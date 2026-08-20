import { CONNECTION_ERROR_CODES, connectionError } from "./errors.mjs";
import { deepFreeze } from "./canonical.mjs";

export const CONNECTION_SCHEMA_VERSION = 1;
export const CONNECTION_EVENT_TYPES = Object.freeze([
  "connection.created",
  "connection.rotated",
  "connection.disabled",
  "connection.deleted",
]);
export const CONNECTION_STATUSES = Object.freeze([
  "active",
  "disabled",
  "deleted",
]);
export const CONNECTION_OWNER_KINDS = Object.freeze([
  "workspace",
  "agent",
  "user",
]);
export const CONNECTION_ACTIONS = Object.freeze([
  "read",
  "grant",
  "rotate",
  "disable",
  "delete",
]);

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OPAQUE_ID_PATTERN = /^[a-z][a-z0-9._:-]{2,127}$/u;
const LABEL_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._:/-]{0,127}$/u;
const METADATA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CREDENTIAL_KEY_PATTERN =
  /(?:password|secret|client[\s_-]?secret|credential|authorization|cookie|bearer|token|private.?key|connection.?string|api[_-]?key)/iu;
const CREDENTIAL_VALUE_PATTERNS = [
  /-----BEGIN [^-]*PRIVATE KEY-----/iu,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /\b(?:sk|rk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9._~+/=-]{8,}\b/iu,
  /(?:^|[^A-Za-z0-9])(?:password|token|secret|client[\s_-]?secret|api[_-]?key|private[_-]?key|cookie|authorization)\s*[:=]/iu,
  /\b(?:https?|ssh|postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?|amqp):\/\/\S+/iu,
  /(?:^|[\s;])(?:host|user|username|password|port)\s*=\s*[^;]+/iu,
];
const BASE64_VALUE_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/u;
const CONFUSABLES = new Map([
  ["а", "a"],
  ["с", "c"],
  ["е", "e"],
  ["і", "i"],
  ["о", "o"],
  ["р", "p"],
  ["х", "x"],
  ["у", "y"],
  ["к", "k"],
  ["т", "t"],
  ["в", "b"],
  ["м", "m"],
  ["н", "h"],
  ["д", "d"],
  ["ο", "o"],
  ["ρ", "p"],
  ["τ", "t"],
]);

export function normalizeSecretRef(input, path = "$.secretRef") {
  assertNoCredentialMaterial(input, path, new Set(), {
    allowGenericBase64: true,
  });
  const value = requireRecord(
    input,
    CONNECTION_ERROR_CODES.INVALID_SECRET_REF,
    path,
  );
  assertAllowedKeys(
    value,
    ["schemaVersion", "id", "provider", "mount", "revision", "label"],
    CONNECTION_ERROR_CODES.INVALID_SECRET_REF,
    path,
  );
  assertSchemaVersion(value.schemaVersion, path, "INVALID_SECRET_REF");
  const normalized = {
    schemaVersion: CONNECTION_SCHEMA_VERSION,
    id: normalizeOpaqueId(
      value.id,
      path + ".id",
      CONNECTION_ERROR_CODES.INVALID_SECRET_REF,
    ),
    provider: normalizeIdentifier(
      value.provider,
      path + ".provider",
      CONNECTION_ERROR_CODES.INVALID_SECRET_REF,
    ),
    mount: normalizeIdentifier(
      value.mount,
      path + ".mount",
      CONNECTION_ERROR_CODES.INVALID_SECRET_REF,
    ),
    revision: normalizePositiveRevision(
      value.revision,
      path + ".revision",
      CONNECTION_ERROR_CODES.INVALID_SECRET_REF,
    ),
    label:
      value.label === undefined || value.label === null
        ? null
        : normalizeLabel(
            value.label,
            path + ".label",
            CONNECTION_ERROR_CODES.INVALID_SECRET_REF,
          ),
  };
  if (normalized.provider !== "infisical") {
    throw connectionError(
      CONNECTION_ERROR_CODES.INVALID_SECRET_REF,
      "SecretRef provider is unsupported",
      { path: path + ".provider" },
    );
  }
  return deepFreeze(normalized);
}

