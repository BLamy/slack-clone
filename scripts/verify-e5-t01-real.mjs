import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CREDENTIAL_BROKER_ERROR_CODES,
  createCredentialBroker,
  createInfisicalAgentProxyAdapter,
} from "@stream-slack/credential-broker";

const root = path.resolve(import.meta.dirname, "..");
const runId =
  process.env.TEST_RUN_ID ?? `e5-t01-real-${Date.now().toString(36)}`;
const evidenceDirectory = path.resolve(
  root,
  process.env.TEST_ARTIFACT_DIR ??
    path.join(".artifacts", "e5-t01-real", runId),
);
const required = [
  "INFISICAL_AGENT_PROXY_URL",
  "INFISICAL_AGENT_PROXY_AUTH_TOKEN",
  "INFISICAL_AGENT_PROXY_ATTESTATION_JSON",
  "INFISICAL_AGENT_PROXY_ATTESTATION_PUBLIC_KEY",
  "E5_T01_TENANT_ID",
  "E5_T01_WORKSPACE_ID",
  "E5_T01_AGENT_ID",
  "E5_T01_RUN_ID",
  "E5_T01_CONNECTION_ID",
  "E5_T01_REQUEST_DIGEST",
  "E5_T01_SECRET_REF_JSON",
  "E5_T01_CANARY_CONSUMER_URL",
];

await mkdir(evidenceDirectory, { recursive: true });
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  await writeJson("skipped.json", {
    schemaVersion: 1,
    task: "E5-T01",
    runId,
    result: "SKIPPED",
    missing,
    fallbackUsed: false,
    replay:
      "Replay: N/A (headless credential broker) + mitigation: cold-clone state replay, canary scans, provider-mode refusal fixtures, and gated real Infisical Agent Proxy transcript",
  });
  console.error(
    `SKIPPED: missing explicit Infisical Agent Proxy configuration: ${missing.join(", ")}`,
  );
  process.exitCode = 2;
} else {
  await runRealGate();
}

async function runRealGate() {
  let secretRef;
  try {
    secretRef = JSON.parse(process.env.E5_T01_SECRET_REF_JSON);
  } catch {
    throw new Error("E5_T01_SECRET_REF_JSON must be valid JSON");
  }
  const binding = {
    tenantId: process.env.E5_T01_TENANT_ID,
    workspaceId: process.env.E5_T01_WORKSPACE_ID,
    agentId: process.env.E5_T01_AGENT_ID,
    runId: process.env.E5_T01_RUN_ID,
    connectionId: process.env.E5_T01_CONNECTION_ID,
    operation: process.env.E5_T01_OPERATION ?? "canary.request.execute",
    requestDigest: process.env.E5_T01_REQUEST_DIGEST,
  };
  const provider = createInfisicalAgentProxyAdapter({
    endpoint: process.env.INFISICAL_AGENT_PROXY_URL,
    authToken: process.env.INFISICAL_AGENT_PROXY_AUTH_TOKEN,
    attestation: process.env.INFISICAL_AGENT_PROXY_ATTESTATION_JSON,
    attestationPublicKey:
      process.env.INFISICAL_AGENT_PROXY_ATTESTATION_PUBLIC_KEY,
    fetchFn: fetch,
    requestTimeoutMs: Number(process.env.E5_T01_TIMEOUT_MS ?? 15_000),
  });
  const broker = createCredentialBroker({
    provider,
    environment: "production",
  });
  const issued = await broker.issue({ secretRef, binding });
  const used = await broker.use(issued.capability, {
    requestDigest: binding.requestDigest,
    request: {
      method: process.env.E5_T01_CANARY_REQUEST_METHOD ?? "GET",
      url: process.env.E5_T01_CANARY_CONSUMER_URL,
      headers: {
        "X-Stream-Slack-Run": binding.runId,
      },
    },
  });
  assert.equal(
    used.outcome.accepted,
    true,
    "dedicated canary consumer did not accept the brokered request",
  );
  let liveReplayCode = null;
  try {
    await broker.use(issued.capability, {
      requestDigest: binding.requestDigest,
      request: {
        method: process.env.E5_T01_CANARY_REQUEST_METHOD ?? "GET",
        url: process.env.E5_T01_CANARY_CONSUMER_URL,
      },
    });
  } catch (error) {
    liveReplayCode = error.code;
  }
  assert.equal(
    liveReplayCode,
    CREDENTIAL_BROKER_ERROR_CODES.CAPABILITY_REPLAYED,
  );
  const revoked = await broker.revoke(issued.capability, {
    reason: "real-gate-complete",
  });
  assert.equal(revoked.revoked, true);
  let secondUseCode = null;
  try {
    await broker.use(issued.capability, {
      requestDigest: binding.requestDigest,
      request: {
        method: "GET",
        url: process.env.E5_T01_CANARY_CONSUMER_URL,
      },
    });
  } catch (error) {
    secondUseCode = error.code;
  }
  assert.equal(secondUseCode, CREDENTIAL_BROKER_ERROR_CODES.CAPABILITY_REVOKED);
  await writeJson("real-transcript.json", {
    schemaVersion: 1,
    task: "E5-T01",
    runId,
    result: "PASS",
    provider: broker.providerHandshake(),
    capability: broker.summarizeCapability(issued.capability),
    use: used,
    revoke: revoked,
    liveReplayCode,
    secondUseCode,
    stateDigest: broker.stateDigest(),
    auditDigest: broker.auditDigest(),
    fallbackUsed: false,
    replay:
      "Replay: N/A (headless credential broker) + mitigation: cold-clone state replay, canary scans, provider-mode refusal fixtures, and gated real Infisical Agent Proxy transcript",
  });
  const canaryScan = await scanEvidence();
  assert.equal(canaryScan.leaked, false);
  await writeJson("real-canary-scan.json", canaryScan);
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        runId,
        stateDigest: broker.stateDigest(),
        auditDigest: broker.auditDigest(),
        evidenceDirectory,
      },
      null,
      2,
    ),
  );
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
    /\b(?:[A-Za-z0-9][A-Za-z0-9._-]{2,}[-_]canary(?:[-_][A-Za-z0-9._-]+)*|canary[-_][A-Za-z0-9._-]{2,})\b/iu,
  ];
  const findings = [];
  for (const filename of files) {
    const content = await readFile(filename, "utf8");
    for (const pattern of patterns) {
      if (pattern.test(content))
        findings.push({ filename, pattern: pattern.source });
    }
  }
  const environmentKeyCount = Object.keys(process.env).length;
  for (const [key, value] of Object.entries(process.env)) {
    for (const pattern of patterns) {
      if (pattern.test(value ?? ""))
        findings.push({ environmentKey: key, pattern: pattern.source });
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
