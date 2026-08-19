import { validateAgentConfigAgentId } from "./agent-config-revisions.mjs";
import { validateChannelId } from "./channels.mjs";
import { validatePrincipalId, validateWorkspaceId } from "./principals.mjs";

export const AGENT_ADMINISTRATION_SCHEMA_VERSION = 1;

export const AGENT_ADMINISTRATION_CAPABILITIES = Object.freeze([
  "agent.roster.read",
  "agent.profile.read",
  "agent.history.read",
  "agent.create",
  "agent.config.read",
  "agent.config.create",
  "agent.config.revise",
  "agent.lifecycle.activate",
  "agent.lifecycle.disable",
  "agent.lifecycle.revoke",
  "channel.membership.manage",
  "provider.registry.read",
  "provider.registry.manage",
  "connection.reference.bind",
  "connection.grant.manage",
  "connection.credential.read",
  "principal.impersonate",
]);

export const AGENT_ADMINISTRATION_ACTOR_CLASSES = Object.freeze([
  "workspace-admin",
  "agent-manager",
  "agent-owner",
  "channel-manager",
  "connection-manager",
  "ordinary-member",
  "agent-principal",
  "service-principal",
]);

export const AGENT_ADMINISTRATION_GRANT_CAPABILITIES = Object.freeze([
  "agent.manager",
  "channel.manager",
  "connection.manager",
]);

export const AGENT_ADMINISTRATION_RESOURCE_TYPES = Object.freeze([
  "workspace",
  "agent",
  "channel",
  "connection",
]);

const WORKSPACE_ADMIN_CAPABILITIES = Object.freeze([
  "agent.roster.read",
  "agent.profile.read",
  "agent.history.read",
  "agent.create",
  "agent.config.read",
  "agent.config.create",
  "agent.config.revise",
  "agent.lifecycle.activate",
  "agent.lifecycle.disable",
  "agent.lifecycle.revoke",
  "channel.membership.manage",
  "provider.registry.read",
  "provider.registry.manage",
  "connection.reference.bind",
  "connection.grant.manage",
]);

const AGENT_MANAGER_CAPABILITIES = Object.freeze([
  "agent.roster.read",
  "agent.profile.read",
  "agent.history.read",
  "agent.create",
  "agent.config.read",
  "agent.config.create",
  "agent.config.revise",
  "agent.lifecycle.activate",
  "agent.lifecycle.disable",
  "agent.lifecycle.revoke",
]);

const AGENT_OWNER_CAPABILITIES = Object.freeze([
  "agent.roster.read",
  "agent.profile.read",
]);

const CHANNEL_MANAGER_CAPABILITIES = Object.freeze([
  "channel.membership.manage",
]);

const CONNECTION_MANAGER_CAPABILITIES = Object.freeze([
  "connection.reference.bind",
  "connection.grant.manage",
]);

const ORDINARY_MEMBER_CAPABILITIES = Object.freeze([
  "agent.roster.read",
  "agent.profile.read",
]);

export const AGENT_ADMINISTRATION_MATRIX = freezeMatrix({
  "workspace-admin": WORKSPACE_ADMIN_CAPABILITIES,
  "agent-manager": AGENT_MANAGER_CAPABILITIES,
  "agent-owner": AGENT_OWNER_CAPABILITIES,
  "channel-manager": CHANNEL_MANAGER_CAPABILITIES,
  "connection-manager": CONNECTION_MANAGER_CAPABILITIES,
  "ordinary-member": ORDINARY_MEMBER_CAPABILITIES,
  "agent-principal": ORDINARY_MEMBER_CAPABILITIES,
  "service-principal": [],
});

export const AGENT_ADMINISTRATION_REFUSALS = freezeMatrix(
  Object.fromEntries(
    AGENT_ADMINISTRATION_ACTOR_CLASSES.map((actorClass) => [
      actorClass,
      AGENT_ADMINISTRATION_CAPABILITIES.filter(
        (capability) =>
          !capabilitiesForActorClass(actorClass).includes(capability),
      ),
    ]),
  ),
);

export const AGENT_ADMINISTRATION_POLICY = AGENT_ADMINISTRATION_MATRIX;

