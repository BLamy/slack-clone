import {
  AGENT_CONFIG_CONTEXT_SCOPES,
  resolveAgentConfigProviders,
  validateAgentConfig,
} from "./agent-config.mjs";
import {
  agentConfigRevisionId,
  validateAgentConfigAgentId,
  workspaceIdFromAgentConfigAgentId,
} from "./agent-config-revisions.mjs";
import { validateChannelId } from "./channels.mjs";
import { sha256Digest } from "./sha256.mjs";
import { validatePrincipalId } from "./principals.mjs";
import { membershipIdFor } from "./workspace.mjs";

export const INVOCATION_SNAPSHOT_SCHEMA_VERSION = 1;
export const INVOCATION_SNAPSHOT_KIND = "invocation-snapshot";

export const INVOCATION_SNAPSHOT_ERROR_CODES = Object.freeze({
  AGENT_CONFIG_INACTIVE: "INVOCATION_SNAPSHOT_AGENT_CONFIG_INACTIVE",
  AGENT_CONFIG_MISSING: "INVOCATION_SNAPSHOT_AGENT_CONFIG_MISSING",
  AGENT_CONFIG_INVALID: "INVOCATION_SNAPSHOT_AGENT_CONFIG_INVALID",
  BUDGET_EXCEEDED: "INVOCATION_SNAPSHOT_BUDGET_EXCEEDED",
  CHANNEL_MEMBERSHIP_INACTIVE:
    "INVOCATION_SNAPSHOT_CHANNEL_MEMBERSHIP_INACTIVE",
  CONNECTION_GRANT_EXPIRED: "INVOCATION_SNAPSHOT_CONNECTION_GRANT_EXPIRED",
  CONNECTION_GRANT_MISSING: "INVOCATION_SNAPSHOT_CONNECTION_GRANT_MISSING",
  CONNECTION_GRANT_REVOKED: "INVOCATION_SNAPSHOT_CONNECTION_GRANT_REVOKED",
  CONNECTION_GRANT_SCOPE_MISMATCH:
    "INVOCATION_SNAPSHOT_CONNECTION_GRANT_SCOPE_MISMATCH",
  CONNECTION_GRANT_REVISION_MISMATCH:
    "INVOCATION_SNAPSHOT_CONNECTION_GRANT_REVISION_MISMATCH",
  CONTEXT_SCOPE_MISMATCH: "INVOCATION_SNAPSHOT_CONTEXT_SCOPE_MISMATCH",
  INVALID_INPUT: "INVOCATION_SNAPSHOT_INVALID_INPUT",
  INVALID_SNAPSHOT: "INVOCATION_SNAPSHOT_INVALID",
  MEMBERSHIP_INACTIVE: "INVOCATION_SNAPSHOT_MEMBERSHIP_INACTIVE",
  MEMBERSHIP_MISSING: "INVOCATION_SNAPSHOT_MEMBERSHIP_MISSING",
  PROVIDER_RESOLUTION_REFUSED:
    "INVOCATION_SNAPSHOT_PROVIDER_RESOLUTION_REFUSED",
  SECRET_VALUE: "INVOCATION_SNAPSHOT_SECRET_VALUE",
  SNAPSHOT_DIGEST_MISMATCH: "INVOCATION_SNAPSHOT_DIGEST_MISMATCH",
  STALE_CONFIG: "INVOCATION_SNAPSHOT_STALE_CONFIG",
  STALE_CONTEXT: "INVOCATION_SNAPSHOT_STALE_CONTEXT",
  STALE_GRANT: "INVOCATION_SNAPSHOT_STALE_GRANT",
  STALE_MEMBERSHIP: "INVOCATION_SNAPSHOT_STALE_MEMBERSHIP",
  STALE_PROVIDER: "INVOCATION_SNAPSHOT_STALE_PROVIDER",
  STALE_SOURCE: "INVOCATION_SNAPSHOT_STALE_SOURCE",
  STALE_WORKSPACE_INPUT: "INVOCATION_SNAPSHOT_STALE_WORKSPACE_INPUT",
  WORKSPACE_INPUT_INVALID: "INVOCATION_SNAPSHOT_WORKSPACE_INPUT_INVALID",
});

const SOURCE_OFFSET_PATTERN = /^\d{16}_[0-9a-f]{16}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REVISION_ID_PATTERN = /^acr_[0-9a-f]{64}$/u;
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
const FORBIDDEN_SNAPSHOT_KEYS = new Set([
  "__proto__",
  "apiKey",
  "credentials",
  "env",
  "environment",
  "password",
  "providerConfiguration",
  "secret",
  "secrets",
  "token",
  "tokens",
]);

const SNAPSHOT_PAYLOAD_KEYS = Object.freeze([
  "agentId",
  "budget",
  "config",
  "connectionGrants",
  "context",
  "kind",
  "membership",
  "providers",
  "resolvedAt",
  "schemaVersion",
  "sourceManifest",
  "workspaceId",
  "workspaceInputs",
]);
const SNAPSHOT_KEYS = Object.freeze([
  ...SNAPSHOT_PAYLOAD_KEYS,
  "snapshotDigest",
]);

