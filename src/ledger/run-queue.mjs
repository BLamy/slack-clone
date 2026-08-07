import { randomBytes } from "node:crypto";

import {
  allowedRunTransition,
  createQueueProof,
  deriveRunQueueId,
  RUN_LEASE_EVENT_TYPES_V1,
  RUN_QUEUE_ERROR_CODES,
  runCapabilityDigest,
  queueEntryDigest,
  validateAgentConfigAgentId,
  validateInvocationRequestedData,
  validateQueueEntry,
  validateQueueProof,
  validateRunCapabilityToken,
  validateRunLifecycleData,
  validateRunLeaseEventData,
  validateWorkspaceId,
} from "@stream-slack/protocol";

import { canonicalSha256 } from "./canonical-json.mjs";
import {
  digestEventEnvelope,
  issueEventEnvelope,
  validateEventEnvelope,
} from "./envelope.mjs";
import { streamNames } from "./topology.mjs";

const OFFSET_PATTERN = /^\d{16}_[0-9a-f]{16}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DEFAULT_LEASE_TTL_MS = 30_000;
const QUEUED_RUN_STATUS = "queued";
const ENDING_LEASE_EVENT_TYPES = new Set([
  "run.lease.expired",
  "run.lease.released",
  "run.lease.superseded",
]);

export class RunQueueError extends Error {
  constructor(code, detail, context = {}) {
    super(`${code}: ${detail}`);
    this.name = "RunQueueError";
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
      workerId: this.workerId ?? null,
    };
  }
}

/**
 * Rebuild the queue only from authoritative invocation and run stream records.
 * Query rows and worker memory are deliberately not accepted as inputs.
 */
export function rebuildQueueProjection(options = {}) {
  return projectEligibleQueue(options);
}

export function projectEligibleQueue({
  invocationRecords = [],
  runRecords = [],
  invocations = null,
  runs = null,
  now = Date.now(),
  priorityFor = defaultPriority,
  workspaceId,
} = {}) {
  validateWorkspaceId(workspaceId);
  const nowMs = normalizeNow(now);
  if (typeof priorityFor !== "function") {
    throw new TypeError("queue priorityFor must be a function");
  }
  const normalizedInvocations = invocations
    ? normalizeInvocationValues(invocations, workspaceId)
    : normalizeInvocationRecords(invocationRecords, workspaceId);
  const normalizedRuns = runs
    ? normalizeRunValues(runs, workspaceId)
    : normalizeRunRecords(runRecords, workspaceId);
  const runByInvocation = new Map(
    normalizedRuns.map((run) => [run.invocationId, run]),
  );
  const entries = [];
  const excluded = [];
  for (const invocation of normalizedInvocations) {
    const run = runByInvocation.get(invocation.invocationId);
    const reason = eligibilityReason(invocation, run, nowMs);
    if (reason) {
      excluded.push({ invocationId: invocation.invocationId, reason });
      continue;
    }
    const priority = priorityFor(invocation, run);
    if (!Number.isSafeInteger(priority) || priority < -100 || priority > 100) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.INVALID_DATA,
        "priorityFor must return an integer between -100 and 100",
        { runId: run.runId },
      );
    }
    const entry = {
      agentId: invocation.agentId,
      attempts: run.attempts,
      correlationId: invocation.correlationId,
      invocationId: invocation.invocationId,
      invocationRef: invocation.sourceRef,
      policyDigest: invocation.policyDigest,
      priority,
      runId: run.runId,
      runRef: run.runRef,
      runStatus: run.status,
      snapshotDigest: invocation.snapshotDigest,
      snapshotRef: invocation.snapshotRef,
      sourceTrigger: invocation.sourceTrigger,
      workspaceId,
    };
    try {
      validateQueueEntry(entry, { expectedWorkspaceId: workspaceId });
    } catch (error) {
      throw new RunQueueError(
        error.code ?? RUN_QUEUE_ERROR_CODES.INVALID_DATA,
        error.detail ?? "queue entry is invalid",
        { invocationId: invocation.invocationId, runId: run.runId },
      );
    }
    entries.push(entry);
  }
  entries.sort(compareQueueEntries);
  const invocationStream = streamNames.workspaceInvocations(workspaceId);
  const runStreamDigest = digestRecords(
    runRecords,
    runRecords.length > 0 ? null : normalizedRuns,
  );
  const invocationStreamDigest = digestRecords(
    invocationRecords,
    invocationRecords.length > 0 ? null : normalizedInvocations,
  );
  const proof = createQueueProof({
    entries,
    invocationStreamDigest,
    runStreamDigest,
    workspaceId,
  });
  return deepFreeze({
    entries,
    excluded,
    invocationStream: invocationStream,
    invocationStreamDigest,
    proof,
    queueDigest: proof.queueDigest,
    runStreamDigest,
    schemaVersion: 1,
    workspaceId,
  });
}

/**
 * Pure reducer for the durable lease journal. The bearer capability is never
 * part of a record; only its digest and immutable scope are persisted.
 */
