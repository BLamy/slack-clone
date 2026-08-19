import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

import {
  AGENT_CONFIG_ERROR_CODES,
  AgentConfigValidationError,
  agentConfigDigest,
  canonicalAgentConfig,
  encodeAgentConfig,
  normalizeAgentConfig,
  upgradeAgentConfig,
  validateAgentConfig,
} from "@stream-slack/protocol";

const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-2-the-roster/E2-T01-versioned-agent-config-schema",
);
const fixtureDirectory = path.join(taskDirectory, "fixtures");
const promoteEvidence = process.env.PROMOTE_EVIDENCE === "1";
const runId = String(
  process.env.TEST_RUN_ID ?? `verify-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/gu, "-");
const implementationCommit = String(
  process.env.E2_T01_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
assert.match(
  implementationCommit,
  /^[0-9a-f]{40}$/u,
  "E2-T01 evidence requires an exact implementation commit",
);

if (promoteEvidence) {
  const trackedChanges = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    { cwd: root, encoding: "utf8" },
  ).trim();
  assert.equal(
    trackedChanges,
    "",
    "promoted E2-T01 evidence must start from a clean tracked implementation tree",
  );
}

const artifactRoot = path.resolve(
  root,
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e2-t01", runId),
);
const evidenceDirectory = promoteEvidence
  ? path.join(taskDirectory, "evidence/e2-t01-final")
  : artifactRoot;
await mkdir(evidenceDirectory, { recursive: true });

const validV1 = await readJson(
  path.join(fixtureDirectory, "valid/agent-config.v1.json"),
);
const validV0 = await readJson(
  path.join(fixtureDirectory, "valid/agent-config.v0.json"),
);
validateAgentConfig(validV1);

const normalized = normalizeAgentConfig(validV1);
const canonical = canonicalAgentConfig(validV1);
const encoded = encodeAgentConfig(validV1);
const digest = agentConfigDigest(validV1);
assert.equal(new TextDecoder().decode(encoded), canonical);
assert.equal(
  digest,
  `sha256:${createHash("sha256").update(encoded).digest("hex")}`,
);
assert.equal(canonicalAgentConfig(structuredClone(validV1)), canonical);

const reordered = structuredClone(validV1);
reordered.trigger.events.reverse();
reordered.harness.requiredCapabilities.reverse();
reordered.sandbox.requiredCapabilities.reverse();
reordered.connectionGrants.refs.reverse();
reordered.workspaceInputs.paths.reverse();
assert.equal(
  canonicalAgentConfig(reordered),
  canonical,
  "unordered arrays must not change canonical bytes",
);
const changed = structuredClone(validV1);
changed.budgets.maxOutputTokens += 1;
assert.notEqual(
  agentConfigDigest(changed),
  digest,
  "one semantic budget change must change the digest",
);

const upgraded = upgradeAgentConfig(validV0);
assert.equal(upgraded.schemaVersion, 1);
assert.deepEqual(upgraded, normalized);
assert.equal(
  canonicalAgentConfig(upgraded),
  canonical,
  "v0 upgrade must be deterministic and preserve explicit policy",
);
assert.deepEqual(upgradeAgentConfig(validV0), upgraded);

const refusalExpectations = new Map([
  ["unknown-environment-field.json", AGENT_CONFIG_ERROR_CODES.FORBIDDEN_FIELD],
  ["secret-canary-instructions.json", AGENT_CONFIG_ERROR_CODES.SECRET_VALUE],
  ["unknown-provider.json", AGENT_CONFIG_ERROR_CODES.UNKNOWN_PROVIDER],
  [
    "future-schema-version.json",
    AGENT_CONFIG_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION,
  ],
  ["fractional-budget.json", AGENT_CONFIG_ERROR_CODES.INVALID_VALUE],
  ["contradictory-policy.json", AGENT_CONFIG_ERROR_CODES.CONTRADICTORY_POLICY],
  ["unversioned-connection.json", AGENT_CONFIG_ERROR_CODES.MISSING_FIELD],
  ["unknown-startup-command.json", AGENT_CONFIG_ERROR_CODES.FORBIDDEN_FIELD],
]);
const refusals = [];
for (const [filename, expectedCode] of refusalExpectations) {
  const value = await readJson(
    path.join(fixtureDirectory, "invalid", filename),
  );
  const rejection = expectRejection(
    () => validateAgentConfig(value),
    expectedCode,
    filename,
  );
  refusals.push({ filename, code: rejection.code, path: rejection.path });
}

const policyMutations = [
  [
    "unknown-schema-version",
    (value) => (value.schemaVersion = 2),
    AGENT_CONFIG_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION,
  ],
  [
    "unknown-harness-version",
    (value) => (value.harness.providerVersion = "9.9.9"),
    AGENT_CONFIG_ERROR_CODES.UNSUPPORTED_PROVIDER_VERSION,
  ],
  [
    "unknown-capability",
    (value) => (value.harness.requiredCapabilities = ["unknown-capability"]),
    AGENT_CONFIG_ERROR_CODES.INVALID_CAPABILITY,
  ],
  [
    "unknown-trigger",
    (value) => (value.trigger.events = ["schedule"]),
    AGENT_CONFIG_ERROR_CODES.INVALID_ENUM,
  ],
  [
    "negative-budget",
    (value) => (value.budgets.timeoutSeconds = -1),
    AGENT_CONFIG_ERROR_CODES.INVALID_VALUE,
  ],
  [
    "fractional-concurrency",
    (value) => (value.concurrency.maxConcurrentRuns = 1.5),
    AGENT_CONFIG_ERROR_CODES.INVALID_VALUE,
  ],
  [
    "cross-channel-with-channel-context",
    (value) => {
      value.delegation.enabled = true;
      value.delegation.maxDepth = 1;
      value.delegation.maxChildren = 1;
      value.delegation.allowCrossChannel = true;
    },
    AGENT_CONFIG_ERROR_CODES.CONTRADICTORY_POLICY,
  ],
];
for (const [label, mutate, expectedCode] of policyMutations) {
  const candidate = structuredClone(validV1);
  mutate(candidate);
  const rejection = expectRejection(
    () => validateAgentConfig(candidate),
    expectedCode,
    label,
  );
  refusals.push({
    filename: label,
    code: rejection.code,
    path: rejection.path,
  });
}

const canaryResults = [];
const canaryCases = [
  [
    "instructions.system",
    (value) => (value.instructions.system = "Bearer canary-token-123456789"),
  ],
  [
    "instructions.task",
    (value) =>
      (value.instructions.task = "client_secret=canary-secret-123456789"),
  ],
  [
    "instructions.guardrails[0]",
    (value) =>
      (value.instructions.guardrails[0] = "sk-proj-12345678901234567890"),
  ],
  [
    "harness.providerId",
    (value) => (value.harness.providerId = "Bearer canary-token-123456789"),
  ],
  [
    "harness.providerVersion",
    (value) =>
      (value.harness.providerVersion = "Bearer canary-token-123456789"),
  ],
  [
    "harness.requiredCapabilities[0]",
    (value) =>
      (value.harness.requiredCapabilities[0] = "Bearer canary-token-123456789"),
  ],
  [
    "sandbox.providerId",
    (value) => (value.sandbox.providerId = "Bearer canary-token-123456789"),
  ],
  [
    "sandbox.providerVersion",
    (value) =>
      (value.sandbox.providerVersion = "Bearer canary-token-123456789"),
  ],
  [
    "sandbox.requiredCapabilities[0]",
    (value) =>
      (value.sandbox.requiredCapabilities[0] = "Bearer canary-token-123456789"),
  ],
  [
    "workspaceInputs.source",
    (value) => (value.workspaceInputs.source = "Bearer canary-token-123456789"),
  ],
  [
    "workspaceInputs.paths[0]",
    (value) =>
      (value.workspaceInputs.paths[0] = "Bearer canary-token-123456789"),
  ],
];
const configWithGrant = structuredClone(validV1);
configWithGrant.connectionGrants = {
  refs: [
    {
      connectionId: "conn_github",
      grantId: "grant_read",
      purpose: "read repository metadata",
      revision: 1,
    },
  ],
  maxCallsPerRun: 1,
};
canaryCases.push(
  [
    "connectionGrants.refs[0].connectionId",
    (value) =>
      (value.connectionGrants.refs[0].connectionId =
        "Bearer canary-token-123456789"),
  ],
  [
    "connectionGrants.refs[0].grantId",
    (value) =>
      (value.connectionGrants.refs[0].grantId =
        "Bearer canary-token-123456789"),
  ],
  [
    "connectionGrants.refs[0].purpose",
    (value) =>
      (value.connectionGrants.refs[0].purpose =
        "Bearer canary-token-123456789"),
  ],
);
for (const [location, mutate] of canaryCases) {
  const candidate = structuredClone(
    location.startsWith("connectionGrants") ? configWithGrant : validV1,
  );
  mutate(candidate);
  const rejection = expectRejection(
    () => validateAgentConfig(candidate),
    AGENT_CONFIG_ERROR_CODES.SECRET_VALUE,
    location,
  );
  canaryResults.push({ location, code: rejection.code, path: rejection.path });
}

const schema = await readJson(
  path.join(root, "packages/protocol/src/schemas/agent-config.v1.schema.json"),
);
assert.equal(schema.additionalProperties, false);
assert.equal(schema.properties.schemaVersion.const, 1);
assert.deepEqual(schema.required, [
  "schemaVersion",
  "instructions",
  "context",
  "trigger",
  "delegation",
  "concurrency",
  "budgets",
  "harness",
  "sandbox",
  "workspaceInputs",
  "connectionGrants",
]);
for (const forbiddenField of [
  "environment",
  "env",
  "providerSettings",
  "startupCommand",
  "token",
  "connection",
]) {
  assert.equal(
    schemaHasPropertyName(schema, forbiddenField),
    false,
    `${forbiddenField} must not be present in the persisted schema`,
  );
}

const sensitivity = await verifySensitivity(
  path.join(fixtureDirectory, "invalid/unknown-environment-field.json"),
);

const gates = [];
if (process.env.E2_T01_SKIP_GATES !== "1") {
  for (const [name, command, args] of [
    ["format", "pnpm", ["format:check"]],
    ["lint", "pnpm", ["lint"]],
    ["typecheck", "pnpm", ["typecheck"]],
    ["test", "pnpm", ["test"]],
    ["build", "pnpm", ["build"]],
  ]) {
    gates.push(runGate(name, command, args));
  }
}

const summary = {
  schemaVersion: 1,
  runId,
  implementationCommit,
  result: "PASS",
  skips:
    process.env.E2_T01_SKIP_GATES === "1"
      ? ["format", "lint", "typecheck", "test", "build"]
      : [],
  canonical: {
    byteLength: encoded.length,
    canonicalUtf8: canonical,
    digest,
    mapAndUnorderedArrayParity: true,
    semanticMutationChangesDigest: true,
  },
  upgrade: {
    from: 0,
    to: 1,
    deterministic: true,
    securityDefaultsInvented: false,
  },
  refusals,
  canaries: {
    cases: canaryResults.length,
    allRejected: canaryResults.every(
      ({ code }) => code === AGENT_CONFIG_ERROR_CODES.SECRET_VALUE,
    ),
    locations: canaryResults,
  },
  schema: {
    additionalPropertiesFalse: true,
    requiredFields: schema.required,
    forbiddenFieldsAbsent: true,
  },
  sensitivity,
  gates,
};
await writeJson("verification-summary.json", summary);
await writeJson("canonical-fixtures.json", {
  schemaVersion: 1,
  v1: {
    byteLength: encoded.length,
    canonicalUtf8: canonical,
    bytesBase64: Buffer.from(encoded).toString("base64"),
    digest,
  },
  reorderedEquivalent: true,
  semanticMutationDigestChanged: true,
});
await writeJson("refusals.json", { schemaVersion: 1, refusals });
await writeJson("upgrade-matrix.json", {
  schemaVersion: 1,
  entries: [
    {
      from: 0,
      to: 1,
      deterministic: true,
      securityDefaultsInvented: false,
      digest,
    },
  ],
});
await writeJson("canary-matrix.json", {
  schemaVersion: 1,
  cases: canaryResults,
  allRejected: summary.canaries.allRejected,
});
await writeJson("sensitivity.json", sensitivity);
await writeJson("schema-summary.json", summary.schema);

console.log(
  JSON.stringify(
    {
      result: summary.result,
      runId,
      implementationCommit,
      digest,
      refusalCases: refusals.length,
      canaryCases: canaryResults.length,
      gates: gates.map(({ name, exitCode }) => ({ name, exitCode })),
      sensitivity: sensitivity.verifierDetectedMutant,
      skips: summary.skips,
    },
    null,
    2,
  ),
);

async function verifySensitivity(invalidFixturePath) {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), "stream-slack-e2-t01-mutant-"),
  );
  try {
    const modulePath = path.join(parent, "agent-config.mjs");
    const shaPath = path.join(parent, "sha256.mjs");
    const providerRegistryPath = path.join(parent, "provider-registry.mjs");
    const source = await readFile(
      path.join(root, "packages/protocol/src/agent-config.mjs"),
      "utf8",
    );
    const guard = "if (!expected.has(key)) {";
    assert.equal(source.split(guard).length - 1, 1);
    await writeFile(
      modulePath,
      source.replace(guard, "if (!expected.has(key) && false) {"),
    );
    await cp(path.join(root, "packages/protocol/src/sha256.mjs"), shaPath);
    await cp(
      path.join(root, "packages/protocol/src/provider-registry.mjs"),
      providerRegistryPath,
    );
    const probePath = path.join(parent, "probe.mjs");
    await writeFile(
      probePath,
      `import { readFile } from "node:fs/promises";\nimport { validateAgentConfig } from ${JSON.stringify(pathToFileURL(modulePath).href)};\nconst candidate = JSON.parse(await readFile(${JSON.stringify(invalidFixturePath)}, "utf8"));\nvalidateAgentConfig(candidate);\nprocess.exit(7);\n`,
    );
    const result = spawnSync(process.execPath, [probePath], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      7,
      `relaxed unknown-field validation must let the mutant accept the attack: ${result.stderr}`,
    );
    return {
      mutation: "disabled unknown-field rejection in disposable module copy",
      sourceGuardOccurrences: 1,
      mutantExitCode: result.status,
      verifierDetectedMutant: true,
      rejectedByMutant: false,
    };
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function expectRejection(callback, expectedCode, label) {
  assert.throws(
    callback,
    (error) =>
      error instanceof AgentConfigValidationError &&
      error.code === expectedCode &&
      error.path.startsWith("$.agentConfig"),
    label,
  );
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error(`${label} unexpectedly returned without a rejection`);
}

function runGate(name, command, args) {
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
    name,
    command: [command, ...args].join(" "),
    exitCode: result.status,
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filename, value) {
  await writeFile(
    path.join(evidenceDirectory, filename),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function schemaHasPropertyName(value, name) {
  if (!value || typeof value !== "object") return false;
  if (
    value.properties &&
    typeof value.properties === "object" &&
    Object.hasOwn(value.properties, name)
  ) {
    return true;
  }
  return Object.values(value).some((child) =>
    schemaHasPropertyName(child, name),
  );
}
