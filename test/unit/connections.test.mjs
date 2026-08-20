import assert from "node:assert/strict";
import test from "node:test";

import {
  CONNECTION_ERROR_CODES,
  canonicalJson,
  canonicalSha256,
  createConnectionStore,
  normalizeConnectionDefinition,
  normalizeConnectionEvent,
  normalizeOpaqueIdForStore,
  normalizeOwner,
  normalizePrincipal,
  normalizeReason,
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
  const shortUrlSafeBase64 = "a".repeat(21) + "-a";
  const zeroWidthUrlSafeBase64 =
    "a".repeat(10) + "\u200b" + "a".repeat(11) + "-a";
  const attacks = [
    { metadata: { encoded: "c3VwZXItc2VjcmV0LXRva2VuLXZhbHVl" } },
    {
      metadata: {
        encodedValue: Buffer.from("ghp_" + "A".repeat(32)).toString("base64"),
      },
    },
    {
      metadata: {
        encodedUrlSafe: Buffer.from([
          251, 255, 239, 250, 222, 173, 190, 239, 251, 255, 239, 250, 222, 173,
          190, 239, 251, 255, 239,
        ]).toString("base64url"),
      },
    },
    { metadata: { encodedUrlSafeShort: shortUrlSafeBase64 } },
    {
      metadata: {
        encodedUrlSafeWhitespace: "  " + shortUrlSafeBase64 + "  ",
      },
    },
    { metadata: { encodedUrlSafeZeroWidth: zeroWidthUrlSafeBase64 } },
    { metadata: { encodedValue: "ghp_" + "A".repeat(32) } },
    { metadata: { endpoint: "https://user:password@example.invalid" } },
    { metadata: { assignment: "client-secret=raw-client-secret" } },
    { metadata: { assignment: "prefix-client-secret=raw-client-secret" } },
    { metadata: { assignment: "prefix_client_secret=raw-client-secret" } },
    { metadata: { assignment: "client%2Dsecret=raw-client-secret" } },
    { metadata: { assignment: "client%252Dsecret%253Draw-client-secret" } },
    { metadata: { payload: '{"token":"raw-token-value"}' } },
    { metadata: { escapedPayload: '{"\\u0074oken":"raw-token-value"}' } },
    { metadata: { percentPayload: '{"%74oken":"raw-token-value"}' } },
    { metadata: { doublePercentPayload: '{"%2574oken":"raw-token-value"}' } },
    {
      metadata: {
        fullyPercentPayload: "%7B%22token%22%3A%22raw-token-value%22%7D",
      },
    },
    {
      metadata: {
        doubleFullyPercentPayload:
          "%257B%2522token%2522%253A%2522raw-token-value%2522%257D",
      },
    },
    {
      metadata: {
        mixedFullyPercentPayload: "%7B%22%74oken%22%3A%22raw-token-value%22%7D",
      },
    },
    {
      metadata: {
        doubleMixedClientSecretPayload:
          "%7B%2522%2563lient%255Fsecre%2574%2522%253A%2522raw%2522%257D",
      },
    },
    {
      metadata: {
        doubleMixedAssignment:
          "cl%2569ent-%2573ecre%2574%253Draw-client-secret",
      },
    },
    {
      metadata: {
        doubleMixedPrefixedAssignment:
          "prefix-%2563lient%255Fsecre%2574%253Draw-client-secret",
      },
    },
    { metadata: { endpoint: "h%74tps%3A%2F%2Fexample.invalid" } },
    {
      metadata: {
        doubleMixedEndpoint:
          "%2568%2574tps%253A%252F%252Fexample.invalid%252Fservice",
      },
    },
    { metadata: { encodedProvider: "g%68p%5F" + "A".repeat(16) } },
    {
      metadata: {
        doubleMixedProvider: "%2567%2568p%255FAAAAAAAAAAAAAAAA",
      },
    },
    {
      metadata: {
        percentPrivateKey:
          "%2D%2D%2D%2D%2DBEGIN%20PRIVATE%20KEY%2D%2D%2D%2D%2D",
      },
    },
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

test("connection metadata enforces the public nesting boundary", () => {
  const tooDeep = {
    level1: {
      level2: {
        level3: {
          level4: {
            level5: "value",
          },
        },
      },
    },
  };
  assert.throws(
    () => definition({ metadata: tooDeep }),
    (error) => error.code === CONNECTION_ERROR_CODES.INVALID_REQUEST,
  );
  assert.deepEqual(
    definition({
      metadata: {
        level1: {
          level2: {
            level3: {
              level4: {},
            },
          },
        },
      },
    }).metadata,
    {
      level1: {
        level2: {
          level3: {
            level4: {},
          },
        },
      },
    },
  );
});

test("connection metadata resource bounds match Unicode schema semantics", () => {
  const tooWide = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => ["key" + index, index]),
  );
  assert.throws(
    () => definition({ metadata: tooWide }),
    (error) => error.code === CONNECTION_ERROR_CODES.INVALID_REQUEST,
  );

  const astralMetadata = { label: "🧪".repeat(512) };
  assert.deepEqual(
    definition({ metadata: astralMetadata }).metadata,
    astralMetadata,
  );
  assert.throws(
    () => definition({ metadata: { label: "🧪".repeat(513) } }),
    (error) => error.code === CONNECTION_ERROR_CODES.INVALID_REQUEST,
  );
  assert.equal(normalizeReason("🧪".repeat(160)), "🧪".repeat(160));
  assert.throws(
    () => normalizeReason("🧪".repeat(161)),
    (error) => error.code === CONNECTION_ERROR_CODES.INVALID_REQUEST,
  );
});

