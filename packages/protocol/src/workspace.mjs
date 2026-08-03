import {
  PRINCIPAL_KINDS,
  validatePrincipalId,
  validateWorkspaceId,
  workspaceIdFromPrincipalId,
} from "./principals.mjs";

export const WORKSPACE_SCHEMA_VERSION = 1;

export const WORKSPACE_EVENT_TYPES_V1 = Object.freeze([
  "workspace.created",
  "workspace.membership.invited",
  "workspace.membership.accepted",
  "workspace.membership.role.changed",
  "workspace.membership.suspended",
  "workspace.membership.removed",
]);

export const WORKSPACE_ROLES = Object.freeze([
  "owner",
  "admin",
  "member",
  "guest",
  "agent",
  "service",
]);

export const WORKSPACE_MEMBERSHIP_STATUSES = Object.freeze([
  "active",
  "suspended",
  "removed",
]);

export const WORKSPACE_CAPABILITIES = Object.freeze([
  "workspace.read",
  "workspace.directory.read",
  "workspace.directory.mutate",
  "workspace.subscribe",
  "workspace.message.mutate",
  "workspace.channel.manage",
  "workspace.membership.invite",
  "workspace.membership.accept",
  "workspace.membership.role.change",
  "workspace.membership.suspend",
  "workspace.membership.remove",
]);

const ALL_CAPABILITIES = Object.freeze([...WORKSPACE_CAPABILITIES]);
export const ROLE_CAPABILITIES = Object.freeze({
  owner: ALL_CAPABILITIES,
  admin: ALL_CAPABILITIES,
  member: Object.freeze([
    "workspace.read",
    "workspace.directory.read",
    "workspace.directory.mutate",
    "workspace.subscribe",
    "workspace.message.mutate",
  ]),
  guest: Object.freeze([
    "workspace.read",
    "workspace.directory.read",
    "workspace.subscribe",
  ]),
  agent: Object.freeze([
    "workspace.read",
    "workspace.directory.read",
    "workspace.directory.mutate",
    "workspace.subscribe",
    "workspace.message.mutate",
  ]),
  service: Object.freeze([
    "workspace.read",
    "workspace.directory.read",
    "workspace.directory.mutate",
  ]),
});

export const WORKSPACE_ERROR_CODES = Object.freeze({
  INVALID_ID: "WORKSPACE_INVALID_ID",
  INVALID_ROLE: "WORKSPACE_INVALID_ROLE",
  INVALID_STATUS: "WORKSPACE_INVALID_STATUS",
  INVALID_WORKSPACE: "WORKSPACE_INVALID_WORKSPACE",
  ROLE_KIND_MISMATCH: "WORKSPACE_ROLE_KIND_MISMATCH",
});

const WORKSPACE_TOKEN = "[0-9a-hjkmnp-tv-z]{26}";
const MEMBERSHIP_PATTERN = new RegExp(
  `^mb_(${WORKSPACE_TOKEN})_(${WORKSPACE_TOKEN})$`,
  "u",
);
const INVITE_PATTERN = new RegExp(
  `^iv_(${WORKSPACE_TOKEN})_(${WORKSPACE_TOKEN})$`,
  "u",
);

export class WorkspaceValidationError extends Error {
  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      name: this.name,
      path: this.path,
    };
  }
}

export function workspaceError(code, path, detail) {
  const error = new WorkspaceValidationError(`${code} at ${path}: ${detail}`);
  error.name = "WorkspaceValidationError";
  error.code = code;
  error.path = path;
  error.detail = detail;
  return error;
}

export function validateRole(value, path = "$.role") {
  if (typeof value !== "string" || !WORKSPACE_ROLES.includes(value)) {
    throw workspaceError(
      WORKSPACE_ERROR_CODES.INVALID_ROLE,
      path,
      "role is not registered",
    );
  }
  return value;
}

export function validateMembershipStatus(value, path = "$.membership.status") {
  if (
    typeof value !== "string" ||
    !WORKSPACE_MEMBERSHIP_STATUSES.includes(value)
  ) {
    throw workspaceError(
      WORKSPACE_ERROR_CODES.INVALID_STATUS,
      path,
      "membership status is not registered",
    );
  }
  return value;
}

