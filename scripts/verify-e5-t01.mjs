import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CREDENTIAL_BROKER_ERROR_CODES,
  createAgentVaultAdapter,
  createCredentialBroker,
  createInfisicalAgentProxyAdapter,
  sha256,
} from "@stream-slack/credential-broker";

const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-5-the-switchboard/E5-T01-credential-broker-contract",
);
const runId =
  process.env.TEST_RUN_ID ??
  `e5-t01-cold-${process.pid}-${Date.now().toString(36)}`;
const promoteEvidence = process.env.PROMOTE_EVIDENCE === "1";
const evidenceDirectory = path.resolve(
  root,
  promoteEvidence
    ? path.join(taskDirectory, "evidence/e5-t01-final")
    : (process.env.TEST_ARTIFACT_DIR ??
        path.join(".artifacts", "e5-t01", runId)),
);
const implementationCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();

await mkdir(evidenceDirectory, { recursive: true });
const first = await replayFixture("first");
const second = await replayFixture("second");
assert.equal(first.stateDigest, second.stateDigest);
assert.equal(first.auditDigest, second.auditDigest);
assert.deepEqual(first.publicSnapshot, second.publicSnapshot);

const modeRefusals = runProviderModeRefusals();
const sensitivity = await runSensitivityFixture();
const evidenceSensitivity = await runEvidenceSensitivityFixture();
const sensitivityEvidence = {
  ...sensitivity,
  evidenceCanary: evidenceSensitivity,
};
const replayEvidence = {
  schemaVersion: 1,
  task: "E5-T01",
  runId,
  implementationCommit,
  replays: [first.redacted, second.redacted],
  parity: {
    stateDigestEqual: first.stateDigest === second.stateDigest,
    auditDigestEqual: first.auditDigest === second.auditDigest,
    publicSnapshotEqual:
      JSON.stringify(first.publicSnapshot) ===
      JSON.stringify(second.publicSnapshot),
  },
};

await writeJson("broker-state.json", first.publicSnapshot);
await writeJson("audit-events.json", first.auditEvents);
await writeJson("replay-digests.json", replayEvidence);
await writeJson("provider-mode-refusals.json", modeRefusals);
await writeJson("sensitivity.json", sensitivityEvidence);
await writeJson("cold-clone-transcript.json", {
  schemaVersion: 1,
  task: "E5-T01",
  runId,
  implementationCommit,
  entrypoint: process.env.E5_T01_ENTRYPOINT ?? "make verify-E5-T01",
  result: "PASS",
  gates: [
    "two fresh Agent Vault brokers",
    "issue/use/revoke replay",
    "provider-mode refusals",
    "tamper sensitivity",
  ],
  replay:
    "Replay: N/A (headless credential broker) + mitigation: cold-clone state replay, canary scans, provider-mode refusal fixtures, and gated real Infisical Agent Proxy transcript",
});

const scan = await scanEvidence();
await writeJson("canary-scan.json", scan);
assert.equal(scan.leaked, false);
await writeJson("verification-summary.json", {
  schemaVersion: 1,
  task: "E5-T01",
  runId,
  implementationCommit,
  result: "PASS",
  stateDigest: first.stateDigest,
  auditDigest: first.auditDigest,
  replayParity: replayEvidence.parity,
  providerModeRefusals: modeRefusals,
  sensitivity: sensitivityEvidence,
  canaryScan: { leaked: false, filesChecked: [] },
  replay:
    "Replay: N/A (headless credential broker) + mitigation: cold-clone state replay, canary scans, provider-mode refusal fixtures, and gated real Infisical Agent Proxy transcript",
});

const finalScan = await scanEvidence();
await writeJson("canary-scan.json", finalScan);
assert.equal(finalScan.leaked, false);
await writeJson("verification-summary.json", {
  schemaVersion: 1,
  task: "E5-T01",
  runId,
  implementationCommit,
  result: "PASS",
  stateDigest: first.stateDigest,
  auditDigest: first.auditDigest,
  replayParity: replayEvidence.parity,
  providerModeRefusals: modeRefusals,
  sensitivity: sensitivityEvidence,
  canaryScan: {
    leaked: finalScan.leaked,
    filesChecked: finalScan.filesChecked,
    environmentKeyCount: finalScan.environmentKeyCount,
  },
  replay:
    "Replay: N/A (headless credential broker) + mitigation: cold-clone state replay, canary scans, provider-mode refusal fixtures, and gated real Infisical Agent Proxy transcript",
});

console.log(
  JSON.stringify(
    {
      implementationCommit,
      result: "PASS",
      runId,
      stateDigest: first.stateDigest,
      auditDigest: first.auditDigest,
      replayParity: replayEvidence.parity,
      evidenceDirectory,
    },
    null,
    2,
  ),
);

