import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createDurableStreamsStore } from "@stream-slack/durable-streams";

import { canonicalSha256 } from "../src/ledger/canonical-json.mjs";
import {
  assertIdleWindowRequestConstant,
  observeHttpIdleWindow,
} from "../test/support/http-idle-probe.mjs";
import { auditDurableStreamsAccess } from "../tools/audit-durable-streams-access.mjs";
import { createRunContext } from "./run-context.mjs";
import { startStack } from "./test-stack.mjs";

const taskEvidenceDirectory = path.resolve(
  ".eforest/tasks/epic-0-the-ledger/E0-T03-official-durable-streams-adapter/evidence",
);
const runId = safeRunId(
  process.env.TEST_RUN_ID ??
    `e0-t03-conformance-${process.pid}-${Date.now().toString(36)}`,
);
const implementationCommit = String(
  process.env.E0_T03_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }),
).trim();
assert.match(
  implementationCommit,
  /^[0-9a-f]{40}$/u,
  "E0-T03 evidence requires an exact implementation commit",
);
const artifactRoot = path.resolve(
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e0-t03", runId),
);
const context = await createRunContext({
  env: {
    ...process.env,
    TEST_ARTIFACT_DIR: artifactRoot,
    TEST_RUN_ID: runId,
  },
});
const canary = `e0t03:${crypto.randomBytes(24).toString("base64url")}/canary`;
const transcript = [];
const browserAndApiPayloads = [];
const environmentManifest = {
  schemaVersion: 1,
  task: "E0-T03",
  runId,
  implementationCommit,
  variables: {
    AUTH0_EMULATOR_URL: context.auth0EmulatorUrl,
    DURABLE_STREAMS_ADMIN_TOKEN: "[REDACTED]",
    DURABLE_STREAMS_URL: context.durableStreamsUrl,
    HOST: context.host,
    PORT: String(context.appPort),
  },
};

await mkdir(artifactRoot, { recursive: true });
await writeArtifact("environment-manifest.json", environmentManifest);

const stack = await startStack(context, {
  appSpec: {
    command: "node",
    args: ["src/server.mjs"],
    name: `app:${runId}`,
    env: {
      ...process.env,
      AUTH0_CLIENT_ID: "slack-clone-auth0",
      AUTH0_CLIENT_SECRET: "slack-clone-secret",
      AUTH0_EMULATOR_URL: context.auth0EmulatorUrl,
      AUTH0_REALM: "Username-Password-Authentication",
      DURABLE_STREAMS_ADMIN_TOKEN: canary,
      DURABLE_STREAMS_URL: context.durableStreamsUrl,
      HOST: context.host,
      PORT: String(context.appPort),
    },
  },
});

const countedFetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = String(init.method ?? "GET").toUpperCase();
  const sequence = transcript.length + 1;
  const startedAt = Date.now();
  const response = await fetch(input, init);
  transcript.push({
    sequence,
    method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    status: response.status,
    contentType: response.headers.get("content-type"),
    nextOffset: response.headers.get("stream-next-offset"),
    streamClosed: response.headers.get("stream-closed"),
    durationMs: Date.now() - startedAt,
  });
  return response;
};

const store = createDurableStreamsStore({
  baseUrl: context.durableStreamsUrl,
  token: canary,
  fetchFn: countedFetch,
  digestRecords: canonicalSha256,
});

