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
  deriveRunQueueId,
  planConversationSchedule,
  validateRunControlPolicy,
  zeroRunUsage,
} from "@stream-slack/protocol";

import { replayAgentConfigStream } from "../src/ledger/agent-config-stream.mjs";
import { canonicalSha256 } from "../src/ledger/canonical-json.mjs";
import { createAgentReplyDispatcher } from "../src/ledger/agent-replies.mjs";
import {
  assembleContextPack,
  contextPackDigest,
  replayContextPack,
} from "../src/ledger/context-pack.mjs";
import { createMentionAwareConversationDispatcher } from "../src/ledger/conversation-auth.mjs";
import { createConversationScheduler } from "../src/ledger/conversation-scheduler.mjs";
import { createDispatchDoor } from "../src/ledger/dispatch.mjs";
import {
  digestEventEnvelope,
  issueEventEnvelope,
} from "../src/ledger/envelope.mjs";
import { createMentionReconciler } from "../src/ledger/mention-reconciler.mjs";
import {
  createRunLeaseCoordinator,
  projectEligibleQueue,
  replayRunLeaseEvents,
} from "../src/ledger/run-queue.mjs";
import {
  createRunControlCoordinator,
  createScriptedProcessRunner,
} from "../src/ledger/run-control.mjs";
import { streamNames } from "../src/ledger/topology.mjs";
import {
  makeDelegatedChild,
  makeItem,
  makePolicy,
} from "../test/support/conversation-scheduler-fixture.mjs";
import {
  createDurableStreamHarness,
  deterministicOffset,
} from "../test/support/durable-stream-harness.mjs";
import {
  CAPSTONE_IDS,
  CAPSTONE_TIME,
  createCapstoneAuthorityState,
  createCapstoneSnapshot,
  createChannelAppend,
  seedCapstoneConfigStream,
} from "../test/support/e3-capstone-fixture.mjs";

