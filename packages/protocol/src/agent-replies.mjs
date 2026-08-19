import { validateAgentConfigAgentId } from "./agent-config-revisions.mjs";
import { validateChannelId } from "./channels.mjs";
import { assertSourceReference } from "./invocation-run.mjs";
import { validatePrincipalId, validateWorkspaceId } from "./principals.mjs";

export const AGENT_REPLY_SCHEMA_VERSION = 1;

export const AGENT_REPLY_ERROR_CODES = Object.freeze({
  ACTOR_MISMATCH: "AGENT_REPLY_ACTOR_MISMATCH",
  CONTEXT_INVALID: "AGENT_REPLY_CONTEXT_INVALID",
  INVALID_PROVENANCE: "AGENT_REPLY_INVALID_PROVENANCE",
  INVOCATION_INVALID: "AGENT_REPLY_INVOCATION_INVALID",
  SNAPSHOT_INVALID: "AGENT_REPLY_SNAPSHOT_INVALID",
  SOURCE_INVALID: "AGENT_REPLY_SOURCE_INVALID",
});

const PROVENANCE_KEYS = Object.freeze([
  "agentId",
  "agentPrincipalId",
  "attemptId",
  "channelId",
  "contextDigest",
  "contextRef",
  "invocationId",
  "invocationRef",
  "leaseGeneration",
  "runId",
  "schemaVersion",
  "snapshotDigest",
  "snapshotRef",
  "sourceMention",
  "threadRootMessageId",
]);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;
const RUN_PATTERN = /^rn_[0-9a-hjkmnp-tv-z]{26}_[0-9a-hjkmnp-tv-z]{26}$/u;

export class AgentReplyProtocolError extends Error {
  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      name: this.name,
      path: this.path,
    };
  }
}

