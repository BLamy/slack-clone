import { sha256Digest } from "./sha256.mjs";

export const INVOCATION_RUN_SCHEMA_VERSION = 1;

export const INVOCATION_RUN_EVENT_TYPES_V1 = Object.freeze([
  "workspace.invocation.requested",
  "run.lifecycle.changed",
  "run.activity.recorded",
  "run.usage.recorded",
  "run.approval.requested",
  "run.approval.decided",
  "run.artifact.recorded",
  "run.result.recorded",
  "run.failure.recorded",
]);

export const INVOCATION_STATES_V1 = Object.freeze(["requested"]);

export const RUN_STATES_V1 = Object.freeze([
  "requested",
  "queued",
  "leased",
  "running",
  "awaiting-approval",
  "retry",
  "completed",
  "failed",
  "timed-out",
  "cancelled",
]);

export const TERMINAL_RUN_STATES_V1 = Object.freeze([
  "completed",
  "failed",
  "timed-out",
  "cancelled",
]);

export const RUN_RECORD_EVENT_TYPES_V1 = Object.freeze([
  "run.activity.recorded",
  "run.usage.recorded",
  "run.approval.requested",
  "run.approval.decided",
  "run.artifact.recorded",
  "run.result.recorded",
  "run.failure.recorded",
]);

export const INVOCATION_RUN_ERROR_CODES = Object.freeze({
  BINDING_MISMATCH: "INVOCATION_RUN_BINDING_MISMATCH",
  DUPLICATE_RECORD: "INVOCATION_RUN_DUPLICATE_RECORD",
  INVALID_DATA: "INVOCATION_RUN_INVALID_DATA",
  INVALID_SOURCE: "INVOCATION_RUN_INVALID_SOURCE",
  INVALID_STATE: "INVOCATION_RUN_INVALID_STATE",
  INVALID_TRANSITION: "INVOCATION_RUN_INVALID_TRANSITION",
  SECRET_VALUE: "INVOCATION_RUN_SECRET_VALUE",
  TERMINAL_IMMUTABLE: "INVOCATION_RUN_TERMINAL_IMMUTABLE",
});

const ID_TOKEN = "[0-9a-hjkmnp-tv-z]{26}";
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const OFFSET_PATTERN = /^\d{16}_[0-9a-f]{16}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;
const SAFE_TEXT_PATTERN = /^[\s\S]{1,512}$/u;
const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN [^-]*PRIVATE KEY-----/iu,
  /\b(?:sk|rk|pk)-[A-Za-z0-9][A-Za-z0-9_-]{15,}\b/u,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bAIza[0-9A-Za-z_-]{20,}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/iu,
  /\b(?:access[_-]?token|api[_-]?key|client[_-]?secret|password|secret|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/iu,
]);

export class InvocationRunValidationError extends Error {
  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      name: this.name,
      path: this.path,
    };
  }
}

export function validateInvocationRequestedData(
  value,
  { expectedCorrelationId = null, expectedWorkspaceId } = {},
) {
  assertKeys(
    value,
    [
      "schemaVersion",
      "invocationId",
      "agentId",
      "correlationId",
      "triggerType",
      "sourceTrigger",
      "snapshotRef",
      "snapshotDigest",
      "policy",
      "policyDigest",
    ],
    ["promptRef"],
    "$.event.data",
  );
  assertVersion(value.schemaVersion, "$.event.data.schemaVersion");
  assertToken(value.invocationId, "$.event.data.invocationId");
  assertScopedId(value.agentId, "agent", "$.event.data.agentId");
  assertCorrelation(value.correlationId, "$.event.data.correlationId");
  assertExpectedCorrelation(
    value.correlationId,
    expectedCorrelationId,
    "$.event.data.correlationId",
  );
  assertToken(value.triggerType, "$.event.data.triggerType");
  assertSourceReference(
    value.sourceTrigger,
    "$.event.data.sourceTrigger",
    expectedWorkspaceId,
    { channelOnly: true },
  );
  assertSourceReference(
    value.snapshotRef,
    "$.event.data.snapshotRef",
    expectedWorkspaceId,
  );
  assertDigest(value.snapshotDigest, "$.event.data.snapshotDigest");
  validatePolicy(value.policy, "$.event.data.policy");
  assertDigest(value.policyDigest, "$.event.data.policyDigest");
  assertEqual(
    value.policyDigest,
    policyDigest(value.policy),
    "$.event.data.policyDigest",
    INVOCATION_RUN_ERROR_CODES.BINDING_MISMATCH,
    "policyDigest does not match canonical policy bytes",
  );
  if (value.promptRef !== undefined) {
    assertSourceReference(
      value.promptRef,
      "$.event.data.promptRef",
      expectedWorkspaceId,
    );
  }
  return value;
}

