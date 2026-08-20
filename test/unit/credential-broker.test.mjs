import assert from "node:assert/strict";
import test from "node:test";

import {
  CREDENTIAL_BROKER_ERROR_CODES,
  createAgentVaultAdapter,
  createCredentialBroker,
  createInfisicalAgentProxyAdapter,
  normalizeSecretRef,
  sha256,
} from "@stream-slack/credential-broker";

const SECRET = "e5-local-canary-value";
const SECRET_REF = {
  tenantId: "tenant-alpha",
  workspaceId: "workspace-alpha",
  environment: "test",
  path: "connections/github",
  key: "github-pat",
  version: "v1",
};
const BINDING = {
  tenantId: SECRET_REF.tenantId,
  workspaceId: SECRET_REF.workspaceId,
  agentId: "agent-ada",
  runId: "run-00000000000000000000000000000001",
  connectionId: "connection-github",
  operation: "github.issue.read",
  requestDigest: sha256({
    method: "GET",
    url: "https://api.github.com/issues",
  }),
};

test("local Agent Vault issues a run-bound capability without exposing the secret", async () => {
  const { broker, secretRef, idFactory } = makeLocalBroker();
  const issued = await broker.issue({
    secretRef,
    binding: BINDING,
  });
  const seen = [];
  const result = await broker.use(issued.capability, {
    requestDigest: BINDING.requestDigest,
    consumer(secret, context) {
      seen.push({ secret, providerId: context.providerId });
      return { accepted: secret === SECRET };
    },
  });

  assert.deepEqual(seen, [
    { secret: SECRET, providerId: "infisical-agent-vault" },
  ]);
  assert.deepEqual(result.outcome, { accepted: true });
  assert.equal(Object.prototype.hasOwnProperty.call(result, "secret"), false);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(issued.receipt).includes(SECRET), false);
  assert.equal(JSON.stringify(broker.snapshot()).includes(SECRET), false);
  assert.equal(idFactory.count > 0, true);
});

test("revoke fences replay and changed request or binding", async () => {
  const { broker, secretRef } = makeLocalBroker();
  const issued = await broker.issue({ secretRef, binding: BINDING });

  await assert.rejects(
    broker.use(issued.capability, {
      binding: { ...BINDING, runId: "run-other" },
      requestDigest: BINDING.requestDigest,
      consumer: () => ({ accepted: true }),
    }),
    (error) =>
      error.code === CREDENTIAL_BROKER_ERROR_CODES.CAPABILITY_BINDING_MISMATCH,
  );
  await assert.rejects(
    broker.use(issued.capability, {
      requestDigest: sha256("changed-request"),
      consumer: () => ({ accepted: true }),
    }),
    (error) =>
      error.code === CREDENTIAL_BROKER_ERROR_CODES.CAPABILITY_REQUEST_MISMATCH,
  );

  const revoked = await broker.revoke(issued.capability, {
    reason: "run-finished",
  });
  assert.equal(revoked.revoked, true);
  assert.equal((await broker.revoke(issued.capability)).idempotent, true);
  await assert.rejects(
    broker.use(issued.capability, {
      requestDigest: BINDING.requestDigest,
      consumer: () => ({ accepted: true }),
    }),
    (error) => error.code === CREDENTIAL_BROKER_ERROR_CODES.CAPABILITY_REVOKED,
  );
});

test("production refuses Agent Vault and accepts only an attested Agent Proxy", () => {
  const provider = createAgentVaultAdapter({
    secrets: [{ secretRef: SECRET_REF, value: SECRET }],
  });
  assert.throws(
    () => createCredentialBroker({ provider, environment: "production" }),
    (error) =>
      error.code === CREDENTIAL_BROKER_ERROR_CODES.LOCAL_PROVIDER_IN_PRODUCTION,
  );

  assert.throws(
    () =>
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
          attestationId: "attestation-1",
        },
      }),
    (error) =>
      error.code === CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_UNSUPPORTED,
  );

  assert.throws(
    () =>
      createInfisicalAgentProxyAdapter({
        endpoint: "http://localhost:8080",
        fetchFn: async () => {},
        attestation: validAttestation(),
      }),
    (error) =>
      error.code === CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_ATTESTATION_INVALID,
  );

  assert.throws(
    () =>
      createInfisicalAgentProxyAdapter({
        endpoint: "https://proxy.example.test",
        attestation: validAttestation(),
      }),
    (error) =>
      error.code === CREDENTIAL_BROKER_ERROR_CODES.PROVIDER_REQUEST_FAILED,
  );
});

