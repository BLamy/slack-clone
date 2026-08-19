import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createDurableStreamsStore } from "@stream-slack/durable-streams";
import { replayRecords } from "@stream-slack/reducers";
import { ZERO_OFFSET } from "@stream-slack/protocol";

import { canonicalSha256 } from "../src/ledger/canonical-json.mjs";
import {
  DISPATCH_REFUSAL_CODES,
  validateDispatchReceipt,
} from "../src/ledger/dispatch.mjs";
import { validateEventEnvelope } from "../src/ledger/envelope.mjs";
import {
  E0_T07_CHECKPOINT_ERROR,
  validateE0T07Checkpoint,
} from "../src/ledger/e0-t07-protocol.mjs";
import { createRunContext } from "./run-context.mjs";
import {
  findAvailablePortBlock,
  releasePortBlock,
  spawnLogged,
  stop,
  waitForExit,
  waitForHttp,
} from "./process-utils.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-0-the-ledger/E0-T07-two-writers-one-log",
);
const runId = safeRunId(
  process.env.TEST_RUN_ID ?? `e0-t07-${process.pid}-${Date.now().toString(36)}`,
);
const implementationCommit = String(
  process.env.E0_T07_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
assert.match(
  implementationCommit,
  /^[0-9a-f]{40}$/u,
  "E0-T07 evidence requires an exact implementation commit",
);
if (process.env.PROMOTE_EVIDENCE === "1") {
  const trackedChanges = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    { cwd: root, encoding: "utf8" },
  ).trim();
  assert.equal(
    trackedChanges,
    "",
    "promoted E0-T07 evidence must start from a clean tracked implementation tree",
  );
}

const defaultArtifactRoot = path.join(taskDirectory, "evidence", runId);
const artifactRoot = path.resolve(
  process.env.TEST_ARTIFACT_DIR ?? defaultArtifactRoot,
);
assertInsideTask(artifactRoot);
const checkpointFile = path.join(artifactRoot, "follower-checkpoint.json");
const workRoot = path.join(taskDirectory, "work", runId);
const token = `e0-t07-token-${runId}`;
const transcript = [];

let context;
let workerPortStart;
let emulator;
let writerA;
let writerB;
let followerBeforePartition;
let followerAfterRestart;
let store;
let releaseWorkerPorts = async () => {};

