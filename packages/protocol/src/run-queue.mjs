import { validateAgentConfigAgentId } from "./agent-config-revisions.mjs";
import { assertSourceReference } from "./invocation-run.mjs";
import { validateWorkspaceId } from "./principals.mjs";
import { sha256Digest } from "./sha256.mjs";

export const RUN_QUEUE_SCHEMA_VERSION = 1;

export const RUN_LEASE_EVENT_TYPES_V1 = Object.freeze([
  "run.lease.acquired",
  "run.lease.heartbeat",
  "run.lease.released",
  "run.lease.expired",
  "run.lease.superseded",
]);

export const RUN_QUEUE_ERROR_CODES = Object.freeze({
  AUTHORITY_REVOKED: "RUN_QUEUE_AUTHORITY_REVOKED",
  CAPABILITY_EXPIRED: "RUN_QUEUE_CAPABILITY_EXPIRED",
  CAPABILITY_INVALID: "RUN_QUEUE_CAPABILITY_INVALID",
  CAPABILITY_SCOPE: "RUN_QUEUE_CAPABILITY_SCOPE",
  CONCURRENCY_LIMIT: "RUN_QUEUE_CONCURRENCY_LIMIT",
  INVALID_DATA: "RUN_QUEUE_INVALID_DATA",
  INVALID_EVENT: "RUN_QUEUE_INVALID_EVENT",
  INVALID_PROOF: "RUN_QUEUE_INVALID_PROOF",
  LEASE_HELD: "RUN_QUEUE_LEASE_HELD",
  LEASE_NOT_FOUND: "RUN_QUEUE_LEASE_NOT_FOUND",
  LEASE_STALE: "RUN_QUEUE_LEASE_STALE",
  QUEUE_CHANGED: "RUN_QUEUE_QUEUE_CHANGED",
  QUEUE_ENTRY_NOT_ELIGIBLE: "RUN_QUEUE_ENTRY_NOT_ELIGIBLE",
  QUEUE_ENTRY_NOT_FOUND: "RUN_QUEUE_ENTRY_NOT_FOUND",
  QUEUE_SCOPE: "RUN_QUEUE_SCOPE",
  SNAPSHOT_STALE: "RUN_QUEUE_SNAPSHOT_STALE",
  WORKSPACE_SUSPENDED: "RUN_QUEUE_WORKSPACE_SUSPENDED",
});

export const RUN_CAPABILITY_PREFIX = "rcap_";

const CAPABILITY_PATTERN = /^rcap_[A-Za-z0-9_-]{32,96}$/u;
const CORRELATION_PATTERN = /^cr_[0-9a-hjkmnp-tv-z]{26}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ID_TOKEN = "[0-9a-hjkmnp-tv-z]{26}";
const INVOCATION_PATTERN = new RegExp(`^iv_${ID_TOKEN}$`, "u");
const RUN_PATTERN = new RegExp(`^rn_${ID_TOKEN}_${ID_TOKEN}$`, "u");
const ATTEMPT_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;
const LEASE_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const QUEUE_ENTRY_KEYS = Object.freeze([
  "agentId",
  "attempts",
  "correlationId",
  "invocationId",
  "invocationRef",
  "policyDigest",
  "priority",
  "runId",
  "runRef",
  "runStatus",
  "snapshotDigest",
  "snapshotRef",
  "sourceTrigger",
  "workspaceId",
]);
const QUEUE_PROOF_KEYS = Object.freeze([
  "entryDigests",
  "invocationStreamDigest",
  "queueDigest",
  "runStreamDigest",
  "schemaVersion",
  "workspaceId",
]);
const LEASE_EVENT_KEYS = Object.freeze([
  "agentId",
  "attemptId",
  "attemptNumber",
  "capabilityDigest",
  "endpoints",
  "entryDigest",
  "expiresAt",
  "invocationId",
  "issuedAt",
  "leaseGeneration",
  "leaseId",
  "queueDigest",
  "reason",
  "runId",
  "schemaVersion",
  "sourceRef",
  "workerId",
]);

export class RunQueueValidationError extends Error {
  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      name: this.name,
      path: this.path,
    };
  }
}

export function queueEntryDigest(entry) {
  const normalized = validateQueueEntry(entry);
  return digestCanonical(normalized);
}