export function validateRunLifecycleData(
  value,
  { expectedCorrelationId = null, expectedWorkspaceId } = {},
) {
  assertKeys(
    value,
    [
      "schemaVersion",
      "runId",
      "invocationId",
      "sequence",
      "from",
      "to",
      "attemptId",
      "attemptNumber",
      "leaseGeneration",
      "sourceRef",
      "binding",
      "terminal",
    ],
    [],
    "$.event.data",
  );
  assertVersion(value.schemaVersion, "$.event.data.schemaVersion");
  assertScopedId(value.runId, "run", "$.event.data.runId");
  assertToken(value.invocationId, "$.event.data.invocationId");
  assertPositiveInteger(value.sequence, "$.event.data.sequence");
  assertRunStateOrNull(value.from, "$.event.data.from");
  assertRunState(value.to, "$.event.data.to");
  assertAttemptFields(value, "$.event.data");
  assertSourceReference(
    value.sourceRef,
    "$.event.data.sourceRef",
    expectedWorkspaceId,
  );
  assertRunBindingOrNull(
    value.binding,
    "$.event.data.binding",
    expectedWorkspaceId,
    expectedCorrelationId,
  );
  assertTerminalOrNull(value.terminal, value.to, expectedWorkspaceId);
  if (value.from === null && value.to !== "requested") {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_TRANSITION,
      "$.event.data.to",
      "a run must begin in requested",
    );
  }
  if (value.to === "requested" && value.from !== null) {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_TRANSITION,
      "$.event.data.to",
      "requested is only the initial run state",
    );
  }
  if (value.from === null && value.binding === null) {
    fail(
      INVOCATION_RUN_ERROR_CODES.BINDING_MISMATCH,
      "$.event.data.binding",
      "the initial run event must carry its immutable invocation binding",
    );
  }
  if (value.from !== null && value.binding !== null) {
    fail(
      INVOCATION_RUN_ERROR_CODES.BINDING_MISMATCH,
      "$.event.data.binding",
      "immutable binding may only appear on the initial run event",
    );
  }
  return value;
}

