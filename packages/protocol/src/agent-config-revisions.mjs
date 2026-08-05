import { sha256Digest } from "./sha256.mjs";
import { normalizeAgentConfig, agentConfigDigest } from "./agent-config.mjs";
import { validateWorkspaceId } from "./principals.mjs";

export const AGENT_CONFIG_REVISION_SCHEMA_VERSION = 1;

export const AGENT_CONFIG_REVISION_EVENT_TYPES_V1 = Object.freeze([
  "agent.config.created",
  "agent.config.revised",
  "agent.config.activated",
  "agent.config.disabled",
  "agent.config.retired",
]);

export const AGENT_CONFIG_REVISION_STATUSES = Object.freeze([
  "draft",
  "active",
  "disabled",
  "retired",
]);

export const AGENT_CONFIG_REVISION_ERROR_CODES = Object.freeze({
  INVALID_AGENT_ID: "AGENT_CONFIG_REVISION_INVALID_AGENT_ID",
  INVALID_DATA: "AGENT_CONFIG_REVISION_INVALID_DATA",
  INVALID_DIGEST: "AGENT_CONFIG_REVISION_INVALID_DIGEST",
  INVALID_EVENT_TYPE: "AGENT_CONFIG_REVISION_INVALID_EVENT_TYPE",
  INVALID_REVISION: "AGENT_CONFIG_REVISION_INVALID_REVISION",
  INVALID_REVISION_ID: "AGENT_CONFIG_REVISION_INVALID_REVISION_ID",
  REVISION_ID_MISMATCH: "AGENT_CONFIG_REVISION_ID_MISMATCH",
});

const ID_TOKEN_PATTERN = "[0-9a-hjkmnp-tv-z]{26}";
const AGENT_ID_PATTERN = new RegExp(
  `^ag_(${ID_TOKEN_PATTERN})_(${ID_TOKEN_PATTERN})$`,
  "u",
);
const REVISION_ID_PATTERN = /^acr_[0-9a-f]{64}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

const REVISION_DATA_KEYS = [
  "agentId",
  "config",
  "configDigest",
  "expectedRevision",
  "expectedRevisionId",
  "predecessorRevisionId",
  "revision",
  "revisionId",
];
const ACTIVATION_DATA_KEYS = [
  "agentId",
  "expectedRevision",
  "expectedRevisionId",
  "revisionId",
];
const LIFECYCLE_DATA_KEYS = [
  "agentId",
  "expectedRevision",
  "expectedRevisionId",
];

export class AgentConfigRevisionValidationError extends Error {
  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      name: this.name,
      path: this.path,
    };
  }
}

export function validateAgentConfigAgentId(
  value,
  { expectedWorkspaceId, path = "$.agentId" } = {},
) {
  if (typeof value !== "string") {
    throw revisionError(
      AGENT_CONFIG_REVISION_ERROR_CODES.INVALID_AGENT_ID,
      path,
      "agent id must be a string",
    );
  }
  const match = value.match(AGENT_ID_PATTERN);
  if (!match) {
    throw revisionError(
      AGENT_CONFIG_REVISION_ERROR_CODES.INVALID_AGENT_ID,
      path,
      "agent id must be a workspace-scoped immutable agent identifier",
    );
  }
  if (expectedWorkspaceId !== undefined) {
    validateWorkspaceId(expectedWorkspaceId);
    if (`ws_${match[1]}` !== expectedWorkspaceId) {
      throw revisionError(
        AGENT_CONFIG_REVISION_ERROR_CODES.INVALID_AGENT_ID,
        path,
        "agent id belongs to a different workspace",
      );
    }
  }
  return value;
}

export function workspaceIdFromAgentConfigAgentId(value, path = "$.agentId") {
  validateAgentConfigAgentId(value, { path });
  return `ws_${value.slice(3, 29)}`;
}

export function validateAgentConfigRevisionId(value, path = "$.revisionId") {
  if (typeof value !== "string" || !REVISION_ID_PATTERN.test(value)) {
    throw revisionError(
      AGENT_CONFIG_REVISION_ERROR_CODES.INVALID_REVISION_ID,
      path,
      "revision id must be an acr_ sha-256 identity",
    );
  }
  return value;
}

export function validateAgentConfigDigest(value, path = "$.configDigest") {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw revisionError(
      AGENT_CONFIG_REVISION_ERROR_CODES.INVALID_DIGEST,
      path,
      "config digest must be a lowercase sha-256 reference",
    );
  }
  return value;
}

export function agentConfigRevisionId({ agentId, revision, configDigest }) {
  validateAgentConfigAgentId(agentId);
  assertPositiveRevision(revision, "$.revision");
  validateAgentConfigDigest(configDigest);
  const identity = `${agentId}\u0000${revision}\u0000${configDigest}`;
  return `acr_${bytesToHex(sha256Digest(identity))}`;
}