export function roleHasCapability(role, capability) {
  validateRole(role);
  if (
    typeof capability !== "string" ||
    !WORKSPACE_CAPABILITIES.includes(capability)
  ) {
    return false;
  }
  if (role === "owner") return ROLE_CAPABILITIES.owner.includes(capability);
  if (role === "admin") return ROLE_CAPABILITIES.admin.includes(capability);
  if (role === "member") return ROLE_CAPABILITIES.member.includes(capability);
  if (role === "guest") return ROLE_CAPABILITIES.guest.includes(capability);
  if (role === "agent") return ROLE_CAPABILITIES.agent.includes(capability);
  return ROLE_CAPABILITIES.service.includes(capability);
}

export function roleForPrincipalKind(kind) {
  if (!PRINCIPAL_KINDS.includes(kind)) {
    throw workspaceError(
      WORKSPACE_ERROR_CODES.ROLE_KIND_MISMATCH,
      "$.principal.kind",
      "principal kind is not registered",
    );
  }
  return kind === "human" ? "member" : kind;
}

export function roleAllowsPrincipalKind(role, kind) {
  validateRole(role);
  if (!PRINCIPAL_KINDS.includes(kind)) return false;
  if (["owner", "admin", "member", "guest"].includes(role)) {
    return kind === "human";
  }
  return role === kind;
}

export function membershipIdFor(workspaceId, principalId) {
  validateWorkspaceId(workspaceId);
  validatePrincipalId(principalId, { expectedWorkspaceId: workspaceId });
  return `mb_${principalId.slice(3)}`;
}

export function validateMembershipId(
  value,
  { expectedWorkspaceId, path = "$.membershipId" } = {},
) {
  const match =
    typeof value === "string" ? value.match(MEMBERSHIP_PATTERN) : null;
  if (!match) {
    throw workspaceError(
      WORKSPACE_ERROR_CODES.INVALID_ID,
      path,
      "membership id must be workspace scoped",
    );
  }
  if (expectedWorkspaceId !== undefined) {
    validateWorkspaceId(expectedWorkspaceId);
    if (`ws_${match[1]}` !== expectedWorkspaceId) {
      throw workspaceError(
        WORKSPACE_ERROR_CODES.INVALID_ID,
        path,
        "membership belongs to a different workspace",
      );
    }
  }
  return value;
}

export function principalIdFromMembershipId(value, path = "$.membershipId") {
  const match = value.match(MEMBERSHIP_PATTERN);
  if (!match) {
    throw workspaceError(
      WORKSPACE_ERROR_CODES.INVALID_ID,
      path,
      "membership id must be workspace scoped",
    );
  }
  return `pr_${match[1]}_${match[2]}`;
}

export function validateInviteId(
  value,
  { expectedWorkspaceId, path = "$.inviteId" } = {},
) {
  const match = typeof value === "string" ? value.match(INVITE_PATTERN) : null;
  if (!match) {
    throw workspaceError(
      WORKSPACE_ERROR_CODES.INVALID_ID,
      path,
      "invite id must be workspace scoped",
    );
  }
  if (expectedWorkspaceId !== undefined) {
    validateWorkspaceId(expectedWorkspaceId);
    if (`ws_${match[1]}` !== expectedWorkspaceId) {
      throw workspaceError(
        WORKSPACE_ERROR_CODES.INVALID_ID,
        path,
        "invite belongs to a different workspace",
      );
    }
  }
  return value;
}

export function workspaceIdFromMembershipId(value, path = "$.membershipId") {
  const match = value.match(MEMBERSHIP_PATTERN);
  if (!match) {
    throw workspaceError(
      WORKSPACE_ERROR_CODES.INVALID_ID,
      path,
      "membership id must be workspace scoped",
    );
  }
  return `ws_${match[1]}`;
}

export function membershipPrincipalWorkspace(value, path = "$.principalId") {
  return workspaceIdFromPrincipalId(value, path);
}
