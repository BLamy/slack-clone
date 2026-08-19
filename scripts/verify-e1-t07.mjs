import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertProjectionIntegrity,
  createProjectionQueries,
  createProjectionStore,
  createProjectionWorker,
  normalizeSourceRecords,
  projectionDigest,
  projectionManifest,
  PROJECTION_ERROR_CODES,
} from "../src/projections.mjs";
import { replayIndependentPrefixes } from "./e1-t07-independent-replay.mjs";

const WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const MEMBER_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const SERVICE_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";
const OUTSIDER_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_ffffffffffffffffffffffffff";
const PRIVATE_CHANNEL_ID =
  "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_22222222222222222222222222";
const DIRECT_CHANNEL_ID =
  "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_b663e6d7z6v64tkx8d49m555wm";
const MESSAGE_CHANNEL_ID = PRIVATE_CHANNEL_ID;
const PROJECTION_ID =
  "px_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";

const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-1-the-workspace/E1-T07-rebuildable-chat-projections",
);
const runId = String(
  process.env.TEST_RUN_ID ?? `verify-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/gu, "-");
const implementationCommit = String(
  process.env.E1_T07_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
assert.match(implementationCommit, /^[0-9a-f]{40}$/u);
assertImplementationBinding(implementationCommit);

const promoteEvidence = process.env.PROMOTE_EVIDENCE === "1";
if (promoteEvidence) {
  assert.equal(
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    "",
    "promoted E1-T07 evidence requires a clean tracked implementation tree",
  );
}

const artifactRoot = path.resolve(
  root,
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e1-t07", runId),
);
const evidenceDirectory = promoteEvidence
  ? path.join(taskDirectory, "evidence/e1-t07-final")
  : artifactRoot;
const trackedTreeCleanAtStart =
  execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: root,
    encoding: "utf8",
  }).trim() === "";
const projectionDirectories = new Set();
await mkdir(artifactRoot, { recursive: true });
await mkdir(evidenceDirectory, { recursive: true });

const namedCommand = process.env.E1_T07_COMMAND ?? null;
if (namedCommand) {
  await runNamedCommand(namedCommand, await buildSourceHistory());
  for (const directory of projectionDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
} else {
  const records = await buildSourceHistory();
  const sourceDump = records.map(({ digest, event, offset, stream }) => ({
    digest,
    event,
    offset,
    stream,
  }));

  const rebuildEvidence = verifyDeletionAndRebuild(records);
  const crashEvidence = verifyCrashAndDuplicateRecovery(records);
  const liveCatchUpEvidence = verifyLiveCatchUp(records);
  const shadowEvidence = verifyShadowPrefixes(records);
  const accessEvidence = verifyAccessMatrix(records);
  const corruptionEvidence = verifyCorruptionDetection(records);
  const sensitivityEvidence =
    process.env.E1_T07_SKIP_SENSITIVITY === "1"
      ? { result: "SKIPPED", reason: "nested mutation verifier" }
      : await verifySensitivity();
  const canaryScan = await verifyCanaries(sourceDump);

  const gates = [];
  if (process.env.E1_T07_SKIP_GATES !== "1") {
    for (const [name, script] of [
      ["format", "format:check"],
      ["lint", "lint"],
      ["typecheck", "typecheck"],
      ["tests", "test"],
      ["build", "build"],
    ]) {
      const startedAt = Date.now();
      runPnpm(script, {
        ...process.env,
        BUILD_DIR: path.join(artifactRoot, "build"),
        E1_T07_IMPLEMENTATION_COMMIT: implementationCommit,
        E1_T07_SKIP_GATES: "1",
        TEST_ARTIFACT_DIR: artifactRoot,
        TEST_RUN_ID: runId,
      });
      gates.push({
        command: `pnpm ${script}`,
        durationMs: Date.now() - startedAt,
        name,
        result: "PASS",
      });
    }
  }

  const finalSnapshot = rebuildEvidence.afterSnapshot;
  const summary = {
    schemaVersion: 1,
    task: "E1-T07",
    runId,
    implementationCommit,
    implementationTreeCleanAtStart: trackedTreeCleanAtStart,
    result: "PASS",
    replay:
      "Replay: N/A (server projection and rebuild apparatus) + mitigation: projection deletion, source replay, row manifests, crash recovery, and digest parity",
    replayUploadAttempted: false,
    gates,
    canaryScan,
    source: {
      recordCount: records.length,
      streamCount: finalSnapshot.checkpoint.sourceHeads.length,
      sourceHeads: finalSnapshot.checkpoint.sourceHeads,
    },
    checkpoint: finalSnapshot.checkpoint,
    rowManifest: {
      projectionDigest: finalSnapshot.projectionDigest,
      rowCounts: Object.fromEntries(
        Object.entries(finalSnapshot.rows).map(([kind, rows]) => [
          kind,
          rows.length,
        ]),
      ),
    },
    rebuildEvidence,
    crashEvidence,
    liveCatchUpEvidence,
    shadowEvidence,
    accessEvidence,
    corruptionEvidence,
    sensitivityEvidence,
  };

  await writeJson(
    path.join(evidenceDirectory, "verification-summary.json"),
    summary,
  );
  await writeJson(path.join(evidenceDirectory, "source-dump.json"), {
    records: sourceDump,
  });
  await writeJson(path.join(evidenceDirectory, "checkpoint-manifest.json"), {
    checkpoint: finalSnapshot.checkpoint,
    projectionDigest: finalSnapshot.projectionDigest,
    rowCounts: summary.rowManifest.rowCounts,
  });
  await writeJson(
    path.join(evidenceDirectory, "row-manifest-before-rebuild.json"),
    rebuildEvidence.beforeManifest,
  );
  await writeJson(
    path.join(evidenceDirectory, "row-manifest-after-rebuild.json"),
    rebuildEvidence.afterManifest,
  );
  await writeJson(
    path.join(evidenceDirectory, "crash-recovery.json"),
    crashEvidence,
  );
  await writeJson(
    path.join(evidenceDirectory, "shadow-compare.json"),
    shadowEvidence,
  );
  await writeJson(
    path.join(evidenceDirectory, "access-matrix.json"),
    accessEvidence,
  );
  await writeJson(
    path.join(evidenceDirectory, "corruption-detection.json"),
    corruptionEvidence,
  );
  await writeJson(
    path.join(evidenceDirectory, "sensitivity.json"),
    sensitivityEvidence,
  );

  for (const directory of projectionDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }

  console.log(JSON.stringify(summary, null, 2));
}

async function runNamedCommand(command, records) {
  switch (command) {
    case "rebuild": {
      const proof = verifyDeletionAndRebuild(records);
      console.log(
        JSON.stringify(
          {
            afterProjectionDigest: proof.afterProjectionDigest,
            command,
            identicalCanonicalManifest: proof.identicalCanonicalManifest,
            result: proof.result,
          },
          null,
          2,
        ),
      );
      return;
    }
    case "catch-up":
      console.log(
        JSON.stringify({ command, ...verifyLiveCatchUp(records) }, null, 2),
      );
      return;
    case "corruption":
      console.log(
        JSON.stringify(
          { command, ...verifyCorruptionDetection(records) },
          null,
          2,
        ),
      );
      return;
    case "shadow":
      console.log(
        JSON.stringify({ command, ...verifyShadowPrefixes(records) }, null, 2),
      );
      return;
    default:
      throw new Error(
        `unknown E1_T07_COMMAND ${command}; expected rebuild, catch-up, corruption, or shadow`,
      );
  }
}

async function buildSourceHistory() {
  const channelFixture = await readJson(
    path.join(
      root,
      ".eforest/tasks/epic-1-the-workspace/E1-T03-channel-lifecycle-and-membership/fixtures/valid/channel-lifecycle.v1.json",
    ),
  );
  const conversationFixture = await readJson(
    path.join(
      root,
      ".eforest/tasks/epic-1-the-workspace/E1-T04-message-thread-reaction-contract/fixtures/valid/conversation.v1.json",
    ),
  );
  const events = [
    ...channelFixture.records
      .filter((record) => record.event.workspaceId === WORKSPACE_ID)
      .map((record) => record.event),
    ...conversationFixture.records
      .filter(
        (record) =>
          record.event.workspaceId === WORKSPACE_ID &&
          record.event.eventType.startsWith("channel.message."),
      )
      .map((record) => ({
        ...record.event,
        data: { ...record.event.data, channelId: MESSAGE_CHANNEL_ID },
      })),
  ];
  const messageCreated = conversationFixture.records.find(
    (record) => record.event.eventType === "channel.message.created",
  )?.event;
  assert.ok(messageCreated);
  events.push(
    {
      ...messageCreated,
      actorId: MEMBER_ID,
      data: {
        ...messageCreated.data,
        authorId: MEMBER_ID,
        channelId: MESSAGE_CHANNEL_ID,
        messageId: "active-a",
        text: "Unread active message",
      },
      eventId: "ev_zzzzzzzzzzzzzzzzzzzzzzzzzz",
      idempotencyKey: "ik_zzzzzzzzzzzzzzzzzzzzzzzzzz",
      serverTimestamp: "2026-08-04T00:00:00.000Z",
    },
    {
      ...messageCreated,
      data: {
        ...messageCreated.data,
        channelId: MESSAGE_CHANNEL_ID,
        messageId: "active-b",
        text: "Owner active message",
      },
      eventId: "ev_yyyyyyyyyyyyyyyyyyyyyyyyyy",
      idempotencyKey: "ik_yyyyyyyyyyyyyyyyyyyyyyyyyy",
      serverTimestamp: "2026-08-04T00:00:01.000Z",
    },
  );
  const directoryEventTypes = new Set([
    "principal.created",
    "workspace.created",
    "workspace.membership.invited",
    "workspace.membership.accepted",
    "workspace.membership.role.changed",
    "workspace.membership.suspended",
    "workspace.membership.removed",
  ]);
  const counters = new Map();
  const raw = events.map((event) => {
    const stream = directoryEventTypes.has(event.eventType)
      ? `workspace:${WORKSPACE_ID}/directory`
      : `channel:${event.data.channelId}`;
    const sequence = (counters.get(stream) ?? 0) + 1;
    counters.set(stream, sequence);
    return {
      event,
      offset: projectionOffset(sequence),
      stream,
    };
  });
  const normalized = normalizeSourceRecords(raw, WORKSPACE_ID);
  assert.ok(normalized.length > 0);
  assert.equal(
    new Set(normalized.map((record) => record.event.eventId)).size,
    normalized.length,
  );
  return normalized;
}

function verifyDeletionAndRebuild(records) {
  const { store, worker } = newProjection();
  worker.rebuild(records);
  const firstProof = assertProjectionIntegrity(store, records);
  const beforeSnapshot = store.read();
  const beforeManifest = projectionManifest({
    checkpoint: beforeSnapshot.checkpoint,
    projectionId: PROJECTION_ID,
    reducerVersion: beforeSnapshot.reducerVersion,
    rows: beforeSnapshot.rows,
    schemaVersion: beforeSnapshot.schemaVersion,
    workspaceId: WORKSPACE_ID,
  });
  store.deleteAll();
  assert.equal(store.read().checkpoint, null);
  worker.rebuild(records);
  const secondProof = assertProjectionIntegrity(store, records);
  const afterSnapshot = store.read();
  const afterManifest = projectionManifest({
    checkpoint: afterSnapshot.checkpoint,
    projectionId: PROJECTION_ID,
    reducerVersion: afterSnapshot.reducerVersion,
    rows: afterSnapshot.rows,
    schemaVersion: afterSnapshot.schemaVersion,
    workspaceId: WORKSPACE_ID,
  });
  assert.equal(firstProof.projectionDigest, secondProof.projectionDigest);
  assert.equal(
    projectionDigest(beforeManifest),
    projectionDigest(afterManifest),
  );
  return {
    beforeManifest,
    afterManifest,
    beforeProjectionDigest: firstProof.projectionDigest,
    afterProjectionDigest: secondProof.projectionDigest,
    deletionObserved: true,
    identicalCanonicalManifest: true,
    identicalStateDigest: firstProof.stateDigest === secondProof.stateDigest,
    afterSnapshot,
    result: "PASS",
  };
}

function verifyCrashAndDuplicateRecovery(records) {
  const duplicateDelivery = [
    ...records.slice(0, 12),
    records[11],
    ...records.slice(12),
  ];
  const { directory, store, worker } = newProjection();
  const crashSequence = 12;
  let crash;
  try {
    worker.rebuild(duplicateDelivery, { crashAfterRowsAt: crashSequence });
  } catch (error) {
    crash = error;
  }
  assert.equal(crash?.code, PROJECTION_ERROR_CODES.CRASH_AFTER_ROW_WRITE);
  const dirtySnapshot = store.read();
  assert.equal(dirtySnapshot.rowsSequence, crashSequence);
  assert.equal(dirtySnapshot.checkpoint.sequence, crashSequence - 1);
  const restarted = newProjection({ directory });
  const persistedSnapshot = restarted.store.read();
  assert.equal(persistedSnapshot.rowsSequence, crashSequence);
  assert.equal(persistedSnapshot.checkpoint.sequence, crashSequence - 1);
  restarted.worker.catchUp(duplicateDelivery);
  const proof = assertProjectionIntegrity(restarted.store, records);
  assert.equal(restarted.store.read().checkpoint.sequence, records.length);
  return {
    crashSequence,
    checkpointBeforeCrash: crashSequence - 1,
    rowsWrittenBeforeCrash: crashSequence,
    duplicateDeliveryIgnored: true,
    recoveredCheckpoint: restarted.store.read().checkpoint,
    recoveredProjectionDigest: proof.projectionDigest,
    noDuplicateLogicalRows: true,
    noMissedLogicalEffects: true,
    resumedFromOlderValidCheckpoint: true,
    restartObserved: true,
    result: "PASS",
  };
}

function verifyLiveCatchUp(records) {
  const split = Math.max(1, Math.floor(records.length / 2));
  const initial = newProjection();
  initial.worker.rebuild(records.slice(0, split));
  const checkpointBefore = initial.store.read().checkpoint;
  const restarted = newProjection({ directory: initial.directory });
  restarted.worker.catchUp(records);
  const proof = assertProjectionIntegrity(restarted.store, records);
  return {
    checkpointBefore,
    checkpointAfter: restarted.store.read().checkpoint,
    caughtUpRecords: records.length - split,
    projectionDigest: proof.projectionDigest,
    resumedFromPersistedCheckpoint: true,
    result: "PASS",
  };
}

function verifyShadowPrefixes(records) {
  const expected = replayIndependentPrefixes(records, WORKSPACE_ID);
  const observed = [];
  for (let sequence = 1; sequence <= records.length; sequence += 1) {
    const { store, worker } = newProjection();
    worker.rebuild(records.slice(0, sequence));
    const snapshot = store.read();
    assert.equal(
      snapshot.checkpoint.stateDigest,
      expected[sequence - 1].stateDigest,
    );
    assert.deepEqual(
      logicalRows(snapshot.rows),
      expected[sequence - 1].rows,
      `independent replay mismatch at prefix ${sequence}`,
    );
    observed.push({
      projectionDigest: snapshot.projectionDigest,
      sequence,
      sourceHeads: snapshot.checkpoint.sourceHeads,
      stateDigest: snapshot.checkpoint.stateDigest,
      logicalRowCount: Object.values(expected[sequence - 1].rows).reduce(
        (count, rows) => count + rows.length,
        0,
      ),
    });
  }
  return {
    prefixCount: observed.length,
    first: observed[0],
    final: observed.at(-1),
    allPrefixesMatchIndependentReplay: true,
    prefixes: observed,
    result: "PASS",
  };
}

function verifyAccessMatrix(records) {
  const { store, worker } = newProjection();
  worker.rebuild(records);
  const queries = createProjectionQueries(store);
  const ownerChannels = queries.listChannels({
    principalId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
  });
  const serviceChannels = queries.listChannels({
    principalId: SERVICE_ID,
    workspaceId: WORKSPACE_ID,
  });
  assert.ok(ownerChannels.some((row) => row.value.kind === "private"));
  assert.ok(ownerChannels.some((row) => row.value.kind === "direct"));
  assert.equal(
    serviceChannels.some((row) => row.value.kind === "private"),
    false,
  );
  assert.equal(
    serviceChannels.some((row) => row.value.kind === "direct"),
    false,
  );
  const ownerMessages = queries.listMessages({
    channelId: MESSAGE_CHANNEL_ID,
    limit: 1,
    principalId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
  });
  assert.equal(ownerMessages.messages.length, 1);
  assert.ok(ownerMessages.nextCursor);
  const ownerNextPage = queries.listMessages({
    after: ownerMessages.nextCursor,
    channelId: MESSAGE_CHANNEL_ID,
    limit: 1,
    principalId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
  });
  assert.equal(ownerNextPage.messages.length, 1);
  const visibleOwnerMessages = [
    ...ownerMessages.messages,
    ...ownerNextPage.messages,
  ];
  const deletedMessageIds = new Set(
    store
      .read()
      .rows.message.filter((row) => row.value.status === "deleted")
      .map((row) => row.id),
  );
  assert.ok(deletedMessageIds.size > 0);
  assert.ok(visibleOwnerMessages.every((row) => row.value.status === "active"));
  assert.equal(
    visibleOwnerMessages.some((row) => deletedMessageIds.has(row.id)),
    false,
  );
  const serviceChannelCount = queries.countChannels({
    principalId: SERVICE_ID,
    workspaceId: WORKSPACE_ID,
  });
  assert.equal(serviceChannelCount, serviceChannels.length);
  assert.ok(ownerChannels.length > serviceChannelCount);
  assert.equal(
    queries.listThreads({
      channelId: MESSAGE_CHANNEL_ID,
      principalId: OWNER_ID,
      workspaceId: WORKSPACE_ID,
    }).length,
    2,
  );
  assert.equal(
    queries.listReactions({
      messageId: "root-a",
      principalId: OWNER_ID,
      workspaceId: WORKSPACE_ID,
    }).length,
    0,
  );
  const unread = queries.getUnread({
    channelId: MESSAGE_CHANNEL_ID,
    principalId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
  });
  assert.equal(unread.value.count, 1);

  const cases = [
    {
      label: "private-row-service",
      principalId: SERVICE_ID,
      operation: () =>
        queries.getChannel({
          channelId: PRIVATE_CHANNEL_ID,
          principalId: SERVICE_ID,
          workspaceId: WORKSPACE_ID,
        }),
    },
    {
      label: "direct-row-service",
      principalId: SERVICE_ID,
      operation: () =>
        queries.getChannel({
          channelId: DIRECT_CHANNEL_ID,
          principalId: SERVICE_ID,
          workspaceId: WORKSPACE_ID,
        }),
    },
    {
      label: "private-messages-service",
      principalId: SERVICE_ID,
      operation: () =>
        queries.listMessages({
          channelId: PRIVATE_CHANNEL_ID,
          principalId: SERVICE_ID,
          workspaceId: WORKSPACE_ID,
        }),
    },
    {
      label: "workspace-count-outsider",
      principalId: OUTSIDER_ID,
      operation: () =>
        queries.countChannels({
          principalId: OUTSIDER_ID,
          workspaceId: WORKSPACE_ID,
        }),
    },
    {
      label: "private-threads-service",
      principalId: SERVICE_ID,
      operation: () =>
        queries.listThreads({
          channelId: PRIVATE_CHANNEL_ID,
          principalId: SERVICE_ID,
          workspaceId: WORKSPACE_ID,
        }),
    },
    {
      label: "private-reactions-service",
      principalId: SERVICE_ID,
      operation: () =>
        queries.listReactions({
          messageId: "active-a",
          principalId: SERVICE_ID,
          workspaceId: WORKSPACE_ID,
        }),
    },
    {
      label: "private-unread-service",
      principalId: SERVICE_ID,
      operation: () =>
        queries.getUnread({
          channelId: PRIVATE_CHANNEL_ID,
          principalId: SERVICE_ID,
          workspaceId: WORKSPACE_ID,
        }),
    },
  ];
  const observed = cases.map(({ label, operation, principalId }) => {
    let error;
    try {
      operation();
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, PROJECTION_ERROR_CODES.ACCESS_DENIED, label);
    assert.equal(error?.detail.includes(principalId), false, label);
    assert.equal(error?.detail.includes(PRIVATE_CHANNEL_ID), false, label);
    return {
      code: error.code,
      label,
      identityLeaked: false,
      result: "REFUSED",
    };
  });
  const timingProbe = runTimingProbe(queries, SERVICE_ID);
  return {
    visibleOwnerChannelKinds: ownerChannels.map((row) => row.value.kind),
    serviceVisibleChannelKinds: serviceChannels.map((row) => row.value.kind),
    ownerChannelCount: ownerChannels.length,
    serviceChannelCount,
    ownerMessagePages: [ownerMessages, ownerNextPage],
    deletedMessageIdsExcluded: true,
    unread,
    cases: observed,
    timingProbe,
    privateRowsRemainUndiscoverable: true,
    result: "PASS",
  };
}

function runTimingProbe(queries, principalId) {
  const existing = measureDenied(queries, PRIVATE_CHANNEL_ID, principalId);
  const sibling = measureDenied(
    queries,
    "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_99999999999999999999999999",
    principalId,
  );
  assert.deepEqual(existing.errors, sibling.errors);
  return {
    existingSamplesMs: existing.samplesMs,
    siblingSamplesMs: sibling.samplesMs,
    equalErrorSurface: true,
    result: "PASS",
  };
}

function measureDenied(queries, channelId, principalId) {
  const samplesMs = [];
  const errors = [];
  for (let index = 0; index < 8; index += 1) {
    const startedAt = performance.now();
    try {
      queries.getChannel({
        channelId,
        principalId,
        workspaceId: WORKSPACE_ID,
      });
    } catch (error) {
      errors.push({ code: error.code, detail: error.detail });
    }
    samplesMs.push(Number((performance.now() - startedAt).toFixed(3)));
  }
  return { errors, samplesMs };
}

function verifyCorruptionDetection(records) {
  const { store, worker } = newProjection();
  worker.rebuild(records);
  const snapshot = store.read();
  const corruptedRows = structuredClone(snapshot.rows);
  corruptedRows.message[0].source.digest =
    "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  store.writeRows(corruptedRows, snapshot.checkpoint.sequence);
  let rowError;
  try {
    assertProjectionIntegrity(store, records);
  } catch (error) {
    rowError = error;
  }
  assert.equal(rowError?.code, PROJECTION_ERROR_CODES.CORRUPT_ROW);
  assert.match(rowError?.detail ?? "", /unknown source reference/u);

  const reducerVersionRows = structuredClone(snapshot.rows);
  reducerVersionRows.message[0].reducerVersion = "stream-slack-reducer-v0";
  let reducerVersionError;
  try {
    assertProjectionIntegrity(
      { read: () => ({ ...snapshot, rows: reducerVersionRows }) },
      records,
    );
  } catch (error) {
    reducerVersionError = error;
  }
  assert.equal(
    reducerVersionError?.code,
    PROJECTION_ERROR_CODES.REDUCER_VERSION_MISMATCH,
  );
  assert.match(reducerVersionError?.detail ?? "", /unsupported reducer/u);

  const { store: checkpointStore, worker: checkpointWorker } = newProjection();
  checkpointWorker.rebuild(records);
  const badCheckpoint = structuredClone(checkpointStore.read().checkpoint);
  badCheckpoint.sourceHeads[0].stream =
    "workspace:ws_bbbbbbbbbbbbbbbbbbbbbbbbbb/directory";
  let checkpointError;
  try {
    checkpointStore.writeCheckpoint(badCheckpoint);
  } catch (error) {
    checkpointError = error;
  }
  assert.equal(
    checkpointError?.code,
    PROJECTION_ERROR_CODES.CHECKPOINT_INVALID,
  );
  return {
    rowSourceRefused: rowError.code,
    rowSourceDetail: rowError.detail,
    reducerVersionRefused: reducerVersionError.code,
    reducerVersionDetail: reducerVersionError.detail,
    crossWorkspaceCheckpointRefused: checkpointError.code,
    sourceDigestChecked: true,
    reducerVersionChecked: true,
    result: "PASS",
  };
}

async function verifySensitivity() {
  await mkdir(path.join(taskDirectory, "work"), { recursive: true });
  const mutationParent = await mkdtemp(
    path.join(taskDirectory, "work/sensitivity-mutant-"),
  );
  const mutationCheckout = path.join(mutationParent, "checkout");
  let worktreeAdded = false;
  try {
    execFileSync(
      "git",
      ["worktree", "add", "--detach", mutationCheckout, implementationCommit],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    worktreeAdded = true;
    const projectionPath = path.join(mutationCheckout, "src/projections.mjs");
    const source = await readFile(projectionPath, "utf8");
    const provenanceStart = source.indexOf("function assertRowProvenance(");
    const provenanceBodyStart = source.indexOf(") {", provenanceStart) + 3;
    const provenanceEnd = source.indexOf(
      "\n}\n\nexport function projectionManifest",
      provenanceBodyStart,
    );
    assert.ok(provenanceStart >= 0);
    assert.ok(provenanceBodyStart > provenanceStart);
    assert.ok(provenanceEnd > provenanceBodyStart);
    await writeFile(
      projectionPath,
      `${source.slice(0, provenanceBodyStart)}\n  // sensitivity mutant: omit row provenance checks${source.slice(provenanceEnd)}`,
    );
    const mutationArtifactDirectory = path.join(
      mutationCheckout,
      ".artifacts/e1-t07-sensitivity",
    );
    await mkdir(mutationArtifactDirectory, { recursive: true });
    const mutationEnv = {
      ...process.env,
      E1_T07_IMPLEMENTATION_COMMIT: implementationCommit,
      E1_T07_SKIP_GATES: "1",
      E1_T07_SKIP_SENSITIVITY: "1",
      TEST_ARTIFACT_DIR: mutationArtifactDirectory,
      TEST_RUN_ID: `${runId}-checkpoint-mutant`,
    };
    delete mutationEnv.PROMOTE_EVIDENCE;
    const install = runSensitivityCommand(
      "pnpm",
      ["install", "--frozen-lockfile"],
      mutationCheckout,
      mutationEnv,
    );
    assert.equal(install.exitCode, 0, install.output);
    const verifier = runSensitivityCommand(
      "node",
      ["scripts/verify-e1-t07.mjs"],
      mutationCheckout,
      mutationEnv,
    );
    assert.notEqual(verifier.exitCode, 0);
    assert.match(
      verifier.output,
      /projection row manifest differs from independent source replay/u,
    );
    return {
      changedFile: "src/projections.mjs",
      mutation: "row source-digest and reducer-version checks omitted",
      installExitCode: install.exitCode,
      verifierExitCode: verifier.exitCode,
      verifierRejected: true,
      result: "PASS",
    };
  } finally {
    if (worktreeAdded) {
      try {
        execFileSync(
          "git",
          ["worktree", "remove", "--force", mutationCheckout],
          { cwd: root, stdio: "ignore" },
        );
      } catch {
        // Preserve the original verifier result; cleanup is best effort.
      }
    }
    await rm(mutationParent, { recursive: true, force: true });
  }
}

