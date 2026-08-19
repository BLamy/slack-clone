import {
  PROVIDER_REGISTRY_ERROR_CODES,
  createProviderRegistry,
} from "./provider-registry.mjs";

export const AGENT_CONFIG_SCHEMA_VERSION = 1;
export const AGENT_CONFIG_PRIOR_SCHEMA_VERSIONS = Object.freeze([0]);

export const AGENT_CONFIG_ERROR_CODES = Object.freeze({
  CONTRADICTORY_POLICY: "AGENT_CONFIG_CONTRADICTORY_POLICY",
  DUPLICATE_VALUE: "AGENT_CONFIG_DUPLICATE_VALUE",
  FORBIDDEN_FIELD: "AGENT_CONFIG_FORBIDDEN_FIELD",
  INVALID_BUDGET: "AGENT_CONFIG_INVALID_BUDGET",
  INVALID_CAPABILITY: "AGENT_CONFIG_INVALID_CAPABILITY",
  INVALID_ENUM: "AGENT_CONFIG_INVALID_ENUM",
  INVALID_SCHEMA_VERSION: "AGENT_CONFIG_INVALID_SCHEMA_VERSION",
  INVALID_VALUE: "AGENT_CONFIG_INVALID_VALUE",
  MISSING_FIELD: "AGENT_CONFIG_MISSING_FIELD",
  SECRET_VALUE: "AGENT_CONFIG_SECRET_VALUE",
  TYPE_MISMATCH: "AGENT_CONFIG_TYPE_MISMATCH",
  UNKNOWN_FIELD: "AGENT_CONFIG_UNKNOWN_FIELD",
  UNKNOWN_PROVIDER: "AGENT_CONFIG_UNKNOWN_PROVIDER",
  UNSUPPORTED_PROVIDER_VERSION: "AGENT_CONFIG_UNSUPPORTED_PROVIDER_VERSION",
  UNSUPPORTED_SCHEMA_VERSION: "AGENT_CONFIG_UNSUPPORTED_SCHEMA_VERSION",
});

const DEFAULT_PROVIDER_REGISTRY = createProviderRegistry();

export const AGENT_CONFIG_TRIGGER_EVENTS = Object.freeze(["manual", "mention"]);
export const AGENT_CONFIG_CONTEXT_SCOPES = Object.freeze([
  "current-channel",
  "current-thread",
  "none",
  "workspace",
]);
export const AGENT_CONFIG_LIFECYCLES = Object.freeze([
  "ephemeral",
  "persistent",
]);

const CONFIG_KEYS = [
  "budgets",
  "concurrency",
  "connectionGrants",
  "context",
  "delegation",
  "harness",
  "instructions",
  "sandbox",
  "schemaVersion",
  "trigger",
  "workspaceInputs",
];
const V0_CONFIG_KEYS = [
  "budget",
  "concurrencyPolicy",
  "connectionGrantRefs",
  "contextPolicy",
  "delegationPolicy",
  "harness",
  "instructions",
  "sandbox",
  "schemaVersion",
  "triggerPolicy",
  "workspaceInputPolicy",
];
const INSTRUCTION_KEYS = ["guardrails", "system", "task"];
const CONTEXT_KEYS = [
  "includePrivate",
  "includeThreadHistory",
  "maxBytes",
  "maxMessages",
  "scope",
];
const TRIGGER_KEYS = ["allowMessageEdits", "events", "requireMention"];
const DELEGATION_KEYS = [
  "allowCrossChannel",
  "enabled",
  "maxChildren",
  "maxDepth",
];
const CONCURRENCY_KEYS = [
  "maxConcurrentPerChannel",
  "maxConcurrentRuns",
  "queueStrategy",
];
const BUDGET_KEYS = [
  "maxCostUsdCents",
  "maxInputTokens",
  "maxOutputTokens",
  "maxTotalTokens",
  "timeoutSeconds",
];
const PROVIDER_KEYS = ["providerId", "providerVersion", "requiredCapabilities"];
const SANDBOX_KEYS = [...PROVIDER_KEYS, "lifecycle", "networkPolicy"];
const WORKSPACE_INPUT_KEYS = ["maxBytes", "paths", "source"];
const CONNECTION_GRANTS_KEYS = ["maxCallsPerRun", "refs"];
const CONNECTION_REF_KEYS = ["connectionId", "grantId", "purpose", "revision"];
const FORBIDDEN_FIELD_NAMES = new Set([
  "apiKey",
  "apiKeyRef",
  "bootstrap",
  "bootstrapCommand",
  "connection",
  "credentials",
  "env",
  "environment",
  "password",
  "providerSettings",
  "secret",
  "secrets",
  "startupCommand",
  "startupCommands",
  "token",
  "tokens",
]);
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/u;
const PROVIDER_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const CONNECTION_ID_PATTERN = /^conn_[a-z0-9][a-z0-9_-]{0,63}$/u;
const GRANT_ID_PATTERN = /^grant_[a-z0-9][a-z0-9_-]{0,63}$/u;
const WORKSPACE_PATH_PATTERN =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]+$/u;
const SECRET_VALUE_PATTERNS = Object.freeze([
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

export class AgentConfigValidationError extends Error {
  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      name: this.name,
      path: this.path,
    };
  }
}