export function replayRunLeaseEvents(records = [], { workspaceId } = {}) {
  if (!Array.isArray(records)) {
    throw new RunQueueError(
      RUN_QUEUE_ERROR_CODES.INVALID_EVENT,
      "lease replay input must be an array",
    );
  }
  if (workspaceId !== undefined) validateWorkspaceId(workspaceId);
  let state = {
    fenceGenerations: {},
    leases: {},
    schemaVersion: 1,
  };
  const eventIds = new Set();
  const prefixes = [];
  for (const [index, record] of records.entries()) {
    const offset = record?.offset ?? syntheticOffset(index + 1);
    if (typeof offset !== "string" || !OFFSET_PATTERN.test(offset)) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.INVALID_EVENT,
        "lease record offset is not canonical",
        { offset },
      );
    }
    const event = record?.event ?? record?.envelope ?? record;
    try {
      validateEventEnvelope(event);
    } catch (error) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.INVALID_EVENT,
        error.detail ?? "lease record envelope is invalid",
        { offset },
      );
    }
    if (workspaceId !== undefined && event.workspaceId !== workspaceId) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.QUEUE_SCOPE,
        "lease event belongs to another workspace",
        { offset },
      );
    }
    if (!RUN_LEASE_EVENT_TYPES_V1.includes(event.eventType)) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.INVALID_EVENT,
        "lease replay received a non-lease event",
        { offset },
      );
    }
    if (eventIds.has(event.eventId)) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.INVALID_EVENT,
        "lease event ID was replayed twice",
        { offset },
      );
    }
    eventIds.add(event.eventId);
    try {
      validateRunLeaseEventData(event.eventType, event.data, {
        expectedWorkspaceId: event.workspaceId,
      });
    } catch (error) {
      throw new RunQueueError(
        error.code ?? RUN_QUEUE_ERROR_CODES.INVALID_EVENT,
        error.detail ?? "lease event data is invalid",
        { offset },
      );
    }
    if (!sameSource(event.causation, event.data.sourceRef)) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.INVALID_EVENT,
        "lease event causation must equal its source reference",
        { offset },
      );
    }
    state = applyLeaseEvent(state, event, offset);
    prefixes.push({
      eventId: event.eventId,
      eventType: event.eventType,
      offset,
      stateDigest: canonicalSha256(state),
    });
  }
  return {
    finalState: deepFreeze(state),
    finalStateDigest: canonicalSha256(state),
    prefixes,
  };
}

/**
 * Create the queue/lease authority. All mutating methods are serialized so
 * Promise.all worker races still have one linearizable winner.
 */
