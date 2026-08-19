import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { createDurableStreamsStore } from "@stream-slack/durable-streams";

import { canonicalSha256 } from "../src/ledger/canonical-json.mjs";
import {
  createDispatchDoor,
  DISPATCH_REFUSAL_CODES,
} from "../src/ledger/dispatch.mjs";
import { createRunContext } from "./run-context.mjs";
import { spawnLogged, stop, waitForHttp } from "./process-utils.mjs";

const runId = safeRunId(
  process.env.TEST_RUN_ID ??
    `e0-t04-conformance-${process.pid}-${Date.now().toString(36)}`,
);
const implementationCommit = String(
  process.env.E0_T04_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }),
).trim();
assert.match(
  implementationCommit,
  /^[0-9a-f]{40}$/u,
  "E0-T04 evidence requires an exact implementation commit",
);
const artifactRoot = path.resolve(
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e0-t04", runId),
);
const token = `e0-t04-provider-${crypto.randomBytes(12).toString("hex")}`;
const transcript = [];
const revokedActors = new Set();
const deletedWorkspaces = new Set();
let lostAckStream = null;

const context = await createRunContext({
  env: {
    ...process.env,
    TEST_ARTIFACT_DIR: artifactRoot,
    TEST_RUN_ID: runId,
  },
});
await mkdir(artifactRoot, { recursive: true });

