import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CloudflareOsClient,
  CloudflareOsSandboxProvider,
} from "@stream-slack/sandbox-cloudflare-os";
import {
  DEFAULT_NETWORK_POLICY,
  NetworkDecisionLog,
  NetworkPolicyEvaluator,
  SANDBOX_ERROR_CODES,
  classifyAddress,
  compileNetworkPolicy,
  normalizeHost,
} from "@stream-slack/sandbox";

const runId = process.env.TEST_RUN_ID ?? `e4-t05-${Date.now().toString(36)}`;
const evidence = path.resolve(
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e4-t05", runId),
);
await mkdir(evidence, { recursive: true });

const tenantId = "tenant_e4_t05";
const sandboxRunId = "rn_e4_t05_network";
const canary = "network-canary-should-not-persist";
const deploymentToken = "e4-t05-deployment-token";
const policyInput = {
  schemaVersion: 1,
  defaultEgress: "deny",
  defaultInbound: "deny",
  allow: [
    {
      id: "api-gateway",
      scheme: "https",
      host: "api.example.com",
      port: 443,
      purpose: "gateway",
      addressClasses: ["public"],
      addresses: ["203.0.113.10"],
    },
    {
      id: "redirect-gateway",
      scheme: "https",
      host: "redirect.example.com",
      port: 443,
      purpose: "gateway",
      addressClasses: ["public"],
    },
  ],
  inbound: [
    {
      id: "gatekeeper-sidecar",
      sidecarId: "sidecar_gatekeeper",
      port: 4317,
      purpose: "gatekeeper",
    },
  ],
};
const compiled = compileNetworkPolicy(policyInput);
const reordered = compileNetworkPolicy({
  ...policyInput,
  allow: [...policyInput.allow].reverse(),
  inbound: [...policyInput.inbound].reverse(),
});
assert.equal(compiled.digest, reordered.digest);
assert.equal(compileNetworkPolicy().defaultEgress, "deny");

const decisionLog = new NetworkDecisionLog();
const resolverCalls = [];
let apiResolution = {
  addresses: ["203.0.113.10"],
  aliases: ["edge.example.com"],
  generation: 1,
};
const resolve = async (host) => {
  resolverCalls.push(host);
  if (host === "api.example.com") return structuredClone(apiResolution);
  if (host === "redirect.example.com")
    return {
      addresses: ["169.254.169.254"],
      aliases: [],
      generation: 1,
    };
  return { addresses: ["203.0.113.10"], aliases: [], generation: 1 };
};
const evaluator = new NetworkPolicyEvaluator({
  policy: compiled,
  decisionLog,
});

const emptyPolicy = new NetworkPolicyEvaluator({
  policy: DEFAULT_NETWORK_POLICY,
});
const defaultDenied = await emptyPolicy.evaluateEgress({
  tenantId,
  runId: sandboxRunId,
  url: "https://api.example.com/data",
  purpose: "gateway",
  resolve,
});
assert.equal(defaultDenied.allowed, false);
assert.equal(defaultDenied.event.reasonCode, "not_allowlisted");
assert.equal(
  emptyPolicy.evaluateInbound({
    tenantId,
    runId: sandboxRunId,
    host: "127.0.0.1",
    port: 4317,
    purpose: "gatekeeper",
    sidecarId: "sidecar_gatekeeper",
  }).allowed,
  false,
);

const allowed = await evaluator.evaluateEgress({
  tenantId,
  runId: sandboxRunId,
  url: `https://api.example.com/data?canary=${canary}`,
  purpose: "gateway",
  resolve,
  headers: { authorization: `Bearer ${canary}` },
  body: canary,
  requestId: "request-allow",
});
assert.equal(allowed.allowed, true);
assert.equal(allowed.event.destination.host, "api.example.com");
assert.equal("query" in allowed.event.destination, false);
assert.equal("headers" in allowed.event, false);
assert.equal("body" in allowed.event, false);

const redirect = await evaluator.evaluateEgress({
  tenantId,
  runId: sandboxRunId,
  url: "https://api.example.com/data",
  purpose: "gateway",
  resolve,
  redirects: ["https://redirect.example.com/landing"],
  requestId: "request-redirect",
});
assert.equal(redirect.allowed, false);
assert.equal(redirect.hops, 2);
assert.equal(redirect.event.reasonCode, "metadata_denied");