export function normalizeConnectionDefinition(input, path = "$.connection") {
  assertNoCredentialMaterial(input, path, new Set(), {
    allowGenericBase64: true,
  });
  const value = requireRecord(
    input,
    CONNECTION_ERROR_CODES.INVALID_REQUEST,
    path,
  );
  assertAllowedKeys(
    value,
    [
      "schemaVersion",
      "connectionId",
      "tenantId",
      "workspaceId",
      "owner",
      "provider",
      "integration",
      "label",
      "metadata",
      "secretRef",
    ],
    CONNECTION_ERROR_CODES.INVALID_REQUEST,
    path,
  );
  assertSchemaVersion(value.schemaVersion, path, "INVALID_REQUEST");
  const normalized = {
    schemaVersion: CONNECTION_SCHEMA_VERSION,
    connectionId: normalizeOpaqueId(
      value.connectionId,
      path + ".connectionId",
      CONNECTION_ERROR_CODES.INVALID_REQUEST,
    ),
    tenantId: normalizeIdentifier(
      value.tenantId,
      path + ".tenantId",
      CONNECTION_ERROR_CODES.INVALID_REQUEST,
    ),
    workspaceId: normalizeIdentifier(
      value.workspaceId,
      path + ".workspaceId",
      CONNECTION_ERROR_CODES.INVALID_REQUEST,
    ),
    owner: normalizeOwner(value.owner, path + ".owner"),
    provider: normalizeIdentifier(
      value.provider,
      path + ".provider",
      CONNECTION_ERROR_CODES.INVALID_REQUEST,
    ),
    integration: normalizeIdentifier(
      value.integration,
      path + ".integration",
      CONNECTION_ERROR_CODES.INVALID_REQUEST,
    ),
    label: normalizeLabel(
      value.label,
      path + ".label",
      CONNECTION_ERROR_CODES.INVALID_REQUEST,
    ),
    metadata: normalizeMetadata(value.metadata, path + ".metadata"),
    secretRef: normalizeSecretRef(value.secretRef, path + ".secretRef"),
  };
  if (normalized.secretRef.provider !== "infisical") {
    throw connectionError(
      CONNECTION_ERROR_CODES.INVALID_SECRET_REF,
      "connection SecretRef provider is unsupported",
      { path: path + ".secretRef.provider" },
    );
  }
  return deepFreeze(normalized);
}

export function normalizeOwner(input, path = "$.owner") {
  const value = requireRecord(
    input,
    CONNECTION_ERROR_CODES.INVALID_REQUEST,
    path,
  );
  assertAllowedKeys(
    value,
    ["kind", "id"],
    CONNECTION_ERROR_CODES.INVALID_REQUEST,
    path,
  );
  const kind =
    value.kind === "human" || value.kind === "user" ? "user" : value.kind;
  if (!CONNECTION_OWNER_KINDS.includes(kind)) {
    throw connectionError(
      CONNECTION_ERROR_CODES.INVALID_REQUEST,
      "connection owner kind is unsupported",
      { path: path + ".kind" },
    );
  }
  return deepFreeze({
    kind,
    id: normalizeIdentifier(
      value.id,
      path + ".id",
      CONNECTION_ERROR_CODES.INVALID_REQUEST,
    ),
  });
}