export function createQueueProof({
  entries,
  invocationStreamDigest,
  runStreamDigest,
  workspaceId,
}) {
  validateWorkspaceId(workspaceId);
  assertDigest(invocationStreamDigest, "$.invocationStreamDigest");
  assertDigest(runStreamDigest, "$.runStreamDigest");
  if (!Array.isArray(entries)) {
    failQueue(
      RUN_QUEUE_ERROR_CODES.INVALID_DATA,
      "$.entries",
      "queue entries must be an array",
    );
  }
  const entryDigests = entries.map((entry, index) => {
    try {
      return queueEntryDigest(entry);
    } catch (error) {
      throw withPath(error, `$.entries[${index}]`);
    }
  });
  const proofPayload = {
    entryDigests,
    invocationStreamDigest,
    runStreamDigest,
    schemaVersion: RUN_QUEUE_SCHEMA_VERSION,
    workspaceId,
  };
  return Object.freeze({
    ...proofPayload,
    queueDigest: digestCanonical(proofPayload),
  });
}

export function validateQueueProof(value, { expectedWorkspaceId } = {}) {
  assertPlainObject(value, "$.queueProof");
  assertExactKeys(value, QUEUE_PROOF_KEYS, "$.queueProof");
  if (value.schemaVersion !== RUN_QUEUE_SCHEMA_VERSION) {
    failQueue(
      RUN_QUEUE_ERROR_CODES.INVALID_PROOF,
      "$.queueProof.schemaVersion",
      `schema version must be ${RUN_QUEUE_SCHEMA_VERSION}`,
    );
  }
  validateWorkspaceId(value.workspaceId, "$.queueProof.workspaceId");
  if (
    expectedWorkspaceId !== undefined &&
    value.workspaceId !== expectedWorkspaceId
  ) {
    failQueue(
      RUN_QUEUE_ERROR_CODES.QUEUE_SCOPE,
      "$.queueProof.workspaceId",
      "queue proof belongs to another workspace",
    );
  }
  assertDigest(
    value.invocationStreamDigest,
    "$.queueProof.invocationStreamDigest",
  );
  assertDigest(value.runStreamDigest, "$.queueProof.runStreamDigest");
  if (
    !Array.isArray(value.entryDigests) ||
    value.entryDigests.some((digest) => !DIGEST_PATTERN.test(digest))
  ) {
    failQueue(
      RUN_QUEUE_ERROR_CODES.INVALID_PROOF,
      "$.queueProof.entryDigests",
      "entryDigests must contain only sha256 references",
    );
  }
  const payload = {
    entryDigests: value.entryDigests,
    invocationStreamDigest: value.invocationStreamDigest,
    runStreamDigest: value.runStreamDigest,
    schemaVersion: value.schemaVersion,
    workspaceId: value.workspaceId,
  };
  if (value.queueDigest !== digestCanonical(payload)) {
    failQueue(
      RUN_QUEUE_ERROR_CODES.INVALID_PROOF,
      "$.queueProof.queueDigest",
      "queueDigest does not match the canonical proof bytes",
    );
  }
  return value;
}

export function validateQueueEntry(value, { expectedWorkspaceId } = {}) {
  assertPlainObject(value, "$.queueEntry");
  assertExactKeys(value, QUEUE_ENTRY_KEYS, "$.queueEntry");
  if (value.schemaVersion !== undefined) {
    failQueue(
      RUN_QUEUE_ERROR_CODES.INVALID_DATA,
      "$.queueEntry.schemaVersion",
      "queue entries do not carry an embedded schema field",
    );
  }
  validateWorkspaceId(value.workspaceId, "$.queueEntry.workspaceId");
  if (
    expectedWorkspaceId !== undefined &&
    value.workspaceId !== expectedWorkspaceId
  ) {
    failQueue(
      RUN_QUEUE_ERROR_CODES.QUEUE_SCOPE,
      "$.queueEntry.workspaceId",
      "queue entry belongs to another workspace",
    );
  }
  validateAgentConfigAgentId(value.agentId, {
    expectedWorkspaceId: value.workspaceId,
    path: "$.queueEntry.agentId",
  });
  assertMatch(
    value.invocationId,
    INVOCATION_PATTERN,
    "$.queueEntry.invocationId",
  );
  assertMatch(value.runId, RUN_PATTERN, "$.queueEntry.runId");
  assertMatch(
    value.correlationId,
    CORRELATION_PATTERN,
    "$.queueEntry.correlationId",
  );
  assertPositiveInteger(value.attempts, "$.queueEntry.attempts", {
    allowZero: true,
  });
  if (
    !Number.isSafeInteger(value.priority) ||
    value.priority < -100 ||
    value.priority > 100
  ) {
    failQueue(
      RUN_QUEUE_ERROR_CODES.INVALID_DATA,
      "$.queueEntry.priority",
      "priority must be an integer between -100 and 100",
    );
  }
  assertToken(value.runStatus, "$.queueEntry.runStatus");
  assertDigest(value.policyDigest, "$.queueEntry.policyDigest");
  assertDigest(value.snapshotDigest, "$.queueEntry.snapshotDigest");
  assertSource(
    value.invocationRef,
    "$.queueEntry.invocationRef",
    value.workspaceId,
  );
  assertSource(value.runRef, "$.queueEntry.runRef", value.workspaceId);
  assertSource(
    value.snapshotRef,
    "$.queueEntry.snapshotRef",
    value.workspaceId,
  );
  assertSource(
    value.sourceTrigger,
    "$.queueEntry.sourceTrigger",
    value.workspaceId,
  );
  return value;
}