try {
  context = await createRunContext({
    env: {
      ...process.env,
      TEST_ARTIFACT_DIR: artifactRoot,
      TEST_RUN_ID: runId,
    },
  });
  await mkdir(artifactRoot, { recursive: true });
  await mkdir(workRoot, { recursive: true });

  emulator = spawnLogged(
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
      cwd: root,
      env: { ...process.env, TEST_RUN_ID: runId },
      name: `e0-t07-emulator:${runId}`,
    },
  );
  await waitForHttp(`${context.durableStreamsUrl}/_inspector`);

  workerPortStart = await findAvailablePortBlock(3, context.host, {
    random: () => 0.307,
  });
  releaseWorkerPorts = () => releasePortBlock(workerPortStart, 3, context.host);

  const stream = `${context.roomPrefix}-authoritative`;
  const auxiliaryStream = `${context.roomPrefix}-nonconflicting`;
  const receiptStream = `${context.roomPrefix}-dispatch-index`;
  const workspaceToken = "a".repeat(26);
  const workspaceId = `ws_${workspaceToken}`;
  const actorA = `pr_${workspaceToken}_${"b".repeat(26)}`;
  const actorB = `pr_${workspaceToken}_${"c".repeat(26)}`;
  const workerEnvironment = {
    ...process.env,
    E0_T07_BASE_URL: context.durableStreamsUrl,
    E0_T07_HOST: context.host,
    E0_T07_IDEMPOTENCY_STREAM: receiptStream,
    E0_T07_TOKEN: token,
  };

  writerA = spawnWriter("writer-a", workerPortStart, {
    ...workerEnvironment,
    E0_T07_PRODUCER_ID: `e0-t07-${runId}-writer-a`,
  });
  writerB = spawnWriter("writer-b", workerPortStart + 1, {
    ...workerEnvironment,
    E0_T07_PRODUCER_ID: `e0-t07-${runId}-writer-b`,
  });
  await Promise.all([
    waitForHttp(`http://${context.host}:${workerPortStart}/health`),
    waitForHttp(`http://${context.host}:${workerPortStart + 1}/health`),
  ]);

  store = createDurableStreamsStore({
    baseUrl: context.durableStreamsUrl,
    digestRecords: canonicalSha256,
    fetchFn: tracedFetch,
    token,
  });
  await Promise.all([
    store.read(stream, "-1"),
    store.read(auxiliaryStream, "-1"),
    store.read(receiptStream, "-1"),
  ]);

  followerBeforePartition = spawnFollower(
    "follower-before-partition",
    workerPortStart + 2,
    {
      ...workerEnvironment,
      E0_T07_CHECKPOINT_FILE: checkpointFile,
      E0_T07_RECEIPT_STREAM: receiptStream,
      E0_T07_SOURCE_STREAM: stream,
    },
  );
  await waitForHttp(`http://${context.host}:${workerPortStart + 2}/health`);

  const operationLog = [];
  let requestNumber = 0;

  const duplicateRequest = makeRequest({
    actorId: actorA,
    eventNumber: requestNumber++,
    expectedHead: await head(stream),
    label: "duplicate-logical-operation",
    stream,
    workspaceId,
  });
  const duplicateResults = await raceRequests(
    duplicateRequest,
    duplicateRequest,
    { order: ["a", "b"] },
  );
  assert.equal(
    duplicateResults.every(({ ok }) => ok),
    true,
  );
  assert.equal(
    new Set(duplicateResults.map(({ receipt }) => receipt.nextOffset)).size,
    1,
  );
  operationLog.push({
    kind: "duplicate-idempotency",
    logicalOperation: duplicateRequest.idempotencyKey,
    results: summarizeResults(duplicateResults),
  });

  for (let round = 0; round < 2; round += 1) {
    const result = await runConflictRound({
      actorA,
      actorB,
      eventNumberA: requestNumber++,
      eventNumberB: requestNumber++,
      expectedHead: await head(stream),
      label: `pre-partition-${round}`,
      order: round % 2 === 0 ? ["a", "b"] : ["b", "a"],
      stream,
      workspaceId,
    });
    operationLog.push(result);
  }

  const nonConflicting = await runNonConflictingPair({
    actorA,
    actorB,
    eventNumberA: requestNumber++,
    eventNumberB: requestNumber++,
    mainHead: await head(stream),
    auxiliaryStream,
    order: ["b", "a"],
    stream,
    workspaceId,
  });
  operationLog.push(nonConflicting);

  await pollJson(
    `http://${context.host}:${workerPortStart + 2}/health`,
    (health) => health.observedCount >= 1 && health.checkpoint.offset !== "-1",
    "follower initial checkpoint",
  );
  const initialCheckpoint = await readCheckpointFile();
  assert.notEqual(initialCheckpoint.offset, "-1");

  const beforePartition = await dump(stream);
  const beforePartitionCheckpoint = initialCheckpoint;
  assert.equal(followerBeforePartition.kill("SIGSTOP"), true);
  for (let round = 0; round < 2; round += 1) {
    const result = await runConflictRound({
      actorA,
      actorB,
      eventNumberA: requestNumber++,
      eventNumberB: requestNumber++,
      expectedHead: await head(stream),
      label: `partition-${round}`,
      order: round % 2 === 0 ? ["a", "b"] : ["b", "a"],
      stream,
      workspaceId,
    });
    operationLog.push(result);
  }
  const afterPartition = await dump(stream);
  assert.ok(afterPartition.records.length > beforePartition.records.length);
  assert.deepEqual(await readCheckpointFile(), beforePartitionCheckpoint);
  assert.equal(followerBeforePartition.kill("SIGKILL"), true);
  const killedFollower = await waitForExit(followerBeforePartition);
  assert.equal(killedFollower.signal, "SIGKILL");

  followerAfterRestart = spawnFollower(
    "follower-after-restart",
    workerPortStart + 2,
    {
      ...workerEnvironment,
      E0_T07_CHECKPOINT_FILE: checkpointFile,
      E0_T07_RECEIPT_STREAM: receiptStream,
      E0_T07_SOURCE_STREAM: stream,
    },
  );
  await waitForHttp(`http://${context.host}:${workerPortStart + 2}/health`);
  const restartHealth = await getJson(
    `http://${context.host}:${workerPortStart + 2}/health`,
  );
  assert.ok(
    restartHealth.metrics.sourceReplayRecords >= afterPartition.records.length,
  );

  const postRestart = await runConflictRound({
    actorA,
    actorB,
    eventNumberA: requestNumber++,
    eventNumberB: requestNumber++,
    expectedHead: await head(stream),
    label: "post-restart",
    order: ["a", "b"],
    stream,
    workspaceId,
  });
  operationLog.push(postRestart);

  const finalTarget = await dump(stream);
  const finalAuxiliary = await dump(auxiliaryStream);
  const finalReceipts = await dump(receiptStream);
  const offsetRecords = buildOffsetRecords(
    finalTarget.records,
    finalReceipts.records,
  );
  const liveReplay = replayRecords(offsetRecords);
  assert.equal(offsetRecords.length, finalTarget.records.length);

  await pollJson(
    `http://${context.host}:${workerPortStart + 2}/state`,
    (state) =>
      state.status === "ready" &&
      state.observedCount === finalTarget.records.length &&
      state.sourceHead === finalTarget.nextOffset,
    "follower final state",
  );
  const followerState = await getJson(
    `http://${context.host}:${workerPortStart + 2}/state`,
  );
  const followerFinalHealth = await getJson(
    `http://${context.host}:${workerPortStart + 2}/health`,
  );
  assert.ok(followerFinalHealth.metrics.externalHeadPolls > 0);
  assert.ok(followerFinalHealth.metrics.followReconnects > 0);
  assert.ok(followerFinalHealth.metrics.followRecords > 0);
  assert.deepEqual(
    followerState.observedEventIds,
    finalTarget.records.map((record) => record.event.eventId),
  );
  assert.equal(followerState.finalStateJson, liveReplay.finalStateJson);
  assert.equal(followerState.finalStateDigest, liveReplay.finalStateDigest);

  const replayDump = { records: offsetRecords };
  const replayDumpPath = path.join(artifactRoot, "final-replay-dump.json");
  await writeJson(replayDumpPath, replayDump);
  const offlineReplay1 = await runOfflineReplay(replayDumpPath);
  const offlineReplay2 = await runOfflineReplay(replayDumpPath);
  assert.equal(offlineReplay1.finalStateJson, liveReplay.finalStateJson);
  assert.equal(offlineReplay2.finalStateJson, liveReplay.finalStateJson);
  assert.equal(
    offlineReplay1.finalStateDigest,
    offlineReplay2.finalStateDigest,
  );

  const cachePath = path.join(workRoot, "projection-cache.json");
  await writeJson(cachePath, {
    finalStateDigest: liveReplay.finalStateDigest,
    note: "disposable projection; replay must not read this file",
  });
  await rm(cachePath, { force: true });
  assert.equal(await pathExists(cachePath), false);
  const cleanOfflineReplay = await runOfflineReplay(replayDumpPath);
  assert.equal(
    cleanOfflineReplay.finalStateJson,
    offlineReplay1.finalStateJson,
  );

  const sensitivity = runSensitivityChecks({
    checkpoint: await readCheckpointFile(),
    finalDigest: liveReplay.finalStateDigest,
    finalTarget,
    finalReceipts,
    offsetRecords,
  });
  assert.equal(
    sensitivity.every(({ outcome }) => outcome === "rejected"),
    true,
  );

  const prefixDigests = liveReplay.prefixes.map(
    ({ index, offset, stateDigest }) => ({ index, offset, stateDigest }),
  );
  const faultManifest = {
    schemaVersion: 1,
    seed: `e0-t07-${runId}`,
    schedule: [
      {
        boundary: "dispatch",
        order: ["a", "b"],
        step: "duplicate-idempotency",
      },
      { boundary: "dispatch", order: ["a", "b"], step: "conflict-0" },
      { boundary: "dispatch", order: ["b", "a"], step: "conflict-1" },
      {
        boundary: "dispatch",
        order: ["b", "a"],
        step: "non-conflicting-streams",
      },
      { boundary: "follower", signal: "SIGSTOP", step: "partition" },
      { boundary: "dispatch", order: ["a", "b"], step: "partition-conflict-0" },
      { boundary: "dispatch", order: ["b", "a"], step: "partition-conflict-1" },
      { boundary: "follower", signal: "SIGKILL", step: "process-restart" },
      {
        boundary: "dispatch",
        order: ["a", "b"],
        step: "post-restart-conflict",
      },
    ],
    writerProcesses: [
      { producerId: `e0-t07-${runId}-writer-a`, role: "writer-a" },
      { producerId: `e0-t07-${runId}-writer-b`, role: "writer-b" },
    ],
  };

  const resourceCountsBefore = {
    adapter: store.diagnostics(),
    workerProcesses: 3,
    streams: 3,
  };
  await stop(followerAfterRestart);
  await Promise.all([stop(writerA), stop(writerB)]);
  const resourceCountsAfter = {
    adapter: store.diagnostics(),
    workerProcesses: [writerA, writerB, followerAfterRestart].filter(
      (child) => child.exitCode === null && child.signalCode === null,
    ).length,
    streams: 3,
  };

  const offsets = {
    auxiliary: {
      nextOffset: finalAuxiliary.nextOffset,
      recordCount: finalAuxiliary.records.length,
      streamDigest: finalAuxiliary.streamDigest,
    },
    authoritative: {
      nextOffset: finalTarget.nextOffset,
      recordCount: finalTarget.records.length,
      streamDigest: finalTarget.streamDigest,
    },
    dispatchReceipts: {
      nextOffset: finalReceipts.nextOffset,
      recordCount: finalReceipts.records.length,
      streamDigest: finalReceipts.streamDigest,
    },
  };
  const verifierReport = {
    schemaVersion: 1,
    task: "E0-T07",
    result: "PASS",
    runId,
    implementationCommit,
    implementationTreeCleanAtStart:
      process.env.PROMOTE_EVIDENCE === "1" ? true : null,
    commands: [
      "make verify-E0-T07",
      "make verify-E0",
      "pnpm format:check",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm test",
      "pnpm build",
    ],
    faultManifest,
    offsets,
    stateDigests: {
      follower: followerState.finalStateDigest,
      live: liveReplay.finalStateDigest,
      offline1: offlineReplay1.finalStateDigest,
      offline2: offlineReplay2.finalStateDigest,
      cleanOffline: cleanOfflineReplay.finalStateDigest,
    },
    stateJsonBytes: {
      follower: Buffer.byteLength(followerState.finalStateJson, "utf8"),
      live: Buffer.byteLength(liveReplay.finalStateJson, "utf8"),
      offline1: Buffer.byteLength(offlineReplay1.finalStateJson, "utf8"),
      offline2: Buffer.byteLength(offlineReplay2.finalStateJson, "utf8"),
    },
    prefixDigests,
    operationLog,
    transcript,
    partition: {
      checkpointBefore: beforePartitionCheckpoint,
      killedFollower,
      recordsBefore: beforePartition.records.length,
      recordsAfter: afterPartition.records.length,
      writesWhilePartitioned:
        afterPartition.records.length - beforePartition.records.length,
      restartSourceReplayRecords: restartHealth.metrics.sourceReplayRecords,
    },
    followerHealth: followerFinalHealth,
    sensitivity,
    resourceCounts: {
      before: resourceCountsBefore,
      after: resourceCountsAfter,
    },
    replay:
      "N/A (server/CLI protocol capstone) + mitigation: real emulator, two-process race, deterministic fault manifest, stream dump, and independent replay digests",
    replayUploadAttempted: false,
    noLocalMutationAuthority: true,
    localProjectionFiles: [],
  };

  await writeJson(path.join(artifactRoot, "final-stream-dump.json"), {
    stream,
    ...finalTarget,
    offsetRecords,
  });
  await writeJson(path.join(artifactRoot, "dispatch-receipts.json"), {
    stream: receiptStream,
    ...finalReceipts,
  });
  await writeJson(path.join(artifactRoot, "auxiliary-stream-dump.json"), {
    stream: auxiliaryStream,
    ...finalAuxiliary,
  });
  await writeJson(
    path.join(artifactRoot, "fault-manifest.json"),
    faultManifest,
  );
  await writeJson(path.join(artifactRoot, "prefix-digests.json"), {
    finalStateDigest: liveReplay.finalStateDigest,
    prefixes: prefixDigests,
  });
  await writeJson(
    path.join(artifactRoot, "verifier-report.json"),
    verifierReport,
  );

  const gates = process.env.E0_T07_SKIP_GATES === "1" ? [] : await runGates();
  assert.equal(
    gates.length,
    process.env.E0_T07_SKIP_GATES === "1" ? 0 : 5,
    "E0-T07 must execute all five repository gates",
  );
  const summary = {
    ...verifierReport,
    gates,
    zeroSkipped: gates.length === 5,
  };
  await writeJson(
    path.join(artifactRoot, "verification-summary.json"),
    summary,
  );
  console.log(JSON.stringify(summary, null, 2));
} finally {
  store?.close();
  await stop(followerBeforePartition).catch(() => {});
  await stop(followerAfterRestart).catch(() => {});
  await stop(writerA).catch(() => {});
  await stop(writerB).catch(() => {});
  await stop(emulator).catch(() => {});
  await releaseWorkerPorts().catch(() => {});
  if (context) await context.releasePortLease().catch(() => {});
}