export function createRunLeaseCoordinator({
  actorId,
  appendLeaseEvent = async ({ record }) => ({ record }),
  clock = () => new Date(),
  initialEvents = [],
  leaseTtlMs = DEFAULT_LEASE_TTL_MS,
  maxActiveLeases = Number.POSITIVE_INFINITY,
  maxActiveLeasesPerAgent = Number.POSITIVE_INFINITY,
  queueProjection,
  resolveAuthority = () => ({
    agentStatus: "active",
    invocationStatus: "requested",
    workspaceStatus: "active",
  }),
  tokenFactory = () => `${"rcap_"}${randomBytes(32).toString("base64url")}`,
  workspaceId,
} = {}) {
  validateWorkspaceId(workspaceId);
  if (
    typeof actorId !== "string" ||
    !/^pr_[0-9a-hjkmnp-tv-z]{26}_[0-9a-hjkmnp-tv-z]{26}$/u.test(actorId)
  ) {
    throw new TypeError(
      "run lease coordinator requires a workspace-scoped actorId",
    );
  }
  if (typeof appendLeaseEvent !== "function") {
    throw new TypeError(
      "run lease coordinator appendLeaseEvent must be a function",
    );
  }
  if (typeof clock !== "function" || typeof resolveAuthority !== "function") {
    throw new TypeError(
      "run lease coordinator clock and resolveAuthority must be functions",
    );
  }
  if (
    !Number.isSafeInteger(leaseTtlMs) ||
    leaseTtlMs < 100 ||
    leaseTtlMs > 86_400_000
  ) {
    throw new TypeError("run lease ttl must be between 100ms and 24h");
  }
  if (
    !Number.isSafeInteger(maxActiveLeases) &&
    maxActiveLeases !== Number.POSITIVE_INFINITY
  ) {
    throw new TypeError("maxActiveLeases must be a safe integer or Infinity");
  }
  if (
    !Number.isSafeInteger(maxActiveLeasesPerAgent) &&
    maxActiveLeasesPerAgent !== Number.POSITIVE_INFINITY
  ) {
    throw new TypeError(
      "maxActiveLeasesPerAgent must be a safe integer or Infinity",
    );
  }
  if (typeof tokenFactory !== "function") {
    throw new TypeError("run lease tokenFactory must be a function");
  }
  if (queueProjection) assertProjection(queueProjection, workspaceId);

  let projection = queueProjection ?? null;
  let journal = structuredClone(initialEvents);
  let replayed = replayRunLeaseEvents(journal, { workspaceId });
  const tokens = new Map();
  const issuedCapabilityDigests = new Set();
  const leaseEntries = new Map();
  if (projection) {
    for (const lease of Object.values(replayed.finalState.leases)) {
      const entry = projection.entries.find(
        ({ runId }) => runId === lease.runId,
      );
      if (entry) leaseEntries.set(lease.runId, structuredClone(entry));
    }
  }
  let serial = Promise.resolve();

  function withLock(operation) {
    const next = serial.then(operation, operation);
    serial = next.catch(() => {});
    return next;
  }

  function currentProjection() {
    if (!projection) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.INVALID_PROOF,
        "a queue projection is required before lease acquisition",
      );
    }
    return projection;
  }

  async function appendEvent({ data, entry, eventType, now, reason = null }) {
    const eventSequence = journal.length + 1;
    const issuedAt = normalizeDate(now).toISOString();
    const eventData = {
      ...data,
      issuedAt,
      reason,
    };
    const idInput = {
      eventSequence,
      eventType,
      eventData,
      workspaceId,
    };
    const event = issueEventEnvelope(
      {
        actorId,
        causation: eventData.sourceRef,
        correlationId: entry.correlationId,
        data: eventData,
        eventType,
        idempotencyKey: deriveRunQueueId("ik", idInput),
        schemaVersion: 1,
        workspaceId,
      },
      {
        clock: () => normalizeDate(now),
        eventId: deriveRunQueueId("ev", idInput),
      },
    );
    const record = {
      digest: digestEventEnvelope(event),
      event,
      offset: syntheticOffset(eventSequence),
    };
    const appended = await appendLeaseEvent({
      event,
      eventDigest: record.digest,
      record,
      stream: streamNames.run(workspaceId, entry.runId),
      workspaceId,
    });
    journal = [...journal, record];
    replayed = replayRunLeaseEvents(journal, { workspaceId });
    return {
      appended,
      record,
      state: replayed.finalState,
    };
  }

  async function authorityFor(entry, operation) {
    const decision = await resolveAuthority({ entry, operation, workspaceId });
    if (decision === false || decision?.allowed === false) {
      throw new RunQueueError(
        decision?.code ?? RUN_QUEUE_ERROR_CODES.AUTHORITY_REVOKED,
        decision?.detail ?? "current authority no longer permits the run",
        { runId: entry.runId },
      );
    }
    if (decision && typeof decision === "object") {
      if (decision.workspaceStatus && decision.workspaceStatus !== "active") {
        throw new RunQueueError(
          RUN_QUEUE_ERROR_CODES.WORKSPACE_SUSPENDED,
          "workspace is not active",
          { runId: entry.runId },
        );
      }
      if (decision.agentStatus && decision.agentStatus !== "active") {
        throw new RunQueueError(
          RUN_QUEUE_ERROR_CODES.AUTHORITY_REVOKED,
          "agent lifecycle is not active",
          { runId: entry.runId },
        );
      }
      if (
        decision.invocationStatus &&
        !["requested", "queued"].includes(decision.invocationStatus)
      ) {
        throw new RunQueueError(
          RUN_QUEUE_ERROR_CODES.AUTHORITY_REVOKED,
          "invocation is no longer runnable",
          { runId: entry.runId },
        );
      }
      if (
        decision.snapshotDigest &&
        decision.snapshotDigest !== entry.snapshotDigest
      ) {
        throw new RunQueueError(
          RUN_QUEUE_ERROR_CODES.SNAPSHOT_STALE,
          "immutable invocation snapshot digest changed",
          { runId: entry.runId },
        );
      }
    }
    return decision;
  }

  function assertQueueBinding(entry, proof) {
    const queue = currentProjection();
    try {
      validateQueueProof(proof, { expectedWorkspaceId: workspaceId });
    } catch (error) {
      throw new RunQueueError(
        error.code ?? RUN_QUEUE_ERROR_CODES.INVALID_PROOF,
        error.detail ?? "queue proof is invalid",
        { runId: entry.runId },
      );
    }
    if (proof.queueDigest !== queue.proof.queueDigest) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.QUEUE_CHANGED,
        "queue proof is not the current rebuilt projection",
        { runId: entry.runId },
      );
    }
    const currentEntry = queue.entries.find(
      ({ invocationId }) => invocationId === entry.invocationId,
    );
    if (!currentEntry) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.QUEUE_ENTRY_NOT_FOUND,
        "invocation is not present in the current eligible queue",
        { runId: entry.runId },
      );
    }
    if (
      queueEntryDigest(currentEntry) !== queueEntryDigest(entry) ||
      !proof.entryDigests.includes(queueEntryDigest(entry))
    ) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.INVALID_PROOF,
        "queue entry does not match the signed projection proof",
        { runId: entry.runId },
      );
    }
    if (entry.runStatus !== QUEUED_RUN_STATUS) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.QUEUE_ENTRY_NOT_ELIGIBLE,
        "only queued runs may be acquired",
        { runId: entry.runId },
      );
    }
  }

  function activeLeaseFor(runId) {
    return replayed.finalState.leases[runId] ?? null;
  }

  function assertConcurrency(entry) {
    const active = Object.values(replayed.finalState.leases);
    if (active.length >= maxActiveLeases) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.CONCURRENCY_LIMIT,
        "workspace concurrency policy has no available lease slot",
        { runId: entry.runId },
      );
    }
    const sameAgent = active.filter((lease) => lease.agentId === entry.agentId);
    if (sameAgent.length >= maxActiveLeasesPerAgent) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.CONCURRENCY_LIMIT,
        "agent concurrency policy has no available lease slot",
        { runId: entry.runId },
      );
    }
  }

  async function expireDueLeases(now) {
    const nowMs = normalizeNow(now);
    const expired = [];
    for (const lease of Object.values(replayed.finalState.leases)) {
      if (Date.parse(lease.expiresAt) > nowMs) continue;
      const entry = entryForLease(lease);
      await appendEvent({
        data: leaseEventData(lease, entry, lease.expiresAt),
        entry,
        eventType: "run.lease.expired",
        now,
        reason: "lease-expired",
      });
      tokens.delete(lease.capabilityDigest);
      expired.push(redactLease(lease));
    }
    return expired;
  }

  function entryForLease(lease) {
    const remembered = leaseEntries.get(lease.runId);
    if (remembered) return remembered;
    const queue = currentProjection();
    const entry = queue.entries.find(({ runId }) => runId === lease.runId);
    if (!entry) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.QUEUE_ENTRY_NOT_FOUND,
        "active lease no longer has a queue entry",
        { runId: lease.runId },
      );
    }
    return entry;
  }

  function assertCapability(capability, request = {}) {
    validateRunCapabilityToken(capability);
    const digest = runCapabilityDigest(capability);
    const token = tokens.get(digest);
    if (token !== capability) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.CAPABILITY_INVALID,
        "capability is unknown to this coordinator",
        { runId: request.runId ?? null },
      );
    }
    const lease =
      replayed.finalState.leases[request.runId ?? request.leaseRunId];
    if (!lease) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.LEASE_NOT_FOUND,
        "lease is no longer active",
        { runId: request.runId ?? null },
      );
    }
    if (lease.capabilityDigest !== digest) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.CAPABILITY_SCOPE,
        "capability is scoped to another lease",
        { runId: lease.runId },
      );
    }
    if (request.workerId !== undefined && request.workerId !== lease.workerId) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.CAPABILITY_SCOPE,
        "capability is scoped to another worker",
        { runId: lease.runId, workerId: request.workerId },
      );
    }
    if (request.endpoint && !lease.endpoints.includes(request.endpoint)) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.CAPABILITY_SCOPE,
        "capability does not grant this endpoint",
        { runId: lease.runId },
      );
    }
    return { digest, lease };
  }

  async function acquire({
    endpoints = ["run.events.write"],
    entry,
    now = clock(),
    queueProof,
    workerId,
  }) {
    return withLock(async () => {
      const normalizedNow = normalizeDate(now);
      await expireDueLeases(normalizedNow);
      assertQueueBinding(entry, queueProof);
      await authorityFor(entry, "acquire");
      if (activeLeaseFor(entry.runId)) {
        throw new RunQueueError(
          RUN_QUEUE_ERROR_CODES.LEASE_HELD,
          "another worker already holds the active lease",
          { runId: entry.runId, workerId },
        );
      }
      assertConcurrency(entry);
      const normalizedWorkerId = boundedToken(workerId, "workerId");
      const normalizedEndpoints = normalizeEndpoints(endpoints);
      const previousFence =
        replayed.finalState.fenceGenerations[entry.runId] ?? 0;
      const leaseGeneration = previousFence === 0 ? 1 : previousFence;
      const attemptNumber = entry.attempts + 1;
      const attemptId = deriveRunQueueId("at", {
        attemptNumber,
        leaseGeneration,
        runId: entry.runId,
      });
      const leaseId = deriveRunQueueId("ls", {
        leaseGeneration,
        runId: entry.runId,
        workerId: normalizedWorkerId,
      });
      const capability = createCapability(tokenFactory, {
        agentId: entry.agentId,
        attemptId,
        attemptNumber,
        endpoints: normalizedEndpoints,
        expiresAt: new Date(normalizedNow.getTime() + leaseTtlMs).toISOString(),
        invocationId: entry.invocationId,
        leaseGeneration,
        runId: entry.runId,
        workerId: normalizedWorkerId,
        workspaceId,
      });
      if (issuedCapabilityDigests.has(capability.digest)) {
        throw new RunQueueError(
          RUN_QUEUE_ERROR_CODES.CAPABILITY_INVALID,
          "capability token factory attempted to reuse a bearer value",
          { runId: entry.runId },
        );
      }
      issuedCapabilityDigests.add(capability.digest);
      const lease = {
        agentId: entry.agentId,
        attemptId,
        attemptNumber,
        capabilityDigest: capability.digest,
        endpoints: normalizedEndpoints,
        entryDigest: queueEntryDigest(entry),
        expiresAt: capability.scope.expiresAt,
        invocationId: entry.invocationId,
        issuedAt: normalizedNow.toISOString(),
        leaseGeneration,
        leaseId,
        queueDigest: currentProjection().proof.queueDigest,
        sourceRef: entry.runRef,
        workerId: normalizedWorkerId,
        runId: entry.runId,
      };
      await appendEvent({
        data: leaseEventData(lease, entry, lease.expiresAt),
        entry,
        eventType: "run.lease.acquired",
        now: normalizedNow,
      });
      leaseEntries.set(entry.runId, structuredClone(entry));
      tokens.set(capability.digest, capability.token);
      return {
        capability: capability.token,
        lease: redactLease(lease),
        queueDigest: currentProjection().proof.queueDigest,
        result: "acquired",
      };
    });
  }

  async function heartbeat({ capability, now = clock(), runId, workerId }) {
    return withLock(async () => {
      const normalizedNow = normalizeDate(now);
      const { digest, lease } = assertCapability(capability, {
        runId,
        workerId,
      });
      if (Date.parse(lease.expiresAt) <= normalizedNow.getTime()) {
        await expireOne(lease, normalizedNow);
        throw new RunQueueError(
          RUN_QUEUE_ERROR_CODES.CAPABILITY_EXPIRED,
          "heartbeat arrived after lease expiry",
          { runId: lease.runId },
        );
      }
      const entry = entryForLease(lease);
      await authorityFor(entry, "heartbeat");
      const nextExpiry = new Date(
        normalizedNow.getTime() + leaseTtlMs,
      ).toISOString();
      const nextLease = {
        ...lease,
        capabilityDigest: digest,
        expiresAt: nextExpiry,
        issuedAt: normalizedNow.toISOString(),
      };
      await appendEvent({
        data: leaseEventData(nextLease, entry, nextExpiry),
        entry,
        eventType: "run.lease.heartbeat",
        now: normalizedNow,
      });
      return { lease: redactLease(nextLease), result: "heartbeat" };
    });
  }

  async function release({
    capability,
    now = clock(),
    reason = "released",
    runId,
    workerId,
  }) {
    return withLock(async () => {
      const normalizedNow = normalizeDate(now);
      const { lease } = assertCapability(capability, { runId, workerId });
      if (Date.parse(lease.expiresAt) <= normalizedNow.getTime()) {
        await expireOne(lease, normalizedNow);
        throw new RunQueueError(
          RUN_QUEUE_ERROR_CODES.CAPABILITY_EXPIRED,
          "release arrived after lease expiry",
          { runId: lease.runId },
        );
      }
      const entry = entryForLease(lease);
      await authorityFor(entry, "release");
      await appendEvent({
        data: leaseEventData(lease, entry, lease.expiresAt),
        entry,
        eventType: "run.lease.released",
        now: normalizedNow,
        reason: boundedToken(reason, "reason"),
      });
      tokens.delete(lease.capabilityDigest);
      return { lease: redactLease(lease), result: "released" };
    });
  }

  async function mutate({
    capability,
    endpoint = "run.events.write",
    mutate: operation,
    now = clock(),
    runId,
    workerId,
  }) {
    return withLock(async () => {
      if (typeof operation !== "function") {
        throw new TypeError("run mutation requires an operation callback");
      }
      const normalizedNow = normalizeDate(now);
      const { digest, lease } = assertCapability(capability, {
        endpoint,
        runId,
        workerId,
      });
      if (Date.parse(lease.expiresAt) <= normalizedNow.getTime()) {
        await expireOne(lease, normalizedNow);
        throw new RunQueueError(
          RUN_QUEUE_ERROR_CODES.CAPABILITY_EXPIRED,
          "run mutation arrived after lease expiry",
          { runId: lease.runId },
        );
      }
      const entry = entryForLease(lease);
      try {
        await authorityFor(entry, "mutate");
      } catch (error) {
        await supersedeOne(lease, entry, normalizedNow, "authority-revoked");
        tokens.delete(digest);
        throw new RunQueueError(
          error.code ?? RUN_QUEUE_ERROR_CODES.AUTHORITY_REVOKED,
          error.detail ?? "run authority was revoked before mutation",
          { runId: lease.runId },
        );
      }
      const result = await operation({
        capabilityDigest: digest,
        leaseGeneration: lease.leaseGeneration,
        scope: redactLease(lease),
      });
      return {
        capabilityDigest: digest,
        leaseGeneration: lease.leaseGeneration,
        result,
      };
    });
  }

  async function expire({ now = clock() } = {}) {
    return withLock(() => expireDueLeases(normalizeDate(now)));
  }

  async function supersede({ now = clock(), reason = "superseded", runId }) {
    return withLock(async () => {
      const lease = replayed.finalState.leases[runId];
      if (!lease) return { result: "no-active-lease", runId };
      const entry = entryForLease(lease);
      await supersedeOne(
        lease,
        entry,
        normalizeDate(now),
        boundedToken(reason, "reason"),
      );
      tokens.delete(lease.capabilityDigest);
      return { lease: redactLease(lease), result: "superseded" };
    });
  }

  async function expireOne(lease, now) {
    const entry = entryForLease(lease);
    await appendEvent({
      data: leaseEventData(lease, entry, lease.expiresAt),
      entry,
      eventType: "run.lease.expired",
      now,
      reason: "lease-expired",
    });
    tokens.delete(lease.capabilityDigest);
  }

  async function supersedeOne(lease, entry, now, reason) {
    await appendEvent({
      data: leaseEventData(lease, entry, lease.expiresAt),
      entry,
      eventType: "run.lease.superseded",
      now,
      reason,
    });
  }

  return Object.freeze({
    acquire,
    expire,
    getJournal: () => structuredClone(journal),
    getState: () =>
      structuredClone({
        ...replayed.finalState,
        leases: Object.fromEntries(
          Object.entries(replayed.finalState.leases).map(([runId, lease]) => [
            runId,
            redactLease(lease),
          ]),
        ),
      }),
    heartbeat,
    mutate,
    rebuild: (nextProjection) => {
      assertProjection(nextProjection, workspaceId);
      projection = nextProjection;
      return nextProjection;
    },
    release,
    supersede,
    workspaceId,
  });
}