export function validateRunRecordData(
  eventType,
  value,
  { expectedWorkspaceId } = {},
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
      "$.event.data",
      "value must be a plain object",
    );
  }
  const commonKeys = [
    "schemaVersion",
    "runId",
    "invocationId",
    "attemptId",
    "sequence",
    "sourceRef",
  ];
  assertVersion(value.schemaVersion, "$.event.data.schemaVersion");
  assertScopedId(value.runId, "run", "$.event.data.runId");
  assertToken(value.invocationId, "$.event.data.invocationId");
  assertToken(value.attemptId, "$.event.data.attemptId");
  assertPositiveInteger(value.sequence, "$.event.data.sequence");
  assertSourceReference(
    value.sourceRef,
    "$.event.data.sourceRef",
    expectedWorkspaceId,
  );

  switch (eventType) {
    case "run.activity.recorded":
      assertKeys(
        value,
        [...commonKeys, "kind", "summary", "contentRef"],
        [],
        "$.event.data",
      );
      assertToken(value.kind, "$.event.data.kind");
      assertSafeTextOrNull(value.summary, "$.event.data.summary");
      assertSourceReferenceOrNull(
        value.contentRef,
        "$.event.data.contentRef",
        expectedWorkspaceId,
      );
      if (value.summary === null && value.contentRef === null) {
        fail(
          INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
          "$.event.data",
          "activity requires a bounded summary or content reference",
        );
      }
      break;
    case "run.usage.recorded":
      assertKeys(
        value,
        [
          ...commonKeys,
          "inputTokens",
          "outputTokens",
          "totalTokens",
          "costUsdCents",
          "wallTimeMs",
          "outputBytes",
        ],
        [],
        "$.event.data",
      );
      assertBoundedInteger(value.inputTokens, "$.event.data.inputTokens");
      assertBoundedInteger(value.outputTokens, "$.event.data.outputTokens");
      assertBoundedInteger(value.totalTokens, "$.event.data.totalTokens");
      assertBoundedInteger(value.costUsdCents, "$.event.data.costUsdCents");
      assertBoundedInteger(value.wallTimeMs, "$.event.data.wallTimeMs");
      assertBoundedInteger(value.outputBytes, "$.event.data.outputBytes");
      if (value.totalTokens !== value.inputTokens + value.outputTokens) {
        fail(
          INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
          "$.event.data.totalTokens",
          "totalTokens must equal inputTokens plus outputTokens",
        );
      }
      break;
    case "run.approval.requested":
      assertKeys(
        value,
        [...commonKeys, "approvalId", "action", "requestRef"],
        [],
        "$.event.data",
      );
      assertToken(value.approvalId, "$.event.data.approvalId");
      assertSafeText(value.action, "$.event.data.action");
      assertSourceReference(
        value.requestRef,
        "$.event.data.requestRef",
        expectedWorkspaceId,
      );
      break;
    case "run.approval.decided":
      assertKeys(
        value,
        [...commonKeys, "approvalId", "decision"],
        [],
        "$.event.data",
      );
      assertToken(value.approvalId, "$.event.data.approvalId");
      if (!["approved", "denied"].includes(value.decision)) {
        fail(
          INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
          "$.event.data.decision",
          "decision must be approved or denied",
        );
      }
      break;
    case "run.artifact.recorded":
      assertKeys(
        value,
        [
          ...commonKeys,
          "artifactId",
          "kind",
          "mediaType",
          "name",
          "byteLength",
          "contentRef",
        ],
        [],
        "$.event.data",
      );
      assertToken(value.artifactId, "$.event.data.artifactId");
      assertToken(value.kind, "$.event.data.kind");
      assertSafeText(value.mediaType, "$.event.data.mediaType");
      assertSafeText(value.name, "$.event.data.name");
      assertBoundedInteger(value.byteLength, "$.event.data.byteLength");
      assertSourceReference(
        value.contentRef,
        "$.event.data.contentRef",
        expectedWorkspaceId,
      );
      break;
    case "run.result.recorded":
      assertKeys(
        value,
        [...commonKeys, "resultRef", "summary"],
        [],
        "$.event.data",
      );
      assertSourceReference(
        value.resultRef,
        "$.event.data.resultRef",
        expectedWorkspaceId,
      );
      assertSafeTextOrNull(value.summary, "$.event.data.summary");
      break;
    case "run.failure.recorded":
      assertKeys(
        value,
        [...commonKeys, "failureCode", "retryable", "detailRef"],
        [],
        "$.event.data",
      );
      assertToken(value.failureCode, "$.event.data.failureCode");
      if (typeof value.retryable !== "boolean") {
        fail(
          INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
          "$.event.data.retryable",
          "retryable must be a boolean",
        );
      }
      assertSourceReferenceOrNull(
        value.detailRef,
        "$.event.data.detailRef",
        expectedWorkspaceId,
      );
      break;
    default:
      fail(
        INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
        "$.event.eventType",
        `unsupported run record event ${String(eventType)}`,
      );
  }
  return value;
}

export function allowedRunTransition(from, to) {
  const transitions = new Map([
    [null, ["requested"]],
    ["requested", ["queued"]],
    ["queued", ["leased", "cancelled"]],
    ["leased", ["running"]],
    [
      "running",
      [
        "awaiting-approval",
        "retry",
        "completed",
        "failed",
        "timed-out",
        "cancelled",
      ],
    ],
    ["awaiting-approval", ["running", "failed", "timed-out", "cancelled"]],
    ["retry", ["queued"]],
  ]);
  return transitions.get(from)?.includes(to) ?? false;
}

