import { validateAgentConfig } from "./agent-config.mjs";
import { validateAgentConfigAgentId } from "./agent-config-revisions.mjs";
import {
  providerKey,
  PROVIDER_HEALTH_STATES,
  PROVIDER_KINDS,
  createProviderRegistry,
} from "./provider-registry.mjs";
import {
  validatePrincipalId,
  validatePrincipalRecord,
  validateWorkspaceId,
  workspaceIdFromPrincipalId,
} from "./principals.mjs";
import { sha256Digest } from "./sha256.mjs";
import {
  membershipIdFor,
  validateMembershipId,
  validateMembershipStatus,
  validateRole,
} from "./workspace.mjs";

export const AGENT_ROSTER_SCHEMA_VERSION = 1;

export const AGENT_AVAILABILITY_STATES = Object.freeze([
  "disabled",
  "unavailable",
  "available",
  "busy",
]);

export const AGENT_PRESENCE_STATES = Object.freeze(["idle", "busy"]);

export const AGENT_ACTIVE_RUN_STATES = Object.freeze([
  "admitted",
  "starting",
  "running",
  "cancelling",
]);

export const AGENT_PRESENCE_MAX_TTL_MS = 60_000;
export const AGENT_PRESENCE_DEFAULT_TTL_MS = 15_000;

export const AGENT_ROSTER_ERROR_CODES = Object.freeze({
  CONFIG_DISABLED: "AGENT_ROSTER_CONFIG_DISABLED",
  CONFIG_INVALID: "AGENT_ROSTER_CONFIG_INVALID",
  CONFIG_MISSING: "AGENT_ROSTER_CONFIG_MISSING",
  CONFIG_NOT_ACTIVE: "AGENT_ROSTER_CONFIG_NOT_ACTIVE",
  CONFIG_NOT_RUNNABLE: "AGENT_ROSTER_CONFIG_NOT_RUNNABLE",
  DUPLICATE_HANDLE: "AGENT_ROSTER_DUPLICATE_HANDLE",
  INVALID_INPUT: "AGENT_ROSTER_INVALID_INPUT",
  INVALID_PRESENCE: "AGENT_ROSTER_INVALID_PRESENCE",
  INVALID_READINESS: "AGENT_ROSTER_INVALID_READINESS",
  PRINCIPAL_INVALID: "AGENT_ROSTER_PRINCIPAL_INVALID",
  PRINCIPAL_KIND_MISMATCH: "AGENT_ROSTER_PRINCIPAL_KIND_MISMATCH",
  PRINCIPAL_NOT_FOUND: "AGENT_ROSTER_PRINCIPAL_NOT_FOUND",
  PRINCIPAL_NOT_AGENT: "AGENT_ROSTER_PRINCIPAL_NOT_AGENT",
  SERVICE_NOT_CHAT_MEMBER: "AGENT_ROSTER_SERVICE_NOT_CHAT_MEMBER",
  WORKSPACE_SCOPE_MISMATCH: "AGENT_ROSTER_WORKSPACE_SCOPE_MISMATCH",
});

export const AGENT_AVAILABILITY_REASON_CODES = Object.freeze({
  CONFIG_DISABLED: "CONFIG_DISABLED",
  CONFIG_INVALID: "CONFIG_INVALID",
  CONFIG_MISSING: "CONFIG_MISSING",
  CONFIG_NOT_ACTIVE: "CONFIG_NOT_ACTIVE",
  CONFIG_NOT_RUNNABLE: "CONFIG_NOT_RUNNABLE",
  PRINCIPAL_DEACTIVATED: "PRINCIPAL_DEACTIVATED",
  PRINCIPAL_INVALID: "PRINCIPAL_INVALID",
  PRINCIPAL_NOT_FOUND: "PRINCIPAL_NOT_FOUND",
  PRINCIPAL_NOT_AGENT: "PRINCIPAL_NOT_AGENT",
  PRINCIPAL_SUSPENDED: "PRINCIPAL_SUSPENDED",
  PROVIDER_DISABLED: "PROVIDER_DISABLED",
  PROVIDER_MISSING: "PROVIDER_MISSING",
  PROVIDER_NOT_IMPLEMENTED: "PROVIDER_NOT_IMPLEMENTED",
  PROVIDER_NOT_INSTALLED: "PROVIDER_NOT_INSTALLED",
  PROVIDER_READINESS_INVALID: "PROVIDER_READINESS_INVALID",
  PROVIDER_STALE: "PROVIDER_STALE",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  PROVIDER_UNHEALTHY: "PROVIDER_UNHEALTHY",
  WORKSPACE_MEMBERSHIP_INACTIVE: "WORKSPACE_MEMBERSHIP_INACTIVE",
  WORKSPACE_MEMBERSHIP_MISSING: "WORKSPACE_MEMBERSHIP_MISSING",
});