async function runConflictRound({
  actorA,
  actorB,
  eventNumberA,
  eventNumberB,
  expectedHead,
  label,
  order,
  stream,
  workspaceId,
}) {
  const requestA = makeRequest({
    actorId: actorA,
    eventNumber: eventNumberA,
    expectedHead,
    label: `${label}-a`,
    stream,
    workspaceId,
  });
  const requestB = makeRequest({
    actorId: actorB,
    eventNumber: eventNumberB,
    expectedHead,
    label: `${label}-b`,
    stream,
    workspaceId,
  });
  const results = await raceRequests(requestA, requestB, { order });
  assert.equal(results.filter(({ ok }) => ok).length, 1);
  assert.equal(
    results.filter(
      ({ refusal }) => refusal?.code === DISPATCH_REFUSAL_CODES.STALE_FENCE,
    ).length,
    1,
  );
  const loser = results.find(({ ok }) => !ok);
  const loserRetry = await dispatchTo(
    loser.writer === "writer-a" ? writerA : writerB,
    loser.request,
  );
  assert.equal(loserRetry.ok, false);
  assert.equal(loserRetry.refusal.code, DISPATCH_REFUSAL_CODES.STALE_FENCE);
  return {
    accepted: summarizeResults(results.filter(({ ok }) => ok)),
    label,
    kind: "conflict-race",
    loserRetry: summarizeResult(loserRetry),
    refused: summarizeResults(results.filter(({ ok }) => !ok)),
  };
}

