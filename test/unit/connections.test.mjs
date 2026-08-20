import assert from "node:assert/strict";
import test from "node:test";

import {
  CONNECTION_ERROR_CODES,
  canonicalJson,
  canonicalSha256,
  createConnectionStore,
  normalizeConnectionDefinition,
  normalizeSecretRef,
  replayConnectionEvents,
} from "@stream-slack/connections";

const SCOPE = {
  tenantId: "tenant-alpha",
  workspaceId: "workspace-alpha",
};
const ADMIN = {
  ...SCOPE,
  id: "user-admin",
  kind: "user",
  role: "admin",
};
const MEMBER = {
  ...SCOPE,
  id: "user-member",
  kind: "user",
  role: "member",
};

test("SecretRefs accept opaque broker identifiers and reject secret-shaped input", () => {
  assert.deepEqual(normalizeSecretRef(ref(1)), {
    schemaVersion: 1,
    id: "secretref-github-001",
    provider: "infisical",
    mount: "production",
    revision: 1,
    label: "github",
  });
  const rejected = [
    { ...ref(1), token: "raw-token" },
    { ...ref(1), path: "connections/github" },
    { ...ref(1), privateKey: "-----BEGIN PRIVATE KEY-----" },
  ];
  for (const value of rejected) {
    assert.throws(
      () => normalizeSecretRef(value),
      (error) =>
        error.code === CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL ||
        error.code === CONNECTION_ERROR_CODES.INVALID_SECRET_REF,
    );
  }
});

test("connection metadata rejects encoded, URL, JSON, nested, and confusable secrets", () => {
  const attacks = [
    { metadata: { encoded: "c3VwZXItc2VjcmV0LXRva2VuLXZhbHVl" } },
    {
      metadata: {
        encodedProviderToken: Buffer.from("ghp_" + "A".repeat(32)).toString(
          "base64",
        ),
      },
    },
    { metadata: { endpoint: "https://user:password@example.invalid" } },
    { metadata: { payload: '{"token":"raw-token-value"}' } },
    { metadata: { nested: { password: "raw-password" } } },
    { metadata: { tοken: "raw-token-value" } },
  ];
  for (const attack of attacks) {
    assert.throws(
      () => definition(attack),
      (error) => error.code === CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL,
    );
  }
  assert.deepEqual(
    definition({
      label: "GitHub",
      metadata: { team: "platform", retries: 2, tags: ["issues", "read"] },
    }).metadata,
    { team: "platform", retries: 2, tags: ["issues", "read"] },
  );
});

test("create, rotate, disable, and delete produce immutable replayable lifecycle state", () => {
  const store = makeStore();
  const created = store.create({
    actor: ADMIN,
    connectionId: "connection-github",
    owner: { kind: "workspace", id: SCOPE.workspaceId },
    provider: "github",
    integration: "issues",
    label: "GitHub Issues",
    metadata: { account: "stream-slack" },
    secretRef: ref(1),
    idempotencyKey: "create-github",
  });
  const capturedBeforeRotate = store.captureForRun({
    actor: MEMBER,
    connectionId: "connection-github",
    runId: "run-first",
  });
  const rotated = store.rotate({
    actor: ADMIN,
    connectionId: "connection-github",
    expectedRevision: 1,
    secretRef: ref(2),
    idempotencyKey: "rotate-github",
  });
  const capturedAfterRotate = store.captureForRun({
    actor: MEMBER,
    connectionId: "connection-github",
    runId: "run-second",
  });
  assert.equal(created.connection.activeRevision, 1);
  assert.equal(rotated.connection.activeRevision, 2);
  assert.equal(capturedBeforeRotate.revision, 1);
  assert.equal(capturedBeforeRotate.secretRef.revision, 1);
  assert.equal(capturedAfterRotate.revision, 2);
  assert.notEqual(
    capturedBeforeRotate.bindingDigest,
    capturedAfterRotate.bindingDigest,
  );

  store.disable({
    actor: ADMIN,
    connectionId: "connection-github",
    reason: "maintenance",
    idempotencyKey: "disable-github",
  });
  assert.throws(
    () =>
      store.captureForRun({
        actor: MEMBER,
        connectionId: "connection-github",
        runId: "run-after-disable",
      }),
    (error) => error.code === CONNECTION_ERROR_CODES.NOT_ACTIVE,
  );
  store.delete({
    actor: ADMIN,
    connectionId: "connection-github",
    reason: "retired",
    idempotencyKey: "delete-github",
  });
  assert.equal(
    store.read({ actor: MEMBER, connectionId: "connection-github" }).status,
    "deleted",
  );

  const events = store.events();
  const replayed = replayConnectionEvents([...events, ...events].reverse());
  assert.equal(replayed.stateDigest, store.stateDigest());
  assert.deepEqual(replayed.connections, store.snapshot().connections);
  assert.equal(replayed.appliedEventIds.length, events.length);
});