async function verifyCanaries(sourceDump) {
  const files = [
    path.join(taskDirectory, "readme.md"),
    path.join(
      root,
      ".eforest/tasks/epic-1-the-workspace/E1-T03-channel-lifecycle-and-membership/fixtures/valid/channel-lifecycle.v1.json",
    ),
    path.join(
      root,
      ".eforest/tasks/epic-1-the-workspace/E1-T04-message-thread-reaction-contract/fixtures/valid/conversation.v1.json",
    ),
  ];
  const patterns = [
    /bearer\s+[A-Za-z0-9._-]+/iu,
    /password\s*[=:]/iu,
    /api[_-]?key\s*[=:]/iu,
    /-----BEGIN [A-Z ]+-----/u,
  ];
  let matches = 0;
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const pattern of patterns) if (pattern.test(content)) matches += 1;
  }
  assert.equal(matches, 0);
  assert.ok(
    sourceDump.every((record) => !JSON.stringify(record).includes("password")),
  );
  return {
    files: files.map((file) => path.relative(root, file)),
    forbiddenPatterns: 0,
    result: "PASS",
  };
}

function newProjection({ directory = null, persistent = true } = {}) {
  const storageDirectory =
    directory ??
    (persistent
      ? mkdtempSync(path.join(artifactRoot, "projection-store-"))
      : null);
  if (storageDirectory) projectionDirectories.add(storageDirectory);
  const store = createProjectionStore({
    directory: storageDirectory,
    projectionId: PROJECTION_ID,
    workspaceId: WORKSPACE_ID,
  });
  const worker = createProjectionWorker({
    projectionId: PROJECTION_ID,
    store,
    workspaceId: WORKSPACE_ID,
  });
  return { directory: storageDirectory, store, worker };
}

