import { sha256Digest } from "./sha256.mjs";

export const PROVIDER_REGISTRY_SCHEMA_VERSION = 1;
export const PROVIDER_DESCRIPTOR_SCHEMA_VERSION = 1;
export const PROVIDER_ADAPTER_INTERFACE_VERSION = 1;

export const PROVIDER_KINDS = Object.freeze(["harness", "sandbox"]);
export const PROVIDER_IMPLEMENTATION_STATES = Object.freeze([
  "implemented",
  "unimplemented",
]);
export const PROVIDER_HEALTH_STATES = Object.freeze([
  "healthy",
  "unhealthy",
  "unknown",
]);
export const PROVIDER_REGISTRY_ERROR_CODES = Object.freeze({
  ADAPTER_CONTRACT: "PROVIDER_REGISTRY_ADAPTER_CONTRACT",
  DUPLICATE_CAPABILITY: "PROVIDER_REGISTRY_DUPLICATE_CAPABILITY",
  DUPLICATE_COMPATIBILITY: "PROVIDER_REGISTRY_DUPLICATE_COMPATIBILITY",
  DUPLICATE_PROVIDER: "PROVIDER_REGISTRY_DUPLICATE_PROVIDER",
  INCOMPATIBLE_PROVIDERS: "PROVIDER_REGISTRY_INCOMPATIBLE_PROVIDERS",
  INVALID_CONFIGURATION: "PROVIDER_REGISTRY_INVALID_CONFIGURATION",
  INVALID_DESCRIPTOR: "PROVIDER_REGISTRY_INVALID_DESCRIPTOR",
  INVALID_REGISTRY: "PROVIDER_REGISTRY_INVALID_REGISTRY",
  MISSING_CONFIGURATION: "PROVIDER_REGISTRY_MISSING_CONFIGURATION",
  MISSING_SELECTION: "PROVIDER_REGISTRY_MISSING_SELECTION",
  PROVIDER_DISABLED: "PROVIDER_REGISTRY_PROVIDER_DISABLED",
  PROVIDER_NOT_INSTALLED: "PROVIDER_REGISTRY_PROVIDER_NOT_INSTALLED",
  PROVIDER_NOT_IMPLEMENTED: "PROVIDER_REGISTRY_PROVIDER_NOT_IMPLEMENTED",
  PROVIDER_STALE: "PROVIDER_REGISTRY_PROVIDER_STALE",
  PROVIDER_UNHEALTHY: "PROVIDER_REGISTRY_PROVIDER_UNHEALTHY",
  UNKNOWN_PROVIDER: "PROVIDER_REGISTRY_UNKNOWN_PROVIDER",
  UNSUPPORTED_CAPABILITY: "PROVIDER_REGISTRY_UNSUPPORTED_CAPABILITY",
  UNSUPPORTED_PROVIDER_VERSION:
    "PROVIDER_REGISTRY_UNSUPPORTED_PROVIDER_VERSION",
});

const DESCRIPTOR_KEYS = [
  "capabilities",
  "compatibleWith",
  "configSchema",
  "descriptorSchemaVersion",
  "displayName",
  "enabled",
  "expiresAt",
  "health",
  "implementationStatus",
  "installed",
  "kind",
  "limits",
  "observedAt",
  "providerId",
  "providerVersion",
];
const LIMIT_KEYS = [
  "maxConcurrentRuns",
  "maxInputBytes",
  "maxOutputBytes",
  "maxWallClockSeconds",
];
const CONFIG_SCHEMA_KEYS = [
  "additionalProperties",
  "properties",
  "required",
  "schemaId",
  "schemaVersion",
  "type",
];
const CONFIG_PROPERTY_ALLOWED_KEYS = [
  "enum",
  "maximum",
  "minimum",
  "pattern",
  "type",
];
const COMPATIBILITY_KEYS = ["kind", "providerId", "providerVersion"];
const SELECTION_KEYS = [
  "lifecycle",
  "networkPolicy",
  "providerId",
  "providerVersion",
  "requiredCapabilities",
];
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/u;
const PROVIDER_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const SCHEMA_ID_PATTERN = /^urn:stream-slack:provider:[a-z0-9-]+:v[0-9]+$/u;
const SECRET_VALUE_PATTERNS = Object.freeze([
  /-----BEGIN [^-]*PRIVATE KEY-----/iu,
  /\b(?:sk|rk|pk)-[A-Za-z0-9][A-Za-z0-9_-]{15,}\b/u,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bAIza[0-9A-Za-z_-]{20,}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/iu,
  /\b(?:access[_-]?token|api[_-]?key|client[_-]?secret|password|secret|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/iu,
]);
const FORBIDDEN_CONFIGURATION_KEYS = new Set([
  "apiKey",
  "apiKeyRef",
  "credentials",
  "env",
  "environment",
  "password",
  "secret",
  "secrets",
  "token",
  "tokens",
]);

export class ProviderRegistryError extends Error {
  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      name: this.name,
      path: this.path,
      providerKey: this.providerKey ?? null,
    };
  }
}

export function providerKey({ kind, providerId, providerVersion }) {
  assertProviderCoordinates(kind, providerId, providerVersion, "$.provider");
  return makeProviderKey(kind, providerId, providerVersion);
}

