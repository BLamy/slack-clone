import { createHash } from "node:crypto";

import { CLOUDFLARE_OS_ERROR_CODES, cloudflareOsError } from "./errors.mjs";

const ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const OWNERSHIP_LABEL_KEYS = Object.freeze([
  "stream-slack/deployment",
  "stream-slack/tenant",
  "stream-slack/workspace",
  "stream-slack/agent",
]);

export { OWNERSHIP_LABEL_KEYS };

export class CloudflareOrphanGarbageCollector {
  #client;
  #ownershipLabels;
  #graceMs;
  #leaseResolver;
  #clock;
  #lastNow = null;
  #quarantine = new Map();
  #events = new Map();

  constructor({
    client,
    ownershipLabels,
    graceMs = 60_000,
    leaseResolver,
    clock = () => Date.now(),
    state,
  } = {}) {
    if (
      !client ||
      (typeof client.inventory !== "function" &&
        typeof client.listByLabels !== "function") ||
      typeof client.destroy !== "function"
    )
      gcInvalid("Cloudflare inventory and destroy client methods are required");
    if (!Number.isSafeInteger(graceMs) || graceMs < 1)
      gcInvalid("graceMs must be a positive safe integer");
    if (typeof leaseResolver !== "function")
      gcInvalid("leaseResolver must be a function");
    if (typeof clock !== "function") gcInvalid("clock must be a function");
    this.#client = client;
    this.#ownershipLabels = normalizeOwnershipLabels(ownershipLabels);
    this.#graceMs = graceMs;
    this.#leaseResolver = leaseResolver;
    this.#clock = clock;
    if (state !== undefined) this.#restore(state);
  }

  ownershipLabels() {
    return structuredClone(this.#ownershipLabels);
  }

  quarantine() {
    return [...this.#quarantine.values()]
      .sort((left, right) => left.resourceKey.localeCompare(right.resourceKey))
      .map((entry) => structuredClone(entry));
  }

  state() {
    return {
      lastNow: this.#lastNow,
      quarantine: this.quarantine(),
      events: this.events(),
      eventDigest: this.digest(),
    };
  }

  events() {
    return [...this.#events.values()]
      .sort((left, right) => left.eventId.localeCompare(right.eventId))
      .map((event) => structuredClone(event));
  }

  digest() {
    return digest({ quarantine: this.quarantine(), events: this.events() });
  }

  async scan() {
    const now = this.#monotonicNow();
    const resources = await this.#inventory();
    const seen = new Set();
    const result = {
      scanned: resources.length,
      ignored: 0,
      held: 0,
      quarantined: [],
      destroyed: [],
      destroyFailures: [],
      gone: [],
      now,
    };
    for (const raw of resources) {
      const resource = normalizeResource(raw);
      if (
        !resource ||
        !ownershipMatches(resource.labels, this.#ownershipLabels)
      ) {
        result.ignored += 1;
        continue;
      }
      seen.add(resource.resourceKey);
      const firstLease = await this.#leaseResolver(resource.public, {
        phase: "pre-quarantine",
        now,
      });
      if (firstLease?.active === true) {
        this.#quarantine.delete(resource.resourceKey);
        result.held += 1;
        this.#append({
          eventId: `lease-held:${resource.resourceKey}:${resource.fence}`,
          eventType: "gc.lease-held",
          resourceKey: resource.resourceKey,
          fence: resource.fence,
        });
        continue;
      }
      const prior = this.#quarantine.get(resource.resourceKey);
      if (!prior || prior.resourceFence !== resource.fence) {
        const entry = {
          resourceKey: resource.resourceKey,
          reference: resource.reference,
          resourceFence: resource.fence,
          firstSeenAt: now,
          lastSeenAt: now,
          heartbeatSequence: safeSequence(firstLease),
        };
        this.#quarantine.set(resource.resourceKey, entry);
        result.quarantined.push(resource.resourceKey);
        this.#append({
          eventId: `quarantine:${resource.resourceKey}:${resource.fence}:${now}`,
          eventType: "gc.orphan-quarantined",
          resourceKey: resource.resourceKey,
          resourceFence: resource.fence,
          firstSeenAt: now,
        });
        continue;
      }
      prior.lastSeenAt = now;
      if (now - prior.firstSeenAt < this.#graceMs) {
        result.held += 1;
        continue;
      }

