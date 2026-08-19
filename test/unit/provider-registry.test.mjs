import test from "node:test";
import assert from "node:assert/strict";

import {
  BUILTIN_PROVIDER_DESCRIPTORS,
  PROVIDER_REGISTRY_ERROR_CODES,
  assertProviderAdapter,
  createProviderRegistry,
  createScriptedProvider,
  providerDescriptorDigest,
} from "@stream-slack/protocol";

const SCRIPTED_HARNESS = {
  kind: "harness",
  providerId: "scripted",
  providerVersion: "1.0.0",
};
test("provider registry exposes versioned manifests and canonical descriptor digests", () => {
  const registry = createProviderRegistry();
  const manifest = registry.manifest();
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.providers.length, 5);
  assert.equal(registry.status(SCRIPTED_HARNESS).available, true);
  assert.deepEqual(
    registry.status({
      kind: "harness",
      providerId: "codex",
      providerVersion: "1.0.0",
    }),
    {
      installed: false,
      enabled: true,
      health: "unknown",
      observedAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
      stale: false,
      available: false,
    },
  );
  assert.equal(
    providerDescriptorDigest(registry.describe(SCRIPTED_HARNESS)),
    providerDescriptorDigest(registry.describe(SCRIPTED_HARNESS)),
  );

  const reordered = [...BUILTIN_PROVIDER_DESCRIPTORS]
    .reverse()
    .map((descriptor) => ({
      ...descriptor,
      capabilities: [...descriptor.capabilities].reverse(),
      compatibleWith: [...descriptor.compatibleWith].reverse(),
      configSchema: {
        ...descriptor.configSchema,
        required: [...descriptor.configSchema.required].reverse(),
      },
    }));
  assert.equal(
    createProviderRegistry().manifestDigest(),
    createProviderRegistry({ descriptors: reordered }).manifestDigest(),
  );
});

test("scripted providers implement the shared adapter contract", () => {
  const adapter = createScriptedProvider({
    kind: "harness",
    providerId: "scripted",
    providerVersion: "1.0.0",
  });
  const descriptor = assertProviderAdapter(adapter);
  assert.equal(descriptor.providerId, "scripted");
  assert.equal(adapter.checkHealth().health, "healthy");
  assert.equal(
    adapter.validateConfiguration({ protocol: "scripted-harness-v1" }).protocol,
    "scripted-harness-v1",
  );
});

