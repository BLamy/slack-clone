import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createInitialState, reduceEnvelope } from "@stream-slack/reducers";
import {
  deriveInvocationCorrelationId,
  deriveRunControlId,
  policyDigest,
  stampConversationActor,
  validateAgentReplyProvenance,
} from "@stream-slack/protocol";

import {
  AGENT_REPLY_ERROR_CODES,
  AgentReplyError,
  createAgentReplyDispatcher,
} from "../src/ledger/agent-replies.mjs";
import { canonicalSha256 } from "../src/ledger/canonical-json.mjs";
import {
  digestEventEnvelope,
  issueEventEnvelope,
} from "../src/ledger/envelope.mjs";
import {
  createRunLeaseCoordinator,
  projectEligibleQueue,
} from "../src/ledger/run-queue.mjs";

const WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const HUMAN_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const AGENT_PRINCIPAL_ID =
  "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";
const OTHER_AGENT_PRINCIPAL_ID =
  "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_eeeeeeeeeeeeeeeeeeeeeeeeee";
const AGENT_ID = "ag_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";
const CHANNEL_ID = "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const OTHER_CHANNEL_ID =
  "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_eeeeeeeeeeeeeeeeeeeeeeeeee";
const INVOCATION_ID = "iv_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const RUN_ID = "rn_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const WORKER_ID = "reply-worker";
const CHANNEL_STREAM = `channel:${CHANNEL_ID}`;
const INVOCATION_STREAM = `workspace:${WORKSPACE_ID}/invocations`;
const CONFIG_STREAM = `agent:${AGENT_ID}/config`;
const RUN_STREAM = `run:${RUN_ID}`;
const BASE_TIME = Date.parse("2026-08-08T00:00:00.000Z");
const REPLAY_DECLARATION =
  "Replay: N/A (server reply dispatch contract) + mitigation: provenance manifests, lost-ack replay, stale-authority matrix, canary scan, and digests";

