import {
  AGENT_ADMINISTRATION_ACTOR_CLASSES,
  AGENT_ADMINISTRATION_CAPABILITIES,
  AGENT_ADMINISTRATION_RESOURCE_TYPES,
  capabilityAllowedForActorClass,
  grantCoversResource,
  readAdministrationGrants,
  validateAgentConfigAgentId,
  validateWorkspaceId,
} from "@stream-slack/protocol";

import { assertWorkspaceContext } from "./workspace-auth.mjs";

export const AGENT_ADMINISTRATION_AUTH_ERROR_CODES = Object.freeze({
  ACCESS_DENIED: "AGENT_ADMINISTRATION_ACCESS_DENIED",
  CONTEXT_REQUIRED: "AGENT_ADMINISTRATION_CONTEXT_REQUIRED",
  INVALID_REQUEST: "AGENT_ADMINISTRATION_INVALID_REQUEST",
});

const OPERATION_SCOPE = Object.freeze({
  "agent.config.create": "agent",
  "agent.config.read": "agent",
  "agent.config.revise": "agent",
  "agent.create": "workspace",
  "agent.history.read": "agent",
  "agent.lifecycle.activate": "agent",
  "agent.lifecycle.disable": "agent",
  "agent.lifecycle.revoke": "agent",
  "agent.profile.read": "agent",
  "agent.roster.read": "workspace",
  "channel.membership.manage": "channel",
  "connection.credential.read": "connection",
  "connection.grant.manage": "connection",
  "connection.reference.bind": "connection",
  "principal.impersonate": "workspace",
  "provider.registry.manage": "workspace",
  "provider.registry.read": "workspace",
});

const GRANT_CLASS_BY_CAPABILITY = Object.freeze({
  "agent.manager": "agent-manager",
  "channel.manager": "channel-manager",
  "connection.manager": "connection-manager",
});

export class AgentAdministrationAuthorizationError extends Error {
  constructor(code, detail, { statusCode = 404 } = {}) {
    super(`${code}: ${detail}`);
    this.name = "AgentAdministrationAuthorizationError";
    this.code = code;
    this.detail = detail;
    this.statusCode = statusCode;
  }

  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      statusCode: this.statusCode,
    };
  }
}

export function createAgentAdministrationAuthorization({
  readDirectory,
  workspaceId,
}) {
  if (typeof readDirectory !== "function") {
    throw new TypeError(
      "agent administration authorization requires readDirectory",
    );
  }
  validateWorkspaceId(workspaceId);

  async function authorizeMutation({
    agentId = null,
    context,
    operation,
    resourceId = null,
    resourceType = null,
  }) {
    const decision = await decide({
      agentId,
      context,
      operations: [operation],
      resourceId,
      resourceType,
    });
    if (!decision.allowedOperations.includes(operation)) throw accessDenied();
    return decision;
  }

  async function authorizeRead({
    agentId = null,
    context,
    operations,
    resourceId = null,
    resourceType = null,
  }) {
    const requested = Array.isArray(operations) ? operations : [operations];
    const decision = await decide({
      agentId,
      context,
      operations: requested,
      resourceId,
      resourceType,
    });
    if (decision.allowedOperations.length === 0) throw accessDenied();
    return decision;
  }

  async function explain({
    agentId = null,
    context,
    operations,
    resourceId = null,
    resourceType = null,
  }) {
    return decide({
      agentId,
      context,
      operations: Array.isArray(operations) ? operations : [operations],
      resourceId,
      resourceType,
    });
  }

  async function decide({
    agentId,
    context,
    operations,
    resourceId,
    resourceType,
  }) {
    const trusted = assertWorkspaceContext(context);
    if (trusted.workspaceId !== workspaceId) throw accessDenied();
    if (
      !Array.isArray(operations) ||
      operations.length === 0 ||
      operations.some((operation) => !isKnownCapability(operation))
    ) {
      throw invalidRequest("administration operation is not registered");
    }

    const normalized = normalizeTarget({
      agentId,
      operations,
      resourceId,
      resourceType,
      workspaceId,
    });
    const directory = await readDirectory();
    const state = directory?.state;
    const principal = state?.entities?.principals?.[trusted.principalId];
    const membership = membershipFor(state, trusted.principalId, workspaceId);
    if (
      !principal ||
      principal.principalId !== trusted.principalId ||
      principal.status !== "active" ||
      !membership ||
      membership.workspaceId !== workspaceId ||
      membership.principalId !== trusted.principalId ||
      membership.status !== "active"
    ) {
      throw accessDenied();
    }

    const targetAgent = normalized.agentId
      ? agentFor(state, normalized.agentId, workspaceId)
      : null;
    if (normalized.agentId && !targetAgent) throw accessDenied();

    const grants = readAdministrationGrants(state, { workspaceId }).filter(
      (grant) =>
        grant.status === "active" && grant.principalId === trusted.principalId,
    );
    const actorClasses = actorClassesFor({
      grants,
      membership,
      principal,
      targetAgent,
      workspaceId,
      normalized,
    });
    const allowedOperations = normalized.operations.filter((operation) =>
      actorClasses.some((actorClass) =>
        capabilityAllowedForActorClass(actorClass, operation),
      ),
    );

    return Object.freeze({
      actorClasses: Object.freeze(actorClasses),
      allowed: allowedOperations.length > 0,
      allowedOperations: Object.freeze(allowedOperations),
      includeConfiguration: allowedOperations.includes("agent.config.read"),
      membershipRevision: membership.revision,
      principalId: trusted.principalId,
      source: {
        directoryDigest: directory?.stateDigest ?? null,
        directoryHead: directory?.nextOffset ?? null,
      },
      workspaceId,
    });
  }

  return Object.freeze({
    authorizeMutation,
    authorizeRead,
    explain,
  });
}