const ADMINISTRATION_GRANT_ENTITY_TYPE = "administration.grant";
const ADMINISTRATION_GRANT_KEYS = [
  "capability",
  "grantId",
  "principalId",
  "resourceId",
  "resourceType",
  "revision",
  "status",
  "workspaceId",
];
const CONNECTION_ID_PATTERN =
  /^cn_([0-9a-hjkmnp-tv-z]{26})_([0-9a-hjkmnp-tv-z]{26})$/u;
const GRANT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;
const GRANT_STATUSES = Object.freeze(["active", "revoked"]);

export function AgentAdministrationValidationError(code, detail, path = "$") {
  this.name = "AgentAdministrationValidationError";
  this.message = `${code} at ${path}: ${detail}`;
  this.code = code;
  this.detail = detail;
  this.path = path;
}

export function administrationGrantId({
  capability,
  principalId,
  resourceId,
  resourceType,
}) {
  validateGrantParts({
    capability,
    principalId,
    resourceId,
    resourceType,
    workspaceId: workspaceIdFromResource({ resourceId, resourceType }),
  });
  return `grant:${principalId}:${capability}:${resourceType}:${resourceId}`;
}

export function createAdministrationGrant({
  capability,
  grantId = null,
  principalId,
  resourceId,
  resourceType,
  revision = 1,
  status = "active",
  workspaceId,
}) {
  validateWorkspaceId(workspaceId);
  validateGrantParts({
    capability,
    principalId,
    resourceId,
    resourceType,
    workspaceId,
  });
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw validationError(
      "ADMINISTRATION_GRANT_INVALID_REVISION",
      "revision must be a positive safe integer",
      "$.revision",
    );
  }
  if (!GRANT_STATUSES.includes(status)) {
    throw validationError(
      "ADMINISTRATION_GRANT_INVALID_STATUS",
      "status is not registered",
      "$.status",
    );
  }
  const expectedGrantId = administrationGrantId({
    capability,
    principalId,
    resourceId,
    resourceType,
  });
  if (grantId !== null && grantId !== expectedGrantId) {
    throw validationError(
      "ADMINISTRATION_GRANT_INVALID_ID",
      "grantId is not bound to the grant scope",
      "$.grantId",
    );
  }
  const value = {
    capability,
    grantId: grantId ?? expectedGrantId,
    principalId,
    resourceId,
    resourceType,
    revision,
    status,
    workspaceId,
  };
  return Object.freeze(value);
}

export function revokeAdministrationGrant(grant) {
  assertGrantShape(grant);
  return createAdministrationGrant({
    ...grant,
    revision: grant.revision + 1,
    status: "revoked",
  });
}

export function administrationGrantDirectoryUpdate(grant) {
  assertGrantShape(grant);
  return {
    entityType: ADMINISTRATION_GRANT_ENTITY_TYPE,
    id: grant.grantId,
    revision: grant.revision,
    value: { ...grant },
  };
}

export function readAdministrationGrants(state, { workspaceId } = {}) {
  if (workspaceId !== undefined) validateWorkspaceId(workspaceId);
  const entries = state?.entities?.directory;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return [];
  }
  const grants = [];
  for (const [id, entry] of Object.entries(entries)) {
    if (entry?.entityType !== ADMINISTRATION_GRANT_ENTITY_TYPE) continue;
    if (entry.id !== id) continue;
    try {
      const grant = createAdministrationGrant(entry.value ?? {});
      if (workspaceId !== undefined && grant.workspaceId !== workspaceId) {
        continue;
      }
      grants.push(grant);
    } catch {
      // An invalid grant can never add authority. The caller fails closed.
    }
  }
  return grants.sort((left, right) =>
    left.grantId.localeCompare(right.grantId),
  );
}

export function grantCoversResource(
  grant,
  { resourceId, resourceType, workspaceId },
) {
  assertGrantShape(grant);
  validateWorkspaceId(workspaceId);
  validateGrantResource(resourceType, resourceId, workspaceId);
  return (
    (grant.workspaceId === workspaceId &&
      grant.resourceType === "workspace" &&
      grant.resourceId === workspaceId) ||
    (grant.workspaceId === workspaceId &&
      grant.resourceType === resourceType &&
      grant.resourceId === resourceId)
  );
}

export function capabilityAllowedForActorClass(actorClass, capability) {
  return (
    AGENT_ADMINISTRATION_ACTOR_CLASSES.includes(actorClass) &&
    AGENT_ADMINISTRATION_CAPABILITIES.includes(capability) &&
    capabilitiesForActorClass(actorClass).includes(capability)
  );
}