const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-3-the-dispatcher/E3-T07-provenance-bound-agent-replies",
);
const runId = String(
  process.env.TEST_RUN_ID ?? `e3-t07-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/gu, "-");
const implementationCommit = String(
  process.env.E3_T07_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
const promoteEvidence = process.env.PROMOTE_EVIDENCE === "1";
const reportDirectory = path.resolve(
  root,
  promoteEvidence
    ? path.join(taskDirectory, "evidence/e3-t07-final")
    : (process.env.TEST_ARTIFACT_DIR ??
        path.join(".artifacts", "e3-t07", runId)),
);

assert.match(implementationCommit, /^[0-9a-f]{40}$/u);
await mkdir(reportDirectory, { recursive: true });
await mkdir(path.join(taskDirectory, "work"), { recursive: true });

const gates = await runGates();
const functional = await verifyFunctionalMatrix();
const sensitivity =
  process.env.E3_T07_SKIP_SENSITIVITY === "1"
    ? { result: "SKIPPED", reason: "nested sensitivity verifier" }
    : await verifySensitivity();

const summary = {
  canaryScan: await scanEvidence(reportDirectory),
  gates,
  implementationCommit,
  replay: REPLAY_DECLARATION,
  result: "PASS",
  runId,
  ...functional,
  sensitivity,
};

await writeJson("reply-receipts.json", functional.replyReceipts);
await writeJson("provenance.json", functional.provenance);
await writeJson("refusal-heads.json", functional.refusalHeads);
await writeJson("message-digests.json", functional.messageDigests);
await writeJson("redaction.json", functional.redaction);
await writeJson("stale-authority.json", functional.staleAuthority);
await writeJson("replay-digests.json", functional.replayDigests);
await writeJson("sensitivity.json", sensitivity);
await writeJson("verification-summary.json", summary);
const finalCanaryScan = await scanEvidence(reportDirectory);
assert.equal(finalCanaryScan.leaked, false);
await writeJson("canary-scan.json", finalCanaryScan);
await writeJson("verification-summary.json", {
  ...summary,
  canaryScan: finalCanaryScan,
});

console.log(
  JSON.stringify(
    {
      implementationCommit,
      result: "PASS",
      runId,
      gates: gates.map(({ name, result }) => ({ name, result })),
      replies: functional.replyReceipts.acceptedCount,
      refusals: functional.refusalHeads.refusalCount,
      sensitivity: sensitivity.result,
      replay: REPLAY_DECLARATION,
    },
    null,
    2,
  ),
);

async function runGates() {
  if (process.env.E3_T07_SKIP_GATES === "1") {
    return [{ command: "gates skipped", name: "gates", result: "SKIPPED" }];
  }
  const results = [];
  for (const [name, command, args] of [
    ["format", "pnpm", ["format:check"]],
    ["lint", "pnpm", ["lint"]],
    ["typecheck", "pnpm", ["typecheck"]],
    ["tests", "pnpm", ["test"]],
    ["build", "pnpm", ["build"]],
  ]) {
    const startedAt = Date.now();
    execFileSync(command, args, { cwd: root, stdio: "inherit" });
    results.push({
      command: `${command} ${args.join(" ")}`,
      durationMs: Date.now() - startedAt,
      name,
      result: "PASS",
    });
  }
  return results;
}

async function verifyFunctionalMatrix() {
  const happy = await createHarness();
  const happyResult = await happy.dispatcher.dispatchReply({
    capability: happy.capability,
    output: "A bounded answer from the agent.",
    runId: RUN_ID,
    workerId: WORKER_ID,
  });
  assert.equal(happyResult.result, "accepted");
  assert.equal(happy.channelMessages.length, 2);
  assert.equal(happy.messageDispatches.length, 1);
  validateAgentReplyProvenance(happy.messageDispatches[0].provenance, {
    expectedAgentId: AGENT_ID,
    expectedAgentPrincipalId: AGENT_PRINCIPAL_ID,
    expectedChannelId: CHANNEL_ID,
    expectedWorkspaceId: WORKSPACE_ID,
  });
  assert.equal(happy.messageDispatches[0].actorId, AGENT_PRINCIPAL_ID);
  assert.equal(
    happy.messageDispatches[0].provenance.threadRootMessageId,
    "root-message",
  );

  const reducerCheck = reduceReplyThroughMessageReducer(
    happy.messageDispatches[0].event,
  );
  assert.equal(
    reducerCheck.entities.messages[happyResult.messageId].agentReplyProvenance
      .runId,
    RUN_ID,
  );

  const spoof = await createHarness();
  await assertReplyRefusal(
    spoof.dispatcher.dispatchReply({
      capability: spoof.capability,
      channelId: OTHER_CHANNEL_ID,
      output: "spoof",
      runId: RUN_ID,
      workerId: WORKER_ID,
    }),
    AGENT_REPLY_ERROR_CODES.INVALID_REQUEST,
  );
  assert.equal(spoof.channelMessages.length, 1);
  assert.equal(spoof.refusalArtifacts.length, 0);

  const lostAck = await createHarness({ loseAck: true });
  const retryRequest = {
    capability: lostAck.capability,
    output: "one durable reply",
    runId: RUN_ID,
    workerId: WORKER_ID,
  };
  await assertReplyRefusal(
    lostAck.dispatcher.dispatchReply(retryRequest),
    AGENT_REPLY_ERROR_CODES.ACK_UNKNOWN,
    { artifact: false },
  );
  const replayed = await lostAck.dispatcher.dispatchReply(retryRequest);
  assert.equal(replayed.result, "accepted");
  assert.equal(replayed.receipt.replayed, true);
  assert.equal(lostAck.channelMessages.length, 2);
  assert.equal(lostAck.messageDispatches.length, 1);
  const conflicting = { ...retryRequest, output: "a conflicting reply" };
  await assertReplyRefusal(
    lostAck.dispatcher.dispatchReply(conflicting),
    AGENT_REPLY_ERROR_CODES.DISPATCH_REFUSED,
  );
  assert.equal(lostAck.channelMessages.length, 2);

  const redacted = await createHarness();
  const secret = `sk-${"z".repeat(24)}`;
  const unsafe = `<script>send(${secret})</script>`;
  const redactedResult = await redacted.dispatcher.dispatchReply({
    capability: redacted.capability,
    output: unsafe,
    runId: RUN_ID,
    workerId: WORKER_ID,
  });
  const redactedText = redacted.channelMessages.at(-1).text;
  assert.equal(redactedResult.output.redacted, true);
  assert.equal(redactedText.includes(secret), false);
  assert.equal(redactedText.includes("<script>"), false);
  assert.equal(redactedText.includes("&lt;script&gt;"), true);

  const staleAuthority = await verifyStaleAuthorityMatrix();
  const refusalHeads = {
    refusalCount: staleAuthority.cases.length + 2,
    artifacts: staleAuthority.cases.map((entry) => entry.artifact),
    allBoundToRuns: staleAuthority.cases.every(
      (entry) => entry.artifact.runId === RUN_ID,
    ),
  };
  assert.equal(refusalHeads.allBoundToRuns, true);
  const messageEvents = [
    happy.messageDispatches[0].event,
    lostAck.messageDispatches[0].event,
    redacted.messageDispatches[0].event,
  ];
  const messageDigests = {
    acceptedMessageCount: messageEvents.length,
    channelStreamDigest: canonicalSha256(messageEvents),
    provenanceDigests: messageEvents.map((event) =>
      canonicalSha256(event.data.agentReplyProvenance),
    ),
  };
  const replayDigests = {
    channel: messageDigests.channelStreamDigest,
    refusalHeads: canonicalSha256(
      staleAuthority.cases.map(({ artifact }) => ({
        artifactId: artifact.artifactId,
        refusalCode: artifact.refusalCode,
        runId: artifact.runId,
      })),
    ),
    provenance: canonicalSha256(
      happy.messageDispatches.map(({ provenance }) => provenance),
    ),
  };
  return {
    messageDigests,
    provenance: {
      actorKind: "agent",
      derivedFields: Object.keys(happy.messageDispatches[0].provenance).sort(),
      invocationRef: happy.messageDispatches[0].provenance.invocationRef,
      sourceMention: happy.messageDispatches[0].provenance.sourceMention,
      snapshotRef: happy.messageDispatches[0].provenance.snapshotRef,
      contextRef: happy.messageDispatches[0].provenance.contextRef,
      runId: RUN_ID,
      attemptId: happy.messageDispatches[0].provenance.attemptId,
      leaseGeneration: happy.messageDispatches[0].provenance.leaseGeneration,
    },
    redaction: {
      canaryAbsentFromAcceptedChannel: !redacted.channelMessages
        .map(({ text }) => text)
        .join("\n")
        .includes(secret),
      escapedMarkup: redactedText.includes("&lt;script&gt;"),
      redacted: redactedResult.output.redacted,
      refusalOutputBytesOnly: staleAuthority.cases.every(
        ({ artifact }) => !Object.hasOwn(artifact, "output"),
      ),
    },
    refusalHeads,
    replayDigests,
    replyReceipts: {
      acceptedCount: 3,
      lostAck: {
        first: "AGENT_REPLY_ACK_UNKNOWN",
        retry: "replayed",
        logicalChannelMessages: 1,
      },
      receipts: [happyResult.receipt, replayed.receipt, redactedResult.receipt],
    },
    staleAuthority,
  };
}

async function createHarness({
  loseAck = false,
  policy = buildPolicy(),
  sourceMentionPrincipalId = AGENT_PRINCIPAL_ID,
} = {}) {
  let nowMs = BASE_TIME;
  let eventNumber = 0;
  let capabilityNumber = 0;
  let shouldLoseAck = loseAck;
  const refusalArtifacts = [];
  const messageDispatches = [];
  const acceptedByKey = new Map();
  const channelMessages = [
    {
      channelId: CHANNEL_ID,
      messageId: "root-message",
      rootMessageId: null,
      status: "active",
    },
  ];
  const authority = {
    agentStatus: "active",
    channel: {
      channelId: CHANNEL_ID,
      status: "active",
      workspaceId: WORKSPACE_ID,
    },
    channelMembership: {
      channelId: CHANNEL_ID,
      principalId: AGENT_PRINCIPAL_ID,
      status: "active",
      workspaceId: WORKSPACE_ID,
    },
    principal: {
      kind: "agent",
      principalId: AGENT_PRINCIPAL_ID,
      status: "active",
    },
    workspaceMembership: {
      principalId: AGENT_PRINCIPAL_ID,
      role: "agent",
      status: "active",
      workspaceId: WORKSPACE_ID,
    },
    workspaceStatus: "active",
  };

  const sourceMention = createSourceMessage(sourceMentionPrincipalId);
  const sourceRecords = new Map([
    [referenceKey(sourceMention.ref), sourceMention],
  ]);
  const invocation = createInvocation(sourceMention.ref, policy);
  const invocationRecord = invocation.record;
  const invocationRef = invocation.ref;
  sourceRecords.set(referenceKey(invocationRef), invocationRecord);

  const runRecords = [];
  const requested = appendRunLifecycle(runRecords, {
    binding: {
      agentId: AGENT_ID,
      correlationId: invocation.data.correlationId,
      invocationRef,
      policy: invocation.data.policy,
      policyDigest: invocation.data.policyDigest,
      snapshotDigest: invocation.data.snapshotDigest,
      snapshotRef: invocation.data.snapshotRef,
      sourceTrigger: invocation.data.sourceTrigger,
    },
    from: null,
    sequence: 1,
    to: "requested",
  });
  const queued = appendRunLifecycle(runRecords, {
    from: "requested",
    previousRef: requested.ref,
    sequence: 2,
    to: "queued",
  });
  const queueProjection = projectEligibleQueue({
    invocations: [
      {
        ...invocation.data,
        sourceRef: invocationRef,
        status: "requested",
      },
    ],
    now: new Date(nowMs),
    runs: [
      {
        agentId: AGENT_ID,
        attempts: 0,
        invocationId: INVOCATION_ID,
        runId: RUN_ID,
        runRef: queued.ref,
        status: "queued",
      },
    ],
    workspaceId: WORKSPACE_ID,
  });
  const leaseCoordinator = createRunLeaseCoordinator({
    actorId: HUMAN_ID,
    appendLeaseEvent: async ({ record }) => {
      const persisted = {
        ...record,
        offset: offset(runRecords.length + 1),
        stream: RUN_STREAM,
      };
      runRecords.push(persisted);
      return { record: persisted };
    },
    clock: () => new Date(nowMs),
    maxActiveLeases: 1,
    queueProjection,
    resolveAuthority: async () => ({
      agentStatus:
        authority.principal.status === "active" ? "active" : "disabled",
      invocationStatus: "queued",
      snapshotDigest: invocation.data.snapshotDigest,
      workspaceStatus: authority.workspaceStatus,
    }),
    tokenFactory: () =>
      `rcap_${String(++capabilityNumber).padStart(2, "0")}${"x".repeat(62)}`,
    workspaceId: WORKSPACE_ID,
  });
  const acquired = await leaseCoordinator.acquire({
    endpoints: ["run.reply.write"],
    entry: queueProjection.entries[0],
    now: new Date(nowMs),
    queueProof: queueProjection.proof,
    workerId: WORKER_ID,
  });
  const lease = acquired.lease;
  const leased = appendRunLifecycle(runRecords, {
    attemptId: lease.attemptId,
    attemptNumber: lease.attemptNumber,
    from: "queued",
    leaseGeneration: lease.leaseGeneration,
    previousRef: lastReference(runRecords),
    sequence: 3,
    to: "leased",
  });
  appendRunLifecycle(runRecords, {
    attemptId: lease.attemptId,
    attemptNumber: lease.attemptNumber,
    from: "leased",
    leaseGeneration: lease.leaseGeneration,
    previousRef: leased.ref,
    sequence: 4,
    to: "running",
  });
  const contextRef = {
    digest: canonicalSha256({
      context: "bounded",
      invocationId: INVOCATION_ID,
    }),
    offset: offset(9),
    stream: CHANNEL_STREAM,
  };
  const contextEvent = appendRunActivity(runRecords, {
    attemptId: lease.attemptId,
    contentRef: contextRef,
    previousRef: lastReference(runRecords),
    sequence: 5,
  });
  sourceRecords.set(referenceKey(contextRef), {
    digest: contextRef.digest,
    event: contextEvent.event,
    offset: contextRef.offset,
    stream: contextRef.stream,
  });

  const readSource = async ({ reference }) => {
    const record = sourceRecords.get(referenceKey(reference));
    if (!record) throw new Error("source record not found");
    return structuredClone(record);
  };
  const readChannel = async () => ({
    channel: structuredClone(authority.channel),
    messages: structuredClone(channelMessages),
  });
  const readAuthority = async () => structuredClone(authority);
  const readInvocation = async () => structuredClone(invocationRecord);
  const readRun = async () => ({ records: structuredClone(runRecords) });
  const dispatch = async (request) => {
    const prepared = stampConversationActor(
      { operation: request.operation, payload: request.payload },
      request.actorId,
      WORKSPACE_ID,
      { allowAgentReplyProvenance: true },
    );
    const requestDigest = canonicalSha256({
      actorId: request.actorId,
      operation: request.operation,
      payload: prepared.data,
      workspaceId: request.workspaceId,
    });
    const existing = acceptedByKey.get(request.idempotencyKey);
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        const conflict = new Error("idempotency payload conflict");
        conflict.code = "DISPATCH_IDEMPOTENCY_CONFLICT";
        throw conflict;
      }
      return {
        ...existing.result,
        receipt: { ...existing.result.receipt, replayed: true },
      };
    }
    if (
      channelMessages.some(
        ({ messageId }) => messageId === prepared.data.messageId,
      )
    ) {
      const duplicate = new Error("message id was already accepted");
      duplicate.code = "DISPATCH_IDEMPOTENCY_CONFLICT";
      throw duplicate;
    }
    const event = issueEventEnvelope(
      {
        actorId: request.actorId,
        causation: prepared.data.agentReplyProvenance.sourceMention,
        correlationId: deriveRunControlId("cr", {
          idempotencyKey: request.idempotencyKey,
        }),
        data: prepared.data,
        eventType: "channel.message.replied",
        idempotencyKey: request.idempotencyKey,
        schemaVersion: 1,
        workspaceId: WORKSPACE_ID,
      },
      {
        clock: () => new Date(nowMs + ++eventNumber),
        eventId: deriveRunControlId("ev", {
          idempotencyKey: request.idempotencyKey,
        }),
      },
    );
    const record = {
      digest: digestEventEnvelope(event),
      event,
      offset: offset(channelMessages.length + 1),
      stream: CHANNEL_STREAM,
    };
    const result = {
      event,
      message: event.data,
      receipt: {
        eventDigest: record.digest,
        idempotencyKey: request.idempotencyKey,
        nextOffset: record.offset,
        replayed: false,
        stream: CHANNEL_STREAM,
      },
    };
    acceptedByKey.set(request.idempotencyKey, { requestDigest, result });
    channelMessages.push({
      channelId: CHANNEL_ID,
      messageId: event.data.messageId,
      rootMessageId: event.data.rootMessageId,
      status: "active",
      text: event.data.text,
    });
    messageDispatches.push({
      actorId: event.actorId,
      event,
      provenance: event.data.agentReplyProvenance,
    });
    if (shouldLoseAck) {
      shouldLoseAck = false;
      const lost = new Error("simulated lost acknowledgement");
      lost.ambiguousAck = true;
      throw lost;
    }
    return result;
  };
  const dispatcher = createAgentReplyDispatcher({
    appendRefusal: async (artifact) => {
      const existing = refusalArtifacts.find(
        ({ idempotencyKey }) => idempotencyKey === artifact.idempotencyKey,
      );
      if (existing) return existing;
      refusalArtifacts.push(structuredClone(artifact));
      return artifact;
    },
    clock: () => new Date(nowMs),
    dispatch,
    leaseCoordinator,
    readAuthority,
    readChannel,
    readInvocation,
    readRun,
    readSource,
    workspaceId: WORKSPACE_ID,
  });
  return {
    authority,
    channelMessages,
    dispatcher,
    invocation,
    leaseCoordinator,
    capability: acquired.capability,
    messageDispatches,
    nowMs,
    refusalArtifacts,
    runRecords,
    sourceMention,
    contextRef,
    setNow(value) {
      nowMs = value;
    },
  };
}

function buildPolicy(overrides = {}) {
  return {
    allowApprovals: false,
    maxAttempts: 3,
    maxCostUsdCents: 100,
    maxInputTokens: 100,
    maxOutputBytes: 1_000,
    maxOutputTokens: 100,
    maxWallTimeMs: 1_000,
    version: 1,
    ...overrides,
  };
}

function createSourceMessage(targetPrincipalId) {
  const mentions = [
    {
      handle: targetPrincipalId === AGENT_PRINCIPAL_ID ? "helper" : "other",
      kind: "agent",
      principalId: targetPrincipalId,
      span: { endByte: 7, startByte: 0 },
      text: targetPrincipalId === AGENT_PRINCIPAL_ID ? "@helper" : "@other",
    },
  ];
  const event = issueEventEnvelope(
    {
      actorId: HUMAN_ID,
      causation: null,
      correlationId: `cr_${"a".repeat(26)}`,
      data: {
        authorId: HUMAN_ID,
        channelId: CHANNEL_ID,
        contentType: "text/plain",
        mentions,
        messageId: "root-message",
        rootMessageId: null,
        text: mentions[0].text,
      },
      eventType: "channel.message.created",
      idempotencyKey: `ik_${"a".repeat(26)}`,
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
    },
    {
      clock: () => new Date(BASE_TIME),
      eventId: `ev_${"a".repeat(26)}`,
    },
  );
  return {
    digest: digestEventEnvelope(event),
    event,
    offset: offset(1),
    ref: {
      digest: digestEventEnvelope(event),
      offset: offset(1),
      stream: CHANNEL_STREAM,
    },
    stream: CHANNEL_STREAM,
  };
}

function createInvocation(sourceRef, policy) {
  const snapshotRef = {
    digest: canonicalSha256({ config: "active" }),
    offset: offset(1),
    stream: CONFIG_STREAM,
  };
  const snapshotDigest = canonicalSha256({ snapshot: "immutable" });
  const correlationId = deriveInvocationCorrelationId({
    agentId: AGENT_ID,
    invocationId: INVOCATION_ID,
    sourceTrigger: sourceRef,
    workspaceId: WORKSPACE_ID,
  });
  const data = {
    agentId: AGENT_ID,
    correlationId,
    invocationId: INVOCATION_ID,
    policy,
    policyDigest: policyDigest(policy),
    promptRef: sourceRef,
    schemaVersion: 1,
    snapshotDigest,
    snapshotRef,
    sourceTrigger: sourceRef,
    triggerType: "channel.mention",
  };
  const event = issueEventEnvelope(
    {
      actorId: HUMAN_ID,
      causation: sourceRef,
      correlationId,
      data,
      eventType: "workspace.invocation.requested",
      idempotencyKey: `ik_${"b".repeat(26)}`,
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
    },
    {
      clock: () => new Date(BASE_TIME + 1000),
      eventId: `ev_${"b".repeat(26)}`,
    },
  );
  const record = {
    digest: digestEventEnvelope(event),
    event,
    offset: offset(1),
    stream: INVOCATION_STREAM,
  };
  return {
    data,
    event,
    record,
    ref: {
      digest: record.digest,
      offset: record.offset,
      stream: INVOCATION_STREAM,
    },
  };
}

function appendRunLifecycle(
  records,
  {
    attemptId = null,
    attemptNumber = null,
    binding = null,
    from,
    leaseGeneration = null,
    previousRef = null,
    sequence,
    terminal = null,
    to,
  },
) {
  const sourceRef = previousRef ?? {
    digest: canonicalSha256({ invocation: INVOCATION_ID }),
    offset: offset(1),
    stream: RUN_STREAM,
  };
  const event = issueEventEnvelope(
    {
      actorId: HUMAN_ID,
      causation: sourceRef,
      correlationId: `cr_${"c".repeat(26)}`,
      data: {
        attemptId,
        attemptNumber,
        binding,
        from,
        invocationId: INVOCATION_ID,
        leaseGeneration,
        runId: RUN_ID,
        schemaVersion: 1,
        sequence,
        sourceRef,
        terminal,
        to,
      },
      eventType: "run.lifecycle.changed",
      idempotencyKey: deriveRunControlId("ik", {
        kind: "fixture-lifecycle",
        sequence,
        to,
      }),
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
    },
    {
      clock: () => new Date(BASE_TIME + sequence * 1000),
      eventId: deriveRunControlId("ev", {
        kind: "fixture-lifecycle",
        sequence,
        to,
      }),
    },
  );
  const record = {
    digest: digestEventEnvelope(event),
    event,
    offset: offset(records.length + 1),
    stream: RUN_STREAM,
  };
  records.push(record);
  return {
    event,
    ref: {
      digest: record.digest,
      offset: record.offset,
      stream: RUN_STREAM,
    },
  };
}

function appendRunActivity(
  records,
  { attemptId, contentRef, previousRef, sequence },
) {
  const event = issueEventEnvelope(
    {
      actorId: HUMAN_ID,
      causation: previousRef,
      correlationId: `cr_${"c".repeat(26)}`,
      data: {
        attemptId,
        contentRef,
        invocationId: INVOCATION_ID,
        kind: "context-pack",
        runId: RUN_ID,
        schemaVersion: 1,
        sequence,
        sourceRef: previousRef,
        summary: "bounded context pack",
      },
      eventType: "run.activity.recorded",
      idempotencyKey: deriveRunControlId("ik", {
        kind: "fixture-context",
        sequence,
      }),
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
    },
    {
      clock: () => new Date(BASE_TIME + sequence * 1000),
      eventId: deriveRunControlId("ev", {
        kind: "fixture-context",
        sequence,
      }),
    },
  );
  const record = {
    digest: digestEventEnvelope(event),
    event,
    offset: offset(records.length + 1),
    stream: RUN_STREAM,
  };
  records.push(record);
  return record;
}

function appendTerminalLifecycle(harness) {
  const lease = harness.runRecords.find(
    ({ event }) => event.eventType === "run.lease.acquired",
  )?.event.data;
  appendRunLifecycle(harness.runRecords, {
    attemptId: lease.attemptId,
    attemptNumber: lease.attemptNumber,
    from: "running",
    leaseGeneration: lease.leaseGeneration,
    previousRef: lastReference(harness.runRecords),
    sequence: 6,
    terminal: {
      failureCode: null,
      kind: "completed",
      reasonCode: null,
      resultRef: harness.contextRef,
    },
    to: "completed",
  });
}

function reduceReplyThroughMessageReducer(replyEvent) {
  const source = createSourceMessage(AGENT_PRINCIPAL_ID);
  const state = createInitialState();
  state.entities.channels = {
    [CHANNEL_ID]: {
      channelId: CHANNEL_ID,
      status: "active",
      workspaceId: WORKSPACE_ID,
    },
  };
  state.entities.channelMemberships = {
    [`${CHANNEL_ID}\u0000${HUMAN_ID}`]: {
      channelId: CHANNEL_ID,
      principalId: HUMAN_ID,
      status: "active",
      workspaceId: WORKSPACE_ID,
    },
    [`${CHANNEL_ID}\u0000${AGENT_PRINCIPAL_ID}`]: {
      channelId: CHANNEL_ID,
      principalId: AGENT_PRINCIPAL_ID,
      status: "active",
      workspaceId: WORKSPACE_ID,
    },
  };
  state.entities.memberships = {
    [membershipKey(HUMAN_ID)]: {
      principalId: HUMAN_ID,
      role: "member",
      status: "active",
      workspaceId: WORKSPACE_ID,
    },
    [membershipKey(AGENT_PRINCIPAL_ID)]: {
      principalId: AGENT_PRINCIPAL_ID,
      role: "agent",
      status: "active",
      workspaceId: WORKSPACE_ID,
    },
  };
  state.entities.principals = {
    [AGENT_PRINCIPAL_ID]: {
      kind: "agent",
      principalId: AGENT_PRINCIPAL_ID,
      status: "active",
    },
  };
  const rootEvent = structuredClone(source.event);
  delete rootEvent.data.mentions;
  let next = reduceEnvelope(state, rootEvent, { offset: offset(1) });
  next = reduceEnvelope(next, replyEvent, { offset: offset(2) });
  return next;
}

function membershipKey(principalId) {
  return `mb_${WORKSPACE_ID.slice(3)}_${principalId.slice(30)}`;
}

function lastReference(records) {
  const record = records.at(-1);
  return {
    digest: record.digest,
    offset: record.offset,
    stream: RUN_STREAM,
  };
}

function assertReplyRefusal(promise, expectedCode, { artifact = true } = {}) {
  return Promise.resolve(promise).then(
    () => {
      assert.fail(`reply unexpectedly accepted; expected ${expectedCode}`);
    },
    (error) => {
      assert.ok(error instanceof AgentReplyError);
      if (expectedCode !== null) assert.equal(error.code, expectedCode);
      if (artifact) {
        if (expectedCode !== AGENT_REPLY_ERROR_CODES.INVALID_REQUEST) {
          assert.ok(
            error.artifact ||
              expectedCode === AGENT_REPLY_ERROR_CODES.ACK_UNKNOWN,
            JSON.stringify(error.toJSON()),
          );
        }
      } else {
        assert.equal(error.artifact, undefined);
      }
      return error;
    },
  );
}

function referenceKey(reference) {
  return `${reference.stream}\u0000${reference.offset}\u0000${reference.digest}`;
}

function offset(value) {
  return `${String(value).padStart(16, "0")}_0000000000000000`;
}

async function verifySensitivity() {
  const mutations = [
    {
      label: "current-membership-fence",
      needle: "assertAuthority(authority, { agentPrincipalId, channelId });",
      replacement: "// sensitivity mutant: omit current membership fence",
      target: "src/ledger/agent-replies.mjs",
    },
    {
      label: "terminal-run-fence",
      needle: "assertRunIsCurrent(run, scope);",
      replacement: "// sensitivity mutant: omit terminal run fence",
      target: "src/ledger/agent-replies.mjs",
    },
    {
      label: "source-mention-fence",
      needle: "assertSourceTargetsAgent(source, agentPrincipalId);",
      replacement: "// sensitivity mutant: omit source mention fence",
      target: "src/ledger/agent-replies.mjs",
    },
  ];
  const control = await runSensitivityChild(root, "control");
  assert.equal(control.exitCode, 0, "clean sensitivity control failed");
  const results = [];
  for (const mutation of mutations) {
    const parent = await mkdtemp(
      path.join(taskDirectory, `sensitivity-${mutation.label}-`),
    );
    const checkout = path.join(parent, "checkout");
    let added = false;
    try {
      execFileSync(
        "git",
        ["worktree", "add", "--detach", checkout, implementationCommit],
        { cwd: root, stdio: "ignore" },
      );
      added = true;
      const targetPath = path.join(checkout, mutation.target);
      const original = await readFile(targetPath, "utf8");
      assert.equal(
        original.split(mutation.needle).length - 1,
        1,
        `${mutation.label} needle changed unexpectedly`,
      );
      await writeFile(
        targetPath,
        original.replace(mutation.needle, mutation.replacement),
      );
      const result = await runSensitivityChild(checkout, mutation.label);
      assert.notEqual(result.exitCode, 0, `${mutation.label} mutant passed`);
      results.push({
        detected: true,
        label: mutation.label,
        verifierExitCode: result.exitCode,
      });
    } finally {
      if (added) {
        execFileSync("git", ["worktree", "remove", "--force", checkout], {
          cwd: root,
          stdio: "ignore",
        });
      }
      await rm(parent, { force: true, recursive: true });
    }
  }
  return {
    controlExitCode: control.exitCode,
    controlPassed: true,
    mutationCount: results.length,
    result: "PASS",
    results,
    verifierDetectedMutant: results.every(({ detected }) => detected),
  };
}

async function runSensitivityChild(cwd, label) {
  const artifactDirectory = path.join(
    cwd,
    ".artifacts",
    "e3-t07-sensitivity",
    label,
  );
  try {
    execFileSync(process.execPath, ["scripts/verify-e3-t07.mjs"], {
      cwd,
      env: {
        ...process.env,
        E3_T07_IMPLEMENTATION_COMMIT: implementationCommit,
        E3_T07_SKIP_GATES: "1",
        E3_T07_SKIP_SENSITIVITY: "1",
        PROMOTE_EVIDENCE: "0",
        TEST_ARTIFACT_DIR: artifactDirectory,
        TEST_RUN_ID: `${runId}-${label}`,
      },
      maxBuffer: 20 * 1024 * 1024,
      stdio: "pipe",
    });
    return { exitCode: 0 };
  } catch (error) {
    return {
      exitCode: error.status ?? 1,
      output: String(error.stderr ?? error.stdout ?? "").slice(-2_000),
    };
  }
}

async function writeJson(filename, value) {
  await writeFile(
    path.join(reportDirectory, filename),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

async function scanEvidence(directory) {
  const files = (await import("node:fs/promises")).readdir(directory);
  const names = (await files)
    .filter((filename) => filename.endsWith(".json"))
    .sort();
  const patterns = [
    /-----BEGIN [^-]*PRIVATE KEY-----/iu,
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/iu,
    /\b(?:sk|rk|pk)-[A-Za-z0-9][A-Za-z0-9_-]{15,}\b/u,
    /\b(?:api[_-]?key|client[_-]?secret|password|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/iu,
    /<script[\s>]/iu,
    /send\(sk-/iu,
    /rcap_[A-Za-z0-9_-]{32,96}/u,
  ];
  const findings = [];
  for (const filename of names) {
    const content = await readFile(path.join(directory, filename), "utf8");
    for (const pattern of patterns) {
      if (pattern.test(content))
        findings.push({ filename, pattern: pattern.source });
    }
  }
  return {
    checked: true,
    files: names,
    findings,
    leaked: findings.length > 0,
  };
}

async function verifyStaleAuthorityMatrix() {
  const cases = [];
  for (const [name, mutate, expectedCode] of [
    [
      "membership-removed",
      (harness) => {
        harness.authority.channelMembership.status = "removed";
      },
      AGENT_REPLY_ERROR_CODES.MEMBERSHIP_INACTIVE,
    ],
    [
      "channel-archived",
      (harness) => {
        harness.authority.channel.status = "archived";
      },
      AGENT_REPLY_ERROR_CODES.CHANNEL_INACTIVE,
    ],
    [
      "agent-disabled",
      (harness) => {
        harness.authority.principal.status = "deactivated";
      },
      null,
    ],
    [
      "workspace-suspended",
      (harness) => {
        harness.authority.workspaceStatus = "suspended";
      },
      null,
    ],
  ]) {
    const harness = await createHarness();
    mutate(harness);
    const error = await assertReplyRefusal(
      harness.dispatcher.dispatchReply({
        capability: harness.capability,
        output: `late ${name}`,
        runId: RUN_ID,
        workerId: WORKER_ID,
      }),
      expectedCode,
    );
    assert.equal(harness.channelMessages.length, 1, name);
    assert.equal(harness.refusalArtifacts.length, 1, name);
    cases.push({
      artifact: harness.refusalArtifacts[0],
      code: error.code,
      name,
      channelAppends: harness.channelMessages.length - 1,
    });
  }

  const terminal = await createHarness();
  appendTerminalLifecycle(terminal);
  const terminalError = await assertReplyRefusal(
    terminal.dispatcher.dispatchReply({
      capability: terminal.capability,
      output: "late terminal output",
      runId: RUN_ID,
      workerId: WORKER_ID,
    }),
    AGENT_REPLY_ERROR_CODES.RUN_TERMINAL,
  );
  cases.push({
    artifact: terminal.refusalArtifacts[0],
    code: terminalError.code,
    name: "terminal-run",
    channelAppends: terminal.channelMessages.length - 1,
  });

  const revoked = await createHarness();
  await revoked.leaseCoordinator.revoke({
    capability: revoked.capability,
    now: new Date(revoked.nowMs),
    reason: "test-revoked",
    runId: RUN_ID,
    workerId: WORKER_ID,
  });
  const revokedError = await assertReplyRefusal(
    revoked.dispatcher.dispatchReply({
      capability: revoked.capability,
      output: "late revoked output",
      runId: RUN_ID,
      workerId: WORKER_ID,
    }),
    AGENT_REPLY_ERROR_CODES.LEASE_INVALID,
  );
  cases.push({
    artifact: revoked.refusalArtifacts[0],
    code: revokedError.code,
    name: "lease-revoked",
    channelAppends: revoked.channelMessages.length - 1,
  });

  const wrongSource = await createHarness({
    sourceMentionPrincipalId: OTHER_AGENT_PRINCIPAL_ID,
  });
  const wrongSourceError = await assertReplyRefusal(
    wrongSource.dispatcher.dispatchReply({
      capability: wrongSource.capability,
      output: "wrong source output",
      runId: RUN_ID,
      workerId: WORKER_ID,
    }),
    AGENT_REPLY_ERROR_CODES.SOURCE_INVALID,
  );
  cases.push({
    artifact: wrongSource.refusalArtifacts[0],
    code: wrongSourceError.code,
    name: "cross-agent-source",
    channelAppends: wrongSource.channelMessages.length - 1,
  });
  return { cases, refusalCount: cases.length };
}