export function isTerminalRunState(value) {
  return TERMINAL_RUN_STATES_V1.includes(value);
}

export function policyDigest(policy) {
  return digestCanonical(policy);
}

export function deriveInvocationCorrelationId({
  agentId,
  invocationId,
  sourceTrigger,
  workspaceId,
}) {
  assertScopedId(agentId, "agent", "$.agentId");
  assertToken(invocationId, "$.invocationId");
  assertSourceReference(sourceTrigger, "$.sourceTrigger", workspaceId, {
    channelOnly: true,
  });
  if (
    typeof workspaceId !== "string" ||
    !/^ws_[0-9a-hjkmnp-tv-z]{26}$/u.test(workspaceId)
  ) {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
      "$.workspaceId",
      "workspaceId is not canonical",
    );
  }
  return `cr_${hex(
    sha256Digest(
      canonicalJson({ agentId, invocationId, sourceTrigger, workspaceId }),
    ),
  ).slice(0, 26)}`;
}

export const invocationCorrelationId = deriveInvocationCorrelationId;

export function canonicalInvocationRun(value) {
  return canonicalJson(value);
}

export function invocationRunDigest(value) {
  return digestCanonical(value);
}

export function assertSourceReference(
  value,
  path,
  expectedWorkspaceId,
  { channelOnly = false } = {},
) {
  assertKeys(value, ["digest", "offset", "stream"], [], path);
  assertDigest(value.digest, `${path}.digest`);
  if (typeof value.offset !== "string" || !OFFSET_PATTERN.test(value.offset)) {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_SOURCE,
      `${path}.offset`,
      "offset is not a canonical Durable Streams offset",
    );
  }
  if (typeof value.stream !== "string") {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_SOURCE,
      `${path}.stream`,
      "stream must be a canonical topology v1 name",
    );
  }
  const workspaceId = workspaceIdFromStream(value.stream);
  if (!workspaceId) {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_SOURCE,
      `${path}.stream`,
      "stream is not a canonical topology v1 name",
    );
  }
  if (
    expectedWorkspaceId !== undefined &&
    workspaceId !== expectedWorkspaceId
  ) {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_SOURCE,
      `${path}.stream`,
      "source belongs to a different workspace",
    );
  }
  if (channelOnly && !value.stream.startsWith("channel:")) {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_SOURCE,
      `${path}.stream`,
      "source trigger must cite a channel stream",
    );
  }
  return value;
}

export function sourcesEqual(left, right) {
  return (
    left?.digest === right?.digest &&
    left?.offset === right?.offset &&
    left?.stream === right?.stream
  );
}

function validatePolicy(value, path) {
  assertKeys(
    value,
    [
      "version",
      "maxAttempts",
      "maxInputTokens",
      "maxOutputTokens",
      "maxCostUsdCents",
      "maxWallTimeMs",
      "allowApprovals",
    ],
    [],
    path,
  );
  assertVersion(value.version, `${path}.version`);
  assertBoundedInteger(value.maxAttempts, `${path}.maxAttempts`, {
    min: 1,
    max: 16,
  });
  assertBoundedInteger(value.maxInputTokens, `${path}.maxInputTokens`);
  assertBoundedInteger(value.maxOutputTokens, `${path}.maxOutputTokens`);
  assertBoundedInteger(value.maxCostUsdCents, `${path}.maxCostUsdCents`);
  assertBoundedInteger(value.maxWallTimeMs, `${path}.maxWallTimeMs`);
  if (typeof value.allowApprovals !== "boolean") {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
      `${path}.allowApprovals`,
      "allowApprovals must be a boolean",
    );
  }
}

