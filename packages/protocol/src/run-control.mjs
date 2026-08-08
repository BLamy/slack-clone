import { sha256Digest } from "./sha256.mjs";

export const RUN_CONTROL_SCHEMA_VERSION = 1;

export const RUN_CONTROL_POLICY_OPTIONAL_KEYS = Object.freeze([
  "attemptDeadlineMs",
  "maxAggregateCostUsdCents",
  "maxAggregateInputTokens",
  "maxAggregateOutputBytes",
  "maxAggregateOutputTokens",
  "maxAggregateWallTimeMs",
  "maxOutputBytes",
  "retryBackoffBaseMs",
  "retryBackoffMaxMs",
  "retryBackoffMultiplier",
  "terminationGraceMs",
]);

export const RUN_CONTROL_POLICY_KEYS = Object.freeze([
  "version",
  "maxAttempts",
  "maxInputTokens",
  "maxOutputTokens",
  "maxCostUsdCents",
  "maxWallTimeMs",
  "allowApprovals",
  ...RUN_CONTROL_POLICY_OPTIONAL_KEYS,
]);

export const RUN_CONTROL_ERROR_CODES = Object.freeze({
  ATTEMPT_BUDGET_EXHAUSTED: "RUN_CONTROL_ATTEMPT_BUDGET_EXHAUSTED",
  BUDGET_EXCEEDED: "RUN_CONTROL_BUDGET_EXCEEDED",
  CAPABILITY_REQUIRED: "RUN_CONTROL_CAPABILITY_REQUIRED",
  DUPLICATE_USAGE: "RUN_CONTROL_DUPLICATE_USAGE",
  INVALID_DATA: "RUN_CONTROL_INVALID_DATA",
  INVALID_POLICY: "RUN_CONTROL_INVALID_POLICY",
  INVALID_STATE: "RUN_CONTROL_INVALID_STATE",
  INVALID_TRANSITION: "RUN_CONTROL_INVALID_TRANSITION",
  TERMINAL_IMMUTABLE: "RUN_CONTROL_TERMINAL_IMMUTABLE",
  USAGE_STALE_ATTEMPT: "RUN_CONTROL_USAGE_STALE_ATTEMPT",
});

const BASE_POLICY_KEYS = Object.freeze([
  "version",
  "maxAttempts",
  "maxInputTokens",
  "maxOutputTokens",
  "maxCostUsdCents",
  "maxWallTimeMs",
  "allowApprovals",
]);
const ACCOUNTING_FIELDS = Object.freeze([
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "costUsdCents",
  "wallTimeMs",
  "outputBytes",
]);
const POLICY_BUDGET_FIELDS = Object.freeze([
  ["inputTokens", "maxInputTokens"],
  ["outputTokens", "maxOutputTokens"],
  ["costUsdCents", "maxCostUsdCents"],
  ["wallTimeMs", "maxWallTimeMs"],
  ["outputBytes", "maxOutputBytes"],
]);
const AGGREGATE_BUDGET_FIELDS = Object.freeze([
  ["inputTokens", "maxAggregateInputTokens"],
  ["outputTokens", "maxAggregateOutputTokens"],
  ["costUsdCents", "maxAggregateCostUsdCents"],
  ["wallTimeMs", "maxAggregateWallTimeMs"],
  ["outputBytes", "maxAggregateOutputBytes"],
]);
const MAX_ACCOUNTING_VALUE = 1_000_000_000;
const MAX_ATTEMPT_DEADLINE_MS = 86_400_000;
const MAX_TERMINATION_GRACE_MS = 10_000;

export class RunControlValidationError extends Error {
  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      name: this.name,
      path: this.path,
    };
  }
}

export function validateRunControlPolicyFields(value, path = "$.policy") {
  assertPlain(value, path);
  for (const key of Object.keys(value)) {
    if (
      !BASE_POLICY_KEYS.includes(key) &&
      !RUN_CONTROL_POLICY_OPTIONAL_KEYS.includes(key)
    ) {
      continue;
    }
    if (!RUN_CONTROL_POLICY_OPTIONAL_KEYS.includes(key)) continue;
    validatePolicyField(key, policyFieldValue(value, key), `${path}.${key}`);
  }
  if (
    Object.hasOwn(value, "retryBackoffBaseMs") &&
    Object.hasOwn(value, "retryBackoffMaxMs") &&
    value.retryBackoffMaxMs < value.retryBackoffBaseMs
  ) {
    fail(
      RUN_CONTROL_ERROR_CODES.INVALID_POLICY,
      `${path}.retryBackoffMaxMs`,
      "retryBackoffMaxMs must be at least retryBackoffBaseMs",
    );
  }
  if (
    Object.hasOwn(value, "attemptDeadlineMs") &&
    Object.hasOwn(value, "maxWallTimeMs") &&
    value.attemptDeadlineMs > value.maxWallTimeMs
  ) {
    fail(
      RUN_CONTROL_ERROR_CODES.INVALID_POLICY,
      `${path}.attemptDeadlineMs`,
      "attemptDeadlineMs cannot exceed maxWallTimeMs",
    );
  }
  return value;
}

