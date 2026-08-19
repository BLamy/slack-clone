import assert from "node:assert/strict";
import test from "node:test";

import {
  digestEventEnvelope,
  issueEventEnvelope,
} from "../../src/ledger/envelope.mjs";
import { replayRecords } from "@stream-slack/reducers";
import {
  deriveInvocationCorrelationId,
  policyDigest,
} from "@stream-slack/protocol";

const correlationIdFor = deriveInvocationCorrelationId;

const WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACTOR_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const AGENT_ID = "ag_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const RUN_ID = "rn_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";
const INVOCATION_ID = "iv_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHANNEL_STREAM =
  "channel:ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const SNAPSHOT_STREAM =
  "agent:ag_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc/config";
const RESULT_STREAM =
  "projection:px_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";

test("invocation/run v1 replays a complete lifecycle with bounded records", () => {
  const { records, resultRef } = lifecycleRecords();
  const first = replayRecords(records);
  const second = replayRecords(structuredClone(records));
  const run = first.finalState.entities.runs[RUN_ID];

  assert.equal(first.finalStateDigest, second.finalStateDigest);
  assert.deepEqual(
    first.prefixes.map(({ offset, stateDigest }) => ({ offset, stateDigest })),
    second.prefixes.map(({ offset, stateDigest }) => ({ offset, stateDigest })),
  );
  assert.equal(run.status, "completed");
  assert.equal(run.attempts.at_1.status, "completed");
  assert.deepEqual(run.usage, {
    costUsdCents: 7,
    inputTokens: 12,
    outputBytes: 128,
    outputTokens: 8,
    totalTokens: 20,
    wallTimeMs: 40,
  });
  assert.equal(run.result.resultRef.digest, resultRef.digest);
  assert.equal(run.approvals.approval_1.decision, "approved");
  assert.deepEqual(Object.keys(run.artifacts), ["artifact_1"]);
});

test("invocation/run v1 refuses skipped, wrong-attempt, canary, and post-terminal events", () => {
  const { records } = lifecycleRecords();

  const skipped = structuredClone(records);
  skipped[2].event.data = {
    ...skipped[2].event.data,
    attemptId: "at_1",
    attemptNumber: 1,
    from: "requested",
    leaseGeneration: 1,
    to: "running",
  };
  assert.throws(
    () => replayRecords(skipped),
    (error) => error.code === "INVOCATION_RUN_INVALID_TRANSITION",
  );

  const wrongAttempt = structuredClone(records);
  wrongAttempt[5].event.data = {
    ...wrongAttempt[5].event.data,
    attemptId: "at_wrong",
  };
  assert.throws(
    () => replayRecords(wrongAttempt),
    (error) => error.code === "INVOCATION_RUN_BINDING_MISMATCH",
  );

  const canary = structuredClone(records);
  canary[5].event.data = {
    ...canary[5].event.data,
    summary: "Bearer e3-t01-test-secret-123456789",
  };
  assert.throws(
    () => replayRecords(canary),
    (error) => error.code === "INVOCATION_RUN_SECRET_VALUE",
  );

  const postTerminal = structuredClone(records);
  const terminal = postTerminal.at(-1);
  postTerminal.push({
    offset: offset(15),
    event: eventEnvelope(
      "r",
      "run.activity.recorded",
      {
        ...commonRecord(15, terminal),
        kind: "late",
        summary: "late",
        contentRef: null,
      },
      sourceReference(
        `run:${RUN_ID}`,
        offset(14),
        digestEventEnvelope(terminal.event),
      ),
    ),
  });
  assert.throws(
    () => replayRecords(postTerminal),
    (error) => error.code === "INVOCATION_RUN_TERMINAL_IMMUTABLE",
  );
});

test("invocation correlation identity is deterministic and source-bound", () => {
  const { sourceTrigger } = lifecycleRecords();
  const input = {
    agentId: AGENT_ID,
    invocationId: INVOCATION_ID,
    sourceTrigger,
    workspaceId: WORKSPACE_ID,
  };
  assert.equal(deriveInvocationCorrelationId(input), correlationIdFor(input));
  assert.match(deriveInvocationCorrelationId(input), /^cr_[0-9a-f]{26}$/u);
});