function assertRunBindingOrNull(
  value,
  path,
  expectedWorkspaceId,
  expectedCorrelationId,
) {
  if (value === null) return;
  assertKeys(
    value,
    [
      "agentId",
      "correlationId",
      "invocationRef",
      "sourceTrigger",
      "snapshotRef",
      "snapshotDigest",
      "policy",
      "policyDigest",
    ],
    [],
    path,
  );
  assertScopedId(value.agentId, "agent", `${path}.agentId`);
  assertCorrelation(value.correlationId, `${path}.correlationId`);
  assertExpectedCorrelation(
    value.correlationId,
    expectedCorrelationId,
    `${path}.correlationId`,
  );
  assertSourceReference(
    value.invocationRef,
    `${path}.invocationRef`,
    expectedWorkspaceId,
  );
  assertSourceReference(
    value.sourceTrigger,
    `${path}.sourceTrigger`,
    expectedWorkspaceId,
    { channelOnly: true },
  );
  assertSourceReference(
    value.snapshotRef,
    `${path}.snapshotRef`,
    expectedWorkspaceId,
  );
  assertDigest(value.snapshotDigest, `${path}.snapshotDigest`);
  validatePolicy(value.policy, `${path}.policy`);
  assertDigest(value.policyDigest, `${path}.policyDigest`);
  assertEqual(
    value.policyDigest,
    policyDigest(value.policy),
    `${path}.policyDigest`,
    INVOCATION_RUN_ERROR_CODES.BINDING_MISMATCH,
    "policyDigest does not match canonical policy bytes",
  );
}

function assertTerminalOrNull(value, to, expectedWorkspaceId) {
  if (!isTerminalRunState(to)) {
    if (value !== null) {
      fail(
        INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
        "$.event.data.terminal",
        "non-terminal lifecycle events must have terminal null",
      );
    }
    return;
  }
  assertKeys(
    value,
    ["kind", "resultRef", "failureCode", "reasonCode"],
    [],
    "$.event.data.terminal",
  );
  if (value.kind !== to) {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
      "$.event.data.terminal.kind",
      "terminal kind must equal the run state",
    );
  }
  assertSourceReferenceOrNull(
    value.resultRef,
    "$.event.data.terminal.resultRef",
    expectedWorkspaceId,
  );
  assertTokenOrNull(value.failureCode, "$.event.data.terminal.failureCode");
  assertTokenOrNull(value.reasonCode, "$.event.data.terminal.reasonCode");
  if (to === "completed" && value.resultRef === null) {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
      "$.event.data.terminal.resultRef",
      "completed runs require a result reference",
    );
  }
  if (to === "failed" && value.failureCode === null) {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
      "$.event.data.terminal.failureCode",
      "failed runs require a failure code",
    );
  }
  if (to === "timed-out" && value.reasonCode === null) {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
      "$.event.data.terminal.reasonCode",
      "timed-out runs require a reason code",
    );
  }
  if (to === "cancelled" && value.reasonCode === null) {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
      "$.event.data.terminal.reasonCode",
      "cancelled runs require a reason code",
    );
  }
}

function assertAttemptFields(value, path) {
  const needsAttempt =
    [
      "leased",
      "running",
      "awaiting-approval",
      "retry",
      ...TERMINAL_RUN_STATES_V1,
    ].includes(value.to) &&
    !(value.to === "cancelled" && value.from === "queued");
  if (needsAttempt) {
    assertToken(value.attemptId, `${path}.attemptId`);
    assertPositiveInteger(value.attemptNumber, `${path}.attemptNumber`);
    assertPositiveInteger(value.leaseGeneration, `${path}.leaseGeneration`);
    return;
  }
  if (
    value.attemptId !== null ||
    value.attemptNumber !== null ||
    value.leaseGeneration !== null
  ) {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
      path,
      "requested, queued, and retry-to-queued events cannot carry an active attempt",
    );
  }
}

function assertSourceReferenceOrNull(value, path, expectedWorkspaceId) {
  if (value !== null) assertSourceReference(value, path, expectedWorkspaceId);
}

function assertTokenOrNull(value, path) {
  if (value !== null) assertToken(value, path);
}

function assertRunStateOrNull(value, path) {
  if (value !== null && !RUN_STATES_V1.includes(value)) {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
      path,
      "state is not registered for invocation/run v1",
    );
  }
}