async function replayFixture(label) {
  const canary = ["e5", "t01", "local", "canary"].join("-");
  const secretRef = {
    tenantId: "tenant-alpha",
    workspaceId: "workspace-alpha",
    environment: "test",
    path: "connections/github",
    key: "github-pat",
    version: "v1",
  };
  const binding = {
    tenantId: secretRef.tenantId,
    workspaceId: secretRef.workspaceId,
    agentId: "agent-ada",
    runId: "run-e5-t01-0000000000000000000000000001",
    connectionId: "connection-github",
    operation: "github.issue.read",
    requestDigest: sha256({
      method: "GET",
      url: "https://api.github.com/issues",
    }),
  };
  const ids = sequentialIds();
  const fixedTime = () => new Date("2026-08-19T17:00:00.000Z");
  const provider = createAgentVaultAdapter({
    secrets: [{ secretRef, value: canary }],
    idFactory: ids.next,
    now: () => Date.parse("2026-08-19T17:00:00.000Z"),
  });
  const broker = createCredentialBroker({
    provider,
    environment: "test",
    clock: fixedTime,
    idFactory: ids.next,
  });
  const issued = await broker.issue({ secretRef, binding });
  let consumerObserved = false;
  const used = await broker.use(issued.capability, {
    requestDigest: binding.requestDigest,
    consumer(secret) {
      consumerObserved = secret === canary;
      return { accepted: consumerObserved };
    },
  });
  let liveReplayCode = null;
  try {
    await broker.use(issued.capability, {
      requestDigest: binding.requestDigest,
      consumer: () => ({ accepted: true }),
    });
  } catch (error) {
    liveReplayCode = error.code;
  }
  const revoked = await broker.revoke(issued.capability, {
    reason: "run-finished",
  });
  let secondUseCode = null;
  try {
    await broker.use(issued.capability, {
      requestDigest: binding.requestDigest,
      consumer: () => ({ accepted: true }),
    });
  } catch (error) {
    secondUseCode = error.code;
  }
  assert.equal(consumerObserved, true);
  assert.equal(used.outcome.accepted, true);
  assert.equal(
    liveReplayCode,
    CREDENTIAL_BROKER_ERROR_CODES.CAPABILITY_REPLAYED,
  );
  assert.equal(revoked.revoked, true);
  assert.equal(secondUseCode, CREDENTIAL_BROKER_ERROR_CODES.CAPABILITY_REVOKED);

  const publicSnapshot = broker.snapshot();
  const auditEvents = broker.auditEvents();
  const redacted = {
    label,
    provider: broker.providerHandshake(),
    capability: broker.summarizeCapability(issued.capability),
    useAccepted: used.outcome.accepted,
    liveReplayCode,
    revokeConfirmed: revoked.revoked,
    secondUseCode,
    consumerObserved,
    publicSnapshot,
  };
  const serialized = JSON.stringify({ redacted, auditEvents });
  assert.equal(serialized.includes(canary), false);
  return {
    stateDigest: broker.stateDigest(),
    auditDigest: broker.auditDigest(),
    publicSnapshot,
    auditEvents,
    redacted,
  };
}

function runProviderModeRefusals() {
  const local = createAgentVaultAdapter({
    secrets: [
      {
        secretRef: {
          tenantId: "tenant-alpha",
          workspaceId: "workspace-alpha",
          environment: "test",
          path: "connections/github",
          key: "github-pat",
        },
        value: "fixture-only",
      },
    ],
  });
  const refusals = [];
  try {
    createCredentialBroker({ provider: local, environment: "production" });
  } catch (error) {
    refusals.push({
      attack: "agent-vault-in-production",
      code: error.code,
    });
  }
  try {
    createInfisicalAgentProxyAdapter({
      endpoint: "https://proxy.example.test",
      fetchFn: async () => {},
      attestation: {
        schemaVersion: 1,
        providerId: "infisical-caching-proxy",
        mode: "production",
        protocolVersion: "wrong.v1",
        attested: true,
        nonProduction: false,
        attestationId: "wrong-provider",
      },
    });
  } catch (error) {
    refusals.push({
      attack: "ordinary-caching-proxy",
      code: error.code,
    });
  }
  try {
    createCredentialBroker({ provider: {}, environment: "production" });
  } catch (error) {
    refusals.push({
      attack: "generic-token-client-without-handshake",
      code: error.code,
    });
  }
  assert.deepEqual(
    refusals.map(({ code }) => code),
    [
      CREDENTIAL_BROKER_ERROR_CODES.LOCAL_PROVIDER_IN_PRODUCTION,
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_UNSUPPORTED,
      CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_HANDSHAKE_REQUIRED,
    ],
  );
  return { refusals };
}