export function validateProviderDescriptor(
  value,
  path = "$.providerDescriptor",
) {
  assertExactObject(value, DESCRIPTOR_KEYS, path, "descriptor");
  assertSafeInteger(
    value.descriptorSchemaVersion,
    `${path}.descriptorSchemaVersion`,
    1,
  );
  if (value.descriptorSchemaVersion !== PROVIDER_DESCRIPTOR_SCHEMA_VERSION) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
      `${path}.descriptorSchemaVersion`,
      `descriptor schema version must be ${PROVIDER_DESCRIPTOR_SCHEMA_VERSION}`,
    );
  }
  assertEnum(value.kind, PROVIDER_KINDS, `${path}.kind`);
  assertProviderCoordinates(
    value.kind,
    value.providerId,
    value.providerVersion,
    path,
  );
  assertString(value.displayName, `${path}.displayName`, 1, 160);
  assertBoolean(value.installed, `${path}.installed`);
  assertBoolean(value.enabled, `${path}.enabled`);
  assertEnum(value.health, PROVIDER_HEALTH_STATES, `${path}.health`);
  assertEnum(
    value.implementationStatus,
    PROVIDER_IMPLEMENTATION_STATES,
    `${path}.implementationStatus`,
  );
  assertSafeInteger(value.observedAt, `${path}.observedAt`, 0);
  assertSafeInteger(value.expiresAt, `${path}.expiresAt`, 0);
  if (value.expiresAt <= value.observedAt) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
      `${path}.expiresAt`,
      "descriptor freshness expiry must be after its observation time",
    );
  }
  validateCapabilities(value.capabilities, `${path}.capabilities`);
  validateLimits(value.limits, `${path}.limits`);
  validateConfigurationSchema(value.configSchema, `${path}.configSchema`);
  validateCompatibilityList(value.compatibleWith, `${path}.compatibleWith`, {
    kind: value.kind,
  });
  return value;
}

export function normalizeProviderDescriptor(value) {
  validateProviderDescriptor(value);
  return freezeDeep({
    descriptorSchemaVersion: value.descriptorSchemaVersion,
    kind: value.kind,
    providerId: value.providerId,
    providerVersion: value.providerVersion,
    displayName: value.displayName,
    installed: value.installed,
    enabled: value.enabled,
    health: value.health,
    implementationStatus: value.implementationStatus,
    observedAt: value.observedAt,
    expiresAt: value.expiresAt,
    capabilities: [...value.capabilities].sort(compareCodeUnits),
    limits: { ...value.limits },
    configSchema: normalizeConfigurationSchema(value.configSchema),
    compatibleWith: value.compatibleWith
      .map((entry) => ({ ...entry }))
      .sort(compareCompatibility),
  });
}

export function canonicalProviderDescriptor(value) {
  return canonicalProviderValue(normalizeProviderDescriptor(value));
}

export function providerDescriptorDigest(value) {
  return digestCanonical(canonicalProviderDescriptor(value));
}

export function canonicalProviderConfiguration(value) {
  assertPlainObject(value, "$.providerConfiguration");
  assertSafeConfigurationValue(value, "$.providerConfiguration");
  return canonicalProviderValue(value);
}

export function providerConfigurationDigest(value) {
  return digestCanonical(canonicalProviderConfiguration(value));
}