let protocolConformance;
let requestBudget;
let canaryScan;
try {
  const room = `${context.roomPrefix}-adapter`;
  await Promise.all([store.ensure(room), store.ensure(room)]);
  await store.ensure(room);

  const accepted = [
    { id: "record-1", room, text: "first accepted record" },
    { id: "record-2", room, text: "second accepted record" },
    { id: "record-3", room, text: "third accepted record" },
  ];
  const appendResults = [];
  for (const record of accepted) {
    appendResults.push(await store.append(room, record));
  }
  const offsets = appendResults.map((result) => result.nextOffset);
  assert.equal(new Set(offsets).size, offsets.length);

  const followed = [];
  const follow = await store.follow(room, offsets.at(-1), {
    live: "sse",
    onBatch(batch) {
      followed.push(...batch.records.map((record) => record.id));
    },
  });
  await eventually(() => store.diagnostics().pendingIdleWaiters === 1);
  const diagnosticsAtIdle = store.diagnostics();
  const requestCountAtIdle = transcript.length;
  await settleMicrotasks();
  const requestCountAfterIdleSettle = transcript.length;
  assert.equal(requestCountAfterIdleSettle, requestCountAtIdle);
  assert.ok(diagnosticsAtIdle.sseRequests <= 2);
  assert.equal(diagnosticsAtIdle.longPollRequests, 0);

  const liveRecord = {
    id: "record-live",
    room,
    text: "record accepted after the idle live reader",
  };
  const liveAppend = await store.append(room, liveRecord);
  await eventually(() => followed.includes(liveRecord.id));
  assert.equal(followed.filter((id) => id === liveRecord.id).length, 1);
  assert.equal(follow.currentOffset, liveAppend.nextOffset);
  await eventually(() => store.diagnostics().pendingIdleWaiters === 1);

  const secondLiveRecord = {
    id: "record-live-2",
    room,
    text: "second record accepted by the same live reader",
  };
  const secondLiveAppend = await store.append(room, secondLiveRecord);
  await eventually(() => followed.includes(secondLiveRecord.id));
  assert.equal(followed.filter((id) => id === secondLiveRecord.id).length, 1);
  assert.equal(follow.currentOffset, secondLiveAppend.nextOffset);
  await eventually(() => store.diagnostics().pendingIdleWaiters === 1);
  follow.cancel("conformance complete");
  follow.cancel("idempotent second cancellation");
  await follow.closed;
  await eventually(() => store.diagnostics().activeFollowers === 0);
  const requestsAtCancel = transcript.length;
  await settleMicrotasks();
  const requestsAfterCancellationSettled = transcript.length;
  assert.equal(requestsAfterCancellationSettled, requestsAtCancel);
  const diagnosticsAfterCancel = store.diagnostics();
  assert.equal(diagnosticsAfterCancel.pendingIdleWaiters, 0);

  const idleWindow = await observeHttpIdleWindow();
  assertIdleWindowRequestConstant(idleWindow);
  const pollingPositiveControl = await observeHttpIdleWindow({
    pollingMutationMs: 350,
  });
  assert.throws(
    () => assertIdleWindowRequestConstant(pollingPositiveControl),
    /additional Durable Streams adapter calls/u,
  );
  assert.equal(pollingPositiveControl.pollingTimerExecutions, 2_571);

  const allAccepted = [...accepted, liveRecord, secondLiveRecord];
  const allOffsets = [
    ...offsets,
    liveAppend.nextOffset,
    secondLiveAppend.nextOffset,
  ];
  const resumeMatrix = [];
  const checkpoints = ["-1", ...allOffsets];
  for (const [index, checkpoint] of checkpoints.entries()) {
    const result = await store.read(room, checkpoint);
    const observedIds = result.records.map((record) => record.id);
    const expectedIds = allAccepted.slice(index).map((record) => record.id);
    assert.deepEqual(observedIds, expectedIds);
    assert.equal(new Set(observedIds).size, observedIds.length);
    resumeMatrix.push({
      checkpoint,
      expectedIds,
      observedIds,
      nextOffset: result.nextOffset,
      streamDigest: result.streamDigest,
    });
  }

  const createRequests = transcript.filter(
    (request) => request.method === "PUT" && request.path.includes(room),
  );
  assert.equal(createRequests.length, 1);
  const sseRequests = transcript.filter(
    (request) => request.query.live === "sse",
  );
  assert.ok(sseRequests.length <= 6);

  protocolConformance = {
    schemaVersion: 1,
    task: "E0-T03",
    runId,
    implementationCommit,
    result: "PASS",
    room,
    officialClient: "@durable-streams/client@0.2.6",
    createOnce: {
      ensureCalls: 3,
      createRequests: createRequests.length,
    },
    acceptedIds: allAccepted.map((record) => record.id),
    capturedOffsets: allOffsets,
    resumeMatrix,
    liveFollow: {
      mode: "sse",
      deliveredIds: followed,
      finalOffset: follow.currentOffset,
    },
    cancellation: {
      repeatedCancelSafe: true,
      activeFollowers: diagnosticsAfterCancel.activeFollowers,
      pendingIdleWaiters: diagnosticsAfterCancel.pendingIdleWaiters,
    },
    requestTranscript: transcript,
  };
  requestBudget = {
    schemaVersion: 1,
    task: "E0-T03",
    runId,
    implementationCommit,
    result: "PASS",
    requestCounter: idleWindow.boundary,
    logicalIdleDurationMs: idleWindow.logicalIdleDurationMs,
    requestsBeforeLogicalAdvance: idleWindow.callsBeforeLogicalAdvance,
    requestsAfterLogicalAdvance: idleWindow.callsAfterLogicalAdvance,
    requestDeltaWhileIdle: idleWindow.callDeltaWhileIdle,
    frozenTotalRequestCap: 24,
    totalRequests: transcript.length,
    createRequests: createRequests.length,
    sseRequests: sseRequests.length,
    requestsAtCancel,
    requestsAfterCancellationSettled,
    realEmulatorIdleObservation: {
      requestsWhenOfficialFollowParked: requestCountAtIdle,
      requestsAfterMicrotaskSettle: requestCountAfterIdleSettle,
    },
    idleWindow,
    pollingPositiveControl: {
      detectorRejected: true,
      logicalIdleDurationMs: pollingPositiveControl.logicalIdleDurationMs,
      pollingMutationMs: pollingPositiveControl.pollingMutationMs,
      pollingTimerExecutions: pollingPositiveControl.pollingTimerExecutions,
      requestDeltaWhileIdle: pollingPositiveControl.callDeltaWhileIdle,
    },
    diagnosticsAtIdle,
    diagnosticsAfterCancel,
  };
  assert.ok(requestBudget.totalRequests < requestBudget.frozenTotalRequestCap);
  await writeEvidence("protocol-conformance.json", protocolConformance);
  await writeEvidence("request-budget.json", requestBudget);

  await collectBrowserAndApiPayloads(room);
  const sourceAudit = await auditDurableStreamsAccess();
  assert.deepEqual(sourceAudit.failures, []);
  await writeEvidence("source-access-audit.json", {
    schemaVersion: 1,
    task: "E0-T03",
    runId,
    implementationCommit,
    result: "PASS",
    ...sourceAudit,
    sensitivity:
      "unit fixture inserts direct fetch to a Durable Streams room and must fail",
  });
} finally {
  store.close();
  await stack.stop();
}