function lifecycleRecords() {
  const sourceTrigger = sourceReference(
    CHANNEL_STREAM,
    offset(90),
    digest("1"),
  );
  const snapshotRef = sourceReference(SNAPSHOT_STREAM, offset(91), digest("2"));
  const policy = {
    allowApprovals: true,
    maxAttempts: 3,
    maxCostUsdCents: 100,
    maxInputTokens: 1000,
    maxOutputTokens: 1000,
    maxWallTimeMs: 10_000,
    version: 1,
  };
  const correlationId = deriveInvocationCorrelationId({
    agentId: AGENT_ID,
    invocationId: INVOCATION_ID,
    sourceTrigger,
    workspaceId: WORKSPACE_ID,
  });
  const invocationData = {
    agentId: AGENT_ID,
    correlationId,
    invocationId: INVOCATION_ID,
    policy,
    policyDigest: policyDigest(policy),
    schemaVersion: 1,
    snapshotDigest: digest("3"),
    snapshotRef,
    sourceTrigger,
    triggerType: "mention",
  };
  const invocation = eventEnvelope(
    "a",
    "workspace.invocation.requested",
    invocationData,
    sourceTrigger,
  );
  const invocationRecord = { event: invocation, offset: offset(1) };
  const invocationRef = sourceReference(
    "workspace:ws_aaaaaaaaaaaaaaaaaaaaaaaaaa/invocations",
    offset(1),
    digestEventEnvelope(invocation),
  );
  const binding = {
    agentId: AGENT_ID,
    correlationId,
    invocationRef,
    policy,
    policyDigest: policyDigest(policy),
    snapshotDigest: invocationData.snapshotDigest,
    snapshotRef,
    sourceTrigger,
  };
  const records = [invocationRecord];
  let previous = invocationRecord;
  const eventLetters = "abcdefghjkmnpqrstvwxyz";
  let eventIndex = 1;
  function append(data, eventType = "run.lifecycle.changed") {
    const causation =
      data.sourceRef ??
      sourceReference(
        `run:${RUN_ID}`,
        previous.offset,
        digestEventEnvelope(previous.event),
      );
    const eventData = {
      ...data,
      sourceRef: data.sourceRef ?? causation,
    };
    const record = {
      event: eventEnvelope(
        eventLetters[eventIndex],
        eventType,
        eventData,
        causation,
      ),
      offset: offset(records.length + 1),
    };
    records.push(record);
    previous = record;
    eventIndex += 1;
    return record;
  }
  const lifecycle = (
    sequence,
    from,
    to,
    attemptId = null,
    attemptNumber = null,
    leaseGeneration = null,
    terminal = null,
    extra = {},
  ) => ({
    attemptId,
    attemptNumber,
    binding: sequence === 1 ? binding : null,
    from,
    invocationId: INVOCATION_ID,
    leaseGeneration,
    runId: RUN_ID,
    schemaVersion: 1,
    sequence,
    sourceRef: sequence === 1 ? invocationRef : undefined,
    terminal,
    to,
    ...extra,
  });
  append(lifecycle(1, null, "requested"));
  append(lifecycle(2, "requested", "queued"));
  append(lifecycle(3, "queued", "leased", "at_1", 1, 1));
  append(lifecycle(4, "leased", "running", "at_1", 1, 1));
  append(
    {
      ...commonRecord(5, previous),
      kind: "progress",
      summary: "started",
      contentRef: null,
    },
    "run.activity.recorded",
  );
  append(
    {
      ...commonRecord(6, previous),
      costUsdCents: 7,
      inputTokens: 12,
      outputBytes: 128,
      outputTokens: 8,
      totalTokens: 20,
      wallTimeMs: 40,
    },
    "run.usage.recorded",
  );
  append(lifecycle(7, "running", "awaiting-approval", "at_1", 1, 1));
  append(
    {
      ...commonRecord(8, previous),
      action: "publish-result",
      approvalId: "approval_1",
      requestRef: sourceTrigger,
    },
    "run.approval.requested",
  );
  append(
    {
      ...commonRecord(9, previous),
      approvalId: "approval_1",
      decision: "approved",
    },
    "run.approval.decided",
  );
  append(lifecycle(10, "awaiting-approval", "running", "at_1", 1, 1));
  append(
    {
      ...commonRecord(11, previous),
      artifactId: "artifact_1",
      byteLength: 128,
      contentRef: sourceReference(RESULT_STREAM, offset(92), digest("4")),
      kind: "report",
      mediaType: "text/plain",
      name: "result.txt",
    },
    "run.artifact.recorded",
  );
  const resultRef = sourceReference(RESULT_STREAM, offset(93), digest("5"));
  append(
    {
      ...commonRecord(12, previous),
      resultRef,
      summary: "completed",
    },
    "run.result.recorded",
  );
  const resultRecord = records.at(-1);
  append(
    lifecycle(
      13,
      "running",
      "completed",
      "at_1",
      1,
      1,
      { kind: "completed", resultRef, failureCode: null, reasonCode: null },
      {
        sourceRef: sourceReference(
          `run:${RUN_ID}`,
          resultRecord.offset,
          digestEventEnvelope(resultRecord.event),
        ),
      },
    ),
  );
  return { records, resultRef, sourceTrigger };
}

function commonRecord(sequence, previous) {
  return {
    attemptId: "at_1",
    invocationId: INVOCATION_ID,
    runId: RUN_ID,
    schemaVersion: 1,
    sequence,
    sourceRef: sourceReference(
      `run:${RUN_ID}`,
      previous.offset,
      digestEventEnvelope(previous.event),
    ),
  };
}

function eventEnvelope(letter, eventType, data, causation) {
  return issueEventEnvelope(
    {
      actorId: ACTOR_ID,
      causation,
      correlationId:
        data.correlationId ??
        correlationIdFor({
          agentId: AGENT_ID,
          invocationId: INVOCATION_ID,
          sourceTrigger: sourceReference(
            CHANNEL_STREAM,
            offset(90),
            digest("1"),
          ),
          workspaceId: WORKSPACE_ID,
        }),
      data,
      eventType,
      idempotencyKey: `ik_${letter.repeat(26)}`,
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
    },
    {
      clock: () =>
        new Date(
          `2026-08-07T00:00:${String(letter.charCodeAt(0) - 96).padStart(2, "0")}.000Z`,
        ),
      eventId: `ev_${letter.repeat(26)}`,
    },
  );
}

function sourceReference(stream, sourceOffset, sourceDigest) {
  return { digest: sourceDigest, offset: sourceOffset, stream };
}

function offset(value) {
  return `${value.toString(10).padStart(16, "0")}_${"a".repeat(16)}`;
}

function digest(letter) {
  return `sha256:${letter.repeat(64)}`;
}