export function validateAgentConfig(
  value,
  { providerRegistry = DEFAULT_PROVIDER_REGISTRY } = {},
) {
  assertPlainObject(value, "$.agentConfig");
  if (!Object.hasOwn(value, "schemaVersion")) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.MISSING_FIELD,
      "$.agentConfig.schemaVersion",
      "field is required",
    );
  }
  assertSchemaVersion(value.schemaVersion, "$.agentConfig.schemaVersion", 1);
  assertExactObject(value, CONFIG_KEYS, "$.agentConfig");
  validateInstructions(value.instructions);
  validateContext(value.context);
  validateTrigger(value.trigger);
  validateDelegation(value.delegation, value.context);
  validateConcurrency(value.concurrency);
  validateBudgets(value.budgets);
  validateProviderSelection(
    value.harness,
    "$.agentConfig.harness",
    "harness",
    providerRegistry,
  );
  validateSandbox(value.sandbox, providerRegistry);
  validateWorkspaceInputs(value.workspaceInputs);
  validateConnectionGrants(value.connectionGrants);
  return value;
}

export function resolveAgentConfigProviders(
  value,
  { registry = DEFAULT_PROVIDER_REGISTRY, providerConfigurations } = {},
) {
  validateAgentConfig(value, { providerRegistry: registry });
  return registry.resolveConfiguration({
    config: value,
    providerConfigurations,
  });
}

export function normalizeAgentConfig(value) {
  validateAgentConfig(value);
  return {
    schemaVersion: AGENT_CONFIG_SCHEMA_VERSION,
    instructions: {
      system: value.instructions.system,
      task: value.instructions.task,
      guardrails: [...value.instructions.guardrails],
    },
    context: { ...value.context },
    trigger: {
      ...value.trigger,
      events: [...value.trigger.events].sort(),
    },
    delegation: { ...value.delegation },
    concurrency: { ...value.concurrency },
    budgets: { ...value.budgets },
    harness: {
      ...value.harness,
      requiredCapabilities: [...value.harness.requiredCapabilities].sort(),
    },
    sandbox: {
      ...value.sandbox,
      requiredCapabilities: [...value.sandbox.requiredCapabilities].sort(),
    },
    workspaceInputs: {
      ...value.workspaceInputs,
      paths: [...value.workspaceInputs.paths].sort(),
    },
    connectionGrants: {
      maxCallsPerRun: value.connectionGrants.maxCallsPerRun,
      refs: value.connectionGrants.refs
        .map((ref) => ({ ...ref }))
        .sort(compareConnectionRefs),
    },
  };
}

export function canonicalAgentConfig(value) {
  return encodeCanonical(
    normalizeAgentConfig(value),
    "$.agentConfig",
    new Set(),
  );
}

export function encodeAgentConfig(value) {
  return new TextEncoder().encode(canonicalAgentConfig(value));
}

export function agentConfigDigest(value) {
  return `sha256:${bytesToHex(sha256Digest(canonicalAgentConfig(value)))}`;
}