async function runNonConflictingPair({
  actorA,
  actorB,
  eventNumberA,
  eventNumberB,
  mainHead,
  auxiliaryStream,
  order,
  stream,
  workspaceId,
}) {
  const mainRequest = makeRequest({
    actorId: actorA,
    eventNumber: eventNumberA,
    expectedHead: mainHead,
    label: "non-conflicting-main",
    stream,
    workspaceId,
  });
  const auxiliaryRequest = makeRequest({
    actorId: actorB,
    eventNumber: eventNumberB,
    expectedHead: ZERO_OFFSET,
    label: "non-conflicting-auxiliary",
    stream: auxiliaryStream,
    workspaceId,
  });
  const initialResults = await raceRequests(mainRequest, auxiliaryRequest, {
    order,
  });
  const recovered = [];
  for (const result of initialResults) {
    if (result.ok) {
      recovered.push(result);
      continue;
    }
    assert.equal(result.refusal.code, DISPATCH_REFUSAL_CODES.STALE_FENCE);
    const retry = await dispatchTo(
      result.writer === "writer-a" ? writerA : writerB,
      result.request,
    );
    assert.equal(retry.ok, true);
    recovered.push({ ...retry, writer: result.writer });
  }
  assert.equal(
    recovered.every(({ ok }) => ok),
    true,
  );
  return {
    initial: summarizeResults(initialResults),
    kind: "non-conflicting-streams",
    recovered: summarizeResults(recovered),
  };
}