const CONFIG_STATUSES = new Set(["draft", "active", "disabled", "retired"]);
const READINESS_KEYS = [
  "available",
  "enabled",
  "expiresAt",
  "health",
  "installed",
  "kind",
  "observedAt",
  "providerId",
  "providerKey",
  "providerVersion",
  "stale",
];
const PRESENCE_KEYS = [
  "agentId",
  "expiresAt",
  "observedAt",
  "schemaVersion",
  "source",
  "state",
  "workspaceId",
];

export class AgentRosterValidationError extends Error {
  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      name: this.name,
      path: this.path,
    };
  }
}

export function rosterError(code, path, detail) {
  const error = new AgentRosterValidationError(`${code} at ${path}: ${detail}`);
  error.name = "AgentRosterValidationError";
  error.code = code;
  error.path = path;
  error.detail = detail;
  return error;
}

export function validateUniquePrincipalHandles(
  principals,
  { expectedWorkspaceId } = {},
) {
  const values = principalValues(principals, "$.principals");
  const seen = new Map();
  for (const [index, principal] of values.entries()) {
    try {
      validatePrincipalRecord(principal, { expectedWorkspaceId });
    } catch (error) {
      throw rosterError(
        AGENT_ROSTER_ERROR_CODES.PRINCIPAL_INVALID,
        `$.principals[${index}]`,
        error?.detail ?? "principal record is invalid",
      );
    }
    const handle = principal.profile.handle;
    const previous = seen.get(handle);
    if (previous && previous !== principal.principalId) {
      throw rosterError(
        AGENT_ROSTER_ERROR_CODES.DUPLICATE_HANDLE,
        `$.principals[${index}].profile.handle`,
        `handle ${handle} is already assigned to ${previous}`,
      );
    }
    seen.set(handle, principal.principalId);
  }
  return Object.freeze(Object.fromEntries(seen));
}

export function createTransientPresence({
  agentId,
  observedAt,
  state,
  ttlMs = AGENT_PRESENCE_DEFAULT_TTL_MS,
  workspaceId,
} = {}) {
  const normalizedWorkspaceId = requireWorkspace(workspaceId);
  const normalizedAgentId = requireAgent(agentId, normalizedWorkspaceId);
  requirePresenceState(state);
  requireClock(observedAt, "$.observedAt");
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > AGENT_PRESENCE_MAX_TTL_MS
  ) {
    throw rosterError(
      AGENT_ROSTER_ERROR_CODES.INVALID_PRESENCE,
      "$.ttlMs",
      `presence ttl must be between 1 and ${AGENT_PRESENCE_MAX_TTL_MS} milliseconds`,
    );
  }
  return deepFreeze({
    agentId: normalizedAgentId,
    expiresAt: observedAt + ttlMs,
    observedAt,
    schemaVersion: AGENT_ROSTER_SCHEMA_VERSION,
    source: "ephemeral-heartbeat",
    state,
    workspaceId: normalizedWorkspaceId,
  });
}

export function mergeTransientPresence(
  current,
  event,
  { now = event?.observedAt ?? 0 } = {},
) {
  const normalizedEvent = validateTransientPresence(event);
  requireClock(now, "$.now");
  const next = compactTransientPresence(current, { now });
  const previous = Object.entries(next)
    .find(([agentId]) => agentId === normalizedEvent.agentId)
    ?.at(1);
  if (previous && previous.observedAt > normalizedEvent.observedAt) {
    return deepFreeze(next);
  }
  return deepFreeze(
    Object.fromEntries([
      ...Object.entries(next).filter(
        ([agentId]) => agentId !== normalizedEvent.agentId,
      ),
      [normalizedEvent.agentId, normalizedEvent],
    ]),
  );
}

export function compactTransientPresence(current, { now = 0 } = {}) {
  requireClock(now, "$.now");
  const entries = presenceEntries(current);
  const next = [];
  for (const [agentId, event] of entries) {
    try {
      const normalized = validateTransientPresence(event);
      if (normalized.expiresAt > now) next.push([agentId, normalized]);
    } catch {
      // An invalid or expired transient event cannot grant presence or access.
    }
  }
  return Object.fromEntries(next);
}