export function createProviderRegistry({
  descriptors = BUILTIN_PROVIDER_DESCRIPTORS,
  now = 0,
} = {}) {
  assertSafeInteger(now, "$.registry.now", 0);
  if (!Array.isArray(descriptors)) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.INVALID_REGISTRY,
      "$.registry.descriptors",
      "registry descriptors must be an array",
    );
  }

  const normalizedDescriptors = descriptors.map((descriptor, index) =>
    normalizeProviderDescriptorAtPath(
      descriptor,
      `$.registry.descriptors[${index}]`,
    ),
  );
  const byKey = new Map();
  for (const descriptor of normalizedDescriptors) {
    const key = makeProviderKey(
      descriptor.kind,
      descriptor.providerId,
      descriptor.providerVersion,
    );
    if (byKey.has(key)) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.DUPLICATE_PROVIDER,
        "$.registry.descriptors",
        `provider descriptor ${key} is registered more than once`,
        key,
      );
    }
    byKey.set(key, descriptor);
  }
  validateCompatibilityGraph(normalizedDescriptors, byKey);

  const orderedDescriptors = Object.freeze(
    [...normalizedDescriptors].sort(compareDescriptors),
  );

  const registry = {
    schemaVersion: PROVIDER_REGISTRY_SCHEMA_VERSION,
    now,
    list({ kind } = {}) {
      if (kind !== undefined) assertEnum(kind, PROVIDER_KINDS, "$.kind");
      return orderedDescriptors.filter(
        (descriptor) => kind === undefined || descriptor.kind === kind,
      );
    },
    manifest() {
      return freezeDeep({
        schemaVersion: PROVIDER_REGISTRY_SCHEMA_VERSION,
        now,
        providers: orderedDescriptors.map((descriptor) => ({
          ...descriptor,
          status: providerStatus(descriptor, now),
        })),
      });
    },
    manifestDigest() {
      return digestCanonical(canonicalProviderValue(registry.manifest()));
    },
    status(selection) {
      const descriptor = findDescriptor(selection, byKey, orderedDescriptors);
      return providerStatus(descriptor, now);
    },
    describe(selection) {
      return findDescriptor(selection, byKey, orderedDescriptors);
    },
    resolve({ kind, selection, providerConfiguration }) {
      const descriptor = findDescriptor(
        { kind, ...selection },
        byKey,
        orderedDescriptors,
      );
      assertRunnable(descriptor, now);
      assertSelectionCapabilities(selection, descriptor);
      const normalizedConfiguration = validateProviderConfiguration(
        descriptor,
        providerConfiguration,
      );
      const resolved = {
        kind: descriptor.kind,
        providerId: descriptor.providerId,
        providerVersion: descriptor.providerVersion,
        providerKey: makeProviderKey(
          descriptor.kind,
          descriptor.providerId,
          descriptor.providerVersion,
        ),
        descriptorSchemaVersion: descriptor.descriptorSchemaVersion,
        descriptorDigest: providerDescriptorDigest(descriptor),
        configSchema: descriptor.configSchema,
        configSchemaDigest: digestCanonical(
          canonicalProviderValue(descriptor.configSchema),
        ),
        providerConfiguration: normalizedConfiguration,
        providerConfigurationDigest: providerConfigurationDigest(
          normalizedConfiguration,
        ),
        requiredCapabilities: [...selection.requiredCapabilities].sort(
          compareCodeUnits,
        ),
        capabilities: descriptor.capabilities,
        limits: descriptor.limits,
        lifecycle: selection.lifecycle ?? null,
        networkPolicy: selection.networkPolicy ?? null,
      };
      return freezeDeep(resolved);
    },
    resolveConfiguration({ config, providerConfigurations }) {
      assertPlainObject(config, "$.config");
      requireProperty(config, "harness", "$.config");
      requireProperty(config, "sandbox", "$.config");
      assertExactObject(
        providerConfigurations,
        ["harness", "sandbox"],
        "$.providerConfigurations",
        "configuration",
      );
      const harness = registry.resolve({
        kind: "harness",
        selection: config.harness,
        providerConfiguration: providerConfigurations.harness,
      });
      const sandbox = registry.resolve({
        kind: "sandbox",
        selection: config.sandbox,
        providerConfiguration: providerConfigurations.sandbox,
      });
      assertCompatible(harness, sandbox, byKey);
      const resolved = {
        schemaVersion: PROVIDER_REGISTRY_SCHEMA_VERSION,
        harness,
        sandbox,
        compatibility: {
          harnessProviderKey: harness.providerKey,
          sandboxProviderKey: sandbox.providerKey,
          status: "compatible",
        },
      };
      return freezeDeep({
        ...resolved,
        resolvedProviderDigest: digestCanonical(
          canonicalProviderValue(resolved),
        ),
      });
    },
    register(descriptor) {
      const normalized = normalizeProviderDescriptor(descriptor);
      const key = makeProviderKey(
        normalized.kind,
        normalized.providerId,
        normalized.providerVersion,
      );
      if (byKey.has(key)) {
        throw registryError(
          PROVIDER_REGISTRY_ERROR_CODES.DUPLICATE_PROVIDER,
          "$.providerDescriptor",
          `provider descriptor ${key} is already registered`,
          key,
        );
      }
      return createProviderRegistry({
        descriptors: [...orderedDescriptors, normalized],
        now,
      });
    },
    updateStatus({ selection, ...status }) {
      const descriptor = findDescriptor(selection, byKey, orderedDescriptors);
      const allowedKeys = [
        "enabled",
        "expiresAt",
        "health",
        "installed",
        "observedAt",
      ];
      assertSubsetKeys(status, allowedKeys, "$.status");
      return createProviderRegistry({
        descriptors: orderedDescriptors.map((candidate) =>
          candidate === descriptor ? { ...candidate, ...status } : candidate,
        ),
        now,
      });
    },
    remove(selection) {
      const descriptor = findDescriptor(selection, byKey, orderedDescriptors);
      const removedKey = makeProviderKey(
        descriptor.kind,
        descriptor.providerId,
        descriptor.providerVersion,
      );
      const descriptorsWithoutTarget = orderedDescriptors.map((candidate) => ({
        ...candidate,
        compatibleWith: candidate.compatibleWith.filter(
          (entry) => makeProviderKeyFromEntry(entry) !== removedKey,
        ),
      }));
      return createProviderRegistry({
        descriptors: descriptorsWithoutTarget.filter(
          (candidate) =>
            makeProviderKey(
              candidate.kind,
              candidate.providerId,
              candidate.providerVersion,
            ) !== removedKey,
        ),
        now,
      });
    },
    withNow(nextNow) {
      return createProviderRegistry({
        descriptors: orderedDescriptors,
        now: nextNow,
      });
    },
  };
  return Object.freeze(registry);
}

export function validateProviderConfiguration(
  descriptor,
  value,
  path = "$.providerConfiguration",
) {
  validateProviderDescriptor(descriptor);
  if (value === undefined) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.MISSING_CONFIGURATION,
      path,
      "provider-owned configuration is required",
      makeProviderKey(
        descriptor.kind,
        descriptor.providerId,
        descriptor.providerVersion,
      ),
    );
  }
  assertPlainObject(value, path);
  assertSafeConfigurationValue(value, path);
  const schema = descriptor.configSchema;
  for (const property of schema.required) {
    if (!Object.hasOwn(value, property)) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.INVALID_CONFIGURATION,
        `${path}.${property}`,
        `provider-owned configuration requires ${property}`,
        makeProviderKey(
          descriptor.kind,
          descriptor.providerId,
          descriptor.providerVersion,
        ),
      );
    }
  }
  for (const [property, candidate] of Object.entries(value)) {
    const definition = objectValue(schema.properties, property);
    if (!definition) {
      if (schema.additionalProperties === false) {
        throw registryError(
          PROVIDER_REGISTRY_ERROR_CODES.INVALID_CONFIGURATION,
          `${path}.${property}`,
          "provider-owned configuration field is not in the registered schema",
          makeProviderKey(
            descriptor.kind,
            descriptor.providerId,
            descriptor.providerVersion,
          ),
        );
      }
      continue;
    }
    validateConfigurationProperty(candidate, definition, `${path}.${property}`);
  }
  return freezeDeep(cloneJson(value));
}