function normalizeInvocationRecords(records, workspaceId) {
  if (!Array.isArray(records))
    throw new TypeError("invocationRecords must be an array");
  return records
    .map((record, index) =>
      normalizeInvocationRecord(record, workspaceId, index),
    )
    .filter(Boolean);
}

function normalizeInvocationValues(values, workspaceId) {
  if (!Array.isArray(values))
    throw new TypeError("invocations must be an array");
  return values.map((value, index) => {
    const data = value?.data ?? value;
    const { priority, sourceRef: embeddedSourceRef, status, ...payload } = data;
    const sourceRef = value?.sourceRef ?? embeddedSourceRef;
    if (!sourceRef) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.INVALID_DATA,
        "direct invocation values require sourceRef",
        { invocationId: payload.invocationId },
      );
    }
    const normalized = validateInvocationRequestedData(payload, {
      expectedWorkspaceId: workspaceId,
    });
    return {
      ...structuredClone(normalized),
      sourceRef,
      status: value?.status ?? status ?? "requested",
      priority: value?.priority ?? priority ?? 0,
      recordIndex: index,
    };
  });
}

function normalizeInvocationRecord(record, workspaceId, index) {
  const event = record?.event ?? record?.envelope ?? record;
  if (!event || event.eventType !== "workspace.invocation.requested")
    return null;
  const data = validateInvocationRequestedData(event.data, {
    expectedWorkspaceId: workspaceId,
  });
  const offset = record.offset ?? syntheticOffset(index + 1);
  const digest = record.digest ?? digestEventEnvelope(event);
  return {
    ...structuredClone(data),
    priority: record.priority ?? 0,
    recordIndex: index,
    sourceRef: record.sourceRef ?? {
      digest,
      offset,
      stream: streamNames.workspaceInvocations(workspaceId),
    },
    status: record.status ?? "requested",
  };
}