export function validateAgentReplyProvenance(
  value,
  {
    expectedAgentId,
    expectedAgentPrincipalId,
    expectedChannelId,
    expectedWorkspaceId,
  } = {},
) {
  try {
    validateWorkspaceId(expectedWorkspaceId);
    assertPlain(value, "$.agentReplyProvenance");
    assertExactKeys(value, PROVENANCE_KEYS, "$.agentReplyProvenance");
    if (value.schemaVersion !== AGENT_REPLY_SCHEMA_VERSION) {
      fail(
        AGENT_REPLY_ERROR_CODES.INVALID_PROVENANCE,
        "$.agentReplyProvenance.schemaVersion",
        "unsupported agent reply provenance schema",
      );
    }
    validateAgentConfigAgentId(value.agentId, {
      expectedWorkspaceId,
      path: "$.agentReplyProvenance.agentId",
    });
    validatePrincipalId(value.agentPrincipalId, {
      expectedWorkspaceId,
      path: "$.agentReplyProvenance.agentPrincipalId",
    });
    validateChannelId(value.channelId, {
      expectedWorkspaceId,
      path: "$.agentReplyProvenance.channelId",
    });
    assertToken(value.attemptId, "$.agentReplyProvenance.attemptId");
    assertToken(value.invocationId, "$.agentReplyProvenance.invocationId");
    if (!RUN_PATTERN.test(value.runId)) {
      fail(
        AGENT_REPLY_ERROR_CODES.INVALID_PROVENANCE,
        "$.agentReplyProvenance.runId",
        "runId is not a workspace-scoped run identifier",
      );
    }
    if (
      !Number.isSafeInteger(value.leaseGeneration) ||
      value.leaseGeneration < 1
    ) {
      fail(
        AGENT_REPLY_ERROR_CODES.INVALID_PROVENANCE,
        "$.agentReplyProvenance.leaseGeneration",
        "leaseGeneration must be a positive integer",
      );
    }
    assertMessageId(
      value.threadRootMessageId,
      "$.agentReplyProvenance.threadRootMessageId",
    );
    assertDigest(value.contextDigest, "$.agentReplyProvenance.contextDigest");
    assertDigest(value.snapshotDigest, "$.agentReplyProvenance.snapshotDigest");
    assertSourceReference(
      value.contextRef,
      "$.agentReplyProvenance.contextRef",
      expectedWorkspaceId,
    );
    assertSourceReference(
      value.invocationRef,
      "$.agentReplyProvenance.invocationRef",
      expectedWorkspaceId,
    );
    assertSourceReference(
      value.snapshotRef,
      "$.agentReplyProvenance.snapshotRef",
      expectedWorkspaceId,
    );
    assertSourceReference(
      value.sourceMention,
      "$.agentReplyProvenance.sourceMention",
      expectedWorkspaceId,
      { channelOnly: true },
    );
    if (
      value.invocationRef.stream !==
      `workspace:${expectedWorkspaceId}/invocations`
    ) {
      fail(
        AGENT_REPLY_ERROR_CODES.INVOCATION_INVALID,
        "$.agentReplyProvenance.invocationRef.stream",
        "invocationRef must cite the workspace invocation stream",
      );
    }
    if (value.snapshotRef.stream !== `agent:${value.agentId}/config`) {
      fail(
        AGENT_REPLY_ERROR_CODES.SNAPSHOT_INVALID,
        "$.agentReplyProvenance.snapshotRef.stream",
        "snapshotRef must cite the bound agent configuration stream",
      );
    }
    if (value.sourceMention.stream !== `channel:${value.channelId}`) {
      fail(
        AGENT_REPLY_ERROR_CODES.SOURCE_INVALID,
        "$.agentReplyProvenance.sourceMention.stream",
        "sourceMention must cite the reply channel stream",
      );
    }
    if (expectedAgentId !== undefined && value.agentId !== expectedAgentId) {
      fail(
        AGENT_REPLY_ERROR_CODES.INVOCATION_INVALID,
        "$.agentReplyProvenance.agentId",
        "provenance agent does not match the leased invocation",
      );
    }
    if (
      expectedAgentPrincipalId !== undefined &&
      value.agentPrincipalId !== expectedAgentPrincipalId
    ) {
      fail(
        AGENT_REPLY_ERROR_CODES.ACTOR_MISMATCH,
        "$.agentReplyProvenance.agentPrincipalId",
        "provenance actor does not match the active agent principal",
      );
    }
    if (
      expectedChannelId !== undefined &&
      value.channelId !== expectedChannelId
    ) {
      fail(
        AGENT_REPLY_ERROR_CODES.SOURCE_INVALID,
        "$.agentReplyProvenance.channelId",
        "provenance channel does not match the source mention",
      );
    }
    return value;
  } catch (error) {
    if (error instanceof AgentReplyProtocolError) throw error;
    const wrapped = new AgentReplyProtocolError(
      error?.code ?? AGENT_REPLY_ERROR_CODES.INVALID_PROVENANCE,
      error?.detail ?? (error instanceof Error ? error.message : String(error)),
    );
    wrapped.path = error?.path ?? "$.agentReplyProvenance";
    throw wrapped;
  }
}

export function agentReplyProvenanceKeys() {
  return [...PROVENANCE_KEYS];
}

function assertDigest(value, path) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    fail(
      AGENT_REPLY_ERROR_CODES.INVALID_PROVENANCE,
      path,
      "value must be a sha256 digest",
    );
  }
}

function assertMessageId(value, path) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    fail(
      AGENT_REPLY_ERROR_CODES.INVALID_PROVENANCE,
      path,
      "value must be a bounded message id",
    );
  }
}

function assertToken(value, path) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    fail(
      AGENT_REPLY_ERROR_CODES.INVALID_PROVENANCE,
      path,
      "value must be a bounded token",
    );
  }
}

function assertPlain(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(
      AGENT_REPLY_ERROR_CODES.INVALID_PROVENANCE,
      path,
      "value must be an object",
    );
  }
}

function assertExactKeys(value, keys, path) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(
        AGENT_REPLY_ERROR_CODES.INVALID_PROVENANCE,
        `${path}.${key}`,
        "field is not allowed",
      );
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      fail(
        AGENT_REPLY_ERROR_CODES.INVALID_PROVENANCE,
        `${path}.${key}`,
        "field is required",
      );
    }
  }
}

function fail(code, path, detail) {
  const error = new AgentReplyProtocolError(`${code} at ${path}: ${detail}`);
  error.code = code;
  error.path = path;
  error.detail = detail;
  throw error;
}