export class InvocationSnapshotError extends Error {
  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      name: this.name,
      path: this.path,
      sourceCode: this.sourceCode ?? null,
    };
  }
}

export function createInvocationSnapshot(input = {}) {
  const payload = resolveInvocationSnapshotPayload(input);
  scanForForbiddenSnapshotValues(payload, "$.snapshot");
  const snapshot = {
    ...payload,
    snapshotDigest: invocationSnapshotDigest(payload),
  };
  return freezeDeep(snapshot);
}

export function resolveInvocationSnapshotPayload(input = {}) {
  const {
    agentId,
    budgetUsage = null,
    channelMembership = null,
    configState,
    context,
    connectionGrants = [],
    now = 0,
    principal,
    providerConfigurations,
    providerRegistry,
    sourceHeads,
    workspaceInputManifest,
    workspaceMembership,
  } = input;

  requireClock(now, "$.now");
  const normalizedAgentId = requireAgentId(agentId, "$.agentId");
  const workspaceId = workspaceIdFromAgentConfigAgentId(normalizedAgentId);
  if (
    !providerRegistry ||
    typeof providerRegistry.resolveConfiguration !== "function"
  ) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.PROVIDER_RESOLUTION_REFUSED,
      "$.providerRegistry",
      "provider registry is required for snapshot resolution",
    );
  }
  const sources = resolveSourceHeads(
    sourceHeads,
    workspaceId,
    normalizedAgentId,
  );
  const configResult = resolveConfigRevision({
    agentId: normalizedAgentId,
    configState,
    source: sources.config,
    workspaceId,
  });
  const normalizedPrincipal = resolvePrincipal(
    principal,
    normalizedAgentId,
    workspaceId,
  );
  const membership = resolveWorkspaceMembership(
    workspaceMembership,
    normalizedAgentId,
    workspaceId,
  );
  const resolvedContext = resolveContext({
    channelMembership,
    context,
    configContext: configResult.config.context,
    principalId: normalizedPrincipal.principalId,
    workspaceId,
  });
  const grants = resolveConnectionGrants({
    config: configResult.config,
    connectionGrants,
    now,
    workspaceId,
    agentId: normalizedAgentId,
  });
  const inputs = resolveWorkspaceInputs({
    config: configResult.config,
    directorySource: sources.directory,
    manifest: workspaceInputManifest,
    workspaceId,
  });
  const budget = resolveBudget(configResult.config.budgets, budgetUsage);
  const providers = resolveProviders({
    config: configResult.config,
    providerConfigurations,
    providerRegistry,
  });
  const sourceManifest = {
    config: sources.config,
    directory: sources.directory,
    providers: {
      manifestDigest: providers.manifestDigest,
      resolvedProviderDigest: providers.resolvedProviderDigest,
    },
    workspaceInputs: inputs.source,
    connectionGrants: grants.refs.map(({ source }) => source),
  };

  return {
    agentId: normalizedAgentId,
    budget,
    config: {
      activeRevisionId: configResult.revision.revisionId,
      agentConfig: configResult.config,
      agentId: normalizedAgentId,
      configDigest: configResult.revision.configDigest,
      revision: configResult.revision.revision,
      sourceOffset: configResult.revision.sourceOffset,
      sourceStateDigest: sources.config.stateDigest,
      status: "active",
    },
    connectionGrants: grants,
    context: resolvedContext,
    kind: INVOCATION_SNAPSHOT_KIND,
    membership,
    providers: {
      compatibility: providers.compatibility,
      harness: providers.harness,
      manifestDigest: providers.manifestDigest,
      resolvedProviderDigest: providers.resolvedProviderDigest,
      sandbox: providers.sandbox,
    },
    resolvedAt: now,
    schemaVersion: INVOCATION_SNAPSHOT_SCHEMA_VERSION,
    sourceManifest,
    workspaceId,
    workspaceInputs: inputs.value,
  };
}

export function authorizeInvocationSnapshotUse(input = {}) {
  const decision = checkInvocationSnapshotUse(input);
  if (!decision.allowed) {
    throw snapshotError(
      decision.code,
      "$.snapshot",
      decision.detail,
      decision.sourceCode,
    );
  }
  return decision;
}