function normalizeRunRecords(records, workspaceId) {
  if (!Array.isArray(records))
    throw new TypeError("runRecords must be an array");
  const sorted = records
    .map((record, index) => ({ index, record }))
    .sort((left, right) =>
      compareOffsets(left.record?.offset, right.record?.offset),
    );
  const runs = new Map();
  for (const { index, record } of sorted) {
    const event = record?.event ?? record?.envelope ?? record;
    if (!event) continue;
    if (event.eventType === "run.lifecycle.changed") {
      applyLifecycleRecord(runs, record, event, workspaceId, index);
    } else if (RUN_LEASE_EVENT_TYPES_V1.includes(event.eventType)) {
      applyLeaseRecord(runs, record, event, workspaceId, index);
    }
  }
  return [...runs.values()];
}

function normalizeRunValues(values, workspaceId) {
  if (!Array.isArray(values)) throw new TypeError("runs must be an array");
  return values.map((value) => {
    if (!value || typeof value !== "object") {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.INVALID_DATA,
        "run value must be an object",
      );
    }
    const run = {
      ...structuredClone(value),
      attempts: value.attempts ?? value.attemptCount ?? 0,
      runRef: value.runRef ?? value.sourceRef,
      status: value.status ?? value.to,
    };
    if (!run.runRef) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.INVALID_DATA,
        "direct run values require runRef",
      );
    }
    validateAgentConfigAgentId(run.agentId, {
      expectedWorkspaceId: workspaceId,
      path: "$.run.agentId",
    });
    return run;
  });
}