async function runSensitivityFixture() {
  const canary = "sensitivity-canary";
  const secretRef = {
    tenantId: "tenant-alpha",
    workspaceId: "workspace-alpha",
    environment: "test",
    path: "connections/github",
    key: "github-pat",
  };
  const binding = {
    tenantId: "tenant-alpha",
    workspaceId: "workspace-alpha",
    agentId: "agent-ada",
    runId: "run-sensitivity-000000000000000000000001",
    connectionId: "connection-github",
    operation: "github.issue.read",
    requestDigest: sha256("sensitivity-request"),
  };
  const provider = createAgentVaultAdapter({
    secrets: [{ secretRef, value: canary }],
    now: () => Date.parse("2026-08-19T17:00:00.000Z"),
  });
  const broker = createCredentialBroker({
    provider,
    environment: "test",
    clock: () => new Date("2026-08-19T17:00:00.000Z"),
  });
  const issued = await broker.issue({ secretRef, binding });
  const findings = [];
  for (const [attack, input] of [
    ["changed-binding", { binding: { ...binding, runId: "run-other" } }],
    ["changed-request", { requestDigest: sha256("other-request") }],
  ]) {
    try {
      await broker.use(issued.capability, {
        ...input,
        requestDigest: input.requestDigest ?? binding.requestDigest,
        consumer: () => ({ accepted: true }),
      });
    } catch (error) {
      findings.push({ attack, code: error.code });
    }
  }
  assert.deepEqual(
    findings.map(({ code }) => code),
    [
      CREDENTIAL_BROKER_ERROR_CODES.CAPABILITY_BINDING_MISMATCH,
      CREDENTIAL_BROKER_ERROR_CODES.CAPABILITY_REQUEST_MISMATCH,
    ],
  );
  await broker.use(issued.capability, {
    requestDigest: binding.requestDigest,
    consumer: () => ({ accepted: true }),
  });
  try {
    await broker.use(issued.capability, {
      requestDigest: binding.requestDigest,
      consumer: () => ({ accepted: true }),
    });
  } catch (error) {
    findings.push({ attack: "live-replay", code: error.code });
  }
  assert.equal(
    findings.at(-1)?.code,
    CREDENTIAL_BROKER_ERROR_CODES.CAPABILITY_REPLAYED,
  );
  return { findings };
}

async function writeJson(filename, value) {
  await writeFile(
    path.join(evidenceDirectory, filename),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

async function scanEvidence() {
  const files = await listEvidenceFiles(evidenceDirectory);
  const patterns = [
    /-----BEGIN [^-]*PRIVATE KEY-----/iu,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
    /\b(?:api[_-]?key|client[_-]?secret|password|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/iu,
    /(?:e5-local-canary-value|sensitivity-canary|e5-t01-local-canary)/u,
    /\b(?:[A-Za-z0-9][A-Za-z0-9._-]{2,}[-_]canary(?:[-_][A-Za-z0-9._-]+)*|canary[-_](?!scan(?:\.|$))[A-Za-z0-9._-]{2,})\b/iu,
  ];
  const findings = [];
  for (const filename of files) {
    const content = await readFile(filename, "utf8");
    for (const [rule, pattern] of patterns.entries()) {
      if (pattern.test(content)) findings.push({ filename, rule });
    }
  }
  const environmentKeyCount = Object.keys(process.env).length;
  for (const [key, value] of Object.entries(process.env)) {
    for (const [rule, pattern] of patterns.entries()) {
      if (pattern.test(value ?? ""))
        findings.push({ environmentKey: key, rule });
    }
  }
  return {
    schemaVersion: 1,
    filesChecked: files
      .map((file) => path.relative(evidenceDirectory, file))
      .sort(),
    environmentKeyCount,
    findings,
    leaked: findings.length > 0,
  };
}

async function runEvidenceSensitivityFixture() {
  const filename = ".e5-t01-independent-canary.txt";
  const file = path.join(evidenceDirectory, filename);
  await writeFile(file, "critic-independent-canary-value\n");
  try {
    const scan = await scanEvidence();
    assert.equal(scan.leaked, true);
    assert.equal(
      scan.findings.some((finding) => finding.filename === file),
      true,
    );
    return { detected: true, findingCount: scan.findings.length };
  } finally {
    await unlink(file);
  }
}

async function listEvidenceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listEvidenceFiles(fullPath)));
    else files.push(fullPath);
  }
  return files;
}

function sequentialIds() {
  let count = 0;
  return {
    next(kind) {
      count += 1;
      return `${kind}-${String(count).padStart(32, "0")}`;
    },
  };
}