export function assertProviderAdapter(provider, path = "$.provider") {
  assertPlainObject(provider, path);
  assertSafeInteger(provider.interfaceVersion, `${path}.interfaceVersion`, 1);
  if (provider.interfaceVersion !== PROVIDER_ADAPTER_INTERFACE_VERSION) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.ADAPTER_CONTRACT,
      `${path}.interfaceVersion`,
      `provider adapter interface version must be ${PROVIDER_ADAPTER_INTERFACE_VERSION}`,
    );
  }
  if (typeof provider.checkHealth !== "function") {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.ADAPTER_CONTRACT,
      `${path}.checkHealth`,
      "provider adapter must implement checkHealth()",
    );
  }
  if (typeof provider.describe !== "function") {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.ADAPTER_CONTRACT,
      `${path}.describe`,
      "provider adapter must implement describe()",
    );
  }
  if (typeof provider.validateConfiguration !== "function") {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.ADAPTER_CONTRACT,
      `${path}.validateConfiguration`,
      "provider adapter must implement validateConfiguration()",
    );
  }
  const descriptor = provider.describe();
  validateProviderDescriptor(descriptor, `${path}.descriptor`);
  const health = provider.checkHealth();
  assertExactObject(
    health,
    ["enabled", "expiresAt", "health", "installed", "observedAt"],
    `${path}.health`,
    "provider health",
  );
  assertBoolean(health.enabled, `${path}.health.enabled`);
  assertBoolean(health.installed, `${path}.health.installed`);
  assertEnum(health.health, PROVIDER_HEALTH_STATES, `${path}.health.health`);
  assertSafeInteger(health.observedAt, `${path}.health.observedAt`, 0);
  assertSafeInteger(health.expiresAt, `${path}.health.expiresAt`, 0);
  return descriptor;
}

export function createScriptedProvider({ kind, providerId, providerVersion }) {
  const descriptor = BUILTIN_PROVIDER_DESCRIPTORS.find(
    (candidate) =>
      candidate.kind === kind &&
      candidate.providerId === providerId &&
      candidate.providerVersion === providerVersion,
  );
  if (!descriptor || providerId !== "scripted") {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.UNKNOWN_PROVIDER,
      "$.provider",
      "scripted provider adapter requires a registered scripted descriptor",
    );
  }
  const adapter = {
    interfaceVersion: PROVIDER_ADAPTER_INTERFACE_VERSION,
    describe() {
      return descriptor;
    },
    checkHealth() {
      return {
        enabled: descriptor.enabled,
        expiresAt: descriptor.expiresAt,
        health: descriptor.health,
        installed: descriptor.installed,
        observedAt: descriptor.observedAt,
      };
    },
    validateConfiguration(value) {
      return validateProviderConfiguration(descriptor, value);
    },
  };
  assertProviderAdapter(adapter);
  return Object.freeze(adapter);
}

const MAX_DESCRIPTOR_TIME = Number.MAX_SAFE_INTEGER;

export const BUILTIN_PROVIDER_DESCRIPTORS = Object.freeze(
  [
    createBuiltinDescriptor({
      kind: "harness",
      providerId: "scripted",
      providerVersion: "1.0.0",
      displayName: "Deterministic scripted harness",
      implementationStatus: "implemented",
      installed: true,
      enabled: true,
      health: "healthy",
      capabilities: ["cancellation", "structured-output", "tool-calls"],
      limits: {
        maxConcurrentRuns: 8,
        maxInputBytes: 1_000_000,
        maxOutputBytes: 1_000_000,
        maxWallClockSeconds: 3_600,
      },
      protocol: "scripted-harness-v1",
      schemaId: "urn:stream-slack:provider:harness-scripted:v1",
      compatibleWith: [
        { kind: "sandbox", providerId: "scripted", providerVersion: "1.0.0" },
      ],
    }),
    createBuiltinDescriptor({
      kind: "harness",
      providerId: "codex",
      providerVersion: "1.0.0",
      displayName: "Codex harness",
      implementationStatus: "unimplemented",
      installed: false,
      enabled: true,
      health: "unknown",
      capabilities: ["cancellation", "structured-output", "tool-calls"],
      limits: {
        maxConcurrentRuns: 8,
        maxInputBytes: 1_000_000,
        maxOutputBytes: 1_000_000,
        maxWallClockSeconds: 3_600,
      },
      protocol: "codex-harness-v1",
      schemaId: "urn:stream-slack:provider:harness-codex:v1",
      compatibleWith: [
        {
          kind: "sandbox",
          providerId: "fly-sprites",
          providerVersion: "1.0.0",
        },
      ],
    }),
    createBuiltinDescriptor({
      kind: "harness",
      providerId: "claude-code",
      providerVersion: "1.0.0",
      displayName: "Claude Code harness",
      implementationStatus: "unimplemented",
      installed: false,
      enabled: true,
      health: "unknown",
      capabilities: ["cancellation", "structured-output", "tool-calls"],
      limits: {
        maxConcurrentRuns: 8,
        maxInputBytes: 1_000_000,
        maxOutputBytes: 1_000_000,
        maxWallClockSeconds: 3_600,
      },
      protocol: "claude-code-harness-v1",
      schemaId: "urn:stream-slack:provider:harness-claude-code:v1",
      compatibleWith: [
        {
          kind: "sandbox",
          providerId: "fly-sprites",
          providerVersion: "1.0.0",
        },
      ],
    }),
    createBuiltinDescriptor({
      kind: "sandbox",
      providerId: "scripted",
      providerVersion: "1.0.0",
      displayName: "Deterministic scripted sandbox",
      implementationStatus: "implemented",
      installed: true,
      enabled: true,
      health: "healthy",
      capabilities: [
        "checkpoint-reconnect",
        "ephemeral",
        "persistent",
        "streaming-exec",
      ],
      limits: {
        maxConcurrentRuns: 4,
        maxInputBytes: 10_000_000,
        maxOutputBytes: 10_000_000,
        maxWallClockSeconds: 7_200,
      },
      protocol: "scripted-sandbox-v1",
      schemaId: "urn:stream-slack:provider:sandbox-scripted:v1",
      compatibleWith: [
        { kind: "harness", providerId: "scripted", providerVersion: "1.0.0" },
      ],
    }),
    createBuiltinDescriptor({
      kind: "sandbox",
      providerId: "fly-sprites",
      providerVersion: "1.0.0",
      displayName: "Fly Sprites sandbox",
      implementationStatus: "unimplemented",
      installed: false,
      enabled: true,
      health: "unknown",
      capabilities: [
        "checkpoint-reconnect",
        "ephemeral",
        "persistent",
        "streaming-exec",
      ],
      limits: {
        maxConcurrentRuns: 4,
        maxInputBytes: 10_000_000,
        maxOutputBytes: 10_000_000,
        maxWallClockSeconds: 7_200,
      },
      protocol: "fly-sprites-sandbox-v1",
      schemaId: "urn:stream-slack:provider:sandbox-fly-sprites:v1",
      compatibleWith: [
        { kind: "harness", providerId: "codex", providerVersion: "1.0.0" },
        {
          kind: "harness",
          providerId: "claude-code",
          providerVersion: "1.0.0",
        },
      ],
    }),
  ].map(normalizeProviderDescriptor),
);