function applyLifecycleRecord(runs, record, event, workspaceId, index) {
  const data = event.data;
  try {
    validateLifecycle(data, workspaceId);
  } catch (error) {
    throw new RunQueueError(
      error.code ?? RUN_QUEUE_ERROR_CODES.INVALID_DATA,
      error.detail ?? "run lifecycle record is invalid",
      { offset: record.offset ?? syntheticOffset(index + 1) },
    );
  }
  const current = runs.get(data.runId);
  if (
    current &&
    (current.status !== data.from || !allowedRunTransition(data.from, data.to))
  ) {
    throw new RunQueueError(
      RUN_QUEUE_ERROR_CODES.INVALID_EVENT,
      "run lifecycle record is not a valid queue projection transition",
      { runId: data.runId },
    );
  }
  const invocationId = data.invocationId ?? current?.invocationId;
  const run = current ?? {
    agentId: data.binding?.agentId ?? null,
    attempts: 0,
    invocationId,
    runId: data.runId,
    status: null,
  };
  if (!invocationId) {
    throw new RunQueueError(
      RUN_QUEUE_ERROR_CODES.INVALID_EVENT,
      "run lifecycle record has no invocation binding",
      { runId: data.runId },
    );
  }
  if (data.attemptNumber)
    run.attempts = Math.max(run.attempts, data.attemptNumber);
  run.status = data.to;
  run.attemptId = data.attemptId;
  run.leaseGeneration = data.leaseGeneration;
  run.runRef = {
    digest: record.digest ?? digestEventEnvelope(event),
    offset: record.offset ?? syntheticOffset(index + 1),
    stream: streamNames.run(workspaceId, data.runId),
  };
  run.workspaceId = workspaceId;
  if (data.binding?.agentId) run.agentId = data.binding.agentId;
  runs.set(data.runId, run);
}

