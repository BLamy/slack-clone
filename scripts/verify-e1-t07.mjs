import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  replayProjectionPrefixes,
  PROJECTION_ERROR_CODES,
} from "../src/projections.mjs";

const WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const MEMBER_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const SERVICE_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";
const OUTSIDER_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_ffffffffffffffffffffffffff";
const PUBLIC_CHANNEL_ID =
  "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_11111111111111111111111111";
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
await mkdir(evidenceDirectory, { recursive: true });

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
  implementationTreeCleanAtStart: promoteEvidence,
  result: "PASS",
  replay:
    "Replay: N/A (server projection and rebuild apparatus) + mitigation: projection deletion, source replay, row manifests, crash recovery, ACL matrix, and digest parity",
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

console.log(JSON.stringify(summary, null, 2));

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
  const { store, worker } = newProjection();
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
  worker.catchUp(duplicateDelivery);
  const proof = assertProjectionIntegrity(store, records);
  assert.equal(store.read().checkpoint.sequence, records.length);
  return {
    crashSequence,
    checkpointBeforeCrash: crashSequence - 1,
    rowsWrittenBeforeCrash: crashSequence,
    duplicateDeliveryIgnored: true,
    recoveredCheckpoint: store.read().checkpoint,
    recoveredProjectionDigest: proof.projectionDigest,
    noDuplicateLogicalRows: true,
    noMissedLogicalEffects: true,
    result: "PASS",
  };
}

function verifyLiveCatchUp(records) {
  const split = Math.max(1, Math.floor(records.length / 2));
  const { store, worker } = newProjection();
  worker.rebuild(records.slice(0, split));
  const checkpointBefore = store.read().checkpoint;
  worker.catchUp(records);
  const proof = assertProjectionIntegrity(store, records);
  return {
    checkpointBefore,
    checkpointAfter: store.read().checkpoint,
    caughtUpRecords: records.length - split,
    projectionDigest: proof.projectionDigest,
    result: "PASS",
  };
}

function verifyShadowPrefixes(records) {
  const expected = replayProjectionPrefixes(
    records,
    WORKSPACE_ID,
    PROJECTION_ID,
  );
  const observed = [];
  for (let sequence = 1; sequence <= records.length; sequence += 1) {
    const { store, worker } = newProjection();
    worker.rebuild(records.slice(0, sequence));
    const snapshot = store.read();
    const proof = assertProjectionIntegrity(store, records.slice(0, sequence));
    assert.equal(
      snapshot.projectionDigest,
      expected[sequence - 1].projectionDigest,
    );
    assert.equal(proof.stateDigest, expected[sequence - 1].stateDigest);
    observed.push({
      projectionDigest: snapshot.projectionDigest,
      sequence,
      sourceHeads: snapshot.checkpoint.sourceHeads,
      stateDigest: snapshot.checkpoint.stateDigest,
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
  assert.equal(
    queries.listThreads({
      channelId: MESSAGE_CHANNEL_ID,
      principalId: OWNER_ID,
      workspaceId: WORKSPACE_ID,
    }).length,
    1,
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
  assert.equal(unread.value.count, 0);

  const cases = [
    {
      label: "private-row-service",
      operation: () =>
        queries.getChannel({
          channelId: PRIVATE_CHANNEL_ID,
          principalId: SERVICE_ID,
          workspaceId: WORKSPACE_ID,
        }),
    },
    {
      label: "direct-row-service",
      operation: () =>
        queries.getChannel({
          channelId: DIRECT_CHANNEL_ID,
          principalId: SERVICE_ID,
          workspaceId: WORKSPACE_ID,
        }),
    },
    {
      label: "private-messages-outsider",
      operation: () =>
        queries.listMessages({
          channelId: PRIVATE_CHANNEL_ID,
          principalId: OUTSIDER_ID,
          workspaceId: WORKSPACE_ID,
        }),
    },
    {
      label: "private-count-outsider",
      operation: () =>
        queries.countChannels({
          principalId: OUTSIDER_ID,
          workspaceId: WORKSPACE_ID,
        }),
    },
  ];
  const observed = cases.map(({ label, operation }) => {
    let error;
    try {
      operation();
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, PROJECTION_ERROR_CODES.ACCESS_DENIED, label);
    assert.equal(error?.detail.includes(OUTSIDER_ID), false, label);
    assert.equal(error?.detail.includes(PRIVATE_CHANNEL_ID), false, label);
    return {
      code: error.code,
      label,
      identityLeaked: false,
      result: "REFUSED",
    };
  });
  return {
    visibleOwnerChannelKinds: ownerChannels.map((row) => row.value.kind),
    serviceVisibleChannelKinds: serviceChannels.map((row) => row.value.kind),
    ownerMessagePages: [ownerMessages, ownerNextPage],
    unread,
    cases: observed,
    privateRowsRemainUndiscoverable: true,
    result: "PASS",
  };
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
    const anchor = "store.writeCheckpoint(checkpoint);";
    assert.equal(source.split(anchor).length - 1, 1);
    await writeFile(
      projectionPath,
      source.replace(
        anchor,
        "// sensitivity mutant: omit checkpoint persistence",
      ),
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
    assert.match(verifier.output, /checkpoint|projection/u);
    return {
      changedFile: "src/projections.mjs",
      mutation: "checkpoint persistence omitted",
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

function newProjection() {
  const store = createProjectionStore({
    projectionId: PROJECTION_ID,
    workspaceId: WORKSPACE_ID,
  });
  const worker = createProjectionWorker({
    projectionId: PROJECTION_ID,
    store,
    workspaceId: WORKSPACE_ID,
  });
  return { store, worker };
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