export function normalizePrincipal(input, path = "$.principal") {
  const value = requireRecord(
    input,
    CONNECTION_ERROR_CODES.INVALID_REQUEST,
    path,
  );
  assertAllowedKeys(
    value,
    ["tenantId", "workspaceId", "id", "kind", "role", "capabilities"],
    CONNECTION_ERROR_CODES.INVALID_REQUEST,
    path,
  );
  const kind =
    value.kind === "human" || value.kind === "user" ? "user" : value.kind;
  if (!["workspace", "agent", "user", "service"].includes(kind)) {
    throw connectionError(
      CONNECTION_ERROR_CODES.INVALID_REQUEST,
      "principal kind is unsupported",
      { path: path + ".kind" },
    );
  }
  const capabilities = value.capabilities ?? [];
  assertNoCredentialMaterial(capabilities, path + ".capabilities");
  if (
    !Array.isArray(capabilities) ||
    capabilities.some(
      (capability) =>
        typeof capability !== "string" ||
        !/^[a-z][a-z0-9._:-]{0,127}$/u.test(capability),
    )
  ) {
    throw connectionError(
      CONNECTION_ERROR_CODES.INVALID_REQUEST,
      "principal capabilities are invalid",
      { path: path + ".capabilities" },
    );
  }
  return deepFreeze({
    tenantId: normalizeIdentifier(
      value.tenantId,
      path + ".tenantId",
      CONNECTION_ERROR_CODES.INVALID_REQUEST,
    ),
    workspaceId: normalizeIdentifier(
      value.workspaceId,
      path + ".workspaceId",
      CONNECTION_ERROR_CODES.INVALID_REQUEST,
    ),
    id: normalizeIdentifier(
      value.id,
      path + ".id",
      CONNECTION_ERROR_CODES.INVALID_REQUEST,
    ),
    kind,
    role:
      value.role === undefined || value.role === null
        ? null
        : normalizeIdentifier(
            value.role,
            path + ".role",
            CONNECTION_ERROR_CODES.INVALID_REQUEST,
          ),
    capabilities: [...new Set(capabilities)].sort(),
  });
}

export function normalizeConnectionEvent(input, path = "$.event") {
  const value = requireRecord(
    input,
    CONNECTION_ERROR_CODES.INVALID_EVENT,
    path,
  );
  assertNoCredentialMaterial(value, path, new Set(), {
    allowGenericBase64: true,
  });
  assertAllowedKeys(
    value,
    [
      "schemaVersion",
      "eventId",
      "eventType",
      "workspaceId",
      "actorId",
      "idempotencyKey",
      "sequence",
      "serverTimestamp",
      "connectionId",
      "data",
    ],
    CONNECTION_ERROR_CODES.INVALID_EVENT,
    path,
  );
  assertSchemaVersion(value.schemaVersion, path, "INVALID_EVENT");
  if (!CONNECTION_EVENT_TYPES.includes(value.eventType)) {
    throw connectionError(
      CONNECTION_ERROR_CODES.INVALID_EVENT,
      "connection event type is not registered",
      { path: path + ".eventType" },
    );
  }
  const normalized = {
    schemaVersion: CONNECTION_SCHEMA_VERSION,
    eventId: normalizeOpaqueId(
      value.eventId,
      path + ".eventId",
      CONNECTION_ERROR_CODES.INVALID_EVENT,
    ),
    eventType: value.eventType,
    workspaceId: normalizeIdentifier(
      value.workspaceId,
      path + ".workspaceId",
      CONNECTION_ERROR_CODES.INVALID_EVENT,
    ),
    actorId: normalizeIdentifier(
      value.actorId,
      path + ".actorId",
      CONNECTION_ERROR_CODES.INVALID_EVENT,
    ),
    idempotencyKey: normalizeOpaqueId(
      value.idempotencyKey,
      path + ".idempotencyKey",
      CONNECTION_ERROR_CODES.INVALID_EVENT,
    ),
    sequence: normalizePositiveRevision(
      value.sequence,
      path + ".sequence",
      CONNECTION_ERROR_CODES.INVALID_EVENT,
    ),
    serverTimestamp: normalizeTimestamp(value.serverTimestamp, path),
    connectionId: normalizeOpaqueId(
      value.connectionId,
      path + ".connectionId",
      CONNECTION_ERROR_CODES.INVALID_EVENT,
    ),
    data: normalizeEventData(value.eventType, value.data, path + ".data"),
  };
  if (
    normalized.eventType === "connection.created" &&
    (normalized.data.workspaceId !== normalized.workspaceId ||
      normalized.data.connectionId !== normalized.connectionId)
  ) {
    throw connectionError(
      CONNECTION_ERROR_CODES.INVALID_EVENT,
      "created connection identity does not match event identity",
      { path: path + ".data" },
    );
  }
  return deepFreeze(normalized);
}