function createBuiltinDescriptor({
  kind,
  providerId,
  providerVersion,
  displayName,
  implementationStatus,
  installed,
  enabled,
  health,
  capabilities,
  limits,
  protocol,
  schemaId,
  compatibleWith,
}) {
  return {
    descriptorSchemaVersion: PROVIDER_DESCRIPTOR_SCHEMA_VERSION,
    kind,
    providerId,
    providerVersion,
    displayName,
    implementationStatus,
    installed,
    enabled,
    health,
    observedAt: 0,
    expiresAt: MAX_DESCRIPTOR_TIME,
    capabilities,
    limits,
    configSchema: {
      schemaVersion: 1,
      schemaId,
      type: "object",
      required: ["protocol"],
      properties: {
        protocol: {
          type: "string",
          enum: [protocol],
        },
      },
      additionalProperties: false,
    },
    compatibleWith,
  };
}

function findDescriptor(selection, byKey, descriptors) {
  assertPlainObject(selection, "$.selection");
  for (const key of ["kind", "providerId", "providerVersion"]) {
    if (!Object.hasOwn(selection, key)) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.MISSING_SELECTION,
        `$.selection.${key}`,
        "exact provider kind, id, and version are required",
      );
    }
  }
  assertProviderCoordinates(
    selection.kind,
    selection.providerId,
    selection.providerVersion,
    "$.selection",
  );
  const key = makeProviderKey(
    selection.kind,
    selection.providerId,
    selection.providerVersion,
  );
  const exact = byKey.get(key);
  if (exact) return exact;
  const sameProvider = descriptors.some(
    (descriptor) =>
      descriptor.kind === selection.kind &&
      descriptor.providerId === selection.providerId,
  );
  if (sameProvider) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.UNSUPPORTED_PROVIDER_VERSION,
      "$.selection.providerVersion",
      `provider version ${selection.providerVersion} is not registered for ${selection.providerId}`,
      key,
    );
  }
  throw registryError(
    PROVIDER_REGISTRY_ERROR_CODES.UNKNOWN_PROVIDER,
    "$.selection.providerId",
    `provider ${selection.providerId} is not registered for ${selection.kind}`,
    key,
  );
}

function assertRunnable(descriptor, now) {
  const key = makeProviderKey(
    descriptor.kind,
    descriptor.providerId,
    descriptor.providerVersion,
  );
  if (!descriptor.installed) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.PROVIDER_NOT_INSTALLED,
      "$.provider.installed",
      "provider is registered but not installed",
      key,
    );
  }
  if (!descriptor.enabled) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.PROVIDER_DISABLED,
      "$.provider.enabled",
      "provider is disabled",
      key,
    );
  }
  if (descriptor.health !== "healthy") {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.PROVIDER_UNHEALTHY,
      "$.provider.health",
      `provider health is ${descriptor.health}`,
      key,
    );
  }
  if (now > descriptor.expiresAt) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.PROVIDER_STALE,
      "$.provider.expiresAt",
      "provider descriptor health observation is stale",
      key,
    );
  }
  if (descriptor.implementationStatus !== "implemented") {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.PROVIDER_NOT_IMPLEMENTED,
      "$.provider.implementationStatus",
      "provider is registered but has no implemented runtime adapter",
      key,
    );
  }
}

