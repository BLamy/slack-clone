import { createHash } from "node:crypto";

import { sandboxError } from "./errors.mjs";

const ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const RUN_ID = /^rn_[A-Za-z0-9._:-]{1,120}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const QUOTA_DIMENSIONS = Object.freeze([
  "sandboxes",
  "cpuMillis",
  "memoryBytes",
  "storageBytes",
  "durationMs",
  "spendCents",
]);
const COST_DIMENSIONS = Object.freeze([
  "cpuMillis",
  "memoryByteMs",
  "storageByteMs",
  "durationMs",
]);
const DEFAULT_LIMITS = Object.freeze({
  sandboxes: 1,
  cpuMillis: 1_000,
  memoryBytes: 1_024 * 1_024,
  storageBytes: 1_024 * 1_024,
  durationMs: 60_000,
  spendCents: 1_000,
});
const DEFAULT_RATES_MICROS = Object.freeze({
  cpuMillis: 1,
  memoryByteMs: 0,
  storageByteMs: 0,
  durationMs: 1,
});
const MAX_SAFE_USAGE = Number.MAX_SAFE_INTEGER;

export const QUOTA_ERROR_CODES = Object.freeze({
  INVALID_POLICY: "SANDBOX_QUOTA_POLICY_INVALID",
  INVALID_REQUEST: "SANDBOX_QUOTA_REQUEST_INVALID",
  QUOTA_EXCEEDED: "SANDBOX_QUOTA_EXCEEDED",
  RESERVATION_NOT_FOUND: "SANDBOX_QUOTA_RESERVATION_NOT_FOUND",
  RESERVATION_CONFLICT: "SANDBOX_QUOTA_RESERVATION_CONFLICT",
  USAGE_CONFLICT: "SANDBOX_QUOTA_USAGE_CONFLICT",
  USAGE_INVALID: "SANDBOX_QUOTA_USAGE_INVALID",
  REPLAY_INVALID: "SANDBOX_QUOTA_REPLAY_INVALID",
});

export const QUOTA_RESERVATION_DIMENSIONS = QUOTA_DIMENSIONS;
export const QUOTA_COST_DIMENSIONS = COST_DIMENSIONS;

export function compileQuotaPolicy(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    quotaInvalid("quota policy must be an object");
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1)
    quotaInvalid("quota policy schemaVersion must be 1");
  const scope = input.scope ?? input;
  const tenantId = normalizeId(scope.tenantId, "tenantId");
  const workspaceId = normalizeId(scope.workspaceId, "workspaceId");
  const agentId = normalizeId(scope.agentId, "agentId");
  const limits = normalizeLimits(input.limits ?? DEFAULT_LIMITS);
  const pricingVersion = normalizeId(
    input.pricingVersion ?? input.pricing?.version ?? "pricing-v1",
    "pricingVersion",
  );
  const ratesMicros = normalizeRates(
    input.ratesMicros ?? input.pricing?.ratesMicros ?? DEFAULT_RATES_MICROS,
  );
  const value = {
    schemaVersion: 1,
    scope: { tenantId, workspaceId, agentId },
    limits,
    pricingVersion,
    ratesMicros,
  };
  return Object.freeze({ ...value, digest: digest(value) });
}

export class SandboxQuotaManager {
  #policy;
  #reservations = new Map();
  #observations = new Map();
  #costs = new Map();
  #events = new Map();
  #committedUsage = zeroDimensions();