const emulator = spawnLogged(
  "node",
  [
    "emulate/packages/emulate/dist/index.js",
    "start",
    "--service",
    "durable-streams",
    "--port",
    String(context.emulatorPort),
    "--seed",
    "emulate.config.yaml",
  ],
  {
    name: `emulate:${runId}`,
    env: { ...process.env, TEST_RUN_ID: runId },
  },
);
let server;
let store;
let baseStore;
let doorA;
let doorB;
try {
  await waitForHttp(`${context.durableStreamsUrl}/_inspector`);

  const tracedFetch = async (input, init = {}) => {
    const requestUrl = new URL(String(input));
    const requestHeaders = new Headers(init.headers);
    const method = String(init.method ?? "GET").toUpperCase();
    const response = await fetch(input, init);
    transcript.push({
      method,
      path: requestUrl.pathname,
      producerEpoch: requestHeaders.get("Producer-Epoch"),
      producerId: requestHeaders.get("Producer-Id"),
      producerSeq: requestHeaders.get("Producer-Seq"),
      status: response.status,
      streamSeq: requestHeaders.get("Stream-Seq"),
    });
    return response;
  };

  baseStore = createDurableStreamsStore({
    baseUrl: context.durableStreamsUrl,
    token,
    digestRecords: canonicalSha256,
    fetchFn: tracedFetch,
  });
  store = {
    append: async (stream, record, options) => {
      const result = await baseStore.append(stream, record, options);
      if (lostAckStream === stream) {
        lostAckStream = null;
        throw new Error(
          "simulated lost acknowledgement after provider acceptance",
        );
      }
      return result;
    },
    read: baseStore.read,
  };
  const authorize = ({ actorId, workspaceId }) => ({
    ok: !revokedActors.has(actorId) && !deletedWorkspaces.has(workspaceId),
    detail: revokedActors.has(actorId)
      ? "actor revoked"
      : deletedWorkspaces.has(workspaceId)
        ? "workspace deleted"
        : undefined,
  });
  doorA = createDispatchDoor({
    authorize,
    producerEpoch: 0,
    producerId: `e0-t04-door-a-${runId}`,
    streamStore: store,
  });
  doorB = createDispatchDoor({
    authorize,
    producerEpoch: 0,
    producerId: `e0-t04-door-b-${runId}`,
    streamStore: store,
  });

  server = createServer((request, response) => {
    void handleHttpRequest(request, response);
  });
  await listen(server, context.host, context.appPort);

  const endpoint = `${context.appBaseUrl}`;
  const sameRoom = `${context.roomPrefix}-same-key`;
  const sameHead = await head(store, sameRoom);
  const sameRequest = makeRequest({
    expectedHead: sameHead,
    payload: { logical: "one-event", value: 7 },
    stream: sameRoom,
  });
  const concurrent = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      postJson(
        `${endpoint}/${index % 2 === 0 ? "dispatch-a" : "dispatch-b"}`,
        sameRequest,
      ),
    ),
  );
  assert.equal(concurrent.filter((result) => result.ok).length, 100);
  assert.equal(
    new Set(concurrent.map((result) => result.receipt.nextOffset)).size,
    1,
  );
  assert.equal(
    new Set(concurrent.map((result) => result.receipt.eventDigest)).size,
    1,
  );
  const sameDump = await dump(store, sameRoom);
  assert.equal(sameDump.records.length, 1);

  const conflictRoom = `${context.roomPrefix}-conflicts`;
  const candidateRoom = `${context.roomPrefix}-conflict-candidate`;
  const conflictHead = await head(store, conflictRoom);
  const candidateHead = await head(store, candidateRoom);
  const conflictBase = makeRequest({
    expectedHead: conflictHead,
    idempotencyKey: idempotencyKey(2),
    payload: { value: "original" },
    stream: conflictRoom,
  });
  const acceptedConflict = await postJson(
    `${endpoint}/dispatch-a`,
    conflictBase,
  );
  assert.equal(acceptedConflict.ok, true);
  const conflictBefore = await dump(store, conflictRoom);
  const candidateBefore = await dump(store, candidateRoom);
  const conflictVariants = [
    { payload: { value: "changed" } },
    { actorId: "pr_linus" },
    { operation: "chat.message.edit" },
    { workspaceId: workspaceId(2) },
    { expectedHead: candidateHead, stream: candidateRoom },
  ];
  const conflictResults = [];
  for (const variant of conflictVariants) {
    const result = await postJson(`${endpoint}/dispatch-a`, {
      ...conflictBase,
      ...variant,
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.refusal.code,
      DISPATCH_REFUSAL_CODES.IDEMPOTENCY_CONFLICT,
    );
    conflictResults.push(result.refusal);
  }
  assert.deepEqual(await dump(store, conflictRoom), conflictBefore);
  assert.deepEqual(await dump(store, candidateRoom), candidateBefore);

  const raceRoom = `${context.roomPrefix}-race`;
  const raceHead = await head(store, raceRoom);
  const raceA = makeRequest({
    expectedHead: raceHead,
    idempotencyKey: idempotencyKey(3),
    payload: { writer: "a" },
    stream: raceRoom,
  });
  const raceB = makeRequest({
    expectedHead: raceHead,
    idempotencyKey: idempotencyKey(4),
    payload: { writer: "b" },
    stream: raceRoom,
  });
  const raceResults = await Promise.all([
    postJson(`${endpoint}/dispatch-a`, raceA),
    postJson(`${endpoint}/dispatch-b`, raceB),
  ]);
  assert.equal(raceResults.filter((result) => result.ok).length, 1);
  assert.equal(
    raceResults.filter(
      (result) => result.refusal?.code === DISPATCH_REFUSAL_CODES.STALE_FENCE,
    ).length,
    1,
  );
  const raceLoser = raceResults.find((result) => !result.ok);
  const loserEndpoint =
    raceResults[0] === raceLoser ? "dispatch-a" : "dispatch-b";
  const retryLoser = await postJson(
    `${endpoint}/${loserEndpoint}`,
    raceLoser.request,
  );
  assert.equal(retryLoser.ok, false);
  assert.equal(retryLoser.refusal.code, DISPATCH_REFUSAL_CODES.STALE_FENCE);
  assert.equal((await dump(store, raceRoom)).records.length, 1);

  const lostRoom = `${context.roomPrefix}-lost-ack`;
  const lostRequest = makeRequest({
    expectedHead: await head(store, lostRoom),
    idempotencyKey: idempotencyKey(5),
    payload: { recovery: "durable" },
    stream: lostRoom,
  });
  lostAckStream = lostRoom;
  const lostFirst = await postJson(`${endpoint}/dispatch-a`, lostRequest);
  assert.equal(lostFirst.ok, false);
  const lostRecovered = await postJson(`${endpoint}/dispatch-a`, lostRequest);
  assert.equal(lostRecovered.ok, true);
  assert.equal((await dump(store, lostRoom)).records.length, 1);

  const capturedRoom = `${context.roomPrefix}-captured`;
  const capturedRequest = makeRequest({
    expectedHead: await head(store, capturedRoom),
    idempotencyKey: idempotencyKey(6),
    payload: { captured: true },
    stream: capturedRoom,
  });
  const advance = makeRequest({
    expectedHead: capturedRequest.expectedHead,
    idempotencyKey: idempotencyKey(7),
    payload: { advance: true },
    stream: capturedRoom,
  });
  assert.equal((await postJson(`${endpoint}/dispatch-a`, advance)).ok, true);
  const staleCaptured = await postJson(
    `${endpoint}/dispatch-a`,
    capturedRequest,
  );
  assert.equal(staleCaptured.ok, false);
  assert.equal(staleCaptured.refusal.code, DISPATCH_REFUSAL_CODES.STALE_FENCE);

  const revokedRoom = `${context.roomPrefix}-revoked`;
  const revokedRequest = makeRequest({
    actorId: "pr_revoked",
    expectedHead: await head(store, revokedRoom),
    idempotencyKey: idempotencyKey(8),
    stream: revokedRoom,
  });
  revokedActors.add(revokedRequest.actorId);
  const revokedResult = await postJson(
    `${endpoint}/dispatch-a`,
    revokedRequest,
  );
  assert.equal(revokedResult.ok, false);
  assert.equal(revokedResult.refusal.code, DISPATCH_REFUSAL_CODES.UNAUTHORIZED);
  assert.equal((await dump(store, revokedRoom)).records.length, 0);

  const deletedRoom = `${context.roomPrefix}-deleted`;
  const deletedRequest = makeRequest({
    expectedHead: await head(store, deletedRoom),
    idempotencyKey: idempotencyKey(9),
    stream: deletedRoom,
    workspaceId: workspaceId(3),
  });
  deletedWorkspaces.add(deletedRequest.workspaceId);
  const deletedResult = await postJson(
    `${endpoint}/dispatch-a`,
    deletedRequest,
  );
  assert.equal(deletedResult.ok, false);
  assert.equal(deletedResult.refusal.code, DISPATCH_REFUSAL_CODES.UNAUTHORIZED);
  assert.equal((await dump(store, deletedRoom)).records.length, 0);

  const reordered = await postJson(`${endpoint}/dispatch-a`, {
    ...sameRequest,
    payload: { value: 7, logical: "one-event" },
  });
  assert.equal(reordered.ok, true);
  assert.equal(
    reordered.receipt.requestDigest,
    concurrent[0].receipt.requestDigest,
  );
  const changedByte = await postJson(`${endpoint}/dispatch-a`, {
    ...sameRequest,
    payload: { value: 8, logical: "one-event" },
  });
  assert.equal(changedByte.ok, false);
  assert.equal(
    changedByte.refusal.code,
    DISPATCH_REFUSAL_CODES.IDEMPOTENCY_CONFLICT,
  );

  const finalStreams = {};
  for (const stream of [
    sameRoom,
    conflictRoom,
    candidateRoom,
    raceRoom,
    lostRoom,
    capturedRoom,
    revokedRoom,
    deletedRoom,
    "__stream_slack_dispatch_idempotency__",
  ]) {
    finalStreams[stream] = await dump(store, stream);
  }
  const producerRequests = transcript.filter(
    (entry) => entry.method === "POST" && entry.producerId,
  );
  assert.ok(producerRequests.length > 0);
  assert.ok(producerRequests.every((entry) => entry.producerEpoch !== null));
  assert.ok(producerRequests.every((entry) => entry.producerSeq !== null));
  assert.ok(producerRequests.some((entry) => entry.streamSeq !== null));

  const evidence = {
    schemaVersion: 1,
    task: "E0-T04",
    runId,
    implementationCommit,
    result: "PASS",
    replay:
      "N/A (server dispatch concurrency contract) + mitigation: real-HTTP race logs, lost-ack recovery, head dumps, and cold-clone verifier",
    requestDigestEvidence: {
      accepted: concurrent[0].receipt.requestDigest,
      conflictRefusals: conflictResults.map((refusal) => refusal.requestDigest),
      staleFence: raceLoser.refusal.requestDigest,
      lostAckRecovery: lostRecovered.receipt.requestDigest,
    },
    concurrency: {
      requests: 100,
      logicalEvents: sameDump.records.length,
      receiptOffsets: [
        ...new Set(concurrent.map((result) => result.receipt.nextOffset)),
      ],
      receiptDigests: [
        ...new Set(concurrent.map((result) => result.receipt.eventDigest)),
      ],
    },
    conflicts: {
      refusalCodes: conflictResults.map((refusal) => refusal.code),
      candidateStreamsUnchanged: true,
    },
    expectedHeadRace: {
      accepted: 1,
      staleFenceRefusals: 1,
      finalLogicalEvents: (await dump(store, raceRoom)).records.length,
    },
    lostAcknowledgement: {
      firstRequestReturnedError: !lostFirst.ok,
      recovered: lostRecovered.ok,
      logicalEvents: (await dump(store, lostRoom)).records.length,
    },
    authorization: {
      revokedActorRefused: revokedResult.refusal.code,
      deletedWorkspaceRefused: deletedResult.refusal.code,
      noCandidateMutation: true,
    },
    finalStreams,
    providerCoordination: {
      coordinatedPostRequests: producerRequests.length,
      producerHeadersPresent: true,
      expectedHeadHeaderPresent: true,
    },
    requestTranscript: transcript,
    canary: "[REDACTED]",
  };
  await writeArtifact("dispatch-conformance.json", evidence);
  await writeArtifact("final-stream-dump.json", finalStreams);
  await writeArtifact("request-transcript.json", transcript);
  const summary = {
    schemaVersion: 1,
    task: "E0-T04",
    runId,
    implementationCommit,
    result: "PASS",
    evidence,
  };
  await writeArtifact("e0-t04-conformance-summary.json", summary);
  console.log(
    `PASS E0-T04 conformance requests=100 logicalEvents=${sameDump.records.length} raceAccepted=1 lostAckRecovered=true`,
  );
} finally {
  doorA?.close();
  doorB?.close();
  baseStore?.close();
  await closeServer(server);
  await stop(emulator);
  await context.releasePortLease();
}

