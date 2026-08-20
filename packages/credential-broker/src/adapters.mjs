import {
  CREDENTIAL_BROKER_ERROR_CODES,
  credentialBrokerError,
} from "./errors.mjs";
import { CREDENTIAL_BROKER_ADAPTER } from "./internal.mjs";
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
  return Object.freeze(adapter);
}

export function createInfisicalAgentProxyAdapter({
  endpoint,
  attestation,
  authToken,
  fetchFn,
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
  const normalizedAttestation = normalizeProviderHandshake({
    ...parseAttestation(attestation),
    endpointDigest: sha256(normalizedEndpoint),
  });
  if (
    normalizedAttestation.providerId !==
    CREDENTIAL_BROKER_PROVIDER_IDS.AGENT_PROXY
  ) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_UNSUPPORTED,
      "Only the Infisical Agent Proxy provider is accepted in production",
    );
  }
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
  return Object.freeze(adapter);
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
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.startsWith("10.") ||
    normalized.startsWith("192.168.") ||
    normalized.startsWith("172.16.") ||
    normalized.startsWith("172.17.") ||
    normalized.startsWith("172.18.") ||
    normalized.startsWith("172.19.") ||
    normalized.startsWith("172.2") ||
    normalized.startsWith("172.3") ||
    normalized.startsWith("169.254.")
  );
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