  constructor({ policy, events = [] } = {}) {
    this.#policy = compileQuotaPolicy(policy);
    if (!Array.isArray(events)) quotaInvalid("quota events must be an array");
    if (events.length > 0) {
      const replayed = replayQuotaEvents(events, { policy: this.#policy });
      this.#reservations = replayed.reservations;
      this.#observations = replayed.observations;
      this.#costs = replayed.costs;
      this.#events = replayed.events;
      this.#committedUsage = replayed.committedUsage;
    }
  }

  policy() {
    return structuredClone(this.#policy);
  }

  reserve({
    reservationId,
    tenantId,
    workspaceId,
    agentId,
    runId,
    invocationDigest,
    requested,
    idempotencyKey,
  } = {}) {
    const normalized = normalizeReservationRequest({
      reservationId,
      tenantId,
      workspaceId,
      agentId,
      runId,
      invocationDigest,
      requested,
      idempotencyKey,
    });
    assertScope(this.#policy, normalized);
    const existing = this.#reservations.get(normalized.reservationId);
    if (existing) {
      if (!sameReservation(existing, normalized))
        throw quotaError(
          QUOTA_ERROR_CODES.RESERVATION_CONFLICT,
          "reservation id is already bound to a different request",
        );
      return publicReservation(existing);
    }
    const active = sumActiveReservations(this.#reservations);
    const projected = addDimensions(active, normalized.requested);
    const projectedSpend =
      this.#committedUsage.spendCents + projected.spendCents;
    for (const dimension of QUOTA_DIMENSIONS) {
      const value =
        dimension === "spendCents" ? projectedSpend : projected[dimension];
      if (value > this.#policy.limits[dimension])
        throw quotaError(
          QUOTA_ERROR_CODES.QUOTA_EXCEEDED,
          `quota ${dimension} would be exceeded`,
        );
    }
    const reservation = {
      reservationId: normalized.reservationId,
      tenantId: normalized.tenantId,
      workspaceId: normalized.workspaceId,
      agentId: normalized.agentId,
      runId: normalized.runId,
      invocationDigest: normalized.invocationDigest,
      requested: normalized.requested,
      status: "active",
      fence: 1,
    };
    this.#reservations.set(reservation.reservationId, reservation);
    this.#append({
      eventType: "quota.reservation.created",
      eventId: `reservation-created:${reservation.reservationId}`,
      reservation: publicReservation(reservation),
    });
    return publicReservation(reservation);
  }

  release({ reservationId, expectedFence, reason = "terminal" } = {}) {
    const id = normalizeId(reservationId, "reservationId");
    const reservation = this.#reservation(id);
    if (reservation.status === "released") {
      if (expectedFence !== undefined && expectedFence !== reservation.fence)
        throw quotaError(
          QUOTA_ERROR_CODES.RESERVATION_CONFLICT,
          "reservation release fence is stale",
        );
      return publicReservation(reservation);
    }
    if (
      expectedFence !== undefined &&
      (!Number.isSafeInteger(expectedFence) ||
        expectedFence !== reservation.fence)
    )
      throw quotaError(
        QUOTA_ERROR_CODES.RESERVATION_CONFLICT,
        "reservation release fence is stale",
      );
    const normalizedReason = normalizeId(reason, "reason");
    reservation.status = "released";
    reservation.fence += 1;
    reservation.releaseReason = normalizedReason;
    this.#append({
      eventType: "quota.reservation.released",
      eventId: `reservation-released:${reservation.reservationId}:${reservation.fence}`,
      reservationId: reservation.reservationId,
      expectedFence: reservation.fence - 1,
      fence: reservation.fence,
      reason: normalizedReason,
    });
    return publicReservation(reservation);
  }

  recordUsage({
    reservationId,
    providerResourceId,
    meteringWindow,
    measured,
    pricingVersion,
    sourceObservationId,
    sourceOffset,
  } = {}) {
    const id = normalizeId(reservationId, "reservationId");
    const reservation = this.#reservation(id);
    const normalized = normalizeUsageObservation({
      reservationId: id,
      providerResourceId,
      meteringWindow,
      measured,
      pricingVersion,
      sourceObservationId,
      sourceOffset,
    });
    assertScope(this.#policy, reservation);
    if (normalized.pricingVersion !== this.#policy.pricingVersion)
      throw quotaError(
        QUOTA_ERROR_CODES.USAGE_INVALID,
        "usage pricing version is not the active quota pricing version",
      );
    const observationFingerprint = digest(normalized);
    const prior = this.#observations.get(normalized.sourceObservationId);
    if (prior) {
      if (prior.fingerprint !== observationFingerprint)
        throw quotaError(
          QUOTA_ERROR_CODES.USAGE_CONFLICT,
          "source observation id is already bound to different usage",
        );
      return structuredClone(prior.cost);
    }
    const costCents = calculateCostCents(
      normalized.measured,
      this.#policy.ratesMicros,
    );
    if (
      this.#committedUsage.spendCents + costCents >
      this.#policy.limits.spendCents
    )
      throw quotaError(
        QUOTA_ERROR_CODES.QUOTA_EXCEEDED,
        "provider usage would exceed the spend ceiling",
      );
    const cost = {
      costId: `cost_${hash(normalized.sourceObservationId).slice(0, 32)}`,
      reservationId: id,
      tenantId: reservation.tenantId,
      workspaceId: reservation.workspaceId,
      agentId: reservation.agentId,
      runId: reservation.runId,
      providerResourceId: normalized.providerResourceId,
      meteringWindow: normalized.meteringWindow,
      measured: normalized.measured,
      pricingVersion: normalized.pricingVersion,
      costCents,
      sourceObservationId: normalized.sourceObservationId,
      sourceOffset: normalized.sourceOffset,
    };
    this.#observations.set(normalized.sourceObservationId, {
      fingerprint: observationFingerprint,
      cost,
    });
    this.#costs.set(cost.costId, cost);
    this.#committedUsage.spendCents += costCents;
    this.#append({
      eventType: "sandbox.usage.observed",
      eventId: `usage:${normalized.sourceObservationId}`,
      observation: normalized,
      costId: cost.costId,
    });
    this.#append({
      eventType: "sandbox.cost.recorded",
      eventId: `cost:${cost.costId}`,
      cost,
    });
    return structuredClone(cost);
  }

  reservation(reservationId) {
    return publicReservation(this.#reservation(reservationId));
  }

  reservations() {
    return [...this.#reservations.values()]
      .sort((left, right) =>
        left.reservationId.localeCompare(right.reservationId),
      )
      .map(publicReservation);
  }

  usage() {
    return {
      activeReserved: sumActiveReservations(this.#reservations),
      committed: structuredClone(this.#committedUsage),
      costs: [...this.#costs.values()]
        .sort((left, right) => left.costId.localeCompare(right.costId))
        .map((cost) => structuredClone(cost)),
    };
  }

  events() {
    return [...this.#events.values()]
      .sort((left, right) => left.eventId.localeCompare(right.eventId))
      .map((event) => structuredClone(event));
  }

  digest() {
    return digest(this.events());
  }

  summary() {
    return {
      policyDigest: this.#policy.digest,
      reservations: this.reservations(),
      usage: this.usage(),
      eventDigest: this.digest(),
    };
  }

  #reservation(reservationId) {
    const id = normalizeId(reservationId, "reservationId");
    const reservation = this.#reservations.get(id);
    if (!reservation)
      throw quotaError(
        QUOTA_ERROR_CODES.RESERVATION_NOT_FOUND,
        "quota reservation was not found",
      );
    return reservation;
  }

  #append(event) {
    const prior = this.#events.get(event.eventId);
    if (prior) {
      if (digest(prior) !== digest(event))
        throw quotaError(
          QUOTA_ERROR_CODES.REPLAY_INVALID,
          "quota event id is already bound to different data",
        );
      return;
    }
    this.#events.set(event.eventId, {
      schemaVersion: 1,
      ...event,
    });
  }
}

export function replayQuotaEvents(events, { policy } = {}) {
  if (!Array.isArray(events))
    throw quotaError(
      QUOTA_ERROR_CODES.REPLAY_INVALID,
      "quota events must be an array",
    );
  const compiled = compileQuotaPolicy(policy);
  const unique = new Map();
  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event))
      throw quotaError(
        QUOTA_ERROR_CODES.REPLAY_INVALID,
        "quota event is invalid",
      );
    const eventId = normalizeId(event.eventId, "eventId");
    const prior = unique.get(eventId);
    if (prior && digest(prior) !== digest(event))
      throw quotaError(
        QUOTA_ERROR_CODES.REPLAY_INVALID,
        "duplicate quota event id has different data",
      );
    unique.set(eventId, structuredClone(event));
  }
  const ordered = [...unique.values()].sort((left, right) =>
    left.eventId.localeCompare(right.eventId),
  );
  const reservations = new Map();
  const observations = new Map();
  const costs = new Map();
  const replayedEvents = new Map();
  const committedUsage = zeroDimensions();
  for (const event of ordered) {
    if (event.eventType === "quota.reservation.created") {
      const reservation = normalizePublicReservation(event.reservation);
      assertScope(compiled, reservation);
      const prior = reservations.get(reservation.reservationId);
      if (prior && digest(prior) !== digest(reservation))
        throw quotaError(
          QUOTA_ERROR_CODES.REPLAY_INVALID,
          "reservation replay conflicts",
        );
      reservations.set(reservation.reservationId, reservation);
    } else if (event.eventType === "quota.reservation.released") {
      const reservation = reservations.get(event.reservationId);
      if (!reservation)
        throw quotaError(
          QUOTA_ERROR_CODES.REPLAY_INVALID,
          "release references an unknown reservation",
        );
      if (reservation.fence !== event.expectedFence)
        throw quotaError(
          QUOTA_ERROR_CODES.REPLAY_INVALID,
          "release fence does not match the reservation",
        );
      reservation.status = "released";
      reservation.fence = event.fence;
      reservation.releaseReason = normalizeId(event.reason, "reason");
    } else if (event.eventType === "sandbox.usage.observed") {
      const observation = normalizeUsageObservation(event.observation);
      const prior = observations.get(observation.sourceObservationId);
      if (prior && digest(prior) !== digest(observation))
        throw quotaError(
          QUOTA_ERROR_CODES.REPLAY_INVALID,
          "usage replay conflicts",
        );
      observations.set(observation.sourceObservationId, observation);
    } else if (event.eventType === "sandbox.cost.recorded") {
      const cost = normalizeCost(event.cost);
      const prior = costs.get(cost.costId);
      if (prior && digest(prior) !== digest(cost))
        throw quotaError(
          QUOTA_ERROR_CODES.REPLAY_INVALID,
          "cost replay conflicts",
        );
      costs.set(cost.costId, cost);
    } else {
      throw quotaError(
        QUOTA_ERROR_CODES.REPLAY_INVALID,
        `unknown quota event type: ${String(event.eventType)}`,
      );
    }
    replayedEvents.set(event.eventId, structuredClone(event));
  }
  for (const cost of costs.values())
    committedUsage.spendCents += cost.costCents;
  return {
    policy: compiled,
    reservations,
    observations,
    costs,
    events: replayedEvents,
    committedUsage,
    digest: digest(ordered),
  };
}

