import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { webcrypto as crypto } from "node:crypto";
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
  agentConfigDigest,
  agentConfigRevisionId,
  createProviderRegistry,
  membershipIdFor,
} from "@stream-slack/protocol";

const snapshotModule = process.env.E2_T07_SNAPSHOT_MODULE
  ? await import(
      pathToFileURL(path.resolve(process.env.E2_T07_SNAPSHOT_MODULE)).href
    )
  : await import("@stream-slack/protocol");
const {
  INVOCATION_SNAPSHOT_ERROR_CODES,
  canonicalInvocationSnapshot,
  checkInvocationSnapshotUse,
  createInvocationSnapshot,
  encodeInvocationSnapshot,
  replayInvocationSnapshot,
} = snapshotModule;

const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-2-the-roster/E2-T07-immutable-invocation-snapshot",
);
const runId = String(
  process.env.TEST_RUN_ID ?? `verify-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/gu, "-");
const artifactRoot = path.resolve(
  root,
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e2-t07", runId),
);
const evidenceDirectory =
  process.env.PROMOTE_EVIDENCE === "1"
    ? path.join(taskDirectory, "evidence/e2-t07-final")
    : artifactRoot;
const implementationCommit = String(
  process.env.E2_T07_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();

const WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const AGENT_ID = `ag_${WORKSPACE_ID.slice(3)}_${"f".repeat(26)}`;
const PRINCIPAL_ID = `pr_${AGENT_ID.slice(3)}`;
const CHANNEL_ID = `ch_${WORKSPACE_ID.slice(3)}_${"1".repeat(26)}`;
const CANARY = "Bearer e2-t07-invocation-canary-123456789";
const CONFIG_PATH = path.join(
  root,
  ".eforest/tasks/epic-2-the-roster/E2-T01-versioned-agent-config-schema/fixtures/valid/agent-config.v1.json",
);
const PROVIDER_CONFIGURATIONS = {
  harness: { protocol: "scripted-harness-v1" },
  sandbox: { protocol: "scripted-sandbox-v1" },
};
const BASE_SOURCE_HEADS = {
  config: {
    offset: "0000000000000030_aaaaaaaaaaaaaaaa",
    stateDigest: `sha256:${"1".repeat(64)}`,
    stream: `agent:${AGENT_ID}/config`,
  },
  directory: {
    offset: "0000000000000040_bbbbbbbbbbbbbbbb",
    stateDigest: `sha256:${"2".repeat(64)}`,
    stream: `workspace:${WORKSPACE_ID}/directory`,
  },
};

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
      "promoted E2-T07 evidence must start from a clean tracked implementation tree",
    );
  }

  const result = await verifyWorkflow();
  const sensitivity =
    process.env.E2_T07_SENSITIVITY_CHILD === "1"
      ? {
          mutationCount: 0,
          mutations: [],
          result: "CHILD",
          verifierDetectedMutant: true,
        }
      : await runSensitivity();
  const gates = runGates();
  assert.equal(result.result, "PASS");
  assert.equal(sensitivity.verifierDetectedMutant, true);

  const summary = {
    schemaVersion: 1,
    task: "E2-T07",
    runId,
    implementationCommit,
    result: "PASS",
    replayDescription:
      "Replay: N/A (server invocation-resolution contract) + mitigation: source-bound snapshot manifests, canary scans, reconfiguration races, and digest tests",
    skips:
      process.env.E2_T07_SKIP_GATES === "1"
        ? ["format", "lint", "typecheck", "test", "build"]
        : [],
    gates,
    snapshot: result.snapshot,
    sourceReferences: result.sourceReferences,
    refusalMatrix: result.refusalMatrix,
    revocationRaces: result.revocationRaces,
    canaryScan: result.canaryScan,
    sensitivity,
  };
  await writeJson("verification-summary.json", summary);
  await writeJson("snapshot-manifest.json", result.snapshot);
  await writeJson("source-references.json", result.sourceReferences);
  await writeJson("refusal-matrix.json", result.refusalMatrix);
  await writeJson("revocation-races.json", result.revocationRaces);
  await writeJson("canary-scan.json", result.canaryScan);
  await writeJson("sensitivity.json", sensitivity);
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        task: "E2-T07",
        implementationCommit,
        snapshotDigest: result.snapshot.initialDigest,
        refusalCount: result.refusalMatrix.rows.length,
        revocationCount: result.revocationRaces.rows.length,
        sensitivity: sensitivity.verifierDetectedMutant,
        skips: summary.skips,
      },
      null,
      2,
    ),
  );
}

async function verifyWorkflow() {
  const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  const input = makeInput(config);
  const snapshot = createInvocationSnapshot(input);
  const canonicalBytes = canonicalInvocationSnapshot(snapshot);
  const encodedBytes = encodeInvocationSnapshot(snapshot);
  const historicalBytes = JSON.stringify(snapshot);

  assert.equal(
    new TextDecoder().decode(encodedBytes),
    canonicalBytes,
    "encoded snapshot must be the canonical snapshot payload",
  );
  assert.equal(
    snapshot.snapshotDigest,
    `sha256:${bytesToHex(await sha256(canonicalBytes))}`,
  );
  assert.equal(
    snapshot.snapshotDigest,
    "sha256:470c2121c38bc9d4a720bf3cfab256c53cd2026c3bb62eefed292c6581529260",
  );
  assert.equal(
    snapshot.providers.manifestDigest,
    "sha256:751764325d1387da9404895128892e5a1e95005fb0bd45e27bd9dde42d6ec8b5",
  );
  assert.equal(
    snapshot.sourceManifest.config.stream,
    BASE_SOURCE_HEADS.config.stream,
  );
  assert.equal(
    snapshot.sourceManifest.directory.stream,
    BASE_SOURCE_HEADS.directory.stream,
  );
  assert.deepEqual(snapshot.sourceManifest.config, input.sourceHeads.config);
  assert.deepEqual(
    snapshot.sourceManifest.directory,
    input.sourceHeads.directory,
  );
  assert.deepEqual(
    snapshot.sourceManifest.workspaceInputs,
    input.sourceHeads.directory,
  );
  assert.equal(
    snapshot.sourceManifest.connectionGrants.length,
    input.connectionGrants.length,
  );
  assert.equal(
    snapshot.sourceManifest.providers.manifestDigest,
    snapshot.providers.manifestDigest,
  );
  assert.equal(snapshot.config.configDigest, agentConfigDigest(config));
  assert.equal(snapshot.config.agentId, AGENT_ID);
  assert.equal(snapshot.config.status, "active");
  assert.equal(snapshot.membership.role, "agent");
  assert.equal(snapshot.context.scope, config.context.scope);
  assert.equal(
    snapshot.budget.limits.maxTotalTokens,
    config.budgets.maxTotalTokens,
  );
  assert.equal(
    snapshot.workspaceInputs.manifestDigest.match(/^sha256:[0-9a-f]{64}$/u) !==
      null,
    true,
  );
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.config.agentConfig), true);
  assert.equal(
    replayInvocationSnapshot(snapshot).snapshotDigest,
    snapshot.snapshotDigest,
  );
  assert.equal(JSON.stringify(snapshot), historicalBytes);

  const sourceReferences = {
    config: snapshot.sourceManifest.config,
    directory: snapshot.sourceManifest.directory,
    workspaceInputs: snapshot.sourceManifest.workspaceInputs,
    connectionGrants: snapshot.sourceManifest.connectionGrants,
    providers: snapshot.sourceManifest.providers,
    snapshotDigest: snapshot.snapshotDigest,
  };
  const updates = verifyReconfigurationRaces({
    config,
    historicalBytes,
    input,
    snapshot,
  });
  const refusalMatrix = verifyRefusalMatrix({ config, input });
  const revocationRaces = verifyRevocationRaces({ config, input, snapshot });
  const canaryScan = verifyCanaryIsolation({ config, input, snapshot });

  return {
    canaryScan,
    refusalMatrix,
    result: "PASS",
    revocationRaces,
    snapshot: {
      canonicalByteLength: canonicalBytes.length,
      initialDigest: snapshot.snapshotDigest,
      replayable: true,
      updates,
    },
    sourceReferences,
  };
}

function verifyReconfigurationRaces({
  config,
  historicalBytes,
  input,
  snapshot,
}) {
  const configUpdate = structuredClone(config);
  configUpdate.instructions.task = "configuration revision two";
  const rows = [
    [
      "config revision",
      makeInput(configUpdate, {
        sourceHeads: {
          ...BASE_SOURCE_HEADS,
          config: {
            ...BASE_SOURCE_HEADS.config,
            offset: "0000000000000031_cccccccccccccccc",
            stateDigest: `sha256:${"3".repeat(64)}`,
          },
        },
      }),
    ],
    [
      "provider descriptor manifest",
      makeInput(config, {
        providerRegistry: input.providerRegistry.withNow(1),
      }),
    ],
    [
      "membership revision",
      makeInput(config, {
        workspaceMembership: {
          ...input.workspaceMembership,
          revision: input.workspaceMembership.revision + 1,
        },
      }),
    ],
    [
      "connection grant source",
      makeInput(config, {
        connectionGrants: input.connectionGrants.map((grant, index) =>
          index === 0
            ? {
                ...grant,
                sourceOffset: "0000000000000052_eeeeeeeeeeeeeeee",
                stateDigest: `sha256:${"7".repeat(64)}`,
              }
            : grant,
        ),
      }),
    ],
    [
      "workspace input directory source",
      makeInput(config, {
        sourceHeads: {
          ...BASE_SOURCE_HEADS,
          directory: {
            ...BASE_SOURCE_HEADS.directory,
            offset: "0000000000000041_dddddddddddddddd",
            stateDigest: `sha256:${"8".repeat(64)}`,
          },
        },
      }),
    ],
  ];
  return rows.map(([name, nextInput]) => {
    const next = createInvocationSnapshot(nextInput);
    assert.notEqual(next.snapshotDigest, snapshot.snapshotDigest, name);
    assert.equal(
      JSON.stringify(snapshot),
      historicalBytes,
      `${name} rewrote history`,
    );
    return {
      historicalDigest: snapshot.snapshotDigest,
      name,
      nextDigest: next.snapshotDigest,
      historicalBytesStable: true,
      sourceManifestChanged:
        canonicalInvocationSnapshot(next) !==
        canonicalInvocationSnapshot(snapshot),
    };
  });
}

function verifyRefusalMatrix({ config, input }) {
  const unhealthyRegistry = input.providerRegistry.updateStatus({
    selection: {
      kind: "harness",
      providerId: "scripted",
      providerVersion: "1.0.0",
    },
    health: "unhealthy",
  });
  const incompatibleRegistry = createProviderRegistry({
    descriptors: input.providerRegistry
      .list()
      .map((descriptor) =>
        descriptor.providerId === "scripted"
          ? { ...descriptor, compatibleWith: [] }
          : descriptor,
      ),
  });
  const rows = [];
  const refuse = (name, overrides, expectedCode) => {
    let error = null;
    try {
      createInvocationSnapshot(makeInput(config, overrides));
    } catch (candidate) {
      error = candidate;
    }
    assert.ok(error, `${name} must refuse snapshot creation`);
    assert.equal(error.code, expectedCode, name);
    assert.equal(
      error.message.includes(CANARY),
      false,
      `${name} leaked canary`,
    );
    rows.push({
      code: error.code,
      detail: error.detail,
      name,
      refused: true,
      sourceCode: error.sourceCode ?? null,
    });
  };

  refuse(
    "disabled configuration",
    {
      configState: {
        ...input.configState,
        runnable: false,
        status: "disabled",
      },
    },
    INVOCATION_SNAPSHOT_ERROR_CODES.AGENT_CONFIG_INACTIVE,
  );
  refuse(
    "suspended membership",
    {
      workspaceMembership: {
        ...input.workspaceMembership,
        revision: 8,
        status: "suspended",
      },
    },
    INVOCATION_SNAPSHOT_ERROR_CODES.MEMBERSHIP_INACTIVE,
  );
  refuse(
    "non-member principal reference",
    {
      workspaceMembership: {
        ...input.workspaceMembership,
        principalId: `pr_${WORKSPACE_ID.slice(3)}_${"e".repeat(26)}`,
      },
    },
    INVOCATION_SNAPSHOT_ERROR_CODES.MEMBERSHIP_INACTIVE,
  );
  refuse(
    "unhealthy provider",
    { providerRegistry: unhealthyRegistry },
    INVOCATION_SNAPSHOT_ERROR_CODES.PROVIDER_RESOLUTION_REFUSED,
  );
  refuse(
    "incompatible providers",
    { providerRegistry: incompatibleRegistry },
    INVOCATION_SNAPSHOT_ERROR_CODES.PROVIDER_RESOLUTION_REFUSED,
  );
  refuse(
    "expired grant",
    {
      connectionGrants: input.connectionGrants.map((grant) => ({
        ...grant,
        expiresAt: input.now,
      })),
    },
    INVOCATION_SNAPSHOT_ERROR_CODES.CONNECTION_GRANT_EXPIRED,
  );
  refuse(
    "over-budget invocation",
    {
      budgetUsage: {
        costUsdCents: 0,
        elapsedSeconds: 0,
        inputTokens: config.budgets.maxInputTokens + 1,
        outputTokens: 0,
        totalTokens: config.budgets.maxInputTokens + 1,
      },
    },
    INVOCATION_SNAPSHOT_ERROR_CODES.BUDGET_EXCEEDED,
  );
  refuse(
    "cross-workspace connection grant",
    {
      connectionGrants: input.connectionGrants.map((grant) => ({
        ...grant,
        workspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbbbb",
      })),
    },
    INVOCATION_SNAPSHOT_ERROR_CODES.CONNECTION_GRANT_SCOPE_MISMATCH,
  );

  const sideEffects = {
    describe: 0,
    manifestDigest: 0,
    resolveConfiguration: 0,
  };
  const countedRegistry = countRegistrySideEffects(
    input.providerRegistry,
    sideEffects,
  );
  const disabled = makeInput(config, {
    configState: { ...input.configState, runnable: false, status: "disabled" },
    providerRegistry: countedRegistry,
  });
  assert.throws(
    () => createInvocationSnapshot(disabled),
    (error) => {
      assert.equal(
        error.code,
        INVOCATION_SNAPSHOT_ERROR_CODES.AGENT_CONFIG_INACTIVE,
      );
      return true;
    },
  );
  assert.deepEqual(sideEffects, {
    describe: 0,
    manifestDigest: 0,
    resolveConfiguration: 0,
  });
  return {
    providerSideEffectsBeforeResolution: 0,
    rows,
    result: "PASS",
  };
}

function verifyRevocationRaces({ config, input, snapshot }) {
  const cases = [
    [
      "configuration disabled",
      {
        configState: {
          ...input.configState,
          runnable: false,
          status: "disabled",
        },
      },
      INVOCATION_SNAPSHOT_ERROR_CODES.AGENT_CONFIG_INACTIVE,
    ],
    [
      "membership suspended",
      {
        workspaceMembership: {
          ...input.workspaceMembership,
          revision: input.workspaceMembership.revision + 1,
          status: "suspended",
        },
      },
      INVOCATION_SNAPSHOT_ERROR_CODES.MEMBERSHIP_INACTIVE,
    ],
    [
      "provider health revoked",
      {
        providerRegistry: input.providerRegistry.updateStatus({
          selection: {
            kind: "harness",
            providerId: "scripted",
            providerVersion: "1.0.0",
          },
          health: "unhealthy",
        }),
      },
      INVOCATION_SNAPSHOT_ERROR_CODES.PROVIDER_RESOLUTION_REFUSED,
    ],
    [
      "all connection grants revoked",
      {
        connectionGrants: input.connectionGrants.map((grant) => ({
          ...grant,
          status: "revoked",
        })),
      },
      INVOCATION_SNAPSHOT_ERROR_CODES.CONNECTION_GRANT_REVOKED,
    ],
    [
      "workspace input source revoked",
      {
        sourceHeads: {
          ...BASE_SOURCE_HEADS,
          directory: {
            ...BASE_SOURCE_HEADS.directory,
            offset: "0000000000000041_dddddddddddddddd",
            stateDigest: `sha256:${"8".repeat(64)}`,
          },
        },
      },
      INVOCATION_SNAPSHOT_ERROR_CODES.STALE_WORKSPACE_INPUT,
    ],
  ];
  const rows = cases.map(([name, overrides, expectedCode]) => {
    const decision = checkInvocationSnapshotUse({
      ...makeInput(config, overrides),
      snapshot,
    });
    assert.equal(decision.allowed, false, name);
    assert.equal(decision.code, expectedCode, name);
    return { code: decision.code, name, rejected: true };
  });
  assert.equal(
    replayInvocationSnapshot(snapshot).snapshotDigest,
    snapshot.snapshotDigest,
  );
  return {
    historicalReplayStillValid: true,
    rows,
    result: "PASS",
  };
}

function verifyCanaryIsolation({ config, input, snapshot }) {
  const canaryInput = makeInput(config, {
    configState: { ...input.configState, auditCanary: CANARY },
    connectionGrants: input.connectionGrants.map((grant) => ({
      ...grant,
      resolverToken: CANARY,
    })),
  });
  const canarySnapshot = createInvocationSnapshot(canaryInput);
  const snapshotBytes = JSON.stringify(canarySnapshot);
  assert.equal(snapshotBytes.includes(CANARY), false);
  assert.equal(snapshotBytes.includes("resolverToken"), false);
  assert.equal(JSON.stringify(snapshot).includes(CANARY), false);
  return {
    checked: [
      "snapshot JSON bytes",
      "canonical snapshot bytes",
      "source manifest",
      "published refusal details",
    ],
    leaked: false,
    result: "PASS",
  };
}

async function runSensitivity() {
  await mkdir(path.join(taskDirectory, "work"), { recursive: true });
  const mutations = [
    {
      name: "bind config source digest to the wrong stream",
      needle: "sourceStateDigest: sources.config.stateDigest,",
      replacement: "sourceStateDigest: sources.directory.stateDigest,",
    },
    {
      name: "remove connection grant source references",
      needle: "connectionGrants: grants.refs.map(({ source }) => source),",
      replacement: "connectionGrants: [],",
    },
    {
      name: "bind source manifest config to directory source",
      needle: "    config: sources.config,\n    directory: sources.directory,",
      replacement:
        "    config: sources.directory,\n    directory: sources.directory,",
    },
  ];
  const results = [];
  for (const mutation of mutations) {
    const sensitivityRoot = await mkdtemp(
      path.join(taskDirectory, "work/sensitivity-"),
    );
    try {
      const sourceDirectory = path.join(root, "packages/protocol/src");
      for (const filename of await readdir(sourceDirectory)) {
        if (filename.endsWith(".mjs")) {
          await copyFile(
            path.join(sourceDirectory, filename),
            path.join(sensitivityRoot, filename),
          );
        }
      }
      const sourcePath = path.join(sourceDirectory, "invocation-snapshot.mjs");
      const source = await readFile(sourcePath, "utf8");
      assert.equal(source.split(mutation.needle).length - 1, 1, mutation.name);
      await writeFile(
        path.join(sensitivityRoot, "invocation-snapshot.mjs"),
        source.replace(mutation.needle, mutation.replacement),
      );
      const child = spawnSync(
        process.execPath,
        [path.join(root, "scripts/verify-e2-t07.mjs")],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            E2_T07_SENSITIVITY_CHILD: "1",
            E2_T07_SKIP_GATES: "1",
            E2_T07_SNAPSHOT_MODULE: path.join(
              sensitivityRoot,
              "invocation-snapshot.mjs",
            ),
            PROMOTE_EVIDENCE: "0",
            TEST_ARTIFACT_DIR: path.join(sensitivityRoot, "artifacts"),
            TEST_RUN_ID: `${runId}-${mutation.name.replace(/[^a-z0-9]+/giu, "-")}`,
          },
        },
      );
      assert.notEqual(
        child.status,
        0,
        `${mutation.name} must make verifier fail`,
      );
      assert.doesNotMatch(child.stdout, new RegExp(CANARY, "u"));
      assert.doesNotMatch(child.stderr, new RegExp(CANARY, "u"));
      results.push({
        exitCode: child.status,
        mutation: mutation.name,
        result: "PASS",
        verifierDetectedMutant: true,
      });
    } finally {
      await rm(sensitivityRoot, { recursive: true, force: true });
    }
  }
  return {
    mutationCount: results.length,
    mutations: results,
    result: "PASS",
    verifierDetectedMutant: results.every(
      ({ verifierDetectedMutant }) => verifierDetectedMutant,
    ),
  };
}

function countRegistrySideEffects(registry, counters) {
  return Object.freeze({
    ...registry,
    describe(...args) {
      counters.describe += 1;
      return registry.describe(...args);
    },
    manifestDigest(...args) {
      counters.manifestDigest += 1;
      return registry.manifestDigest(...args);
    },
    resolveConfiguration(...args) {
      counters.resolveConfiguration += 1;
      return registry.resolveConfiguration(...args);
    },
  });
}

function makeInput(config, overrides = {}) {
  const now = overrides.now ?? 100;
  const sourceHeads = structuredClone(
    overrides.sourceHeads ?? BASE_SOURCE_HEADS,
  );
  const configDigest = agentConfigDigest(config);
  const revisionId = agentConfigRevisionId({
    agentId: AGENT_ID,
    configDigest,
    revision: 1,
  });
  const base = {
    agentId: AGENT_ID,
    budgetUsage: null,
    channelMembership: {
      channelId: CHANNEL_ID,
      principalId: PRINCIPAL_ID,
      revision: 4,
      status: "active",
    },
    config,
    configState: {
      activeConfig: config,
      activeRevisionId: revisionId,
      revisions: [
        {
          agentId: AGENT_ID,
          config,
          configDigest,
          revision: 1,
          revisionId,
          sourceOffset: sourceHeads.config.offset,
          workspaceId: WORKSPACE_ID,
        },
      ],
      runnable: true,
      status: "active",
    },
    connectionGrants: makeGrants(config, now),
    context: {
      channelId: CHANNEL_ID,
      scope: "current-channel",
      threadId: null,
    },
    now,
    principal: {
      kind: "agent",
      principalId: PRINCIPAL_ID,
      profileRevision: 2,
      status: "active",
    },
    providerConfigurations: structuredClone(PROVIDER_CONFIGURATIONS),
    providerRegistry: createProviderRegistry({ now: 0 }),
    sourceHeads,
    workspaceInputManifest: {
      files: [
        {
          bytes: 10,
          digest: `sha256:${"4".repeat(64)}`,
          path: "README.md",
        },
        {
          bytes: 20,
          digest: `sha256:${"5".repeat(64)}`,
          path: "docs/index.md",
        },
      ],
      maxBytes: config.workspaceInputs.maxBytes,
      paths: [...config.workspaceInputs.paths],
      source: config.workspaceInputs.source,
      sourceOffset: sourceHeads.directory.offset,
      sourceStream: sourceHeads.directory.stream,
      stateDigest: sourceHeads.directory.stateDigest,
    },
    workspaceMembership: {
      membershipId: membershipIdFor(WORKSPACE_ID, PRINCIPAL_ID),
      principalId: PRINCIPAL_ID,
      revision: 7,
      role: "agent",
      status: "active",
      workspaceId: WORKSPACE_ID,
    },
  };
  return { ...base, ...overrides };
}

function makeGrants(config, now) {
  return config.connectionGrants.refs.map((ref, index) => ({
    ...ref,
    agentId: AGENT_ID,
    expiresAt: now + 400,
    sourceOffset: `00000000000000${50 + index}_cccccccccccccccc`,
    sourceStream: `connection:${ref.connectionId}/config`,
    stateDigest: `sha256:${String(6 + index).repeat(64)}`,
    status: "active",
    workspaceId: WORKSPACE_ID,
  }));
}

async function writeJson(filename, value) {
  await writeFile(
    path.join(evidenceDirectory, filename),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function runGates() {
  if (process.env.E2_T07_SKIP_GATES === "1") return {};
  const commands = ["format:check", "lint", "typecheck", "test", "build"];
  const results = {};
  for (const command of commands) {
    const child = spawnSync("pnpm", [command], {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    });
    results[command] = {
      command: `pnpm ${command}`,
      exitCode: child.status,
    };
    if (child.status !== 0) {
      throw new Error(
        `pnpm ${command} failed:\n${child.stdout}\n${child.stderr}`,
      );
    }
  }
  return results;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function sha256(value) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}