function applyLeaseRecord(runs, record, event, workspaceId, index) {
  try {
    validateRunLeaseEventData(event.eventType, event.data, {
      expectedWorkspaceId: workspaceId,
    });
  } catch (error) {
    throw new RunQueueError(
      error.code ?? RUN_QUEUE_ERROR_CODES.INVALID_EVENT,
      error.detail ?? "run lease record is invalid",
      { offset: record.offset ?? syntheticOffset(index + 1) },
    );
  }
  const data = event.data;
  const run = runs.get(data.runId);
  if (!run) {
    throw new RunQueueError(
      RUN_QUEUE_ERROR_CODES.INVALID_EVENT,
      "run lease record precedes the run lifecycle",
      { runId: data.runId },
    );
  }
  if (event.eventType === "run.lease.acquired") {
    run.lease = { ...data, active: true };
  } else if (event.eventType === "run.lease.heartbeat") {
    if (!run.lease || run.lease.leaseId !== data.leaseId) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.LEASE_STALE,
        "heartbeat has no matching active lease",
        { runId: data.runId },
      );
    }
    run.lease = { ...run.lease, expiresAt: data.expiresAt };
  } else {
    if (!run.lease || run.lease.leaseId !== data.leaseId) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.LEASE_STALE,
        "lease end has no matching active lease",
        { runId: data.runId },
      );
    }
    run.lease = null;
  }
  run.runRef = {
    digest: record.digest ?? digestEventEnvelope(event),
    offset: record.offset ?? syntheticOffset(index + 1),
    stream: streamNames.run(workspaceId, data.runId),
  };
}

function validateLifecycle(data, workspaceId) {
  return validateRunLifecycleData(data, { expectedWorkspaceId: workspaceId });
}

function eligibilityReason(invocation, run, nowMs) {
  if (!run) return "run-missing";
  if (invocation.status !== "requested") return "invocation-not-requested";
  if (run.status !== QUEUED_RUN_STATUS) return `run-${run.status ?? "missing"}`;
  if (run.lease && run.lease.active && Date.parse(run.lease.expiresAt) > nowMs)
    return "lease-held";
  const maxAttempts = invocation.policy?.maxAttempts;
  if (Number.isSafeInteger(maxAttempts) && run.attempts >= maxAttempts)
    return "attempt-budget-exhausted";
  if (invocation.agentStatus && invocation.agentStatus !== "active")
    return "agent-inactive";
  if (invocation.workspaceStatus && invocation.workspaceStatus !== "active")
    return "workspace-inactive";
  return null;
}

function compareQueueEntries(left, right) {
  if (left.priority !== right.priority) return right.priority - left.priority;
  if (left.invocationRef.offset !== right.invocationRef.offset) {
    return left.invocationRef.offset < right.invocationRef.offset ? -1 : 1;
  }
  return left.invocationId < right.invocationId
    ? -1
    : left.invocationId > right.invocationId
      ? 1
      : 0;
}

