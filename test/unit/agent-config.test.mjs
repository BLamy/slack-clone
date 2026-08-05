import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_CONFIG_ERROR_CODES,
  AgentConfigValidationError,
  agentConfigDigest,
  canonicalAgentConfig,
  encodeAgentConfig,
  upgradeAgentConfig,
  validateAgentConfig,
} from "@stream-slack/protocol";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TASK = path.join(
  ROOT,
  ".eforest/tasks/epic-2-the-roster/E2-T01-versioned-agent-config-schema",
);

test("v1 AgentConfig validates, encodes canonically, and hashes with SHA-256", async () => {
  const config = await fixture("valid/agent-config.v1.json");
  assert.equal(validateAgentConfig(config), config);

  const reordered = structuredClone(config);
  reordered.trigger.events.reverse();
  reordered.harness.requiredCapabilities.reverse();
  reordered.connectionGrants.refs.reverse();
  reordered.workspaceInputs.paths.reverse();
  assert.equal(canonicalAgentConfig(config), canonicalAgentConfig(reordered));
  assert.equal(agentConfigDigest(config), agentConfigDigest(reordered));

  const encoded = encodeAgentConfig(config);
  const expectedDigest = `sha256:${createHash("sha256")
    .update(encoded)
    .digest("hex")}`;
  assert.equal(agentConfigDigest(config), expectedDigest);
  assert.equal(new TextDecoder().decode(encoded), canonicalAgentConfig(config));

  const changed = structuredClone(config);
  changed.budgets.maxOutputTokens += 1;
  assert.notEqual(agentConfigDigest(config), agentConfigDigest(changed));
});

test("v0 upgrade maps every required policy field without permissive defaults", async () => {
  const legacy = await fixture("valid/agent-config.v0.json");
  const upgraded = upgradeAgentConfig(legacy);
  assert.equal(upgraded.schemaVersion, 1);
  validateAgentConfig(upgraded);
  assert.equal(upgraded.connectionGrants.refs.length, 2);
  assert.equal(upgraded.connectionGrants.maxCallsPerRun, 2);
  assert.deepEqual(upgraded.delegation, {
    enabled: false,
    maxDepth: 0,
    maxChildren: 0,
    allowCrossChannel: false,
  });
  assert.deepEqual(upgradeAgentConfig(legacy), upgraded);
});

test("invalid fixture corpus fails with stable typed paths and refusal codes", async () => {
  const expected = new Map([
    [
      "invalid/unknown-environment-field.json",
      AGENT_CONFIG_ERROR_CODES.FORBIDDEN_FIELD,
    ],
    [
      "invalid/secret-canary-instructions.json",
      AGENT_CONFIG_ERROR_CODES.SECRET_VALUE,
    ],
    [
      "invalid/unknown-provider.json",
      AGENT_CONFIG_ERROR_CODES.UNKNOWN_PROVIDER,
    ],
    [
      "invalid/future-schema-version.json",
      AGENT_CONFIG_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION,
    ],
    ["invalid/fractional-budget.json", AGENT_CONFIG_ERROR_CODES.INVALID_VALUE],
    [
      "invalid/contradictory-policy.json",
      AGENT_CONFIG_ERROR_CODES.CONTRADICTORY_POLICY,
    ],
    [
      "invalid/unversioned-connection.json",
      AGENT_CONFIG_ERROR_CODES.MISSING_FIELD,
    ],
    [
      "invalid/unknown-startup-command.json",
      AGENT_CONFIG_ERROR_CODES.FORBIDDEN_FIELD,
    ],
  ]);

  for (const [relativePath, code] of expected) {
    const value = await fixture(relativePath);
    assert.throws(
      () => validateAgentConfig(value),
      (error) =>
        error instanceof AgentConfigValidationError &&
        error.code === code &&
        error.path.startsWith("$.agentConfig"),
      relativePath,
    );
  }
});

test("secret-shaped canaries are refused in every persisted text location", async () => {
  const config = await fixture("valid/agent-config.v1.json");
  const mutations = [
    (value) => {
      value.instructions.system = "Bearer canary-token-123456789";
    },
    (value) => {
      value.instructions.task = "client_secret=canary-secret-123456789";
    },
    (value) => {
      value.instructions.guardrails[0] = "sk-proj-12345678901234567890";
    },
    (value) => {
      value.connectionGrants.refs = [
        {
          connectionId: "conn_github",
          grantId: "grant_read",
          purpose: "ghp_123456789012345678901234567890",
          revision: 1,
        },
      ];
      value.connectionGrants.maxCallsPerRun = 1;
    },
    (value) => {
      value.workspaceInputs.paths = ["docs/api_key=canary123456789"];
    },
  ];

  for (const mutate of mutations) {
    const candidate = structuredClone(config);
    mutate(candidate);
    assert.throws(
      () => validateAgentConfig(candidate),
      (error) => error.code === AGENT_CONFIG_ERROR_CODES.SECRET_VALUE,
    );
  }
});

test("non-enumerable and symbol fields do not cross the persistence boundary", async () => {
  const config = await fixture("valid/agent-config.v1.json");
  const withSymbol = structuredClone(config);
  withSymbol.context[Symbol("hidden")] = true;
  assert.throws(
    () => validateAgentConfig(withSymbol),
    (error) => error.code === AGENT_CONFIG_ERROR_CODES.UNKNOWN_FIELD,
  );

  const withHidden = structuredClone(config);
  Object.defineProperty(withHidden.instructions, "hidden", {
    enumerable: false,
    value: "not persisted",
  });
  assert.throws(
    () => validateAgentConfig(withHidden),
    (error) => error.code === AGENT_CONFIG_ERROR_CODES.TYPE_MISMATCH,
  );
});

async function fixture(relativePath) {
  return JSON.parse(
    await readFile(path.join(TASK, "fixtures", relativePath), "utf8"),
  );
}
