import { createHash, randomBytes } from "node:crypto";

import {
  CREDENTIAL_BROKER_ERROR_CODES,
  credentialBrokerError,
} from "./errors.mjs";

export const CREDENTIAL_BROKER_SCHEMA_VERSION = 1;
export const CREDENTIAL_BROKER_PROVIDER_IDS = Object.freeze({
  AGENT_PROXY: "infisical-agent-proxy",
  AGENT_VAULT: "infisical-agent-vault",
});
export const CREDENTIAL_BROKER_MODES = Object.freeze({
  PRODUCTION: "production",
  LOCAL: "local",
});

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CREDENTIAL_KEY_PATTERN =
  /(?:password|secret|credential|authorization|api[_-]?key|session[_-]?token|bearer)/iu;
const CREDENTIAL_VALUE_PATTERNS = [
  /-----BEGIN [^-]*PRIVATE KEY-----/iu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
  /\b(?:sk|rk|pk)-[A-Za-z0-9][A-Za-z0-9_-]{15,}\b/u,
];

export function normalizeSecretRef(input) {
  const value = requireRecord(
    input,
    CREDENTIAL_BROKER_ERROR_CODES.INVALID_SECRET_REF,
  );
  assertAllowedKeys(
    value,
    [
      "schemaVersion",
      "type",
      "provider",
      "tenantId",
      "workspaceId",
      "environment",
      "path",
      "key",
      "version",
    ],
    CREDENTIAL_BROKER_ERROR_CODES.INVALID_SECRET_REF,
  );
  if (
    value.schemaVersion !== undefined &&
    value.schemaVersion !== CREDENTIAL_BROKER_SCHEMA_VERSION
  ) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_SECRET_REF,
      "SecretRef schema version is unsupported",
    );
  }
  if (value.type !== undefined && value.type !== "secret-ref") {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_SECRET_REF,
      "SecretRef type is unsupported",
    );
  }
  if (value.provider !== undefined && value.provider !== "infisical") {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_SECRET_REF,
      "SecretRef provider is unsupported",
    );
  }
  return freezeDeep({
    schemaVersion: CREDENTIAL_BROKER_SCHEMA_VERSION,
    type: "secret-ref",
    provider: "infisical",
    tenantId: normalizeIdentifier(
      value.tenantId,
      "tenantId",
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_SECRET_REF,
    ),
    workspaceId: normalizeIdentifier(
      value.workspaceId,
      "workspaceId",
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_SECRET_REF,
    ),
    environment: normalizeIdentifier(
      value.environment,
      "environment",
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_SECRET_REF,
    ),
    path: normalizePath(value.path),
    key: normalizeIdentifier(
      value.key,
      "key",
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_SECRET_REF,
    ),
    version:
      value.version === undefined || value.version === null
        ? "latest"
        : normalizeIdentifier(
            value.version,
            "version",
            CREDENTIAL_BROKER_ERROR_CODES.INVALID_SECRET_REF,
          ),
  });
}

export function normalizeBinding(input) {
  const value = requireRecord(
    input,
    CREDENTIAL_BROKER_ERROR_CODES.INVALID_BINDING,
  );
  assertAllowedKeys(
    value,
    [
      "schemaVersion",
      "tenantId",
      "workspaceId",
      "agentId",
      "runId",
      "connectionId",
      "operation",
      "requestDigest",
    ],
    CREDENTIAL_BROKER_ERROR_CODES.INVALID_BINDING,
  );
  if (
    value.schemaVersion !== undefined &&
    value.schemaVersion !== CREDENTIAL_BROKER_SCHEMA_VERSION
  ) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_BINDING,
      "Capability binding schema version is unsupported",
    );
  }
  return freezeDeep({
    schemaVersion: CREDENTIAL_BROKER_SCHEMA_VERSION,
    tenantId: normalizeIdentifier(
      value.tenantId,
      "tenantId",
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_BINDING,
    ),
    workspaceId: normalizeIdentifier(
      value.workspaceId,
      "workspaceId",
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_BINDING,
    ),
    agentId: normalizeIdentifier(
      value.agentId,
      "agentId",
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_BINDING,
    ),
    runId: normalizeIdentifier(
      value.runId,
      "runId",
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_BINDING,
    ),
    connectionId: normalizeIdentifier(
      value.connectionId,
      "connectionId",
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_BINDING,
    ),
    operation: normalizeOperation(value.operation),
    requestDigest: normalizeDigest(
      value.requestDigest,
      "requestDigest",
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_BINDING,
    ),
  });
}