export function clearTransientPresence(current, agentId) {
  const next = compactTransientPresence(current);
  if (agentId !== undefined) {
    return deepFreeze(
      Object.fromEntries(
        Object.entries(next).filter(([candidate]) => candidate !== agentId),
      ),
    );
  }
  return deepFreeze(next);
}

export function deriveAgentAvailability({
  activeRun = null,
  agentId,
  configState = null,
  now = 0,
  principal = null,
  principalId,
  providerReadiness = null,
  providerRegistry = null,
  transientPresence = null,
  workspaceMembership = null,
} = {}) {
  const normalizedAgentId = requireAgent(agentId);
  const workspaceId = workspaceIdFromAgentId(normalizedAgentId);
  const normalizedPrincipalId =
    principalId ?? `pr_${normalizedAgentId.slice(3)}`;
  try {
    validatePrincipalId(normalizedPrincipalId, {
      expectedWorkspaceId: workspaceId,
    });
  } catch (error) {
    throw rosterError(
      AGENT_ROSTER_ERROR_CODES.INVALID_INPUT,
      "$.principalId",
      error?.detail ?? "principal id is invalid",
    );
  }
  requireClock(now, "$.now");
  const registry = providerRegistry ?? createProviderRegistry({ now });
  const reasons = [];
  const reasonKeys = new Set();
  const addReason = (code, detail, prerequisite, provider = null) => {
    const key = `${code}\u0000${provider?.providerKey ?? ""}`;
    if (reasonKeys.has(key)) return;
    reasonKeys.add(key);
    reasons.push({
      code,
      detail,
      prerequisite,
      providerKey: provider?.providerKey ?? null,
    });
  };

  let principalIsActiveAgent = true;
  if (principal === null) {
    principalIsActiveAgent = false;
    addReason(
      AGENT_AVAILABILITY_REASON_CODES.PRINCIPAL_NOT_FOUND,
      "agent principal is not present in the authoritative workspace directory",
      "principal",
    );
  } else {
    try {
      validatePrincipalRecord(principal, { expectedWorkspaceId: workspaceId });
    } catch (error) {
      principalIsActiveAgent = false;
      addReason(
        AGENT_AVAILABILITY_REASON_CODES.PRINCIPAL_INVALID,
        error?.detail ?? "agent principal record is invalid",
        "principal",
      );
    }
    if (principal.principalId !== normalizedPrincipalId) {
      principalIsActiveAgent = false;
      addReason(
        AGENT_AVAILABILITY_REASON_CODES.PRINCIPAL_INVALID,
        "principal id does not match the requested agent",
        "principal",
      );
    }
    if (principal.kind !== "agent") {
      principalIsActiveAgent = false;
      addReason(
        AGENT_AVAILABILITY_REASON_CODES.PRINCIPAL_NOT_AGENT,
        "only agent principals may have agent availability",
        "principal",
      );
    }
    if (principal.status !== "active") {
      principalIsActiveAgent = false;
      addReason(
        principal.status === "suspended"
          ? AGENT_AVAILABILITY_REASON_CODES.PRINCIPAL_SUSPENDED
          : AGENT_AVAILABILITY_REASON_CODES.PRINCIPAL_DEACTIVATED,
        `principal status is ${String(principal.status)}`,
        "principal",
      );
    }
  }

  const membership = normalizeWorkspaceMembership(
    workspaceMembership,
    workspaceId,
    normalizedPrincipalId,
  );
  if (membership === null) {
    addReason(
      AGENT_AVAILABILITY_REASON_CODES.WORKSPACE_MEMBERSHIP_MISSING,
      "agent has no authoritative workspace membership",
      "workspace-membership",
    );
  } else if (membership.status !== "active") {
    addReason(
      AGENT_AVAILABILITY_REASON_CODES.WORKSPACE_MEMBERSHIP_INACTIVE,
      `workspace membership status is ${membership.status}`,
      "workspace-membership",
    );
  }

  const readiness = readinessMap(providerReadiness);
  const configResult = inspectConfigState(configState, registry, addReason);
  const requiredProviders = [];
  if (configResult.valid) {
    for (const kind of ["harness", "sandbox"]) {
      const selection =
        kind === "harness"
          ? configResult.config.harness
          : configResult.config.sandbox;
      const provider = inspectProvider(
        registry,
        selection,
        readiness,
        now,
        addReason,
        kind,
      );
      requiredProviders.push(provider);
    }
  }

  const disabled =
    !principalIsActiveAgent ||
    ["disabled", "retired"].includes(configState?.status);
  const baseAvailability = disabled
    ? "disabled"
    : reasons.length > 0
      ? "unavailable"
      : "available";
  const runnable = baseAvailability === "available";
  const presence = inspectPresence(
    transientPresence,
    workspaceId,
    normalizedAgentId,
    now,
  );
  const runBusy = hasActiveRun(activeRun, workspaceId, normalizedAgentId);
  const busy = runnable && (runBusy || presence.freshBusy);
  const availability = busy ? "busy" : baseAvailability;
  const reasonDigest = digestValue(reasons);

  return deepFreeze({
    agentId: normalizedAgentId,
    availability,
    availabilityReasons: reasons,
    baseAvailability,
    busySource: busy ? (runBusy ? "active-run" : "ephemeral-presence") : null,
    config: {
      activeRevisionId: configState?.activeRevisionId ?? null,
      status: configState?.status ?? null,
      valid: configResult.valid,
    },
    kind: "agent",
    presence,
    principalId: normalizedPrincipalId,
    providerReadiness: requiredProviders,
    reasonDigest,
    runnable,
    source: {
      configRevisionId: configState?.activeRevisionId ?? null,
      principalProfileRevision: principal?.profileRevision ?? null,
      transientPresence: "ephemeral",
      workspaceMembershipRevision: membership?.revision ?? null,
    },
    workspaceId,
  });
}