test("rotation is revision-fenced and idempotency does not append duplicates", () => {
  const store = makeStore();
  store.create({
    actor: ADMIN,
    connectionId: "connection-github",
    owner: { kind: "workspace", id: SCOPE.workspaceId },
    provider: "github",
    integration: "issues",
    label: "GitHub Issues",
    metadata: {},
    secretRef: ref(1),
    idempotencyKey: "create-github",
  });
  const first = store.rotate({
    actor: ADMIN,
    connectionId: "connection-github",
    expectedRevision: 1,
    secretRef: ref(2),
    idempotencyKey: "rotate-github",
  });
  const replayed = store.rotate({
    actor: ADMIN,
    connectionId: "connection-github",
    expectedRevision: 1,
    secretRef: ref(2),
    idempotencyKey: "rotate-github",
  });
  assert.equal(replayed.replayed, true);
  assert.equal(store.events().length, 2);
  assert.equal(replayed.event.eventId, first.event.eventId);
  assert.throws(
    () =>
      store.rotate({
        actor: ADMIN,
        connectionId: "connection-github",
        expectedRevision: 1,
        secretRef: ref(3),
        idempotencyKey: "rotate-github",
      }),
    (error) => error.code === CONNECTION_ERROR_CODES.IDEMPOTENCY_CONFLICT,
  );
  assert.throws(
    () =>
      store.rotate({
        actor: ADMIN,
        connectionId: "connection-github",
        expectedRevision: 1,
        secretRef: ref(3),
        idempotencyKey: "rotate-again",
      }),
    (error) => error.code === CONNECTION_ERROR_CODES.REVISION_CONFLICT,
  );
});

test("workspace, agent, and user ownership have distinct authorization", () => {
  const store = makeStore();
  store.create({
    actor: ADMIN,
    connectionId: "connection-agent",
    owner: { kind: "agent", id: "agent-ada" },
    provider: "github",
    integration: "issues",
    label: "Agent GitHub",
    metadata: {},
    secretRef: ref(1),
    idempotencyKey: "create-agent",
  });
  store.create({
    actor: ADMIN,
    connectionId: "connection-user",
    owner: { kind: "user", id: "user-member" },
    provider: "github",
    integration: "issues",
    label: "User GitHub",
    metadata: {},
    secretRef: ref(1),
    idempotencyKey: "create-user",
  });
  const agent = { ...SCOPE, id: "agent-ada", kind: "agent", role: "agent" };
  assert.equal(
    store.authorization({ actor: agent, connectionId: "connection-agent" })
      .allowed,
    true,
  );
  assert.equal(
    store.authorization({ actor: MEMBER, connectionId: "connection-agent" })
      .allowed,
    false,
  );
  assert.equal(
    store.authorization({ actor: MEMBER, connectionId: "connection-user" })
      .allowed,
    true,
  );
  assert.equal(
    store.authorization({
      actor: ADMIN,
      connectionId: "connection-agent",
      action: "delete",
    }).allowed,
    true,
  );
});

test("foreign and unknown connection ids return the same not-found error without state movement", () => {
  const store = makeStore();
  store.create({
    actor: ADMIN,
    connectionId: "connection-private",
    owner: { kind: "workspace", id: SCOPE.workspaceId },
    provider: "github",
    integration: "issues",
    label: "Private",
    metadata: {},
    secretRef: ref(1),
    idempotencyKey: "create-private",
  });
  const before = store.stateDigest();
  const foreign = {
    ...ADMIN,
    tenantId: "tenant-foreign",
    workspaceId: "workspace-foreign",
  };
  let foreignError;
  let unknownError;
  try {
    store.read({ actor: foreign, connectionId: "connection-private" });
  } catch (error) {
    foreignError = error;
  }
  try {
    store.read({ actor: foreign, connectionId: "connection-unknown" });
  } catch (error) {
    unknownError = error;
  }
  assert.equal(foreignError.code, CONNECTION_ERROR_CODES.NOT_FOUND);
  assert.equal(unknownError.code, CONNECTION_ERROR_CODES.NOT_FOUND);
  assert.deepEqual(foreignError.toJSON(), unknownError.toJSON());
  assert.equal(store.stateDigest(), before);
});

test("canonical event and state digests are stable across object insertion order", () => {
  const left = { z: 1, nested: { b: true, a: "x" }, a: 2 };
  const right = { a: 2, nested: { a: "x", b: true }, z: 1 };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(canonicalSha256(left), canonicalSha256(right));
});

function makeStore() {
  let now = Date.parse("2026-08-19T17:00:00.000Z");
  return createConnectionStore({
    ...SCOPE,
    clock: () => new Date((now += 1000)),
  });
}

function ref(revision) {
  return {
    schemaVersion: 1,
    id: "secretref-github-" + String(revision).padStart(3, "0"),
    provider: "infisical",
    mount: "production",
    revision,
    label: "github",
  };
}

function definition(overrides = {}) {
  return normalizeConnectionDefinition({
    connectionId: "connection-github",
    tenantId: SCOPE.tenantId,
    workspaceId: SCOPE.workspaceId,
    owner: { kind: "workspace", id: SCOPE.workspaceId },
    provider: "github",
    integration: "issues",
    label: "GitHub",
    metadata: {},
    secretRef: ref(1),
    ...overrides,
  });
}