export function quotaUsageDigest(value) {
  return digest(value);
}

function normalizeReservationRequest({
  reservationId,
  tenantId,
  workspaceId,
  agentId,
  runId,
  invocationDigest,
  requested,
  idempotencyKey,
}) {
  const normalized = {
    reservationId: normalizeId(reservationId, "reservationId"),
    tenantId: normalizeId(tenantId, "tenantId"),
    workspaceId: normalizeId(workspaceId, "workspaceId"),
    agentId: normalizeId(agentId, "agentId"),
    runId: normalizeRunId(runId),
    invocationDigest: normalizeDigest(invocationDigest),
    requested: normalizeLimits(requested, { requireAll: true }),
    idempotencyKey: normalizeId(
      idempotencyKey ?? reservationId,
      "idempotencyKey",
    ),
  };
  return normalized;
}

function normalizeUsageObservation({
  reservationId,
  providerResourceId,
  meteringWindow,
  measured,
  pricingVersion,
  sourceObservationId,
  sourceOffset,
}) {
  const normalizedWindow = normalizeMeteringWindow(meteringWindow);
  const normalizedMeasured = normalizeMeasured(measured);
  if (!DIGEST.test(normalizedMeasured.digest ?? ""))
    delete normalizedMeasured.digest;
  return {
    reservationId: normalizeId(reservationId, "reservationId"),
    providerResourceId: normalizeId(providerResourceId, "providerResourceId"),
    meteringWindow: normalizedWindow,
    measured: normalizedMeasured,
    pricingVersion: normalizeId(pricingVersion, "pricingVersion"),
    sourceObservationId: normalizeId(
      sourceObservationId,
      "sourceObservationId",
    ),
    ...(sourceOffset === undefined
      ? {}
      : { sourceOffset: normalizeId(sourceOffset, "sourceOffset") }),
  };
}

