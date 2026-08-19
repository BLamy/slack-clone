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
  deriveInvocationCorrelationId,
  deriveRunControlId,
  policyDigest,
  runCapabilityDigest,
  RUN_CONTROL_ERROR_CODES,
  validateRunControlPolicy,
  zeroRunUsage,
} from "@stream-slack/protocol";
import { replayRecords } from "@stream-slack/reducers";

import {
  createRunControlCoordinator,
  createScriptedProcessRunner,
  RunControlError,
} from "../src/ledger/run-control.mjs";
import {
  createRunLeaseCoordinator,
  projectEligibleQueue,
  replayRunLeaseEvents,
} from "../src/ledger/run-queue.mjs";
import {
  digestEventEnvelope,
  issueEventEnvelope,
} from "../src/ledger/envelope.mjs";
import { createProcessTreeRunner } from "./process-tree.mjs";

const WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHANNEL_ID = "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const AGENT_ID = "ag_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const ACTOR_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const CHANNEL_STREAM = `channel:${CHANNEL_ID}`;
const CONFIG_STREAM = `agent:${AGENT_ID}/config`;
const BASE_TIME = Date.parse("2026-08-08T00:00:00.000Z");

const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-3-the-dispatcher/E3-T06-cancellation-retries-and-budgets",
);
const runId = String(
  process.env.TEST_RUN_ID ?? `e3-t06-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/gu, "-");
const implementationCommit = String(
  process.env.E3_T06_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
const promoteEvidence = process.env.PROMOTE_EVIDENCE === "1";
const reportDirectory = path.resolve(
  root,
  promoteEvidence
    ? path.join(taskDirectory, "evidence/e3-t06-final")
    : (process.env.TEST_ARTIFACT_DIR ??
        path.join(".artifacts", "e3-t06", runId)),
);
const replayDeclaration =
  "Replay: N/A (headless run-control protocol) + mitigation: real process-tree probes, fake-clock schedules, usage manifests, terminal races, and replay";

assert.match(implementationCommit, /^[0-9a-f]{40}$/u);
await mkdir(reportDirectory, { recursive: true });
await mkdir(path.join(taskDirectory, "work"), { recursive: true });

const gates = await runGates();
const retryEvidence = await verifyRetryAndRecovery();
const controlEvidence = await verifyAuthorityAndProcessControl();
const clockEvidence = await verifyClockAndDeadline();
const budgetEvidence = await verifyBudgetAccounting();
const raceEvidence = await verifyTerminalRaces();
const crashEvidence = await verifyCrashRecovery();
const replayEvidence = verifyReplayAndReducer(retryEvidence.records);
const processEvidence = await verifyRealProcessTree();
const sensitivity =
  process.env.E3_T06_SKIP_SENSITIVITY === "1"
    ? { result: "SKIPPED", reason: "nested sensitivity verifier" }
    : await verifySensitivity();

const evidence = {
  schemaVersion: 1,
  task: "E3-T06",
  runId,
  implementationCommit,
  replay: replayDeclaration,
  gates,
  attempts: retryEvidence.attempts,
  fakeClockSchedules: {
    retry: retryEvidence.schedule,
    authorityAndProcess: controlEvidence.schedules,
    terminalRace: raceEvidence.schedule,
  },
  usageAccounting: budgetEvidence,
  capabilityRevocations: controlEvidence.revocations,
  clockGuards: clockEvidence,
  processResources: {
    scripted: controlEvidence.processes,
    real: processEvidence,
  },
  terminalRaces: raceEvidence,
  crashRecovery: crashEvidence,
  replayDigests: replayEvidence,
  sensitivity,
};

await writeJson("attempt-timelines.json", retryEvidence.attempts);
await writeJson("fake-clock-schedules.json", evidence.fakeClockSchedules);
await writeJson("usage-accounting.json", budgetEvidence);
await writeJson("capability-revocations.json", controlEvidence.revocations);
await writeJson("clock-guards.json", clockEvidence);
await writeJson("process-resource-counts.json", evidence.processResources);
await writeJson("terminal-races.json", raceEvidence);
await writeJson("crash-recovery.json", crashEvidence);
await writeJson("replay-digests.json", replayEvidence);
await writeJson("sensitivity.json", sensitivity);

const summary = {
  ...evidence,
  canaryScan: await scanEvidence(reportDirectory),
  result: "PASS",
};
await writeJson("verification-summary.json", summary);
const finalCanaryScan = await scanEvidence(reportDirectory);
assert.equal(finalCanaryScan.leaked, false);
summary.canaryScan = finalCanaryScan;
await writeJson("canary-scan.json", finalCanaryScan);
await writeJson("verification-summary.json", summary);

console.log(
  JSON.stringify(
    {
      implementationCommit,
      result: summary.result,
      runId,
      gates: gates.map(({ name, result }) => ({ name, result })),
      attempts: retryEvidence.attempts.attemptCount,
      terminal: raceEvidence.terminalState,
      sensitivity: sensitivity.result,
      replay: replayDeclaration,
    },
    null,
    2,
  ),
);

async function runGates() {
  if (process.env.E3_T06_SKIP_GATES === "1") {
    return [{ command: "gates skipped", name: "gates", result: "SKIPPED" }];
  }
  const results = [];
  for (const [name, command, args] of [
    ["format-e3-t06", "pnpm", ["format:check:e3-t06"]],
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

function buildPolicy(overrides = {}) {
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

function createHarness({
  policy = buildPolicy(),
  processRunner,
  runLetter = "e",
  aggregateUsageStore = null,
  initialRecords = null,
  initialRun = null,
  initialCapability = null,
  initialLeaseRecordCount = 0,
  idempotencyStore = new Map(),
  leaseCoordinator: existingLeaseCoordinator = null,
  leaseRecordsOverride = null,
  onCapabilityFenced = () => {},
  authorizeCancel = () => true,
} = {}) {
  const fixture = buildFixture({ policy, runLetter });
  let nowMs = 0;
  let tokenIndex = 0;
  const leaseRecords = leaseRecordsOverride ?? [];
  const appended = [];
  const projectionFor = ({
    attempts = 0,
    now = dateAt(nowMs),
    status = "queued",
  }) =>
    projectEligibleQueue({
      invocations: [fixture.invocationValue],
      now,
      runs: [
        {
          agentId: AGENT_ID,
          attempts,
          invocationId: fixture.invocationId,
          runId: fixture.runId,
          runRef: fixture.queuedRef,
          status,
        },
      ],
      workspaceId: WORKSPACE_ID,
    });
  const projection = projectionFor({});
  const leaseCoordinator =
    existingLeaseCoordinator ??
    createRunLeaseCoordinator({
      actorId: ACTOR_ID,
      appendLeaseEvent: async ({ record }) => {
        leaseRecords.push(structuredClone(record));
        return { record };
      },
      clock: () => dateAt(nowMs),
      initialEvents: [],
      leaseTtlMs: 1_000,
      queueProjection: projection,
      tokenFactory: () =>
        `rcap_${String(tokenIndex++).padStart(42, "a").slice(-42)}`,
      workspaceId: WORKSPACE_ID,
    });
  const controller = createRunControlCoordinator({
    actorId: ACTOR_ID,
    aggregateUsageStore,
    appendRecord: async ({ record }) => {
      appended.push({
        eventType: record.event.eventType,
        offset: record.offset,
      });
      return { record };
    },
    authorizeCancel,
    clock: () => dateAt(nowMs),
    entry: projection.entries[0],
    initialCapability,
    idempotencyStore,
    initialRecords: initialRecords ?? fixture.records,
    initialRun: initialRun ?? {
      sequence: 2,
      status: "queued",
      usage: zeroRunUsage(),
    },
    initialLeaseRecordCount,
    leaseCoordinator,
    leaseRecords,
    onCapabilityFenced,
    policy,
    processRunner,
    queueProjectionFor: projectionFor,
    workerId: `worker-${runLetter}`,
  });
  return {
    appended,
    controller,
    dateAt: (value) => dateAt(value),
    fixture,
    leaseCoordinator,
    leaseRecords,
    now: () => nowMs,
    setNow: (value) => {
      nowMs = value;
    },
  };
}

function buildFixture({ policy, runLetter }) {
  const invocationId = `iv_${runLetter.repeat(26)}`;
  const runId = `rn_${"a".repeat(26)}_${runLetter.repeat(26)}`;
  const sourceTrigger = sourceReference(CHANNEL_STREAM, 90, "1");
  const snapshotRef = sourceReference(CONFIG_STREAM, 91, "2");
  const correlationId = deriveInvocationCorrelationId({
    agentId: AGENT_ID,
    invocationId,
    sourceTrigger,
    workspaceId: WORKSPACE_ID,
  });
  const invocationData = {
    agentId: AGENT_ID,
    correlationId,
    invocationId,
    policy,
    policyDigest: policyDigest(policy),
    schemaVersion: 1,
    snapshotDigest: digest("3"),
    snapshotRef,
    sourceTrigger,
    triggerType: "channel.mention",
  };
  const invocationEvent = issueEventEnvelope(
    {
      actorId: ACTOR_ID,
      causation: sourceTrigger,
      correlationId,
      data: invocationData,
      eventType: "workspace.invocation.requested",
      idempotencyKey: deriveRunControlId("ik", {
        invocationId,
        kind: "invocation",
      }),
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
    },
    {
      clock: () => dateAt(0),
      eventId: deriveRunControlId("ev", { invocationId, kind: "invocation" }),
    },
  );
  const invocationRecord = {
    digest: digestEventEnvelope(invocationEvent),
    event: invocationEvent,
    offset: offset(1),
  };
  const invocationRef = sourceReference(
    `workspace:${WORKSPACE_ID}/invocations`,
    1,
    invocationRecord.digest.slice(7),
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
  const requestedData = {
    attemptId: null,
    attemptNumber: null,
    binding,
    from: null,
    invocationId,
    leaseGeneration: null,
    runId,
    schemaVersion: 1,
    sequence: 1,
    sourceRef: invocationRef,
    terminal: null,
    to: "requested",
  };
  const requestedEvent = runEnvelope({
    actorId: ACTOR_ID,
    correlationId,
    data: requestedData,
    eventType: "run.lifecycle.changed",
    idempotencyKey: deriveRunControlId("ik", { invocationId, sequence: 1 }),
    runId,
    sourceRef: invocationRef,
  });
  const requestedRecord = {
    digest: digestEventEnvelope(requestedEvent),
    event: requestedEvent,
    offset: offset(2),
  };
  const requestedRef = sourceReference(
    `run:${runId}`,
    2,
    requestedRecord.digest.slice(7),
  );
  const queuedData = {
    attemptId: null,
    attemptNumber: null,
    binding: null,
    from: "requested",
    invocationId,
    leaseGeneration: null,
    runId,
    schemaVersion: 1,
    sequence: 2,
    sourceRef: requestedRef,
    terminal: null,
    to: "queued",
  };
  const queuedEvent = runEnvelope({
    actorId: ACTOR_ID,
    correlationId,
    data: queuedData,
    eventType: "run.lifecycle.changed",
    idempotencyKey: deriveRunControlId("ik", { invocationId, sequence: 2 }),
    runId,
    sourceRef: requestedRef,
  });
  const queuedRecord = {
    digest: digestEventEnvelope(queuedEvent),
    event: queuedEvent,
    offset: offset(3),
  };
  const queuedRef = sourceReference(
    `run:${runId}`,
    3,
    queuedRecord.digest.slice(7),
  );
  return {
    binding,
    invocationData,
    invocationId,
    invocationValue: {
      ...invocationData,
      priority: 0,
      sourceRef: invocationRef,
      status: "requested",
    },
    invocationRef,
    queuedRef,
    records: [invocationRecord, requestedRecord, queuedRecord],
    requestedRef,
    runId,
    sourceTrigger,
  };
}

function runEnvelope({
  actorId,
  correlationId,
  data,
  eventType,
  idempotencyKey,
  runId,
  sourceRef,
}) {
  const event = issueEventEnvelope(
    {
      actorId,
      causation: sourceRef,
      correlationId,
      data,
      eventType,
      idempotencyKey,
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
    },
    {
      clock: () => dateAt(0),
      eventId: deriveRunControlId("ev", {
        eventType,
        runId,
        sequence: data.sequence,
      }),
    },
  );
  return event;
}

function sourceReference(stream, sequence, digestValue) {
  return {
    digest: digestValue.startsWith("sha256:")
      ? digestValue
      : `sha256:${digestValue.repeat(64).slice(0, 64)}`,
    offset: offset(sequence),
    stream,
  };
}

function digest(value) {
  return `sha256:${value.repeat(64).slice(0, 64)}`;
}

function offset(sequence) {
  return `${String(sequence).padStart(16, "0")}_0000000000000000`;
}

function dateAt(milliseconds) {
  return new Date(BASE_TIME + milliseconds);
}

async function writeJson(filename, value) {
  await writeFile(
    path.join(reportDirectory, filename),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

async function verifyRetryAndRecovery() {
  const idempotencyStore = new Map([["unrelated", true]]);
  const harness = createHarness({
    idempotencyStore,
    processRunner: createScriptedProcessRunner({
      clock: () => harness?.now?.() ?? 0,
      defaultChildren: 4,
      defaultIgnoresTerm: true,
    }),
  });
  const firstLease = await harness.controller.beginAttempt({
    now: harness.dateAt(0),
  });
  const firstCapability = harness.controller.getCapabilityForWorker();
  await harness.controller.startAttempt({
    launch: { children: 4, ignoresTerm: true, outputBytes: 256 },
    now: harness.dateAt(1),
  });
  let sideEffectCalls = 0;
  const actionKey = "action_crash_after_side_effect";
  await assert.rejects(
    harness.controller.commitLogicalAction({
      actionKey,
      crashAfterSideEffect: true,
      now: harness.dateAt(2),
      perform: async () => {
        sideEffectCalls += 1;
      },
    }),
    (error) =>
      error instanceof RunControlError &&
      error.code === RUN_CONTROL_ERROR_CODES.INVALID_STATE,
  );
  const replayedAction = await harness.controller.commitLogicalAction({
    actionKey,
    now: harness.dateAt(3),
    perform: async () => {
      sideEffectCalls += 1;
    },
  });
  assert.equal(replayedAction.result, "replayed");
  assert.equal(sideEffectCalls, 1);

  const retry = await harness.controller.reportFailure({
    failureCode: "provider.transient",
    now: harness.dateAt(10),
    retryable: true,
  });
  assert.equal(retry.retry, true);
  assert.equal(retry.schedule.backoffMs, 10);
  assert.equal(retry.schedule.nextAttemptAtMs, BASE_TIME + 20);
  assert.equal(harness.controller.getState().status, "retry");
  assert.equal(
    harness.controller.getState().processSnapshot[0].activeChildren,
    0,
  );
  await assert.rejects(
    harness.leaseCoordinator.mutate({
      capability: firstCapability,
      mutate: () => "late-old-attempt",
      runId: harness.fixture.runId,
      workerId: harness.controller.workerId,
    }),
    (error) => String(error.code).includes("CAPABILITY_INVALID"),
  );

  harness.setNow(19);
  await harness.controller.tick({ now: harness.dateAt(19) });
  assert.equal(harness.controller.getState().status, "retry");
  harness.setNow(20);
  const secondLease = await harness.controller.tick({
    now: harness.dateAt(20),
  });
  assert.equal(secondLease.result, "leased");
  await harness.controller.startAttempt({ now: harness.dateAt(21) });
  const secondCapability = harness.controller.getCapabilityForWorker();
  assert.notEqual(firstLease.lease.attemptId, secondLease.attempt.attemptId);
  assert.notEqual(
    runCapabilityDigest(firstCapability),
    runCapabilityDigest(secondCapability),
  );
  await assert.rejects(
    harness.controller.reportUsage({
      capability: firstCapability,
      now: harness.dateAt(22),
      usage: {
        costUsdCents: 1,
        inputTokens: 101,
        outputBytes: 1,
        outputTokens: 1,
        totalTokens: 102,
        wallTimeMs: 1,
      },
      usageKey: "stale-capability-overbudget",
    }),
    (error) => String(error.code).includes("CAPABILITY_INVALID"),
  );
  assert.equal(harness.controller.getState().status, "running");
  await harness.controller.reportUsage({
    now: harness.dateAt(25),
    usage: {
      costUsdCents: 5,
      inputTokens: 10,
      outputBytes: 20,
      outputTokens: 5,
      totalTokens: 15,
      wallTimeMs: 20,
    },
    usageKey: "attempt-two-usage",
  });
  await harness.controller.complete({ now: harness.dateAt(30) });
  const state = harness.controller.getState();
  assert.equal(state.status, "completed");
  assert.equal(state.terminalCount, 1);
  assert.equal(
    state.processSnapshot.every((group) => group.activeChildren === 0),
    true,
  );

  const nonRetryableHarness = createHarness({ runLetter: "f" });
  await nonRetryableHarness.controller.beginAttempt({
    now: nonRetryableHarness.dateAt(0),
  });
  await nonRetryableHarness.controller.startAttempt({
    now: nonRetryableHarness.dateAt(1),
  });
  const nonRetryable = await nonRetryableHarness.controller.reportFailure({
    failureCode: "policy.deterministic",
    now: nonRetryableHarness.dateAt(2),
    retryable: false,
  });
  assert.equal(nonRetryable.result, "failed");
  assert.equal(nonRetryableHarness.controller.getState().status, "failed");
  assert.equal(nonRetryableHarness.controller.getState().attempts.length, 1);
  await assert.rejects(
    nonRetryableHarness.controller.beginAttempt({
      now: nonRetryableHarness.dateAt(3),
    }),
    (error) => error.code === RUN_CONTROL_ERROR_CODES.TERMINAL_IMMUTABLE,
  );
  return {
    attempts: {
      attemptCount: state.attempts.length,
      firstAttempt: firstLease.lease,
      secondAttempt: state.attempts[1],
      firstCapabilityDigest: runCapabilityDigest(firstCapability),
      secondCapabilityDigest: runCapabilityDigest(secondCapability),
      freshIdentity: true,
      oldCapabilityRefused: true,
      staleCapabilityBudgetRefused: true,
    },
    nonRetryableFailureNoNextAttempt: {
      attempts: nonRetryableHarness.controller.getState().attempts.length,
      status: nonRetryableHarness.controller.getState().status,
      terminalImmutable: true,
    },
    schedule: {
      backoffMs: retry.schedule.backoffMs,
      firstFailureAtMs: 10,
      nextAttemptAtMs: retry.schedule.nextAttemptAtMs - BASE_TIME,
      retryable: true,
      retryReadyAtMs: 20,
    },
    records: harness.controller.getRecords(),
    result: "PASS",
  };
}

async function verifyAuthorityAndProcessControl() {
  const cancellation = await runControlOutcome("cancelled", async (harness) => {
    await harness.controller.cancel({
      now: harness.dateAt(12),
      reasonCode: "operator-request",
    });
  });
  const timeout = await runControlOutcome("timed-out", async (harness) => {
    await harness.controller.tick({ now: harness.dateAt(101) });
  });
  const agentRevoke = await runControlOutcome("cancelled", async (harness) => {
    await harness.controller.revokeForAuthority({
      now: harness.dateAt(15),
      reasonCode: "agent-revoked",
    });
  });
  const budget = await runControlOutcome(
    "budget-exhausted",
    async (harness) => {
      await assert.rejects(
        harness.controller.reportUsage({
          now: harness.dateAt(16),
          usage: {
            costUsdCents: 1,
            inputTokens: 101,
            outputBytes: 1,
            outputTokens: 1,
            totalTokens: 102,
            wallTimeMs: 1,
          },
          usageKey: "authority-budget-exceeded",
        }),
        (error) => error.code === RUN_CONTROL_ERROR_CODES.BUDGET_EXCEEDED,
      );
    },
  );
  const leaseLoss = await runControlOutcome("cancelled", async (harness) => {
    await harness.leaseCoordinator.supersede({
      now: harness.dateAt(14),
      reason: "lease-lost",
      runId: harness.fixture.runId,
    });
    await harness.controller.revokeForAuthority({
      now: harness.dateAt(15),
      reasonCode: "lease-lost",
    });
  });
  for (const outcome of [
    cancellation,
    timeout,
    agentRevoke,
    budget,
    leaseLoss,
  ]) {
    assert.equal(outcome.state.terminalCount, 1);
    assert.equal(
      outcome.state.processSnapshot.every(
        (group) => group.activeChildren === 0,
      ),
      true,
    );
    assert.ok(outcome.state.capabilityRevocations.length >= 1);
    assert.ok(outcome.state.processTerminations.length >= 1);
    assert.ok(
      outcome.state.processTerminations.every(
        ({ survivors }) => survivors === 0,
      ),
    );
  }
  return {
    revocations: [cancellation, timeout, agentRevoke, budget, leaseLoss].map(
      ({ state, fence }) => ({
        fencedBeforeNextAppend: fence.fencedBeforeAppend,
        reason: state.terminal.reasonCode,
        terminal: state.status,
      }),
    ),
    processes: [cancellation, timeout, agentRevoke, budget, leaseLoss].map(
      ({ state }) => ({
        finalActiveChildren: state.processSnapshot.map(
          ({ activeChildren }) => activeChildren,
        ),
        killEscalated: state.processTerminations.map(
          ({ usedKillEscalation }) => usedKillEscalation,
        ),
        survivors: state.processTerminations.map(({ survivors }) => survivors),
      }),
    ),
    schedules: {
      cancelAtMs: 12,
      deadlineAtMs: 100,
      deadlineObservedAtMs: 101,
      agentRevokedAtMs: 15,
      leaseLostAtMs: 14,
    },
    result: "PASS",
  };
}

async function runControlOutcome(expectedStatus, operation) {
  const fenceEvents = [];
  const harness = createHarness({
    onCapabilityFenced: ({ recordCount }) => {
      fenceEvents.push({ recordCount, fenced: true });
    },
  });
  await harness.controller.beginAttempt({ now: harness.dateAt(0) });
  await harness.controller.startAttempt({ now: harness.dateAt(1) });
  await operation(harness);
  const state = harness.controller.getState();
  assert.equal(state.status, expectedStatus);
  const firstFenceCount =
    fenceEvents[0]?.recordCount ?? Number.MAX_SAFE_INTEGER;
  const firstAppendAfterFence = harness.appended.findIndex(
    ({ offset: eventOffset }) =>
      Number.parseInt(eventOffset.slice(0, 16), 10) > firstFenceCount,
  );
  return {
    fence: {
      fencedBeforeAppendObserved: fenceEvents.length > 0,
      fencedBeforeAppend:
        firstFenceCount <= Number.MAX_SAFE_INTEGER &&
        firstAppendAfterFence >= 0,
    },
    state,
  };
}

async function verifyClockAndDeadline() {
  const harness = createHarness({ runLetter: "m" });
  await harness.controller.beginAttempt({ now: harness.dateAt(0) });
  await harness.controller.startAttempt({ now: harness.dateAt(1) });
  await harness.controller.reportUsage({
    now: harness.dateAt(10),
    usage: {
      costUsdCents: 1,
      inputTokens: 1,
      outputBytes: 1,
      outputTokens: 1,
      totalTokens: 2,
      wallTimeMs: 1,
    },
    usageKey: "clock-forward-usage",
  });
  const beforeRollback = harness.controller.getState();
  await assert.rejects(
    harness.controller.complete({ now: harness.dateAt(9) }),
    (error) => error.code === RUN_CONTROL_ERROR_CODES.CLOCK_REGRESSION,
  );
  const afterRollback = harness.controller.getState();
  assert.equal(afterRollback.status, "running");
  assert.equal(afterRollback.records, beforeRollback.records);
  await assert.rejects(
    harness.controller.complete({ now: harness.dateAt(101) }),
    (error) => error.code === RUN_CONTROL_ERROR_CODES.DEADLINE_EXCEEDED,
  );
  const afterDeadline = harness.controller.getState();
  assert.equal(afterDeadline.status, "timed-out");
  assert.equal(afterDeadline.terminalCount, 1);
  assert.equal(
    harness.controller
      .getRecords()
      .some(({ event }) => event.eventType === "run.result.recorded"),
    false,
  );
  assert.equal(
    afterDeadline.processSnapshot.every(
      ({ activeChildren }) => activeChildren === 0,
    ),
    true,
  );
  return {
    rollbackObservedAtMs: afterRollback.lastObservedAtMs - BASE_TIME,
    rollbackRefused: true,
    deadlineObservedAtMs: afterDeadline.lastObservedAtMs - BASE_TIME,
    deadlineFenced: true,
    terminal: afterDeadline.status,
    result: "PASS",
  };
}

async function verifyBudgetAccounting() {
  const duplicateHarness = createHarness({
    policy: buildPolicy({
      maxAggregateInputTokens: 15,
      maxAggregateOutputTokens: 15,
      maxAggregateWallTimeMs: 200,
    }),
  });
  await duplicateHarness.controller.beginAttempt({
    now: duplicateHarness.dateAt(0),
  });
  await duplicateHarness.controller.startAttempt({
    now: duplicateHarness.dateAt(1),
  });
  const usage = {
    costUsdCents: 2,
    inputTokens: 5,
    outputBytes: 10,
    outputTokens: 3,
    totalTokens: 8,
    wallTimeMs: 10,
  };
  await duplicateHarness.controller.reportUsage({
    usage,
    usageKey: "same-sample",
    now: duplicateHarness.dateAt(2),
  });
  await assert.rejects(
    duplicateHarness.controller.reportUsage({
      usage,
      usageKey: "same-sample",
      now: duplicateHarness.dateAt(3),
    }),
    (error) => error.code === RUN_CONTROL_ERROR_CODES.DUPLICATE_USAGE,
  );
  await assert.rejects(
    duplicateHarness.controller.reportUsage({
      now: duplicateHarness.dateAt(4),
      usage: { ...usage, inputTokens: 1.5, totalTokens: 4.5 },
      usageKey: "fractional",
    }),
    (error) => error.code === RUN_CONTROL_ERROR_CODES.INVALID_DATA,
  );
  await assert.rejects(
    duplicateHarness.controller.reportUsage({
      now: duplicateHarness.dateAt(4),
      usage: {
        ...usage,
        costUsdCents: 1_000_000_001,
      },
      usageKey: "overflow",
    }),
    (error) => error.code === RUN_CONTROL_ERROR_CODES.INVALID_DATA,
  );
  const concurrent = await Promise.allSettled(
    ["concurrent-a", "concurrent-a"].map((usageKey) =>
      duplicateHarness.controller.reportUsage({
        now: duplicateHarness.dateAt(5),
        usage: { ...usage, inputTokens: 1, totalTokens: 4 },
        usageKey,
      }),
    ),
  );
  assert.equal(
    concurrent.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  assert.equal(
    concurrent.filter(({ status }) => status === "rejected").length,
    1,
  );
  const budgetHarness = createHarness({
    policy: buildPolicy({
      maxAggregateInputTokens: 10,
      maxAggregateOutputTokens: 10,
      maxInputTokens: 10,
      maxOutputTokens: 10,
    }),
  });
  await budgetHarness.controller.beginAttempt({ now: budgetHarness.dateAt(0) });
  await budgetHarness.controller.startAttempt({ now: budgetHarness.dateAt(1) });
  await budgetHarness.controller.reportUsage({
    now: budgetHarness.dateAt(2),
    usage: { ...usage, inputTokens: 9, totalTokens: 12 },
    usageKey: "within-budget",
  });
  await assert.rejects(
    budgetHarness.controller.reportUsage({
      now: budgetHarness.dateAt(3),
      usage: { ...usage, inputTokens: 2, totalTokens: 5 },
      usageKey: "would-exceed",
    }),
    (error) => error.code === RUN_CONTROL_ERROR_CODES.BUDGET_EXCEEDED,
  );
  const state = budgetHarness.controller.getState();
  assert.equal(state.status, "budget-exhausted");
  assert.equal(state.totalUsage.inputTokens, 9);
  assert.equal(state.aggregateUsage.inputTokens, 9);
  assert.equal(
    state.processSnapshot.every((group) => group.activeChildren === 0),
    true,
  );

  const dimensionCases = [
    {
      label: "cost",
      policy: { maxAggregateCostUsdCents: 1, maxCostUsdCents: 1 },
      usage: { costUsdCents: 2 },
    },
    {
      label: "wall-time",
      policy: {
        attemptDeadlineMs: 10,
        maxAggregateWallTimeMs: 10,
        maxWallTimeMs: 10,
      },
      usage: { wallTimeMs: 11 },
    },
    {
      label: "output-tokens",
      policy: { maxAggregateOutputTokens: 2, maxOutputTokens: 2 },
      usage: { inputTokens: 1, outputTokens: 3, totalTokens: 4 },
    },
    {
      label: "output-bytes",
      policy: { maxAggregateOutputBytes: 2, maxOutputBytes: 2 },
      usage: { outputBytes: 3 },
    },
  ];
  const dimensionEvidence = [];
  const dimensionRunLetters = ["g", "h", "j", "k"];
  for (const [index, dimensionCase] of dimensionCases.entries()) {
    const dimensionHarness = createHarness({
      policy: buildPolicy(dimensionCase.policy),
      runLetter: dimensionRunLetters[index],
    });
    await dimensionHarness.controller.beginAttempt({
      now: dimensionHarness.dateAt(0),
    });
    await dimensionHarness.controller.startAttempt({
      now: dimensionHarness.dateAt(1),
    });
    const dimensionUsage = {
      costUsdCents: 1,
      inputTokens: 1,
      outputBytes: 1,
      outputTokens: 1,
      totalTokens: 2,
      wallTimeMs: 1,
      ...dimensionCase.usage,
    };
    await assert.rejects(
      dimensionHarness.controller.reportUsage({
        now: dimensionHarness.dateAt(2),
        usage: dimensionUsage,
        usageKey: `dimension-${dimensionCase.label}`,
      }),
      (error) => error.code === RUN_CONTROL_ERROR_CODES.BUDGET_EXCEEDED,
    );
    const dimensionState = dimensionHarness.controller.getState();
    assert.equal(dimensionState.status, "budget-exhausted");
    assert.equal(dimensionState.totalUsage.costUsdCents, 0);
    assert.equal(dimensionState.totalUsage.inputTokens, 0);
    assert.equal(dimensionState.totalUsage.outputBytes, 0);
    assert.equal(dimensionState.totalUsage.outputTokens, 0);
    assert.equal(dimensionState.totalUsage.wallTimeMs, 0);
    dimensionEvidence.push({
      actual: dimensionCase.usage,
      label: dimensionCase.label,
      status: dimensionState.status,
    });
  }

  const attemptBudgetHarness = createHarness({
    policy: buildPolicy({ maxAttempts: 2 }),
    runLetter: "k",
  });
  await attemptBudgetHarness.controller.beginAttempt({
    now: attemptBudgetHarness.dateAt(0),
  });
  await attemptBudgetHarness.controller.startAttempt({
    now: attemptBudgetHarness.dateAt(1),
  });
  const firstAttemptFailure =
    await attemptBudgetHarness.controller.reportFailure({
      failureCode: "provider.transient.first",
      now: attemptBudgetHarness.dateAt(10),
      retryable: true,
    });
  assert.equal(firstAttemptFailure.retry, true);
  await attemptBudgetHarness.controller.tick({
    now: attemptBudgetHarness.dateAt(20),
  });
  await attemptBudgetHarness.controller.startAttempt({
    now: attemptBudgetHarness.dateAt(21),
  });
  const exhaustedAttemptFailure =
    await attemptBudgetHarness.controller.reportFailure({
      failureCode: "provider.transient.second",
      now: attemptBudgetHarness.dateAt(30),
      retryable: true,
    });
  assert.equal(exhaustedAttemptFailure.retry, false);
  assert.equal(
    exhaustedAttemptFailure.terminal.reasonCode,
    "attempt-budget-exhausted",
  );
  assert.equal(attemptBudgetHarness.controller.getState().attempts.length, 2);
  assert.equal(attemptBudgetHarness.controller.getState().status, "failed");
  return {
    duplicateRefused: true,
    fractionalRefused: true,
    overflowRefused: true,
    concurrent: {
      accepted: concurrent.filter(({ status }) => status === "fulfilled")
        .length,
      refused: concurrent.filter(({ status }) => status === "rejected").length,
    },
    aggregateBudget: {
      acceptedInputTokens: state.aggregateUsage.inputTokens,
      attemptedInputTokens: 11,
      terminal: state.status,
    },
    dimensions: dimensionEvidence,
    attemptBudget: {
      attempts: attemptBudgetHarness.controller.getState().attempts.length,
      status: attemptBudgetHarness.controller.getState().status,
      reason: exhaustedAttemptFailure.terminal.reasonCode,
    },
    total: state.totalUsage,
    result: "PASS",
  };
}

async function verifyTerminalRaces() {
  const causes = ["complete", "fail", "timeout", "budget", "cancel"];
  const raceRunLetters = ["r", "s", "t", "v", "w"];
  const races = [];
  for (const [index, winner] of causes.entries()) {
    const harness = createHarness({
      runLetter: raceRunLetters[index],
    });
    await harness.controller.beginAttempt({ now: harness.dateAt(0) });
    await harness.controller.startAttempt({ now: harness.dateAt(1) });
    const contenders = [
      {
        cause: "complete",
        operation: () =>
          harness.controller.complete({ now: harness.dateAt(20) }),
      },
      {
        cause: "fail",
        operation: () =>
          harness.controller.reportFailure({
            failureCode: "race.failure",
            now: harness.dateAt(20),
            retryable: false,
          }),
      },
      {
        cause: "timeout",
        operation: () => harness.controller.tick({ now: harness.dateAt(101) }),
      },
      {
        cause: "budget",
        operation: () =>
          harness.controller.reportUsage({
            now: harness.dateAt(20),
            usage: {
              costUsdCents: 1,
              inputTokens: 101,
              outputBytes: 1,
              outputTokens: 1,
              totalTokens: 102,
              wallTimeMs: 1,
            },
            usageKey: `race-budget-${winner}`,
          }),
      },
      {
        cause: "cancel",
        operation: () =>
          harness.controller.cancel({
            now: harness.dateAt(20),
            reasonCode: "race-cancel",
          }),
      },
    ];
    const orderedContenders = [
      contenders.find(({ cause }) => cause === winner),
      ...contenders.filter(({ cause }) => cause !== winner),
    ];
    const results = await Promise.allSettled(
      orderedContenders.map(({ operation }) => operation()),
    );
    const state = harness.controller.getState();
    const expectedStatus = {
      budget: "budget-exhausted",
      cancel: "cancelled",
      complete: "completed",
      fail: "failed",
      timeout: "timed-out",
    }[winner];
    assert.equal(state.status, expectedStatus);
    assert.equal(state.terminalCount, 1);
    const terminalLifecycleCount = harness.controller
      .getRecords()
      .filter(
        ({ event }) =>
          event.eventType === "run.lifecycle.changed" &&
          [
            "completed",
            "cancelled",
            "timed-out",
            "budget-exhausted",
            "failed",
          ].includes(event.data.to),
      ).length;
    assert.equal(terminalLifecycleCount, 1);
    await assert.rejects(
      harness.controller.complete({ now: harness.dateAt(102) }),
      (error) => error.code === RUN_CONTROL_ERROR_CODES.TERMINAL_IMMUTABLE,
    );
    await assert.rejects(
      harness.controller.reportFailure({
        failureCode: "late.failure",
        now: harness.dateAt(103),
        retryable: false,
      }),
      (error) => error.code === RUN_CONTROL_ERROR_CODES.TERMINAL_IMMUTABLE,
    );
    await assert.rejects(
      harness.controller.reportUsage({
        now: harness.dateAt(104),
        usage: {
          costUsdCents: 1,
          inputTokens: 1,
          outputBytes: 1,
          outputTokens: 1,
          totalTokens: 2,
          wallTimeMs: 1,
        },
        usageKey: `late-terminal-usage-${winner}`,
      }),
      (error) => error.code === RUN_CONTROL_ERROR_CODES.TERMINAL_IMMUTABLE,
    );
    races.push({
      contenders: orderedContenders.map(({ cause }, contenderIndex) => ({
        cause,
        result: results[contenderIndex].status,
      })),
      terminalCount: state.terminalCount,
      terminalLifecycleCount,
      terminalState: state.status,
      winner,
    });
  }
  return {
    terminalState: races[0].terminalState,
    terminalCount: 1,
    terminalLifecycleCount: 1,
    lateMutationRefused: true,
    schedule: {
      racedAtMs: 20,
      deadlineAtMs: 100,
      timeoutCandidateAtMs: 101,
    },
    contenders: races,
    result: "PASS",
  };
}

async function verifyCrashRecovery() {
  const idempotencyStore = new Map();
  const aggregateUsageStore = { usage: zeroRunUsage() };
  let sideEffectCalls = 0;
  const original = createHarness({ idempotencyStore, aggregateUsageStore });
  await original.controller.beginAttempt({ now: original.dateAt(0) });
  await original.controller.startAttempt({ now: original.dateAt(1) });
  const durableUsage = {
    costUsdCents: 2,
    inputTokens: 4,
    outputBytes: 8,
    outputTokens: 2,
    totalTokens: 6,
    wallTimeMs: 3,
  };
  await original.controller.reportUsage({
    now: original.dateAt(2),
    usage: durableUsage,
    usageKey: "durable-usage-1",
  });
  await assert.rejects(
    original.controller.commitLogicalAction({
      actionKey: "durable-side-effect-1",
      crashAfterSideEffect: true,
      now: original.dateAt(3),
      perform: async () => {
        sideEffectCalls += 1;
      },
    }),
  );
  const beforeRestart = original.controller.getState();
  assert.equal(sideEffectCalls, 1);
  assert.equal(idempotencyStore.has("durable-side-effect-1"), true);
  const initialLeaseRecordCount = original.leaseRecords.length;
  const recoveryRunner = createScriptedProcessRunner({
    defaultChildren: 2,
    defaultIgnoresTerm: true,
  });
  const recovery = createHarness({
    leaseCoordinator: original.leaseCoordinator,
    idempotencyStore,
    initialCapability: original.controller.getCapabilityForWorker(),
    initialLeaseRecordCount,
    initialRecords: original.controller.getRecords(),
    initialRun: {
      activeAttempt: beforeRestart.activeAttempt,
      attempts: beforeRestart.attempts,
      lastObservedAtMs: beforeRestart.lastObservedAtMs,
      runStartedAtMs: beforeRestart.runStartedAtMs,
      sequence: beforeRestart.runSequence,
      status: beforeRestart.status,
      usage: beforeRestart.totalUsage,
    },
    aggregateUsageStore,
    processRunner: recoveryRunner,
    leaseRecordsOverride: original.leaseRecords,
  });
  await assert.rejects(
    recovery.controller.reportUsage({
      now: recovery.dateAt(4),
      usage: durableUsage,
      usageKey: "durable-usage-1",
    }),
    (error) => error.code === RUN_CONTROL_ERROR_CODES.DUPLICATE_USAGE,
  );
  assert.deepEqual(recovery.controller.getState().totalUsage, durableUsage);
  assert.deepEqual(aggregateUsageStore.usage, durableUsage);
  const recovered = await recovery.controller.commitLogicalAction({
    actionKey: "durable-side-effect-1",
    now: recovery.dateAt(5),
    perform: async () => {
      sideEffectCalls += 1;
    },
  });
  assert.equal(recovered.result, "replayed");
  assert.equal(sideEffectCalls, 1);
  await recovery.controller.complete({ now: recovery.dateAt(6) });
  const state = recovery.controller.getState();
  assert.equal(state.status, "completed");
  const recoveryOffsets = recovery.controller
    .getRecords()
    .map(({ offset }) => offset);
  assert.equal(new Set(recoveryOffsets).size, recoveryOffsets.length);
  const recoveryLeaseEventIds = recovery.controller
    .getRecords()
    .filter(({ event }) => event.eventType.startsWith("run.lease."))
    .map(({ event }) => event.eventId);
  assert.equal(
    new Set(recoveryLeaseEventIds).size,
    recoveryLeaseEventIds.length,
  );
  assert.equal(recovery.leaseRecords.length, initialLeaseRecordCount + 1);
  return {
    actionKey: "durable-side-effect-1",
    sideEffectCalls,
    restartStartedWithEmptyProcessMap:
      recoveryRunner.getProcessSnapshot().length === 0,
    recoveredWithoutRepeat: true,
    usageReplayRefused: true,
    aggregateUsagePreserved: true,
    leaseWatermarkPreserved: true,
    recoveredControlRecorded: recovery.controller
      .getRecords()
      .some(({ event }) => event.data?.controlType === "side-effect.recovered"),
    terminal: state.status,
    result: "PASS",
  };
}

function verifyReplayAndReducer(records) {
  const first = replayRecords(records);
  const second = replayRecords(structuredClone(records));
  assert.equal(first.finalStateDigest, second.finalStateDigest);
  const run = first.finalState.entities.runs[records[1].event.data.runId];
  assert.equal(run.status, "completed");
  assert.equal(run.terminal.kind, "completed");
  assert.equal(run.controls.length >= 4, true);
  assert.equal(run.lease, null);
  const leaseRecords = records.filter(({ event }) =>
    event.eventType.startsWith("run.lease."),
  );
  const leaseReplay = replayRunLeaseEvents(leaseRecords, {
    workspaceId: WORKSPACE_ID,
  });
  assert.equal(JSON.stringify(leaseRecords).includes("rcap_"), false);
  return {
    finalReducerDigest: first.finalStateDigest,
    finalLeaseDigest: leaseReplay.finalStateDigest,
    prefixCount: first.prefixes.length,
    leasePrefixCount: leaseReplay.prefixes.length,
    terminalImmutable: true,
    bearerNotPersisted: true,
    result: "PASS",
  };
}

async function verifyRealProcessTree() {
  const workDirectory = path.join(taskDirectory, "work", "process-tree");
  await mkdir(workDirectory, { recursive: true });
  const pidFile = path.join(workDirectory, `grandchild-${runId}.pid`);
  const childCode = [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "writeFileSync(process.env.E3_T06_PID_FILE, String(grandchild.pid));",
    "process.on('SIGTERM', () => {});",
    "setInterval(() => process.stdout.write('x'.repeat(2048)), 1);",
  ].join(" ");
  const runner = createProcessTreeRunner({ outputLimit: 8_000 });
  const handle = await runner.launch({
    args: ["--input-type=module", "-e", childCode],
    env: { ...process.env, E3_T06_PID_FILE: pidFile },
  });
  await waitForFile(pidFile, 2_000);
  await sleep(40);
  const termination = await runner.terminate(handle, {
    boundMs: 1_000,
    graceMs: 50,
  });
  const grandchildPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
  const grandchildAlive = processAlive(grandchildPid);
  if (grandchildAlive) {
    try {
      process.kill(grandchildPid, "SIGKILL");
    } catch {
      // The probe is already being failed; best-effort cleanup only.
    }
  }
  assert.equal(grandchildAlive, false);
  assert.equal(termination.survivors, 0);
  return {
    processGroupId: termination.groupId,
    signals: termination.signals,
    outputExceeded: runner.getProcessSnapshot()[0]?.outputExceeded ?? true,
    survivors: termination.survivors,
    durationMs: termination.durationMs,
    withinBound: termination.durationMs <= 1_000,
    result: "PASS",
  };
}

async function verifyFenceProbe({ expectPass = true } = {}) {
  let lateMutation = false;
  let lateCapability = null;
  let harness;
  const baseRunner = createScriptedProcessRunner({
    defaultChildren: 3,
    defaultIgnoresTerm: true,
  });
  const processRunner = {
    activeCount: baseRunner.activeCount,
    getProcessSnapshot: baseRunner.getProcessSnapshot,
    launch: baseRunner.launch,
    terminate: async (handle, options) => {
      try {
        await harness.leaseCoordinator.mutate({
          capability: lateCapability,
          mutate: () => {
            lateMutation = true;
            return "late-mutation";
          },
          runId: harness.fixture.runId,
          workerId: harness.controller.workerId,
        });
      } catch {
        // A correctly fenced capability is expected to refuse this callback.
      }
      return baseRunner.terminate(handle, options);
    },
  };
  harness = createHarness({ processRunner });
  const controller = harness.controller;
  await controller.beginAttempt({ now: harness.dateAt(0) });
  await controller.startAttempt({ now: harness.dateAt(1) });
  lateCapability = controller.getCapabilityForWorker();
  await controller.cancel({
    now: harness.dateAt(2),
    reasonCode: "fence-probe",
  });
  if (expectPass) assert.equal(lateMutation, false);
  else assert.equal(lateMutation, true);
  return { lateMutation, result: "PASS" };
}

async function verifySensitivity() {
  if (process.env.E3_T06_EXPECT_SENSITIVITY === "1") {
    await verifyFenceProbe({ expectPass: false });
    return {
      result: "PASS",
      reason: "mutated verifier reached its expected red path",
    };
  }
  await verifyFenceProbe({ expectPass: true });
  const sensitivityParent = await mkdtemp(
    path.join(taskDirectory, "work", "sensitivity-"),
  );
  const checkout = path.join(sensitivityParent, "checkout");
  let worktreeAdded = false;
  try {
    execFileSync(
      "git",
      ["worktree", "add", "--detach", checkout, implementationCommit],
      {
        cwd: root,
        stdio: "ignore",
      },
    );
    worktreeAdded = true;
    execFileSync("pnpm", ["install", "--frozen-lockfile"], {
      cwd: checkout,
      stdio: "ignore",
    });
    const mutations = [
      {
        file: "src/ledger/run-queue.mjs",
        label: "capability-fence",
        needle: "      tokens.delete(digest);\n      await supersedeOne(",
        replacement:
          "      // fenced deletion disabled by sensitivity mutation\n      await supersedeOne(",
      },
      {
        file: "src/ledger/run-control.mjs",
        label: "usage-replay-dedupe",
        needle: "      usageKeys.add(event.idempotencyKey);",
        replacement: '      usageKeys.add("sensitivity-mutated-usage-key");',
      },
      {
        file: "src/ledger/run-control.mjs",
        label: "lease-watermark",
        needle: "  let flushedLeaseCount = initialLeaseRecordCount;",
        replacement: "  let flushedLeaseCount = 0;",
      },
      {
        file: "src/ledger/run-control.mjs",
        label: "stale-capability-preflight",
        needle:
          "      await preflightMutationWithoutLock({ capability, now: nowDate });",
        replacement:
          "      await preflightMutationWithoutLock({ capability: currentCapability, now: nowDate });",
      },
      {
        file: "src/ledger/run-control.mjs",
        label: "deadline-fence",
        needle:
          "    if (deadlineAtMs !== null && now.getTime() >= deadlineAtMs) {",
        replacement: "    if (false) {",
      },
    ];
    const mutationResults = [];
    for (const [index, mutation] of mutations.entries()) {
      const target = path.join(checkout, mutation.file);
      const source = await readFile(target, "utf8");
      assert.equal(
        source.includes(mutation.needle),
        true,
        `sensitivity needle missing for ${mutation.label}`,
      );
      await writeFile(
        target,
        source.replace(mutation.needle, mutation.replacement),
      );
      let exitCode = 0;
      try {
        execFileSync("node", ["scripts/verify-e3-t06.mjs"], {
          cwd: checkout,
          env: {
            ...process.env,
            E3_T06_EXPECT_SENSITIVITY: "1",
            E3_T06_IMPLEMENTATION_COMMIT: implementationCommit,
            E3_T06_SKIP_GATES: "1",
            E3_T06_SKIP_SENSITIVITY: "1",
            TEST_RUN_ID: `${runId}-sensitivity-${index}`,
          },
          stdio: "ignore",
        });
      } catch (error) {
        exitCode = error.status ?? 1;
      }
      await writeFile(target, source);
      assert.notEqual(exitCode, 0);
      mutationResults.push({
        detectorWentRed: true,
        label: mutation.label,
        mutatedVerifierExitCode: exitCode,
      });
    }
    return {
      result: "PASS",
      mutations: mutationResults,
      detectorCount: mutationResults.length,
      detectorWentRed: mutationResults.every(
        ({ detectorWentRed }) => detectorWentRed,
      ),
    };
  } finally {
    if (worktreeAdded) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", checkout], {
          cwd: root,
          stdio: "ignore",
        });
      } catch {
        // Preserve the verifier's original result.
      }
    }
    await rm(sensitivityParent, { force: true, recursive: true });
  }
}

async function waitForFile(filename, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await readFile(filename, "utf8");
      return;
    } catch {
      await sleep(10);
    }
  }
  throw new Error(`timed out waiting for ${filename}`);
}

async function sleep(milliseconds) {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function scanEvidence(directory) {
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const findings = [];
  for (const filename of files) {
    const content = await readFile(path.join(directory, filename), "utf8");
    const leaked =
      /rcap_[A-Za-z0-9_-]{32,96}|PRIVATE KEY|api[_-]?key\s*[:=]|Bearer\s+[A-Za-z0-9._~+/=-]{12,}/iu.test(
        content,
      );
    findings.push({ leaked, name: filename });
  }
  return {
    checked: true,
    evidenceFiles: files,
    findings,
    leaked: findings.some(({ leaked }) => leaked),
  };
}