async function handleHttpRequest(request, response) {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (
      request.method === "POST" &&
      ["/dispatch-a", "/dispatch-b"].includes(url.pathname)
    ) {
      const body = JSON.parse(await readBody(request));
      const door = url.pathname === "/dispatch-a" ? doorA : doorB;
      try {
        const result = await door.dispatch(body);
        sendJson(response, 200, { ok: true, ...result, request: body });
      } catch (error) {
        if (error?.code?.startsWith("DISPATCH_")) {
          sendJson(response, error.statusCode ?? 409, {
            ok: false,
            refusal: error.toJSON(),
            request: body,
          });
          return;
        }
        sendJson(response, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          request: body,
        });
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/dump") {
      const result = await dump(store, url.searchParams.get("stream"));
      sendJson(response, 200, result);
      return;
    }
    sendJson(response, 404, { ok: false, error: "not_found" });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function makeRequest(overrides = {}) {
  return {
    actorId: "pr_ada",
    expectedHead: "0000000000000000_0000000000000000",
    idempotencyKey: idempotencyKey(1),
    operation: "chat.message.create",
    payload: { value: "default" },
    stream: "e0-t04-default",
    workspaceId: workspaceId(1),
    ...overrides,
  };
}

function workspaceId(number) {
  return `ws_${String(number).padStart(26, "0")}`;
}

function idempotencyKey(number) {
  return `ik_${String(number).padStart(26, "0")}`;
}

async function head(streamStore, stream) {
  return (await streamStore.read(stream, "-1")).nextOffset;
}

async function dump(streamStore, stream) {
  const result = await streamStore.read(stream, "-1");
  return {
    records: result.records,
    nextOffset: result.nextOffset,
    streamDigest: result.streamDigest,
  };
}

async function postJson(url, value) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  const result = await response.json();
  if (!result.request) result.request = value;
  return result;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function listen(serverToStart, host, port) {
  return new Promise((resolve, reject) => {
    serverToStart.once("error", reject);
    serverToStart.listen(port, host, () => resolve());
  });
}

function closeServer(serverToClose) {
  if (!serverToClose) return Promise.resolve();
  return new Promise((resolve) => {
    serverToClose.close(() => resolve());
  });
}

async function writeArtifact(name, value) {
  await writeFile(
    path.join(artifactRoot, name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function safeRunId(value) {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return normalized || `run-${process.pid}`;
}