function validateGrantParts({
  capability,
  principalId,
  resourceId,
  resourceType,
  workspaceId,
}) {
  validateWorkspaceId(workspaceId);
  validatePrincipalId(principalId, { expectedWorkspaceId: workspaceId });
  if (!AGENT_ADMINISTRATION_GRANT_CAPABILITIES.includes(capability)) {
    throw validationError(
      "ADMINISTRATION_GRANT_INVALID_CAPABILITY",
      "capability is not registered",
      "$.capability",
    );
  }
  if (!AGENT_ADMINISTRATION_RESOURCE_TYPES.includes(resourceType)) {
    throw validationError(
      "ADMINISTRATION_GRANT_INVALID_RESOURCE",
      "resourceType is not registered",
      "$.resourceType",
    );
  }
  validateGrantResource(resourceType, resourceId, workspaceId);
}

function validateGrantResource(resourceType, resourceId, workspaceId) {
  if (resourceType === "workspace") {
    validateWorkspaceId(resourceId);
    if (resourceId !== workspaceId) {
      throw validationError(
        "ADMINISTRATION_GRANT_SCOPE_MISMATCH",
        "workspace grant belongs to another workspace",
        "$.resourceId",
      );
    }
    return;
  }
  if (resourceType === "agent") {
    validateAgentConfigAgentId(resourceId, {
      expectedWorkspaceId: workspaceId,
    });
    return;
  }
  if (resourceType === "channel") {
    validateChannelId(resourceId, { expectedWorkspaceId: workspaceId });
    return;
  }
  if (
    typeof resourceId !== "string" ||
    !CONNECTION_ID_PATTERN.test(resourceId) ||
    `ws_${resourceId.slice(3, 29)}` !== workspaceId
  ) {
    throw validationError(
      "ADMINISTRATION_GRANT_SCOPE_MISMATCH",
      "connection resource belongs to another workspace or is invalid",
      "$.resourceId",
    );
  }
}

function workspaceIdFromResource({ resourceId, resourceType }) {
  if (resourceType === "workspace") return resourceId;
  if (typeof resourceId === "string" && resourceId.startsWith("cn_")) {
    return `ws_${resourceId.slice(3, 29)}`;
  }
  if (typeof resourceId === "string") {
    return `ws_${resourceId.slice(3, 29)}`;
  }
  throw validationError(
    "ADMINISTRATION_GRANT_INVALID_RESOURCE",
    "resourceId is required",
    "$.resourceId",
  );
}

function assertGrantShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationError(
      "ADMINISTRATION_GRANT_INVALID_RECORD",
      "grant must be an object",
    );
  }
  if (
    Object.keys(value).length !== ADMINISTRATION_GRANT_KEYS.length ||
    ADMINISTRATION_GRANT_KEYS.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !ADMINISTRATION_GRANT_KEYS.includes(key))
  ) {
    throw validationError(
      "ADMINISTRATION_GRANT_INVALID_RECORD",
      "grant has an invalid shape",
    );
  }
  if (!GRANT_ID_PATTERN.test(value.grantId)) {
    throw validationError(
      "ADMINISTRATION_GRANT_INVALID_ID",
      "grantId is invalid",
      "$.grantId",
    );
  }
  createAdministrationGrant(value);
}

function validationError(code, detail, path) {
  return new AgentAdministrationValidationError(code, detail, path);
}

function capabilitiesForActorClass(actorClass) {
  switch (actorClass) {
    case "workspace-admin":
      return WORKSPACE_ADMIN_CAPABILITIES;
    case "agent-manager":
      return AGENT_MANAGER_CAPABILITIES;
    case "agent-owner":
      return AGENT_OWNER_CAPABILITIES;
    case "channel-manager":
      return CHANNEL_MANAGER_CAPABILITIES;
    case "connection-manager":
      return CONNECTION_MANAGER_CAPABILITIES;
    case "ordinary-member":
    case "agent-principal":
      return ORDINARY_MEMBER_CAPABILITIES;
    case "service-principal":
      return [];
    default:
      return [];
  }
}

function freezeMatrix(matrix) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(matrix).map(([key, value]) => [
        key,
        Object.freeze([...value]),
      ]),
    ),
  );
}