export function upgradeAgentConfig(value) {
  assertPlainObject(value, "$.agentConfig");
  if (!Object.hasOwn(value, "schemaVersion")) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.MISSING_FIELD,
      "$.agentConfig.schemaVersion",
      "schema version is required before upgrade",
    );
  }
  if (!Number.isSafeInteger(value.schemaVersion)) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.INVALID_SCHEMA_VERSION,
      "$.agentConfig.schemaVersion",
      "schema version must be a safe integer",
    );
  }
  if (value.schemaVersion === AGENT_CONFIG_SCHEMA_VERSION) {
    return normalizeAgentConfig(value);
  }
  if (value.schemaVersion !== 0) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION,
      "$.agentConfig.schemaVersion",
      `schema version ${value.schemaVersion} is not supported for upgrade`,
    );
  }

  assertExactObject(value, V0_CONFIG_KEYS, "$.agentConfig.v0");
  const upgraded = {
    schemaVersion: AGENT_CONFIG_SCHEMA_VERSION,
    instructions: value.instructions,
    context: value.contextPolicy,
    trigger: value.triggerPolicy,
    delegation: value.delegationPolicy,
    concurrency: value.concurrencyPolicy,
    budgets: value.budget,
    harness: value.harness,
    sandbox: value.sandbox,
    workspaceInputs: value.workspaceInputPolicy,
    connectionGrants: value.connectionGrantRefs,
  };
  return normalizeAgentConfig(upgraded);
}

function validateInstructions(value) {
  const path = "$.agentConfig.instructions";
  assertExactObject(value, INSTRUCTION_KEYS, path);
  assertText(value.system, `${path}.system`, 1, 16_000);
  assertText(value.task, `${path}.task`, 0, 16_000);
  assertArray(value.guardrails, `${path}.guardrails`, 0, 32);
  value.guardrails.forEach((guardrail, index) =>
    assertText(guardrail, `${path}.guardrails[${index}]`, 1, 2_000),
  );
}

function validateContext(value) {
  const path = "$.agentConfig.context";
  assertExactObject(value, CONTEXT_KEYS, path);
  assertEnum(value.scope, AGENT_CONFIG_CONTEXT_SCOPES, `${path}.scope`);
  assertBoolean(value.includePrivate, `${path}.includePrivate`);
  assertBoolean(value.includeThreadHistory, `${path}.includeThreadHistory`);
  assertInteger(value.maxMessages, `${path}.maxMessages`, 0, 10_000);
  assertInteger(value.maxBytes, `${path}.maxBytes`, 0, 10_000_000);
  if (value.scope === "none") {
    if (
      value.includePrivate ||
      value.includeThreadHistory ||
      value.maxMessages !== 0 ||
      value.maxBytes !== 0
    ) {
      throw agentConfigError(
        AGENT_CONFIG_ERROR_CODES.CONTRADICTORY_POLICY,
        path,
        "scope none cannot request context or a non-zero limit",
      );
    }
  }
}

function validateTrigger(value) {
  const path = "$.agentConfig.trigger";
  assertExactObject(value, TRIGGER_KEYS, path);
  assertArray(
    value.events,
    `${path}.events`,
    1,
    AGENT_CONFIG_TRIGGER_EVENTS.length,
  );
  value.events.forEach((event, index) =>
    assertEnum(event, AGENT_CONFIG_TRIGGER_EVENTS, `${path}.events[${index}]`),
  );
  assertUnique(value.events, `${path}.events`);
  assertBoolean(value.requireMention, `${path}.requireMention`);
  assertBoolean(value.allowMessageEdits, `${path}.allowMessageEdits`);
  if (value.requireMention && !value.events.includes("mention")) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.CONTRADICTORY_POLICY,
      `${path}.requireMention`,
      "requireMention requires the mention trigger",
    );
  }
  if (value.allowMessageEdits && !value.events.includes("mention")) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.CONTRADICTORY_POLICY,
      `${path}.allowMessageEdits`,
      "message edit triggers require the mention trigger",
    );
  }
}