export function validateAgentConfigRevisionEventData(
  eventType,
  value,
  { expectedWorkspaceId, path = "$.event.data" } = {},
) {
  if (!AGENT_CONFIG_REVISION_EVENT_TYPES_V1.includes(eventType)) {
    throw revisionError(
      AGENT_CONFIG_REVISION_ERROR_CODES.INVALID_EVENT_TYPE,
      `${path}.eventType`,
      "event type is not registered for agent configuration revisions",
    );
  }

  const keys =
    eventType === "agent.config.created" || eventType === "agent.config.revised"
      ? REVISION_DATA_KEYS
      : eventType === "agent.config.activated"
        ? ACTIVATION_DATA_KEYS
        : LIFECYCLE_DATA_KEYS;
  assertExactObject(value, keys, path);
  validateAgentConfigAgentId(value.agentId, {
    expectedWorkspaceId,
    path: `${path}.agentId`,
  });
  assertExpectedRevision(value.expectedRevision, `${path}.expectedRevision`);

  const expectedRevisionId = validateNullableRevisionId(
    value.expectedRevisionId,
    `${path}.expectedRevisionId`,
  );

  if (
    eventType === "agent.config.created" ||
    eventType === "agent.config.revised"
  ) {
    const config = normalizeAgentConfig(value.config);
    const configDigest = validateAgentConfigDigest(
      value.configDigest,
      `${path}.configDigest`,
    );
    if (agentConfigDigest(config) !== configDigest) {
      throw revisionError(
        AGENT_CONFIG_REVISION_ERROR_CODES.INVALID_DIGEST,
        `${path}.configDigest`,
        "config digest does not match canonical config bytes",
      );
    }

    assertPositiveRevision(value.revision, `${path}.revision`);
    if (value.revision !== value.expectedRevision + 1) {
      throw revisionError(
        AGENT_CONFIG_REVISION_ERROR_CODES.INVALID_REVISION,
        `${path}.revision`,
        "revision must be exactly one greater than expectedRevision",
      );
    }

    const predecessorRevisionId = validateNullableRevisionId(
      value.predecessorRevisionId,
      `${path}.predecessorRevisionId`,
    );
    if (predecessorRevisionId !== expectedRevisionId) {
      throw revisionError(
        AGENT_CONFIG_REVISION_ERROR_CODES.INVALID_DATA,
        `${path}.predecessorRevisionId`,
        "predecessorRevisionId must equal expectedRevisionId",
      );
    }
    if (eventType === "agent.config.created" && value.expectedRevision !== 0) {
      throw revisionError(
        AGENT_CONFIG_REVISION_ERROR_CODES.INVALID_REVISION,
        `${path}.expectedRevision`,
        "create must expect revision zero",
      );
    }
    if (eventType === "agent.config.created" && expectedRevisionId !== null) {
      throw revisionError(
        AGENT_CONFIG_REVISION_ERROR_CODES.INVALID_DATA,
        `${path}.expectedRevisionId`,
        "create must not name a predecessor revision",
      );
    }
    if (eventType === "agent.config.revised" && expectedRevisionId === null) {
      throw revisionError(
        AGENT_CONFIG_REVISION_ERROR_CODES.INVALID_DATA,
        `${path}.expectedRevisionId`,
        "revise must name its predecessor revision",
      );
    }

    const revisionId = validateAgentConfigRevisionId(
      value.revisionId,
      `${path}.revisionId`,
    );
    if (
      revisionId !==
      agentConfigRevisionId({
        agentId: value.agentId,
        revision: value.revision,
        configDigest,
      })
    ) {
      throw revisionError(
        AGENT_CONFIG_REVISION_ERROR_CODES.REVISION_ID_MISMATCH,
        `${path}.revisionId`,
        "revision id does not match its agent, revision, and config digest",
      );
    }

    return {
      ...value,
      config,
      configDigest,
      expectedRevisionId,
      predecessorRevisionId,
      revisionId,
    };
  }

  if (eventType === "agent.config.activated") {
    return {
      ...value,
      expectedRevisionId,
      revisionId: validateAgentConfigRevisionId(
        value.revisionId,
        `${path}.revisionId`,
      ),
    };
  }

  return {
    ...value,
    expectedRevisionId,
  };
}

function validateNullableRevisionId(value, path) {
  if (value === null) return null;
  return validateAgentConfigRevisionId(value, path);
}

function assertExpectedRevision(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw revisionError(
      AGENT_CONFIG_REVISION_ERROR_CODES.INVALID_REVISION,
      path,
      "expected revision must be a non-negative safe integer",
    );
  }
}

function assertPositiveRevision(value, path) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw revisionError(
      AGENT_CONFIG_REVISION_ERROR_CODES.INVALID_REVISION,
      path,
      "revision must be a positive safe integer",
    );
  }
}

function assertExactObject(value, keys, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw revisionError(
      AGENT_CONFIG_REVISION_ERROR_CODES.INVALID_DATA,
      path,
      "event data must be a plain object",
    );
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw revisionError(
        AGENT_CONFIG_REVISION_ERROR_CODES.INVALID_DATA,
        path,
        "event data contains an unknown field",
      );
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      throw revisionError(
        AGENT_CONFIG_REVISION_ERROR_CODES.INVALID_DATA,
        `${path}.${key}`,
        "field is required",
      );
    }
  }
}

function revisionError(code, path, detail) {
  const error = new AgentConfigRevisionValidationError(
    `${code} at ${path}: ${detail}`,
  );
  error.name = "AgentConfigRevisionValidationError";
  error.code = code;
  error.path = path;
  error.detail = detail;
  return error;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