export function checkInvocationSnapshotUse(input = {}) {
  const { snapshot, ...currentInput } = input;
  let historical;
  try {
    historical = replayInvocationSnapshot(snapshot);
  } catch (error) {
    return deniedDecision(error);
  }

  const nextInput = { ...currentInput };
  if (!Object.hasOwn(nextInput, "budgetUsage")) {
    nextInput.budgetUsage = historical.budget.usage;
  }
  if (!Object.hasOwn(nextInput, "context")) {
    nextInput.context = historical.context;
  }
  let current;
  try {
    current = resolveInvocationSnapshotPayload(nextInput);
  } catch (error) {
    return deniedDecision(error);
  }

  const historicalPayload = snapshotPayload(historical);
  const comparisons = [
    {
      code: INVOCATION_SNAPSHOT_ERROR_CODES.STALE_CONFIG,
      current: current.config,
      historical: historicalPayload.config,
      key: "config",
    },
    {
      code: INVOCATION_SNAPSHOT_ERROR_CODES.STALE_PROVIDER,
      current: current.providers,
      historical: historicalPayload.providers,
      key: "providers",
    },
    {
      code: INVOCATION_SNAPSHOT_ERROR_CODES.STALE_MEMBERSHIP,
      current: current.membership,
      historical: historicalPayload.membership,
      key: "membership",
    },
    {
      code: INVOCATION_SNAPSHOT_ERROR_CODES.STALE_CONTEXT,
      current: current.context,
      historical: historicalPayload.context,
      key: "context",
    },
    {
      code: INVOCATION_SNAPSHOT_ERROR_CODES.BUDGET_EXCEEDED,
      current: current.budget,
      historical: historicalPayload.budget,
      key: "budget",
    },
    {
      code: INVOCATION_SNAPSHOT_ERROR_CODES.STALE_WORKSPACE_INPUT,
      current: current.workspaceInputs,
      historical: historicalPayload.workspaceInputs,
      key: "workspaceInputs",
    },
    {
      code: INVOCATION_SNAPSHOT_ERROR_CODES.STALE_GRANT,
      current: current.connectionGrants,
      historical: historicalPayload.connectionGrants,
      key: "connectionGrants",
    },
    {
      code: INVOCATION_SNAPSHOT_ERROR_CODES.STALE_SOURCE,
      current: current.sourceManifest,
      historical: historicalPayload.sourceManifest,
      key: "sourceManifest",
    },
  ];
  for (const comparison of comparisons) {
    if (
      canonicalize(comparison.historical) !== canonicalize(comparison.current)
    ) {
      return deniedDecision(
        snapshotError(
          comparison.code,
          `$.snapshot.${comparison.key}`,
          `${comparison.key} changed after snapshot creation`,
        ),
      );
    }
  }
  return {
    allowed: true,
    currentResolvedAt: current.resolvedAt,
    snapshotDigest: historical.snapshotDigest,
  };
}

export function replayInvocationSnapshot(value) {
  assertSnapshotShape(value);
  const expected = invocationSnapshotDigest(value);
  if (value.snapshotDigest !== expected) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.SNAPSHOT_DIGEST_MISMATCH,
      "$.snapshotDigest",
      "snapshot digest does not match canonical snapshot bytes",
    );
  }
  return freezeDeep(structuredClone(value));
}

export function canonicalInvocationSnapshot(value) {
  return canonicalize(snapshotPayload(value));
}

export function encodeInvocationSnapshot(value) {
  return new TextEncoder().encode(canonicalInvocationSnapshot(value));
}

export function invocationSnapshotDigest(value) {
  return digestCanonical(snapshotPayload(value));
}

function resolveConfigRevision({ agentId, configState, source, workspaceId }) {
  if (!isRecord(configState)) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.AGENT_CONFIG_MISSING,
      "$.configState",
      "authoritative agent configuration state is required",
    );
  }
  if (configState.status !== "active" || configState.runnable !== true) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.AGENT_CONFIG_INACTIVE,
      "$.configState.status",
      "agent configuration is not active and runnable",
    );
  }
  if (
    !Array.isArray(configState.revisions) ||
    typeof configState.activeRevisionId !== "string"
  ) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.AGENT_CONFIG_MISSING,
      "$.configState.revisions",
      "active configuration revision history is required",
    );
  }
  const revision = configState.revisions.find(
    ({ revisionId }) => revisionId === configState.activeRevisionId,
  );
  if (!revision) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.AGENT_CONFIG_MISSING,
      "$.configState.activeRevisionId",
      "active revision is not present in the immutable revision history",
    );
  }
  requireAgentId(revision.agentId, "$.configState.revisions[].agentId");
  if (
    revision.agentId !== agentId ||
    revision.workspaceId !== workspaceId ||
    revision.revisionId !== configState.activeRevisionId
  ) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.AGENT_CONFIG_INVALID,
      "$.configState.revisions[]",
      "active revision is outside the requested agent scope",
    );
  }
  if (
    !Number.isSafeInteger(revision.revision) ||
    revision.revision < 1 ||
    typeof revision.config !== "object" ||
    !isRecord(revision.config) ||
    typeof revision.configDigest !== "string" ||
    !DIGEST_PATTERN.test(revision.configDigest) ||
    typeof revision.sourceOffset !== "string" ||
    !SOURCE_OFFSET_PATTERN.test(revision.sourceOffset) ||
    typeof revision.revisionId !== "string" ||
    !REVISION_ID_PATTERN.test(revision.revisionId)
  ) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.AGENT_CONFIG_INVALID,
      "$.configState.revisions[]",
      "active revision is missing immutable identity fields",
    );
  }
  if (revision.sourceOffset !== source.offset) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.STALE_CONFIG,
      "$.sourceHeads.config.offset",
      "config source head does not contain the active revision",
    );
  }
  if (
    agentConfigRevisionId({
      agentId,
      configDigest: revision.configDigest,
      revision: revision.revision,
    }) !== revision.revisionId
  ) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.AGENT_CONFIG_INVALID,
      "$.configState.revisions[].revisionId",
      "active revision id is not bound to its agent, revision, and config digest",
    );
  }
  try {
    validateAgentConfig(revision.config, {
      providerRegistry: createConfigValidationRegistry(revision.config),
    });
  } catch (error) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.AGENT_CONFIG_INVALID,
      "$.configState.revisions[].config",
      "active configuration failed strict validation",
      error?.code,
    );
  }
  const config = normalizeSnapshotConfig(revision.config);
  if (configDigest(config) !== revision.configDigest) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.AGENT_CONFIG_INVALID,
      "$.configState.revisions[].configDigest",
      "active configuration bytes do not match the revision digest",
    );
  }
  if (
    !isRecord(configState.activeConfig) ||
    configDigest(configState.activeConfig) !== revision.configDigest
  ) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.AGENT_CONFIG_INVALID,
      "$.configState.activeConfig",
      "active configuration projection does not match its revision",
    );
  }
  return { config, revision };
}