export function validateRunLeaseEventData(
  eventType,
  value,
  { expectedWorkspaceId } = {},
) {
  if (!RUN_LEASE_EVENT_TYPES_V1.includes(eventType)) {
    failQueue(
      RUN_QUEUE_ERROR_CODES.INVALID_EVENT,
      "$.eventType",
      `unsupported run lease event ${String(eventType)}`,
    );
  }
  assertPlainObject(value, "$.event.data");
  assertExactKeys(value, LEASE_EVENT_KEYS, "$.event.data");
  if (value.schemaVersion !== RUN_QUEUE_SCHEMA_VERSION) {
    failQueue(
      RUN_QUEUE_ERROR_CODES.INVALID_DATA,
      "$.event.data.schemaVersion",
      `schema version must be ${RUN_QUEUE_SCHEMA_VERSION}`,
    );
  }
  validateWorkspaceId(
    expectedWorkspaceId ?? workspaceFromSource(value.sourceRef),
  );
  assertMatch(value.runId, RUN_PATTERN, "$.event.data.runId");
  assertMatch(
    value.invocationId,
    INVOCATION_PATTERN,
    "$.event.data.invocationId",
  );
  validateAgentConfigAgentId(value.agentId, {
    expectedWorkspaceId:
      expectedWorkspaceId ?? workspaceFromSource(value.sourceRef),
    path: "$.event.data.agentId",
  });
  assertMatch(value.attemptId, ATTEMPT_PATTERN, "$.event.data.attemptId");
  assertPositiveInteger(value.attemptNumber, "$.event.data.attemptNumber");
  assertPositiveInteger(value.leaseGeneration, "$.event.data.leaseGeneration");
  assertMatch(value.leaseId, LEASE_PATTERN, "$.event.data.leaseId");
  assertToken(value.workerId, "$.event.data.workerId");
  assertDigest(value.queueDigest, "$.event.data.queueDigest");
  assertDigest(value.entryDigest, "$.event.data.entryDigest");
  assertDigest(value.capabilityDigest, "$.event.data.capabilityDigest");
  assertSource(
    value.sourceRef,
    "$.event.data.sourceRef",
    expectedWorkspaceId ?? workspaceFromSource(value.sourceRef),
  );
  if (
    !Array.isArray(value.endpoints) ||
    value.endpoints.length < 1 ||
    value.endpoints.length > 16 ||
    value.endpoints.some(
      (endpoint) =>
        typeof endpoint !== "string" || !TOKEN_PATTERN.test(endpoint),
    ) ||
    new Set(value.endpoints).size !== value.endpoints.length ||
    [...value.endpoints].sort(compareStrings).join("\u0000") !==
      value.endpoints.join("\u0000")
  ) {
    failQueue(
      RUN_QUEUE_ERROR_CODES.INVALID_DATA,
      "$.event.data.endpoints",
      "endpoints must be a sorted, unique list of bounded names",
    );
  }
  assertTimestamp(value.issuedAt, "$.event.data.issuedAt");
  assertTimestamp(value.expiresAt, "$.event.data.expiresAt");
  if (value.reason !== null) assertToken(value.reason, "$.event.data.reason");
  if (
    ["run.lease.acquired", "run.lease.heartbeat"].includes(eventType) &&
    value.reason !== null
  ) {
    failQueue(
      RUN_QUEUE_ERROR_CODES.INVALID_DATA,
      "$.event.data.reason",
      `${eventType} cannot carry a terminal reason`,
    );
  }
  if (
    [
      "run.lease.released",
      "run.lease.expired",
      "run.lease.superseded",
    ].includes(eventType) &&
    value.reason === null
  ) {
    failQueue(
      RUN_QUEUE_ERROR_CODES.INVALID_DATA,
      "$.event.data.reason",
      `${eventType} requires a terminal reason`,
    );
  }
  return value;
}

