export const PRINCIPAL_SCHEMA_VERSION = 1;

export const PRINCIPAL_KINDS = Object.freeze(["human", "agent", "service"]);

export const PRINCIPAL_STATUSES = Object.freeze([
  "active",
  "suspended",
  "deactivated",
]);

export const PRINCIPAL_EVENT_TYPES_V1 = Object.freeze([
  "principal.created",
  "principal.profile.updated",
  "principal.suspended",
  "principal.deactivated",
]);

export const PRINCIPAL_ERROR_CODES = Object.freeze({
  ACTOR_FIELD_FORBIDDEN: "PRINCIPAL_ACTOR_FIELD_FORBIDDEN",
  AUTHENTICATION_REQUIRED: "PRINCIPAL_AUTHENTICATION_REQUIRED",
  DEACTIVATED: "PRINCIPAL_DEACTIVATED",
  INVALID_AUTHENTICATION: "PRINCIPAL_INVALID_AUTHENTICATION",
  INVALID_KIND: "PRINCIPAL_INVALID_KIND",
  INVALID_OWNER: "PRINCIPAL_INVALID_OWNER",
  INVALID_PROFILE: "PRINCIPAL_INVALID_PROFILE",
  INVALID_RECORD: "PRINCIPAL_INVALID_RECORD",
  INVALID_STATUS: "PRINCIPAL_INVALID_STATUS",
  INVALID_SUBJECT_BINDING: "PRINCIPAL_INVALID_SUBJECT_BINDING",
  NOT_FOUND: "PRINCIPAL_NOT_FOUND",
  SCOPE_MISMATCH: "PRINCIPAL_SCOPE_MISMATCH",
  SUBJECT_MISMATCH: "PRINCIPAL_SUBJECT_MISMATCH",
  SUBJECT_REUSED: "PRINCIPAL_SUBJECT_REUSED",
  SUSPENDED: "PRINCIPAL_SUSPENDED",
});

const WORKSPACE_TOKEN = "[0-9a-hjkmnp-tv-z]{26}";
const PRINCIPAL_PATTERN = new RegExp(
  `^pr_(${WORKSPACE_TOKEN})_(${WORKSPACE_TOKEN})$`,
  "u",
);
const WORKSPACE_PATTERN = new RegExp(`^ws_${WORKSPACE_TOKEN}$`, "u");
const ISSUER_PATTERN = /^[a-z][a-z0-9._:-]{1,63}$/u;
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/u;
const SUBJECT_FORBIDDEN_PATTERN =
  /^(?:bearer\s|basic\s|password[=:]|secret[=:]|session[=:]|token[=:])/iu;

const SUBJECT_BINDING_KEYS = ["audience", "issuer", "subject"];
const PROFILE_KEYS = ["displayName", "email", "handle"];
const RECORD_KEYS = [
  "kind",
  "ownedBy",
  "principalId",
  "profile",
  "profileRevision",
  "status",
  "subjectBinding",
];

export class PrincipalValidationError extends Error {
  constructor(code, path, detail) {
    super(`${code} at ${path}: ${detail}`);
    this.name = "PrincipalValidationError";
    this.code = code;
    this.path = path;
    this.detail = detail;
  }

  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      name: this.name,
      path: this.path,
    };
  }
}

export function validateWorkspaceId(value, path = "$.workspaceId") {
  if (typeof value !== "string" || !WORKSPACE_PATTERN.test(value)) {
    throw principalError(
      PRINCIPAL_ERROR_CODES.SCOPE_MISMATCH,
      path,
      "workspace id must be a lowercase workspace identifier",
    );
  }
  return value;
}