export function createConnectionEvent(input) {
  return normalizeConnectionEvent(input);
}

export function normalizeMetadata(input, path = "$.metadata") {
  assertNoCredentialMaterial(input, path);
  return deepFreeze(normalizeMetadataValue(input, path, 0, new Set()));
}

export function assertNoCredentialMaterial(
  value,
  path = "$",
  seen = new Set(),
  { allowGenericBase64 = false } = {},
) {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (looksLikeCredentialValue(value, { allowGenericBase64 })) {
      throw connectionError(
        CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL,
        "credential-shaped material is not accepted",
        { path },
      );
    }
    return;
  }
  if (typeof value !== "object") return;
  if (seen.has(value)) {
    throw connectionError(
      CONNECTION_ERROR_CODES.INVALID_REQUEST,
      "cyclic input is not accepted",
      { path },
    );
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        assertNoCredentialMaterial(
          value[index],
          path + "[" + index + "]",
          seen,
          { allowGenericBase64 },
        );
      }
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (isCredentialKey(key)) {
        throw connectionError(
          CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL,
          "credential-shaped field is not accepted",
          { path: path + "." + key },
        );
      }
      assertNoCredentialMaterial(nested, path + "." + key, seen, {
        allowGenericBase64,
      });
    }
  } finally {
    seen.delete(value);
  }
}

export function isCredentialMaterial(value) {
  try {
    assertNoCredentialMaterial(value);
    return false;
  } catch (error) {
    if (error?.code === CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL) return true;
    throw error;
  }
}

export function normalizeReason(value, path = "$.reason") {
  if (value === undefined || value === null) return null;
  const normalized = typeof value === "string" ? value.trim() : value;
  assertNoCredentialMaterial(normalized, path);
  if (
    typeof normalized !== "string" ||
    [...normalized].length > 160 ||
    hasControlCharacter(normalized)
  ) {
    throw connectionError(
      CONNECTION_ERROR_CODES.INVALID_REQUEST,
      "reason must be a bounded safe label",
      { path },
    );
  }
  return normalized || null;
}

function normalizeEventData(eventType, input, path) {
  if (eventType === "connection.created") {
    const value = requireRecord(
      input,
      CONNECTION_ERROR_CODES.INVALID_EVENT,
      path,
    );
    assertAllowedKeys(
      value,
      [
        "schemaVersion",
        "connectionId",
        "tenantId",
        "workspaceId",
        "owner",
        "provider",
        "integration",
        "label",
        "metadata",
        "secretRef",
        "revision",
      ],
      CONNECTION_ERROR_CODES.INVALID_EVENT,
      path,
    );
    const { revision, ...definitionInput } = value;
    const definition = normalizeConnectionDefinition(definitionInput, path);
    const normalizedRevision = normalizePositiveRevision(
      revision ?? 1,
      path + ".revision",
      CONNECTION_ERROR_CODES.INVALID_EVENT,
    );
    if (normalizedRevision !== 1) {
      throw connectionError(
        CONNECTION_ERROR_CODES.SEQUENCE_CONFLICT,
        "connection creation must use revision one",
        { path: path + ".revision", statusCode: 409 },
      );
    }
    return deepFreeze({
      connectionId: definition.connectionId,
      tenantId: definition.tenantId,
      workspaceId: definition.workspaceId,
      owner: definition.owner,
      provider: definition.provider,
      integration: definition.integration,
      label: definition.label,
      metadata: definition.metadata,
      secretRef: definition.secretRef,
      revision: normalizedRevision,
    });
  }
  if (eventType === "connection.rotated") {
    const value = requireRecord(
      input,
      CONNECTION_ERROR_CODES.INVALID_EVENT,
      path,
    );
    assertAllowedKeys(
      value,
      ["expectedRevision", "revision", "secretRef"],
      CONNECTION_ERROR_CODES.INVALID_EVENT,
      path,
    );
    return deepFreeze({
      expectedRevision: normalizePositiveRevision(
        value.expectedRevision,
        path + ".expectedRevision",
        CONNECTION_ERROR_CODES.INVALID_EVENT,
      ),
      revision: normalizePositiveRevision(
        value.revision,
        path + ".revision",
        CONNECTION_ERROR_CODES.INVALID_EVENT,
      ),
      secretRef: normalizeSecretRef(value.secretRef, path + ".secretRef"),
    });
  }
  const value = requireRecord(
    input,
    CONNECTION_ERROR_CODES.INVALID_EVENT,
    path,
  );
  assertAllowedKeys(
    value,
    ["reason"],
    CONNECTION_ERROR_CODES.INVALID_EVENT,
    path,
  );
  return deepFreeze({
    reason: normalizeReason(value.reason, path + ".reason"),
  });
}

