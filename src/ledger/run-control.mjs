import {
  addRunUsage,
  allowedRunTransition,
  deriveRunControlId,
  planRunRetry,
  RUN_CONTROL_ERROR_CODES,
  TERMINAL_RUN_STATES_V1,
  validateRunControlPolicy,
  validateRunLifecycleData,
  validateRunRecordData,
  validateUsage,
  usageBudgetViolations,
  zeroRunUsage,
} from "@stream-slack/protocol";

import { canonicalSha256 } from "./canonical-json.mjs";
import { digestEventEnvelope, issueEventEnvelope } from "./envelope.mjs";
import { streamNames } from "./topology.mjs";
import { createScriptedProcessRunner } from "./process-tree-scripted.mjs";

const RUN_EVENT_SCHEMA_VERSION = 1;
const OFFSET_PATTERN = /^\d{16}_[0-9a-f]{16}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export class RunControlError extends Error {
  constructor(code, detail, context = {}) {
    super(`${code}: ${detail}`);
    this.name = "RunControlError";
    this.code = code;
    this.detail = detail;
    Object.assign(this, context);
  }

  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      name: this.name,
      runId: this.runId ?? null,
      attemptId: this.attemptId ?? null,
    };
  }
}

/**
 * Durable run control adapter. Run facts are emitted as ordinary invocation,
 * lifecycle, usage, control, result, failure, and lease events. The injected
 * appendRecord callback is the Durable Streams boundary; no bearer capability
 * is ever copied into a record.
 */