      // This is deliberately a second authoritative lease read immediately
      // before the destructive provider call. A quarantine is not a lease.
      const secondLease = await this.#leaseResolver(resource.public, {
        phase: "pre-destroy",
        now,
        quarantine: structuredClone(prior),
      });
      if (secondLease?.active === true) {
        this.#quarantine.delete(resource.resourceKey);
        result.held += 1;
        this.#append({
          eventId: `lease-revalidated:${resource.resourceKey}:${resource.fence}:${safeSequence(secondLease)}`,
          eventType: "gc.lease-revalidated",
          resourceKey: resource.resourceKey,
          resourceFence: resource.fence,
          heartbeatSequence: safeSequence(secondLease),
        });
        continue;
      }
      if (safeSequence(secondLease) > prior.heartbeatSequence) {
        prior.firstSeenAt = now;
        prior.heartbeatSequence = safeSequence(secondLease);
        result.held += 1;
        this.#append({
          eventId: `heartbeat-advanced:${resource.resourceKey}:${resource.fence}:${safeSequence(secondLease)}`,
          eventType: "gc.heartbeat-advanced",
          resourceKey: resource.resourceKey,
          resourceFence: resource.fence,
          heartbeatSequence: safeSequence(secondLease),
        });
        continue;
      }
      const idempotencyKey = destroyIdempotencyKey(
        this.#ownershipLabels["stream-slack/deployment"],
        resource,
      );
      try {
        await this.#client.destroy(
          resource.reference,
          this.#ownershipLabels,
          idempotencyKey,
          resource.fence,
        );
        this.#quarantine.delete(resource.resourceKey);
        result.destroyed.push(resource.resourceKey);
        this.#append({
          eventId: `destroyed:${resource.resourceKey}:${resource.fence}`,
          eventType: "gc.orphan-destroyed",
          resourceKey: resource.resourceKey,
          resourceFence: resource.fence,
          idempotencyKey,
        });
      } catch (error) {
        if (isNotFound(error)) {
          this.#quarantine.delete(resource.resourceKey);
          result.gone.push(resource.resourceKey);
          this.#append({
            eventId: `gone:${resource.resourceKey}:${resource.fence}`,
            eventType: "gc.resource-gone",
            resourceKey: resource.resourceKey,
            resourceFence: resource.fence,
          });
          continue;
        }
        result.destroyFailures.push({
          resourceKey: resource.resourceKey,
          code: error?.code ?? CLOUDFLARE_OS_ERROR_CODES.GC_DESTROY_FAILED,
        });
        this.#append({
          eventId: `destroy-failed:${resource.resourceKey}:${resource.fence}`,
          eventType: "gc.destroy-failed",
          resourceKey: resource.resourceKey,
          resourceFence: resource.fence,
          code: error?.code ?? CLOUDFLARE_OS_ERROR_CODES.GC_DESTROY_FAILED,
        });
      }
    }
    for (const resourceKey of this.#quarantine.keys()) {
      if (seen.has(resourceKey)) continue;
      this.#quarantine.delete(resourceKey);
      result.gone.push(resourceKey);
      this.#append({
        eventId: `gone:${resourceKey}:absent`,
        eventType: "gc.resource-gone",
        resourceKey,
      });
    }
    return {
      ...result,
      quarantine: this.quarantine(),
      digest: this.digest(),
    };
  }

  async #inventory() {
    const resources = [];
    let cursor = null;
    const cursors = new Set();
    for (let page = 0; page < 1024; page += 1) {
      const response =
        typeof this.#client.inventory === "function"
          ? await this.#client.inventory(this.#ownershipLabels, { cursor })
          : await this.#client.listByLabels(this.#ownershipLabels, { cursor });
      const pageResources = response?.resources ?? response?.items ?? response;
      if (!Array.isArray(pageResources))
        throw cloudflareOsError(
          CLOUDFLARE_OS_ERROR_CODES.GC_PAGINATION_INVALID,
          "Cloudflare inventory page is not an array",
          { operation: "gc-inventory" },
        );
      resources.push(...pageResources);
      const nextCursor =
        response?.nextCursor ??
        response?.next_cursor ??
        response?.pagination?.nextCursor ??
        null;
      if (nextCursor === null || nextCursor === undefined || nextCursor === "")
        return resources;
      if (typeof nextCursor !== "string" || cursors.has(nextCursor))
        throw cloudflareOsError(
          CLOUDFLARE_OS_ERROR_CODES.GC_PAGINATION_INVALID,
          "Cloudflare inventory pagination cursor repeated or is invalid",
          { operation: "gc-inventory" },
        );
      cursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw cloudflareOsError(
      CLOUDFLARE_OS_ERROR_CODES.GC_PAGINATION_INVALID,
      "Cloudflare inventory pagination exceeded the bounded page limit",
      { operation: "gc-inventory" },
    );
  }

  #monotonicNow() {
    const raw = this.#clock();
    if (!Number.isSafeInteger(raw))
      throw cloudflareOsError(
        CLOUDFLARE_OS_ERROR_CODES.GC_CLOCK_INVALID,
        "garbage collector clock must return a safe integer",
        { operation: "gc-clock" },
      );
    if (this.#lastNow === null) {
      this.#lastNow = raw;
      return raw;
    }
    this.#lastNow = Math.max(this.#lastNow, raw);
    return this.#lastNow;
  }

  #append(event) {
    const normalized = { schemaVersion: 1, ...event };
    const prior = this.#events.get(normalized.eventId);
    if (prior) {
      if (digest(prior) !== digest(normalized))
        throw cloudflareOsError(
          CLOUDFLARE_OS_ERROR_CODES.GC_INVALID_REQUEST,
          "garbage collector event id is already bound to different data",
          { operation: "gc-event" },
        );
      return;
    }
    this.#events.set(normalized.eventId, normalized);
  }

  #restore(state) {
    if (!state || typeof state !== "object" || Array.isArray(state))
      gcInvalid("garbage collector state is invalid");
    if (state.lastNow !== null && state.lastNow !== undefined)
      this.#lastNow = normalizeSafeInteger(state.lastNow, "state.lastNow");
    for (const entry of state.quarantine ?? []) {
      const normalized = normalizeQuarantine(entry);
      this.#quarantine.set(normalized.resourceKey, normalized);
    }
    for (const event of state.events ?? []) {
      if (!event?.eventId) continue;
      this.#events.set(event.eventId, structuredClone(event));
    }
  }
}