function assertSelectionCapabilities(selection, descriptor) {
  assertPlainObject(selection, "$.selection");
  assertSubsetKeys(selection, SELECTION_KEYS, "$.selection");
  for (const key of ["providerId", "providerVersion", "requiredCapabilities"]) {
    if (!Object.hasOwn(selection, key)) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.MISSING_SELECTION,
        `$.selection.${key}`,
        "provider selection field is required",
      );
    }
  }
  assertArray(
    selection.requiredCapabilities,
    "$.selection.requiredCapabilities",
  );
  const seen = new Set();
  for (const [index, capability] of selection.requiredCapabilities.entries()) {
    assertString(
      capability,
      `$.selection.requiredCapabilities[${index}]`,
      1,
      64,
    );
    if (!CAPABILITY_PATTERN.test(capability)) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.INVALID_CONFIGURATION,
        `$.selection.requiredCapabilities[${index}]`,
        "capability must be lowercase kebab-case",
      );
    }
    if (seen.has(capability)) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.DUPLICATE_CAPABILITY,
        "$.selection.requiredCapabilities",
        `capability ${capability} is listed more than once`,
      );
    }
    seen.add(capability);
    if (!descriptor.capabilities.includes(capability)) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.UNSUPPORTED_CAPABILITY,
        `$.selection.requiredCapabilities[${index}]`,
        `provider does not publish capability ${capability}`,
        makeProviderKey(
          descriptor.kind,
          descriptor.providerId,
          descriptor.providerVersion,
        ),
      );
    }
  }
  if (
    selection.lifecycle !== undefined &&
    !selection.requiredCapabilities.includes(selection.lifecycle)
  ) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.UNSUPPORTED_CAPABILITY,
      "$.selection.lifecycle",
      "selected lifecycle must be one of the required provider capabilities",
    );
  }
}

function assertCompatible(harness, sandbox, byKey) {
  const harnessDescriptor = byKey.get(harness.providerKey);
  const sandboxDescriptor = byKey.get(sandbox.providerKey);
  const harnessSupportsSandbox = descriptorSupports(
    harnessDescriptor,
    sandboxDescriptor,
  );
  const sandboxSupportsHarness = descriptorSupports(
    sandboxDescriptor,
    harnessDescriptor,
  );
  if (!harnessSupportsSandbox || !sandboxSupportsHarness) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.INCOMPATIBLE_PROVIDERS,
      "$.config",
      "selected harness and sandbox do not share a reciprocal compatibility declaration",
      `${harness.providerKey}+${sandbox.providerKey}`,
    );
  }
}

function descriptorSupports(descriptor, target) {
  return descriptor.compatibleWith.some(
    (entry) => makeProviderKeyFromEntry(entry) === targetKey(target),
  );
}

function targetKey(target) {
  return makeProviderKey(
    target.kind,
    target.providerId,
    target.providerVersion,
  );
}

function validateCompatibilityGraph(descriptors, byKey) {
  for (const descriptor of descriptors) {
    for (const entry of descriptor.compatibleWith) {
      const target = byKey.get(makeProviderKeyFromEntry(entry));
      if (!target) {
        throw registryError(
          PROVIDER_REGISTRY_ERROR_CODES.INVALID_REGISTRY,
          "$.registry.descriptors",
          `compatibility target ${makeProviderKeyFromEntry(entry)} is not registered`,
          targetKey(descriptor),
        );
      }
      if (!descriptorSupports(target, descriptor)) {
        throw registryError(
          PROVIDER_REGISTRY_ERROR_CODES.INVALID_REGISTRY,
          "$.registry.descriptors",
          `compatibility declaration between ${targetKey(descriptor)} and ${targetKey(target)} is not reciprocal`,
          targetKey(descriptor),
        );
      }
    }
  }
}

function providerStatus(descriptor, now) {
  const stale = now > descriptor.expiresAt;
  return freezeDeep({
    installed: descriptor.installed,
    enabled: descriptor.enabled,
    health: descriptor.health,
    observedAt: descriptor.observedAt,
    expiresAt: descriptor.expiresAt,
    stale,
    available:
      descriptor.installed &&
      descriptor.enabled &&
      descriptor.health === "healthy" &&
      descriptor.implementationStatus === "implemented" &&
      !stale,
  });
}

function validateCapabilities(value, path) {
  assertArray(value, path);
  const seen = new Set();
  for (const [index, capability] of value.entries()) {
    assertString(capability, `${path}[${index}]`, 1, 64);
    if (!CAPABILITY_PATTERN.test(capability)) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
        `${path}[${index}]`,
        "capabilities must be lowercase kebab-case",
      );
    }
    if (seen.has(capability)) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.DUPLICATE_CAPABILITY,
        path,
        `capability ${capability} is listed more than once`,
      );
    }
    seen.add(capability);
  }
}

function validateLimits(value, path) {
  assertExactObject(value, LIMIT_KEYS, path, "provider limits");
  for (const key of LIMIT_KEYS) {
    assertSafeInteger(objectValue(value, key), `${path}.${key}`, 1);
  }
}

function validateConfigurationSchema(value, path) {
  assertExactObject(value, CONFIG_SCHEMA_KEYS, path, "provider schema");
  assertSafeInteger(value.schemaVersion, `${path}.schemaVersion`, 1);
  if (value.schemaVersion !== 1) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
      `${path}.schemaVersion`,
      "provider configuration schema version must be 1",
    );
  }
  assertString(value.schemaId, `${path}.schemaId`, 1, 200);
  if (!SCHEMA_ID_PATTERN.test(value.schemaId)) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
      `${path}.schemaId`,
      "provider schema id must be a versioned stream-slack URN",
    );
  }
  assertEnum(value.type, ["object"], `${path}.type`);
  assertBoolean(value.additionalProperties, `${path}.additionalProperties`);
  assertArray(value.required, `${path}.required`);
  assertPlainObject(value.properties, `${path}.properties`);
  const required = new Set();
  for (const [index, property] of value.required.entries()) {
    assertString(property, `${path}.required[${index}]`, 1, 120);
    if (required.has(property)) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
        `${path}.required`,
        `schema property ${property} is required more than once`,
      );
    }
    required.add(property);
  }
  for (const property of required) {
    if (!Object.hasOwn(value.properties, property)) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
        `${path}.required`,
        `required schema property ${property} is not defined`,
      );
    }
  }
  for (const [property, definition] of Object.entries(value.properties)) {
    validateConfigurationPropertyDefinition(
      definition,
      `${path}.properties.${property}`,
    );
  }
}