test("event boundaries reject credential-shaped opaque identifiers", () => {
  assert.throws(
    () =>
      normalizeConnectionEvent({
        schemaVersion: 1,
        eventId: "ghp-" + "a".repeat(32),
        eventType: "connection.created",
        workspaceId: SCOPE.workspaceId,
        actorId: ADMIN.id,
        idempotencyKey: "event-boundary-create",
        sequence: 1,
        serverTimestamp: "2026-08-19T17:00:00.000Z",
        connectionId: "connection-event-boundary",
        data: {
          connectionId: "connection-event-boundary",
          tenantId: SCOPE.tenantId,
          workspaceId: SCOPE.workspaceId,
          owner: { kind: "workspace", id: SCOPE.workspaceId },
          provider: "github",
          integration: "issues",
          label: "Event boundary",
          metadata: {},
          secretRef: ref(1),
          revision: 1,
        },
      }),
    (error) => error.code === CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL,
  );
});

test("runtime identifier APIs reject provider-token-shaped values", () => {
  const providerToken = "ghp_" + "a".repeat(32);
  assert.throws(
    () => normalizeOpaqueIdForStore(providerToken, "$.runId"),
    (error) => error.code === CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL,
  );
  assert.equal(
    normalizeOpaqueIdForStore("connection-final-lifecycle", "$.runId"),
    "connection-final-lifecycle",
  );
  assert.throws(
    () => normalizeReason("a".repeat(21) + "-a"),
    (error) => error.code === CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL,
  );
  assert.throws(
    () => normalizeReason("  " + "a".repeat(21) + "-a  "),
    (error) => error.code === CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL,
  );
  assert.throws(
    () => normalizeReason("a".repeat(10) + "\u200b" + "a".repeat(11) + "-a"),
    (error) => error.code === CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL,
  );
  assert.throws(
    () => definition({ label: "  " + "a".repeat(21) + "-a  " }),
    (error) => error.code === CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL,
  );
  assert.throws(
    () =>
      definition({
        label: "a".repeat(10) + "\u200b" + "a".repeat(11) + "-a",
      }),
    (error) => error.code === CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL,
  );
  assert.throws(
    () =>
      normalizePrincipal({
        ...SCOPE,
        id: providerToken,
        kind: "user",
        role: "admin",
      }),
    (error) => error.code === CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL,
  );
  assert.throws(
    () =>
      normalizePrincipal({
        ...ADMIN,
        capabilities: [providerToken],
      }),
    (error) => error.code === CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL,
  );
  assert.throws(
    () => normalizeOwner({ kind: "workspace", id: providerToken }),
    (error) => error.code === CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL,
  );
  const store = makeStore();
  store.create({
    actor: ADMIN,
    connectionId: "connection-api-identifier",
    owner: { kind: "workspace", id: SCOPE.workspaceId },
    provider: "github",
    integration: "issues",
    label: "API identifier",
    metadata: {},
    secretRef: ref(1),
    idempotencyKey: "create-api-identifier",
  });
  assert.throws(
    () =>
      store.captureForRun({
        actor: ADMIN,
        connectionId: "connection-api-identifier",
        runId: providerToken,
      }),
    (error) => error.code === CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL,
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
  const capturedSameRunAfterRotate = store.captureForRun({
    actor: MEMBER,
    connectionId: "connection-github",
    runId: "run-first",
  });
  assert.equal(created.connection.activeRevision, 1);
  assert.equal(rotated.connection.activeRevision, 2);
  assert.equal(capturedBeforeRotate.revision, 1);
  assert.equal(capturedBeforeRotate.secretRef.revision, 1);
  assert.equal(capturedAfterRotate.revision, 2);
  assert.equal(capturedSameRunAfterRotate.revision, 1);
  assert.equal(
    capturedSameRunAfterRotate.bindingDigest,
    capturedBeforeRotate.bindingDigest,
  );
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

test("capture bindings distinguish delimiter-containing connection and run ids", () => {
  const store = makeStore();
  for (const [connectionId, idempotencyKey] of [
    ["connection-critic-a:b", "create-critic-a-b"],
    ["connection-critic-a", "create-critic-a"],
  ]) {
    store.create({
      actor: ADMIN,
      connectionId,
      owner: { kind: "workspace", id: SCOPE.workspaceId },
      provider: "github",
      integration: "issues",
      label: "Collision test",
      metadata: {},
      secretRef: ref(1),
      idempotencyKey,
    });
  }
  const first = store.captureForRun({
    actor: MEMBER,
    connectionId: "connection-critic-a:b",
    runId: "run-critic-c",
  });
  const second = store.captureForRun({
    actor: MEMBER,
    connectionId: "connection-critic-a",
    runId: "b:run-critic-c",
  });
  assert.equal(first.connectionId, "connection-critic-a:b");
  assert.equal(first.runId, "run-critic-c");
  assert.equal(second.connectionId, "connection-critic-a");
  assert.equal(second.runId, "b:run-critic-c");
  assert.notEqual(first.bindingDigest, second.bindingDigest);
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
