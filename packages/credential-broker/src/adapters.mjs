import { verify as verifySignature } from "node:crypto";
import { isIP } from "node:net";

import {
  CREDENTIAL_BROKER_ERROR_CODES,
  credentialBrokerError,
} from "./errors.mjs";
import {
  CREDENTIAL_BROKER_ADAPTER,
  registerTrustedAdapter,
} from "./internal.mjs";
import {
  CREDENTIAL_BROKER_MODES,
  CREDENTIAL_BROKER_PROVIDER_IDS,
  CREDENTIAL_BROKER_SCHEMA_VERSION,
  assertNoCredentialMaterial,
  canonicalJson,
  defaultIdFactory,
  freezeDeep,
  normalizeConsumerOutcome,
  normalizeDigest,
  normalizeIdentifier,
  normalizeProviderHandshake,
  normalizeProviderOutcome,
  normalizeSecretRef,
  sha256,
} from "./schema.mjs";

const SESSION_TTL_SKEW_MS = 5_000;

export function createAgentVaultAdapter({
  secrets,
  idFactory = defaultIdFactory,
  now = () => Date.now(),
} = {}) {
  const store = new Map();
  for (const entry of normalizeSecretEntries(secrets)) {
    store.set(sha256(entry.secretRef), entry.value);
  }
  const sessions = new Map();
  const handshake = normalizeProviderHandshake({
    schemaVersion: CREDENTIAL_BROKER_SCHEMA_VERSION,
    providerId: CREDENTIAL_BROKER_PROVIDER_IDS.AGENT_VAULT,
    mode: CREDENTIAL_BROKER_MODES.LOCAL,
    protocolVersion: "agent-vault-local-fixture.v1",
    attested: false,
    nonProduction: true,
    providerMarker: "local-agent-vault",
  });

  const adapter = {
    handshake() {
      return handshake;
    },
  };
  Object.defineProperty(adapter, CREDENTIAL_BROKER_ADAPTER, {
    enumerable: false,
    value: Object.freeze({
      async issue({ binding, secretRef, expiresAt }) {
        const secret = store.get(sha256(secretRef));
        if (secret === undefined) {
          throw credentialBrokerError(
            CREDENTIAL_BROKER_ERROR_CODES.SECRET_NOT_FOUND,
            "Agent Vault has no secret for the requested SecretRef",
          );
        }
        const providerHandle = idFactory("vault-session");
        sessions.set(providerHandle, {
          bindingDigest: sha256(binding),
          expiresAt,
          secret,
        });
        return {
          providerHandle,
          providerOperationId: idFactory("vault-issue"),
          expiresAt,
        };
      },
      async use({ providerHandle, binding, consumer, request }) {
        const session = sessions.get(providerHandle);
        if (!session) {
          throw credentialBrokerError(
            CREDENTIAL_BROKER_ERROR_CODES.CAPABILITY_NOT_FOUND,
            "Agent Vault session is not available",
          );
        }
        if (Date.parse(session.expiresAt) <= now() + SESSION_TTL_SKEW_MS) {
          throw credentialBrokerError(
            CREDENTIAL_BROKER_ERROR_CODES.CAPABILITY_EXPIRED,
            "Agent Vault session has expired",
          );
        }
        if (session.bindingDigest !== sha256(binding)) {
          throw credentialBrokerError(
            CREDENTIAL_BROKER_ERROR_CODES.CAPABILITY_BINDING_MISMATCH,
            "Agent Vault session binding does not match the run capability",
          );
        }
        if (typeof consumer !== "function") {
          throw credentialBrokerError(
            CREDENTIAL_BROKER_ERROR_CODES.CONSUMER_REQUIRED,
            "Local Agent Vault use requires an in-process test consumer",
          );
        }
        let outcome;
        try {
          outcome = await consumer(session.secret, {
            providerId: handshake.providerId,
            providerMode: handshake.mode,
            binding,
            request,
          });
        } catch {
          throw credentialBrokerError(
            CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_REQUEST_FAILED,
            "Agent Vault consumer failed",
          );
        }
        return {
          providerOperationId: idFactory("vault-use"),
          outcome: normalizeConsumerOutcome(outcome),
        };
      },
      async revoke({ providerHandle }) {
        sessions.delete(providerHandle);
        return {
          providerOperationId: idFactory("vault-revoke"),
          revoked: true,
        };
      },
    }),
  });
  return registerTrustedAdapter(Object.freeze(adapter));
}