apiResolution = {
  addresses: ["192.168.10.4"],
  aliases: ["edge.example.com"],
  generation: 2,
};
const rebound = await evaluator.evaluateEgress({
  tenantId,
  runId: sandboxRunId,
  url: "https://api.example.com/data",
  purpose: "gateway",
  resolve,
  requestId: "request-rebind",
});
assert.equal(rebound.allowed, false);
assert.equal(rebound.event.reasonCode, "address_class_denied");
assert.ok(
  resolverCalls.filter((host) => host === "api.example.com").length >= 3,
);

apiResolution = {
  addresses: ["203.0.113.10"],
  aliases: ["metadata.google.internal"],
  generation: 3,
};
const cnameDenied = await evaluator.evaluateEgress({
  tenantId,
  runId: sandboxRunId,
  url: "https://api.example.com/data",
  purpose: "gateway",
  resolve,
  requestId: "request-cname",
});
assert.equal(cnameDenied.allowed, false);
assert.equal(cnameDenied.event.reasonCode, "cname_denied");

const proxyDenied = await evaluator.evaluateEgress({
  tenantId,
  runId: sandboxRunId,
  url: "https://api.example.com/data",
  purpose: "gateway",
  resolve,
  proxyEnv: { HTTPS_PROXY: "http://proxy.invalid" },
  requestId: "request-proxy",
});
assert.equal(proxyDenied.allowed, false);
assert.equal(proxyDenied.event.reasonCode, "proxy_bypass_denied");

const sidecar = evaluator.evaluateInbound({
  tenantId,
  runId: sandboxRunId,
  host: "127.0.0.1",
  port: 4317,
  purpose: "gatekeeper",
  sidecarId: "sidecar_gatekeeper",
  sourceAddress: "127.0.0.1",
  requestId: "request-sidecar",
});
assert.equal(sidecar.allowed, true);
const publicInbound = evaluator.evaluateInbound({
  tenantId,
  runId: sandboxRunId,
  host: "127.0.0.1",
  port: 4317,
  purpose: "gatekeeper",
  sidecarId: "sidecar_gatekeeper",
  sourceAddress: "203.0.113.20",
  requestId: "request-public-inbound",
});
assert.equal(publicInbound.allowed, false);
assert.equal(publicInbound.event.reasonCode, "inbound_source_denied");

const encodedAddresses = [
  ["10.1.2.3", "private"],
  ["172.16.2.3", "private"],
  ["192.168.2.3", "private"],
  ["0177.0.0.1", "loopback"],
  ["0x7f000001", "loopback"],
  ["2130706433", "loopback"],
  ["169.254.1.1", "link-local"],
  ["169.254.169.254", "metadata"],
  ["100.100.100.200", "metadata"],
  ["::1", "loopback"],
  ["::ffff:127.0.0.1", "loopback"],
  ["fe80::1", "link-local"],
  ["fd00:ec2::254", "metadata"],
];
for (const [address, expectedClass] of encodedAddresses)
  assert.equal(classifyAddress(address).addressClass, expectedClass, address);
assert.equal(
  normalizeHost(new URL("http://2130706433/").hostname),
  "127.0.0.1",
);
const directSocket = await evaluator.evaluateSocket({
  tenantId,
  runId: sandboxRunId,
  host: "127.0.0.1",
  port: 80,
  purpose: "gateway",
  resolve,
});
assert.equal(directSocket.allowed, false);
assert.throws(
  () =>
    compileNetworkPolicy({
      schemaVersion: 1,
      allow: [
        {
          id: "unsafe",
          scheme: "https",
          host: "unsafe.example.com",
          port: 443,
          purpose: "gateway",
          addressClasses: ["private"],
        },
      ],
    }),
  (error) => error.code === SANDBOX_ERROR_CODES.NETWORK_POLICY_INVALID,
);

const replayLog = new NetworkDecisionLog();
for (const event of decisionLog.events()) replayLog.append(event);
assert.equal(replayLog.digest(), decisionLog.digest());
const decisionBytes = JSON.stringify(decisionLog.events());
assert.equal(decisionBytes.includes(canary), false);
assert.equal(decisionBytes.includes("authorization"), false);
assert.equal(decisionBytes.includes("query"), false);

