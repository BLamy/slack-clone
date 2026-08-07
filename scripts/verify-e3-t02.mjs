import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  deriveMentionInvocationId,
  validateMentionFacts,
} from "@stream-slack/protocol";
import { replayRecords } from "@stream-slack/reducers";
import { canonicalSha256 } from "../src/ledger/canonical-json.mjs";
import {
  digestEventEnvelope,
  issueEventEnvelope,
} from "../src/ledger/envelope.mjs";
import { createDispatchDoor } from "../src/ledger/dispatch.mjs";
import {
  createMentionReconciler,
  MENTION_RECONCILER_ERROR_CODES,
} from "../src/ledger/mention-reconciler.mjs";
import { streamNames } from "../src/ledger/topology.mjs";

const WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHANNEL_ID = "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const ACTOR_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const AGENT_PRINCIPAL_ID =
  "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";
const AGENT_ID = "ag_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";
const CHANNEL_STREAM = streamNames.channel(WORKSPACE_ID, CHANNEL_ID);
const INVOCATION_STREAM = streamNames.workspaceInvocations(WORKSPACE_ID);
const AUDIT_STREAM = streamNames.workspaceAudit(WORKSPACE_ID);
const ALPHABET = "abcdefghjkmnpqrstvwxyz";

const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-3-the-dispatcher/E3-T02-mention-reconciler",
);
const fixture = JSON.parse(
  await readFile(
    path.join(taskDirectory, "fixtures/mention-reconciler-corpus.v1.json"),
    "utf8",
  ),
);
assert.equal(fixture.task, "E3-T02");
assert.equal(fixture.schemaVersion, 1);
const runId = String(
  process.env.TEST_RUN_ID ?? `verify-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/gu, "-");
const implementationCommit = String(
  process.env.E3_T02_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
assert.match(implementationCommit, /^[0-9a-f]{40}$/u);
const promoteEvidence = process.env.PROMOTE_EVIDENCE === "1";
if (promoteEvidence) {
  assert.equal(
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    "",
    "promoted E3-T02 evidence requires a clean tracked implementation tree",
  );
}
const artifactRoot = path.resolve(
  root,
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e3-t02", runId),
);
const evidenceDirectory = promoteEvidence
  ? path.join(taskDirectory, "evidence/e3-t02-final")
  : artifactRoot;
await mkdir(evidenceDirectory, { recursive: true });

const race = await verifyDuplicateRace();
const crashes = await verifyCrashSchedules();
const outcomes = await verifyNonRunnableOutcomes();
const attacks = await verifySourceAndCheckpointAttacks();
const replay = await verifyReplayDigests(race);
const sensitivity =
  process.env.E3_T02_SKIP_SENSITIVITY === "1"
    ? { reason: "nested mutation verifier", result: "SKIPPED" }
    : await verifySensitivity();

const gates = [];
if (process.env.E3_T02_SKIP_GATES !== "1") {
  for (const [name, script] of [
    ["format", "format:check"],
    ["lint", "lint"],
    ["typecheck", "typecheck"],
    ["tests", "test"],
    ["build", "build"],
  ]) {
    const startedAt = Date.now();
    execFileSync("pnpm", [script], {
      cwd: root,
      env: {
        ...process.env,
        BUILD_DIR: path.join(artifactRoot, "build"),
        E3_T02_IMPLEMENTATION_COMMIT: implementationCommit,
        E3_T02_SKIP_GATES: "1",
        E3_T02_SKIP_SENSITIVITY: "1",
        TEST_ARTIFACT_DIR: artifactRoot,
        TEST_RUN_ID: runId,
      },
      stdio: "inherit",
    });
    gates.push({
      command: `pnpm ${script}`,
      durationMs: Date.now() - startedAt,
      name,
      result: "PASS",
    });
  }
}

const sourceManifest = {
  channelStream: CHANNEL_STREAM,
  records: race.source.records.map((record) => ({
    digest: record.digest,
    eventType: record.event.eventType,
    mentions: record.event.data.mentions?.length ?? 0,
    offset: record.offset,
  })),
  streamDigest: race.source.streamDigest,
};
const checkpointManifest = {
  checkpointStream: race.reconciler.checkpointStream,
  records: race.checkpoints.records.map((record) => ({
    eventId: record.event.eventId,
    projectionId: record.event.data.projectionId,
    sequence: record.event.data.sequence,
    sourceOffset: record.event.data.sourceOffset,
    sourceStream: record.event.data.sourceStream,
    stateDigest: record.event.data.stateDigest,
  })),
  streamDigest: race.checkpoints.streamDigest,
};
const invocationManifest = {
  records: race.invocations.records.map((record) => ({
    eventId: record.event.eventId,
    invocationId: record.event.data.invocationId,
    policyDigest: record.event.data.policyDigest,
    snapshotDigest: record.event.data.snapshotDigest,
    snapshotRef: record.event.data.snapshotRef,
    sourceTrigger: record.event.data.sourceTrigger,
  })),
  stream: INVOCATION_STREAM,
  streamDigest: race.invocations.streamDigest,
};
const summary = {
  attacks,
  canaryScan: null,
  crashSchedules: crashes,
  duplicateRace: race.report,
  gates,
  implementationCommit,
  implementationTreeCleanAtStart: promoteEvidence,
  nonRunnableOutcomes: outcomes,
  replayEvidence: replay,
  replayUploadAttempted: false,
  result: "PASS",
  replay: fixture.replay,
  runId,
  sensitivity,
  task: "E3-T02",
};

await writeJson(
  path.join(evidenceDirectory, "source-manifest.json"),
  sourceManifest,
);
await writeJson(
  path.join(evidenceDirectory, "checkpoint-manifest.json"),
  checkpointManifest,
);
await writeJson(
  path.join(evidenceDirectory, "invocation-receipts.json"),
  invocationManifest,
);
await writeJson(
  path.join(evidenceDirectory, "duplicate-race.json"),
  race.report,
);
await writeJson(path.join(evidenceDirectory, "crash-schedules.json"), crashes);
await writeJson(path.join(evidenceDirectory, "outcomes.json"), outcomes);
await writeJson(path.join(evidenceDirectory, "source-attacks.json"), attacks);
await writeJson(path.join(evidenceDirectory, "replay-digests.json"), replay);
await writeJson(path.join(evidenceDirectory, "sensitivity.json"), sensitivity);
await writeJson(
  path.join(evidenceDirectory, "verification-summary.json"),
  summary,
);

const canaryScan = await scanEvidenceDirectory(evidenceDirectory);
const publishedCanaryScan = {
  ...canaryScan,
  canaryPresentInPublishedEvidence: canaryScan.leaked,
  publishedEvidenceLeaked: canaryScan.leaked,
};
summary.canaryScan = publishedCanaryScan;
await writeJson(
  path.join(evidenceDirectory, "canary-scan.json"),
  publishedCanaryScan,
);
await writeJson(
  path.join(evidenceDirectory, "verification-summary.json"),
  summary,
);
const finalScan = await scanEvidenceDirectory(evidenceDirectory);
assert.equal(
  finalScan.leaked,
  false,
  "E3-T02 evidence leaked credential material",
);

console.log(JSON.stringify(summary, null, 2));

async function verifyDuplicateRace() {
  const store = createMemoryStore({ appendDelayMs: 1 });
  const source = seedSource(store, {
    mentions: [agentMention(AGENT_PRINCIPAL_ID, "helper")],
    text: "@helper",
  });
  const snapshot = snapshotFor({
    agentId: AGENT_ID,
    sourceTrigger: source.reference,
  });
  const reconcilers = [];
  const doors = [];
  for (let index = 0; index < fixture.race.duplicateDeliveries; index += 1) {
    const door = createDispatchDoor({
      producerId: `e3-t02-race-door-${index}`,
      streamStore: store,
    });
    doors.push(door);
    reconcilers.push(
      createReconciler({
        door,
        resolveTarget: async () => ({ snapshot, status: "eligible" }),
        store,
      }),
    );
  }
  const reports = await Promise.all(
    reconcilers.map((reconciler) => reconciler.reconcile()),
  );
  const invocations = await store.read(INVOCATION_STREAM);
  const checkpoints = await store.read(reconcilers[0].checkpointStream);
  assert.equal(invocations.records.length, fixture.race.effectiveInvocations);
  assert.equal(checkpoints.records.length, fixture.race.effectiveCheckpoints);
  const invocation = invocations.records[0].event.data;
  assert.equal(
    invocation.invocationId,
    deriveMentionInvocationId({
      agentId: AGENT_ID,
      sourceTrigger: source.reference,
      workspaceId: WORKSPACE_ID,
    }),
  );
  assert.deepEqual(invocation.sourceTrigger, source.reference);
  const receipts = reports.flatMap((report) =>
    report.processed.flatMap((processed) =>
      processed.targets
        .filter((target) => target.status === "invoked")
        .map((target) => target.receipt),
    ),
  );
  assert.ok(receipts.length > 0);
  assert.equal(new Set(receipts.map((receipt) => receipt.nextOffset)).size, 1);
  assert.equal(new Set(receipts.map((receipt) => receipt.eventDigest)).size, 1);
  for (const door of doors) door.close();
  return {
    checkpoints,
    invocations,
    reconciler: reconcilers[0],
    report: {
      duplicateDeliveries: fixture.race.duplicateDeliveries,
      effectiveCheckpointRecords: checkpoints.records.length,
      effectiveInvocationRecords: invocations.records.length,
      invocationId: invocation.invocationId,
      receiptEventDigests: [
        ...new Set(receipts.map((receipt) => receipt.eventDigest)),
      ],
      receiptNextOffsets: [
        ...new Set(receipts.map((receipt) => receipt.nextOffset)),
      ],
      sameLogicalReceipt: true,
      source: source.reference,
    },
    source: await store.read(CHANNEL_STREAM),
  };
}

async function verifyCrashSchedules() {
  const results = [];
  for (const boundary of fixture.crashBoundaries) {
    const store = createMemoryStore();
    const source = seedSource(store, {
      mentions: [agentMention(AGENT_PRINCIPAL_ID, "helper")],
      text: "@helper",
    });
    const invocationStream = streamNames.workspaceInvocations(WORKSPACE_ID);
    if (boundary === "lost-acknowledgement") {
      store.failAfterAppendOnce(invocationStream);
    }
    const snapshot = snapshotFor({
      agentId: AGENT_ID,
      sourceTrigger: source.reference,
    });
    const firstDoor = createDispatchDoor({
      producerId: `e3-t02-crash-${boundary}`,
      streamStore: store,
    });
    const first = createReconciler({
      door: firstDoor,
      resolveTarget: async () => ({ snapshot, status: "eligible" }),
      onBoundary: async (observed) => {
        if (observed === boundary) throw new Error("simulated crash");
      },
      store,
    });
    let firstFailed = false;
    try {
      await first.reconcile();
    } catch {
      firstFailed = true;
    }
    assert.equal(firstFailed, true, boundary);
    firstDoor.close();
    const retryDoor = createDispatchDoor({
      producerId: `e3-t02-retry-${boundary}`,
      streamStore: store,
    });
    const retry = createReconciler({
      door: retryDoor,
      resolveTarget: async () => ({ snapshot, status: "eligible" }),
      store,
    });
    await retry.reconcile();
    const invocations = await store.read(INVOCATION_STREAM);
    const checkpoints = await store.read(retry.checkpointStream);
    assert.equal(invocations.records.length, 1, boundary);
    assert.equal(checkpoints.records.length, 1, boundary);
    retryDoor.close();
    results.push({
      boundary,
      finalCheckpointCount: checkpoints.records.length,
      finalInvocationCount: invocations.records.length,
      resumed: true,
    });
  }
  return { schedules: results, result: "PASS" };
}

async function verifyNonRunnableOutcomes() {
  const store = createMemoryStore();
  const targets = [
    {
      code: MENTION_RECONCILER_ERROR_CODES.TARGET_NOT_AGENT,
      kind: "human",
      label: "human",
      letter: "f",
    },
    {
      code: MENTION_RECONCILER_ERROR_CODES.TARGET_KIND,
      label: "service",
      letter: "g",
    },
    {
      code: "INVOCATION_SNAPSHOT_AGENT_CONFIG_INACTIVE",
      label: "disabled",
      letter: "h",
    },
    {
      code: "INVOCATION_SNAPSHOT_MEMBERSHIP_INACTIVE",
      label: "suspended",
      letter: "j",
    },
    {
      code: MENTION_RECONCILER_ERROR_CODES.TARGET_REMOVED,
      label: "removed",
      letter: "k",
    },
    {
      code: MENTION_RECONCILER_ERROR_CODES.TARGET_NOT_MEMBER,
      label: "non-member",
      letter: "m",
    },
    {
      code: "INVOCATION_SNAPSHOT_AGENT_CONFIG_INVALID",
      label: "invalid-config",
      letter: "n",
    },
    {
      code: "INVOCATION_SNAPSHOT_PROVIDER_RESOLUTION_REFUSED",
      label: "unavailable-provider",
      letter: "p",
    },
    {
      code: "INVOCATION_SNAPSHOT_STALE_CONFIG",
      label: "stale-config",
      letter: "q",
    },
    {
      code: "INVOCATION_SNAPSHOT_STALE_MEMBERSHIP",
      label: "stale-membership",
      letter: "r",
    },
  ];
  const mappings = new Map();
  for (const target of targets) {
    if (target.kind === "human") continue;
    const principalId = principalFor(target.letter);
    mappings.set(agentFor(target.letter), target);
    seedSource(store, {
      mentions: [agentMention(principalId, target.label)],
      text: `@${target.label}`,
    });
  }
  seedSource(store, {
    mentions: [
      {
        handle: "ada",
        kind: "human",
        principalId: principalFor("s"),
        span: { endByte: 4, startByte: 0 },
        text: "@ada",
      },
    ],
    text: "@ada",
  });
  const door = createDispatchDoor({
    producerId: "e3-t02-outcome-door",
    streamStore: store,
  });
  const reconciler = createReconciler({
    door,
    resolveTarget: async ({ agentId }) => ({
      code:
        mappings.get(agentId)?.code ??
        MENTION_RECONCILER_ERROR_CODES.SNAPSHOT_REFUSED,
      hiddenConfig: "Bearer e3-t02-verifier-canary-should-not-persist",
      status: "non-runnable",
    }),
    store,
  });
  await reconciler.reconcile({ limit: 100 });
  const invocations = await store.read(INVOCATION_STREAM);
  const audits = await store.read(AUDIT_STREAM);
  assert.equal(invocations.records.length, 0);
  assert.equal(audits.records.length, targets.length);
  const codes = audits.records.map((record) => record.event.data.detail.code);
  for (const target of targets)
    assert.ok(codes.includes(target.code), target.label);
  assert.equal(
    JSON.stringify(audits.records).includes("verifier-canary"),
    false,
  );
  door.close();
  return {
    auditCount: audits.records.length,
    codes: [...new Set(codes)].sort(),
    invocationCount: invocations.records.length,
    noHiddenConfigurationLeak: true,
    result: "PASS",
  };
}

async function verifySourceAndCheckpointAttacks() {
  const attacks = [];
  const sourceCases = [
    {
      label: "forged-offset",
      mutate(record) {
        return { ...record, offset: "forged" };
      },
      expected: MENTION_RECONCILER_ERROR_CODES.SOURCE_INVALID,
    },
    {
      label: "forged-event-digest",
      mutate(record) {
        return { ...record, digest: digest("z") };
      },
      expected: MENTION_RECONCILER_ERROR_CODES.SOURCE_INVALID,
    },
    {
      label: "foreign-agent",
      mutate(record) {
        const foreign = structuredClone(record);
        foreign.event.data.mentions[0].principalId =
          "pr_bbbbbbbbbbbbbbbbbbbbbbbbbb_dddddddddddddddddddddddddd";
        return foreign;
      },
      expected: MENTION_RECONCILER_ERROR_CODES.SOURCE_INVALID,
    },
    {
      label: "foreign-workspace",
      mutate(record) {
        const foreign = structuredClone(record);
        foreign.event.workspaceId = "ws_bbbbbbbbbbbbbbbbbbbbbbbbbb";
        foreign.event.actorId =
          "pr_bbbbbbbbbbbbbbbbbbbbbbbbbb_cccccccccccccccccccccccccc";
        return foreign;
      },
      expected: MENTION_RECONCILER_ERROR_CODES.SOURCE_SCOPE,
    },
  ];
  for (const attack of sourceCases) {
    const store = createMemoryStore();
    const source = seedSource(store, {
      mentions: [agentMention(AGENT_PRINCIPAL_ID, "helper")],
      text: "@helper",
    });
    const records = store.records(CHANNEL_STREAM);
    store.replace(CHANNEL_STREAM, [attack.mutate(records[0])]);
    const door = createDispatchDoor({
      producerId: `e3-t02-attack-${attack.label}`,
      streamStore: store,
    });
    const reconciler = createReconciler({
      door,
      resolveTarget: async () => ({
        snapshot: snapshotFor({
          agentId: AGENT_ID,
          sourceTrigger: source.reference,
        }),
        status: "eligible",
      }),
      store,
    });
    await assert.rejects(
      reconciler.reconcile(),
      (error) => error.code === attack.expected,
      attack.label,
    );
    const invocations = await store.read(INVOCATION_STREAM);
    assert.equal(invocations.records.length, 0, attack.label);
    attacks.push({
      attack: attack.label,
      invocationCount: 0,
      observedCode: attack.expected,
      refused: true,
    });
    door.close();
  }

  const checkpointStore = createMemoryStore();
  const source = seedSource(checkpointStore, {
    mentions: [agentMention(AGENT_PRINCIPAL_ID, "helper")],
    text: "@helper",
  });
  const checkpointDoor = createDispatchDoor({
    producerId: "e3-t02-checkpoint-attack",
    streamStore: checkpointStore,
  });
  const checkpointReconciler = createReconciler({
    door: checkpointDoor,
    resolveTarget: async () => ({
      snapshot: snapshotFor({
        agentId: AGENT_ID,
        sourceTrigger: source.reference,
      }),
      status: "eligible",
    }),
    store: checkpointStore,
  });
  const siblingCheckpoint = issueEventEnvelope(
    {
      actorId: ACTOR_ID,
      causation: source.reference,
      correlationId: `cr_${"z".repeat(26)}`,
      data: {
        projectionId: checkpointReconciler.projectionId,
        sequence: 1,
        sourceOffset: source.reference.offset,
        sourceStream:
          "channel:ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_eeeeeeeeeeeeeeeeeeeeeeeeee",
        stateDigest: digest("y"),
      },
      eventType: "projection.checkpointed",
      idempotencyKey: `ik_${"z".repeat(26)}`,
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
    },
    { clock: fixedClock, eventId: `ev_${"y".repeat(26)}` },
  );
  checkpointStore.seed(checkpointReconciler.checkpointStream, {
    event: siblingCheckpoint,
    offset: offset(1),
  });
  await assert.rejects(
    checkpointReconciler.reconcile(),
    (error) => error.code === MENTION_RECONCILER_ERROR_CODES.CHECKPOINT_SCOPE,
  );
  attacks.push({
    attack: "cross-wired-checkpoint",
    invocationCount: 0,
    observedCode: MENTION_RECONCILER_ERROR_CODES.CHECKPOINT_SCOPE,
    refused: true,
  });
  checkpointDoor.close();
  return { attacks, result: "PASS" };
}

async function verifyReplayDigests(race) {
  const invocationRecords = race.invocations.records.map((record, index) => ({
    event: record.event,
    offset: offset(index + 1),
  }));
  const checkpointRecords = race.checkpoints.records.map((record, index) => ({
    event: record.event,
    offset: offset(index + 1),
  }));
  const invocationFirst = replayRecords(invocationRecords);
  const invocationSecond = replayRecords(structuredClone(invocationRecords));
  const checkpointFirst = replayRecords(checkpointRecords);
  const checkpointSecond = replayRecords(structuredClone(checkpointRecords));
  assert.equal(
    invocationFirst.finalStateDigest,
    invocationSecond.finalStateDigest,
  );
  assert.equal(
    checkpointFirst.finalStateDigest,
    checkpointSecond.finalStateDigest,
  );
  return {
    checkpoint: {
      finalStateDigest: checkpointFirst.finalStateDigest,
      replayedTwiceWithIdenticalDigest: true,
    },
    invocation: {
      finalStateDigest: invocationFirst.finalStateDigest,
      replayedTwiceWithIdenticalDigest: true,
    },
    sourceStreamDigest: race.source.streamDigest,
    result: "PASS",
  };
}

async function verifySensitivity() {
  await mkdir(path.join(taskDirectory, "work"), { recursive: true });
  const parent = await mkdtemp(
    path.join(taskDirectory, "work", "sensitivity-"),
  );
  const checkout = path.join(parent, "checkout");
  let worktreeAdded = false;
  try {
    execFileSync(
      "git",
      ["worktree", "add", "--detach", checkout, implementationCommit],
      { cwd: root, stdio: "ignore" },
    );
    worktreeAdded = true;
    const modulePath = path.join(checkout, "src/ledger/mention-reconciler.mjs");
    const anchor = `const invocationId = deriveMentionInvocationId({
    agentId,
    sourceTrigger,
    workspaceId,
  });`;
    let source = await readFile(modulePath, "utf8");
    assert.equal(source.split(anchor).length - 1, 1);
    source = source.replace(
      anchor,
      "const invocationId = `iv_${Math.random().toString(16).slice(2, 28)}`;",
    );
    await writeFile(modulePath, source);
    execFileSync("pnpm", ["install", "--frozen-lockfile"], {
      cwd: checkout,
      stdio: "ignore",
    });
    let exitCode = 0;
    try {
      execFileSync(
        "node",
        ["--test", "test/unit/mention-reconciler.test.mjs"],
        {
          cwd: checkout,
          stdio: "ignore",
        },
      );
    } catch (error) {
      exitCode = typeof error.status === "number" ? error.status : 1;
    }
    assert.notEqual(
      exitCode,
      0,
      "random invocation IDs must make the race verifier fail",
    );
    return {
      mutation: "replace source-bound invocation ID with randomness",
      verifierCommand: "node --test test/unit/mention-reconciler.test.mjs",
      verifierExitCode: exitCode,
      verifierRejected: true,
      result: "PASS",
    };
  } finally {
    if (worktreeAdded) {
      execFileSync("git", ["worktree", "remove", "--force", checkout], {
        cwd: root,
        stdio: "ignore",
      });
    }
    await rm(parent, { force: true, recursive: true });
  }
}

function createReconciler({
  door,
  onBoundary = async () => {},
  resolveTarget,
  store,
}) {
  return createMentionReconciler({
    actorId: ACTOR_ID,
    channelId: CHANNEL_ID,
    dispatch: door,
    onBoundary,
    resolveTarget,
    streamStore: store,
    workspaceId: WORKSPACE_ID,
  });
}

function seedSource(store, { mentions, text }) {
  const sequence = store.count(CHANNEL_STREAM) + 1;
  const event = issueEventEnvelope(
    {
      actorId: ACTOR_ID,
      causation: null,
      correlationId: `cr_${tokenFor(sequence)}`,
      data: {
        authorId: ACTOR_ID,
        channelId: CHANNEL_ID,
        contentType: "text/plain",
        mentions,
        messageId: `msg_${tokenFor(sequence).slice(0, 8)}`,
        rootMessageId: null,
        text,
      },
      eventType: "channel.message.created",
      idempotencyKey: `ik_${tokenFor(sequence)}`,
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
    },
    { clock: fixedClock, eventId: `ev_${tokenFor(sequence)}` },
  );
  validateMentionFacts(mentions, text, { expectedWorkspaceId: WORKSPACE_ID });
  const reference = {
    digest: digestEventEnvelope(event),
    offset: offset(sequence),
    stream: CHANNEL_STREAM,
  };
  store.seed(CHANNEL_STREAM, {
    digest: reference.digest,
    event,
    offset: reference.offset,
  });
  return { event, reference };
}

function snapshotFor({ agentId, sourceTrigger }) {
  const configStream = streamNames.agentConfig(WORKSPACE_ID, agentId);
  return {
    config: {
      agentConfig: {
        budgets: {
          maxCostUsdCents: 100,
          maxInputTokens: 1000,
          maxOutputTokens: 1000,
          maxTotalTokens: 2000,
          timeoutSeconds: 60,
        },
      },
    },
    hiddenConfig: "Bearer e3-t02-verifier-canary-should-not-persist",
    snapshotDigest: canonicalSha256({ agentId, sourceTrigger, revision: 1 }),
    sourceManifest: {
      config: {
        offset: offset(2),
        stateDigest: digest("b"),
        stream: configStream,
      },
    },
  };
}

function agentMention(principalId, handle) {
  return {
    handle,
    kind: "agent",
    principalId,
    span: { endByte: handle.length + 1, startByte: 0 },
    text: `@${handle}`,
  };
}

function principalFor(letter) {
  return `pr_${WORKSPACE_ID.slice(3)}_${letter.repeat(26)}`;
}

function agentFor(letter) {
  return `ag_${WORKSPACE_ID.slice(3)}_${letter.repeat(26)}`;
}

function tokenFor(sequence) {
  const letter = ALPHABET[(sequence - 1) % ALPHABET.length];
  return letter.repeat(26);
}

function digest(letter) {
  return `sha256:${letter.repeat(64)}`;
}

function offset(sequence) {
  const word = sequence.toString(16).padStart(16, "0");
  return `${String(sequence).padStart(16, "0")}_${word}`;
}

function fixedClock() {
  return new Date("2026-08-07T00:00:00.000Z");
}

function createMemoryStore({ appendDelayMs = 0 } = {}) {
  const streams = new Map();
  const producers = new Map();
  const failAfterAppend = new Set();
  return {
    async append(stream, record, options = {}) {
      if (appendDelayMs) {
        await new Promise((resolve) => {
          setTimeout(resolve, appendDelayMs);
        });
      }
      const records = streams.get(stream) ?? [];
      const expectedHead = offset(records.length);
      if (
        options.streamSeq !== undefined &&
        options.streamSeq !== expectedHead
      ) {
        throw Object.assign(new Error("stale expected head"), {
          code: "APPEND_CONFLICT",
          status: 409,
        });
      }
      if (options.producer) {
        const producerKey = `${stream}:${options.producer.id}`;
        const previous = producers.get(producerKey);
        if (
          previous &&
          options.producer.epoch === previous.epoch &&
          options.producer.seq <= previous.seq
        ) {
          return { duplicate: true, message: record, nextOffset: expectedHead };
        }
        producers.set(producerKey, {
          epoch: options.producer.epoch,
          seq: options.producer.seq,
        });
      }
      records.push(record);
      streams.set(stream, records);
      if (failAfterAppend.delete(stream))
        throw new Error("lost acknowledgement");
      return { message: record, nextOffset: offset(records.length) };
    },
    async ensure(stream) {
      if (!streams.has(stream)) streams.set(stream, []);
    },
    async read(stream) {
      const records = [...(streams.get(stream) ?? [])];
      return {
        nextOffset: offset(records.length),
        records,
        streamDigest: canonicalSha256(records),
      };
    },
    count(stream) {
      return (streams.get(stream) ?? []).length;
    },
    failAfterAppendOnce(stream) {
      failAfterAppend.add(stream);
    },
    records(stream) {
      return [...(streams.get(stream) ?? [])];
    },
    replace(stream, records) {
      streams.set(stream, [...records]);
    },
    seed(stream, record) {
      const records = streams.get(stream) ?? [];
      records.push(record);
      streams.set(stream, records);
    },
  };
}

async function writeJson(filename, value) {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);
}

async function scanEvidenceDirectory(directory) {
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  let leaked = false;
  for (const filename of files) {
    const contents = await readFile(path.join(directory, filename), "utf8");
    if (
      /e3-t02-verifier-canary-|PRIVATE KEY|api[_-]?key\s*[:=]|Bearer\s+[A-Za-z0-9._~+/=-]{12,}/iu.test(
        contents,
      )
    ) {
      leaked = true;
    }
  }
  return { checked: true, files, leaked };
}