export function createInfisicalAgentProxyAdapter({
  endpoint,
  attestation,
  authToken,
  fetchFn,
  attestationPublicKey,
  requestTimeoutMs = 10_000,
  protocolBasePath = "/v1/stream-slack/credential-sessions",
} = {}) {
  const normalizedEndpoint = normalizeProductionEndpoint(endpoint);
  if (typeof fetchFn !== "function") {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_REQUEST_FAILED,
      "Infisical Agent Proxy requires an injected fetch function",
    );
  }
  const normalizedAttestation = normalizeProviderHandshake(
    parseAttestation(attestation),
  );
  if (
    normalizedAttestation.providerId !==
    CREDENTIAL_BROKER_PROVIDER_IDS.AGENT_PROXY
  ) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_UNSUPPORTED,
      "Only the Infisical Agent Proxy provider is accepted in production",
    );
  }
  if (normalizedAttestation.endpointDigest !== sha256(normalizedEndpoint)) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_ATTESTATION_INVALID,
      "Infisical Agent Proxy attestation is not bound to its endpoint",
    );
  }
  verifyProviderAttestation(normalizedAttestation, attestationPublicKey);
  if (
    authToken !== undefined &&
    (typeof authToken !== "string" || authToken.length < 1)
  ) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_ATTESTATION_INVALID,
      "Infisical Agent Proxy authentication material must be non-empty when supplied",
    );
  }
  const basePath = normalizeBasePath(protocolBasePath);
  const adapter = {
    handshake() {
      return normalizedAttestation;
    },
  };
  Object.defineProperty(adapter, CREDENTIAL_BROKER_ADAPTER, {
    enumerable: false,
    value: Object.freeze({
      async issue({ binding, secretRef, expiresAt }) {
        const response = await requestJson(
          `${normalizedEndpoint}${basePath}`,
          {
            method: "POST",
            body: {
              schemaVersion: CREDENTIAL_BROKER_SCHEMA_VERSION,
              binding,
              secretRef,
              expiresAt,
            },
          },
          { fetchFn, authToken, requestTimeoutMs },
        );
        const sessionId = normalizeIdentifier(
          response.sessionId,
          "sessionId",
          CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_RESPONSE_INVALID,
        );
        return {
          providerHandle: sessionId,
          providerOperationId: normalizeIdentifier(
            response.operationId,
            "operationId",
            CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_RESPONSE_INVALID,
          ),
          expiresAt: normalizeExpiry(response.expiresAt ?? expiresAt),
        };
      },
      async use({ providerHandle, binding, request }) {
        const response = await requestJson(
          `${normalizedEndpoint}${basePath}/${encodeURIComponent(providerHandle)}/requests`,
          {
            method: "POST",
            body: {
              schemaVersion: CREDENTIAL_BROKER_SCHEMA_VERSION,
              binding,
              request: normalizeProxyRequest(request),
            },
          },
          { fetchFn, authToken, requestTimeoutMs },
        );
        return {
          providerOperationId: normalizeIdentifier(
            response.operationId,
            "operationId",
            CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_RESPONSE_INVALID,
          ),
          outcome: normalizeProviderOutcome(response),
        };
      },
      async revoke({ providerHandle }) {
        const response = await requestJson(
          `${normalizedEndpoint}${basePath}/${encodeURIComponent(providerHandle)}`,
          { method: "DELETE" },
          { fetchFn, authToken, requestTimeoutMs },
        );
        return {
          providerOperationId: normalizeIdentifier(
            response.operationId,
            "operationId",
            CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_RESPONSE_INVALID,
          ),
          revoked: response.revoked === true,
        };
      },
    }),
  });
  return registerTrustedAdapter(Object.freeze(adapter));
}