function validateDelegation(value, context) {
  const path = "$.agentConfig.delegation";
  assertExactObject(value, DELEGATION_KEYS, path);
  assertBoolean(value.enabled, `${path}.enabled`);
  assertInteger(value.maxDepth, `${path}.maxDepth`, 0, 8);
  assertInteger(value.maxChildren, `${path}.maxChildren`, 0, 16);
  assertBoolean(value.allowCrossChannel, `${path}.allowCrossChannel`);
  if (!value.enabled) {
    if (
      value.maxDepth !== 0 ||
      value.maxChildren !== 0 ||
      value.allowCrossChannel
    ) {
      throw agentConfigError(
        AGENT_CONFIG_ERROR_CODES.CONTRADICTORY_POLICY,
        path,
        "disabled delegation must have zero limits and cross-channel access disabled",
      );
    }
  } else if (value.maxDepth < 1 || value.maxChildren < 1) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.CONTRADICTORY_POLICY,
      path,
      "enabled delegation requires positive depth and child limits",
    );
  }
  if (value.allowCrossChannel && context.scope !== "workspace") {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.CONTRADICTORY_POLICY,
      `${path}.allowCrossChannel`,
      "cross-channel delegation requires workspace context scope",
    );
  }
}

function validateConcurrency(value) {
  const path = "$.agentConfig.concurrency";
  assertExactObject(value, CONCURRENCY_KEYS, path);
  assertInteger(value.maxConcurrentRuns, `${path}.maxConcurrentRuns`, 1, 32);
  assertInteger(
    value.maxConcurrentPerChannel,
    `${path}.maxConcurrentPerChannel`,
    1,
    8,
  );
  assertEnum(
    value.queueStrategy,
    ["parallel", "serialize"],
    `${path}.queueStrategy`,
  );
  if (value.maxConcurrentPerChannel > value.maxConcurrentRuns) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.CONTRADICTORY_POLICY,
      `${path}.maxConcurrentPerChannel`,
      "per-channel concurrency cannot exceed total concurrency",
    );
  }
  if (
    value.queueStrategy === "serialize" &&
    value.maxConcurrentPerChannel !== 1
  ) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.CONTRADICTORY_POLICY,
      `${path}.queueStrategy`,
      "serialize queues require one concurrent run per channel",
    );
  }
}

function validateBudgets(value) {
  const path = "$.agentConfig.budgets";
  assertExactObject(value, BUDGET_KEYS, path);
  assertInteger(value.timeoutSeconds, `${path}.timeoutSeconds`, 1, 86_400);
  assertInteger(value.maxInputTokens, `${path}.maxInputTokens`, 1, 1_000_000);
  assertInteger(value.maxOutputTokens, `${path}.maxOutputTokens`, 1, 1_000_000);
  assertInteger(value.maxTotalTokens, `${path}.maxTotalTokens`, 1, 2_000_000);
  assertInteger(value.maxCostUsdCents, `${path}.maxCostUsdCents`, 1, 1_000_000);
  if (
    value.maxTotalTokens < value.maxInputTokens ||
    value.maxTotalTokens < value.maxOutputTokens
  ) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.INVALID_BUDGET,
      `${path}.maxTotalTokens`,
      "total token budget must cover both input and output ceilings",
    );
  }
}