export function validatePrincipalId(
  value,
  { expectedWorkspaceId, path = "$.principalId" } = {},
) {
  if (typeof value !== "string") {
    throw principalError(
      PRINCIPAL_ERROR_CODES.INVALID_RECORD,
      path,
      "principal id must be a string",
    );
  }
  const match = value.match(PRINCIPAL_PATTERN);
  if (!match) {
    throw principalError(
      PRINCIPAL_ERROR_CODES.INVALID_RECORD,
      path,
      "principal id must be a workspace-scoped immutable id",
    );
  }
  if (expectedWorkspaceId !== undefined) {
    validateWorkspaceId(expectedWorkspaceId);
    if (`ws_${match[1]}` !== expectedWorkspaceId) {
      throw principalError(
        PRINCIPAL_ERROR_CODES.SCOPE_MISMATCH,
        path,
        "principal belongs to a different workspace",
      );
    }
  }
  return value;
}

export function workspaceIdFromPrincipalId(value, path = "$.principalId") {
  validatePrincipalId(value, { path });
  return `ws_${value.slice(3, 29)}`;
}

export function validateSubjectBinding(value, path = "$.subjectBinding") {
  assertExactKeys(value, SUBJECT_BINDING_KEYS, path);
  assertBoundString(value.issuer, `${path}.issuer`, 64);
  if (!ISSUER_PATTERN.test(value.issuer)) {
    throw principalError(
      PRINCIPAL_ERROR_CODES.INVALID_SUBJECT_BINDING,
      `${path}.issuer`,
      "issuer must be a lowercase provider name",
    );
  }
  assertBoundString(value.subject, `${path}.subject`, 256);
  if (SUBJECT_FORBIDDEN_PATTERN.test(value.subject)) {
    throw principalError(
      PRINCIPAL_ERROR_CODES.INVALID_SUBJECT_BINDING,
      `${path}.subject`,
      "subject binding must not contain a bearer or secret credential",
    );
  }
  assertBoundString(value.audience, `${path}.audience`, 128);
  return value;
}

export function validateAuthenticatedSubject(value) {
  try {
    return validateSubjectBinding(value, "$.authenticatedSubject");
  } catch (error) {
    if (error instanceof PrincipalValidationError) {
      throw new PrincipalValidationError(
        PRINCIPAL_ERROR_CODES.INVALID_AUTHENTICATION,
        error.path,
        error.detail,
      );
    }
    throw error;
  }
}

export function subjectBindingKey(value) {
  validateSubjectBinding(value);
  return `${value.issuer}\u0000${value.audience}\u0000${value.subject}`;
}

export function sameSubjectBinding(left, right) {
  return subjectBindingKey(left) === subjectBindingKey(right);
}

export function validatePrincipalProfile(value, path = "$.profile") {
  assertExactKeys(value, PROFILE_KEYS, path);
  assertBoundString(value.displayName, `${path}.displayName`, 160);
  assertBoundString(value.handle, `${path}.handle`, 64);
  if (!HANDLE_PATTERN.test(value.handle)) {
    throw principalError(
      PRINCIPAL_ERROR_CODES.INVALID_PROFILE,
      `${path}.handle`,
      "handle must be lowercase and contain only letters, digits, dot, underscore, or hyphen",
    );
  }
  if (typeof value.email !== "string" || value.email.length > 320) {
    throw principalError(
      PRINCIPAL_ERROR_CODES.INVALID_PROFILE,
      `${path}.email`,
      "email must be a bounded string",
    );
  }
  if (value.email && !EMAIL_PATTERN.test(value.email)) {
    throw principalError(
      PRINCIPAL_ERROR_CODES.INVALID_PROFILE,
      `${path}.email`,
      "email must be an address or an empty service value",
    );
  }
  return value;
}