const providerRequests = [];
let remoteResource = null;
const providerClient = new CloudflareOsClient({
  baseUrl: "http://fixture.invalid",
  token: deploymentToken,
  fetchImpl: async (url, options) => {
    const parsed = new URL(url);
    const body = options.body === undefined ? null : JSON.parse(options.body);
    providerRequests.push({ path: parsed.pathname, body });
    if (parsed.pathname === "/v1/workspaces" && options.method === "POST") {
      remoteResource = {
        workspaceId: "ws_e4_t05",
        gadgetId: "gd_e4_t05",
        labels: body.labels,
        spec: body.spec,
        state: "ready",
        fence: 1,
      };
      return jsonResponse(remoteResource);
    }
    if (options.method === "GET") return jsonResponse(remoteResource);
    if (parsed.pathname.endsWith("/network-policy")) {
      remoteResource = { ...remoteResource, fence: remoteResource.fence + 1 };
      return jsonResponse(remoteResource);
    }
    return jsonResponse(remoteResource);
  },
});
const provider = new CloudflareOsSandboxProvider({ client: providerClient });
const providerBase = {
  runId: "rn_e4_t05_provider",
  invocationDigest: `sha256:${"e".repeat(64)}`,
  expectedFence: 0,
  resourceIdentity: {
    tenantId: "tenant_e4_t05_provider",
    workspaceId: "workspace_e4_t05_provider",
    agentId: "agent_e4_t05_provider",
    invocationId: "invocation_e4_t05_provider",
    idempotencyKey: "ik_e4_t05_provider_create",
  },
  spec: { persistence: "ephemeral", requiredCapabilities: ["network-policy"] },
};
const created = await provider.create({
  ...providerBase,
  idempotencyKey: "ik_e4_t05_provider_create",
});
const createRequest = providerRequests.find(
  (request) => request.path === "/v1/workspaces",
);
assert.equal(createRequest.body.spec.networkPolicy.defaultEgress, "deny");
assert.deepEqual(createRequest.body.spec.networkPolicy.allow, []);
const configured = await provider.configureNetworkPolicy(
  {
    ...providerBase,
    idempotencyKey: "ik_e4_t05_provider_policy",
    expectedFence: created.fence,
    sandboxId: created.sandboxId,
  },
  compiled,
);
assert.equal(configured.policyDigest, compiled.digest);
const policyRequest = providerRequests.find((request) =>
  request.path.endsWith("/network-policy"),
);
assert.equal(policyRequest.body.policy.defaultEgress, "deny");
assert.equal(policyRequest.body.policy.digest, compiled.digest);
assert.equal(
  JSON.stringify(provider.events()).includes(deploymentToken),
  false,
);

await writeJson("compiled-policy.json", compiled);
await writeJson("decision-log.json", {
  digest: decisionLog.digest(),
  replayDigest: replayLog.digest(),
  events: decisionLog.events(),
});
await writeJson("adversarial-matrix.json", {
  defaultDenied: true,
  redirectRechecked: true,
  dnsRebindingDenied: true,
  cnameMetadataDenied: true,
  encodedAddressClasses: encodedAddresses,
  proxyBypassDenied: true,
  inboundDefaultDenied: true,
  sidecarOnlyInbound: true,
  canaryAbsentFromEvents: true,
});
await writeJson("provider-enforcement.json", {
  createDefaultEgress: createRequest.body.spec.networkPolicy.defaultEgress,
  createDefaultInbound: createRequest.body.spec.networkPolicy.defaultInbound,
  configuredPolicyDigest: configured.policyDigest,
  providerEventCount: provider.events().length,
  clientAudit: providerClient.audit(),
});
await writeJson("verification-summary.json", {
  schemaVersion: 1,
  task: "E4-T05",
  runId,
  result: "PASS",
  policyDigest: compiled.digest,
  decisionDigest: decisionLog.digest(),
  replayedDecisionDigest: replayLog.digest(),
  matrixCases: decisionLog.events().length,
  zeroSkips: true,
  replay:
    "Replay: N/A (sandbox network security boundary) + mitigation: cold-clone adversarial DNS matrix, deny-log replay, canary scans, and real-provider enforcement in E4-T08",
});
for (const file of await readdir(evidence)) {
  if (!file.endsWith(".json")) continue;
  const contents = await readFile(path.join(evidence, file), "utf8");
  assert.equal(contents.includes(canary), false, `${file} leaked canary`);
  assert.equal(
    contents.includes(deploymentToken),
    false,
    `${file} leaked deployment token`,
  );
  assert.equal(
    contents.includes("authorization"),
    false,
    `${file} leaked header name`,
  );
}

console.log(
  JSON.stringify(
    {
      implementationCommit: process.env.E4_T05_IMPLEMENTATION_COMMIT ?? "local",
      result: "PASS",
      runId,
      policyDigest: compiled.digest,
      decisionDigest: decisionLog.digest(),
      matrixCases: decisionLog.events().length,
    },
    null,
    2,
  ),
);

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function writeJson(name, value) {
  await writeFile(
    path.join(evidence, name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}