function assertRunState(value, path) {
  if (!RUN_STATES_V1.includes(value)) {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
      path,
      "state is not registered for invocation/run v1",
    );
  }
}

function assertVersion(value, path) {
  if (value !== INVOCATION_RUN_SCHEMA_VERSION) {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
      path,
      `schema version must be ${INVOCATION_RUN_SCHEMA_VERSION}`,
    );
  }
}

function assertCorrelation(value, path) {
  if (
    typeof value !== "string" ||
    !new RegExp(`^cr_${ID_TOKEN}$`, "u").test(value)
  ) {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
      path,
      "correlationId is not canonical",
    );
  }
}

function assertExpectedCorrelation(value, expected, path) {
  if (expected !== null && value !== expected) {
    fail(
      INVOCATION_RUN_ERROR_CODES.BINDING_MISMATCH,
      path,
      "correlationId does not match the event envelope",
    );
  }
}

function assertScopedId(value, kind, path) {
  const prefix = kind === "agent" ? "ag" : "rn";
  if (
    typeof value !== "string" ||
    !new RegExp(`^${prefix}_${ID_TOKEN}_${ID_TOKEN}$`, "u").test(value)
  ) {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
      path,
      `${kind} id is not canonical`,
    );
  }
}

function assertToken(value, path) {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
      path,
      "value must be a bounded token",
    );
  }
}

function assertDigest(value, path) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
      path,
      "value must be a sha256 digest",
    );
  }
}

function assertPositiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
      path,
      "value must be a positive safe integer",
    );
  }
}

function assertBoundedInteger(
  value,
  path,
  { min = 0, max = 1_000_000_000 } = {},
) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
      path,
      `value must be an integer between ${min} and ${max}`,
    );
  }
}

function assertSafeText(value, path) {
  if (
    typeof value !== "string" ||
    !SAFE_TEXT_PATTERN.test(value) ||
    hasControlCharacter(value) ||
    hasSecret(value)
  ) {
    fail(
      hasSecret(value)
        ? INVOCATION_RUN_ERROR_CODES.SECRET_VALUE
        : INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
      path,
      "value must be bounded, printable text without credential material",
    );
  }
}

function assertSafeTextOrNull(value, path) {
  if (value !== null) assertSafeText(value, path);
}

function assertEqual(actual, expected, path, code, detail) {
  if (actual !== expected) fail(code, path, detail);
}

function assertKeys(value, required, optional, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(
      INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
      path,
      "value must be a plain object",
    );
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(
        INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
        `${path}.${key}`,
        "field is not allowed",
      );
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail(
        INVOCATION_RUN_ERROR_CODES.INVALID_DATA,
        `${path}.${key}`,
        "field is required",
      );
    }
  }
}

function fail(code, path, detail) {
  const error = new InvocationRunValidationError(
    `${code} at ${path}: ${detail}`,
  );
  error.name = "InvocationRunValidationError";
  error.code = code;
  error.path = path;
  error.detail = detail;
  throw error;
}

function hasSecret(value) {
  return (
    typeof value === "string" &&
    SECRET_PATTERNS.some((pattern) => pattern.test(value))
  );
}

function hasControlCharacter(value) {
  if (typeof value !== "string") return false;
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

function workspaceIdFromStream(stream) {
  const workspaceMatch = stream.match(
    /^workspace:(ws_[0-9a-hjkmnp-tv-z]{26})\/(?:directory|invocations|audit)$/u,
  );
  if (workspaceMatch) return workspaceMatch[1];
  const scopedMatch = stream.match(
    /^(?:channel:ch_|agent:ag_|run:rn_|connection:cn_|projection:px_)([0-9a-hjkmnp-tv-z]{26})_[0-9a-hjkmnp-tv-z]{26}(?:\/config)?$/u,
  );
  return scopedMatch ? `ws_${scopedMatch[1]}` : null;
}

function digestCanonical(value) {
  return `sha256:${hex(sha256Digest(canonicalJson(value)))}`;
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("canonical JSON requires finite numbers");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object")
    throw new TypeError("canonical JSON requires JSON values");
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
}