function normalizeCost(cost) {
  if (!cost || typeof cost !== "object" || Array.isArray(cost))
    throw quotaError(QUOTA_ERROR_CODES.REPLAY_INVALID, "cost is invalid");
  const normalized = {
    ...structuredClone(cost),
    costId: normalizeId(cost.costId, "costId"),
    reservationId: normalizeId(cost.reservationId, "reservationId"),
    tenantId: normalizeId(cost.tenantId, "tenantId"),
    workspaceId: normalizeId(cost.workspaceId, "workspaceId"),
    agentId: normalizeId(cost.agentId, "agentId"),
    runId: normalizeRunId(cost.runId),
    providerResourceId: normalizeId(
      cost.providerResourceId,
      "providerResourceId",
    ),
    meteringWindow: normalizeMeteringWindow(cost.meteringWindow),
    measured: normalizeMeasured(cost.measured),
    pricingVersion: normalizeId(cost.pricingVersion, "pricingVersion"),
    costCents: normalizeNonNegativeInteger(cost.costCents, "costCents"),
    sourceObservationId: normalizeId(
      cost.sourceObservationId,
      "sourceObservationId",
    ),
  };
  if (cost.sourceOffset !== undefined)
    normalized.sourceOffset = normalizeId(cost.sourceOffset, "sourceOffset");
  return normalized;
}