export function validateRunControlPolicy(value, path = "$.policy") {
  assertExactKeys(value, RUN_CONTROL_POLICY_KEYS, path);
  for (const key of BASE_POLICY_KEYS) {
    if (key === "version") {
      assertInteger(policyFieldValue(value, key), `${path}.${key}`, 1, 1);
    } else if (key === "maxAttempts") {
      assertInteger(policyFieldValue(value, key), `${path}.${key}`, 1, 16);
    } else if (key === "allowApprovals") {
      if (typeof policyFieldValue(value, key) !== "boolean") {
        fail(
          RUN_CONTROL_ERROR_CODES.INVALID_POLICY,
          `${path}.${key}`,
          "allowApprovals must be a boolean",
        );
      }
    } else {
      assertInteger(
        policyFieldValue(value, key),
        `${path}.${key}`,
        0,
        MAX_ACCOUNTING_VALUE,
      );
    }
  }
  return validateRunControlPolicyFields(value, path);
}

export function validateUsage(value, path = "$.usage") {
  assertExactKeys(value, ACCOUNTING_FIELDS, path);
  for (const field of ACCOUNTING_FIELDS) {
    assertInteger(
      usageFieldValue(value, field),
      `${path}.${field}`,
      0,
      MAX_ACCOUNTING_VALUE,
    );
  }
  if (value.totalTokens !== value.inputTokens + value.outputTokens) {
    fail(
      RUN_CONTROL_ERROR_CODES.INVALID_DATA,
      `${path}.totalTokens`,
      "totalTokens must equal inputTokens plus outputTokens",
    );
  }
  return value;
}

export function zeroRunUsage() {
  return {
    costUsdCents: 0,
    inputTokens: 0,
    outputBytes: 0,
    outputTokens: 0,
    totalTokens: 0,
    wallTimeMs: 0,
  };
}

export function addRunUsage(left, right) {
  validateUsage(left, "$.left");
  validateUsage(right, "$.right");
  return {
    costUsdCents: resultValue("costUsdCents", left, right),
    inputTokens: resultValue("inputTokens", left, right),
    outputBytes: resultValue("outputBytes", left, right),
    outputTokens: resultValue("outputTokens", left, right),
    totalTokens: resultValue("totalTokens", left, right),
    wallTimeMs: resultValue("wallTimeMs", left, right),
  };
}

export function usageBudgetViolations(
  usage,
  policy,
  { aggregate = false } = {},
) {
  validateUsage(usage);
  validateRunControlPolicy(policy);
  const violations = [];
  const fields = aggregate ? AGGREGATE_BUDGET_FIELDS : POLICY_BUDGET_FIELDS;
  for (const [usageField, policyField] of fields) {
    const actual = usageFieldValue(usage, usageField);
    const budget = policyFieldValue(policy, policyField);
    if (actual > budget) {
      violations.push({
        actual,
        budget,
        field: usageField,
        policyField,
      });
    }
  }
  return violations;
}

export function planRunRetry({
  attemptNumber,
  failureCode,
  nowMs,
  policy,
  retryable,
}) {
  validateRunControlPolicy(policy);
  assertInteger(attemptNumber, "$.attemptNumber", 1, policy.maxAttempts);
  assertInteger(nowMs, "$.nowMs", 0, Number.MAX_SAFE_INTEGER);
  assertToken(failureCode, "$.failureCode");
  if (!retryable) {
    return {
      attemptNumber,
      backoffMs: 0,
      failureCode,
      nextAttemptAtMs: null,
      reason: "non-retryable",
      retry: false,
    };
  }
  if (attemptNumber >= policy.maxAttempts) {
    return {
      attemptNumber,
      backoffMs: 0,
      failureCode,
      nextAttemptAtMs: null,
      reason: "attempt-budget-exhausted",
      retry: false,
    };
  }
  let backoffMs = policy.retryBackoffBaseMs;
  for (let index = 1; index < attemptNumber; index += 1) {
    if (backoffMs >= policy.retryBackoffMaxMs) {
      backoffMs = policy.retryBackoffMaxMs;
      break;
    }
    if (backoffMs > policy.retryBackoffMaxMs / policy.retryBackoffMultiplier) {
      backoffMs = policy.retryBackoffMaxMs;
      break;
    }
    backoffMs *= policy.retryBackoffMultiplier;
  }
  const nextAttemptAtMs = nowMs + backoffMs;
  if (!Number.isSafeInteger(nextAttemptAtMs)) {
    fail(
      RUN_CONTROL_ERROR_CODES.INVALID_DATA,
      "$.nextAttemptAtMs",
      "retry schedule exceeds the safe clock range",
    );
  }
  return {
    attemptNumber: attemptNumber + 1,
    backoffMs,
    failureCode,
    nextAttemptAtMs,
    reason: "retryable",
    retry: true,
    scheduleId: deriveRunControlId("rtry", {
      attemptNumber,
      backoffMs,
      failureCode,
      nextAttemptAtMs,
    }),
  };
}

