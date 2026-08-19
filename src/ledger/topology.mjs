import { assertIdentifier, workspaceIdFromScopedIdentifier } from "./identifiers.mjs";
import { LEDGER_ERROR_CODES, fail } from "./errors.mjs";

const WORKSPACE_STREAM_PATTERN = /^workspace:([^/]+)\/(directory|invocations|audit)$/;
const RESOURCE_STREAM_PATTERNS = Object.freeze([
  { kind: "channel", pattern: /^channel:([^/]+)$/, idKind: "channel" },
  { kind: "agentConfig", pattern: /^agent:([^/]+)\/config$/, idKind: "agent" },
  { kind: "run", pattern: /^run:([^/]+)$/, idKind: "run" },
  { kind: "connectionConfig", pattern: /^connection:([^/]+)\/config$/, idKind: "connection" },
  { kind: "projection", pattern: /^projection:([^/]+)$/, idKind: "projection" },
]);

export const STREAM_TOPOLOGY_V1 = Object.freeze({
  workspaceDirectory: "workspace:<workspaceId>/directory",
  channel: "channel:<channelId>",
  agentConfig: "agent:<agentId>/config",
  workspaceInvocations: "workspace:<workspaceId>/invocations",
  run: "run:<runId>",
  connectionConfig: "connection:<connectionId>/config",
  workspaceAudit: "workspace:<workspaceId>/audit",
  projection: "projection:<projectionId>",
});

export const streamNames = Object.freeze({
  workspaceDirectory(workspaceId) {
    assertIdentifier("workspace", workspaceId, { path: "$.workspaceId" });
    return `workspace:${workspaceId}/directory`;
  },

  channel(workspaceId, channelId) {
    assertIdentifier("workspace", workspaceId, { path: "$.workspaceId" });
    assertIdentifier("channel", channelId, { path: "$.channelId", workspaceId });
    return `channel:${channelId}`;
  },

  agentConfig(workspaceId, agentId) {
    assertIdentifier("workspace", workspaceId, { path: "$.workspaceId" });
    assertIdentifier("agent", agentId, { path: "$.agentId", workspaceId });
    return `agent:${agentId}/config`;
  },

  workspaceInvocations(workspaceId) {
    assertIdentifier("workspace", workspaceId, { path: "$.workspaceId" });
    return `workspace:${workspaceId}/invocations`;
  },

  run(workspaceId, runId) {
    assertIdentifier("workspace", workspaceId, { path: "$.workspaceId" });
    assertIdentifier("run", runId, { path: "$.runId", workspaceId });
    return `run:${runId}`;
  },

  connectionConfig(workspaceId, connectionId) {
    assertIdentifier("workspace", workspaceId, { path: "$.workspaceId" });
    assertIdentifier("connection", connectionId, { path: "$.connectionId", workspaceId });
    return `connection:${connectionId}/config`;
  },

  workspaceAudit(workspaceId) {
    assertIdentifier("workspace", workspaceId, { path: "$.workspaceId" });
    return `workspace:${workspaceId}/audit`;
  },

  projection(workspaceId, projectionId) {
    assertIdentifier("workspace", workspaceId, { path: "$.workspaceId" });
    assertIdentifier("projection", projectionId, { path: "$.projectionId", workspaceId });
    return `projection:${projectionId}`;
  },
});

export function parseStreamName(stream, { expectedWorkspaceId, path = "$.stream" } = {}) {
  if (typeof stream !== "string") {
    fail(LEDGER_ERROR_CODES.INVALID_STREAM_NAME, path, "stream name must be a string");
  }

  const workspaceMatch = stream.match(WORKSPACE_STREAM_PATTERN);
  if (workspaceMatch) {
    const workspaceId = workspaceMatch[1];
    assertIdentifier("workspace", workspaceId, { path });
    assertExpectedWorkspace(workspaceId, expectedWorkspaceId, path);
    const suffixKind = {
      directory: "workspaceDirectory",
      invocations: "workspaceInvocations",
      audit: "workspaceAudit",
    }[workspaceMatch[2]];
    return Object.freeze({ kind: suffixKind, workspaceId, resourceId: null, stream });
  }

  for (const definition of RESOURCE_STREAM_PATTERNS) {
    const match = stream.match(definition.pattern);
    if (!match) continue;
    const resourceId = match[1];
    assertIdentifier(definition.idKind, resourceId, { path });
    const workspaceId = workspaceIdFromScopedIdentifier(definition.idKind, resourceId, path);
    assertExpectedWorkspace(workspaceId, expectedWorkspaceId, path);
    return Object.freeze({ kind: definition.kind, workspaceId, resourceId, stream });
  }

  fail(LEDGER_ERROR_CODES.INVALID_STREAM_NAME, path, "stream name is not canonical topology v1");
}

function assertExpectedWorkspace(actualWorkspaceId, expectedWorkspaceId, path) {
  if (expectedWorkspaceId === undefined) return;
  assertIdentifier("workspace", expectedWorkspaceId, { path: "$.workspaceId" });
  if (actualWorkspaceId !== expectedWorkspaceId) {
    fail(
      LEDGER_ERROR_CODES.WORKSPACE_SCOPE_MISMATCH,
      path,
      "stream belongs to a different workspace",
    );
  }
}