export function buildAgentRoster({
  activeRuns = [],
  configs = null,
  now = 0,
  providerReadiness = null,
  providerRegistry = null,
  state,
  transientPresence = null,
  workspaceId,
} = {}) {
  const normalizedWorkspaceId = requireWorkspace(workspaceId);
  requireClock(now, "$.now");
  const entities = state?.entities ?? state;
  if (!isRecord(entities)) {
    throw rosterError(
      AGENT_ROSTER_ERROR_CODES.INVALID_INPUT,
      "$.state",
      "replayed directory state must contain entities",
    );
  }
  const principals = entities.principals ?? {};
  const memberships = entities.memberships ?? {};
  const channels = entities.channels ?? {};
  const channelMemberships = entities.channelMemberships ?? {};
  const configStates = configs ?? entities.agents ?? {};
  const principalRecords = principalValues(
    principals,
    "$.state.entities.principals",
  ).filter((principal) => {
    try {
      return (
        workspaceIdFromPrincipalId(principal.principalId) ===
        normalizedWorkspaceId
      );
    } catch {
      return false;
    }
  });
  validateUniquePrincipalHandles(principalRecords, {
    expectedWorkspaceId: normalizedWorkspaceId,
  });

  principalRecords.sort(comparePrincipal);
  const directory = principalRecords.map((principal) => {
    const membership = lookupValue(
      memberships,
      membershipIdFor(normalizedWorkspaceId, principal.principalId),
    );
    const workspaceMembership = normalizeWorkspaceMembership(
      membership,
      normalizedWorkspaceId,
      principal.principalId,
    );
    const agentId =
      principal.kind === "agent"
        ? `ag_${principal.principalId.slice(3)}`
        : null;
    const availability =
      principal.kind === "agent"
        ? deriveAgentAvailability({
            activeRun: activeRuns,
            agentId,
            configState: lookupValue(configStates, agentId),
            now,
            principal,
            principalId: principal.principalId,
            providerReadiness,
            providerRegistry,
            transientPresence: getPresence(transientPresence, agentId),
            workspaceMembership,
          })
        : null;
    return deepFreeze({
      agentId,
      availability: availability?.availability ?? null,
      availabilityReasons: availability?.availabilityReasons ?? [],
      baseAvailability: availability?.baseAvailability ?? null,
      chatMember:
        principal.kind !== "service" &&
        principal.status === "active" &&
        workspaceMembership?.status === "active",
      kind: principal.kind,
      ownedBy: principal.ownedBy,
      principalId: principal.principalId,
      profile: cloneJson(principal.profile),
      profileRevision: principal.profileRevision,
      runnable: availability?.runnable ?? false,
      status: principal.status,
      workspaceMembership: membershipView(workspaceMembership),
    });
  });
  const directoryById = new Map(
    directory.map((entry) => [entry.principalId, entry]),
  );

  const channelViews = Object.values(channels)
    .filter((channel) => channel?.workspaceId === normalizedWorkspaceId)
    .sort((left, right) => left.channelId.localeCompare(right.channelId))
    .map((channel) => {
      const members = Object.values(channelMemberships)
        .filter(
          (membership) =>
            membership?.channelId === channel.channelId &&
            membership?.status === "active",
        )
        .map((membership) => directoryById.get(membership.principalId))
        .filter((entry) => entry?.chatMember && entry.kind !== "service")
        .sort(compareDirectoryEntry)
        .map((entry) => ({
          agentId: entry.agentId,
          kind: entry.kind,
          principalId: entry.principalId,
          profile: cloneJson(entry.profile),
          status: entry.status,
        }));
      return {
        channelId: channel.channelId,
        displayName: channel.displayName,
        kind: channel.kind,
        members,
        revision: channel.revision,
        status: channel.status,
      };
    });

  return deepFreeze({
    channels: channelViews,
    directory,
    membershipPolicy: {
      chatMemberKinds: ["agent", "human"],
      handleScope: "workspace",
      operations: [
        "directory",
        "channel.membership.invite",
        "channel.membership.join",
        "channel.membership.leave",
        "channel.membership.remove",
      ],
      servicePrincipalChatMember: false,
    },
    schemaVersion: AGENT_ROSTER_SCHEMA_VERSION,
    source: {
      authority: "durable-stream-replay",
      durableStateDigest: entities.stateDigest ?? null,
      presenceAuthority: "ephemeral-projection",
    },
    workspaceId: normalizedWorkspaceId,
  });
}