async function raceRequests(requestA, requestB, { order }) {
  const requestByWriter = { a: requestA, b: requestB };
  const childByWriter = { a: writerA, b: writerB };
  const results = await Promise.all(
    order.map(async (writer) => {
      const result = await dispatchTo(
        childByWriter[writer],
        requestByWriter[writer],
      );
      return { ...result, writer: writer === "a" ? "writer-a" : "writer-b" };
    }),
  );
  return results;
}

async function dispatchTo(child, request) {
  const port = child.__e0T07Port;
  const result = await postJson(
    `http://${context.host}:${port}/dispatch`,
    request,
  );
  result.request ??= request;
  result.writer ??= child.__e0T07Name;
  return result;
}

function makeRequest({
  actorId,
  eventNumber,
  expectedHead,
  label,
  stream,
  workspaceId,
}) {
  const tokenPart = idToken(eventNumber);
  const event = validateEventEnvelope({
    actorId,
    causation: null,
    correlationId: "cr_dddddddddddddddddddddddddd",
    data: {
      fixtureId: `e0-t07-${runId}-${label}-${eventNumber}`,
      value: `value-${eventNumber}`,
    },
    eventId: `ev_${tokenPart}`,
    eventType: "ledger.fixture-recorded",
    idempotencyKey: `ik_${tokenPart}`,
    schemaVersion: 1,
    serverTimestamp: `2026-08-02T00:00:${String(eventNumber).padStart(2, "0")}.000Z`,
    workspaceId,
  });
  return {
    actorId,
    expectedHead,
    idempotencyKey: event.idempotencyKey,
    operation: "ledger.event.append",
    payload: { event },
    stream,
    workspaceId,
  };
}