function normalizeMetadataValue(value, path, depth, seen) {
  if (depth > 4) {
    throw connectionError(
      CONNECTION_ERROR_CODES.INVALID_REQUEST,
      "metadata nesting is too deep",
      { path },
    );
  }
  if (value === null) return null;
  if (typeof value === "string") {
    if ([...value].length > 512 || hasControlCharacter(value)) {
      throw connectionError(
        CONNECTION_ERROR_CODES.INVALID_REQUEST,
        "metadata strings must be bounded printable labels",
        { path },
      );
    }
    return value;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw connectionError(
        CONNECTION_ERROR_CODES.INVALID_REQUEST,
        "metadata numbers must be finite safe integers",
        { path },
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 32) {
      throw connectionError(
        CONNECTION_ERROR_CODES.INVALID_REQUEST,
        "metadata arrays are too large",
        { path },
      );
    }
    if (seen.has(value)) {
      throw connectionError(
        CONNECTION_ERROR_CODES.INVALID_REQUEST,
        "metadata must not be cyclic",
        { path },
      );
    }
    seen.add(value);
    try {
      return value.map((item, index) =>
        normalizeMetadataValue(item, path + "[" + index + "]", depth + 1, seen),
      );
    } finally {
      seen.delete(value);
    }
  }
  if (!isPlainRecord(value)) {
    throw connectionError(
      CONNECTION_ERROR_CODES.INVALID_REQUEST,
      "metadata must contain only JSON values",
      { path },
    );
  }
  if (seen.has(value)) {
    throw connectionError(
      CONNECTION_ERROR_CODES.INVALID_REQUEST,
      "metadata must not be cyclic",
      { path },
    );
  }
  seen.add(value);
  try {
    const entries = Object.entries(value);
    if (entries.length > 64) {
      throw connectionError(
        CONNECTION_ERROR_CODES.INVALID_REQUEST,
        "metadata objects are too large",
        { path },
      );
    }
    const output = {};
    for (const [key, nested] of entries) {
      if (isCredentialKey(key, { allowSecretRef: false })) {
        throw connectionError(
          CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL,
          "credential-shaped metadata field is not accepted",
          { path: path + "." + key },
        );
      }
      if (!METADATA_KEY_PATTERN.test(key)) {
        throw connectionError(
          CONNECTION_ERROR_CODES.INVALID_REQUEST,
          "metadata keys must be ASCII non-secret labels",
          { path: path + "." + key },
        );
      }
      output[key] = normalizeMetadataValue(
        nested,
        path + "." + key,
        depth + 1,
        seen,
      );
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function isCredentialKey(key, { allowSecretRef = true } = {}) {
  if (allowSecretRef && (key === "secretRef" || key === "secretRefId")) {
    return false;
  }
  const normalized = securityNormalize(key);
  return (
    CREDENTIAL_KEY_PATTERN.test(key) ||
    (normalized !== key.toLowerCase() &&
      CREDENTIAL_KEY_PATTERN.test(normalized))
  );
}

function looksLikeCredentialValue(value, { allowGenericBase64 = false } = {}) {
  if (/\p{Cf}/u.test(value)) return true;
  const candidate = normalizeCredentialCandidate(value);
  if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(candidate))) {
    return true;
  }
  if (!allowGenericBase64 && isBase64EncodedValue(value)) return true;
  if (/^\s*(?:\[|\{)/u.test(candidate)) {
    try {
      const parsed = JSON.parse(candidate);
      assertNoCredentialMaterial(parsed);
    } catch (error) {
      if (error?.code === CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL)
        return true;
    }
  }
  return false;
}

function isBase64EncodedValue(value) {
  const candidate = normalizeCredentialCandidate(value).trim();
  if (candidate.length < 22 || !BASE64_VALUE_PATTERN.test(candidate))
    return false;
  const unpadded = candidate.replace(/=+$/u, "");
  if (unpadded.length % 4 === 1) return false;
  const normalized = unpadded.replace(/-/gu, "+").replace(/_/gu, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    atob(normalized + padding);
    return true;
  } catch {
    return false;
  }
}

function normalizeCredentialCandidate(value) {
  return value.normalize("NFKC").replace(/\p{Cf}/gu, "");
}

function securityNormalize(value) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u0300-\u036f\u200b-\u200f\ufeff]/gu, "")
    .replace(/[а-сеіорхуктвмндерορτ]/gu, (character) => {
      return CONFUSABLES.get(character) ?? character;
    });
}

function hasControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function assertSchemaVersion(value, path, codeName) {
  if (value !== undefined && value !== CONNECTION_SCHEMA_VERSION) {
    throw connectionError(
      CONNECTION_ERROR_CODES[codeName] ??
        CONNECTION_ERROR_CODES.INVALID_REQUEST,
      "schema version is unsupported",
      { path: path + ".schemaVersion" },
    );
  }
}

function normalizeIdentifier(value, path, code) {
  assertNoCredentialMaterial(value, path, new Set(), {
    allowGenericBase64: true,
  });
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw connectionError(code, "identifier is invalid", { path });
  }
  return value;
}

function normalizeOpaqueId(value, path, code) {
  assertNoCredentialMaterial(value, path, new Set(), {
    allowGenericBase64: true,
  });
  if (
    typeof value !== "string" ||
    !OPAQUE_ID_PATTERN.test(value) ||
    /(?:https?|ssh|postgres|mysql|redis|mongodb|amqp):\/\//iu.test(value)
  ) {
    throw connectionError(code, "opaque identifier is invalid", { path });
  }
  return value;
}

export function normalizeOpaqueIdForStore(value, path = "$.id") {
  return normalizeOpaqueId(value, path, CONNECTION_ERROR_CODES.INVALID_REQUEST);
}

function normalizeLabel(value, path, code) {
  const normalized = typeof value === "string" ? value.trim() : value;
  assertNoCredentialMaterial(normalized, path);
  if (typeof normalized !== "string" || !LABEL_PATTERN.test(normalized)) {
    throw connectionError(code, "label is invalid", { path });
  }
  return normalized;
}

function normalizePositiveRevision(value, path, code) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw connectionError(code, "revision must be a positive integer", {
      path,
    });
  }
  return value;
}

function normalizeTimestamp(value, path) {
  if (
    typeof value !== "string" ||
    !TIMESTAMP_PATTERN.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw connectionError(
      CONNECTION_ERROR_CODES.INVALID_EVENT,
      "timestamp must be canonical UTC milliseconds",
      { path: path + ".serverTimestamp" },
    );
  }
  return value;
}

function assertAllowedKeys(value, allowed, code, path) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw connectionError(code, "unsupported field is not accepted", {
        path: path + "." + key,
      });
    }
  }
}

function requireRecord(value, code, path) {
  if (!isPlainRecord(value)) {
    throw connectionError(code, "value must be a plain object", { path });
  }
  return value;
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