export function canonicalAgentRoster(value) {
  return canonicalize(value);
}

export function agentRosterDigest(value) {
  return `sha256:${bytesToHex(sha256Digest(canonicalAgentRoster(value)))}`;
}

function inspectConfigState(configState, registry, addReason) {
  if (configState === null || configState === undefined) {
    addReason(
      AGENT_AVAILABILITY_REASON_CODES.CONFIG_MISSING,
      "agent has no committed configuration state",
      "config",
    );
    return { config: null, valid: false };
  }
  if (!isRecord(configState) || !CONFIG_STATUSES.has(configState.status)) {
    addReason(
      AGENT_AVAILABILITY_REASON_CODES.CONFIG_INVALID,
      "agent configuration state has an unknown status",
      "config",
    );
    return { config: null, valid: false };
  }
  if (configState.status !== "active") {
    addReason(
      ["disabled", "retired"].includes(configState.status)
        ? AGENT_AVAILABILITY_REASON_CODES.CONFIG_DISABLED
        : AGENT_AVAILABILITY_REASON_CODES.CONFIG_NOT_ACTIVE,
      `agent configuration status is ${configState.status}`,
      "config",
    );
  }
  if (configState.runnable !== true) {
    addReason(
      AGENT_AVAILABILITY_REASON_CODES.CONFIG_NOT_RUNNABLE,
      "agent configuration is not marked runnable by its durable config reducer",
      "config",
    );
  }
  if (!configState.activeConfig) {
    addReason(
      AGENT_AVAILABILITY_REASON_CODES.CONFIG_MISSING,
      "active agent configuration bytes are missing",
      "config",
    );
    return { config: null, valid: false };
  }
  try {
    validateAgentConfig(configState.activeConfig, {
      providerRegistry: registry,
    });
  } catch (error) {
    addReason(
      AGENT_AVAILABILITY_REASON_CODES.CONFIG_INVALID,
      error?.detail ?? "active agent configuration failed validation",
      "config",
    );
    return { config: null, valid: false };
  }
  return {
    config: configState.activeConfig,
    valid: configState.status === "active" && configState.runnable === true,
  };
}