export function normalizeOperation(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9._:-]{0,127}$/u.test(value)) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_BINDING,
      "Operation must be a lowercase scoped identifier",
    );
  }
  return value;
}

export function normalizeDigest(value, field = "digest", code = undefined) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw credentialBrokerError(
      code ?? CREDENTIAL_BROKER_ERROR_CODES.INVALID_REQUEST,
      `${field} must be a sha256 digest`,
    );
  }
  return value;
}

export function normalizeIdentifier(value, field, code) {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw credentialBrokerError(code, `${field} must be a bounded identifier`);
  }
  return value;
}

export function normalizePath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_SECRET_REF,
      "SecretRef path must be a bounded path",
    );
  }
  const path = value.replace(/^\/+|\/+$/gu, "");
  if (!path || path.includes("..") || path.includes("\\")) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_SECRET_REF,
      "SecretRef path must not escape its namespace",
    );
  }
  return path;
}

export function normalizeDurationMs(value = 60_000) {
  if (!Number.isInteger(value) || value < 1_000 || value > 3_600_000) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_REQUEST,
      "Capability duration must be between one second and one hour",
    );
  }
  return value;
}

export function normalizeProviderHandshake(input) {
  const value = requireRecord(
    input,
    CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_HANDSHAKE_REQUIRED,
  );
  assertAllowedKeys(
    value,
    [
      "schemaVersion",
      "providerId",
      "mode",
      "protocolVersion",
      "attested",
      "nonProduction",
      "attestationId",
      "keyId",
      "signature",
      "endpointDigest",
      "providerMarker",
    ],
    CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_ATTESTATION_INVALID,
  );
  if (value.schemaVersion !== CREDENTIAL_BROKER_SCHEMA_VERSION) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_ATTESTATION_INVALID,
      "Provider handshake schema version is unsupported",
    );
  }
  const providerId = value.providerId;
  if (
    providerId !== CREDENTIAL_BROKER_PROVIDER_IDS.AGENT_PROXY &&
    providerId !== CREDENTIAL_BROKER_PROVIDER_IDS.AGENT_VAULT
  ) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_UNSUPPORTED,
      "Provider is not an Infisical Agent Proxy or Agent Vault adapter",
    );
  }
  if (
    typeof value.mode !== "string" ||
    !Object.values(CREDENTIAL_BROKER_MODES).includes(value.mode)
  ) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_MODE_MISMATCH,
      "Provider mode is unsupported",
    );
  }
  if (
    typeof value.protocolVersion !== "string" ||
    value.protocolVersion.length < 1
  ) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_ATTESTATION_INVALID,
      "Provider protocol version is required",
    );
  }
  if (
    typeof value.attested !== "boolean" ||
    typeof value.nonProduction !== "boolean"
  ) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_ATTESTATION_INVALID,
      "Provider attestation flags are required",
    );
  }
  if (providerId === CREDENTIAL_BROKER_PROVIDER_IDS.AGENT_PROXY) {
    if (value.mode !== CREDENTIAL_BROKER_MODES.PRODUCTION || !value.attested) {
      throw credentialBrokerError(
        CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_ATTESTATION_INVALID,
        "Production Agent Proxy requires an attested production handshake",
      );
    }
    if (value.nonProduction) {
      throw credentialBrokerError(
        CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_ATTESTATION_INVALID,
        "Production Agent Proxy cannot be marked non-production",
      );
    }
    normalizeIdentifier(
      value.attestationId,
      "attestationId",
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_ATTESTATION_INVALID,
    );
    normalizeDigest(
      value.endpointDigest,
      "endpointDigest",
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_ATTESTATION_INVALID,
    );
    normalizeIdentifier(
      value.keyId,
      "keyId",
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_ATTESTATION_INVALID,
    );
    if (
      typeof value.signature !== "string" ||
      value.signature.length < 32 ||
      value.signature.length > 8_192 ||
      !/^[A-Za-z0-9+/=_-]+$/u.test(value.signature)
    ) {
      throw credentialBrokerError(
        CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_ATTESTATION_INVALID,
        "Production Agent Proxy attestation signature is invalid",
      );
    }
  } else {
    if (value.mode !== CREDENTIAL_BROKER_MODES.LOCAL || !value.nonProduction) {
      throw credentialBrokerError(
        CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_MODE_MISMATCH,
        "Agent Vault must be explicitly marked local and non-production",
      );
    }
    if (value.attested) {
      throw credentialBrokerError(
        CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_ATTESTATION_INVALID,
        "Agent Vault cannot satisfy the production attestation",
      );
    }
    normalizeIdentifier(
      value.providerMarker,
      "providerMarker",
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_ATTESTATION_INVALID,
    );
  }
  return freezeDeep({ ...value });
}