export function deriveRunControlId(kind, value) {
  if (!/^[a-z][a-z0-9-]{1,24}$/u.test(kind)) {
    throw new TypeError("run control ID kind must be a lowercase token");
  }
  return `${kind}_${hex(sha256Digest(canonicalJson(value))).slice(0, 26)}`;
}

function validatePolicyField(key, value, path) {
  if (key === "retryBackoffMultiplier") {
    assertInteger(value, path, 1, 8);
    return;
  }
  if (key === "attemptDeadlineMs") {
    assertInteger(value, path, 1, MAX_ATTEMPT_DEADLINE_MS);
    return;
  }
  if (key === "terminationGraceMs") {
    assertInteger(value, path, 1, MAX_TERMINATION_GRACE_MS);
    return;
  }
  assertInteger(value, path, 0, MAX_ACCOUNTING_VALUE);
}

function assertExactKeys(value, keys, path) {
  assertPlain(value, path);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(
        RUN_CONTROL_ERROR_CODES.INVALID_POLICY,
        `${path}.${key}`,
        "field is not allowed",
      );
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      fail(
        RUN_CONTROL_ERROR_CODES.INVALID_POLICY,
        `${path}.${key}`,
        "field is required",
      );
    }
  }
}

function assertInteger(value, path, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(
      RUN_CONTROL_ERROR_CODES.INVALID_DATA,
      path,
      `value must be a safe integer between ${min} and ${max}`,
    );
  }
}

function assertToken(value, path) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/u.test(value)) {
    fail(
      RUN_CONTROL_ERROR_CODES.INVALID_DATA,
      path,
      "value must be a bounded token",
    );
  }
}

function assertPlain(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(RUN_CONTROL_ERROR_CODES.INVALID_DATA, path, "value must be an object");
  }
}

function fail(code, path, detail) {
  const error = new RunControlValidationError();
  error.message = `${code} at ${path}: ${detail}`;
  error.name = "RunControlValidationError";
  error.code = code;
  error.path = path;
  error.detail = detail;
  throw error;
}

function policyFieldValue(policy, field) {
  switch (field) {
    case "allowApprovals":
      return policy.allowApprovals;
    case "attemptDeadlineMs":
      return policy.attemptDeadlineMs;
    case "maxAggregateCostUsdCents":
      return policy.maxAggregateCostUsdCents;
    case "maxAggregateInputTokens":
      return policy.maxAggregateInputTokens;
    case "maxAggregateOutputBytes":
      return policy.maxAggregateOutputBytes;
    case "maxAggregateOutputTokens":
      return policy.maxAggregateOutputTokens;
    case "maxAggregateWallTimeMs":
      return policy.maxAggregateWallTimeMs;
    case "maxAttempts":
      return policy.maxAttempts;
    case "maxCostUsdCents":
      return policy.maxCostUsdCents;
    case "maxInputTokens":
      return policy.maxInputTokens;
    case "maxOutputBytes":
      return policy.maxOutputBytes;
    case "maxOutputTokens":
      return policy.maxOutputTokens;
    case "maxWallTimeMs":
      return policy.maxWallTimeMs;
    case "retryBackoffBaseMs":
      return policy.retryBackoffBaseMs;
    case "retryBackoffMaxMs":
      return policy.retryBackoffMaxMs;
    case "retryBackoffMultiplier":
      return policy.retryBackoffMultiplier;
    case "terminationGraceMs":
      return policy.terminationGraceMs;
    case "version":
      return policy.version;
    default:
      throw new TypeError(`unknown run control field ${field}`);
  }
}

function usageFieldValue(usage, field) {
  switch (field) {
    case "costUsdCents":
      return usage.costUsdCents;
    case "inputTokens":
      return usage.inputTokens;
    case "outputBytes":
      return usage.outputBytes;
    case "outputTokens":
      return usage.outputTokens;
    case "totalTokens":
      return usage.totalTokens;
    case "wallTimeMs":
      return usage.wallTimeMs;
    default:
      throw new TypeError(`unknown usage field ${field}`);
  }
}

function resultValue(field, left, right) {
  const next = usageFieldValue(left, field) + usageFieldValue(right, field);
  if (!Number.isSafeInteger(next) || next > MAX_ACCOUNTING_VALUE) {
    fail(
      RUN_CONTROL_ERROR_CODES.INVALID_DATA,
      `$.usage.${field}`,
      "usage sum exceeds the bounded accounting range",
    );
  }
  return next;
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON requires finite numbers");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") {
    throw new TypeError("canonical JSON requires JSON values");
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