test("exact provider selections negotiate capabilities, schemas, compatibility, and digests", () => {
  const registry = createProviderRegistry();
  const resolved = registry.resolveConfiguration({
    config: {
      harness: {
        providerId: "scripted",
        providerVersion: "1.0.0",
        requiredCapabilities: ["structured-output"],
      },
      sandbox: {
        providerId: "scripted",
        providerVersion: "1.0.0",
        requiredCapabilities: ["ephemeral"],
        lifecycle: "ephemeral",
        networkPolicy: "deny-all",
      },
    },
    providerConfigurations: {
      harness: { protocol: "scripted-harness-v1" },
      sandbox: { protocol: "scripted-sandbox-v1" },
    },
  });
  assert.equal(resolved.compatibility.status, "compatible");
  assert.match(resolved.resolvedProviderDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(resolved.harness.requiredCapabilities[0], "structured-output");
  assert.match(resolved.harness.descriptorDigest, /^sha256:[0-9a-f]{64}$/u);

  const changed = registry.resolveConfiguration({
    config: {
      harness: {
        providerId: "scripted",
        providerVersion: "1.0.0",
        requiredCapabilities: ["tool-calls"],
      },
      sandbox: {
        providerId: "scripted",
        providerVersion: "1.0.0",
        requiredCapabilities: ["ephemeral"],
        lifecycle: "ephemeral",
        networkPolicy: "deny-all",
      },
    },
    providerConfigurations: {
      harness: { protocol: "scripted-harness-v1" },
      sandbox: { protocol: "scripted-sandbox-v1" },
    },
  });
  assert.notEqual(
    resolved.resolvedProviderDigest,
    changed.resolvedProviderDigest,
  );
});

test("provider negotiation fails closed with typed reasons", () => {
  const registry = createProviderRegistry();
  assertCode(
    () =>
      registry.resolve({
        kind: "harness",
        selection: {
          providerId: "almostnode-browser",
          providerVersion: "1.0.0",
          requiredCapabilities: [],
        },
        providerConfiguration: {},
      }),
    PROVIDER_REGISTRY_ERROR_CODES.UNKNOWN_PROVIDER,
  );
  assertCode(
    () =>
      registry.resolve({
        kind: "harness",
        selection: {
          providerId: "scripted",
          providerVersion: "9.9.9",
          requiredCapabilities: [],
        },
        providerConfiguration: {},
      }),
    PROVIDER_REGISTRY_ERROR_CODES.UNSUPPORTED_PROVIDER_VERSION,
  );
  assertCode(
    () =>
      registry.resolve({
        kind: "harness",
        selection: {
          providerId: "scripted",
          providerVersion: "1.0.0",
          requiredCapabilities: ["streaming-exec"],
        },
        providerConfiguration: {},
      }),
    PROVIDER_REGISTRY_ERROR_CODES.UNSUPPORTED_CAPABILITY,
  );
  assertCode(
    () =>
      registry.resolve({
        kind: "harness",
        selection: {
          providerId: "scripted",
          providerVersion: "1.0.0",
          requiredCapabilities: [],
        },
      }),
    PROVIDER_REGISTRY_ERROR_CODES.MISSING_CONFIGURATION,
  );
  assertCode(
    () =>
      registry.resolve({
        kind: "harness",
        selection: {
          providerId: "scripted",
          providerVersion: "1.0.0",
          requiredCapabilities: [],
        },
        providerConfiguration: { protocol: "wrong-protocol" },
      }),
    PROVIDER_REGISTRY_ERROR_CODES.INVALID_CONFIGURATION,
  );
  assertCode(
    () =>
      registry.resolve({
        kind: "harness",
        selection: {
          providerId: "codex",
          providerVersion: "1.0.0",
          requiredCapabilities: [],
        },
        providerConfiguration: { protocol: "codex-harness-v1" },
      }),
    PROVIDER_REGISTRY_ERROR_CODES.PROVIDER_NOT_INSTALLED,
  );
});

test("disabled, unhealthy, stale, removed, and incompatible providers never resolve", () => {
  const registry = createProviderRegistry();
  const disabled = registry.updateStatus({
    selection: SCRIPTED_HARNESS,
    enabled: false,
  });
  assertCode(
    () =>
      disabled.resolve({
        kind: "harness",
        selection: { ...SCRIPTED_HARNESS, requiredCapabilities: [] },
        providerConfiguration: { protocol: "scripted-harness-v1" },
      }),
    PROVIDER_REGISTRY_ERROR_CODES.PROVIDER_DISABLED,
  );

  const unhealthy = registry.updateStatus({
    selection: SCRIPTED_HARNESS,
    health: "unhealthy",
  });
  assertCode(
    () =>
      unhealthy.resolve({
        kind: "harness",
        selection: { ...SCRIPTED_HARNESS, requiredCapabilities: [] },
        providerConfiguration: { protocol: "scripted-harness-v1" },
      }),
    PROVIDER_REGISTRY_ERROR_CODES.PROVIDER_UNHEALTHY,
  );

  const stale = registry
    .updateStatus({
      selection: SCRIPTED_HARNESS,
      observedAt: 1,
      expiresAt: 2,
    })
    .withNow(3);
  assertCode(
    () =>
      stale.resolve({
        kind: "harness",
        selection: { ...SCRIPTED_HARNESS, requiredCapabilities: [] },
        providerConfiguration: { protocol: "scripted-harness-v1" },
      }),
    PROVIDER_REGISTRY_ERROR_CODES.PROVIDER_STALE,
  );

  const removed = registry.remove(SCRIPTED_HARNESS);
  assertCode(
    () =>
      removed.resolve({
        kind: "harness",
        selection: { ...SCRIPTED_HARNESS, requiredCapabilities: [] },
        providerConfiguration: { protocol: "scripted-harness-v1" },
      }),
    PROVIDER_REGISTRY_ERROR_CODES.UNKNOWN_PROVIDER,
  );

  const codexReady = registry.updateStatus({
    selection: {
      kind: "harness",
      providerId: "codex",
      providerVersion: "1.0.0",
    },
    installed: true,
    health: "healthy",
  });
  assertCode(
    () =>
      codexReady.resolveConfiguration({
        config: {
          harness: {
            providerId: "codex",
            providerVersion: "1.0.0",
            requiredCapabilities: [],
          },
          sandbox: {
            providerId: "scripted",
            providerVersion: "1.0.0",
            requiredCapabilities: ["ephemeral"],
            lifecycle: "ephemeral",
            networkPolicy: "deny-all",
          },
        },
        providerConfigurations: {
          harness: { protocol: "codex-harness-v1" },
          sandbox: { protocol: "scripted-sandbox-v1" },
        },
      }),
    PROVIDER_REGISTRY_ERROR_CODES.PROVIDER_NOT_IMPLEMENTED,
  );

  const implementedDescriptors = structuredClone(BUILTIN_PROVIDER_DESCRIPTORS);
  implementedDescriptors.find(
    (descriptor) =>
      descriptor.kind === "harness" && descriptor.providerId === "codex",
  ).implementationStatus = "implemented";
  implementedDescriptors.find(
    (descriptor) =>
      descriptor.kind === "sandbox" && descriptor.providerId === "fly-sprites",
  ).implementationStatus = "implemented";
  const implemented = createProviderRegistry({
    descriptors: implementedDescriptors,
  });
  const ready = implemented
    .updateStatus({
      selection: {
        kind: "harness",
        providerId: "codex",
        providerVersion: "1.0.0",
      },
      installed: true,
      health: "healthy",
    })
    .updateStatus({
      selection: {
        kind: "sandbox",
        providerId: "fly-sprites",
        providerVersion: "1.0.0",
      },
      installed: true,
      health: "healthy",
    });
  assert.doesNotThrow(() =>
    ready.resolveConfiguration({
      config: {
        harness: {
          providerId: "codex",
          providerVersion: "1.0.0",
          requiredCapabilities: [],
        },
        sandbox: {
          providerId: "fly-sprites",
          providerVersion: "1.0.0",
          requiredCapabilities: ["ephemeral"],
          lifecycle: "ephemeral",
          networkPolicy: "deny-all",
        },
      },
      providerConfigurations: {
        harness: { protocol: "codex-harness-v1" },
        sandbox: { protocol: "fly-sprites-sandbox-v1" },
      },
    }),
  );
  assertCode(
    () =>
      ready.resolveConfiguration({
        config: {
          harness: {
            providerId: "codex",
            providerVersion: "1.0.0",
            requiredCapabilities: [],
          },
          sandbox: {
            providerId: "scripted",
            providerVersion: "1.0.0",
            requiredCapabilities: ["ephemeral"],
            lifecycle: "ephemeral",
            networkPolicy: "deny-all",
          },
        },
        providerConfigurations: {
          harness: { protocol: "codex-harness-v1" },
          sandbox: { protocol: "scripted-sandbox-v1" },
        },
      }),
    PROVIDER_REGISTRY_ERROR_CODES.INCOMPATIBLE_PROVIDERS,
  );
});

test("descriptor integrity rejects duplicates and altered schemas", () => {
  const duplicate = [
    ...BUILTIN_PROVIDER_DESCRIPTORS,
    BUILTIN_PROVIDER_DESCRIPTORS[0],
  ];
  assertCode(
    () => createProviderRegistry({ descriptors: duplicate }),
    PROVIDER_REGISTRY_ERROR_CODES.DUPLICATE_PROVIDER,
  );
  const duplicateCapability = structuredClone(BUILTIN_PROVIDER_DESCRIPTORS);
  duplicateCapability[0].capabilities.push("tool-calls");
  assertCode(
    () => createProviderRegistry({ descriptors: duplicateCapability }),
    PROVIDER_REGISTRY_ERROR_CODES.DUPLICATE_CAPABILITY,
  );
  const alteredSchema = structuredClone(BUILTIN_PROVIDER_DESCRIPTORS);
  alteredSchema[0].configSchema.schemaId = "not-a-provider-schema";
  assertCode(
    () => createProviderRegistry({ descriptors: alteredSchema }),
    PROVIDER_REGISTRY_ERROR_CODES.INVALID_DESCRIPTOR,
  );
});

function assertCode(callback, expectedCode) {
  assert.throws(callback, (error) => {
    assert.equal(error.code, expectedCode);
    assert.equal(typeof error.path, "string");
    return true;
  });
}
