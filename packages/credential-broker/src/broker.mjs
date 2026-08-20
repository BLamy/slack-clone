import {
  CREDENTIAL_BROKER_ERROR_CODES,
  CredentialBrokerError,
  credentialBrokerError,
} from "./errors.mjs";
import { CREDENTIAL_BROKER_ADAPTER } from "./internal.mjs";
import {
  CREDENTIAL_BROKER_MODES,
  CREDENTIAL_BROKER_PROVIDER_IDS,
  CREDENTIAL_BROKER_SCHEMA_VERSION,
  assertNoCredentialMaterial,
  defaultIdFactory,
  freezeDeep,
  normalizeBinding,
  normalizeDigest,
  normalizeDurationMs,
  normalizeIdentifier,
  normalizeOperation,
  normalizeProviderHandshake,
  normalizeProviderOutcome,
  normalizeSecretRef,
  sha256,
  summarizeCapability,
} from "./schema.mjs";

const OPAQUE_HANDLE_PATTERN = /^[A-Za-z0-9._:-]{16,256}$/u;

export function createCredentialBroker({
  provider,
  environment = process.env.NODE_ENV ?? "development",
  clock = () => new Date(),
  idFactory = defaultIdFactory,
} = {}) {
  if (!provider || typeof provider.handshake !== "function") {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_HANDSHAKE_REQUIRED,
      "CredentialBroker requires an adapter handshake",
    );
  }
  const adapter = provider[CREDENTIAL_BROKER_ADAPTER];
  if (
    !adapter ||
    typeof adapter.issue !== "function" ||
    typeof adapter.use !== "function"
  ) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_HANDSHAKE_REQUIRED,
      "CredentialBroker requires an internal provider capability surface",
    );
  }
  const handshake = normalizeProviderHandshake(provider.handshake());
  const normalizedEnvironment = normalizeEnvironment(environment);
  if (
    normalizedEnvironment === "production" &&
    handshake.providerId !== CREDENTIAL_BROKER_PROVIDER_IDS.AGENT_PROXY
  ) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.LOCAL_PROVIDER_IN_PRODUCTION,
      "Production CredentialBroker requires an attested Infisical Agent Proxy",
    );
  }
  if (
    handshake.providerId === CREDENTIAL_BROKER_PROVIDER_IDS.AGENT_PROXY &&
    handshake.mode !== CREDENTIAL_BROKER_MODES.PRODUCTION
  ) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_MODE_MISMATCH,
      "Infisical Agent Proxy must run in production mode",
    );
  }
  if (
    handshake.providerId === CREDENTIAL_BROKER_PROVIDER_IDS.AGENT_VAULT &&
    handshake.mode !== CREDENTIAL_BROKER_MODES.LOCAL
  ) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_MODE_MISMATCH,
      "Agent Vault must run in explicit local mode",
    );
  }

  const capabilities = new Map();
  const auditEvents = [];
  let auditSequence = 0;

  const broker = {
    providerHandshake() {
      return handshake;
    },

    async issue({ secretRef, binding, durationMs = 60_000 } = {}) {
      const normalizedSecretRef = normalizeSecretRef(secretRef);
      const normalizedBinding = normalizeBinding(binding);
      assertReferenceBinding(normalizedSecretRef, normalizedBinding);
      const issuedAt = nowIso(clock);
      const expiresAt = new Date(
        Date.parse(issuedAt) + normalizeDurationMs(durationMs),
      ).toISOString();
      const capabilityId = normalizeIdentifier(
        idFactory("capability"),
        "capabilityId",
        CREDENTIAL_BROKER_ERROR_CODES.INVALID_CAPABILITY,
      );
      const opaqueToken = normalizeOpaque(
        idFactory("capability-handle"),
        "capability handle",
      );
      let providerSession;
      try {
        providerSession = await adapter.issue({
          binding: normalizedBinding,
          secretRef: normalizedSecretRef,
          expiresAt,
        });
      } catch (error) {
        appendAudit({
          type: "credential.capability.issue.denied",
          capabilityId,
          binding: normalizedBinding,
          secretRefDigest: sha256(normalizedSecretRef),
          reasonCode: errorCode(
            error,
            CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_REQUEST_FAILED,
          ),
        });
        throw brokerError(error, "Credential capability issue was refused");
      }
      if (!providerSession || typeof providerSession !== "object") {
        throw credentialBrokerError(
          CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_RESPONSE_INVALID,
          "Provider did not return an opaque session",
        );
      }
      const providerHandle = normalizeOpaque(
        providerSession.providerHandle,
        "provider session handle",
      );
      const providerExpiresAt = normalizeExpiry(
        providerSession.expiresAt ?? expiresAt,
      );
      const providerOperationId = normalizeIdentifier(
        providerSession.providerOperationId,
        "providerOperationId",
        CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_RESPONSE_INVALID,
      );
      const record = {
        capabilityId,
        tokenDigest: sha256(opaqueToken),
        binding: normalizedBinding,
        secretRef: normalizedSecretRef,
        secretRefDigest: sha256(normalizedSecretRef),
        providerHandle,
        providerOperationId,
        issuedAt,
        expiresAt: providerExpiresAt,
        status: "active",
      };
      capabilities.set(capabilityId, record);
      const capability = freezeDeep({
        schemaVersion: CREDENTIAL_BROKER_SCHEMA_VERSION,
        type: "injection-capability",
        capabilityId,
        token: opaqueToken,
        binding: normalizedBinding,
        issuedAt,
        expiresAt: providerExpiresAt,
        providerId: handshake.providerId,
        providerMode: handshake.mode,
      });
      const auditEvent = appendAudit({
        type: "credential.capability.issued",
        capabilityId,
        binding: normalizedBinding,
        secretRefDigest: record.secretRefDigest,
        providerOperationId,
        expiresAt: providerExpiresAt,
      });
      return {
        capability,
        receipt: freezeDeep({
          capabilityId,
          auditEventId: auditEvent.eventId,
          providerId: handshake.providerId,
          providerMode: handshake.mode,
          expiresAt: providerExpiresAt,
        }),
      };
    },

    async use(
      capability,
      { binding, requestDigest, operation, request, consumer } = {},
    ) {
      const record = assertCapability(capability);
      const normalizedBinding =
        binding === undefined ? record.binding : normalizeBinding(binding);
      const normalizedRequestDigest = normalizeDigest(
        requestDigest,
        "requestDigest",
        CREDENTIAL_BROKER_ERROR_CODES.INVALID_REQUEST,
      );
      const normalizedOperation = normalizeOperation(
        operation ?? record.binding.operation,
      );
      if (sha256(normalizedBinding) !== sha256(record.binding)) {
        return denyUse(
          record,
          CREDENTIAL_BROKER_ERROR_CODES.CAPABILITY_BINDING_MISMATCH,
          "Capability binding does not match the issued run identity",
        );
      }
      if (normalizedOperation !== record.binding.operation) {
        return denyUse(
          record,
          CREDENTIAL_BROKER_ERROR_CODES.CAPABILITY_BINDING_MISMATCH,
          "Capability operation does not match the issued operation",
        );
      }
      if (normalizedRequestDigest !== record.binding.requestDigest) {
        return denyUse(
          record,
          CREDENTIAL_BROKER_ERROR_CODES.CAPABILITY_REQUEST_MISMATCH,
          "Capability request digest does not match the issued request",
        );
      }
      assertLive(record);
      if (request !== undefined)
        assertNoCredentialMaterial(request, "broker request");
      let providerResult;
      try {
        providerResult = await adapter.use({
          providerHandle: record.providerHandle,
          binding: record.binding,
          request: request ?? {},
          consumer,
        });
      } catch (error) {
        appendAudit({
          type: "credential.capability.use.denied",
          capabilityId: record.capabilityId,
          binding: record.binding,
          secretRefDigest: record.secretRefDigest,
          reasonCode: errorCode(
            error,
            CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_REQUEST_FAILED,
          ),
        });
        throw brokerError(error, "Credential capability use was refused");
      }
      const outcome = normalizeProviderOutcome(
        providerResult?.outcome ?? providerResult,
        "provider outcome",
      );
      const providerOperationId = normalizeIdentifier(
        providerResult?.providerOperationId,
        "providerOperationId",
        CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_RESPONSE_INVALID,
      );
      const auditEvent = appendAudit({
        type: "credential.capability.used",
        capabilityId: record.capabilityId,
        binding: record.binding,
        secretRefDigest: record.secretRefDigest,
        providerOperationId,
        outcome,
      });
      return freezeDeep({
        schemaVersion: CREDENTIAL_BROKER_SCHEMA_VERSION,
        capabilityId: record.capabilityId,
        providerId: handshake.providerId,
        providerMode: handshake.mode,
        operation: record.binding.operation,
        requestDigest: record.binding.requestDigest,
        outcome,
        auditEventId: auditEvent.eventId,
      });
    },

    async revoke(capability, { reason = "run-finished" } = {}) {
      const record = assertCapability(capability);
      const normalizedReason = normalizeReason(reason);
      if (record.status === "revoked") {
        return freezeDeep({
          capabilityId: record.capabilityId,
          revoked: true,
          idempotent: true,
          providerId: handshake.providerId,
        });
      }
      assertLive(record);
      let providerResult;
      try {
        providerResult = await adapter.revoke({
          providerHandle: record.providerHandle,
          binding: record.binding,
        });
      } catch (error) {
        appendAudit({
          type: "credential.capability.revoke.denied",
          capabilityId: record.capabilityId,
          binding: record.binding,
          secretRefDigest: record.secretRefDigest,
          reasonCode: errorCode(
            error,
            CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_REQUEST_FAILED,
          ),
        });
        throw brokerError(error, "Credential capability revoke was refused");
      }
      if (providerResult?.revoked !== true) {
        throw credentialBrokerError(
          CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_RESPONSE_INVALID,
          "Provider did not confirm capability revocation",
        );
      }
      const providerOperationId = normalizeIdentifier(
        providerResult.providerOperationId,
        "providerOperationId",
        CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_RESPONSE_INVALID,
      );
      record.status = "revoked";
      const auditEvent = appendAudit({
        type: "credential.capability.revoked",
        capabilityId: record.capabilityId,
        binding: record.binding,
        secretRefDigest: record.secretRefDigest,
        providerOperationId,
        reason: normalizedReason,
      });
      return freezeDeep({
        capabilityId: record.capabilityId,
        revoked: true,
        idempotent: false,
        auditEventId: auditEvent.eventId,
        providerId: handshake.providerId,
      });
    },

    auditEvents() {
      return freezeDeep(auditEvents.map((event) => structuredClone(event)));
    },

    snapshot() {
      const snapshot = {
        schemaVersion: CREDENTIAL_BROKER_SCHEMA_VERSION,
        provider: handshake,
        capabilities: [...capabilities.values()]
          .sort((left, right) =>
            left.capabilityId.localeCompare(right.capabilityId),
          )
          .map((record) => ({
            capabilityId: record.capabilityId,
            binding: record.binding,
            secretRefDigest: record.secretRefDigest,
            issuedAt: record.issuedAt,
            expiresAt: record.expiresAt,
            status: record.status,
          })),
        auditEvents: broker.auditEvents(),
      };
      assertNoCredentialMaterial(snapshot, "broker snapshot");
      return freezeDeep(snapshot);
    },

    stateDigest() {
      return sha256(broker.snapshot());
    },

    auditDigest() {
      return sha256(broker.auditEvents());
    },

    summarizeCapability,
  };

  return Object.freeze(broker);

  function assertCapability(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw credentialBrokerError(
        CREDENTIAL_BROKER_ERROR_CODES.INVALID_CAPABILITY,
        "Credential capability must be an object",
      );
    }
    const capabilityId = normalizeIdentifier(
      input.capabilityId,
      "capabilityId",
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_CAPABILITY,
    );
    const record = capabilities.get(capabilityId);
    if (!record) {
      throw credentialBrokerError(
        CREDENTIAL_BROKER_ERROR_CODES.CAPABILITY_NOT_FOUND,
        "Credential capability is not known to this broker",
      );
    }
    if (
      typeof input.token !== "string" ||
      sha256(input.token) !== record.tokenDigest ||
      input.providerId !== handshake.providerId ||
      input.providerMode !== handshake.mode ||
      input.type !== "injection-capability"
    ) {
      throw credentialBrokerError(
        CREDENTIAL_BROKER_ERROR_CODES.INVALID_CAPABILITY,
        "Credential capability handle is invalid",
      );
    }
    if (
      input.binding &&
      sha256(normalizeBinding(input.binding)) !== sha256(record.binding)
    ) {
      throw credentialBrokerError(
        CREDENTIAL_BROKER_ERROR_CODES.CAPABILITY_BINDING_MISMATCH,
        "Credential capability binding is invalid",
      );
    }
    return record;
  }

  function assertLive(record) {
    if (record.status === "revoked") {
      return denyUse(
        record,
        CREDENTIAL_BROKER_ERROR_CODES.CAPABILITY_REVOKED,
        "Credential capability has been revoked",
      );
    }
    if (Date.parse(record.expiresAt) <= Date.parse(nowIso(clock))) {
      record.status = "expired";
      return denyUse(
        record,
        CREDENTIAL_BROKER_ERROR_CODES.CAPABILITY_EXPIRED,
        "Credential capability has expired",
      );
    }
  }

  function denyUse(record, code, message) {
    appendAudit({
      type: "credential.capability.use.denied",
      capabilityId: record.capabilityId,
      binding: record.binding,
      secretRefDigest: record.secretRefDigest,
      reasonCode: code,
    });
    throw credentialBrokerError(code, message);
  }

  function appendAudit(event) {
    const auditEvent = freezeDeep({
      schemaVersion: CREDENTIAL_BROKER_SCHEMA_VERSION,
      eventId: normalizeIdentifier(
        idFactory("audit"),
        "eventId",
        CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_RESPONSE_INVALID,
      ),
      sequence: ++auditSequence,
      timestamp: nowIso(clock),
      providerId: handshake.providerId,
      providerMode: handshake.mode,
      ...event,
    });
    assertNoCredentialMaterial(auditEvent, "broker audit event");
    auditEvents.push(auditEvent);
    return auditEvent;
  }
}