test("the production Agent Proxy adapter keeps provider auth and session handles internal", async () => {
  const calls = [];
  const responses = [
    {
      sessionId: "proxy-session-0000000000000000000000000001",
      operationId: "proxy-op-000000000000000000000000000001",
      expiresAt: "2026-08-19T18:00:00.000Z",
    },
    {
      accepted: true,
      status: 200,
      responseDigest: sha256("canary-consumer-response"),
      operationId: "proxy-op-000000000000000000000000000002",
    },
    {
      revoked: true,
      operationId: "proxy-op-000000000000000000000000000003",
    },
  ];
  const provider = createInfisicalAgentProxyAdapter({
    endpoint: "https://proxy.example.test",
    attestation: validAttestation(),
    authToken: "provider-auth-token-not-an-output",
    requestTimeoutMs: 1_000,
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const broker = createCredentialBroker({
    provider,
    environment: "production",
    clock: () => new Date("2026-08-19T17:00:00.000Z"),
  });
  const issued = await broker.issue({
    secretRef: SECRET_REF,
    binding: BINDING,
  });
  const used = await broker.use(issued.capability, {
    requestDigest: BINDING.requestDigest,
    request: {
      method: "GET",
      url: "https://api.github.com/issues",
      headers: { "X-Request-Trace": "e5-t01" },
    },
  });
  await broker.revoke(issued.capability);

  assert.equal(used.outcome.accepted, true);
  assert.equal(calls.length, 3);
  assert.equal(
    calls[0].init.headers.Authorization,
    "Bearer provider-auth-token-not-an-output",
  );
  assert.equal(
    JSON.stringify(broker.snapshot()).includes("provider-auth-token"),
    false,
  );
  assert.equal(
    JSON.stringify(broker.snapshot()).includes("proxy-session"),
    false,
  );
  assert.equal(Object.keys(provider).includes("issue"), false);
});

test("SecretRef rejects raw credential fields and public capability summaries omit handles", async () => {
  assert.throws(
    () => normalizeSecretRef({ ...SECRET_REF, secret: SECRET }),
    (error) => error.code === CREDENTIAL_BROKER_ERROR_CODES.INVALID_SECRET_REF,
  );
  const { broker, secretRef } = makeLocalBroker();
  const issued = await broker.issue({ secretRef, binding: BINDING });
  const summary = broker.summarizeCapability(issued.capability);
  assert.equal("token" in summary, false);
  assert.equal(JSON.stringify(summary).includes(SECRET), false);
});

function makeLocalBroker() {
  const idFactory = sequentialIdFactory();
  const provider = createAgentVaultAdapter({
    secrets: [{ secretRef: SECRET_REF, value: SECRET }],
    idFactory: idFactory.next,
    now: () => Date.parse("2026-08-19T17:00:00.000Z"),
  });
  const broker = createCredentialBroker({
    provider,
    environment: "test",
    clock: () => new Date("2026-08-19T17:00:00.000Z"),
    idFactory: idFactory.next,
  });
  return { broker, secretRef: SECRET_REF, idFactory };
}

function sequentialIdFactory() {
  let count = 0;
  return {
    get count() {
      return count;
    },
    next(kind) {
      count += 1;
      return `${kind}-${String(count).padStart(32, "0")}`;
    },
  };
}

function validAttestation() {
  return {
    schemaVersion: 1,
    providerId: "infisical-agent-proxy",
    mode: "production",
    protocolVersion: "agent-proxy.v1",
    attested: true,
    nonProduction: false,
    attestationId: "attestation-0000000000000000000000000001",
  };
}