function normalizeSecretEntries(secrets) {
  if (!Array.isArray(secrets) || secrets.length < 1) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.SECRET_NOT_FOUND,
      "Local Agent Vault requires at least one explicit SecretRef fixture",
    );
  }
  return secrets.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw credentialBrokerError(
        CREDENTIAL_BROKER_ERROR_CODES.INVALID_SECRET_REF,
        "Agent Vault secret fixtures must be records",
      );
    }
    const secretRef = normalizeSecretRef(entry.secretRef);
    if (
      typeof entry.value !== "string" ||
      entry.value.length < 1 ||
      entry.value.length > 65_536
    ) {
      throw credentialBrokerError(
        CREDENTIAL_BROKER_ERROR_CODES.SECRET_NOT_FOUND,
        "Agent Vault secret fixture value is invalid",
      );
    }
    return { secretRef, value: entry.value };
  });
}

function normalizeProductionEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length < 1) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_ATTESTATION_INVALID,
      "Infisical Agent Proxy endpoint is required",
    );
  }
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_ATTESTATION_INVALID,
      "Infisical Agent Proxy endpoint is not a URL",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    isDisallowedProductionHost(url.hostname)
  ) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_ATTESTATION_INVALID,
      "Infisical Agent Proxy endpoint must be credential-free public HTTPS",
    );
  }
  return url.toString().replace(/\/$/u, "");
}

function isDisallowedProductionHost(hostname) {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return true;
  }
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return isDisallowedIpv4(normalized);
  if (ipVersion === 6) return isDisallowedIpv6(normalized);
  return false;
}

function isDisallowedIpv4(value) {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    return true;
  }
  const [first, second, third] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && second === 51) ||
    (first === 198 && second >= 18 && second <= 19) ||
    (first === 203 && second === 0) ||
    first >= 224
  );
}

function isDisallowedIpv6(value) {
  const bytes = parseIpv6(value);
  if (!bytes) return true;
  const first = bytes[0];
  const isUnspecified = bytes.every((byte) => byte === 0);
  const isLoopback =
    bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  const isUniqueLocal = first === 0xfc || first === 0xfd;
  const isLinkLocal = first === 0xfe && (bytes[1] & 0xc0) === 0x80;
  const isMulticast = first === 0xff;
  const isIpv4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  const isIpv4Compatible =
    bytes.slice(0, 12).every((byte) => byte === 0) && !isIpv4Mapped;
  const isNat64 =
    bytes[0] === 0 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0);
  const hasEmbeddedIpv4 = isIpv4Mapped || isIpv4Compatible || isNat64;
  return (
    isUnspecified ||
    isLoopback ||
    isUniqueLocal ||
    isLinkLocal ||
    isMulticast ||
    hasEmbeddedIpv4
  );
}

function parseIpv6(value) {
  let normalized = value.toLowerCase();
  if (normalized.includes(".")) {
    const separator = normalized.lastIndexOf(":");
    const ipv4 = normalized.slice(separator + 1);
    const octets = ipv4.split(".").map(Number);
    if (
      separator < 0 ||
      octets.length !== 4 ||
      octets.some(
        (octet) => !Number.isInteger(octet) || octet < 0 || octet > 255,
      )
    ) {
      return null;
    }
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${normalized.slice(0, separator)}:${high}:${low}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const zeroCount = 8 - left.length - right.length;
  if (halves.length === 2 && zeroCount < 1) return null;
  const groups = [
    ...left,
    ...(halves.length === 2
      ? Array.from({ length: zeroCount }, () => "0")
      : []),
    ...right,
  ];
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/u.test(group)) return null;
    const number = Number.parseInt(group, 16);
    bytes.push(number >> 8, number & 0xff);
  }
  return bytes;
}

function verifyProviderAttestation(attestation, publicKey) {
  if (typeof publicKey !== "string" || publicKey.length < 1) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_ATTESTATION_INVALID,
      "Infisical Agent Proxy requires an out-of-band attestation public key",
    );
  }
  const { signature, ...unsignedAttestation } = attestation;
  let verified = false;
  try {
    verified = verifySignature(
      "sha256",
      Buffer.from(canonicalJson(unsignedAttestation)),
      publicKey,
      Buffer.from(signature, "base64"),
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_ATTESTATION_INVALID,
      "Infisical Agent Proxy attestation signature is invalid",
    );
  }
}