function resolvePrincipal(principal, agentId, workspaceId) {
  if (!isRecord(principal)) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.MEMBERSHIP_MISSING,
      "$.principal",
      "authoritative agent principal is required",
    );
  }
  try {
    validatePrincipalId(principal.principalId, {
      expectedWorkspaceId: workspaceId,
    });
  } catch {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.INVALID_INPUT,
      "$.principal.principalId",
      "principal is outside the requested workspace",
    );
  }
  if (
    principal.principalId !== `pr_${agentId.slice(3)}` ||
    principal.kind !== "agent" ||
    principal.status !== "active"
  ) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.MEMBERSHIP_INACTIVE,
      "$.principal",
      "only an active agent principal may create an invocation snapshot",
    );
  }
  return {
    kind: "agent",
    principalId: principal.principalId,
    profileRevision: requirePositiveInteger(
      principal.profileRevision,
      "$.principal.profileRevision",
    ),
    status: "active",
  };
}

function resolveWorkspaceMembership(value, agentId, workspaceId) {
  if (!isRecord(value)) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.MEMBERSHIP_MISSING,
      "$.workspaceMembership",
      "active workspace membership is required",
    );
  }
  const principalId = `pr_${agentId.slice(3)}`;
  if (
    value.workspaceId !== workspaceId ||
    value.principalId !== principalId ||
    value.membershipId !== membershipIdFor(workspaceId, principalId)
  ) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.MEMBERSHIP_INACTIVE,
      "$.workspaceMembership",
      "workspace membership is outside the requested agent scope",
    );
  }
  if (value.status !== "active") {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.MEMBERSHIP_INACTIVE,
      "$.workspaceMembership.status",
      "workspace membership is not active",
    );
  }
  if (value.role !== "agent") {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.MEMBERSHIP_INACTIVE,
      "$.workspaceMembership.role",
      "agent snapshots require the agent workspace role",
    );
  }
  return {
    membershipId: value.membershipId,
    principalId,
    revision: requirePositiveInteger(
      value.revision,
      "$.workspaceMembership.revision",
    ),
    role: "agent",
    status: "active",
    workspaceId,
  };
}

function resolveContext({
  channelMembership,
  context,
  configContext,
  principalId,
  workspaceId,
}) {
  if (!isRecord(context)) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.CONTEXT_SCOPE_MISMATCH,
      "$.context",
      "invocation context is required",
    );
  }
  assertExactKeys(context, ["channelId", "scope", "threadId"], "$.context");
  if (!AGENT_CONFIG_CONTEXT_SCOPES.includes(context.scope)) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.CONTEXT_SCOPE_MISMATCH,
      "$.context.scope",
      "invocation context scope is not registered",
    );
  }
  if (context.scope !== configContext.scope) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.CONTEXT_SCOPE_MISMATCH,
      "$.context.scope",
      "invocation scope does not match the immutable agent policy",
    );
  }
  const needsChannel = ["current-channel", "current-thread"].includes(
    context.scope,
  );
  if (needsChannel) {
    try {
      validateChannelId(context.channelId, {
        expectedWorkspaceId: workspaceId,
      });
    } catch {
      throw snapshotError(
        INVOCATION_SNAPSHOT_ERROR_CODES.CONTEXT_SCOPE_MISMATCH,
        "$.context.channelId",
        "channel context is required and must be workspace scoped",
      );
    }
    if (!isRecord(channelMembership)) {
      throw snapshotError(
        INVOCATION_SNAPSHOT_ERROR_CODES.CHANNEL_MEMBERSHIP_INACTIVE,
        "$.channelMembership",
        "active channel membership is required for channel context",
      );
    }
    if (
      channelMembership.channelId !== context.channelId ||
      channelMembership.principalId !== principalId ||
      channelMembership.status !== "active"
    ) {
      throw snapshotError(
        INVOCATION_SNAPSHOT_ERROR_CODES.CHANNEL_MEMBERSHIP_INACTIVE,
        "$.channelMembership",
        "channel membership is not active for the requested context",
      );
    }
  } else if (channelMembership !== null) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.CONTEXT_SCOPE_MISMATCH,
      "$.channelMembership",
      "non-channel contexts may not carry channel membership authority",
    );
  }
  if (context.scope === "current-thread") {
    requireBoundString(context.threadId, "$.context.threadId", 1, 240);
  } else if (context.threadId !== null) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.CONTEXT_SCOPE_MISMATCH,
      "$.context.threadId",
      "thread context is only valid for current-thread scope",
    );
  }
  return {
    channelId: needsChannel ? context.channelId : null,
    channelMembership: needsChannel
      ? {
          channelId: channelMembership.channelId,
          principalId,
          revision: requirePositiveInteger(
            channelMembership.revision,
            "$.channelMembership.revision",
          ),
          status: "active",
        }
      : null,
    scope: context.scope,
    threadId: context.scope === "current-thread" ? context.threadId : null,
  };
}