function inspectProvider(registry, selection, readiness, now, addReason, kind) {
  let descriptor;
  let key = null;
  try {
    descriptor = registry.describe({ kind, ...selection });
    key = providerKey({ kind, ...selection });
  } catch (error) {
    addReason(
      AGENT_AVAILABILITY_REASON_CODES.PROVIDER_MISSING,
      error?.detail ?? "required provider is not registered",
      `provider.${kind}`,
    );
    return {
      available: false,
      kind,
      providerKey: null,
      reason: AGENT_AVAILABILITY_REASON_CODES.PROVIDER_MISSING,
    };
  }
  const status =
    readiness.get(key) ?? registry.status(selectionFor(kind, selection));
  const provider = {
    available: false,
    enabled: status.enabled,
    expiresAt: status.expiresAt,
    health: status.health,
    installed: status.installed,
    kind,
    observedAt: status.observedAt,
    providerKey: key,
    providerId: selection.providerId,
    providerVersion: selection.providerVersion,
    stale: status.stale || now > status.expiresAt,
  };
  const reasonProvider = { providerKey: key };
  if (!provider.installed) {
    provider.reason = AGENT_AVAILABILITY_REASON_CODES.PROVIDER_NOT_INSTALLED;
    addReason(
      provider.reason,
      `required ${kind} provider is not installed`,
      `provider.${kind}`,
      reasonProvider,
    );
  } else if (!provider.enabled) {
    provider.reason = AGENT_AVAILABILITY_REASON_CODES.PROVIDER_DISABLED;
    addReason(
      provider.reason,
      `required ${kind} provider is disabled`,
      `provider.${kind}`,
      reasonProvider,
    );
  } else if (
    !PROVIDER_HEALTH_STATES.includes(provider.health) ||
    provider.health !== "healthy"
  ) {
    provider.reason = AGENT_AVAILABILITY_REASON_CODES.PROVIDER_UNHEALTHY;
    addReason(
      provider.reason,
      `required ${kind} provider health is ${String(provider.health)}`,
      `provider.${kind}`,
      reasonProvider,
    );
  } else if (provider.stale) {
    provider.reason = AGENT_AVAILABILITY_REASON_CODES.PROVIDER_STALE;
    addReason(
      provider.reason,
      `required ${kind} provider readiness expired at ${provider.expiresAt}`,
      `provider.${kind}`,
      reasonProvider,
    );
  } else if (descriptor.implementationStatus !== "implemented") {
    provider.reason = AGENT_AVAILABILITY_REASON_CODES.PROVIDER_NOT_IMPLEMENTED;
    addReason(
      provider.reason,
      `required ${kind} provider is registered but unimplemented`,
      `provider.${kind}`,
      reasonProvider,
    );
  } else if (status.available !== true) {
    provider.reason = AGENT_AVAILABILITY_REASON_CODES.PROVIDER_UNAVAILABLE;
    addReason(
      provider.reason,
      `required ${kind} provider is not available`,
      `provider.${kind}`,
      reasonProvider,
    );
  } else {
    provider.available = true;
    provider.reason = null;
  }
  return provider;
}

function inspectPresence(event, workspaceId, agentId, now) {
  if (event === null || event === undefined) {
    return {
      accepted: false,
      durable: false,
      expiresAt: null,
      fresh: false,
      freshBusy: false,
      state: null,
    };
  }
  try {
    const normalized = validateTransientPresence(event);
    const inScope =
      normalized.workspaceId === workspaceId && normalized.agentId === agentId;
    const fresh =
      inScope && normalized.observedAt <= now && normalized.expiresAt > now;
    return {
      accepted: inScope,
      durable: false,
      expiresAt: normalized.expiresAt,
      fresh,
      freshBusy: fresh && normalized.state === "busy",
      state: fresh ? normalized.state : null,
    };
  } catch {
    return {
      accepted: false,
      durable: false,
      expiresAt: null,
      fresh: false,
      freshBusy: false,
      state: null,
    };
  }
}

function validateTransientPresence(value) {
  assertExactKeys(value, PRESENCE_KEYS, "$.presence");
  if (value.schemaVersion !== AGENT_ROSTER_SCHEMA_VERSION) {
    throw rosterError(
      AGENT_ROSTER_ERROR_CODES.INVALID_PRESENCE,
      "$.presence.schemaVersion",
      "presence schema version is unsupported",
    );
  }
  const workspaceId = requireWorkspace(value.workspaceId);
  requireAgent(value.agentId, workspaceId);
  requirePresenceState(value.state);
  requireClock(value.observedAt, "$.presence.observedAt");
  requireClock(value.expiresAt, "$.presence.expiresAt");
  if (value.expiresAt <= value.observedAt) {
    throw rosterError(
      AGENT_ROSTER_ERROR_CODES.INVALID_PRESENCE,
      "$.presence.expiresAt",
      "presence must expire after observation",
    );
  }
  if (value.expiresAt - value.observedAt > AGENT_PRESENCE_MAX_TTL_MS) {
    throw rosterError(
      AGENT_ROSTER_ERROR_CODES.INVALID_PRESENCE,
      "$.presence.expiresAt",
      "presence ttl exceeds the bounded maximum",
    );
  }
  if (value.source !== "ephemeral-heartbeat") {
    throw rosterError(
      AGENT_ROSTER_ERROR_CODES.INVALID_PRESENCE,
      "$.presence.source",
      "presence source must be ephemeral-heartbeat",
    );
  }
  return deepFreeze({ ...value });
}