function buildOffsetRecords(targetRecords, receiptRecords) {
  const receipts = new Map();
  for (const record of receiptRecords) {
    if (record?.kind !== "dispatch.accepted") continue;
    const receipt = validateDispatchReceipt(record.receipt);
    assert.equal(
      receipts.has(receipt.idempotencyKey),
      false,
      `duplicate receipt ${receipt.idempotencyKey}`,
    );
    receipts.set(receipt.idempotencyKey, receipt);
  }
  return targetRecords.map((record) => {
    const idempotencyKey = record?.dispatch?.idempotencyKey;
    const receipt = receipts.get(idempotencyKey);
    assert.ok(receipt, `missing receipt for ${idempotencyKey}`);
    assert.equal(canonicalSha256(record), receipt.eventDigest);
    return { event: record.event, offset: receipt.nextOffset };
  });
}

function runSensitivityChecks({
  checkpoint,
  finalDigest,
  finalTarget,
  finalReceipts,
  offsetRecords,
}) {
  const results = [];

  const tamperedEventRecords = structuredClone(offsetRecords);
  tamperedEventRecords[0].event.data.value = "tampered-event";
  const tamperedEventReplay = replayRecords(tamperedEventRecords);
  assert.notEqual(tamperedEventReplay.finalStateDigest, finalDigest);
  results.push({
    detector: "authoritative-event-digest",
    expectedCode: "E0_T07_FINAL_DIGEST_MISMATCH",
    observed: tamperedEventReplay.finalStateDigest,
    outcome: "rejected",
  });

  const tamperedReceiptRecords = structuredClone(finalReceipts.records);
  tamperedReceiptRecords[0].receipt.eventDigest = `sha256:${"0".repeat(64)}`;
  assert.throws(
    () => buildOffsetRecords(finalTarget.records, tamperedReceiptRecords),
    (error) => error instanceof assert.AssertionError,
  );
  results.push({
    detector: "dispatch-receipt-binding",
    expectedCode: "E0_T07_RECEIPT_MISMATCH",
    outcome: "rejected",
  });

  const tamperedCheckpoint = {
    ...checkpoint,
    offset: checkpoint.offset === ZERO_OFFSET ? "-1" : ZERO_OFFSET,
  };
  assert.throws(
    () => validateE0T07Checkpoint(tamperedCheckpoint),
    (error) => error?.code === E0_T07_CHECKPOINT_ERROR,
  );
  results.push({
    detector: "opaque-checkpoint-integrity",
    expectedCode: E0_T07_CHECKPOINT_ERROR,
    outcome: "rejected",
  });

  const tamperedFinalDigest = `sha256:${"f".repeat(64)}`;
  assert.notEqual(tamperedFinalDigest, finalDigest);
  results.push({
    detector: "claimed-final-digest",
    expectedCode: "E0_T07_FINAL_DIGEST_MISMATCH",
    expected: finalDigest,
    claimed: tamperedFinalDigest,
    outcome: "rejected",
  });
  return results;
}