function normalizeOwnershipLabels(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    gcInvalid("ownershipLabels must be an object");
  const labels = {};
  for (const key of OWNERSHIP_LABEL_KEYS) {
    if (typeof value[key] !== "string" || !ID.test(value[key]))
      throw cloudflareOsError(
        CLOUDFLARE_OS_ERROR_CODES.GC_OWNERSHIP_MISMATCH,
        `${key} ownership label is invalid`,
        { operation: "gc-labels" },
      );
    labels[key] = value[key];
  }
  return Object.freeze(labels);
}

function ownershipMatches(actual, expected) {
  return (
    actual &&
    typeof actual === "object" &&
    OWNERSHIP_LABEL_KEYS.every((key) => actual[key] === expected[key])
  );
}

function normalizeResource(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw.resource ?? raw.gadget ?? raw.workspace ?? raw;
  const labels =
    record?.labels ?? record?.workspace?.labels ?? record?.gadget?.labels;
  if (!labels || typeof labels !== "object") return null;
  const workspaceId =
    record.workspaceId ?? record.workspace?.id ?? record.workspace?.workspaceId;
  const gadgetId =
    record.gadgetId ?? record.gadget?.id ?? record.gadget?.gadgetId;
  const fence = record.fence ?? record.revision;
  if (
    typeof workspaceId !== "string" ||
    !ID.test(workspaceId) ||
    typeof gadgetId !== "string" ||
    !ID.test(gadgetId) ||
    !Number.isSafeInteger(fence) ||
    fence < 1
  )
    return null;
  const resourceKey = `${workspaceId}:${gadgetId}`;
  return {
    resourceKey,
    reference: { workspaceId, gadgetId },
    fence,
    labels: structuredClone(labels),
    public: {
      resourceKey,
      reference: { workspaceId, gadgetId },
      fence,
      labels: structuredClone(labels),
      lifecycle: record.state ?? record.status ?? record.lifecycle ?? "unknown",
    },
  };
}

function normalizeQuarantine(entry) {
  if (!entry || typeof entry !== "object")
    gcInvalid("quarantine entry is invalid");
  return {
    resourceKey: normalizeId(entry.resourceKey, "resourceKey"),
    reference: {
      workspaceId: normalizeId(entry.reference?.workspaceId, "workspaceId"),
      gadgetId: normalizeId(entry.reference?.gadgetId, "gadgetId"),
    },
    resourceFence: normalizePositiveInteger(
      entry.resourceFence,
      "resourceFence",
    ),
    firstSeenAt: normalizeSafeInteger(entry.firstSeenAt, "firstSeenAt"),
    lastSeenAt: normalizeSafeInteger(entry.lastSeenAt, "lastSeenAt"),
    heartbeatSequence: normalizeNonNegativeInteger(
      entry.heartbeatSequence,
      "heartbeatSequence",
    ),
  };
}

function safeSequence(lease) {
  return Number.isSafeInteger(lease?.heartbeatSequence) &&
    lease.heartbeatSequence >= 0
    ? lease.heartbeatSequence
    : 0;
}

function destroyIdempotencyKey(deploymentId, resource) {
  return `gc_${hash(
    `${deploymentId}:${resource.resourceKey}:${resource.fence}`,
  ).slice(0, 32)}`;
}

function isNotFound(error) {
  return (
    error?.status === 404 || error?.code === CLOUDFLARE_OS_ERROR_CODES.NOT_FOUND
  );
}

function normalizeId(value, name) {
  if (typeof value !== "string" || !ID.test(value))
    gcInvalid(`${name} is invalid`);
  return value;
}

function normalizePositiveInteger(value, name) {
  const normalized = normalizeSafeInteger(value, name);
  if (normalized < 1) gcInvalid(`${name} must be positive`);
  return normalized;
}

function normalizeNonNegativeInteger(value, name) {
  const normalized = normalizeSafeInteger(value, name);
  if (normalized < 0) gcInvalid(`${name} must not be negative`);
  return normalized;
}

function normalizeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value)) gcInvalid(`${name} is invalid`);
  return value;
}

function gcInvalid(detail) {
  throw cloudflareOsError(
    CLOUDFLARE_OS_ERROR_CODES.GC_INVALID_REQUEST,
    detail,
    { operation: "gc-validate" },
  );
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