function readinessMap(value) {
  if (value === null || value === undefined) return new Map();
  const entries =
    value instanceof Map ? [...value.entries()] : Object.entries(value);
  const map = new Map();
  for (const [entryKey, candidate] of entries) {
    const normalized = normalizeReadiness(
      candidate,
      `$.providerReadiness.${entryKey}`,
    );
    if (map.has(normalized.providerKey)) {
      throw rosterError(
        AGENT_ROSTER_ERROR_CODES.INVALID_READINESS,
        "$.providerReadiness",
        `provider readiness ${normalized.providerKey} is duplicated`,
      );
    }
    map.set(normalized.providerKey, normalized);
  }
  return map;
}

function normalizeReadiness(value, path) {
  assertExactKeys(value, READINESS_KEYS, path);
  if (!PROVIDER_KINDS.includes(value.kind)) {
    throw rosterError(
      AGENT_ROSTER_ERROR_CODES.INVALID_READINESS,
      `${path}.kind`,
      "provider kind is invalid",
    );
  }
  const key = providerKey(value);
  for (const field of ["available", "enabled", "installed", "stale"]) {
    if (typeof readinessFlag(value, field) !== "boolean") {
      throw rosterError(
        AGENT_ROSTER_ERROR_CODES.INVALID_READINESS,
        `${path}.${field}`,
        "readiness flag must be boolean",
      );
    }
  }
  if (!PROVIDER_HEALTH_STATES.includes(value.health)) {
    throw rosterError(
      AGENT_ROSTER_ERROR_CODES.INVALID_READINESS,
      `${path}.health`,
      "provider health is invalid",
    );
  }
  for (const field of ["observedAt", "expiresAt"]) {
    const time = readinessTime(value, field);
    if (!Number.isSafeInteger(time) || time < 0) {
      throw rosterError(
        AGENT_ROSTER_ERROR_CODES.INVALID_READINESS,
        `${path}.${field}`,
        "readiness time must be a non-negative integer",
      );
    }
  }
  if (value.providerKey !== key) {
    throw rosterError(
      AGENT_ROSTER_ERROR_CODES.INVALID_READINESS,
      `${path}.providerKey`,
      "provider key does not match coordinates",
    );
  }
  return deepFreeze({ ...value });
}

function normalizeWorkspaceMembership(value, workspaceId, principalId) {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    throw rosterError(
      AGENT_ROSTER_ERROR_CODES.INVALID_INPUT,
      "$.workspaceMembership",
      "workspace membership must be an object",
    );
  }
  try {
    validateMembershipId(value.membershipId, {
      expectedWorkspaceId: workspaceId,
    });
    validatePrincipalId(value.principalId, {
      expectedWorkspaceId: workspaceId,
    });
    validateWorkspaceId(value.workspaceId);
    validateMembershipStatus(value.status);
    validateRole(value.role);
  } catch (error) {
    throw rosterError(
      AGENT_ROSTER_ERROR_CODES.INVALID_INPUT,
      "$.workspaceMembership",
      error?.detail ?? "workspace membership is invalid",
    );
  }
  if (value.workspaceId !== workspaceId || value.principalId !== principalId) {
    throw rosterError(
      AGENT_ROSTER_ERROR_CODES.WORKSPACE_SCOPE_MISMATCH,
      "$.workspaceMembership",
      "workspace membership is not bound to the requested principal and workspace",
    );
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw rosterError(
      AGENT_ROSTER_ERROR_CODES.INVALID_INPUT,
      "$.workspaceMembership.revision",
      "membership revision must be positive",
    );
  }
  return value;
}

function membershipView(membership) {
  if (!membership) return null;
  return {
    membershipId: membership.membershipId,
    revision: membership.revision,
    role: membership.role,
    status: membership.status,
  };
}