export function createRunControlCoordinator({
  actorId,
  aggregateUsage = zeroRunUsage(),
  aggregateUsageStore = null,
  appendRecord = async ({ record }) => ({ record }),
  authorizeCancel = () => true,
  clock = () => new Date(),
  entry,
  initialCapability = null,
  initialLeaseRecordCount = 0,
  initialRecords = [],
  initialRun = {},
  idempotencyStore = new Map(),
  leaseCoordinator,
  leaseRecords = [],
  onCapabilityFenced = () => {},
  policy,
  processRunner = createScriptedProcessRunner(),
  queueProjectionFor,
  workerId = "run-control-worker",
} = {}) {
  assertCoordinatorInputs({
    actorId,
    appendRecord,
    clock,
    entry,
    leaseCoordinator,
    onCapabilityFenced,
    policy,
    processRunner,
    queueProjectionFor,
    workerId,
  });
  validateRunControlPolicy(policy);
  validateUsage(aggregateUsage, "$.aggregateUsage");
  if (
    !Number.isSafeInteger(initialLeaseRecordCount) ||
    initialLeaseRecordCount < 0 ||
    initialLeaseRecordCount > leaseRecords.length
  ) {
    throw new TypeError(
      "initialLeaseRecordCount must be within the supplied lease record range",
    );
  }
  if (
    initialRun.lastObservedAtMs !== undefined &&
    initialRun.lastObservedAtMs !== null &&
    (!Number.isSafeInteger(initialRun.lastObservedAtMs) ||
      initialRun.lastObservedAtMs < 0)
  ) {
    throw new TypeError("initialRun.lastObservedAtMs must be a timestamp");
  }
  if (
    !idempotencyStore ||
    typeof idempotencyStore.has !== "function" ||
    typeof idempotencyStore.set !== "function"
  ) {
    throw new TypeError("idempotencyStore must provide has and set");
  }

  const records = structuredClone(initialRecords);
  let flushedLeaseCount = initialLeaseRecordCount;
  let runSequence = initialRun.sequence ?? inferRunSequence(records);
  let status = initialRun.status ?? "queued";
  let terminal = initialRun.terminal ?? null;
  let attempts = structuredClone(initialRun.attempts ?? []);
  let activeAttempt = structuredClone(initialRun.activeAttempt ?? null);
  let totalUsage = structuredClone(initialRun.usage ?? zeroRunUsage());
  let aggregateTotals = structuredClone(
    aggregateUsageStore?.usage ?? aggregateUsage,
  );
  let retrySchedule = structuredClone(initialRun.retrySchedule ?? null);
  let currentCapability = initialCapability;
  let processHandle = null;
  let runStartedAtMs = initialRun.runStartedAtMs ?? null;
  let lastObservedAtMs = initialRun.lastObservedAtMs ?? null;
  let deadlineAtMs = initialRun.deadlineAtMs ?? null;
  let terminalCount = terminal ? 1 : 0;
  let serial = Promise.resolve();
  const controlIds = new Set();
  const usageKeys = new Set();
  const capabilityRevocations = [];
  const attemptTimelines = [];
  const processTerminations = [];

  for (const record of records) indexDurableRecord(record);

  function withLock(operation) {
    const next = serial.then(operation, operation);
    serial = next.catch(() => {});
    return next;
  }

  async function beginAttempt({ now = clock() } = {}) {
    return withLock(async () => {
      if (terminal) {
        throw controlError(
          RUN_CONTROL_ERROR_CODES.TERMINAL_IMMUTABLE,
          "terminal run cannot acquire another attempt",
        );
      }
      const nowDate = observeNow(now);
      const nowMs = nowDate.getTime();
      if (status === "retry") {
        if (!retrySchedule || nowMs < retrySchedule.nextAttemptAtMs) {
          throw controlError(
            RUN_CONTROL_ERROR_CODES.INVALID_STATE,
            "retry backoff has not elapsed",
          );
        }
        await appendLifecycleWithoutLock({
          from: "retry",
          now: nowDate,
          to: "queued",
        });
        retrySchedule = null;
      }
      if (status !== "queued") {
        throw controlError(
          RUN_CONTROL_ERROR_CODES.INVALID_STATE,
          "only queued runs may acquire an attempt",
        );
      }
      const projection = queueProjectionFor({
        attempts: attempts.length,
        now: nowDate,
        status: "queued",
      });
      leaseCoordinator.rebuild(projection);
      const currentEntry = projection.entries.find(
        ({ runId }) => runId === entry.runId,
      );
      if (!currentEntry) {
        throw controlError(
          RUN_CONTROL_ERROR_CODES.INVALID_STATE,
          "run is not eligible in the rebuilt queue",
        );
      }
      const acquired = await leaseCoordinator.acquire({
        entry: currentEntry,
        now: new Date(nowMs),
        queueProof: projection.proof,
        workerId,
      });
      currentCapability = acquired.capability;
      activeAttempt = {
        attemptId: acquired.lease.attemptId,
        attemptNumber: acquired.lease.attemptNumber,
        leaseGeneration: acquired.lease.leaseGeneration,
        status: "leased",
      };
      attempts.push(structuredClone(activeAttempt));
      await appendLifecycleWithoutLock({
        from: "queued",
        now: new Date(nowMs),
        to: "leased",
      });
      await flushLeaseEventsWithoutLock();
      attemptTimelines.push({
        attemptId: activeAttempt.attemptId,
        attemptNumber: activeAttempt.attemptNumber,
        atMs: nowMs,
        event: "leased",
        leaseGeneration: activeAttempt.leaseGeneration,
      });
      return {
        attempt: structuredClone(activeAttempt),
        lease: acquired.lease,
        result: "leased",
      };
    });
  }

  async function startAttempt({ now = clock(), launch = {} } = {}) {
    return withLock(async () => {
      assertActiveAttempt("startAttempt", ["leased"]);
      const nowDate = observeNow(now);
      const nowMs = nowDate.getTime();
      await leaseCoordinator.mutate({
        capability: currentCapability,
        runId: entry.runId,
        workerId,
        mutate: async () => {
          await appendLifecycleWithoutLock({
            from: "leased",
            now: nowDate,
            to: "running",
          });
          activeAttempt.status = "running";
          if (runStartedAtMs === null) runStartedAtMs = nowMs;
          deadlineAtMs = Math.min(
            nowMs + policy.attemptDeadlineMs,
            runStartedAtMs + policy.maxWallTimeMs,
          );
          processHandle = await processRunner.launch(launch);
          await appendControlWithoutLock({
            actionKey: null,
            controlType: "attempt.deadline.set",
            detail: "deadline-frozen",
            dueAtMs: deadlineAtMs,
            now: nowDate,
          });
          attemptTimelines.push({
            attemptId: activeAttempt.attemptId,
            attemptNumber: activeAttempt.attemptNumber,
            atMs: nowMs,
            deadlineAtMs,
            event: "running",
            leaseGeneration: activeAttempt.leaseGeneration,
          });
          return { deadlineAtMs, result: "running" };
        },
      });
      return {
        attempt: structuredClone(activeAttempt),
        deadlineAtMs,
        result: "running",
      };
    });
  }

  async function reportUsage({
    capability = currentCapability,
    now = clock(),
    usage,
    usageKey = null,
  } = {}) {
    return withLock(async () => {
      assertActiveAttempt("reportUsage", ["running", "awaiting-approval"]);
      const nowDate = observeNow(now);
      await preflightMutationWithoutLock({ capability, now: nowDate });
      validateUsage(usage);
      const normalizedKey =
        usageKey ??
        deriveRunControlId("use", {
          attemptId: activeAttempt.attemptId,
          usage,
        });
      const usageIdempotencyKey = deriveRunControlId("ik", {
        attemptId: activeAttempt.attemptId,
        kind: "usage",
        usageKey: normalizedKey,
      });
      if (usageKeys.has(usageIdempotencyKey)) {
        throw controlError(
          RUN_CONTROL_ERROR_CODES.DUPLICATE_USAGE,
          "usage key was already durably accounted",
        );
      }
      const nextTotal = addRunUsage(totalUsage, usage);
      const nextAggregate = addRunUsage(aggregateTotals, usage);
      const violations = [
        ...usageBudgetViolations(nextTotal, policy),
        ...usageBudgetViolations(nextAggregate, policy, { aggregate: true }),
      ];
      if (violations.length > 0) {
        await finalizeWithoutLock({
          reasonCode: "budget-exhausted",
          terminalKind: "budget-exhausted",
          now: nowDate,
        });
        throw controlError(
          RUN_CONTROL_ERROR_CODES.BUDGET_EXCEEDED,
          "usage would exceed the immutable run or aggregate budget",
        );
      }
      const result = await leaseCoordinator.mutate({
        capability,
        endpoint: "run.events.write",
        now: nowDate,
        runId: entry.runId,
        workerId,
        mutate: async () => {
          await appendRunRecordWithoutLock({
            data: {
              costUsdCents: usage.costUsdCents,
              inputTokens: usage.inputTokens,
              outputBytes: usage.outputBytes,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens,
              wallTimeMs: usage.wallTimeMs,
            },
            eventType: "run.usage.recorded",
            idempotencyKey: usageIdempotencyKey,
            now: nowDate,
          });
          totalUsage = nextTotal;
          aggregateTotals = nextAggregate;
          if (aggregateUsageStore) {
            aggregateUsageStore.usage = structuredClone(aggregateTotals);
          }
          usageKeys.add(usageIdempotencyKey);
          return { usage: structuredClone(usage), usageKey: normalizedKey };
        },
      });
      return { ...result.result, result: "accounted" };
    });
  }

  async function reportFailure({
    capability = currentCapability,
    failureCode,
    now = clock(),
    retryable,
  } = {}) {
    return withLock(async () => {
      assertActiveAttempt("reportFailure", ["running", "awaiting-approval"]);
      const nowDate = observeNow(now);
      await preflightMutationWithoutLock({ capability, now: nowDate });
      const plan = planRunRetry({
        attemptNumber: activeAttempt.attemptNumber,
        failureCode,
        nowMs: nowDate.getTime(),
        policy,
        retryable,
      });
      await leaseCoordinator.mutate({
        capability,
        now: nowDate,
        runId: entry.runId,
        workerId,
        mutate: () =>
          appendRunRecordWithoutLock({
            data: {
              detailRef: null,
              failureCode,
              retryable,
            },
            eventType: "run.failure.recorded",
            idempotencyKey: deriveRunControlId("ik", {
              attemptId: activeAttempt.attemptId,
              failureCode,
              kind: "failure",
            }),
            now: nowDate,
          }),
      });
      if (plan.retry) {
        await appendControlWithoutLock({
          actionKey: null,
          controlType: "retry.scheduled",
          detail: plan.reason,
          dueAtMs: plan.nextAttemptAtMs,
          now: nowDate,
        });
        await revokeAndTerminateWithoutLock({ now: nowDate });
        await appendLifecycleWithoutLock({
          from: status,
          now: nowDate,
          to: "retry",
        });
        retrySchedule = plan;
        return {
          retry: true,
          schedule: structuredClone(plan),
          result: "retry",
        };
      }
      const terminalKind =
        plan.reason === "attempt-budget-exhausted" ? "failed" : "failed";
      await revokeAndTerminateWithoutLock({ now: nowDate });
      await appendLifecycleWithoutLock({
        from: status,
        now: nowDate,
        terminal: {
          failureCode,
          kind: terminalKind,
          reasonCode: plan.reason,
          resultRef: null,
        },
        to: terminalKind,
      });
      return {
        retry: false,
        result: "failed",
        terminal: structuredClone(terminal),
      };
    });
  }

  async function complete({
    capability = currentCapability,
    now = clock(),
    resultRef = entry.runRef,
    summary = null,
  } = {}) {
    return withLock(async () => {
      assertActiveAttempt("complete", ["running", "awaiting-approval"]);
      const nowDate = observeNow(now);
      await preflightMutationWithoutLock({ capability, now: nowDate });
      await leaseCoordinator.mutate({
        capability,
        now: nowDate,
        runId: entry.runId,
        workerId,
        mutate: () =>
          appendRunRecordWithoutLock({
            data: { resultRef, summary },
            eventType: "run.result.recorded",
            idempotencyKey: deriveRunControlId("ik", {
              attemptId: activeAttempt.attemptId,
              kind: "result",
            }),
            now: nowDate,
          }),
      });
      await revokeAndTerminateWithoutLock({ now: nowDate });
      await appendLifecycleWithoutLock({
        from: status,
        now: nowDate,
        terminal: {
          failureCode: null,
          kind: "completed",
          reasonCode: null,
          resultRef,
        },
        to: "completed",
      });
      return { result: "completed", terminal: structuredClone(terminal) };
    });
  }

  async function cancel({
    actor = actorId,
    now = clock(),
    reasonCode = "cancelled",
  } = {}) {
    return withLock(async () => {
      if (!(await authorizeCancel({ actor, entry, runId: entry.runId }))) {
        throw controlError(
          RUN_CONTROL_ERROR_CODES.CAPABILITY_REQUIRED,
          "cancel actor is not authorized",
        );
      }
      if (terminal)
        return {
          result: "already-terminal",
          terminal: structuredClone(terminal),
        };
      const nowDate = observeNow(now);
      if (
        !["queued", "retry", "running", "awaiting-approval", "leased"].includes(
          status,
        )
      ) {
        throw controlError(
          RUN_CONTROL_ERROR_CODES.INVALID_STATE,
          "run cannot be cancelled from its current state",
        );
      }
      if (
        status === "running" ||
        status === "awaiting-approval" ||
        status === "leased"
      ) {
        await revokeAndTerminateWithoutLock({ now: nowDate });
      }
      await appendLifecycleWithoutLock({
        from: status,
        now: nowDate,
        terminal: {
          failureCode: null,
          kind: "cancelled",
          reasonCode,
          resultRef: null,
        },
        to: "cancelled",
      });
      return { result: "cancelled", terminal: structuredClone(terminal) };
    });
  }

  async function tick({ now = clock() } = {}) {
    return withLock(async () => {
      if (terminal) return getState();
      const nowDate = observeNow(now);
      const nowMs = nowDate.getTime();
      if (
        status === "retry" &&
        retrySchedule &&
        nowMs >= retrySchedule.nextAttemptAtMs
      ) {
        return beginAttemptWithoutLock({ now: nowDate });
      }
      if (
        (status === "running" || status === "awaiting-approval") &&
        deadlineAtMs !== null &&
        nowMs >= deadlineAtMs
      ) {
        await finalizeWithoutLock({
          now: nowDate,
          reasonCode: "attempt-deadline",
          terminalKind: "timed-out",
        });
      }
      return getState();
    });
  }

  async function revokeForAuthority({
    now = clock(),
    reasonCode = "authority-revoked",
  } = {}) {
    return withLock(async () => {
      if (terminal)
        return {
          result: "already-terminal",
          terminal: structuredClone(terminal),
        };
      const nowDate = observeNow(now);
      if (status === "queued" || status === "retry") {
        await appendLifecycleWithoutLock({
          from: status,
          now: nowDate,
          terminal: {
            failureCode: null,
            kind: "cancelled",
            reasonCode,
            resultRef: null,
          },
          to: "cancelled",
        });
      } else {
        await finalizeWithoutLock({
          now: nowDate,
          reasonCode,
          terminalKind: "cancelled",
        });
      }
      return { result: "cancelled", terminal: structuredClone(terminal) };
    });
  }

  async function commitLogicalAction({
    actionKey,
    capability = currentCapability,
    crashAfterSideEffect = false,
    now = clock(),
    perform,
  } = {}) {
    return withLock(async () => {
      assertActiveAttempt("commitLogicalAction", [
        "running",
        "awaiting-approval",
      ]);
      const nowDate = observeNow(now);
      await preflightMutationWithoutLock({ capability, now: nowDate });
      if (typeof perform !== "function")
        throw new TypeError("logical action perform must be a function");
      if (idempotencyStore.has(actionKey)) {
        if (!controlIds.has(controlIdForAction(actionKey))) {
          await leaseCoordinator.mutate({
            capability,
            now: nowDate,
            runId: entry.runId,
            workerId,
            mutate: () =>
              appendControlWithoutLock({
                actionKey,
                controlType: "side-effect.recovered",
                detail: "idempotent-recovery",
                dueAtMs: null,
                now: nowDate,
              }),
          });
        }
        return { actionKey, performed: false, result: "replayed" };
      }
      return (
        await leaseCoordinator.mutate({
          capability,
          now: nowDate,
          runId: entry.runId,
          workerId,
          mutate: async () => {
            await perform({ actionKey });
            idempotencyStore.set(actionKey, true);
            if (crashAfterSideEffect) {
              throw controlError(
                RUN_CONTROL_ERROR_CODES.INVALID_STATE,
                "simulated crash after side effect before acknowledgement",
              );
            }
            await appendControlWithoutLock({
              actionKey,
              controlType: "side-effect.committed",
              detail: "idempotent-commit",
              dueAtMs: null,
              now: nowDate,
            });
            return { actionKey, performed: true, result: "committed" };
          },
        })
      ).result;
    });
  }

  async function beginAttemptWithoutLock({ now }) {
    const nowMs = normalizeDate(now).getTime();
    if (status === "retry") {
      await appendLifecycleWithoutLock({
        from: "retry",
        now: new Date(nowMs),
        to: "queued",
      });
      retrySchedule = null;
    }
    if (status !== "queued") return getState();
    const projection = queueProjectionFor({
      attempts: attempts.length,
      now: new Date(nowMs),
      status: "queued",
    });
    leaseCoordinator.rebuild(projection);
    const currentEntry = projection.entries.find(
      ({ runId }) => runId === entry.runId,
    );
    if (!currentEntry)
      throw controlError(
        RUN_CONTROL_ERROR_CODES.INVALID_STATE,
        "run is not eligible in the rebuilt queue",
      );
    const acquired = await leaseCoordinator.acquire({
      entry: currentEntry,
      now: new Date(nowMs),
      queueProof: projection.proof,
      workerId,
    });
    currentCapability = acquired.capability;
    activeAttempt = {
      attemptId: acquired.lease.attemptId,
      attemptNumber: acquired.lease.attemptNumber,
      leaseGeneration: acquired.lease.leaseGeneration,
      status: "leased",
    };
    attempts.push(structuredClone(activeAttempt));
    await appendLifecycleWithoutLock({
      from: "queued",
      now: new Date(nowMs),
      to: "leased",
    });
    await flushLeaseEventsWithoutLock();
    attemptTimelines.push({
      attemptId: activeAttempt.attemptId,
      attemptNumber: activeAttempt.attemptNumber,
      atMs: nowMs,
      event: "leased",
      leaseGeneration: activeAttempt.leaseGeneration,
    });
    return {
      attempt: structuredClone(activeAttempt),
      lease: acquired.lease,
      result: "leased",
    };
  }

  async function appendLifecycleWithoutLock({
    from = status,
    now,
    terminal: terminalData = null,
    to,
  }) {
    if (terminal && !TERMINAL_RUN_STATES_V1.includes(to)) {
      throw controlError(
        RUN_CONTROL_ERROR_CODES.TERMINAL_IMMUTABLE,
        "terminal run cannot transition again",
      );
    }
    if (status !== from || !allowedRunTransition(from, to)) {
      throw controlError(
        RUN_CONTROL_ERROR_CODES.INVALID_TRANSITION,
        `run cannot transition from ${String(status)} to ${to}`,
      );
    }
    const needsAttempt = !(
      (to === "cancelled" && from === "queued") ||
      (to === "cancelled" && from === "retry") ||
      to === "queued"
    );
    const attempt = needsAttempt ? activeAttempt : null;
    const data = {
      attemptId: attempt?.attemptId ?? null,
      attemptNumber: attempt?.attemptNumber ?? null,
      binding: null,
      from,
      invocationId: entry.invocationId,
      leaseGeneration: attempt?.leaseGeneration ?? null,
      runId: entry.runId,
      schemaVersion: RUN_EVENT_SCHEMA_VERSION,
      sequence: runSequence + 1,
      sourceRef: entry.runRef,
      terminal: terminalData,
      to,
    };
    validateRunLifecycleData(data, {
      expectedCorrelationId: entry.correlationId,
      expectedWorkspaceId: entry.workspaceId,
    });
    await appendEnvelopeWithoutLock({
      data,
      eventType: "run.lifecycle.changed",
      idempotencyKey: deriveRunControlId("ik", {
        from,
        kind: "lifecycle",
        runId: entry.runId,
        sequence: data.sequence,
        to,
      }),
      now,
    });
    runSequence = data.sequence;
    status = to;
    if (to === "leased") {
      activeAttempt.status = "leased";
    } else if (to === "running") {
      activeAttempt.status = "running";
    } else if (to === "retry") {
      activeAttempt.status = "retry";
    } else if (to === "queued") {
      if (activeAttempt) activeAttempt.status = "queued";
      activeAttempt = null;
    } else if (TERMINAL_RUN_STATES_V1.includes(to)) {
      if (activeAttempt) activeAttempt.status = to;
      terminal = structuredClone(terminalData);
      terminalCount += 1;
      activeAttempt = null;
    }
    return data;
  }

  async function appendRunRecordWithoutLock({
    data: partialData,
    eventType,
    idempotencyKey,
    now,
  }) {
    const data = {
      attemptId: activeAttempt?.attemptId,
      invocationId: entry.invocationId,
      runId: entry.runId,
      schemaVersion: RUN_EVENT_SCHEMA_VERSION,
      sequence: runSequence + 1,
      sourceRef: entry.runRef,
      ...partialData,
    };
    validateRunRecordData(eventType, data, {
      expectedWorkspaceId: entry.workspaceId,
    });
    await appendEnvelopeWithoutLock({ data, eventType, idempotencyKey, now });
    runSequence = data.sequence;
    return data;
  }

  async function appendControlWithoutLock({
    actionKey,
    controlType,
    detail,
    dueAtMs,
    now,
  }) {
    const controlId =
      actionKey === null
        ? deriveRunControlId("ctl", {
            controlType,
            dueAtMs,
            runId: entry.runId,
            sequence: runSequence + 1,
          })
        : controlIdForAction(actionKey);
    if (controlIds.has(controlId)) return { controlId, result: "duplicate" };
    const data = await appendRunRecordWithoutLock({
      data: { actionKey, controlId, controlType, detail, dueAtMs },
      eventType: "run.control.recorded",
      idempotencyKey: deriveRunControlId("ik", { controlId, kind: "control" }),
      now,
    });
    controlIds.add(controlId);
    return { controlId, data, result: "recorded" };
  }

  async function appendEnvelopeWithoutLock({
    data,
    eventType,
    idempotencyKey,
    now,
  }) {
    const normalizedNow = normalizeDate(now);
    const eventInput = {
      actorId,
      causation: data.sourceRef,
      correlationId: entry.correlationId,
      data,
      eventType,
      idempotencyKey,
      schemaVersion: 1,
      workspaceId: entry.workspaceId,
    };
    const event = issueEventEnvelope(eventInput, {
      clock: () => normalizedNow,
      eventId: deriveRunControlId("ev", {
        eventType,
        idempotencyKey,
        runId: entry.runId,
        sequence: data.sequence,
      }),
    });
    const record = {
      digest: digestEventEnvelope(event),
      event,
      offset: nextOffset(records.length + 1),
    };
    await appendRecord({
      event,
      eventDigest: record.digest,
      record,
      stream: streamNames.run(entry.workspaceId, entry.runId),
      workspaceId: entry.workspaceId,
    });
    records.push(record);
    return record;
  }

  async function flushLeaseEventsWithoutLock() {
    while (flushedLeaseCount < leaseRecords.length) {
      const source = leaseRecords[flushedLeaseCount];
      const record = {
        ...structuredClone(source),
        offset: nextOffset(records.length + 1),
      };
      await appendRecord({
        event: record.event,
        eventDigest: record.digest,
        record,
        stream: streamNames.run(entry.workspaceId, entry.runId),
        workspaceId: entry.workspaceId,
      });
      records.push(record);
      flushedLeaseCount += 1;
    }
  }

  async function preflightMutationWithoutLock({ capability, now }) {
    await leaseCoordinator.mutate({
      capability,
      endpoint: "run.events.write",
      now,
      runId: entry.runId,
      workerId,
      mutate: () => null,
    });
    if (deadlineAtMs !== null && now.getTime() >= deadlineAtMs) {
      await finalizeWithoutLock({
        now,
        reasonCode: "attempt-deadline",
        terminalKind: "timed-out",
      });
      throw controlError(
        RUN_CONTROL_ERROR_CODES.DEADLINE_EXCEEDED,
        "run attempt deadline has elapsed",
      );
    }
  }

  async function revokeAndTerminateWithoutLock({ now }) {
    if (currentCapability) {
      const capability = currentCapability;
      currentCapability = null;
      capabilityRevocations.push({
        attemptId: activeAttempt?.attemptId ?? null,
        atMs: normalizeDate(now).getTime(),
        reason: "run-control",
      });
      onCapabilityFenced({
        attemptId: activeAttempt?.attemptId ?? null,
        recordCount: records.length,
      });
      try {
        await leaseCoordinator.revoke({
          capability,
          now,
          reason: "run-control",
          runId: entry.runId,
          workerId,
        });
      } catch (error) {
        if (!String(error?.code ?? "").includes("CAPABILITY_INVALID"))
          throw error;
      }
      await flushLeaseEventsWithoutLock();
    }
    if (processHandle) {
      const termination = await processRunner.terminate(processHandle, {
        boundMs: policy.terminationGraceMs + 1_000,
        graceMs: policy.terminationGraceMs,
        nowMs: normalizeDate(now).getTime(),
      });
      processTerminations.push({
        attemptId: activeAttempt?.attemptId ?? null,
        ...termination,
      });
      await appendControlWithoutLock({
        actionKey: null,
        controlType: "process.terminated",
        detail: termination.usedKillEscalation
          ? "group-kill"
          : "graceful-group-exit",
        dueAtMs: null,
        now,
      });
      processHandle = null;
    }
  }

  async function finalizeWithoutLock({ now, reasonCode, terminalKind }) {
    if (terminal)
      return {
        result: "already-terminal",
        terminal: structuredClone(terminal),
      };
    if (!TERMINAL_RUN_STATES_V1.includes(terminalKind)) {
      throw controlError(
        RUN_CONTROL_ERROR_CODES.INVALID_STATE,
        "invalid terminal kind",
      );
    }
    if (status === "queued" || status === "retry") {
      await appendLifecycleWithoutLock({
        from: status,
        now,
        terminal: {
          failureCode: null,
          kind: terminalKind,
          reasonCode,
          resultRef: null,
        },
        to: terminalKind,
      });
      return { result: terminalKind, terminal: structuredClone(terminal) };
    }
    await revokeAndTerminateWithoutLock({ now });
    await appendLifecycleWithoutLock({
      from: status,
      now,
      terminal: {
        failureCode: null,
        kind: terminalKind,
        reasonCode,
        resultRef: null,
      },
      to: terminalKind,
    });
    return { result: terminalKind, terminal: structuredClone(terminal) };
  }

  function assertActiveAttempt(operation, allowedStatuses) {
    if (
      terminal ||
      !activeAttempt ||
      !allowedStatuses.includes(status) ||
      !currentCapability
    ) {
      throw controlError(
        terminal
          ? RUN_CONTROL_ERROR_CODES.TERMINAL_IMMUTABLE
          : RUN_CONTROL_ERROR_CODES.CAPABILITY_REQUIRED,
        `${operation} requires an active, capability-bound attempt`,
      );
    }
  }

  function getState() {
    return structuredClone({
      activeAttempt,
      aggregateUsage: aggregateTotals,
      attemptTimelines,
      attempts,
      capabilityRevocations,
      deadlineAtMs,
      lastObservedAtMs,
      processTerminations,
      processSnapshot: processRunner.getProcessSnapshot(),
      records: records.length,
      replayDigest: canonicalSha256(records),
      retrySchedule,
      runSequence,
      status,
      terminal,
      terminalCount,
      totalUsage,
    });
  }

  return Object.freeze({
    beginAttempt,
    cancel,
    commitLogicalAction,
    complete,
    getRecords: () => structuredClone(records),
    getCapabilityForWorker: () => currentCapability,
    getState,
    reportFailure,
    reportUsage,
    revokeForAuthority,
    startAttempt,
    tick,
    workerId,
  });

  function indexDurableRecord(record) {
    const event = record?.event ?? record?.envelope ?? record;
    if (!event) return;
    if (event.eventType === "run.control.recorded") {
      controlIds.add(event.data.controlId);
      if (event.data.actionKey) {
        if (event.data.controlType === "side-effect.committed") {
          idempotencyStore.set(event.data.actionKey, true);
        }
      }
    }
    if (event.eventType === "run.usage.recorded") {
      usageKeys.add(event.idempotencyKey);
    }
  }

  function observeNow(value) {
    const date = normalizeDate(value);
    const nowMs = date.getTime();
    if (lastObservedAtMs !== null && nowMs < lastObservedAtMs) {
      throw controlError(
        RUN_CONTROL_ERROR_CODES.CLOCK_REGRESSION,
        "run-control timestamps must not move backwards",
      );
    }
    lastObservedAtMs = nowMs;
    return date;
  }
}