function resolveProviders({
  config,
  providerConfigurations,
  providerRegistry,
}) {
  if (
    !providerRegistry ||
    typeof providerRegistry.resolveConfiguration !== "function"
  ) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.PROVIDER_RESOLUTION_REFUSED,
      "$.providerRegistry",
      "provider registry is required for snapshot resolution",
    );
  }
  let resolved;
  try {
    resolved = resolveAgentConfigProviders(config, {
      providerConfigurations,
      registry: providerRegistry,
    });
  } catch (error) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.PROVIDER_RESOLUTION_REFUSED,
      "$.providers",
      "exact provider selections did not resolve as runnable",
      error?.code,
    );
  }
  let manifestDigest;
  try {
    manifestDigest = providerRegistry.manifestDigest();
  } catch (error) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.PROVIDER_RESOLUTION_REFUSED,
      "$.providerRegistry",
      "provider registry manifest is not canonical",
      error?.code,
    );
  }
  return {
    compatibility: resolved.compatibility,
    harness: projectProvider(resolved.harness),
    manifestDigest,
    resolvedProviderDigest: resolved.resolvedProviderDigest,
    sandbox: projectProvider(resolved.sandbox),
  };
}

function projectProvider(provider) {
  return {
    capabilities: [...provider.capabilities].sort(compareStrings),
    configSchemaDigest: provider.configSchemaDigest,
    descriptorDigest: provider.descriptorDigest,
    descriptorSchemaVersion: provider.descriptorSchemaVersion,
    kind: provider.kind,
    lifecycle: provider.lifecycle,
    limits: { ...provider.limits },
    networkPolicy: provider.networkPolicy,
    providerId: provider.providerId,
    providerKey: provider.providerKey,
    providerVersion: provider.providerVersion,
    providerConfigurationDigest: provider.providerConfigurationDigest,
    requiredCapabilities: [...provider.requiredCapabilities].sort(
      compareStrings,
    ),
  };
}

function resolveConnectionGrants({
  agentId,
  config,
  connectionGrants,
  now,
  workspaceId,
}) {
  if (!Array.isArray(connectionGrants)) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.CONNECTION_GRANT_MISSING,
      "$.connectionGrants",
      "current connection-grant state must be an array",
    );
  }
  const selected = [];
  for (const [index, ref] of config.connectionGrants.refs.entries()) {
    const grant = connectionGrants.find(
      (candidate) =>
        candidate?.connectionId === ref.connectionId &&
        candidate?.grantId === ref.grantId,
    );
    if (!grant) {
      throw snapshotError(
        INVOCATION_SNAPSHOT_ERROR_CODES.CONNECTION_GRANT_MISSING,
        `$.connectionGrants[${index}]`,
        "configured connection grant is not present in current state",
      );
    }
    if (
      grant.workspaceId !== workspaceId ||
      grant.agentId !== agentId ||
      grant.purpose !== ref.purpose
    ) {
      throw snapshotError(
        INVOCATION_SNAPSHOT_ERROR_CODES.CONNECTION_GRANT_SCOPE_MISMATCH,
        `$.connectionGrants[${index}]`,
        "connection grant is outside the agent, purpose, or workspace scope",
      );
    }
    if (grant.revision !== ref.revision) {
      throw snapshotError(
        INVOCATION_SNAPSHOT_ERROR_CODES.CONNECTION_GRANT_REVISION_MISMATCH,
        `$.connectionGrants[${index}].revision`,
        "current connection grant revision differs from the config reference",
      );
    }
    if (grant.status === "revoked") {
      throw snapshotError(
        INVOCATION_SNAPSHOT_ERROR_CODES.CONNECTION_GRANT_REVOKED,
        `$.connectionGrants[${index}].status`,
        "connection grant is revoked",
      );
    }
    if (grant.status !== "active") {
      throw snapshotError(
        INVOCATION_SNAPSHOT_ERROR_CODES.CONNECTION_GRANT_SCOPE_MISMATCH,
        `$.connectionGrants[${index}].status`,
        "connection grant status is not active",
      );
    }
    if (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= now) {
      throw snapshotError(
        INVOCATION_SNAPSHOT_ERROR_CODES.CONNECTION_GRANT_EXPIRED,
        `$.connectionGrants[${index}].expiresAt`,
        "connection grant has expired",
      );
    }
    const source = normalizeSourceReference(
      {
        stateDigest: grant.stateDigest,
        stream: grant.sourceStream,
        offset: grant.sourceOffset,
      },
      `$.connectionGrants[${index}]`,
    );
    if (source.stream !== `connection:${grant.connectionId}/config`) {
      throw snapshotError(
        INVOCATION_SNAPSHOT_ERROR_CODES.CONNECTION_GRANT_SCOPE_MISMATCH,
        `$.connectionGrants[${index}].sourceStream`,
        "connection grant source stream is not bound to its connection",
      );
    }
    assertNoSecretLikeText(
      grant.purpose,
      `$.connectionGrants[${index}].purpose`,
    );
    selected.push({
      connectionId: ref.connectionId,
      expiresAt: grant.expiresAt,
      grantId: ref.grantId,
      purpose: ref.purpose,
      revision: ref.revision,
      source,
    });
  }
  selected.sort((left, right) =>
    compareStrings(
      `${left.connectionId}\u0000${left.grantId}`,
      `${right.connectionId}\u0000${right.grantId}`,
    ),
  );
  return {
    manifestDigest: digestCanonical(selected),
    maxCallsPerRun: config.connectionGrants.maxCallsPerRun,
    refs: selected,
  };
}

