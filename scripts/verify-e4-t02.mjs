import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CLOUDFLARE_OS_ERROR_CODES,
  CloudflareOsClient,
  CloudflareOsSandboxProvider,
  canonical,
  resourceLabels,
} from "@stream-slack/sandbox-cloudflare-os";

const runId = process.env.TEST_RUN_ID ?? `e4-t02-${Date.now().toString(36)}`;
const evidence = path.resolve(
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e4-t02", runId),
);
await mkdir(evidence, { recursive: true });

const deploymentToken = "cf-e4-t02-contract-token";
const base = {
  runId: "rn_e4_t02_contract",
  invocationDigest: `sha256:${"c".repeat(64)}`,
  expectedFence: 0,
  resourceIdentity: {
    tenantId: "tenant_contract",
    workspaceId: "workspace_contract",
    agentId: "agent_contract",
    invocationId: "invocation_contract",
    idempotencyKey: "ik_contract_create",
  },
  spec: {
    persistence: "ephemeral",
    requiredCapabilities: ["persistence", "network-policy"],
  },
};

const fixture = createProtocolFixture({ deploymentToken });
const server = createServer(fixture.handler);
await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    resolve();
  });
});
const address = server.address();
assert(address && typeof address === "object");
const client = new CloudflareOsClient({
  baseUrl: `http://127.0.0.1:${address.port}`,
  token: deploymentToken,
  fetchImpl: globalThis.fetch,
  timeoutMs: 20,
  maxAttempts: 3,
  sleep: async () => {},
});
const provider = new CloudflareOsSandboxProvider({ client });