function hasActiveRun(activeRun, workspaceId, agentId) {
  const runs = Array.isArray(activeRun)
    ? activeRun
    : activeRun
      ? [activeRun]
      : [];
  return runs.some((run) => {
    if (!isRecord(run)) return false;
    if (run.workspaceId !== undefined && run.workspaceId !== workspaceId)
      return false;
    if (run.agentId !== agentId && run.agentId !== `ag_${agentId.slice(3)}`)
      return false;
    return AGENT_ACTIVE_RUN_STATES.includes(
      run.status ?? run.to ?? run.lifecycle,
    );
  });
}

function getPresence(store, agentId) {
  if (store instanceof Map) return store.get(agentId) ?? null;
  return lookupValue(store, agentId);
}

function presenceEntries(value) {
  if (value === null || value === undefined) return [];
  return value instanceof Map ? [...value.entries()] : Object.entries(value);
}

function principalValues(value, path) {
  if (Array.isArray(value)) return [...value];
  if (isRecord(value)) return Object.values(value);
  throw rosterError(
    AGENT_ROSTER_ERROR_CODES.INVALID_INPUT,
    path,
    "principals must be an array or object map",
  );
}

function comparePrincipal(left, right) {
  return (
    left.profile.handle.localeCompare(right.profile.handle) ||
    left.principalId.localeCompare(right.principalId)
  );
}

function compareDirectoryEntry(left, right) {
  return (
    left.profile.handle.localeCompare(right.profile.handle) ||
    left.principalId.localeCompare(right.principalId)
  );
}

function selectionFor(kind, selection) {
  return {
    kind,
    providerId: selection.providerId,
    providerVersion: selection.providerVersion,
  };
}

function requireAgent(value, expectedWorkspaceId) {
  try {
    return validateAgentConfigAgentId(value, { expectedWorkspaceId });
  } catch (error) {
    throw rosterError(
      AGENT_ROSTER_ERROR_CODES.INVALID_INPUT,
      "$.agentId",
      error?.detail ?? "agent id is invalid",
    );
  }
}

function workspaceIdFromAgentId(agentId) {
  try {
    return `ws_${agentId.slice(3, 29)}`;
  } catch {
    throw rosterError(
      AGENT_ROSTER_ERROR_CODES.INVALID_INPUT,
      "$.agentId",
      "agent id has no workspace scope",
    );
  }
}

function requireWorkspace(value) {
  try {
    return validateWorkspaceId(value);
  } catch (error) {
    throw rosterError(
      AGENT_ROSTER_ERROR_CODES.INVALID_INPUT,
      "$.workspaceId",
      error?.detail ?? "workspace id is invalid",
    );
  }
}

function requireClock(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw rosterError(
      AGENT_ROSTER_ERROR_CODES.INVALID_INPUT,
      path,
      "clock value must be a non-negative safe integer",
    );
  }
}

function requirePresenceState(value) {
  if (!AGENT_PRESENCE_STATES.includes(value)) {
    throw rosterError(
      AGENT_ROSTER_ERROR_CODES.INVALID_PRESENCE,
      "$.presence.state",
      "presence state is not registered",
    );
  }
}

function assertExactKeys(value, keys, path) {
  if (!isRecord(value)) {
    throw rosterError(
      AGENT_ROSTER_ERROR_CODES.INVALID_INPUT,
      path,
      "value must be an object",
    );
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw rosterError(
        AGENT_ROSTER_ERROR_CODES.INVALID_INPUT,
        `${path}.${key}`,
        "field is not allowed",
      );
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      throw rosterError(
        AGENT_ROSTER_ERROR_CODES.INVALID_INPUT,
        `${path}.${key}`,
        "field is required",
      );
    }
  }
}

function digestValue(value) {
  return `sha256:${bytesToHex(sha256Digest(canonicalize(value)))}`;
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "undefined") {
      throw rosterError(
        AGENT_ROSTER_ERROR_CODES.INVALID_INPUT,
        "$",
        "undefined is not canonical JSON",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
    .join(",")}}`;
}

function lookupValue(value, key) {
  if (!isRecord(value)) return undefined;
  return Object.entries(value)
    .find(([candidate]) => candidate === key)
    ?.at(1);
}

function readinessFlag(value, field) {
  if (field === "available") return value.available;
  if (field === "enabled") return value.enabled;
  if (field === "installed") return value.installed;
  return value.stale;
}

function readinessTime(value, field) {
  return field === "observedAt" ? value.observedAt : value.expiresAt;
}

function cloneJson(value) {
  if (Array.isArray(value)) return value.map((entry) => cloneJson(entry));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneJson(entry)]),
    );
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