function resolveWorkspaceInputs({
  config,
  directorySource,
  manifest,
  workspaceId,
}) {
  if (!isRecord(manifest)) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.WORKSPACE_INPUT_INVALID,
      "$.workspaceInputManifest",
      "workspace input manifest is required",
    );
  }
  assertExactKeys(
    manifest,
    [
      "files",
      "maxBytes",
      "paths",
      "source",
      "sourceOffset",
      "sourceStream",
      "stateDigest",
    ],
    "$.workspaceInputManifest",
  );
  const policy = config.workspaceInputs;
  if (!Array.isArray(manifest.paths) || !Array.isArray(manifest.files)) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.WORKSPACE_INPUT_INVALID,
      "$.workspaceInputManifest.files",
      "workspace input paths and files must be arrays",
    );
  }
  if (
    manifest.source !== policy.source ||
    manifest.maxBytes !== policy.maxBytes ||
    canonicalize([...manifest.paths].sort(compareStrings)) !==
      canonicalize([...policy.paths].sort(compareStrings))
  ) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.WORKSPACE_INPUT_INVALID,
      "$.workspaceInputManifest",
      "workspace input manifest does not match the immutable policy",
    );
  }
  const source = normalizeSourceReference(
    {
      stateDigest: manifest.stateDigest,
      stream: manifest.sourceStream,
      offset: manifest.sourceOffset,
    },
    "$.workspaceInputManifest",
  );
  if (
    source.stream !== `workspace:${workspaceId}/directory` ||
    source.offset !== directorySource.offset ||
    source.stateDigest !== directorySource.stateDigest
  ) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.STALE_SOURCE,
      "$.workspaceInputManifest",
      "workspace input manifest is not bound to the directory source head",
    );
  }
  const files = manifest.files.map((file, index) => {
    if (!isRecord(file)) {
      throw snapshotError(
        INVOCATION_SNAPSHOT_ERROR_CODES.WORKSPACE_INPUT_INVALID,
        `$.workspaceInputManifest.files[${index}]`,
        "workspace input file entries must be objects",
      );
    }
    assertExactKeys(
      file,
      ["bytes", "digest", "path"],
      `$.workspaceInputManifest.files[${index}]`,
    );
    requireBoundString(
      file.path,
      `$.workspaceInputManifest.files[${index}].path`,
      1,
      240,
    );
    if (!DIGEST_PATTERN.test(file.digest)) {
      throw snapshotError(
        INVOCATION_SNAPSHOT_ERROR_CODES.WORKSPACE_INPUT_INVALID,
        `$.workspaceInputManifest.files[${index}].digest`,
        "workspace input file digest must be sha-256",
      );
    }
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw snapshotError(
        INVOCATION_SNAPSHOT_ERROR_CODES.WORKSPACE_INPUT_INVALID,
        `$.workspaceInputManifest.files[${index}].bytes`,
        "workspace input file bytes must be a non-negative safe integer",
      );
    }
    if (
      !policy.paths.some(
        (allowed) =>
          file.path === allowed || file.path.startsWith(`${allowed}/`),
      )
    ) {
      throw snapshotError(
        INVOCATION_SNAPSHOT_ERROR_CODES.WORKSPACE_INPUT_INVALID,
        `$.workspaceInputManifest.files[${index}].path`,
        "workspace input file is outside the configured path policy",
      );
    }
    return { bytes: file.bytes, digest: file.digest, path: file.path };
  });
  const paths = [...manifest.paths].sort(compareStrings);
  const sortedFiles = files.sort((left, right) =>
    compareStrings(left.path, right.path),
  );
  if (
    new Set(sortedFiles.map(({ path }) => path)).size !== sortedFiles.length
  ) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.WORKSPACE_INPUT_INVALID,
      "$.workspaceInputManifest.files",
      "workspace input manifest contains duplicate paths",
    );
  }
  const totalBytes = sortedFiles.reduce((sum, file) => sum + file.bytes, 0);
  if (totalBytes > policy.maxBytes) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.WORKSPACE_INPUT_INVALID,
      "$.workspaceInputManifest.files",
      "workspace input manifest exceeds its byte policy",
    );
  }
  if (policy.source === "none" && sortedFiles.length > 0) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.WORKSPACE_INPUT_INVALID,
      "$.workspaceInputManifest.files",
      "source none cannot carry workspace files",
    );
  }
  const manifestValue = {
    files: sortedFiles,
    maxBytes: policy.maxBytes,
    paths,
    source: policy.source,
  };
  return {
    source,
    value: {
      manifestDigest: digestCanonical(manifestValue),
      ...manifestValue,
      source,
      totalBytes,
    },
  };
}