try {
  const createRequest = { ...base, idempotencyKey: "ik_contract_create" };
  const [created, duplicate] = await Promise.all([
    provider.create(createRequest),
    provider.create(createRequest),
  ]);
  assert.deepEqual(created, duplicate);
  assert.equal(fixture.counts.create, 2);
  assert.equal(fixture.counts.createdResources, 1);

  await assert.rejects(
    provider.create({
      ...createRequest,
      spec: { ...createRequest.spec, persistence: "persistent" },
    }),
    (error) => error.code === CLOUDFLARE_OS_ERROR_CODES.CONFLICT,
  );

  const inspected = await provider.inspect({
    ...base,
    idempotencyKey: "ik_contract_inspect",
    expectedFence: created.fence,
    sandboxId: created.sandboxId,
  });
  assert.deepEqual(inspected, created);

  const suspended = await provider.suspend({
    ...base,
    idempotencyKey: "ik_contract_suspend",
    expectedFence: created.fence,
    sandboxId: created.sandboxId,
  });
  const suspendedAgain = await provider.suspend({
    ...base,
    idempotencyKey: "ik_contract_suspend",
    expectedFence: created.fence,
    sandboxId: created.sandboxId,
  });
  assert.deepEqual(suspendedAgain, suspended);

  const resumed = await provider.resume({
    ...base,
    idempotencyKey: "ik_contract_resume",
    expectedFence: suspended.fence,
    sandboxId: created.sandboxId,
  });
  const destroyed = await provider.destroy({
    ...base,
    idempotencyKey: "ik_contract_destroy",
    expectedFence: resumed.fence,
    sandboxId: created.sandboxId,
  });
  assert.equal(destroyed.lifecycle, "destroyed");
  assert.equal(
    await provider.reconcile({
      ...base,
      idempotencyKey: "ik_contract_reconcile",
      expectedFence: destroyed.fence,
      sandboxId: created.sandboxId,
    }),
    null,
  );

  const timeoutBase = {
    ...base,
    resourceIdentity: {
      ...base.resourceIdentity,
      tenantId: "tenant_timeout",
    },
    idempotencyKey: "ik_timeout_create",
  };
  const timeoutCreated = await provider.create(timeoutBase);
  assert.equal(timeoutCreated.lifecycle, "ready");
  assert.equal(fixture.counts.acceptedTimeoutCreates, 1);
  assert.equal(fixture.counts.resourcesForLabels(timeoutBase), 1);

  const conflictBase = {
    ...base,
    resourceIdentity: {
      ...base.resourceIdentity,
      tenantId: "tenant_conflict",
    },
    idempotencyKey: "ik_conflict_create",
  };
  await assert.rejects(
    provider.create(conflictBase),
    (error) => error.code === CLOUDFLARE_OS_ERROR_CODES.CONFLICT,
  );

  for (const [tenantId, code] of [
    ["tenant_401", CLOUDFLARE_OS_ERROR_CODES.AUTHENTICATION],
    ["tenant_403", CLOUDFLARE_OS_ERROR_CODES.AUTHORIZATION],
    ["tenant_429", CLOUDFLARE_OS_ERROR_CODES.QUOTA],
    ["tenant_504", CLOUDFLARE_OS_ERROR_CODES.TIMEOUT],
    ["tenant_503", CLOUDFLARE_OS_ERROR_CODES.UNAVAILABLE],
    ["tenant_404", CLOUDFLARE_OS_ERROR_CODES.NOT_FOUND],
  ]) {
    const labels = resourceLabels({
      ...base,
      idempotencyKey: `ik_${tenantId}`,
      resourceIdentity: { ...base.resourceIdentity, tenantId },
    });
    await assert.rejects(
      client.listByLabels(labels),
      (error) =>
        error.code === code && !JSON.stringify(error).includes(deploymentToken),
    );
  }

  const digestOne = digest({
    events: provider.events(),
    audit: client.audit(),
  });
  const digestTwo = digest(
    structuredClone({ events: provider.events(), audit: client.audit() }),
  );
  assert.equal(digestOne, digestTwo);
  assert.equal(
    JSON.stringify(provider.events()).includes(deploymentToken),
    false,
  );
  assert.equal(JSON.stringify(client.audit()).includes(deploymentToken), false);
  assert.equal(
    JSON.stringify(provider.publicConfig()).includes(deploymentToken),
    false,
  );
  assert.equal(fixture.seenAuthorization, true);
  assert.equal(fixture.bodyContainsToken, false);

  await writeJson("protocol-events.json", provider.events());
  await writeJson("http-audit.json", client.audit());
  await writeJson("redaction.json", {
    deploymentIdentityUsed: fixture.seenAuthorization,
    tokenAbsentFromPublicArtifacts: true,
    tokenAbsentFromRequestBodies: !fixture.bodyContainsToken,
  });
  await writeJson("verification-summary.json", {
    schemaVersion: 1,
    task: "E4-T02",
    runId,
    result: "PASS",
    lifecycleDigest: digestOne,
    retries: fixture.counts,
    replayedTwiceWithIdenticalDigest: true,
    replay:
      "Replay: N/A (server-side Cloudflare OS control plane) + mitigation: cold-clone HTTP contract tests, redaction scans, and the gated real Cloudflare OS lifecycle transcript",
  });
  for (const file of await readdir(evidence)) {
    if (!file.endsWith(".json")) continue;
    const contents = await readFile(path.join(evidence, file), "utf8");
    assert.equal(
      contents.includes(deploymentToken),
      false,
      `${file} leaked deployment token`,
    );
    assert.equal(
      contents.includes("authorization"),
      false,
      `${file} leaked auth header`,
    );
  }
  console.log(
    JSON.stringify(
      {
        implementationCommit:
          process.env.E4_T02_IMPLEMENTATION_COMMIT ?? "local",
        result: "PASS",
        runId,
        lifecycleDigest: digestOne,
      },
      null,
      2,
    ),
  );
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

async function writeJson(name, value) {
  await writeFile(
    path.join(evidence, name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function createProtocolFixture({ deploymentToken: token }) {
  const resources = new Map();
  const counts = {
    create: 0,
    createUnavailableRetry: true,
    acceptedTimeoutCreates: 0,
    suspendUnavailableRetry: 1,
    createdResources: 0,
    resourcesForLabels: (request) => {
      const labels = resourceLabels(request);
      return [...resources.values()].filter((resource) =>
        sameLabels(resource.labels, labels),
      ).length;
    },
  };
  let seenAuthorization = false;
  let bodyContainsToken = false;

  async function handler(request, response) {
    seenAuthorization ||= request.headers.authorization === `Bearer ${token}`;
    const body = await readBody(request);
    bodyContainsToken ||= body.includes(token);
    if (request.headers.authorization !== `Bearer ${token}`) {
      return send(response, 401, { error: "auth" });
    }
    const url = new URL(request.url, "http://fixture");
    const pathParts = url.pathname.split("/").filter(Boolean);
    if (
      request.method === "GET" &&
      pathParts.length === 2 &&
      pathParts[1] === "workspaces"
    ) {
      return handleList(url, response);
    }
    if (request.method === "POST" && url.pathname === "/v1/workspaces") {
      counts.create += 1;
      const payload = JSON.parse(body);
      const labels = payload.labels;
      if (labels["stream-slack/tenant"] === "tenant_timeout") {
        const resource = ensureResource(labels, payload.spec);
        counts.acceptedTimeoutCreates += 1;
        await new Promise((resolve) => {
          setTimeout(resolve, 60);
        });
        if (!response.destroyed) send(response, 200, resource);
        return;
      }
      if (labels["stream-slack/tenant"] === "tenant_conflict") {
        return send(response, 504, { message: `Bearer ${token}` });
      }
      if (counts.createUnavailableRetry) {
        counts.createUnavailableRetry = false;
        return send(response, 503, { message: "temporary" });
      }
      return send(response, 200, ensureResource(labels, payload.spec));
    }
    if (
      pathParts.length >= 5 &&
      pathParts[0] === "v1" &&
      pathParts[1] === "workspaces" &&
      pathParts[3] === "gadgets"
    ) {
      const resource = [...resources.values()].find(
        (candidate) =>
          candidate.workspaceId === pathParts[2] &&
          candidate.gadgetId === pathParts[4],
      );
      if (!resource) return send(response, 404, { message: "missing" });
      if (request.method === "GET" && pathParts.length === 5)
        return send(response, 200, resource);
      if (request.method === "POST" && pathParts.length === 6) {
        const operation = pathParts[5];
        if (operation === "suspend" && counts.suspendUnavailableRetry === 1) {
          counts.suspendUnavailableRetry += 1;
          return send(response, 503, { message: "retry" });
        }
        if (operation === "suspend") resource.state = "suspended";
        if (operation === "resume") resource.state = "ready";
        if (operation === "cancel") resource.state = "ready";
        if (operation === "destroy") resource.state = "destroyed";
        resource.fence += 1;
        return send(response, 200, resource);
      }
    }
    return send(response, 404, { message: "unknown" });
  }

  function handleList(url, response) {
    const labels = Object.fromEntries(
      [...url.searchParams.entries()]
        .filter(([key]) => key.startsWith("label."))
        .map(([key, value]) => [key.slice("label.".length), value]),
    );
    const tenant = labels["stream-slack/tenant"];
    const failures = {
      tenant_401: 401,
      tenant_403: 403,
      tenant_429: 429,
      tenant_504: 504,
      tenant_503: 503,
      tenant_404: 404,
    };
    if (failures[tenant]) {
      return send(response, failures[tenant], {
        message: `Bearer ${token}`,
        headers: { authorization: token },
      });
    }
    if (tenant === "tenant_conflict") {
      const first = ensureResource(
        labels,
        base.spec,
        "ws_conflict_a",
        "gd_conflict_a",
      );
      const second = ensureResource(
        labels,
        base.spec,
        "ws_conflict_b",
        "gd_conflict_b",
      );
      return send(response, 200, { resources: [first, second] });
    }
    const matched = [...resources.values()].filter(
      (resource) =>
        sameLabels(resource.labels, labels) && resource.state !== "destroyed",
    );
    return send(response, 200, { resources: matched });
  }

  function ensureResource(
    labels,
    spec,
    workspaceId = `ws_${labels["stream-slack/tenant"]}`,
    gadgetId = `gd_${labels["stream-slack/tenant"]}`,
  ) {
    const key = `${workspaceId}:${gadgetId}`;
    let resource = resources.get(key);
    if (!resource) {
      resource = {
        workspaceId,
        gadgetId,
        labels: structuredClone(labels),
        spec: structuredClone(spec),
        state: "ready",
        fence: 1,
      };
      resources.set(key, resource);
      counts.createdResources += 1;
    }
    return resource;
  }

  return {
    handler,
    counts,
    get seenAuthorization() {
      return seenAuthorization;
    },
    get bodyContainsToken() {
      return bodyContainsToken;
    },
  };
}

function sameLabels(actual, expected) {
  return Object.keys(expected).every((key) => actual?.[key] === expected[key]);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response, status, payload) {
  if (response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}