function validateProviderSelection(
  value,
  path,
  kind,
  providerRegistry,
  expectedKeys = PROVIDER_KEYS,
) {
  assertExactObject(value, expectedKeys, path);
  assertString(value.providerId, `${path}.providerId`, 2, 64);
  if (!PROVIDER_ID_PATTERN.test(value.providerId)) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.INVALID_VALUE,
      `${path}.providerId`,
      "provider id must be lowercase kebab-case",
    );
  }
  assertString(value.providerVersion, `${path}.providerVersion`, 5, 32);
  if (!PROVIDER_VERSION_PATTERN.test(value.providerVersion)) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.INVALID_VALUE,
      `${path}.providerVersion`,
      "provider version must use numeric semantic version syntax",
    );
  }
  assertArray(
    value.requiredCapabilities,
    `${path}.requiredCapabilities`,
    0,
    32,
  );
  value.requiredCapabilities.forEach((capability, index) => {
    assertString(capability, `${path}.requiredCapabilities[${index}]`, 1, 64);
    if (!CAPABILITY_PATTERN.test(capability)) {
      throw agentConfigError(
        AGENT_CONFIG_ERROR_CODES.INVALID_CAPABILITY,
        `${path}.requiredCapabilities[${index}]`,
        "capability must be lowercase kebab-case",
      );
    }
  });
  assertUnique(value.requiredCapabilities, `${path}.requiredCapabilities`);
  let provider;
  try {
    provider = providerRegistry.describe({
      kind,
      providerId: value.providerId,
      providerVersion: value.providerVersion,
    });
  } catch (error) {
    if (error.code === PROVIDER_REGISTRY_ERROR_CODES.UNKNOWN_PROVIDER) {
      throw agentConfigError(
        AGENT_CONFIG_ERROR_CODES.UNKNOWN_PROVIDER,
        `${path}.providerId`,
        "provider is not registered",
      );
    }
    if (
      error.code === PROVIDER_REGISTRY_ERROR_CODES.UNSUPPORTED_PROVIDER_VERSION
    ) {
      throw agentConfigError(
        AGENT_CONFIG_ERROR_CODES.UNSUPPORTED_PROVIDER_VERSION,
        `${path}.providerVersion`,
        "provider version is not registered",
      );
    }
    throw error;
  }
  for (const [index, capability] of value.requiredCapabilities.entries()) {
    if (!provider.capabilities.includes(capability)) {
      throw agentConfigError(
        AGENT_CONFIG_ERROR_CODES.INVALID_CAPABILITY,
        `${path}.requiredCapabilities[${index}]`,
        `capability is not supported by provider ${value.providerId}`,
      );
    }
  }
}

function validateSandbox(value, providerRegistry) {
  const path = "$.agentConfig.sandbox";
  assertExactObject(value, SANDBOX_KEYS, path);
  validateProviderSelection(
    value,
    path,
    "sandbox",
    providerRegistry,
    SANDBOX_KEYS,
  );
  assertEnum(value.lifecycle, AGENT_CONFIG_LIFECYCLES, `${path}.lifecycle`);
  assertEnum(value.networkPolicy, ["deny-all"], `${path}.networkPolicy`);
  if (!value.requiredCapabilities.includes(value.lifecycle)) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.INVALID_CAPABILITY,
      `${path}.requiredCapabilities`,
      "sandbox lifecycle must be declared as a required capability",
    );
  }
}

function validateWorkspaceInputs(value) {
  const path = "$.agentConfig.workspaceInputs";
  assertExactObject(value, WORKSPACE_INPUT_KEYS, path);
  assertEnum(
    value.source,
    ["none", "repository", "workspace"],
    `${path}.source`,
  );
  assertArray(value.paths, `${path}.paths`, 0, 32);
  value.paths.forEach((inputPath, index) => {
    assertString(inputPath, `${path}.paths[${index}]`, 1, 240);
    if (!WORKSPACE_PATH_PATTERN.test(inputPath)) {
      throw agentConfigError(
        AGENT_CONFIG_ERROR_CODES.INVALID_VALUE,
        `${path}.paths[${index}]`,
        "workspace paths must be relative, normalized, and traversal-free",
      );
    }
  });
  assertUnique(value.paths, `${path}.paths`);
  assertInteger(value.maxBytes, `${path}.maxBytes`, 0, 100_000_000);
  if (
    value.source === "none" &&
    (value.paths.length > 0 || value.maxBytes !== 0)
  ) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.CONTRADICTORY_POLICY,
      path,
      "source none cannot include paths or a byte budget",
    );
  }
  if (
    value.source !== "none" &&
    (value.paths.length === 0 || value.maxBytes === 0)
  ) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.CONTRADICTORY_POLICY,
      path,
      "a workspace source requires at least one path and a positive byte budget",
    );
  }
}

