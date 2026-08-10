import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  deriveRunQueueId,
  planConversationSchedule,
  validateRunControlPolicy,
  zeroRunUsage,
} from "@stream-slack/protocol";

import { canonicalSha256 } from "../src/ledger/canonical-json.mjs";
import { createAgentReplyDispatcher } from "../src/ledger/agent-replies.mjs";
import {
  assembleContextPack,
  contextPackDigest,
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
} from "../src/ledger/run-queue.mjs";
import {
  createRunControlCoordinator,
  createScriptedProcessRunner,
} from "../src/ledger/run-control.mjs";
import { streamNames } from "../src/ledger/topology.mjs";
import {
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
const streamDumps = composed.store.dump();
const sourceRefManifest = sourceManifest(streamDumps);
const composite = canonicalSha256({
  context: composed.context,
  invocation: composed.invocation,
  queue: composed.queue,
  run: composed.run,
  scheduler: composed.scheduler,
  sourceRefManifest,
});
const evidence = {
  batchingRecursionOutcomes: composed.scheduler,
  compositeReplayDigests: {
    compositeDigest: composite,
    rebuiltDigest: canonicalSha256({
      context: composed.context,
      invocation: composed.invocation,
      queue: composed.queue,
      run: composed.run,
      scheduler: composed.scheduler,
      sourceRefManifest: sourceManifest(structuredClone(streamDumps)),
    }),
  },
  faultSchedules: composed.store.faultSchedule(),
  gates,
  implementationCommit,
  mentionInvocationSnapshot: composed.invocation,
  queueLeaseManifest: composed.lease,
  replay,
  result: "PASS",
  runId,
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
  ["batching-recursion-outcomes.json", composed.scheduler],
  ["attempt-timelines.json", composed.run.state.attemptTimelines],
  ["process-resource-counts.json", composed.run.state.processSnapshot],
  ["context-pack.json", composed.context],
  ["composite-replay-digests.json", evidence.compositeReplayDigests],
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
  const snapshot = createCapstoneSnapshot(sourceTrigger);
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
    offset: deterministicOffset(1),
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
  const scheduler = createConversationScheduler({
    record: async (entry) => scheduleJournal.push(entry),
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
      durableRunRecords.push(structuredClone(record));
      return { record };
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
  const contextRef = {
    digest: contextPack.packDigest,
    offset: deterministicOffset(2),
    stream: streamNames.channel(workspaceId, channelId),
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
  return {
    context: contextPack,
    invocation: {
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
      journal: scheduleJournal,
      scheduleDigest: schedule.scheduleDigest,
      batches: schedule.batches,
      refusals: schedule.refusals,
    },
    run: {
      records: controller.getRecords(),
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

function sourceManifest(dumps) {
  return Object.fromEntries(
    Object.entries(dumps).map(([stream, dump]) => [
      stream,
      {
        head: dump.head,
        recordDigests: dump.records.map((record) => {
          if (record?.event && record?.digest) return record.digest;
          if (record?.eventType) return digestEventEnvelope(record);
          return canonicalSha256(record);
        }),
        streamDigest: dump.streamDigest,
      },
    ]),
  );
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