function resolveBudget(limits, usage) {
  const normalizedUsage = usage ?? {
    costUsdCents: 0,
    elapsedSeconds: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  if (!isRecord(normalizedUsage)) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.INVALID_INPUT,
      "$.budgetUsage",
      "budget usage must be an object",
    );
  }
  assertExactKeys(
    normalizedUsage,
    [
      "costUsdCents",
      "elapsedSeconds",
      "inputTokens",
      "outputTokens",
      "totalTokens",
    ],
    "$.budgetUsage",
  );
  for (const [key, value] of Object.entries(normalizedUsage)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw snapshotError(
        INVOCATION_SNAPSHOT_ERROR_CODES.INVALID_INPUT,
        `$.budgetUsage.${key}`,
        "budget usage values must be non-negative safe integers",
      );
    }
  }
  const exceeded =
    normalizedUsage.costUsdCents > limits.maxCostUsdCents ||
    normalizedUsage.elapsedSeconds > limits.timeoutSeconds ||
    normalizedUsage.inputTokens > limits.maxInputTokens ||
    normalizedUsage.outputTokens > limits.maxOutputTokens ||
    normalizedUsage.totalTokens > limits.maxTotalTokens ||
    normalizedUsage.inputTokens + normalizedUsage.outputTokens >
      normalizedUsage.totalTokens;
  if (exceeded) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.BUDGET_EXCEEDED,
      "$.budgetUsage",
      "current invocation usage exceeds the immutable budget",
    );
  }
  return {
    limits: { ...limits },
    usage: { ...normalizedUsage },
  };
}

function resolveSourceHeads(value, workspaceId, agentId) {
  if (!isRecord(value)) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.INVALID_INPUT,
      "$.sourceHeads",
      "config and directory source heads are required",
    );
  }
  assertExactKeys(value, ["config", "directory"], "$.sourceHeads");
  const config = normalizeSourceReference(value.config, "$.sourceHeads.config");
  const directory = normalizeSourceReference(
    value.directory,
    "$.sourceHeads.directory",
  );
  if (
    config.stream !== `agent:${agentId}/config` ||
    directory.stream !== `workspace:${workspaceId}/directory`
  ) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.STALE_SOURCE,
      "$.sourceHeads",
      "source heads are outside the requested workspace and agent scope",
    );
  }
  return { config, directory };
}

function normalizeSourceReference(value, path) {
  if (!isRecord(value)) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.INVALID_INPUT,
      path,
      "source reference must be an object",
    );
  }
  assertExactKeys(value, ["offset", "stateDigest", "stream"], path);
  requireBoundString(value.stream, `${path}.stream`, 1, 240);
  if (!SOURCE_OFFSET_PATTERN.test(value.offset)) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.INVALID_INPUT,
      `${path}.offset`,
      "source offset is not canonical",
    );
  }
  if (!DIGEST_PATTERN.test(value.stateDigest)) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.INVALID_INPUT,
      `${path}.stateDigest`,
      "source state digest must be sha-256",
    );
  }
  return {
    offset: value.offset,
    stateDigest: value.stateDigest,
    stream: value.stream,
  };
}

function assertSnapshotShape(value) {
  if (!isRecord(value)) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.INVALID_SNAPSHOT,
      "$.snapshot",
      "snapshot must be a plain object",
    );
  }
  assertExactKeys(value, SNAPSHOT_KEYS, "$.snapshot");
  if (value.schemaVersion !== INVOCATION_SNAPSHOT_SCHEMA_VERSION) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.INVALID_SNAPSHOT,
      "$.snapshot.schemaVersion",
      "snapshot schema version is unsupported",
    );
  }
  if (value.kind !== INVOCATION_SNAPSHOT_KIND) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.INVALID_SNAPSHOT,
      "$.snapshot.kind",
      "snapshot kind is not registered",
    );
  }
  if (!DIGEST_PATTERN.test(value.snapshotDigest)) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.INVALID_SNAPSHOT,
      "$.snapshot.snapshotDigest",
      "snapshot digest must be sha-256",
    );
  }
  scanForForbiddenSnapshotValues(value, "$.snapshot");
}