function actorClassesFor({
  grants,
  membership,
  normalized,
  principal,
  targetAgent,
  workspaceId,
}) {
  const classes = [];
  if (principal.kind === "human") {
    if (membership.role === "owner" || membership.role === "admin") {
      classes.push("workspace-admin");
    }
    if (membership.role === "member" || membership.role === "guest") {
      classes.push("ordinary-member");
    }
    if (targetAgent?.ownedBy === principal.principalId) {
      classes.push("agent-owner");
    }
  } else if (principal.kind === "agent") {
    classes.push("agent-principal");
  } else if (principal.kind === "service") {
    classes.push("service-principal");
  }

  for (const grant of grants) {
    const actorClass = GRANT_CLASS_BY_CAPABILITY[grant.capability];
    if (
      !actorClass ||
      !grantCoversNormalizedScope(grant, normalized, workspaceId)
    ) {
      continue;
    }
    if (!classes.includes(actorClass)) classes.push(actorClass);
  }
  return classes.filter((actorClass) =>
    AGENT_ADMINISTRATION_ACTOR_CLASSES.includes(actorClass),
  );
}

function grantCoversNormalizedScope(grant, normalized, workspaceId) {
  try {
    return grantCoversResource(grant, {
      resourceId: normalized.resourceId,
      resourceType: normalized.resourceType,
      workspaceId,
    });
  } catch {
    return false;
  }
}

function normalizeTarget({
  agentId,
  operations,
  resourceId,
  resourceType,
  workspaceId,
}) {
  let normalizedAgentId = agentId;
  if (normalizedAgentId !== null) {
    try {
      validateAgentConfigAgentId(normalizedAgentId, {
        expectedWorkspaceId: workspaceId,
      });
    } catch {
      throw accessDenied();
    }
  }
  const scopes = new Set(
    operations.map((operation) => OPERATION_SCOPE[operation]),
  );
  if (
    resourceType !== null &&
    !AGENT_ADMINISTRATION_RESOURCE_TYPES.includes(resourceType)
  ) {
    throw invalidRequest("administration resource type is not registered");
  }
  const inferredType =
    resourceType ?? (scopes.size === 1 ? scopes.values().next().value : null);
  if (inferredType === null) {
    throw invalidRequest("administration resource type is ambiguous");
  }
  if (normalizedAgentId !== null) {
    if (inferredType !== "agent") throw accessDenied();
    resourceId ??= normalizedAgentId;
  }
  if (resourceId === null) {
    resourceId = inferredType === "workspace" ? workspaceId : null;
  }
  if (resourceId === null) throw accessDenied();
  return {
    agentId: normalizedAgentId,
    operations,
    resourceId,
    resourceType: inferredType,
  };
}

function membershipFor(state, principalId, workspaceId) {
  const membershipId = `mb_${workspaceId.slice(3)}_${principalId.slice(30)}`;
  return state?.entities?.memberships?.[membershipId] ?? null;
}

function agentFor(state, agentId, workspaceId) {
  try {
    validateAgentConfigAgentId(agentId, { expectedWorkspaceId: workspaceId });
  } catch {
    return null;
  }
  const principalId = `pr_${agentId.slice(3)}`;
  const principal = state?.entities?.principals?.[principalId];
  return principal?.kind === "agent" && principal.status === "active"
    ? principal
    : null;
}

function isKnownCapability(operation) {
  return (
    typeof operation === "string" &&
    AGENT_ADMINISTRATION_CAPABILITIES.includes(operation)
  );
}

function accessDenied() {
  return new AgentAdministrationAuthorizationError(
    AGENT_ADMINISTRATION_AUTH_ERROR_CODES.ACCESS_DENIED,
    "agent administration access denied",
  );
}

function invalidRequest(detail) {
  return new AgentAdministrationAuthorizationError(
    AGENT_ADMINISTRATION_AUTH_ERROR_CODES.INVALID_REQUEST,
    detail,
    { statusCode: 400 },
  );
}