function validateConnectionGrants(value) {
  const path = "$.agentConfig.connectionGrants";
  assertExactObject(value, CONNECTION_GRANTS_KEYS, path);
  assertArray(value.refs, `${path}.refs`, 0, 32);
  const seen = new Set();
  value.refs.forEach((ref, index) => {
    const refPath = `${path}.refs[${index}]`;
    assertExactObject(ref, CONNECTION_REF_KEYS, refPath);
    assertString(ref.connectionId, `${refPath}.connectionId`, 6, 72);
    if (!CONNECTION_ID_PATTERN.test(ref.connectionId)) {
      throw agentConfigError(
        AGENT_CONFIG_ERROR_CODES.INVALID_VALUE,
        `${refPath}.connectionId`,
        "connection id must be a reference identifier",
      );
    }
    assertString(ref.grantId, `${refPath}.grantId`, 6, 72);
    if (!GRANT_ID_PATTERN.test(ref.grantId)) {
      throw agentConfigError(
        AGENT_CONFIG_ERROR_CODES.INVALID_VALUE,
        `${refPath}.grantId`,
        "grant id must be a reference identifier",
      );
    }
    assertString(ref.purpose, `${refPath}.purpose`, 1, 160);
    assertInteger(ref.revision, `${refPath}.revision`, 1, 1_000_000);
    const identity = `${ref.connectionId}\u0000${ref.grantId}\u0000${ref.revision}`;
    if (seen.has(identity)) {
      throw agentConfigError(
        AGENT_CONFIG_ERROR_CODES.DUPLICATE_VALUE,
        refPath,
        "connection grant reference is duplicated",
      );
    }
    seen.add(identity);
  });
  assertInteger(value.maxCallsPerRun, `${path}.maxCallsPerRun`, 0, 1_000);
  if (value.refs.length === 0 && value.maxCallsPerRun !== 0) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.CONTRADICTORY_POLICY,
      `${path}.maxCallsPerRun`,
      "a configuration without grants cannot make connection calls",
    );
  }
  if (value.refs.length > 0 && value.maxCallsPerRun === 0) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.CONTRADICTORY_POLICY,
      `${path}.maxCallsPerRun`,
      "granted connections require an explicit positive call ceiling",
    );
  }
}

function assertSchemaVersion(value, path, expected) {
  if (!Number.isSafeInteger(value)) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.INVALID_SCHEMA_VERSION,
      path,
      "schema version must be a safe integer",
    );
  }
  if (value !== expected) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION,
      path,
      `schema version ${value} is not supported by the current validator`,
    );
  }
}

function assertExactObject(value, expectedKeys, path) {
  assertPlainObject(value, path);
  const expected = new Set(expectedKeys);
  const enumerableKeys = new Set(Object.keys(value));
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.UNKNOWN_FIELD,
      path,
      "symbol fields are not allowed",
    );
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!enumerableKeys.has(key)) {
      throw agentConfigError(
        AGENT_CONFIG_ERROR_CODES.TYPE_MISMATCH,
        `${path}.${key}`,
        "fields must be enumerable values",
      );
    }
    if (!expected.has(key)) {
      const code = FORBIDDEN_FIELD_NAMES.has(key)
        ? AGENT_CONFIG_ERROR_CODES.FORBIDDEN_FIELD
        : AGENT_CONFIG_ERROR_CODES.UNKNOWN_FIELD;
      throw agentConfigError(
        code,
        `${path}.${key}`,
        "field is not permitted by the versioned schema",
      );
    }
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) {
      throw agentConfigError(
        AGENT_CONFIG_ERROR_CODES.MISSING_FIELD,
        `${path}.${key}`,
        "field is required",
      );
    }
  }
}

function assertPlainObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.TYPE_MISMATCH,
      path,
      "expected a plain object",
    );
  }
}

function assertArray(value, path, minLength, maxLength) {
  if (!Array.isArray(value)) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.TYPE_MISMATCH,
      path,
      "expected an array",
    );
  }
  const ownKeys = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.INVALID_VALUE,
      path,
      "arrays may not contain symbol properties",
    );
  }
  if (
    ownKeys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key)),
    )
  ) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.INVALID_VALUE,
      path,
      "arrays may not contain custom properties",
    );
  }
  if (value.length < minLength || value.length > maxLength) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.INVALID_VALUE,
      path,
      `array length must be between ${minLength} and ${maxLength}`,
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw agentConfigError(
        AGENT_CONFIG_ERROR_CODES.INVALID_VALUE,
        `${path}[${index}]`,
        "sparse arrays are not allowed",
      );
    }
  }
}