export function validatePrincipalRecord(value, { expectedWorkspaceId } = {}) {
  assertExactKeys(value, RECORD_KEYS, "$.principal");
  validatePrincipalId(value.principalId, { expectedWorkspaceId });
  if (!PRINCIPAL_KINDS.includes(value.kind)) {
    throw principalError(
      PRINCIPAL_ERROR_CODES.INVALID_KIND,
      "$.principal.kind",
      "kind must be human, agent, or service",
    );
  }
  if (!PRINCIPAL_STATUSES.includes(value.status)) {
    throw principalError(
      PRINCIPAL_ERROR_CODES.INVALID_STATUS,
      "$.principal.status",
      "status is not registered",
    );
  }
  validatePrincipalProfile(value.profile);
  validateSubjectBinding(value.subjectBinding);
  if (
    !Number.isSafeInteger(value.profileRevision) ||
    value.profileRevision < 1
  ) {
    throw principalError(
      PRINCIPAL_ERROR_CODES.INVALID_RECORD,
      "$.principal.profileRevision",
      "profile revision must be a positive integer",
    );
  }
  if (value.ownedBy !== null) {
    validatePrincipalId(value.ownedBy, {
      expectedWorkspaceId,
      path: "$.principal.ownedBy",
    });
  }
  if (value.kind === "agent" && value.ownedBy === null) {
    throw principalError(
      PRINCIPAL_ERROR_CODES.INVALID_OWNER,
      "$.principal.ownedBy",
      "agent principals require an owner reference",
    );
  }
  if (value.kind !== "agent" && value.ownedBy !== null) {
    throw principalError(
      PRINCIPAL_ERROR_CODES.INVALID_OWNER,
      "$.principal.ownedBy",
      "only agent principals may carry an owner reference",
    );
  }
  return value;
}

export function assertPrincipalCanMutate(principal) {
  if (!principal || typeof principal !== "object") {
    throw principalError(
      PRINCIPAL_ERROR_CODES.NOT_FOUND,
      "$.principal",
      "authenticated principal was not found",
    );
  }
  if (principal.status === "suspended") {
    throw principalError(
      PRINCIPAL_ERROR_CODES.SUSPENDED,
      "$.principal.status",
      "suspended principals cannot create new mutations",
    );
  }
  if (principal.status === "deactivated") {
    throw principalError(
      PRINCIPAL_ERROR_CODES.DEACTIVATED,
      "$.principal.status",
      "deactivated principals cannot create new mutations",
    );
  }
  if (principal.status !== "active") {
    throw principalError(
      PRINCIPAL_ERROR_CODES.INVALID_STATUS,
      "$.principal.status",
      "principal is not active",
    );
  }
  return principal;
}

export function assertPrincipalSubject(principal, authenticatedSubject) {
  if (!principal?.subjectBinding) {
    throw principalError(
      PRINCIPAL_ERROR_CODES.NOT_FOUND,
      "$.principal.subjectBinding",
      "principal has no subject binding",
    );
  }
  validateAuthenticatedSubject(authenticatedSubject);
  if (!sameSubjectBinding(principal.subjectBinding, authenticatedSubject)) {
    throw principalError(
      PRINCIPAL_ERROR_CODES.SUBJECT_MISMATCH,
      "$.authenticatedSubject",
      "authenticated subject is not bound to this principal",
    );
  }
  return principal;
}

export function principalError(code, path, detail) {
  return new PrincipalValidationError(code, path, detail);
}

function assertExactKeys(value, expectedKeys, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw principalError(
      PRINCIPAL_ERROR_CODES.INVALID_RECORD,
      path,
      "expected an object",
    );
  }
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw principalError(
        PRINCIPAL_ERROR_CODES.INVALID_RECORD,
        `${path}.${key}`,
        "field is not allowed",
      );
    }
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) {
      throw principalError(
        PRINCIPAL_ERROR_CODES.INVALID_RECORD,
        `${path}.${key}`,
        "field is required",
      );
    }
  }
}

function assertBoundString(value, path, maxLength) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    hasControlCharacter(value)
  ) {
    throw principalError(
      PRINCIPAL_ERROR_CODES.INVALID_RECORD,
      path,
      "value must be a non-empty bounded string without control characters",
    );
  }
}

function hasControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}