function logicalRows(rows) {
  return Object.fromEntries(
    Object.entries(rows).map(([kind, values]) => [
      kind,
      values
        .map(({ id, kind: rowKind, value, workspaceId }) => ({
          id,
          kind: rowKind,
          value,
          workspaceId,
        }))
        .sort((left, right) => `${left.id}`.localeCompare(`${right.id}`)),
    ]),
  );
}

function runSensitivityCommand(command, args, cwd, env) {
  try {
    execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exitCode: 0, output: "" };
  } catch (error) {
    return {
      exitCode: typeof error.status === "number" ? error.status : 1,
      output: [error.stdout, error.stderr]
        .filter(Boolean)
        .map((value) => value.toString())
        .join("\n"),
    };
  }
}

function runPnpm(script, env) {
  execFileSync("pnpm", [script], {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function projectionOffset(sequence) {
  return `0000000000000000_${sequence.toString(16).padStart(16, "0")}`;
}

function assertImplementationBinding(commit) {
  const resolved = execFileSync(
    "git",
    ["rev-parse", "--verify", `${commit}^{commit}`],
    { cwd: root, encoding: "utf8" },
  ).trim();
  assert.equal(resolved, commit, "implementation commit must resolve exactly");
  execFileSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], {
    cwd: root,
    stdio: "ignore",
  });
  const changedPaths = execFileSync(
    "git",
    ["diff", "--name-only", `${commit}..HEAD`],
    { cwd: root, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const taskReadmePath = path.relative(
    root,
    path.join(taskDirectory, "readme.md"),
  );
  const evidencePrefix = `${path
    .relative(root, path.join(taskDirectory, "evidence"))
    .replaceAll(path.sep, "/")}/`;
  const allowed = new Set([
    ".eforest/project.json",
    ".eforest/tasks/QUEUE.md",
    taskReadmePath,
    "Makefile",
    "package.json",
    "scripts/cold-verify-e1-t07.mjs",
    "scripts/e1-t07-command.mjs",
    "scripts/e1-t07-independent-replay.mjs",
    "scripts/verify-e1-t07.mjs",
    "src/projections.mjs",
    "test/unit/projections.test.mjs",
  ]);
  const unexpected = changedPaths.filter(
    (filePath) =>
      !allowed.has(filePath) && !filePath.startsWith(evidencePrefix),
  );
  assert.deepEqual(
    unexpected,
    [],
    "implementation commit must bind the exact diff",
  );
}