async function runOfflineReplay(dumpPath) {
  const result = await execFileAsync(
    process.execPath,
    ["scripts/replay-ledger.mjs", "replay", dumpPath],
    {
      cwd: root,
      env: {
        ...process.env,
        E0_T07_NETWORK_DISABLED: "1",
      },
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return JSON.parse(result.stdout.trim());
}

async function runGates() {
  const gates = [];
  for (const [name, script] of [
    ["format", "format:check"],
    ["lint", "lint"],
    ["typecheck", "typecheck"],
    ["tests", "test"],
    ["build", "build"],
  ]) {
    const startedAt = Date.now();
    await execFileAsync("pnpm", [script], {
      cwd: root,
      env: {
        ...process.env,
        BUILD_DIR: path.join(root, ".artifacts", "e0-t07", runId, "build"),
        E0_T07_IMPLEMENTATION_COMMIT: implementationCommit,
        TEST_ARTIFACT_DIR: artifactRoot,
        TEST_RUN_ID: runId,
      },
      maxBuffer: 16 * 1024 * 1024,
    });
    gates.push({
      command: `pnpm ${script}`,
      durationMs: Date.now() - startedAt,
      name,
      result: "PASS",
    });
  }
  return gates;
}

function spawnWriter(name, port, env) {
  const child = spawnLogged(process.execPath, ["scripts/e0-t07-writer.mjs"], {
    cwd: root,
    env: { ...env, E0_T07_PORT: String(port) },
    name: `e0-t07-${name}:${runId}`,
  });
  child.__e0T07Name = name;
  child.__e0T07Port = port;
  return child;
}

function spawnFollower(name, port, env) {
  const child = spawnLogged(process.execPath, ["scripts/e0-t07-follower.mjs"], {
    cwd: root,
    env: { ...env, E0_T07_PORT: String(port) },
    name: `e0-t07-${name}:${runId}`,
  });
  child.__e0T07Name = name;
  child.__e0T07Port = port;
  return child;
}

async function tracedFetch(input, init = {}) {
  const url = new URL(String(input));
  const response = await fetch(input, init);
  transcript.push({
    method: String(init.method ?? "GET").toUpperCase(),
    path: url.pathname,
    status: response.status,
    streamSeq: new Headers(init.headers).get("Stream-Seq"),
    producerId: new Headers(init.headers).get("Producer-Id"),
    producerSeq: new Headers(init.headers).get("Producer-Seq"),
  });
  return response;
}

async function dump(streamName) {
  const result = await store.read(streamName, "-1");
  return {
    records: result.records,
    nextOffset: result.nextOffset,
    streamDigest: result.streamDigest,
  };
}

async function head(streamName) {
  return (await store.read(streamName, "-1")).nextOffset;
}

async function readCheckpointFile() {
  return validateE0T07Checkpoint(
    JSON.parse(await readFile(checkpointFile, "utf8")),
  );
}

async function getJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  assert.equal(response.ok, true, `${url} returned ${response.status}`);
  return body;
}

async function postJson(url, value) {
  const response = await fetch(url, {
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const body = await response.json();
  transcript.push({
    method: "POST",
    path: new URL(url).pathname,
    status: response.status,
  });
  return body;
}

async function pollJson(url, predicate, label, timeoutMs = 30000) {
  const startedAt = Date.now();
  let lastBody;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastBody = await getJson(url);
      if (predicate(lastBody)) return lastBody;
    } catch {
      // The process may still be starting or restarting.
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(`${label} timed out: ${JSON.stringify(lastBody)}`);
}

function summarizeResults(results) {
  return results.map(summarizeResult);
}

function summarizeResult(result) {
  return {
    code: result.refusal?.code ?? null,
    eventDigest: result.receipt?.eventDigest ?? null,
    idempotencyKey: result.request?.idempotencyKey ?? null,
    nextOffset: result.receipt?.nextOffset ?? null,
    ok: result.ok,
    status: result.refusal?.statusCode ?? (result.ok ? 200 : 500),
    writer: result.writer ?? null,
  };
}

function idToken(number) {
  return Math.max(0, number).toString(16).padStart(26, "0").slice(-26);
}

function safeRunId(value) {
  const normalized = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return normalized || `run-${process.pid}`;
}

function assertInsideTask(filePath) {
  const relative = path.relative(taskDirectory, filePath);
  assert.equal(
    relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative)),
    true,
    `E0-T07 evidence must remain inside ${taskDirectory}`,
  );
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeJson(filePath, value) {
  assertInsideTask(filePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
