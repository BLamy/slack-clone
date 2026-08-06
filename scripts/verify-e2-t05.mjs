import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  BUILTIN_PROVIDER_DESCRIPTORS,
  PROVIDER_KINDS,
  PROVIDER_REGISTRY_ERROR_CODES,
  assertProviderAdapter,
  createProviderRegistry,
  createScriptedProvider,
  providerDescriptorDigest,
} from "@stream-slack/protocol";

const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-2-the-roster/E2-T05-provider-registry-and-capabilities",
);
const runId = String(
  process.env.TEST_RUN_ID ?? `verify-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/gu, "-");
const artifactRoot = path.resolve(
  root,
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e2-t05", runId),
);
const evidenceDirectory =
  process.env.PROMOTE_EVIDENCE === "1"
    ? path.join(taskDirectory, "evidence/e2-t05-final")
    : artifactRoot;
const implementationCommit = String(
  process.env.E2_T05_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
const CANARY = "Bearer e2-t05-provider-secret-canary-123456789";
const SCRIPTED_PROTOCOLS = Object.freeze({
  harness: "scripted-harness-v1",
  sandbox: "scripted-sandbox-v1",
});

assert.match(
  implementationCommit,
  /^[0-9a-f]{40}$/u,
  "E2-T05 evidence requires an exact implementation commit",
);

await main();

async function main() {
  await mkdir(evidenceDirectory, { recursive: true });
  if (process.env.PROMOTE_EVIDENCE === "1") {
    const trackedChanges = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      { cwd: root, encoding: "utf8" },
    ).trim();
    assert.equal(
      trackedChanges,
      "",
      "promoted E2-T05 evidence must start from a clean tracked implementation tree",
    );
  }
  if (process.env.E2_T05_SENSITIVITY_MUTANT === "1") {
    await runSensitivityProbe();
    return;
  }

  const registry = createProviderRegistry();
  const sourceAudit = await auditProviderBranching();
  const manifest = registry.manifest();
  const conformance = verifyConformance();
  const matrix = verifyCompatibilityMatrix(registry);
  const resolved = verifyResolvedDigests(registry);
  const refusals = verifyRefusals(registry);
  const sensitivity = await runSensitivity();
  const gates = runGates();

  assert.equal(sourceAudit.offenses.length, 0);
  assert.equal(matrix.result, "PASS");
  assert.equal(resolved.result, "PASS");
  assert.equal(refusals.result, "PASS");
  assert.equal(conformance.result, "PASS");
  assert.equal(sensitivity.verifierDetectedMutant, true);

  const summary = {
    schemaVersion: 1,
    task: "E2-T05",
    runId,
    implementationCommit,
    result: "PASS",
    replayDescription:
      "Replay: N/A (server provider contract) + mitigation: conformance doubles, fail-closed compatibility matrix, registry manifests, and digest evidence",
    skips:
      process.env.E2_T05_SKIP_GATES === "1"
        ? ["format", "lint", "typecheck", "test", "build"]
        : [],
    gates,
    registry: {
      schemaVersion: manifest.schemaVersion,
      providerCount: manifest.providers.length,
      manifestDigest: registry.manifestDigest(),
      availableProviderKeys: manifest.providers
        .filter(({ status }) => status.available)
        .map((provider) => providerKey(provider)),
      unavailableProviderKeys: manifest.providers
        .filter(({ status }) => !status.available)
        .map((provider) => providerKey(provider)),
    },
    sourceAudit,
    conformance,
    compatibility: matrix,
    resolved,
    refusals,
    sensitivity,
  };
  await writeJson("verification-summary.json", summary);
  await writeJson("registry-manifest.json", manifest);
  await writeJson("compatibility-matrix.json", matrix);
  await writeJson("refusals.json", refusals);
  await writeJson("resolved-provider-digests.json", resolved);
  await writeJson("conformance.json", conformance);
  await writeJson("sensitivity.json", sensitivity);
  console.log(
    JSON.stringify(
      {
        result: summary.result,
        task: summary.task,
        implementationCommit,
        providerCount: manifest.providers.length,
        compatibilityRows: matrix.rows.length,
        refusalCount: refusals.rows.length,
        resolvedProviderDigest: resolved.valid.resolvedProviderDigest,
        sensitivity: sensitivity.verifierDetectedMutant,
        skips: summary.skips,
      },
      null,
      2,
    ),
  );
}

function verifyConformance() {
  const rows = [];
  for (const kind of PROVIDER_KINDS) {
    const adapter = createScriptedProvider({
      kind,
      providerId: "scripted",
      providerVersion: "1.0.0",
    });
    const descriptor = assertProviderAdapter(adapter);
    const protocol = SCRIPTED_PROTOCOLS[kind];
    assert.equal(
      adapter.validateConfiguration({ protocol }).protocol,
      protocol,
    );
    rows.push({
      adapterInterfaceVersion: adapter.interfaceVersion,
      descriptorDigest: providerDescriptorDigest(descriptor),
      kind,
      providerKey: providerKey(descriptor),
      result: "PASS",
    });
  }
  return {
    interfaceVersion: 1,
    rows,
    result: "PASS",
  };
}

function verifyCompatibilityMatrix(registry) {
  const harnesses = registry.list({ kind: "harness" });
  const sandboxes = registry.list({ kind: "sandbox" });
  const rows = [];
  for (const harness of harnesses) {
    for (const sandbox of sandboxes) {
      const declaredByHarness = declares(harness, sandbox);
      const declaredBySandbox = declares(sandbox, harness);
      const expectedAvailable =
        registry.status(harness).available &&
        registry.status(sandbox).available;
      const expectedRunnable =
        expectedAvailable && declaredByHarness && declaredBySandbox;
      let actual = { allowed: false, code: null };
      try {
        registry.resolveConfiguration({
          config: {
            harness: selection(harness, []),
            sandbox: selection(sandbox, ["ephemeral"]),
          },
          providerConfigurations: {
            harness: providerConfiguration(harness),
            sandbox: providerConfiguration(sandbox),
          },
        });
        actual = { allowed: true, code: null };
      } catch (error) {
        actual = { allowed: false, code: error.code };
      }
      assert.equal(actual.allowed, expectedRunnable);
      if (!expectedRunnable) {
        assert.ok(
          actual.code,
          "a refused compatibility row must have a typed code",
        );
      }
      rows.push({
        harnessProviderKey: providerKey(harness),
        sandboxProviderKey: providerKey(sandbox),
        declaredByHarness,
        declaredBySandbox,
        harnessAvailable: registry.status(harness).available,
        sandboxAvailable: registry.status(sandbox).available,
        expectedRunnable,
        actual,
        result: "PASS",
      });
    }
  }
  assert.equal(rows.filter(({ actual }) => actual.allowed).length, 1);
  return {
    rows,
    runnableRows: rows.filter(({ actual }) => actual.allowed).length,
    refusedRows: rows.filter(({ actual }) => !actual.allowed).length,
    result: "PASS",
  };
}

function verifyResolvedDigests(registry) {
  const baseConfig = {
    harness: {
      providerId: "scripted",
      providerVersion: "1.0.0",
      requiredCapabilities: ["structured-output", "tool-calls"],
    },
    sandbox: {
      providerId: "scripted",
      providerVersion: "1.0.0",
      requiredCapabilities: ["persistent", "ephemeral"],
      lifecycle: "persistent",
      networkPolicy: "deny-all",
    },
  };
  const providerConfigurations = {
    harness: { protocol: "scripted-harness-v1" },
    sandbox: { protocol: "scripted-sandbox-v1" },
  };
  const valid = registry.resolveConfiguration({
    config: baseConfig,
    providerConfigurations,
  });
  const reordered = registry.resolveConfiguration({
    config: {
      harness: {
        ...baseConfig.harness,
        requiredCapabilities: [
          ...baseConfig.harness.requiredCapabilities,
        ].reverse(),
      },
      sandbox: {
        ...baseConfig.sandbox,
        requiredCapabilities: [
          ...baseConfig.sandbox.requiredCapabilities,
        ].reverse(),
      },
    },
    providerConfigurations,
  });
  assert.equal(
    valid.resolvedProviderDigest,
    reordered.resolvedProviderDigest,
    "unordered capability requirements must not alter resolved digest",
  );
  const changed = registry.resolveConfiguration({
    config: {
      ...baseConfig,
      harness: {
        ...baseConfig.harness,
        requiredCapabilities: ["structured-output"],
      },
    },
    providerConfigurations,
  });
  assert.notEqual(valid.resolvedProviderDigest, changed.resolvedProviderDigest);
  return {
    result: "PASS",
    valid: {
      resolvedProviderDigest: valid.resolvedProviderDigest,
      harnessDescriptorDigest: valid.harness.descriptorDigest,
      sandboxDescriptorDigest: valid.sandbox.descriptorDigest,
      harnessConfigurationDigest: valid.harness.providerConfigurationDigest,
      sandboxConfigurationDigest: valid.sandbox.providerConfigurationDigest,
      requiredCapabilities: {
        harness: valid.harness.requiredCapabilities,
        sandbox: valid.sandbox.requiredCapabilities,
      },
    },
    reorderedEquivalent: true,
    semanticMutationChangedDigest: true,
  };
}

function verifyRefusals(registry) {
  const rows = [];
  rows.push(
    refusal(
      "unknown AlmostNode provider",
      () =>
        registry.resolve({
          kind: "sandbox",
          selection: {
            providerId: "almostnode-browser",
            providerVersion: "1.0.0",
            requiredCapabilities: ["ephemeral"],
          },
          providerConfiguration: {},
        }),
      PROVIDER_REGISTRY_ERROR_CODES.UNKNOWN_PROVIDER,
    ),
    refusal(
      "downgraded provider version",
      () =>
        registry.resolve({
          kind: "harness",
          selection: {
            providerId: "scripted",
            providerVersion: "0.9.0",
            requiredCapabilities: [],
          },
          providerConfiguration: {},
        }),
      PROVIDER_REGISTRY_ERROR_CODES.UNSUPPORTED_PROVIDER_VERSION,
    ),
    refusal(
      "missing exact selection field",
      () =>
        registry.resolve({
          kind: "harness",
          selection: {
            providerId: "scripted",
            providerVersion: "1.0.0",
          },
          providerConfiguration: {},
        }),
      PROVIDER_REGISTRY_ERROR_CODES.MISSING_SELECTION,
    ),
    refusal(
      "unsupported capability",
      () =>
        registry.resolve({
          kind: "harness",
          selection: {
            providerId: "scripted",
            providerVersion: "1.0.0",
            requiredCapabilities: ["streaming-exec"],
          },
          providerConfiguration: { protocol: "scripted-harness-v1" },
        }),
      PROVIDER_REGISTRY_ERROR_CODES.UNSUPPORTED_CAPABILITY,
    ),
    refusal(
      "duplicate required capability",
      () =>
        registry.resolve({
          kind: "harness",
          selection: {
            providerId: "scripted",
            providerVersion: "1.0.0",
            requiredCapabilities: ["structured-output", "structured-output"],
          },
          providerConfiguration: { protocol: "scripted-harness-v1" },
        }),
      PROVIDER_REGISTRY_ERROR_CODES.DUPLICATE_CAPABILITY,
    ),
    refusal(
      "missing provider-owned configuration",
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
    ),
    refusal(
      "altered provider-owned schema value",
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
    ),
    refusal(
      "unavailable unimplemented Codex provider",
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
    ),
  );

  const disabled = registry.updateStatus({
    selection: {
      kind: "harness",
      providerId: "scripted",
      providerVersion: "1.0.0",
    },
    enabled: false,
  });
  rows.push(
    refusal(
      "disabled provider",
      () =>
        disabled.resolve({
          kind: "harness",
          selection: {
            providerId: "scripted",
            providerVersion: "1.0.0",
            requiredCapabilities: [],
          },
          providerConfiguration: { protocol: "scripted-harness-v1" },
        }),
      PROVIDER_REGISTRY_ERROR_CODES.PROVIDER_DISABLED,
    ),
  );

  const unhealthy = registry.updateStatus({
    selection: {
      kind: "harness",
      providerId: "scripted",
      providerVersion: "1.0.0",
    },
    health: "unhealthy",
  });
  rows.push(
    refusal(
      "unhealthy provider",
      () =>
        unhealthy.resolve({
          kind: "harness",
          selection: {
            providerId: "scripted",
            providerVersion: "1.0.0",
            requiredCapabilities: [],
          },
          providerConfiguration: { protocol: "scripted-harness-v1" },
        }),
      PROVIDER_REGISTRY_ERROR_CODES.PROVIDER_UNHEALTHY,
    ),
  );

  const stale = registry
    .updateStatus({
      selection: {
        kind: "harness",
        providerId: "scripted",
        providerVersion: "1.0.0",
      },
      observedAt: 1,
      expiresAt: 2,
    })
    .withNow(3);
  rows.push(
    refusal(
      "stale provider readiness",
      () =>
        stale.resolve({
          kind: "harness",
          selection: {
            providerId: "scripted",
            providerVersion: "1.0.0",
            requiredCapabilities: [],
          },
          providerConfiguration: { protocol: "scripted-harness-v1" },
        }),
      PROVIDER_REGISTRY_ERROR_CODES.PROVIDER_STALE,
    ),
  );

  const removed = registry.remove({
    kind: "harness",
    providerId: "scripted",
    providerVersion: "1.0.0",
  });
  rows.push(
    refusal(
      "removed provider",
      () =>
        removed.resolve({
          kind: "harness",
          selection: {
            providerId: "scripted",
            providerVersion: "1.0.0",
            requiredCapabilities: [],
          },
          providerConfiguration: { protocol: "scripted-harness-v1" },
        }),
      PROVIDER_REGISTRY_ERROR_CODES.UNKNOWN_PROVIDER,
    ),
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
  rows.push(
    refusal(
      "incompatible ready providers",
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
      PROVIDER_REGISTRY_ERROR_CODES.INCOMPATIBLE_PROVIDERS,
    ),
  );

  const duplicate = [
    ...BUILTIN_PROVIDER_DESCRIPTORS,
    BUILTIN_PROVIDER_DESCRIPTORS[0],
  ];
  rows.push(
    refusal(
      "duplicate descriptor",
      () => createProviderRegistry({ descriptors: duplicate }),
      PROVIDER_REGISTRY_ERROR_CODES.DUPLICATE_PROVIDER,
    ),
  );
  const duplicateCapability = structuredClone(BUILTIN_PROVIDER_DESCRIPTORS);
  duplicateCapability[0].capabilities.push("tool-calls");
  rows.push(
    refusal(
      "duplicate descriptor capability",
      () => createProviderRegistry({ descriptors: duplicateCapability }),
      PROVIDER_REGISTRY_ERROR_CODES.DUPLICATE_CAPABILITY,
    ),
  );
  assert.equal(rows.length, 15);
  assert.equal(
    rows.every(({ result }) => result === "PASS"),
    true,
  );
  return { rows, result: "PASS" };
}

function refusal(name, callback, expectedCode) {
  try {
    callback();
  } catch (error) {
    assert.equal(error.code, expectedCode, name);
    assert.equal(typeof error.path, "string", name);
    return {
      name,
      code: error.code,
      path: error.path,
      providerKey: error.providerKey ?? null,
      result: "PASS",
    };
  }
  assert.fail(`${name} unexpectedly resolved`);
}

async function auditProviderBranching() {
  const files = [];
  for (const directory of [
    path.join(root, "src"),
    path.join(root, "packages/services/src"),
    path.join(root, "packages/http/src"),
    path.join(root, "packages/durable-streams/src"),
  ]) {
    files.push(...(await executableFiles(directory)));
  }
  const patterns = [
    {
      name: "provider-id equality branch",
      pattern: /\bproviderId\s*!==?\s*["']|\bproviderId\s*===?\s*["']/u,
    },
    {
      name: "provider-name equality branch",
      pattern: /\bproviderName\s*!==?\s*["']|\bproviderName\s*===?\s*["']/u,
    },
    {
      name: "provider switch branch",
      pattern: /\bswitch\s*\([^)]*\bprovider(?:Id|Name)\b/u,
    },
  ];
  const offenses = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const rule of patterns) {
      if (rule.pattern.test(source)) {
        offenses.push({ file: path.relative(root, file), rule: rule.name });
      }
    }
  }
  return {
    scannedFiles: files.map((file) => path.relative(root, file)),
    offenses,
    result: offenses.length === 0 ? "PASS" : "FAIL",
  };
}

function runGates() {
  if (process.env.E2_T05_SKIP_GATES === "1") return [];
  return [
    ["format", "pnpm", ["format:check"]],
    ["lint", "pnpm", ["lint"]],
    ["typecheck", "pnpm", ["typecheck"]],
    ["test", "pnpm", ["test"]],
    ["build", "pnpm", ["build"]],
  ].map(([name, command, args]) => {
    const result = spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    });
    if (result.status !== 0) {
      throw new Error(
        `${name} gate failed with exit ${result.status}:\n${result.stdout}\n${result.stderr}`,
      );
    }
    return {
      command: [command, ...args].join(" "),
      exitCode: result.status,
      name,
    };
  });
}

async function runSensitivity() {
  await mkdir(path.join(taskDirectory, "work"), { recursive: true });
  const source = await readFile(
    path.join(root, "packages/protocol/src/provider-registry.mjs"),
    "utf8",
  );
  const mutations = [
    {
      name: "remove capability negotiation refusal",
      needle: "if (!descriptor.capabilities.includes(capability)) {",
      expectedCode: PROVIDER_REGISTRY_ERROR_CODES.UNSUPPORTED_CAPABILITY,
      probe: "capability",
    },
    {
      name: "remove reciprocal compatibility refusal",
      needle: "if (!harnessSupportsSandbox || !sandboxSupportsHarness) {",
      expectedCode: PROVIDER_REGISTRY_ERROR_CODES.INCOMPATIBLE_PROVIDERS,
      probe: "compatibility",
    },
  ];
  const results = [];
  for (const mutation of mutations) {
    assert.equal(source.split(mutation.needle).length - 1, 1, mutation.name);
    const sensitivityRoot = await mkdtemp(
      path.join(taskDirectory, "work/sensitivity-"),
    );
    const mutantModule = path.join(sensitivityRoot, "provider-registry.mjs");
    const probePath = path.join(sensitivityRoot, "probe.mjs");
    try {
      await writeFile(
        mutantModule,
        source.replace(mutation.needle, "if (false) {"),
      );
      await copyFile(
        path.join(root, "packages/protocol/src/sha256.mjs"),
        path.join(sensitivityRoot, "sha256.mjs"),
      );
      await writeFile(
        probePath,
        sensitivityProbeSource({
          moduleUrl: pathToFileURL(mutantModule).href,
          expectedCode: mutation.expectedCode,
          probe: mutation.probe,
        }),
      );
      const result = spawnSync(process.execPath, [probePath], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(
        result.status,
        7,
        `${mutation.name} must make the probe go red`,
      );
      assert.doesNotMatch(result.stdout, new RegExp(CANARY, "u"));
      assert.doesNotMatch(result.stderr, new RegExp(CANARY, "u"));
      results.push({
        mutation: mutation.name,
        exitCode: result.status,
        verifierDetectedMutant: true,
        result: "PASS",
      });
    } finally {
      await rm(sensitivityRoot, { recursive: true, force: true });
    }
  }
  return {
    mutationCount: results.length,
    mutations: results,
    verifierDetectedMutant: results.every(
      ({ verifierDetectedMutant }) => verifierDetectedMutant,
    ),
    result: "PASS",
  };
}

function sensitivityProbeSource({ moduleUrl, expectedCode, probe }) {
  return `import { createProviderRegistry } from ${JSON.stringify(moduleUrl)};
const registry = createProviderRegistry();
try {
  if (${JSON.stringify(probe)} === "capability") {
    registry.resolve({
      kind: "harness",
      selection: {
        providerId: "scripted",
        providerVersion: "1.0.0",
        requiredCapabilities: ["streaming-exec"],
      },
      providerConfiguration: { protocol: "scripted-harness-v1" },
    });
  } else {
    const codexReady = registry.updateStatus({
      selection: { kind: "harness", providerId: "codex", providerVersion: "1.0.0" },
      installed: true,
      health: "healthy",
    });
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
    });
  }
} catch (error) {
  if (error.code === ${JSON.stringify(expectedCode)}) process.exit(0);
  process.exit(2);
}
process.exit(7);
`;
}

async function executableFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await executableFiles(file)));
    else if (/\.(?:mjs|js|cjs)$/u.test(entry.name)) files.push(file);
  }
  return files;
}

function declares(descriptor, target) {
  return descriptor.compatibleWith.some(
    (entry) => providerKey(entry) === providerKey(target),
  );
}

function selection(descriptor, requiredCapabilities) {
  return {
    providerId: descriptor.providerId,
    providerVersion: descriptor.providerVersion,
    requiredCapabilities,
    ...(descriptor.kind === "sandbox"
      ? {
          lifecycle: requiredCapabilities[0] ?? "ephemeral",
          networkPolicy: "deny-all",
        }
      : {}),
  };
}

function providerConfiguration(descriptor) {
  return {
    protocol: descriptor.configSchema.properties.protocol.enum[0],
  };
}

function providerKey(value) {
  return `${value.kind}:${value.providerId}@${value.providerVersion}`;
}

async function writeJson(filename, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  assert.doesNotMatch(text, new RegExp(CANARY, "u"));
  await writeFile(path.join(evidenceDirectory, filename), text);
}