function validateConfigurationPropertyDefinition(value, path) {
  assertPlainObject(value, path);
  assertSubsetKeys(value, CONFIG_PROPERTY_ALLOWED_KEYS, path);
  assertEnum(
    value.type,
    ["boolean", "integer", "number", "string"],
    `${path}.type`,
  );
  if (Object.hasOwn(value, "enum")) {
    assertArray(value.enum, `${path}.enum`);
    if (value.enum.length === 0) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
        `${path}.enum`,
        "provider schema enums must contain at least one value",
      );
    }
    for (const [index, item] of value.enum.entries()) {
      if (!["boolean", "number", "string"].includes(typeof item)) {
        throw registryError(
          PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
          `${path}.enum[${index}]`,
          "provider schema enum values must be primitive",
        );
      }
    }
  }
  for (const key of ["minimum", "maximum"]) {
    if (Object.hasOwn(value, key)) {
      assertSafeInteger(objectValue(value, key), `${path}.${key}`, 0);
    }
  }
  if (
    Object.hasOwn(value, "minimum") &&
    Object.hasOwn(value, "maximum") &&
    value.minimum > value.maximum
  ) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
      path,
      "provider schema minimum cannot exceed maximum",
    );
  }
  if (Object.hasOwn(value, "pattern")) {
    assertString(value.pattern, `${path}.pattern`, 1, 240);
    try {
      new RegExp(value.pattern, "u");
    } catch {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
        `${path}.pattern`,
        "provider schema pattern must be a valid regular expression",
      );
    }
  }
}

function validateConfigurationProperty(value, definition, path) {
  const typeMatches =
    (definition.type === "boolean" && typeof value === "boolean") ||
    (definition.type === "integer" &&
      Number.isSafeInteger(value) &&
      !Number.isNaN(value)) ||
    (definition.type === "number" &&
      typeof value === "number" &&
      Number.isFinite(value)) ||
    (definition.type === "string" && typeof value === "string");
  if (!typeMatches) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.INVALID_CONFIGURATION,
      path,
      `provider configuration value must be ${definition.type}`,
    );
  }
  if (typeof value === "string") {
    if (
      hasControlCharacter(value) ||
      SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))
    ) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.INVALID_CONFIGURATION,
        path,
        "provider configuration may not contain control or secret-shaped values",
      );
    }
    if (
      definition.pattern &&
      !new RegExp(definition.pattern, "u").test(value)
    ) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.INVALID_CONFIGURATION,
        path,
        "provider configuration value does not match the provider schema",
      );
    }
  }
  if (typeof value === "number") {
    if (definition.minimum !== undefined && value < definition.minimum) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.INVALID_CONFIGURATION,
        path,
        "provider configuration value is below the provider schema minimum",
      );
    }
    if (definition.maximum !== undefined && value > definition.maximum) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.INVALID_CONFIGURATION,
        path,
        "provider configuration value exceeds the provider schema maximum",
      );
    }
  }
  if (
    definition.enum &&
    !definition.enum.some((candidate) => Object.is(candidate, value))
  ) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.INVALID_CONFIGURATION,
      path,
      "provider configuration value is not in the provider schema enum",
    );
  }
}

function validateCompatibilityList(value, path, { kind }) {
  assertArray(value, path);
  const seen = new Set();
  for (const [index, entry] of value.entries()) {
    const entryPath = `${path}[${index}]`;
    assertExactObject(
      entry,
      COMPATIBILITY_KEYS,
      entryPath,
      "compatibility entry",
    );
    assertEnum(entry.kind, PROVIDER_KINDS, `${entryPath}.kind`);
    if (entry.kind === kind) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
        `${entryPath}.kind`,
        "a provider may only declare compatibility with the opposite provider kind",
      );
    }
    assertProviderCoordinates(
      entry.kind,
      entry.providerId,
      entry.providerVersion,
      entryPath,
    );
    const key = makeProviderKeyFromEntry(entry);
    if (seen.has(key)) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.DUPLICATE_COMPATIBILITY,
        path,
        `compatibility target ${key} is listed more than once`,
      );
    }
    seen.add(key);
  }
}

function normalizeConfigurationSchema(value) {
  return {
    schemaVersion: value.schemaVersion,
    schemaId: value.schemaId,
    type: value.type,
    required: [...value.required].sort(compareCodeUnits),
    properties: Object.fromEntries(
      Object.entries(value.properties)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, definition]) => [key, { ...definition }]),
    ),
    additionalProperties: value.additionalProperties,
  };
}

function normalizeProviderDescriptorAtPath(value, path) {
  validateProviderDescriptor(value, path);
  return normalizeProviderDescriptor(value);
}

function assertProviderCoordinates(kind, providerId, providerVersion, path) {
  assertEnum(kind, PROVIDER_KINDS, `${path}.kind`);
  assertString(providerId, `${path}.providerId`, 2, 64);
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
      `${path}.providerId`,
      "provider id must be lowercase kebab-case",
    );
  }
  assertString(providerVersion, `${path}.providerVersion`, 5, 32);
  if (!PROVIDER_VERSION_PATTERN.test(providerVersion)) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
      `${path}.providerVersion`,
      "provider version must use numeric semantic version syntax",
    );
  }
}