function parseAttestation(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      throw credentialBrokerError(
        CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_ATTESTATION_INVALID,
        "Infisical Agent Proxy attestation is not valid JSON",
      );
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_ATTESTATION_INVALID,
      "Infisical Agent Proxy attestation is required",
    );
  }
  return value;
}

function normalizeBasePath(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.includes("?")
  ) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_ATTESTATION_INVALID,
      "Agent Proxy protocol base path is invalid",
    );
  }
  return value.replace(/\/+$/u, "");
}

function normalizeProxyRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_REQUEST,
      "Brokered provider request must be a record",
    );
  }
  const allowed = new Set(["method", "url", "headers", "bodyDigest"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw credentialBrokerError(
        CREDENTIAL_BROKER_ERROR_CODES.INVALID_REQUEST,
        `Provider request field ${key} is not accepted`,
      );
    }
  }
  let url;
  try {
    url = new URL(value.url);
  } catch {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_REQUEST,
      "Provider request URL is invalid",
    );
  }
  if (url.username || url.password) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_REQUEST,
      "Provider request URL cannot contain credentials",
    );
  }
  const method = String(value.method ?? "GET").toUpperCase();
  if (!/^(?:GET|POST|PUT|PATCH|DELETE|HEAD)$/u.test(method)) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_REQUEST,
      "Provider request method is unsupported",
    );
  }
  const output = { method, url: url.toString() };
  if (value.headers !== undefined) {
    if (
      !value.headers ||
      typeof value.headers !== "object" ||
      Array.isArray(value.headers)
    ) {
      throw credentialBrokerError(
        CREDENTIAL_BROKER_ERROR_CODES.INVALID_REQUEST,
        "Provider request headers must be a record",
      );
    }
    output.headers = {};
    for (const [key, headerValue] of Object.entries(value.headers)) {
      if (
        /(?:authorization|cookie|token|secret|credential|api[_-]?key|password)/iu.test(
          key,
        ) ||
        typeof headerValue !== "string" ||
        headerValue.length > 2_000
      ) {
        throw credentialBrokerError(
          CREDENTIAL_BROKER_ERROR_CODES.INVALID_REQUEST,
          "Provider request contains a forbidden header",
        );
      }
      output.headers[key] = headerValue;
    }
  }
  if (value.bodyDigest !== undefined) {
    output.bodyDigest = normalizeDigest(
      value.bodyDigest,
      "bodyDigest",
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_REQUEST,
    );
  }
  assertNoCredentialMaterial(output, "provider request");
  return freezeDeep(output);
}

function normalizeExpiry(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_RESPONSE_INVALID,
      "Provider session expiry is invalid",
    );
  }
  return new Date(value).toISOString();
}

async function requestJson(url, { method, body } = {}, options) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.requestTimeoutMs,
  );
  try {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (options.authToken !== undefined) {
      headers.Authorization = `Bearer ${options.authToken}`;
    }
    const response = await options.fetchFn(url, {
      method,
      headers,
      body: body === undefined ? undefined : canonicalJson(body),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response || !response.ok) {
      throw credentialBrokerError(
        CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_REQUEST_FAILED,
        "Infisical Agent Proxy request failed",
      );
    }
    let parsed;
    try {
      parsed = await response.json();
    } catch {
      throw credentialBrokerError(
        CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_RESPONSE_INVALID,
        "Infisical Agent Proxy response is not JSON",
      );
    }
    assertNoCredentialMaterial(parsed, "Infisical Agent Proxy response");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw credentialBrokerError(
        CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_RESPONSE_INVALID,
        "Infisical Agent Proxy response must be an object",
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.name === "CredentialBrokerError")
      throw error;
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_REQUEST_FAILED,
      "Infisical Agent Proxy request failed",
    );
  } finally {
    clearTimeout(timeout);
  }
}