const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-3-the-dispatcher/E3-T08-mention-to-scripted-agent-reply",
);
const runId = String(
  process.env.TEST_RUN_ID ?? `e3-t08-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/gu, "-");
const implementationCommit = String(
  process.env.E3_T08_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
const reportDirectory = path.resolve(
  root,
  process.env.PROMOTE_EVIDENCE === "1"
    ? path.join(taskDirectory, "evidence/e3-t08-final")
    : (process.env.TEST_ARTIFACT_DIR ??
        path.join(".artifacts", "e3-t08", runId)),
);
const replay =
  "Replay: N/A (server/CLI scripted-agent capstone; real providers and UI land later) + mitigation: multi-process fault schedules, source/ref manifest, canary scans, projection rebuild, and independent composite replay";

assert.match(implementationCommit, /^[0-9a-f]{40}$/u);
await mkdir(reportDirectory, { recursive: true });
await mkdir(path.join(taskDirectory, "work"), { recursive: true });

const gates = runGates();
const composed = await verifyComposedIngressAndLease();
const adversarial = verifyBatchingAndRecursion();
const faultEvidence = await verifyCancellationAndRetry(composed);
const streamDumps = composed.store.dump();
const sourceRefManifest = sourceManifest(streamDumps, {
  stateReferences: [composed.config.source],
});
const projectionRebuild = rebuildProjection({ composed, streamDumps });
const sensitivity = await verifySensitivity();
const composite = canonicalSha256({
  adversarial,
  faultEvidence,
  context: composed.context,
  invocation: composed.invocation,
  projectionRebuild,
  queue: composed.queue,
  run: composed.run,
  scheduler: composed.scheduler,
  sourceRefManifest,
});
const evidence = {
  adversarial,
  batchingRecursionOutcomes: {
    adversarial,
    composed: composed.scheduler,
  },
  cancellationRevocation: {
    cancellation: faultEvidence.cancellation,
    revocation: faultEvidence.revocation,
  },
  compositeReplayDigests: {
    compositeDigest: composite,
    rebuiltDigest: canonicalSha256({
      adversarial,
      faultEvidence,
      context: composed.context,
      invocation: composed.invocation,
      projectionRebuild,
      queue: composed.queue,
      run: composed.run,
      scheduler: composed.scheduler,
      sourceRefManifest: sourceManifest(structuredClone(streamDumps), {
        stateReferences: [composed.config.source],
      }),
    }),
  },
  faultSchedules: {
    runControl: faultEvidence.schedule,
    streamBoundaries: composed.store.faultSchedule(),
  },
  processResourceCounts: faultEvidence.processes,
  retryUsageAccounting: faultEvidence.retry,
  gates,
  implementationCommit,
  mentionInvocationSnapshot: composed.invocation,
  queueLeaseManifest: composed.lease,
  replyReceipt: composed.reply,
  replay,
  result: "PASS",
  runId,
  sensitivity,
  sourceRefManifest,
  streamDumps,
  task: "E3-T08",
};
assert.equal(
  evidence.compositeReplayDigests.rebuiltDigest,
  evidence.compositeReplayDigests.compositeDigest,
);

for (const [filename, value] of [
  ["source-ref-manifest.json", sourceRefManifest],
  ["fault-schedules.json", evidence.faultSchedules],
  ["stream-dumps.json", streamDumps],
  ["mention-invocation-snapshot.json", composed.invocation],
  ["queue-lease-manifest.json", composed.lease],
  ["batching-recursion-outcomes.json", evidence.batchingRecursionOutcomes],
  [
    "attempt-timelines.json",
    {
      cancellation: faultEvidence.cancellation.state.attemptTimelines,
      composed: composed.run.state.attemptTimelines,
      revocation: faultEvidence.revocation.state.attemptTimelines,
      retry: faultEvidence.retry.attempts,
    },
  ],
  ["process-resource-counts.json", evidence.processResourceCounts],
  ["cancellation-revocation.json", evidence.cancellationRevocation],
  ["retry-usage-accounting.json", evidence.retryUsageAccounting],
  ["context-pack.json", composed.context],
  ["reply-receipt.json", composed.reply],
  ["projection-rebuild.json", projectionRebuild],
  ["composite-replay-digests.json", evidence.compositeReplayDigests],
  ["sensitivity.json", sensitivity],
]) {
  await writeJson(filename, value);
}
await writeJson("verification-summary.json", evidence);
const canaryScan = await scanEvidence();
assert.equal(canaryScan.leaked, false);
await writeJson("canary-scan.json", canaryScan);
await writeJson("verification-summary.json", { ...evidence, canaryScan });

console.log(
  JSON.stringify(
    {
      implementationCommit,
      result: "PASS",
      runId,
      invocationId: composed.invocation.invocationId,
      leaseGeneration: composed.lease.leaseGeneration,
      compositeDigest: composite,
      replay,
    },
    null,
    2,
  ),
);

function runGates() {
  if (process.env.E3_T08_SKIP_GATES === "1") {
    return [{ command: "gates skipped", name: "gates", result: "SKIPPED" }];
  }
  const results = [];
  for (const [name, script] of [
    ["format", "format:check"],
    ["format-task", "format:check:e3-t08"],
    ["lint", "lint"],
    ["typecheck", "typecheck"],
    ["tests", "test"],
    ["build", "build"],
  ]) {
    execFileSync("pnpm", [script], { cwd: root, stdio: "inherit" });
    results.push({ command: `pnpm ${script}`, name, result: "PASS" });
  }
  return results;
}

async function verifyComposedIngressAndLease() {
  const { agentId, channelId, humanId, workspaceId } = CAPSTONE_IDS;
  const store = createDurableStreamHarness({ appendDelayMs: 1 });
  const state = createCapstoneAuthorityState();
  const appendChannel = createChannelAppend({ state, store });
  const dispatchConversation = createMentionAwareConversationDispatcher({
    dispatch: appendChannel,
    lookupState: async () => state,
    withChannelFence: async (_scope, operation) => operation(),
  });
  await dispatchConversation({
    actorId: humanId,
    idempotencyKey: `ik_${"m".repeat(26)}`,
    operation: "channel.message.create",
    payload: {
      channelId,
      contentType: "text/plain",
      messageId: "capstone-trigger",
      rootMessageId: null,
      text: "@helper summarize the authorized thread",
    },
    stream: streamNames.channel(workspaceId, channelId),
    workspaceId,
  });
  const sourceRecord = store.records(
    streamNames.channel(workspaceId, channelId),
  )[0];
  const sourceTrigger = {
    digest: sourceRecord.digest,
    offset: sourceRecord.offset,
    stream: sourceRecord.stream,
  };
  const config = await seedCapstoneConfigStream({ store });
  const snapshot = createCapstoneSnapshot(sourceTrigger, {
    configSource: config.source,
  });
  const door = createDispatchDoor({
    producerId: "e3-t08-reconciler",
    streamStore: store,
  });
  const reconciler = createMentionReconciler({
    actorId: humanId,
    channelId,
    dispatch: door,
    resolveTarget: async () => ({ snapshot, status: "eligible" }),
    streamStore: store,
    workspaceId,
  });
  const reports = await Promise.all([
    reconciler.reconcile(),
    reconciler.reconcile(),
  ]);
  const invocationStream = streamNames.workspaceInvocations(workspaceId);
  const invocationSnapshot = await store.read(invocationStream);
  assert.equal(invocationSnapshot.records.length, 1);
  const invocationEvent =
    invocationSnapshot.records[0].event ?? invocationSnapshot.records[0];
  const invocation = invocationEvent.data;
  assert.equal(invocation.agentId, agentId);
  assert.deepEqual(invocation.sourceTrigger, sourceTrigger);
  assert.equal(
    reports
      .flatMap(({ processed }) => processed)
      .filter(({ status }) => status === "reconciled").length >= 1,
    true,
  );

  const invocationRecord = {
    digest: digestEventEnvelope(invocationEvent),
    event: invocationEvent,
    offset: invocationSnapshot.records[0].offset ?? deterministicOffset(1),
  };
  const invocationRef = {
    digest: invocationRecord.digest,
    offset: invocationRecord.offset,
    stream: invocationStream,
  };
  const runId = `rn_${workspaceId.slice(3)}_${"r".repeat(26)}`;
  const runRecords = createRequestedAndQueuedRun({
    invocation,
    invocationRef,
    runId,
  });
  const queue = projectEligibleQueue({
    invocationRecords: [invocationRecord],
    now: new Date(CAPSTONE_TIME),
    runRecords,
    workspaceId,
  });
  assert.equal(queue.entries.length, 1);

  const actualItem = {
    ...makeItem({ policy: makePolicy() }),
    agentId,
    invocationId: invocation.invocationId,
    invocationRef,
    snapshotDigest: invocation.snapshotDigest,
    sourceTrigger,
    workspaceId,
  };
  const scheduleJournal = [];
  const auditStream = streamNames.workspaceAudit(workspaceId);
  const scheduler = createConversationScheduler({
    record: async (entry) => {
      scheduleJournal.push(entry);
      store.seed(auditStream, {
        ...structuredClone(entry),
        stream: auditStream,
      });
    },
  });
  const schedule = await scheduler.plan({ queued: [actualItem], workspaceId });
  assert.equal(schedule.batches.length, 1);
  assert.equal(
    planConversationSchedule({ queued: [actualItem], workspaceId })
      .scheduleDigest,
    schedule.scheduleDigest,
  );

  const leaseRecords = [];
  const leaseCoordinator = createRunLeaseCoordinator({
    actorId: humanId,
    appendLeaseEvent: async ({ record }) => {
      leaseRecords.push(structuredClone(record));
      return { record };
    },
    clock: () => new Date(CAPSTONE_TIME),
    queueProjection: queue,
    resolveAuthority: () => ({
      agentStatus: "active",
      invocationStatus: "requested",
      workspaceStatus: "active",
    }),
    tokenFactory: () => `rcap_${"x".repeat(64)}`,
    workspaceId,
  });
  const processRunner = createScriptedProcessRunner({
    clock: () => new Date(CAPSTONE_TIME),
  });
  const runStream = streamNames.run(workspaceId, runId);
  for (const record of runRecords) {
    store.seed(runStream, { ...structuredClone(record), stream: runStream });
  }
  const durableRunRecords = structuredClone(runRecords);
  const runPolicy = buildRunPolicy();
  const queueProjectionFor = ({ attempts = 0, now, status = "queued" }) =>
    projectEligibleQueue({
      invocations: [
        {
          ...invocation,
          sourceRef: invocationRef,
          status: "requested",
        },
      ],
      now,
      runs: [
        {
          agentId,
          attempts,
          invocationId: invocation.invocationId,
          runId,
          runRef: queue.entries[0].runRef,
          status,
        },
      ],
      workspaceId,
    });
  const controller = createRunControlCoordinator({
    actorId: humanId,
    appendRecord: async ({ record }) => {
      const persisted = {
        ...structuredClone(record),
        stream: runStream,
      };
      durableRunRecords.push(persisted);
      store.seed(runStream, persisted);
      return { record: persisted };
    },
    clock: () => new Date(CAPSTONE_TIME),
    entry: queue.entries[0],
    initialRecords: runRecords,
    initialRun: {
      sequence: 2,
      status: "queued",
      usage: zeroRunUsage(),
    },
    leaseCoordinator,
    leaseEndpoints: ["run.events.write", "run.reply.write"],
    leaseRecords,
    policy: runPolicy,
    processRunner,
    queueProjectionFor,
    workerId: "scripted-capstone-worker",
  });
  await controller.beginAttempt();
  await controller.startAttempt({
    launch: { children: 2, outputBytes: 64 },
  });
  await controller.reportUsage({
    usage: {
      costUsdCents: 1,
      inputTokens: 10,
      outputBytes: 64,
      outputTokens: 8,
      totalTokens: 18,
      wallTimeMs: 10,
    },
  });
  const runState = controller.getState();
  assert.equal(runState.status, "running");
  assert.equal(runState.attempts.length, 1);
  assert.equal(runState.processSnapshot.length, 1);
  const contextPack = assembleContextPack({
    agentId,
    authorization: {
      channel: {
        channelId,
        kind: "public",
        revision: 1,
        status: "active",
        workspaceId,
      },
      channelMembership: {
        channelId,
        principalId: CAPSTONE_IDS.agentPrincipalId,
        revision: 1,
        status: "active",
        workspaceId,
      },
      workspaceMembership: {
        principalId: CAPSTONE_IDS.agentPrincipalId,
        revision: 1,
        role: "agent",
        status: "active",
        workspaceId,
      },
    },
    context: { channelId, scope: "current-channel", threadId: null },
    instructions: [],
    policy: {
      includePrivate: false,
      includeThreadHistory: true,
      maxAttachmentBytes: 64_000,
      maxBytes: 20_000,
      maxEstimatedTokens: 4_000,
      maxHistoryDepth: 100,
      maxItems: 8,
      maxMessages: 4,
      workspaceInputPaths: [],
    },
    sourceHeads: [sourceTrigger],
    sourceRecords: [
      {
        event: sourceRecord.event,
        offset: sourceRecord.offset,
        stream: sourceRecord.stream,
      },
    ],
    trigger: {
      channelId,
      messageId: "capstone-trigger",
      source: sourceTrigger,
      threadId: null,
    },
    workspaceId,
    workspaceInputs: [],
  });
  assert.equal(contextPack.packDigest, contextPackDigest(contextPack));
  const contextArtifactSequence = store.count(auditStream) + 1;
  const contextArtifactRecord = {
    content: contextPack,
    digest: contextPack.packDigest,
    kind: "context-pack",
    offset: deterministicOffset(contextArtifactSequence),
    stream: auditStream,
  };
  store.seed(auditStream, contextArtifactRecord);
  const contextRef = {
    digest: contextArtifactRecord.digest,
    offset: contextArtifactRecord.offset,
    stream: auditStream,
  };
  await controller.recordActivity({
    contentRef: contextRef,
    kind: "context-pack",
    summary: "bounded capstone context pack",
  });
  const replyDispatch = createMentionAwareConversationDispatcher({
    allowAgentReplyProvenance: true,
    dispatch: appendChannel,
    lookupState: async () => state,
    withChannelFence: async (_scope, operation) => operation(),
  });
  const refusalArtifacts = [];
  const replyDispatcher = createAgentReplyDispatcher({
    appendRefusal: async (artifact) => {
      refusalArtifacts.push(structuredClone(artifact));
      return artifact;
    },
    clock: () => new Date(CAPSTONE_TIME),
    dispatch: replyDispatch,
    leaseCoordinator,
    readAuthority: async () => ({
      agentStatus: "active",
      channel: state.entities.channels[channelId],
      channelMembership:
        state.entities.channelMemberships[
          `${channelId}\u0000${CAPSTONE_IDS.agentPrincipalId}`
        ],
      principal: state.entities.principals[CAPSTONE_IDS.agentPrincipalId],
      workspaceMembership:
        state.entities.memberships[
          `mb_${workspaceId.slice(3)}_${CAPSTONE_IDS.agentPrincipalId.slice(30)}`
        ],
      workspaceStatus: "active",
    }),
    readChannel: async () => ({
      channel: state.entities.channels[channelId],
      messages: Object.values(state.entities.messages),
    }),
    readInvocation: async () => ({
      digest: invocationRecord.digest,
      event: invocationEvent,
      offset: invocationRecord.offset,
      stream: invocationStream,
    }),
    readRun: async () => ({ records: controller.getRecords() }),
    readSource: async () => structuredClone(sourceRecord),
    workspaceId,
  });
  const reply = await replyDispatcher.dispatchReply({
    capability: controller.getCapabilityForWorker(),
    output: "The authorized thread asks for a concise summary.",
    runId,
    workerId: controller.workerId,
  });
  assert.equal(reply.result, "accepted");
  assert.equal(reply.provenance.contextDigest, contextPack.packDigest);
  assert.equal(refusalArtifacts.length, 0);
  await controller.complete({
    resultRef: {
      digest: reply.receipt.eventDigest,
      offset: reply.receipt.nextOffset,
      stream: reply.receipt.stream,
    },
    summary: "scripted reply accepted",
  });
  const completedRunState = controller.getState();
  assert.equal(completedRunState.status, "completed");
  assert.equal(
    completedRunState.processSnapshot.every(
      ({ activeChildren }) => activeChildren === 0,
    ),
    true,
  );
  const completedRunRecords = controller.getRecords();
  const leaseReplay = replayRunLeaseEvents(
    completedRunRecords.filter((record) =>
      record.event?.eventType?.startsWith("run.lease."),
    ),
    { workspaceId },
  );
  const auditRecords = store.records(auditStream);
  const conversation = structuredClone(state.entities.messages);
  const projectionBefore = {
    auditDigest: canonicalSha256(stripStreamFields(auditRecords)),
    configStateDigest: config.source.stateDigest,
    contextDigest: contextPack.packDigest,
    conversationDigest: canonicalSha256(conversation),
    leaseStateDigest: leaseReplay.finalStateDigest,
    queueDigest: queue.queueDigest,
    runDigest: completedRunState.replayDigest,
    projectionDigest: canonicalSha256({
      auditDigest: canonicalSha256(stripStreamFields(auditRecords)),
      configStateDigest: config.source.stateDigest,
      contextDigest: contextPack.packDigest,
      conversationDigest: canonicalSha256(conversation),
      leaseStateDigest: leaseReplay.finalStateDigest,
      queueDigest: queue.queueDigest,
      runDigest: completedRunState.replayDigest,
    }),
  };
  return {
    config,
    context: contextPack,
    invocation: {
      ...invocation,
      invocationId: invocation.invocationId,
      invocationRef,
      snapshotDigest: invocation.snapshotDigest,
      snapshotRef: invocation.snapshotRef,
      sourceTrigger,
    },
    lease: {
      attemptId: runState.activeAttempt.attemptId,
      leaseGeneration: runState.activeAttempt.leaseGeneration,
      queueDigest: queue.queueDigest,
      runId,
      workerId: controller.workerId,
    },
    queue: {
      entry: queue.entries[0],
      proof: queue.proof,
      queueDigest: queue.queueDigest,
    },
    scheduler: {
      input: [actualItem],
      journal: scheduleJournal,
      scheduleDigest: schedule.scheduleDigest,
      batches: schedule.batches,
      refusals: schedule.refusals,
    },
    conversation,
    projectionBefore,
    run: {
      records: completedRunRecords,
      state: completedRunState,
    },
    reply,
    store,
  };
}

function buildRunPolicy(overrides = {}) {
  const policy = {
    allowApprovals: false,
    attemptDeadlineMs: 100,
    maxAggregateCostUsdCents: 100,
    maxAggregateInputTokens: 100,
    maxAggregateOutputBytes: 500,
    maxAggregateOutputTokens: 100,
    maxAggregateWallTimeMs: 1_000,
    maxAttempts: 3,
    maxCostUsdCents: 100,
    maxInputTokens: 100,
    maxOutputBytes: 500,
    maxOutputTokens: 100,
    maxWallTimeMs: 1_000,
    retryBackoffBaseMs: 10,
    retryBackoffMaxMs: 40,
    retryBackoffMultiplier: 2,
    terminationGraceMs: 10,
    version: 1,
    ...overrides,
  };
  validateRunControlPolicy(policy);
  return policy;
}

async function verifyCancellationAndRetry(composed) {
  const baseMs = Date.parse(CAPSTONE_TIME);
  const policy = buildRunPolicy();
  const actionKey = "scripted-side-effect-capstone";
  const retryFixture = createFaultController("f", composed, policy, baseMs);
  const retryController = retryFixture.controller;

  await retryController.beginAttempt({ now: new Date(baseMs) });
  await retryController.startAttempt({
    launch: { children: 3, ignoresTerm: true, outputBytes: 32 },
    now: new Date(baseMs + 1),
  });
  const firstCapability = retryController.getCapabilityForWorker();
  let crash = null;
  let sideEffects = 0;
  try {
    await retryController.commitLogicalAction({
      actionKey,
      capability: firstCapability,
      crashAfterSideEffect: true,
      now: new Date(baseMs + 2),
      perform: async () => {
        sideEffects += 1;
      },
    });
  } catch (error) {
    crash = summarizeError(error);
  }
  assert.ok(crash);
  assert.equal(sideEffects, 1);
  const retryResult = await retryController.reportFailure({
    capability: firstCapability,
    failureCode: "scripted-process-crash",
    now: new Date(baseMs + 3),
    retryable: true,
  });
  assert.equal(retryResult.retry, true);
  const afterFailure = retryController.getState();
  assert.equal(afterFailure.status, "retry");
  assert.equal(
    afterFailure.processSnapshot.every(
      ({ activeChildren }) => activeChildren === 0,
    ),
    true,
  );

  const retryAt = retryResult.schedule.nextAttemptAtMs;
  const leasedRetry = await retryController.tick({
    now: new Date(retryAt),
  });
  assert.equal(leasedRetry.result, "leased");
  assert.equal(retryController.getState().status, "leased");
  await retryController.startAttempt({
    launch: { children: 2, ignoresTerm: false, outputBytes: 16 },
    now: new Date(retryAt + 1),
  });
  const secondCapability = retryController.getCapabilityForWorker();
  const replayResult = await retryController.commitLogicalAction({
    actionKey,
    capability: secondCapability,
    now: new Date(retryAt + 2),
    perform: async () => {
      sideEffects += 1;
    },
  });
  assert.equal(replayResult.result, "replayed");
  assert.equal(sideEffects, 1);
  await retryController.reportUsage({
    capability: secondCapability,
    now: new Date(retryAt + 3),
    usage: {
      costUsdCents: 1,
      inputTokens: 4,
      outputBytes: 16,
      outputTokens: 2,
      totalTokens: 6,
      wallTimeMs: 5,
    },
    usageKey: "retry-success-usage",
  });
  const beforeCancel = retryController.getState();
  assert.equal(beforeCancel.attempts.length, 2);
  assert.equal(beforeCancel.totalUsage.totalTokens, 6);
  assert.equal(
    beforeCancel.totalUsage.totalTokens <=
      policy.maxInputTokens + policy.maxOutputTokens,
    true,
  );
  const cancelResult = await retryController.cancel({
    now: new Date(retryAt + 4),
    reasonCode: "operator-cancelled",
  });
  const afterCancel = retryController.getState();
  assert.equal(cancelResult.result, "cancelled");
  assert.equal(afterCancel.status, "cancelled");
  assert.equal(afterCancel.terminalCount, 1);
  assert.equal(
    afterCancel.processSnapshot.every(
      ({ activeChildren }) => activeChildren === 0,
    ),
    true,
  );
  const lateCancelWrite = await captureError(() =>
    retryController.reportUsage({
      capability: secondCapability,
      now: new Date(retryAt + 5),
      usage: {
        costUsdCents: 1,
        inputTokens: 1,
        outputBytes: 1,
        outputTokens: 1,
        totalTokens: 2,
        wallTimeMs: 1,
      },
      usageKey: "late-cancel-usage",
    }),
  );
  assert.match(lateCancelWrite.code, /TERMINAL_IMMUTABLE/u);

  const revocationFixture = createFaultController(
    "v",
    composed,
    policy,
    baseMs,
  );
  const revocationController = revocationFixture.controller;
  await revocationController.beginAttempt({ now: new Date(baseMs) });
  await revocationController.startAttempt({
    launch: { children: 2, ignoresTerm: true, outputBytes: 8 },
    now: new Date(baseMs + 1),
  });
  const revocationCapability = revocationController.getCapabilityForWorker();
  revocationFixture.authority.agentStatus = "disabled";
  const revocationResult = await revocationController.revokeForAuthority({
    now: new Date(baseMs + 2),
    reasonCode: "agent-disabled",
  });
  const afterRevocation = revocationController.getState();
  assert.equal(revocationResult.result, "cancelled");
  assert.equal(afterRevocation.status, "cancelled");
  assert.equal(
    afterRevocation.processSnapshot.every(
      ({ activeChildren }) => activeChildren === 0,
    ),
    true,
  );
  const lateRevocationWrite = await captureError(() =>
    revocationController.commitLogicalAction({
      actionKey: "late-revocation-action",
      capability: revocationCapability,
      now: new Date(baseMs + 3),
      perform: async () => {
        throw new Error("late mutation should not run");
      },
    }),
  );
  assert.match(lateRevocationWrite.code, /TERMINAL_IMMUTABLE/u);

  return {
    cancellation: {
      lateWrite: lateCancelWrite,
      result: cancelResult,
      state: afterCancel,
    },
    processes: {
      cancellation: afterCancel.processSnapshot,
      revocation: afterRevocation.processSnapshot,
      survivorsAfterCancellation: afterCancel.processSnapshot.reduce(
        (sum, { activeChildren }) => sum + activeChildren,
        0,
      ),
      survivorsAfterRevocation: afterRevocation.processSnapshot.reduce(
        (sum, { activeChildren }) => sum + activeChildren,
        0,
      ),
    },
    retry: {
      actionKey,
      attempts: beforeCancel.attempts,
      budget: {
        aggregateMaxTotalTokens:
          policy.maxAggregateInputTokens + policy.maxAggregateOutputTokens,
        maxAttempts: policy.maxAttempts,
        maxTotalTokens: policy.maxInputTokens + policy.maxOutputTokens,
      },
      crash,
      replayResult,
      retrySchedule: retryResult.schedule,
      sideEffects,
      totalUsage: beforeCancel.totalUsage,
    },
    revocation: {
      lateWrite: lateRevocationWrite,
      result: revocationResult,
      state: afterRevocation,
    },
    schedule: [...retryFixture.schedule, ...revocationFixture.schedule],
  };
}

function createFaultController(suffix, composed, policy, baseMs) {
  const { agentId, humanId, workspaceId } = CAPSTONE_IDS;
  const runId = `rn_${workspaceId.slice(3)}_${suffix.repeat(26)}`;
  const invocationRef = composed.invocation.invocationRef;
  const invocation = { ...composed.invocation };
  delete invocation.invocationRef;
  const runRecords = createRequestedAndQueuedRun({
    invocation,
    invocationRef,
    runId,
  });
  const runStream = streamNames.run(workspaceId, runId);
  for (const record of runRecords) {
    composed.store.seed(runStream, {
      ...structuredClone(record),
      stream: runStream,
    });
  }
  const queuedRunRef = {
    digest: runRecords.at(-1).digest,
    offset: runRecords.at(-1).offset,
    stream: runStream,
  };
  const invocationValue = { ...invocation, sourceRef: invocationRef };
  const queueProjectionFor = ({ attempts = 0, now, status = "queued" }) =>
    projectEligibleQueue({
      invocations: [
        {
          ...invocationValue,
          status: "requested",
        },
      ],
      now,
      runs: [
        {
          agentId,
          attempts,
          invocationId: invocation.invocationId,
          runId,
          runRef: queuedRunRef,
          status,
        },
      ],
      workspaceId,
    });
  const queue = queueProjectionFor({
    now: new Date(baseMs),
  });
  const authority = {
    agentStatus: "active",
    invocationStatus: "requested",
    workspaceStatus: "active",
  };
  const leaseRecords = [];
  const durableRunRecords = structuredClone(runRecords);
  const processRunner = createScriptedProcessRunner({
    clock: () => baseMs,
  });
  let nowMs = baseMs;
  const leaseCoordinator = createRunLeaseCoordinator({
    actorId: humanId,
    appendLeaseEvent: async ({ record }) => {
      leaseRecords.push(structuredClone(record));
      return { record };
    },
    clock: () => new Date(nowMs),
    leaseTtlMs: 1_000,
    queueProjection: queue,
    resolveAuthority: () => authority,
    tokenFactory: (scope) =>
      `rcap_${canonicalSha256(scope).slice("sha256:".length)}`,
    workspaceId,
  });
  const controller = createRunControlCoordinator({
    actorId: humanId,
    appendRecord: async ({ record }) => {
      const persisted = {
        ...structuredClone(record),
        stream: runStream,
      };
      durableRunRecords.push(persisted);
      composed.store.seed(runStream, persisted);
      return { record: persisted };
    },
    clock: () => new Date(nowMs),
    entry: queue.entries[0],
    initialRecords: runRecords,
    initialRun: {
      sequence: 2,
      status: "queued",
      usage: zeroRunUsage(),
    },
    leaseCoordinator,
    leaseEndpoints: ["run.events.write", "run.reply.write"],
    leaseRecords,
    policy,
    processRunner,
    queueProjectionFor,
    workerId: `e3-t08-fault-${suffix}`,
  });
  const schedule = [
    {
      boundary: "crash-after-side-effect-before-ack",
      runId,
    },
    {
      boundary: "retry-backoff-elapsed",
      runId,
    },
    {
      boundary: "cancellation-before-late-write",
      runId,
    },
  ];
  return { authority, controller, durableRunRecords, nowMs, schedule };
}

async function captureError(operation) {
  try {
    await operation();
  } catch (error) {
    return summarizeError(error);
  }
  throw new Error("expected operation to fail");
}

function summarizeError(error) {
  return {
    code: error?.code ?? error?.name ?? "ERROR",
    detail: error?.detail ?? error?.message ?? String(error),
  };
}

function verifyBatchingAndRecursion() {
  const policy = makePolicy({
    delegation: {
      allowCrossChannel: false,
      enabled: false,
      maxChildren: 0,
      maxDepth: 0,
    },
    maxConcurrentPerChannel: 1,
  });
  const base = makeItem({ policy });
  const burst = [
    makeItem({ index: 3, invocationLetter: "c", policy }),
    makeItem({ index: 1, invocationLetter: "a", policy }),
    makeItem({ index: 2, invocationLetter: "b", policy }),
    makeItem({
      authorAgentId: base.agentId,
      authorKind: "agent",
      index: 4,
      invocationLetter: "d",
      isAgentReply: true,
      policy,
    }),
    makeDelegatedChild({ policy }),
  ];
  const planned = planConversationSchedule({
    queued: burst,
    workspaceId: CAPSTONE_IDS.workspaceId,
  });
  assert.equal(planned.batches.length, 1);
  assert.equal(planned.batches[0].members.length, 3);
  assert.equal(planned.refusals.length, 2);
  assert.equal(
    planned.refusals.every(({ code }) =>
      [
        "CONVERSATION_SCHEDULER_AGENT_REPLY",
        "CONVERSATION_SCHEDULER_DELEGATION_REQUIRED",
      ].includes(code),
    ),
    true,
  );
  const admittedIds = new Set(planned.batches[0].memberInvocationIds);
  assert.equal(admittedIds.size, 3);
  return {
    admittedInvocationIds: [...admittedIds],
    batchCount: planned.batches.length,
    providerCalls: admittedIds.size,
    refusalCodes: planned.refusals.map(({ code }) => code),
    refusalCount: planned.refusals.length,
    scheduleDigest: planned.scheduleDigest,
  };
}

function rebuildProjection({ composed, streamDumps }) {
  const { channelId, workspaceId, runId } = {
    channelId: CAPSTONE_IDS.channelId,
    runId: composed.lease.runId,
    workspaceId: CAPSTONE_IDS.workspaceId,
  };
  const channelStream = streamNames.channel(workspaceId, channelId);
  const configStream = streamNames.agentConfig(
    workspaceId,
    composed.invocation.agentId,
  );
  const invocationStream = streamNames.workspaceInvocations(workspaceId);
  const auditStream = streamNames.workspaceAudit(workspaceId);
  const runStream = streamNames.run(workspaceId, runId);
  const channelRecords = streamDumps[channelStream]?.records ?? [];
  const configRecords = streamDumps[configStream]?.records ?? [];
  const invocationRecords = streamDumps[invocationStream]?.records ?? [];
  const normalizedInvocationRecords = invocationRecords.map(
    (record, index) => ({
      ...record,
      offset: record.offset ?? deterministicOffset(index + 1),
    }),
  );
  const auditRecords = streamDumps[auditStream]?.records ?? [];
  const runRecords = streamDumps[runStream]?.records ?? [];
  assert.ok(channelRecords.length > 0);
  assert.ok(configRecords.length > 0);
  assert.ok(invocationRecords.length > 0);
  assert.ok(runRecords.length > 0);

  const rebuiltConfig = replayAgentConfigStream(configRecords);
  const configHead = configRecords.at(-1);
  assert.equal(
    rebuiltConfig.finalStateDigest,
    composed.config.source.stateDigest,
  );
  assert.equal(configHead.offset, composed.config.source.offset);
  assert.equal(
    composed.invocation.snapshotRef.digest,
    rebuiltConfig.finalStateDigest,
  );
  assert.equal(composed.invocation.snapshotRef.offset, configHead.offset);

  const initialRunRecords = runRecords
    .filter((record) => {
      const event = record.event ?? record;
      return (
        event.eventType === "run.lifecycle.changed" &&
        ["requested", "queued"].includes(event.data?.to)
      );
    })
    .slice(0, 2);
  const rebuiltQueue = projectEligibleQueue({
    invocationRecords: normalizedInvocationRecords,
    now: new Date(CAPSTONE_TIME),
    runRecords: initialRunRecords,
    workspaceId,
  });
  assert.equal(rebuiltQueue.queueDigest, composed.queue.queueDigest);

  const contextArtifact = auditRecords.find(
    (record) => record.kind === "context-pack" && record.content,
  );
  assert.ok(contextArtifact);
  const rebuiltContext = replayContextPack(contextArtifact.content);
  assert.equal(rebuiltContext.packDigest, composed.context.packDigest);

  const rebuiltConversation = replayConversationRecords(channelRecords);
  assert.equal(
    canonicalSha256(rebuiltConversation),
    composed.projectionBefore.conversationDigest,
  );

  const normalizedRunRecords = stripStreamFields(runRecords);
  const rebuiltLease = replayRunLeaseEvents(
    normalizedRunRecords.filter((record) =>
      record.event?.eventType?.startsWith("run.lease."),
    ),
    { workspaceId },
  );
  const rebuiltSchedule = planConversationSchedule({
    queued: composed.scheduler.input,
    workspaceId,
  });
  assert.equal(
    rebuiltSchedule.scheduleDigest,
    composed.scheduler.scheduleDigest,
  );
  const after = {
    auditDigest: canonicalSha256(stripStreamFields(auditRecords)),
    configStateDigest: rebuiltConfig.finalStateDigest,
    contextDigest: rebuiltContext.packDigest,
    conversationDigest: canonicalSha256(rebuiltConversation),
    leaseStateDigest: rebuiltLease.finalStateDigest,
    queueDigest: rebuiltQueue.queueDigest,
    runDigest: canonicalSha256(normalizedRunRecords),
    projectionDigest: canonicalSha256({
      auditDigest: canonicalSha256(stripStreamFields(auditRecords)),
      configStateDigest: rebuiltConfig.finalStateDigest,
      contextDigest: rebuiltContext.packDigest,
      conversationDigest: canonicalSha256(rebuiltConversation),
      leaseStateDigest: rebuiltLease.finalStateDigest,
      queueDigest: rebuiltQueue.queueDigest,
      runDigest: canonicalSha256(normalizedRunRecords),
    }),
  };
  assert.deepEqual(after, composed.projectionBefore);
  return {
    after,
    before: composed.projectionBefore,
    replayed: {
      conversationMessageCount: Object.keys(rebuiltConversation).length,
      configStateDigest: rebuiltConfig.finalStateDigest,
      contextDigest: rebuiltContext.packDigest,
      leaseStateDigest: rebuiltLease.finalStateDigest,
      queueDigest: rebuiltQueue.queueDigest,
      runRecordCount: normalizedRunRecords.length,
      scheduleDigest: rebuiltSchedule.scheduleDigest,
    },
  };
}

function replayConversationRecords(records) {
  const messages = {};
  for (const record of records) {
    const event = record.event ?? record;
    if (
      !["channel.message.created", "channel.message.replied"].includes(
        event.eventType,
      )
    ) {
      continue;
    }
    messages[event.data.messageId] = {
      ...structuredClone(event.data),
      revision: 1,
      status: "active",
      workspaceId: event.workspaceId,
    };
  }
  return messages;
}

function stripStreamFields(records) {
  return records.map((record) => {
    const copy = structuredClone(record);
    delete copy.stream;
    return copy;
  });
}

async function verifySensitivity() {
  if (process.env.E3_T08_SKIP_SENSITIVITY === "1") {
    return {
      mutationCount: 0,
      result: "SKIPPED",
    };
  }
  const mutations = [
    {
      file: "scripts/verify-e3-t08.mjs",
      name: "reply-endpoint-scope",
      from: 'leaseEndpoints: ["run.events.write", "run.reply.write"],',
      to: 'leaseEndpoints: ["run.events.write"],',
    },
    {
      file: "src/ledger/run-control.mjs",
      name: "activity-event-type",
      from: 'eventType: "run.activity.recorded",',
      to: 'eventType: "run.result.recorded",',
    },
    {
      file: "src/ledger/mention-reconciler.mjs",
      name: "dispatch-door-adapter",
      from: 'const dispatchFunction =\n    typeof dispatch === "function" ? dispatch : dispatch?.dispatch;',
      to: "const dispatchFunction = dispatch;",
    },
  ];
  const results = [];
  for (const [index, mutation] of mutations.entries()) {
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
      const target = path.join(checkout, mutation.file);
      const original = await readFile(target, "utf8");
      assert.equal(
        original.includes(mutation.from),
        true,
        `sensitivity mutation needle missing: ${mutation.file}`,
      );
      await writeFile(target, original.replace(mutation.from, mutation.to));
      const artifactDirectory = path.join(
        checkout,
        ".artifacts",
        "e3-t08-sensitivity",
        mutation.name,
      );
      let exitCode = 0;
      let stdout = "";
      let stderr = "";
      try {
        stdout = execFileSync("node", ["scripts/verify-e3-t08.mjs"], {
          cwd: checkout,
          encoding: "utf8",
          env: {
            ...process.env,
            E3_T08_IMPLEMENTATION_COMMIT: implementationCommit,
            E3_T08_SKIP_GATES: "1",
            E3_T08_SKIP_SENSITIVITY: "1",
            PROMOTE_EVIDENCE: "0",
            TEST_ARTIFACT_DIR: artifactDirectory,
            TEST_RUN_ID: `sens-${index}-${mutation.name}`,
          },
          maxBuffer: 10 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        exitCode = error.status ?? 1;
        stdout = error.stdout ?? "";
        stderr = error.stderr ?? "";
      }
      assert.notEqual(
        exitCode,
        0,
        `sensitivity mutation unexpectedly passed: ${mutation.name}`,
      );
      results.push({
        exitCode,
        file: mutation.file,
        mutation: mutation.name,
        stderrSha256: canonicalSha256(stderr),
        stdoutSha256: canonicalSha256(stdout),
        result: "VERIFIER_FAILED_AS_EXPECTED",
      });
    } finally {
      if (worktreeAdded) {
        try {
          execFileSync("git", ["worktree", "remove", "--force", checkout], {
            cwd: root,
            stdio: "ignore",
          });
        } catch {
          // Preserve the mutation result and remove the temporary parent below.
        }
      }
      await rm(parent, { force: true, recursive: true });
    }
  }
  return {
    mutationCount: results.length,
    mutations: results,
    result: "PASS",
  };
}

function createRequestedAndQueuedRun({ invocation, invocationRef, runId }) {
  const events = [];
  let previous = invocationRef;
  for (const [index, [from, to]] of [
    [null, "requested"],
    ["requested", "queued"],
  ].entries()) {
    const sequence = index + 1;
    const event = issueEventEnvelope(
      {
        actorId: CAPSTONE_IDS.humanId,
        causation: previous,
        correlationId: invocation.correlationId,
        data: {
          attemptId: null,
          attemptNumber: null,
          binding:
            sequence === 1
              ? {
                  agentId: invocation.agentId,
                  correlationId: invocation.correlationId,
                  invocationRef,
                  policy: invocation.policy,
                  policyDigest: invocation.policyDigest,
                  snapshotDigest: invocation.snapshotDigest,
                  snapshotRef: invocation.snapshotRef,
                  sourceTrigger: invocation.sourceTrigger,
                }
              : null,
          from,
          invocationId: invocation.invocationId,
          leaseGeneration: null,
          runId,
          schemaVersion: 1,
          sequence,
          sourceRef: previous,
          terminal: null,
          to,
        },
        eventType: "run.lifecycle.changed",
        idempotencyKey: deriveRunQueueId("ik", { runId, sequence, to }),
        schemaVersion: 1,
        workspaceId: CAPSTONE_IDS.workspaceId,
      },
      {
        clock: () => new Date(CAPSTONE_TIME),
        eventId: deriveRunQueueId("ev", { runId, sequence, to }),
      },
    );
    const record = {
      digest: digestEventEnvelope(event),
      event,
      offset: deterministicOffset(sequence),
    };
    events.push(record);
    previous = {
      digest: record.digest,
      offset: record.offset,
      stream: `run:${runId}`,
    };
  }
  return events;
}

function sourceManifest(dumps, { stateReferences = [] } = {}) {
  const manifest = Object.fromEntries(
    Object.entries(dumps).map(([stream, dump]) => [
      stream,
      {
        head: dump.head,
        recordDigests: dump.records.map((record) => {
          if (record?.event && record?.digest) return record.digest;
          if (record?.digest) return record.digest;
          if (record?.eventType) return digestEventEnvelope(record);
          return canonicalSha256(record);
        }),
        streamDigest: dump.streamDigest,
      },
    ]),
  );
  if (stateReferences.length > 0) {
    manifest.stateReferences = stateReferences.map((reference) => {
      const dump = dumps[reference.stream];
      assert.ok(dump, `state reference stream is absent: ${reference.stream}`);
      assert.equal(
        dump.records.at(-1)?.offset,
        reference.offset,
        `state reference does not resolve to stream head: ${reference.stream}`,
      );
      return {
        ...reference,
        head: dump.head,
        streamDigest: dump.streamDigest,
      };
    });
  }
  return manifest;
}

async function writeJson(filename, value) {
  await writeFile(
    path.join(reportDirectory, filename),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

async function scanEvidence() {
  const names = (await readdir(reportDirectory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const findings = [];
  for (const filename of names) {
    const content = await readFile(
      path.join(reportDirectory, filename),
      "utf8",
    );
    if (
      /-----BEGIN [^-]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\bsk-[A-Za-z0-9_-]{16,}/iu.test(
        content,
      )
    ) {
      findings.push(filename);
    }
  }
  return { checked: true, files: names, findings, leaked: findings.length > 0 };
}