function makeProviderKey(kind, providerId, providerVersion) {
  return `${kind}:${providerId}@${providerVersion}`;
}

function makeProviderKeyFromEntry(entry) {
  return makeProviderKey(entry.kind, entry.providerId, entry.providerVersion);
}

function registryError(code, path, detail, providerKeyValue) {
  const error = new ProviderRegistryError(`${code} at ${path}: ${detail}`);
  error.name = "ProviderRegistryError";
  error.code = code;
  error.path = path;
  error.detail = detail;
  if (providerKeyValue !== undefined) error.providerKey = providerKeyValue;
  return error;
}

function assertExactObject(value, expectedKeys, path, label) {
  assertPlainObject(value, path);
  const expected = new Set(expectedKeys);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
      path,
      `${label} may not contain symbol properties`,
    );
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
        `${path}.${key}`,
        `${label} field is not registered`,
      );
    }
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
        `${path}.${key}`,
        `${label} field is required`,
      );
    }
  }
}

function assertSubsetKeys(value, allowedKeys, path) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
        `${path}.${key}`,
        "provider schema field is not registered",
      );
    }
  }
}

function requireProperty(value, property, path) {
  if (!Object.hasOwn(value, property)) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.MISSING_SELECTION,
      `${path}.${property}`,
      "configuration must select both a harness and a sandbox",
    );
  }
}

function assertPlainObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.INVALID_CONFIGURATION,
      path,
      "expected a plain object",
    );
  }
}

function assertArray(value, path) {
  if (!Array.isArray(value)) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
      path,
      "expected an array",
    );
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
      path,
      "arrays may not contain symbol properties",
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
        `${path}[${index}]`,
        "sparse arrays are not allowed",
      );
    }
  }
}

function assertString(value, path, minLength, maxLength) {
  if (
    typeof value !== "string" ||
    value.length < minLength ||
    value.length > maxLength ||
    hasControlCharacter(value)
  ) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
      path,
      `string must be between ${minLength} and ${maxLength} characters without controls`,
    );
  }
}

function assertBoolean(value, path) {
  if (typeof value !== "boolean") {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
      path,
      "expected a boolean",
    );
  }
}

function assertSafeInteger(value, path, min) {
  if (!Number.isSafeInteger(value) || value < min) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
      path,
      `expected a safe integer at least ${min}`,
    );
  }
}

function assertEnum(value, allowed, path) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw registryError(
      PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
      path,
      `value must be one of: ${allowed.join(", ")}`,
    );
  }
}

function assertSafeConfigurationValue(value, path, ancestors = new Set()) {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.INVALID_CONFIGURATION,
        path,
        "provider configuration numbers must be finite",
      );
    }
    return;
  }
  if (typeof value === "string") {
    if (
      hasControlCharacter(value) ||
      SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))
    ) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.INVALID_CONFIGURATION,
        path,
        "provider configuration may not contain control or secret-shaped values",
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.INVALID_CONFIGURATION,
        path,
        "provider configuration may not be cyclic",
      );
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.INVALID_CONFIGURATION,
        path,
        "provider configuration arrays may not contain symbol properties",
      );
    }
    ancestors.add(value);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw registryError(
          PROVIDER_REGISTRY_ERROR_CODES.INVALID_CONFIGURATION,
          `${path}[${index}]`,
          "provider configuration arrays may not be sparse",
        );
      }
    }
    for (const [index, item] of value.entries()) {
      assertSafeConfigurationValue(item, `${path}[${index}]`, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  if (value && typeof value === "object") {
    if (ancestors.has(value)) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.INVALID_CONFIGURATION,
        path,
        "provider configuration may not be cyclic",
      );
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw registryError(
        PROVIDER_REGISTRY_ERROR_CODES.INVALID_CONFIGURATION,
        path,
        "provider configuration objects may not contain symbol properties",
      );
    }
    ancestors.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_CONFIGURATION_KEYS.has(key)) {
        throw registryError(
          PROVIDER_REGISTRY_ERROR_CODES.INVALID_CONFIGURATION,
          `${path}.${key}`,
          "provider configuration may not carry credentials or secret values",
        );
      }
      assertSafeConfigurationValue(child, `${path}.${key}`, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  throw registryError(
    PROVIDER_REGISTRY_ERROR_CODES.INVALID_CONFIGURATION,
    path,
    "provider configuration must contain only JSON values",
  );
}

function canonicalProviderValue(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("canonical value is not finite");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalProviderValue(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(
        ([key, child]) =>
          `${JSON.stringify(key)}:${canonicalProviderValue(child)}`,
      )
      .join(",")}}`;
  }
  throw new TypeError("canonical provider value must be JSON data");
}

function digestCanonical(value) {
  return `sha256:${bytesToHex(sha256Digest(value))}`;
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneJson(child)]),
    );
  }
  return value;
}

function objectValue(value, key) {
  return Object.entries(value).find(([candidate]) => candidate === key)?.[1];
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function compareCodeUnits(left, right) {
  const leftValue = String(left);
  const rightValue = String(right);
  const length =
    leftValue.length < rightValue.length ? leftValue.length : rightValue.length;
  for (let index = 0; index < length; index += 1) {
    const difference =
      leftValue.charCodeAt(index) - rightValue.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return leftValue.length - rightValue.length;
}

function compareCompatibility(left, right) {
  return compareCodeUnits(
    makeProviderKeyFromEntry(left),
    makeProviderKeyFromEntry(right),
  );
}

function compareDescriptors(left, right) {
  return compareCodeUnits(targetKey(left), targetKey(right));
}

function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    ) {
      return true;
    }
  }
  return false;
}