function assertReferenceBinding(secretRef, binding) {
  if (
    secretRef.tenantId !== binding.tenantId ||
    secretRef.workspaceId !== binding.workspaceId
  ) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_BINDING,
      "SecretRef is outside the requested tenant and workspace binding",
    );
  }
}

function normalizeEnvironment(value) {
  const environment = String(value ?? "development")
    .trim()
    .toLowerCase();
  if (!environment) return "development";
  return environment;
}

function normalizeOpaque(value, label) {
  if (typeof value !== "string" || !OPAQUE_HANDLE_PATTERN.test(value)) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_RESPONSE_INVALID,
      `${label} must be an opaque bounded handle`,
    );
  }
  return value;
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

function normalizeReason(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9._:-]{0,63}$/u.test(value)) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_REQUEST,
      "Capability revoke reason is invalid",
    );
  }
  return value;
}

function nowIso(clock) {
  let value;
  try {
    value = clock();
  } catch {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_REQUEST,
      "Credential broker clock failed",
    );
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw credentialBrokerError(
      CREDENTIAL_BROKER_ERROR_CODES.INVALID_REQUEST,
      "Credential broker clock returned an invalid time",
    );
  }
  return date.toISOString();
}

function errorCode(error, fallback) {
  return error instanceof CredentialBrokerError && error.code
    ? error.code
    : fallback;
}

function brokerError(error, message) {
  if (error instanceof CredentialBrokerError) return error;
  return credentialBrokerError(
    CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_REQUEST_FAILED,
    message,
  );
}