function assertString(value, path, minLength, maxLength) {
  if (typeof value !== "string") {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.TYPE_MISMATCH,
      path,
      "expected a string",
    );
  }
  if (
    value.length < minLength ||
    value.length > maxLength ||
    hasControlCharacter(value)
  ) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.INVALID_VALUE,
      path,
      `string must be between ${minLength} and ${maxLength} characters without controls`,
    );
  }
  if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.SECRET_VALUE,
      path,
      "secret-shaped values may not be persisted in agent configuration",
    );
  }
}

function assertText(value, path, minLength, maxLength) {
  assertString(value, path, minLength, maxLength);
}

function assertBoolean(value, path) {
  if (typeof value !== "boolean") {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.TYPE_MISMATCH,
      path,
      "expected a boolean",
    );
  }
}

function assertInteger(value, path, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.INVALID_VALUE,
      path,
      `integer must be between ${min} and ${max}`,
    );
  }
}

function assertEnum(value, allowed, path) {
  assertString(value, path, 1, 64);
  if (!allowed.includes(value)) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.INVALID_ENUM,
      path,
      `value must be one of: ${allowed.join(", ")}`,
    );
  }
}

function assertUnique(values, path) {
  if (new Set(values).size !== values.length) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.DUPLICATE_VALUE,
      path,
      "values must be unique",
    );
  }
}

function compareConnectionRefs(left, right) {
  for (const [leftValue, rightValue] of [
    [left.connectionId, right.connectionId],
    [left.grantId, right.grantId],
    [left.revision, right.revision],
    [left.purpose, right.purpose],
  ]) {
    const comparison = compareCodeUnits(String(leftValue), String(rightValue));
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function agentConfigError(code, path, detail) {
  const error = new AgentConfigValidationError(`${code} at ${path}: ${detail}`);
  error.name = "AgentConfigValidationError";
  error.code = code;
  error.path = path;
  error.detail = detail;
  return error;
}

function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    ) {
      return true;
    }
  }
  return false;
}

function encodeCanonical(value, path, ancestors) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw agentConfigError(
        AGENT_CONFIG_ERROR_CODES.INVALID_VALUE,
        path,
        "non-finite or unsafe numbers are not canonical JSON values",
      );
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.INVALID_VALUE,
      path,
      "only JSON values may be encoded",
    );
  }
  if (ancestors.has(value)) {
    throw agentConfigError(
      AGENT_CONFIG_ERROR_CODES.INVALID_VALUE,
      path,
      "cyclic values cannot be encoded",
    );
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item, index) => encodeCanonical(item, `${path}[${index}]`, ancestors)).join(",")}]`;
    }
    const entries = Object.entries(value).sort(([left], [right]) =>
      compareCodeUnits(left, right),
    );
    return `{${entries
      .map(
        ([key, child]) =>
          `${JSON.stringify(key)}:${encodeCanonical(child, `${path}.${key}`, ancestors)}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function sha256Digest(value) {
  const bytes = new TextEncoder().encode(value);
  const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded.set([0x80], bytes.length);
  const bitLength = bytes.length * 8;
  padded.set(
    [
      (bitLength >>> 24) & 0xff,
      (bitLength >>> 16) & 0xff,
      (bitLength >>> 8) & 0xff,
      bitLength & 0xff,
    ],
    padded.length - 4,
  );
  let state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    const words = new Uint32Array(64);
    for (let index = 0; index < 16; index += 1) {
      const offset = chunk + index * 4;
      words.set(
        [
          ((padded.at(offset) << 24) |
            (padded.at(offset + 1) << 16) |
            (padded.at(offset + 2) << 8) |
            padded.at(offset + 3)) >>>
            0,
        ],
        index,
      );
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words.at(index - 15);
      const right = words.at(index - 2);
      const s0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const s1 =
        rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words.set(
        [(words.at(index - 16) + s0 + words.at(index - 7) + s1) >>> 0],
        index,
      );
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 =
        (h + s1 + choose + constants.at(index) + words.at(index)) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    const roundState = [a, b, c, d, e, f, g, h];
    state = state.map((word, index) => (word + roundState.at(index)) >>> 0);
  }
  const digest = new Uint8Array(32);
  for (const [index, word] of state.entries()) {
    digest.set([word >>> 24, word >>> 16, word >>> 8, word], index * 4);
  }
  return digest;
}

function rotateRight(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