canaryScan = await scanForCanary({
  canary,
  artifactRoot,
  browserAndApiPayloads,
  logs: `${stack.app.outputText()}\n${stack.emulator.outputText()}`,
});
await writeEvidence("canary-scan.json", canaryScan);

const summary = {
  schemaVersion: 1,
  task: "E0-T03",
  runId,
  implementationCommit,
  result: "PASS",
  protocolConformance,
  requestBudget,
  canaryScan,
};
await writeArtifact("e0-t03-conformance-summary.json", summary);
console.log(
  `PASS E0-T03 conformance requests=${transcript.length} offsets=${protocolConformance.capturedOffsets.length} canaryMatches=0`,
);

async function collectBrowserAndApiPayloads(room) {
  for (const pathname of ["/", "/app.js", "/styles.css", "/api/health"]) {
    const response = await fetch(`${context.appBaseUrl}${pathname}`);
    const body = await response.text();
    assert.ok(response.ok);
    browserAndApiPayloads.push({ pathname, body });
  }

  const login = await fetch(`${context.appBaseUrl}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: "ada@example.test",
      password: "DemoPass123",
      returnTo: `/app?room=${room}`,
    }),
  });
  assert.equal(login.status, 302);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  for (const pathname of [
    "/api/session",
    `/api/rooms/${encodeURIComponent(room)}/messages`,
  ]) {
    const response = await fetch(`${context.appBaseUrl}${pathname}`, {
      headers: { Cookie: cookie },
    });
    const body = await response.text();
    assert.ok(response.ok);
    browserAndApiPayloads.push({ pathname, body });
  }
}

async function scanForCanary({
  canary: secret,
  artifactRoot: artifacts,
  browserAndApiPayloads: payloads,
  logs,
}) {
  const variants = [
    secret,
    encodeURIComponent(secret),
    Buffer.from(secret).toString("base64"),
  ];
  const positiveControlDetections = variants.map((variant) =>
    countVariantMatches(`planted-browser-fixture=${variant}`, variants),
  );
  assert.ok(
    positiveControlDetections.every((matches) => matches > 0),
    "token canary scanner did not detect its positive controls",
  );
  const categories = {
    browserAssetsAndApi: payloads.map(({ pathname, body }) => ({
      label: pathname,
      value: body,
    })),
    logs: [{ label: "app-and-emulator-logs", value: logs }],
    environmentManifests: [
      {
        label: "environment-manifest.json",
        value: await readFile(
          path.join(artifacts, "environment-manifest.json"),
          "utf8",
        ),
      },
    ],
    runArtifacts: await readArtifactPayloads(artifacts),
  };
  const results = {};
  let totalMatches = 0;
  for (const [category, entries] of Object.entries(categories)) {
    let bytesScanned = 0;
    let matches = 0;
    for (const entry of entries) {
      bytesScanned += Buffer.byteLength(entry.value);
      matches += countVariantMatches(entry.value, variants);
    }
    totalMatches += matches;
    results[category] = { entries: entries.length, bytesScanned, matches };
  }
  assert.equal(totalMatches, 0, "Durable Streams token canary leaked");
  return {
    schemaVersion: 1,
    task: "E0-T03",
    runId,
    implementationCommit,
    result: "PASS",
    canarySha256: crypto.createHash("sha256").update(secret).digest("hex"),
    encodingsScanned: ["raw", "url-encoded", "base64"],
    positiveControlDetections,
    totalMatches,
    categories: results,
  };
}

function countVariantMatches(value, variants) {
  let matches = 0;
  for (const variant of new Set(variants)) {
    if (value.includes(variant)) matches += 1;
  }
  return matches;
}

async function readArtifactPayloads(directory) {
  const entries = [];
  for (const file of await listFiles(directory)) {
    if (file.endsWith("canary-scan.json")) continue;
    entries.push({
      label: path.relative(directory, file),
      value: await readFile(file, "utf8"),
    });
  }
  return entries;
}

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(entryPath)));
    else files.push(entryPath);
  }
  return files.sort();
}

async function writeEvidence(name, value) {
  await writeArtifact(name, value);
  if (process.env.PROMOTE_EVIDENCE !== "1") return;
  await mkdir(taskEvidenceDirectory, { recursive: true });
  await writeFile(
    path.join(taskEvidenceDirectory, name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

async function writeArtifact(name, value) {
  await writeFile(
    path.join(artifactRoot, name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

async function eventually(predicate, attempts = 300) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  assert.fail("condition did not become true");
}

async function settleMicrotasks() {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

function safeRunId(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}