export function canonicalize(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Canonical values require finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  throw new TypeError("Canonical values must be JSON-compatible records");
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  const input = typeof value === "string" ? value : canonicalJson(value);
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

export function defaultIdFactory(kind) {
  return `${kind}_${randomBytes(24).toString("base64url")}`;
}

export function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export function summarizeCapability(capability) {
  if (!isPlainRecord(capability)) return null;
  return {
    schemaVersion: capability.schemaVersion,
    type: capability.type,
    capabilityId: capability.capabilityId,
    binding: capability.binding,
    issuedAt: capability.issuedAt,
    expiresAt: capability.expiresAt,
    providerId: capability.providerId,
    providerMode: capability.providerMode,
  };
}

export function assertNoCredentialMaterial(value, context = "value") {
  const seen = new Set();
  walkForCredentialMaterial(value, context, seen);
}

export function normalizeProviderOutcome(value, context = "provider outcome") {
  if (!isPlainRecord(value)) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_RESPONSE_INVALID,
      `${context} must be a result record`,
    );
  }
  assertAllowedKeys(
    value,
    ["accepted", "status", "responseDigest", "requestId", "operationId"],
    CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_RESPONSE_INVALID,
  );
  assertNoCredentialMaterial(value, context);
  const output = { accepted: value.accepted === true };
  if (value.status !== undefined) {
    if (
      !Number.isInteger(value.status) ||
      value.status < 100 ||
      value.status > 599
    ) {
      throw credentialBrokerError(
        CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_RESPONSE_INVALID,
        `${context} status is invalid`,
      );
    }
    output.status = value.status;
  }
  for (const field of ["responseDigest", "requestId", "operationId"]) {
    if (value[field] !== undefined) {
      output[field] =
        field === "responseDigest" || field === "requestId"
          ? normalizeDigest(
              value[field],
              field,
              CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_RESPONSE_INVALID,
            )
          : normalizeIdentifier(
              value[field],
              field,
              CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_RESPONSE_INVALID,
            );
    }
  }
  return freezeDeep(output);
}

export function normalizeConsumerOutcome(value) {
  if (value === undefined) return freezeDeep({ accepted: true });
  if (typeof value === "boolean") return freezeDeep({ accepted: value });
  return normalizeProviderOutcome(value, "consumer outcome");
}

function requireRecord(value, code) {
  if (!isPlainRecord(value)) {
    throw credentialBrokerError(code, "Expected a plain object");
  }
  return value;
}

function assertAllowedKeys(value, allowed, code) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key) || CREDENTIAL_KEY_PATTERN.test(key)) {
      throw credentialBrokerError(
        code,
        `Credential-bearing or unsupported field ${key} is not accepted`,
      );
    }
  }
}

function walkForCredentialMaterial(value, context, seen) {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      throw credentialBrokerError(
        CREDENTIAL_BROKER_ERROR_CODES.CONSUMER_OUTPUT_LEAK,
        `${context} contains credential-shaped material`,
      );
    }
    return;
  }
  if (typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) walkForCredentialMaterial(child, context, seen);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_KEY_PATTERN.test(key) && !isSafeDigestKey(key)) {
      throw credentialBrokerError(
        CREDENTIAL_BROKER_ERROR_CODES.CONSUMER_OUTPUT_LEAK,
        `${context} contains a credential-bearing field`,
      );
    }
    walkForCredentialMaterial(child, `${context}.${key}`, seen);
  }
}

function isSafeDigestKey(key) {
  return /^(?:binding|body|request|response|secretRef)Digest$/u.test(key);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