export { createScriptedProcessRunner } from "./process-tree-scripted.mjs";

function assertCoordinatorInputs({
  actorId,
  appendRecord,
  clock,
  entry,
  leaseCoordinator,
  onCapabilityFenced,
  policy,
  processRunner,
  queueProjectionFor,
  workerId,
}) {
  if (typeof actorId !== "string" || !actorId.startsWith("pr_"))
    throw new TypeError("run controller actorId is required");
  if (typeof appendRecord !== "function")
    throw new TypeError("run controller appendRecord must be a function");
  if (typeof clock !== "function")
    throw new TypeError("run controller clock must be a function");
  if (!entry || typeof entry !== "object")
    throw new TypeError("run controller queue entry is required");
  for (const field of [
    "agentId",
    "correlationId",
    "invocationId",
    "runId",
    "runRef",
    "workspaceId",
  ]) {
    if (!entry[field])
      throw new TypeError(`run controller entry.${field} is required`);
  }
  if (
    !leaseCoordinator ||
    typeof leaseCoordinator.acquire !== "function" ||
    typeof leaseCoordinator.revoke !== "function"
  ) {
    throw new TypeError("run controller lease coordinator is incomplete");
  }
  if (typeof onCapabilityFenced !== "function")
    throw new TypeError("run controller onCapabilityFenced must be a function");
  if (!policy || typeof policy !== "object")
    throw new TypeError("run controller policy is required");
  if (
    !processRunner ||
    typeof processRunner.launch !== "function" ||
    typeof processRunner.terminate !== "function"
  ) {
    throw new TypeError("run controller process runner is incomplete");
  }
  if (typeof processRunner.getProcessSnapshot !== "function")
    throw new TypeError(
      "run controller process runner must expose getProcessSnapshot",
    );
  if (typeof queueProjectionFor !== "function")
    throw new TypeError("run controller queueProjectionFor must be a function");
  if (typeof workerId !== "string" || workerId.length === 0)
    throw new TypeError("run controller workerId is required");
}

function controlIdForAction(actionKey) {
  return deriveRunControlId("ctl", { actionKey, kind: "side-effect" });
}

function controlError(code, detail) {
  return new RunControlError(code, detail);
}

function inferRunSequence(records) {
  return records.reduce((sequence, record) => {
    const data = record?.event?.data;
    return Number.isSafeInteger(data?.sequence)
      ? Math.max(sequence, data.sequence)
      : sequence;
  }, 0);
}

function nextOffset(sequence) {
  const offset = `${String(sequence).padStart(16, "0")}_0000000000000000`;
  if (!OFFSET_PATTERN.test(offset))
    throw new Error("run control offset overflow");
  return offset;
}

function normalizeDate(value) {
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new TypeError("run control clock returned an invalid date");
  if (!TIMESTAMP_PATTERN.test(date.toISOString()))
    throw new TypeError(
      "run control timestamps must have millisecond precision",
    );
  return date;
}