function normalizePublicReservation(reservation) {
  if (!reservation || typeof reservation !== "object")
    throw quotaError(
      QUOTA_ERROR_CODES.REPLAY_INVALID,
      "reservation is invalid",
    );
  return {
    reservationId: normalizeId(reservation.reservationId, "reservationId"),
    tenantId: normalizeId(reservation.tenantId, "tenantId"),
    workspaceId: normalizeId(reservation.workspaceId, "workspaceId"),
    agentId: normalizeId(reservation.agentId, "agentId"),
    runId: normalizeRunId(reservation.runId),
    invocationDigest: normalizeDigest(reservation.invocationDigest),
    requested: normalizeLimits(reservation.requested, { requireAll: true }),
    status: reservation.status === "released" ? "released" : "active",
    fence: normalizePositiveInteger(reservation.fence, "fence"),
    ...(reservation.reservedAt === undefined
      ? {}
      : {
          reservedAt: normalizeSafeInteger(
            reservation.reservedAt,
            "reservedAt",
          ),
        }),
    ...(reservation.releasedAt === undefined
      ? {}
      : {
          releasedAt: normalizeSafeInteger(
            reservation.releasedAt,
            "releasedAt",
          ),
        }),
    ...(reservation.releaseReason === undefined
      ? {}
      : {
          releaseReason: normalizeId(
            reservation.releaseReason,
            "releaseReason",
          ),
        }),
  };
}

function normalizeLimits(value, { requireAll = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    quotaInvalid("quota limits must be an object");
  const normalized = {};
  for (const dimension of QUOTA_DIMENSIONS) {
    if (value[dimension] === undefined) {
      if (requireAll) quotaInvalid(`quota limit ${dimension} is required`);
      normalized[dimension] = DEFAULT_LIMITS[dimension];
      continue;
    }
    normalized[dimension] = normalizeNonNegativeInteger(
      value[dimension],
      dimension,
    );
  }
  if (normalized.sandboxes < 1)
    quotaInvalid("sandboxes limit must be positive");
  return normalized;
}

function normalizeRates(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    quotaInvalid("quota rates must be an object");
  const rates = {};
  for (const dimension of COST_DIMENSIONS)
    rates[dimension] = normalizeNonNegativeInteger(
      value[dimension] ?? 0,
      `${dimension} rate`,
    );
  return rates;
}

function normalizeMeasured(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw quotaError(
      QUOTA_ERROR_CODES.USAGE_INVALID,
      "measured usage is invalid",
    );
  const measured = {};
  for (const dimension of COST_DIMENSIONS)
    measured[dimension] = normalizeNonNegativeInteger(
      value[dimension] ?? 0,
      dimension,
    );
  for (const dimension of ["memoryBytes", "storageBytes"]) {
    if (value[dimension] !== undefined)
      measured[dimension] = normalizeNonNegativeInteger(
        value[dimension],
        dimension,
      );
  }
  return measured;
}

function normalizeMeteringWindow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw quotaError(
      QUOTA_ERROR_CODES.USAGE_INVALID,
      "metering window is invalid",
    );
  const startMs = normalizeSafeInteger(value.startMs, "meteringWindow.startMs");
  const endMs = normalizeSafeInteger(value.endMs, "meteringWindow.endMs");
  if (endMs <= startMs)
    throw quotaError(
      QUOTA_ERROR_CODES.USAGE_INVALID,
      "metering window must have a positive duration",
    );
  return { startMs, endMs };
}