function snapshotPayload(value) {
  if (!isRecord(value)) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.INVALID_SNAPSHOT,
      "$.snapshot",
      "snapshot must be a plain object",
    );
  }
  const payload = { ...value };
  delete payload.snapshotDigest;
  assertExactKeys(payload, SNAPSHOT_PAYLOAD_KEYS, "$.snapshot");
  return payload;
}

function normalizeSnapshotConfig(value) {
  if (!isRecord(value)) return value;
  const config = structuredClone(value);
  config.trigger.events = [...config.trigger.events].sort(compareStrings);
  config.harness.requiredCapabilities = [
    ...config.harness.requiredCapabilities,
  ].sort(compareStrings);
  config.sandbox.requiredCapabilities = [
    ...config.sandbox.requiredCapabilities,
  ].sort(compareStrings);
  config.workspaceInputs.paths = [...config.workspaceInputs.paths].sort(
    compareStrings,
  );
  config.connectionGrants.refs = [...config.connectionGrants.refs].sort(
    (left, right) =>
      compareStrings(
        `${left.connectionId}\u0000${left.grantId}\u0000${left.revision}`,
        `${right.connectionId}\u0000${right.grantId}\u0000${right.revision}`,
      ),
  );
  return config;
}

function createConfigValidationRegistry(config) {
  return {
    describe({ kind }) {
      const selection = kind === "harness" ? config.harness : config.sandbox;
      return {
        capabilities: Array.isArray(selection?.requiredCapabilities)
          ? selection.requiredCapabilities
          : [],
      };
    },
  };
}

function configDigest(value) {
  return digestCanonical(normalizeSnapshotConfig(value));
}

function deniedDecision(error) {
  return {
    allowed: false,
    code: error?.code ?? INVOCATION_SNAPSHOT_ERROR_CODES.INVALID_INPUT,
    detail: error?.detail ?? "current snapshot authorization failed",
    sourceCode: error?.sourceCode ?? null,
  };
}

function snapshotError(code, path, detail, sourceCode = null) {
  const error = new InvocationSnapshotError(`${code} at ${path}: ${detail}`);
  error.name = "InvocationSnapshotError";
  error.code = code;
  error.detail = detail;
  error.path = path;
  error.sourceCode = sourceCode;
  return error;
}

function requireAgentId(value, path) {
  try {
    return validateAgentConfigAgentId(value, { path });
  } catch {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.INVALID_INPUT,
      path,
      "agent id is invalid or outside its workspace scope",
    );
  }
}

function requireClock(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.INVALID_INPUT,
      path,
      "clock must be a non-negative safe integer",
    );
  }
}

function requirePositiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.INVALID_INPUT,
      path,
      "value must be a positive safe integer",
    );
  }
  return value;
}

function requireBoundString(value, path, min, max) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.INVALID_INPUT,
      path,
      `string must contain between ${min} and ${max} characters`,
    );
  }
  assertNoSecretLikeText(value, path);
  return value;
}

function assertExactKeys(value, keys, path) {
  const allowed = new Set(keys);
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !allowed.has(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.INVALID_INPUT,
      path,
      "object contains an unknown or missing field",
    );
  }
}

function assertNoSecretLikeText(value, path) {
  if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    throw snapshotError(
      INVOCATION_SNAPSHOT_ERROR_CODES.SECRET_VALUE,
      path,
      "secret-shaped values are not permitted in snapshot inputs",
    );
  }
}

function scanForForbiddenSnapshotValues(value, path) {
  if (typeof value === "string") {
    assertNoSecretLikeText(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      scanForForbiddenSnapshotValues(item, `${path}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_SNAPSHOT_KEYS.has(key)) {
      throw snapshotError(
        INVOCATION_SNAPSHOT_ERROR_CODES.INVALID_SNAPSHOT,
        `${path}.${key}`,
        "forbidden credential or environment field is present",
      );
    }
    scanForForbiddenSnapshotValues(child, `${path}.${key}`);
  }
}

function digestCanonical(value) {
  return `sha256:${bytesToHex(sha256Digest(canonicalize(value)))}`;
}

function canonicalize(value, ancestors = new Set()) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw new TypeError(
        "canonical snapshot numbers must be finite safe integers",
      );
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (!isRecord(value) && !Array.isArray(value)) {
    throw new TypeError("canonical snapshot values must be JSON data");
  }
  if (ancestors.has(value)) throw new TypeError("canonical snapshot is cyclic");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((item) => canonicalize(item, ancestors))
        .join(",")}]`;
    }
    const entries = Object.entries(value).sort(([left], [right]) =>
      compareStrings(left, right),
    );
    return `{${entries
      .map(([key, child]) => {
        if (FORBIDDEN_SNAPSHOT_KEYS.has(key)) {
          throw new TypeError(`forbidden snapshot key ${key}`);
        }
        return `${JSON.stringify(key)}:${canonicalize(child, ancestors)}`;
      })
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function freezeDeep(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