function digestRecords(records, fallback = null) {
  if (Array.isArray(records) && records.length > 0) {
    const metadata = records.map((record, index) => {
      const event = record?.event ?? record?.envelope ?? record;
      return {
        digest:
          record?.digest ??
          (event?.eventId ? digestEventEnvelope(event) : null),
        eventId: event?.eventId ?? null,
        eventType: event?.eventType ?? null,
        offset: record?.offset ?? syntheticOffset(index + 1),
      };
    });
    metadata.sort((left, right) => {
      const offsetComparison = compareOffsets(left.offset, right.offset);
      if (offsetComparison !== 0) return offsetComparison;
      const leftId = left.eventId ?? "";
      const rightId = right.eventId ?? "";
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
    return canonicalSha256(metadata);
  }
  const normalizedFallback = (fallback ?? [])
    .map((value) => {
      const rest = { ...value };
      delete rest.recordIndex;
      return rest;
    })
    .sort((left, right) => {
      const offsetComparison = compareOffsets(
        left.sourceRef?.offset ?? left.runRef?.offset,
        right.sourceRef?.offset ?? right.runRef?.offset,
      );
      if (offsetComparison !== 0) return offsetComparison;
      const leftId = left.invocationId ?? left.runId ?? "";
      const rightId = right.invocationId ?? right.runId ?? "";
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
  return canonicalSha256(normalizedFallback);
}

function createCapability(tokenFactory, scope) {
  const token = tokenFactory(scope);
  validateRunCapabilityToken(token);
  return {
    digest: runCapabilityDigest(token),
    scope,
    token,
  };
}

function leaseEventData(lease, entry, expiresAt) {
  return {
    agentId: lease.agentId,
    attemptId: lease.attemptId,
    attemptNumber: lease.attemptNumber,
    capabilityDigest: lease.capabilityDigest,
    endpoints: [...lease.endpoints].sort(),
    entryDigest: lease.entryDigest,
    expiresAt,
    invocationId: lease.invocationId,
    issuedAt: lease.issuedAt,
    leaseGeneration: lease.leaseGeneration,
    leaseId: lease.leaseId,
    queueDigest: lease.queueDigest,
    reason: null,
    runId: lease.runId,
    schemaVersion: 1,
    sourceRef: entry.runRef,
    workerId: lease.workerId,
  };
}

function assertProjection(projection, workspaceId) {
  if (
    !projection ||
    projection.workspaceId !== workspaceId ||
    !projection.proof
  ) {
    throw new RunQueueError(
      RUN_QUEUE_ERROR_CODES.INVALID_PROOF,
      "queue projection is not workspace scoped",
    );
  }
  try {
    validateQueueProof(projection.proof, { expectedWorkspaceId: workspaceId });
  } catch (error) {
    throw new RunQueueError(
      error.code ?? RUN_QUEUE_ERROR_CODES.INVALID_PROOF,
      error.detail ?? "queue proof is invalid",
    );
  }
}

function assertCurrentLeaseInState(state, event) {
  const active = state.leases[event.data.runId];
  if (!active) {
    throw new RunQueueError(
      RUN_QUEUE_ERROR_CODES.LEASE_STALE,
      "lease event does not have an active predecessor",
      { runId: event.data.runId },
    );
  }
  for (const field of [
    "leaseId",
    "invocationId",
    "agentId",
    "attemptId",
    "attemptNumber",
    "leaseGeneration",
    "workerId",
    "queueDigest",
    "entryDigest",
    "capabilityDigest",
  ]) {
    if (active[field] !== event.data[field]) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.LEASE_STALE,
        `lease ${field} does not match the active generation`,
        { runId: event.data.runId },
      );
    }
  }
  if (active.endpoints.join("\u0000") !== event.data.endpoints.join("\u0000")) {
    throw new RunQueueError(
      RUN_QUEUE_ERROR_CODES.LEASE_STALE,
      "lease endpoints do not match the active generation",
      { runId: event.data.runId },
    );
  }
  return active;
}

function applyLeaseEvent(state, event, offset) {
  const next = structuredClone(state);
  const data = event.data;
  if (event.eventType === "run.lease.acquired") {
    if (next.leases[data.runId]) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.LEASE_HELD,
        "a lease is already active",
        { runId: data.runId },
      );
    }
    const expected = next.fenceGenerations[data.runId] ?? 0;
    const required = expected === 0 ? 1 : expected;
    if (data.leaseGeneration !== required) {
      throw new RunQueueError(
        RUN_QUEUE_ERROR_CODES.LEASE_STALE,
        `lease generation must be ${required}`,
        { runId: data.runId },
      );
    }
    next.fenceGenerations[data.runId] = data.leaseGeneration;
    next.leases[data.runId] = {
      ...structuredClone(data),
      active: true,
      acquiredOffset: offset,
    };
    return next;
  }
  const active = assertCurrentLeaseInState(next, event);
  if (event.eventType === "run.lease.heartbeat") {
    next.leases[data.runId] = {
      ...active,
      expiresAt: data.expiresAt,
      issuedAt: data.issuedAt,
      heartbeatOffset: offset,
    };
    return next;
  }
  if (!ENDING_LEASE_EVENT_TYPES.has(event.eventType)) {
    throw new RunQueueError(
      RUN_QUEUE_ERROR_CODES.INVALID_EVENT,
      "unknown lease event",
      { offset },
    );
  }
  delete next.leases[data.runId];
  next.fenceGenerations[data.runId] = data.leaseGeneration + 1;
  return next;
}

function defaultPriority(invocation) {
  return invocation.priority ?? 0;
}

function boundedToken(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/u.test(value)) {
    throw new RunQueueError(
      RUN_QUEUE_ERROR_CODES.INVALID_DATA,
      `${field} must be a bounded token`,
    );
  }
  return value;
}

function normalizeEndpoints(endpoints) {
  if (
    !Array.isArray(endpoints) ||
    endpoints.length < 1 ||
    endpoints.length > 16
  ) {
    throw new RunQueueError(
      RUN_QUEUE_ERROR_CODES.INVALID_DATA,
      "endpoints must contain one to sixteen names",
    );
  }
  const normalized = [
    ...new Set(endpoints.map((endpoint) => boundedToken(endpoint, "endpoint"))),
  ].sort();
  if (normalized.length !== endpoints.length) {
    throw new RunQueueError(
      RUN_QUEUE_ERROR_CODES.INVALID_DATA,
      "endpoints must be unique",
    );
  }
  return normalized;
}

function normalizeDate(value) {
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    !TIMESTAMP_PATTERN.test(date.toISOString())
  ) {
    throw new RunQueueError(
      RUN_QUEUE_ERROR_CODES.INVALID_DATA,
      "clock value must be a valid date",
    );
  }
  return date;
}

function normalizeNow(value) {
  if (value instanceof Date) return normalizeDate(value).getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return normalizeDate(value).getTime();
}

function redactLease(lease) {
  return {
    agentId: lease.agentId,
    attemptId: lease.attemptId,
    attemptNumber: lease.attemptNumber,
    capabilityDigest: lease.capabilityDigest,
    endpoints: [...lease.endpoints],
    entryDigest: lease.entryDigest,
    expiresAt: lease.expiresAt,
    invocationId: lease.invocationId,
    leaseGeneration: lease.leaseGeneration,
    leaseId: lease.leaseId,
    queueDigest: lease.queueDigest,
    runId: lease.runId,
    workerId: lease.workerId,
  };
}

function sameSource(left, right) {
  return (
    left?.digest === right?.digest &&
    left?.offset === right?.offset &&
    left?.stream === right?.stream
  );
}

function syntheticOffset(sequence) {
  return `${String(sequence).padStart(16, "0")}_0000000000000000`;
}

function compareOffsets(left, right) {
  const leftOffset = left ?? "";
  const rightOffset = right ?? "";
  if (leftOffset === rightOffset) return 0;
  return leftOffset < rightOffset ? -1 : 1;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