function calculateCostCents(measured, ratesMicros) {
  let micros = 0;
  for (const dimension of COST_DIMENSIONS) {
    const contribution = measured[dimension] * ratesMicros[dimension];
    if (
      !Number.isSafeInteger(contribution) ||
      micros > MAX_SAFE_USAGE - contribution
    )
      throw quotaError(
        QUOTA_ERROR_CODES.USAGE_INVALID,
        "measured usage exceeds the accounting range",
      );
    micros += contribution;
  }
  return Math.ceil(micros / 1_000_000);
}

function sumActiveReservations(reservations) {
  const result = zeroDimensions();
  for (const reservation of reservations.values()) {
    if (reservation.status !== "active") continue;
    for (const dimension of QUOTA_DIMENSIONS)
      result[dimension] += reservation.requested[dimension];
  }
  return result;
}

function addDimensions(left, right) {
  const result = zeroDimensions();
  for (const dimension of QUOTA_DIMENSIONS)
    result[dimension] = left[dimension] + right[dimension];
  return result;
}

function zeroDimensions() {
  return Object.fromEntries(
    QUOTA_DIMENSIONS.map((dimension) => [dimension, 0]),
  );
}

function sameReservation(existing, normalized) {
  return (
    existing.tenantId === normalized.tenantId &&
    existing.workspaceId === normalized.workspaceId &&
    existing.agentId === normalized.agentId &&
    existing.runId === normalized.runId &&
    existing.invocationDigest === normalized.invocationDigest &&
    digest(existing.requested) === digest(normalized.requested)
  );
}

function assertScope(policy, value) {
  for (const dimension of ["tenantId", "workspaceId", "agentId"])
    if (value[dimension] !== policy.scope[dimension])
      throw quotaError(
        QUOTA_ERROR_CODES.INVALID_REQUEST,
        `request ${dimension} is outside the quota scope`,
      );
}

function publicReservation(reservation) {
  return structuredClone(reservation);
}

function normalizeRunId(value) {
  if (typeof value !== "string" || !RUN_ID.test(value))
    throw quotaError(QUOTA_ERROR_CODES.INVALID_REQUEST, "runId is invalid");
  return value;
}

function normalizeDigest(value) {
  if (typeof value !== "string" || !DIGEST.test(value))
    throw quotaError(
      QUOTA_ERROR_CODES.INVALID_REQUEST,
      "invocationDigest is invalid",
    );
  return value;
}

function normalizeId(value, name) {
  if (typeof value !== "string" || !ID.test(value))
    throw quotaError(QUOTA_ERROR_CODES.INVALID_REQUEST, `${name} is invalid`);
  return value;
}

function normalizePositiveInteger(value, name) {
  const normalized = normalizeSafeInteger(value, name);
  if (normalized < 1)
    throw quotaError(
      QUOTA_ERROR_CODES.REPLAY_INVALID,
      `${name} must be positive`,
    );
  return normalized;
}

function normalizeNonNegativeInteger(value, name) {
  const normalized = normalizeSafeInteger(value, name);
  if (normalized < 0)
    throw quotaError(
      QUOTA_ERROR_CODES.INVALID_REQUEST,
      `${name} must not be negative`,
    );
  return normalized;
}

function normalizeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value))
    throw quotaError(QUOTA_ERROR_CODES.INVALID_REQUEST, `${name} is invalid`);
  return value;
}

function quotaInvalid(detail) {
  throw quotaError(QUOTA_ERROR_CODES.INVALID_POLICY, detail);
}

function quotaError(code, detail) {
  return sandboxError(code, detail);
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