export function validateRunCapabilityToken(value, path = "$.capability") {
  if (typeof value !== "string" || !CAPABILITY_PATTERN.test(value)) {
    failQueue(
      RUN_QUEUE_ERROR_CODES.CAPABILITY_INVALID,
      path,
      "capability must be a short-lived opaque bearer value",
    );
  }
  return value;
}

export function runCapabilityDigest(value) {
  validateRunCapabilityToken(value);
  return digestCanonical({ capability: value });
}

export function deriveRunQueueId(kind, value) {
  if (!/^[a-z][a-z0-9-]{1,24}$/u.test(kind)) {
    throw new TypeError("run queue ID kind must be a lowercase token");
  }
  return `${kind}_${hex(sha256Digest(canonicalJson(value))).slice(0, 26)}`;
}

export function canonicalRunQueue(value) {
  return canonicalJson(value);
}

export function runQueueDigest(value) {
  return digestCanonical(value);
}

function assertSource(value, path, expectedWorkspaceId) {
  try {
    assertSourceReference(value, path, expectedWorkspaceId);
  } catch (error) {
    throw new RunQueueValidationError(
      error.code ?? RUN_QUEUE_ERROR_CODES.INVALID_DATA,
      error.detail ?? "source reference is invalid",
      error.path ?? path,
    );
  }
}

function assertExactKeys(value, keys, path) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      failQueue(
        RUN_QUEUE_ERROR_CODES.INVALID_DATA,
        `${path}.${key}`,
        "field is not allowed",
      );
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      failQueue(
        RUN_QUEUE_ERROR_CODES.INVALID_DATA,
        `${path}.${key}`,
        "field is required",
      );
    }
  }
}

function assertPlainObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failQueue(
      RUN_QUEUE_ERROR_CODES.INVALID_DATA,
      path,
      "value must be an object",
    );
  }
}

function assertDigest(value, path) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    failQueue(
      RUN_QUEUE_ERROR_CODES.INVALID_DATA,
      path,
      "value must be a sha256 digest",
    );
  }
}

function assertMatch(value, pattern, path) {
  if (typeof value !== "string" || !pattern.test(value)) {
    failQueue(
      RUN_QUEUE_ERROR_CODES.INVALID_DATA,
      path,
      "value is not canonical",
    );
  }
}

function assertPositiveInteger(value, path, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    failQueue(
      RUN_QUEUE_ERROR_CODES.INVALID_DATA,
      path,
      allowZero
        ? "value must be a non-negative safe integer"
        : "value must be a positive safe integer",
    );
  }
}

function assertTimestamp(value, path) {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    failQueue(
      RUN_QUEUE_ERROR_CODES.INVALID_DATA,
      path,
      "value must be an ISO millisecond timestamp",
    );
  }
}

function assertToken(value, path) {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    failQueue(
      RUN_QUEUE_ERROR_CODES.INVALID_DATA,
      path,
      "value must be a bounded token",
    );
  }
}

function workspaceFromSource(source) {
  const match =
    typeof source?.stream === "string"
      ? source.stream.match(
          /^(?:workspace:(ws_[0-9a-hjkmnp-tv-z]{26})\/|(?:channel:ch_|agent:ag_|run:rn_|connection:cn_|projection:px_)([0-9a-hjkmnp-tv-z]{26})_)/u,
        )
      : null;
  if (!match) {
    failQueue(
      RUN_QUEUE_ERROR_CODES.INVALID_DATA,
      "$.event.data.sourceRef.stream",
      "source stream does not carry a workspace scope",
    );
  }
  return match[1] ?? `ws_${match[2]}`;
}

function withPath(error, prefix) {
  if (error instanceof RunQueueValidationError) {
    error.path = `${prefix}${error.path === "$" ? "" : error.path.slice(1)}`;
  }
  return error;
}

function failQueue(code, path, detail) {
  const error = new RunQueueValidationError(`${code} at ${path}: ${detail}`);
  error.name = "RunQueueValidationError";
  error.code = code;
  error.detail = detail;
  error.path = path;
  throw error;
}

function digestCanonical(value) {
  return `sha256:${hex(sha256Digest(canonicalJson(value)))}`;
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw new TypeError(
        "run queue canonical values require finite safe numbers",
      );
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object")
    throw new TypeError("run queue canonical values must be JSON values");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
