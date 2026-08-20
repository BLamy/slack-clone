import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CONNECTION_ERROR_CODES,
  canonicalSha256,
  createConnectionStore,
  normalizeConnectionEvent,
  normalizeOpaqueIdForStore,
  normalizeOwner,
  normalizePrincipal,
  normalizeSecretRef,
  replayConnectionEvents,
} from "@stream-slack/connections";

const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-5-the-switchboard/E5-T02-service-connection-secretref-model",
);
const runId =
  process.env.TEST_RUN_ID ??
  `e5-t02-cold-${process.pid}-${Date.now().toString(36)}`;
const promoteEvidence = process.env.PROMOTE_EVIDENCE === "1";
const evidenceDirectory = path.resolve(
  root,
  promoteEvidence
    ? path.join(taskDirectory, "evidence/e5-t02-final")
    : (process.env.TEST_ARTIFACT_DIR ??
        path.join(".artifacts", "e5-t02", runId)),
);
const implementationCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();

const SCOPE = Object.freeze({
  tenantId: "tenant-alpha",
  workspaceId: "workspace-alpha",
});
const ADMIN = Object.freeze({
  ...SCOPE,
  id: "user-admin",
  kind: "user",
  role: "admin",
});
const MEMBER = Object.freeze({
  ...SCOPE,
  id: "user-member",
  kind: "user",
  role: "member",
});
const CANARY_VALUES = Object.freeze([
  "e5-t02-connection-canary-value",
  "critic-independent-e5-t02-canary-value",
]);

await mkdir(evidenceDirectory, { recursive: true });

const first = lifecycleFixture("first");
const second = lifecycleFixture("second");
assert.equal(first.storeDigest, second.storeDigest);
assert.deepEqual(first.view, second.view);
assert.equal(first.replayDigest, second.replayDigest);
assert.equal(first.replayViewDigest, second.replayViewDigest);

const corpus = secretCorpusFixture();
const authz = authorizationFixture();
const captureKeyCollision = captureKeyCollisionFixture();
const apiIdentifierBoundary = apiIdentifierBoundaryFixture();
const sensitivity = {
  url: await detectorSensitivityFixture(),
  providerToken: await detectorProviderTokenSensitivityFixture(),
  base64: await detectorBase64SensitivityFixture(),
};

await writeJson("connection-state.json", first.view);
await writeJson("lifecycle-events.json", first.redactedEvents);
await writeJson("replay-digests.json", {
  schemaVersion: 1,
  task: "E5-T02",
  runId,
  implementationCommit,
  first: {
    storeDigest: first.storeDigest,
    replayDigest: first.replayDigest,
    replayViewDigest: first.replayViewDigest,
  },
  second: {
    storeDigest: second.storeDigest,
    replayDigest: second.replayDigest,
    replayViewDigest: second.replayViewDigest,
  },
  parity: {
    storeDigestEqual: first.storeDigest === second.storeDigest,
    replayDigestEqual: first.replayDigest === second.replayDigest,
    replayViewDigestEqual: first.replayViewDigest === second.replayViewDigest,
    viewEqual: JSON.stringify(first.view) === JSON.stringify(second.view),
    duplicateAndReorderedInput: true,
  },
});
await writeJson("secret-corpus.json", corpus);
await writeJson("authz-matrix.json", authz);
await writeJson("capture-key-binding.json", captureKeyCollision);
await writeJson("api-identifier-boundary.json", apiIdentifierBoundary);
await writeJson("sensitivity.json", sensitivity);
await writeJson("cold-clone-transcript.json", {
  schemaVersion: 1,
  task: "E5-T02",
  runId,
  implementationCommit,
  entrypoint: process.env.E5_T02_ENTRYPOINT ?? "make verify-E5-T02",
  result: "PASS",
  fixture: "fresh in-memory connection stream with deterministic clock",
  replay:
    "Replay: N/A (server connection model) + mitigation: cold-clone reducer replay, secret-shaped input corpus, authz matrix, and exact lifecycle digests",
});

const initialScan = await scanEvidence();
assert.equal(initialScan.leaked, false);
const evidenceSensitivity = await evidenceLeakSensitivityFixture();
await writeJson("canary-scan.json", {
  ...initialScan,
  sensitivity: evidenceSensitivity,
});
const finalScan = await scanEvidence();
assert.equal(finalScan.leaked, false);
await writeJson("canary-scan.json", {
  ...finalScan,
  sensitivity: evidenceSensitivity,
});
await writeJson("verification-summary.json", {
  schemaVersion: 1,
  task: "E5-T02",
  runId,
  implementationCommit,
  result: "PASS",
  stateDigest: first.storeDigest,
  replay: {
    digest: first.replayDigest,
    viewDigest: first.replayViewDigest,
    duplicateAndReorderedParity: true,
  },
  secretCorpus: {
    rejected: corpus.rejected,
    appendedEvents: corpus.appendedEvents,
  },
  authorization: authz.summary,
  captureKeyCollision,
  apiIdentifierBoundary,
  sensitivity,
  canaryScan: {
    leaked: finalScan.leaked,
    filesChecked: finalScan.filesChecked,
    environmentKeyCount: finalScan.environmentKeyCount,
  },
  replayEvidence:
    "Replay: N/A (server connection model) + mitigation: cold-clone reducer replay, secret-shaped input corpus, authz matrix, and exact lifecycle digests",
});

console.log(
  JSON.stringify(
    {
      implementationCommit,
      result: "PASS",
      runId,
      stateDigest: first.storeDigest,
      replayDigest: first.replayDigest,
      replayViewDigest: first.replayViewDigest,
      evidenceDirectory,
    },
    null,
    2,
  ),
);

function lifecycleFixture(label) {
  let now = Date.parse("2026-08-19T17:00:00.000Z");
  let idCounter = 0;
  const store = createConnectionStore({
    ...SCOPE,
    clock: () => new Date((now += 1000)),
    idFactory: (kind) => {
      idCounter += 1;
      return kind + "-" + String(idCounter).padStart(8, "0");
    },
  });
  const created = store.create({
    actor: ADMIN,
    connectionId: "connection-github",
    owner: { kind: "workspace", id: SCOPE.workspaceId },
    provider: "github",
    integration: "issues",
    label: "GitHub Issues",
    metadata: { account: "stream-slack", purpose: "read-issues" },
    secretRef: secretRef(1),
    idempotencyKey: "create-github",
  });
  const capturedBeforeRotate = store.captureForRun({
    actor: MEMBER,
    connectionId: "connection-github",
    runId: "run-first",
  });
  const capturedBeforeRotateBytes = JSON.stringify(capturedBeforeRotate);
  const rotated = store.rotate({
    actor: ADMIN,
    connectionId: "connection-github",
    expectedRevision: 1,
    secretRef: secretRef(2),
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
  assert.equal(JSON.stringify(capturedBeforeRotate), capturedBeforeRotateBytes);
  assert.equal(Object.isFrozen(capturedBeforeRotate), true);
  assert.equal(Object.isFrozen(capturedBeforeRotate.secretRef), true);

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
  const view = store.read({
    actor: MEMBER,
    connectionId: "connection-github",
  });
  assert.equal(view.status, "deleted");
  assert.equal(view.tombstone.reason, "retired");
  assert.equal(view.tombstone.eventId, store.events().at(-1).eventId);

  const events = store.events();
  const duplicatedReorderedEvents = [...events, ...events].reverse();
  const replay = replayConnectionEvents(duplicatedReorderedEvents);
  const replayAgain = replayConnectionEvents(duplicatedReorderedEvents);
  assert.equal(replay.stateDigest, store.stateDigest());
  assert.deepEqual(replay.connections, store.snapshot().connections);
  assert.equal(replay.stateDigest, replayAgain.stateDigest);
  assert.equal(replay.eventDigest, replayAgain.eventDigest);
  assert.deepEqual(replay.connections, replayAgain.connections);

  return {
    label,
    storeDigest: store.stateDigest(),
    replayDigest: replay.stateDigest,
    replayViewDigest: canonicalSha256(replay.connections),
    view: replay.connections,
    redactedEvents: events.map((event) => ({
      eventId: event.eventId,
      eventType: event.eventType,
      workspaceId: event.workspaceId,
      actorId: event.actorId,
      idempotencyKey: event.idempotencyKey,
      sequence: event.sequence,
      serverTimestamp: event.serverTimestamp,
      connectionId: event.connectionId,
      secretRefRevision:
        event.data.secretRef?.revision ?? event.data.revision ?? null,
      secretRefId: event.data.secretRef?.id ?? null,
      statusChange: event.eventType,
    })),
  };
}

function secretCorpusFixture() {
  const attacks = [
    ["base64", { encoded: "c3VwZXItc2VjcmV0LXRva2VuLXZhbHVl" }],
    [
      "base64-provider-token",
      {
        encodedValue: Buffer.from("ghp_" + "A".repeat(32)).toString("base64"),
      },
    ],
    [
      "base64url",
      {
        encodedUrlSafe: Buffer.from([
          251, 255, 239, 250, 222, 173, 190, 239, 251, 255, 239, 250, 222, 173,
          190, 239, 251, 255, 239,
        ]).toString("base64url"),
      },
    ],
    ["base64url-short", { encodedUrlSafe: "a".repeat(21) + "-a" }],
    ["provider-token", { encodedValue: "ghp_" + "A".repeat(32) }],
    ["json", { payload: '{"token":"e5-t02-connection-canary-value"}' }],
    ["url", { endpoint: "https://user:password@example.invalid/service" }],
    [
      "multiline-private-key",
      {
        material:
          "-----BEGIN RSA PRIVATE KEY-----\nredacted\n-----END RSA PRIVATE KEY-----",
      },
    ],
    ["unicode-confusable-key", { tοken: "redacted-token-value" }],
    ["nested-cookie", { nested: { headers: { cookie: "session=redacted" } } }],
    [
      "connection-string",
      { dsn: "host=db.example.invalid;user=app;password=redacted" },
    ],
    ["private-key-field", { privateKey: "redacted-key-value" }],
    ["authorization-field", { authorization: "Bearer redacted-token-value" }],
  ];
  const rejected = [];
  let store = makeStore();
  for (const [name, metadata] of attacks) {
    const before = store.events().length;
    let error;
    try {
      store.create({
        actor: ADMIN,
        connectionId: "c-" + name.slice(0, 18),
        owner: { kind: "workspace", id: SCOPE.workspaceId },
        provider: "github",
        integration: "issues",
        label: "Rejected attack",
        metadata,
        secretRef: secretRef(1),
        idempotencyKey: "a-" + name.slice(0, 18),
      });
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL);
    assert.equal(store.events().length, before);
    rejected.push({ name, code: error.code, path: error.path });
  }

  const refAttacks = [
    ["token-field", { token: "redacted-token-value" }],
    ["password-field", { password: "redacted-password-value" }],
    ["private-key-field", { privateKey: "redacted-key-value" }],
    ["cookie-field", { cookie: "session=redacted" }],
    ["connection-string-field", { connectionString: "postgres://redacted" }],
  ];
  for (const [, extra] of refAttacks) {
    const before = store.events().length;
    let error;
    try {
      normalizeSecretRef({ ...secretRef(1), ...extra });
    } catch (caught) {
      error = caught;
    }
    assert.equal(
      error?.code === CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL ||
        error?.code === CONNECTION_ERROR_CODES.INVALID_SECRET_REF,
      true,
    );
    assert.equal(store.events().length, before);
  }

  const eventBoundary = eventBoundaryFixture();

  return {
    corpus: attacks.map(([name]) => name),
    secretRefCorpus: refAttacks.map(([name]) => name),
    rejected,
    eventBoundary,
    appendedEvents: store.events().length,
    rawValuesPersisted: false,
  };
}

function eventBoundaryFixture() {
  let error;
  try {
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
        secretRef: secretRef(1),
        revision: 1,
      },
    });
  } catch (caught) {
    error = caught;
  }
  assert.equal(error?.code, CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL);
  return {
    rejected: true,
    code: error.code,
    path: error.path,
  };
}

function captureKeyCollisionFixture() {
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
      secretRef: secretRef(1),
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
  return {
    collisionAvoided: true,
    firstBinding: {
      connectionId: first.connectionId,
      runId: first.runId,
      revision: first.revision,
    },
    secondBinding: {
      connectionId: second.connectionId,
      runId: second.runId,
      revision: second.revision,
    },
  };
}

function apiIdentifierBoundaryFixture() {
  const providerToken = "ghp_" + "a".repeat(32);
  const rejected = {};
  const assertions = [
    [
      "opaque-store-id",
      () => normalizeOpaqueIdForStore(providerToken, "$.runId"),
    ],
    [
      "principal-id",
      () =>
        normalizePrincipal({
          ...SCOPE,
          id: providerToken,
          kind: "user",
          role: "admin",
        }),
    ],
    [
      "principal-workspace-id",
      () =>
        normalizePrincipal({
          ...MEMBER,
          workspaceId: providerToken,
        }),
    ],
    [
      "principal-capability",
      () =>
        normalizePrincipal({
          ...ADMIN,
          capabilities: [providerToken],
        }),
    ],
    [
      "owner-id",
      () => normalizeOwner({ kind: "workspace", id: providerToken }),
    ],
  ];
  for (const [name, action] of assertions) {
    let error;
    try {
      action();
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL);
    rejected[name] = { code: error.code, path: error.path };
  }

  const store = makeStore();
  store.create({
    actor: ADMIN,
    connectionId: "connection-api-identifier",
    owner: { kind: "workspace", id: SCOPE.workspaceId },
    provider: "github",
    integration: "issues",
    label: "API identifier",
    metadata: {},
    secretRef: secretRef(1),
    idempotencyKey: "create-api-identifier",
  });
  const before = store.events().length;
  let captureError;
  try {
    store.captureForRun({
      actor: ADMIN,
      connectionId: "connection-api-identifier",
      runId: providerToken,
    });
  } catch (caught) {
    captureError = caught;
  }
  assert.equal(captureError?.code, CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL);
  assert.equal(store.events().length, before);
  let authorizationError;
  try {
    store.authorization({
      actor: { ...ADMIN, id: providerToken },
      connectionId: "connection-api-identifier",
    });
  } catch (caught) {
    authorizationError = caught;
  }
  assert.equal(
    authorizationError?.code,
    CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL,
  );
  const authorization = {
    allowed: false,
    code: authorizationError.code,
    path: authorizationError.path,
  };
  const ordinaryLongId = "connection-final-lifecycle";
  const ordinaryPrincipal = normalizePrincipal({
    ...MEMBER,
    workspaceId: ordinaryLongId,
  });
  return {
    rejected,
    identifierCompatibility: {
      opaqueId: normalizeOpaqueIdForStore(ordinaryLongId, "$.connectionId"),
      principalWorkspaceId: ordinaryPrincipal.workspaceId,
    },
    capture: {
      code: captureError.code,
      path: captureError.path,
      appendedBefore: before,
      appendedAfter: store.events().length,
    },
    authorization,
  };
}

function authorizationFixture() {
  const store = makeStore();
  store.create({
    actor: ADMIN,
    connectionId: "connection-workspace",
    owner: { kind: "workspace", id: SCOPE.workspaceId },
    provider: "github",
    integration: "issues",
    label: "Workspace connection",
    metadata: {},
    secretRef: secretRef(1),
    idempotencyKey: "create-workspace",
  });
  store.create({
    actor: ADMIN,
    connectionId: "connection-agent",
    owner: { kind: "agent", id: "agent-ada" },
    provider: "github",
    integration: "issues",
    label: "Agent connection",
    metadata: {},
    secretRef: secretRef(1),
    idempotencyKey: "create-agent",
  });
  store.create({
    actor: ADMIN,
    connectionId: "connection-user",
    owner: { kind: "user", id: "user-member" },
    provider: "github",
    integration: "issues",
    label: "User connection",
    metadata: {},
    secretRef: secretRef(1),
    idempotencyKey: "create-user",
  });
  const agent = {
    ...SCOPE,
    id: "agent-ada",
    kind: "agent",
    role: "agent",
  };
  const rows = [
    [
      "workspace-member-read",
      store.authorization({
        actor: MEMBER,
        connectionId: "connection-workspace",
      }),
    ],
    [
      "workspace-member-grant",
      store.authorization({
        actor: MEMBER,
        connectionId: "connection-workspace",
        action: "grant",
      }),
    ],
    [
      "workspace-member-delete",
      store.authorization({
        actor: MEMBER,
        connectionId: "connection-workspace",
        action: "delete",
      }),
    ],
    [
      "agent-owner-grant",
      store.authorization({
        actor: agent,
        connectionId: "connection-agent",
        action: "grant",
      }),
    ],
    [
      "member-agent-grant",
      store.authorization({
        actor: MEMBER,
        connectionId: "connection-agent",
        action: "grant",
      }),
    ],
    [
      "user-owner-grant",
      store.authorization({
        actor: MEMBER,
        connectionId: "connection-user",
        action: "grant",
      }),
    ],
    [
      "admin-delete-agent",
      store.authorization({
        actor: ADMIN,
        connectionId: "connection-agent",
        action: "delete",
      }),
    ],
  ];
  assert.deepEqual(
    Object.fromEntries(rows.map(([name, value]) => [name, value.allowed])),
    {
      "workspace-member-read": true,
      "workspace-member-grant": true,
      "workspace-member-delete": false,
      "agent-owner-grant": true,
      "member-agent-grant": false,
      "user-owner-grant": true,
      "admin-delete-agent": true,
    },
  );

  const foreign = {
    ...ADMIN,
    tenantId: "tenant-foreign",
    workspaceId: "workspace-foreign",
  };
  const operations = [
    [
      "read",
      () =>
        store.read({ actor: foreign, connectionId: "connection-workspace" }),
    ],
    [
      "grant",
      () =>
        store.captureForRun({
          actor: foreign,
          connectionId: "connection-workspace",
          runId: "run-foreign",
        }),
    ],
    [
      "rotate",
      () =>
        store.rotate({
          actor: foreign,
          connectionId: "connection-workspace",
          expectedRevision: 1,
          secretRef: secretRef(2),
          idempotencyKey: "foreign-rotate",
        }),
    ],
    [
      "disable",
      () =>
        store.disable({
          actor: foreign,
          connectionId: "connection-workspace",
          idempotencyKey: "foreign-disable",
        }),
    ],
    [
      "delete",
      () =>
        store.delete({
          actor: foreign,
          connectionId: "connection-workspace",
          idempotencyKey: "foreign-delete",
        }),
    ],
  ];
  const before = store.stateDigest();
  const foreignErrors = [];
  const unknownErrors = [];
  for (const [operation, action] of operations) {
    foreignErrors.push(captureError(operation, action));
    unknownErrors.push(
      captureError(operation, () => {
        const input = { actor: foreign, connectionId: "connection-unknown" };
        if (operation === "grant") input.runId = "run-foreign";
        if (operation === "rotate") {
          input.expectedRevision = 1;
          input.secretRef = secretRef(2);
          input.idempotencyKey = "unknown-rotate";
        }
        if (operation === "disable" || operation === "delete") {
          input.idempotencyKey = "unknown-" + operation;
        }
        return operation === "read"
          ? store.read(input)
          : operation === "grant"
            ? store.captureForRun(input)
            : operation === "rotate"
              ? store.rotate(input)
              : operation === "disable"
                ? store.disable(input)
                : store.delete(input);
      }),
    );
  }
  assert.deepEqual(foreignErrors, unknownErrors);
  assert.equal(store.stateDigest(), before);

  return {
    rows: rows.map(([name, value]) => ({
      name,
      allowed: value.allowed,
      code: value.code,
    })),
    foreignErrors,
    unknownErrors,
    summary: {
      ownershipMatrixPassed: true,
      foreignAndUnknownErrorsEqual: true,
      stateDigestUnchanged: true,
    },
  };
}

function captureError(operation, action) {
  let error;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  assert.equal(error?.code, CONNECTION_ERROR_CODES.NOT_FOUND);
  return {
    operation,
    code: error.code,
    detail: error.detail,
    path: error.path,
    statusCode: error.statusCode,
  };
}

async function detectorSensitivityFixture() {
  const workDirectory = path.join(taskDirectory, "work");
  await mkdir(workDirectory, { recursive: true });
  const scratchDirectory = await mkdtemp(
    path.join(workDirectory, "detector-sensitivity-"),
  );
  try {
    const sourceDirectory = path.join(scratchDirectory, "src");
    await mkdir(sourceDirectory, { recursive: true });
    const schemaPath = path.join(sourceDirectory, "schema.mjs");
    const errorsPath = path.join(sourceDirectory, "errors.mjs");
    const canonicalPath = path.join(sourceDirectory, "canonical.mjs");
    await copyFile(
      path.join(root, "packages/connections/src/schema.mjs"),
      schemaPath,
    );
    await copyFile(
      path.join(root, "packages/connections/src/errors.mjs"),
      errorsPath,
    );
    await copyFile(
      path.join(root, "packages/connections/src/canonical.mjs"),
      canonicalPath,
    );
    const source = await readFile(schemaPath, "utf8");
    const lines = source.split("\n");
    const detectorLine = lines.findIndex((line) =>
      line.includes("https?|ssh|postgres(?:ql)?"),
    );
    assert.notEqual(detectorLine, -1);
    lines.splice(detectorLine, 1);
    await writeFile(schemaPath, lines.join("\n"));
    const fixture = {
      connectionId: "connection-sensitivity",
      tenantId: SCOPE.tenantId,
      workspaceId: SCOPE.workspaceId,
      owner: { kind: "workspace", id: SCOPE.workspaceId },
      provider: "github",
      integration: "issues",
      label: "Sensitivity",
      metadata: { endpoint: "https://user:password@example.invalid/service" },
      secretRef: secretRef(1),
    };
    const probe =
      "import { normalizeConnectionDefinition } from " +
      JSON.stringify(pathToFileURL(schemaPath).href) +
      ";\nnormalizeConnectionDefinition(" +
      JSON.stringify(fixture) +
      ");\n";
    let mutatedAccepted = false;
    try {
      execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      mutatedAccepted = true;
    } catch {
      mutatedAccepted = false;
    }
    assert.equal(mutatedAccepted, true);
    return {
      branchRemoved: "URL and connection-string value detector",
      mutatedFixtureAccepted: true,
      verifierWouldTurnRed: true,
    };
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true });
  }
}

async function detectorProviderTokenSensitivityFixture() {
  const workDirectory = path.join(taskDirectory, "work");
  await mkdir(workDirectory, { recursive: true });
  const scratchDirectory = await mkdtemp(
    path.join(workDirectory, "detector-provider-token-sensitivity-"),
  );
  try {
    const sourceDirectory = path.join(scratchDirectory, "src");
    await mkdir(sourceDirectory, { recursive: true });
    const schemaPath = path.join(sourceDirectory, "schema.mjs");
    const errorsPath = path.join(sourceDirectory, "errors.mjs");
    const canonicalPath = path.join(sourceDirectory, "canonical.mjs");
    await copyFile(
      path.join(root, "packages/connections/src/schema.mjs"),
      schemaPath,
    );
    await copyFile(
      path.join(root, "packages/connections/src/errors.mjs"),
      errorsPath,
    );
    await copyFile(
      path.join(root, "packages/connections/src/canonical.mjs"),
      canonicalPath,
    );
    const source = await readFile(schemaPath, "utf8");
    const lines = source.split("\n");
    const detectorLine = lines.findIndex((line) =>
      line.includes("sk|rk|pk|ghp|github_pat|xox"),
    );
    assert.notEqual(detectorLine, -1);
    lines.splice(detectorLine, 1);
    await writeFile(schemaPath, lines.join("\n"));
    const fixture = {
      connectionId: "conn-provider-sense",
      tenantId: SCOPE.tenantId,
      workspaceId: SCOPE.workspaceId,
      owner: { kind: "workspace", id: SCOPE.workspaceId },
      provider: "github",
      integration: "issues",
      label: "Provider sensitivity",
      metadata: {
        encodedValue: "ghp_" + "A".repeat(12) + "." + "A".repeat(20),
      },
      secretRef: secretRef(1),
    };
    const probe =
      "import { normalizeConnectionDefinition } from " +
      JSON.stringify(pathToFileURL(schemaPath).href) +
      ";\nnormalizeConnectionDefinition(" +
      JSON.stringify(fixture) +
      ");\n";
    let mutatedAccepted = false;
    try {
      execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      mutatedAccepted = true;
    } catch {
      mutatedAccepted = false;
    }
    assert.equal(mutatedAccepted, true);
    return {
      branchRemoved: "provider-token value detector",
      fixtureKey: "encodedValue",
      mutatedFixtureAccepted: true,
      verifierWouldTurnRed: true,
    };
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true });
  }
}

async function detectorBase64SensitivityFixture() {
  const workDirectory = path.join(taskDirectory, "work");
  await mkdir(workDirectory, { recursive: true });
  const scratchDirectory = await mkdtemp(
    path.join(workDirectory, "detector-base64-sensitivity-"),
  );
  try {
    const sourceDirectory = path.join(scratchDirectory, "src");
    await mkdir(sourceDirectory, { recursive: true });
    const schemaPath = path.join(sourceDirectory, "schema.mjs");
    const errorsPath = path.join(sourceDirectory, "errors.mjs");
    const canonicalPath = path.join(sourceDirectory, "canonical.mjs");
    await copyFile(
      path.join(root, "packages/connections/src/schema.mjs"),
      schemaPath,
    );
    await copyFile(
      path.join(root, "packages/connections/src/errors.mjs"),
      errorsPath,
    );
    await copyFile(
      path.join(root, "packages/connections/src/canonical.mjs"),
      canonicalPath,
    );
    const source = await readFile(schemaPath, "utf8");
    const lines = source.split("\n");
    const detectorLine = lines.findIndex((line) =>
      line.includes(
        "if (!allowGenericBase64 && isBase64EncodedValue(value)) return true;",
      ),
    );
    assert.notEqual(detectorLine, -1);
    lines.splice(detectorLine, 1);
    await writeFile(schemaPath, lines.join("\n"));
    const fixture = {
      connectionId: "connection-base64-sensitivity",
      tenantId: SCOPE.tenantId,
      workspaceId: SCOPE.workspaceId,
      owner: { kind: "workspace", id: SCOPE.workspaceId },
      provider: "github",
      integration: "issues",
      label: "Base64 sensitivity",
      metadata: {
        encodedUrlSafe: "a".repeat(21) + "-a",
      },
      secretRef: secretRef(1),
    };
    const probe =
      "import { normalizeConnectionDefinition } from " +
      JSON.stringify(pathToFileURL(schemaPath).href) +
      ";\nnormalizeConnectionDefinition(" +
      JSON.stringify(fixture) +
      ");\n";
    let mutatedAccepted = false;
    try {
      execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      mutatedAccepted = true;
    } catch {
      mutatedAccepted = false;
    }
    assert.equal(mutatedAccepted, true);
    return {
      branchRemoved: "standard and URL-safe base64 value detector",
      fixtureKey: "encodedUrlSafe",
      mutatedFixtureAccepted: true,
      verifierWouldTurnRed: true,
    };
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true });
  }
}

async function evidenceLeakSensitivityFixture() {
  const filename = ".e5-t02-independent-canary.txt";
  const file = path.join(evidenceDirectory, filename);
  await writeFile(file, CANARY_VALUES[1] + "\n");
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

async function scanEvidence() {
  const files = await listEvidenceFiles(evidenceDirectory);
  const patterns = [
    /e5-t02-connection-canary-value|critic-independent-e5-t02-canary-value/iu,
    /-----BEGIN [^-]*PRIVATE KEY-----/iu,
    /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/iu,
    /\b(?:api[_-]?key|client[_-]?secret|password|token|cookie|authorization)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/iu,
    /(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?|amqp):\/\/\S+/iu,
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

async function writeJson(filename, value) {
  await writeFile(
    path.join(evidenceDirectory, filename),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function makeStore() {
  let now = Date.parse("2026-08-19T17:00:00.000Z");
  return createConnectionStore({
    ...SCOPE,
    clock: () => new Date((now += 1000)),
  });
}

function secretRef(revision) {
  return {
    schemaVersion: 1,
    id: "secretref-github-" + String(revision).padStart(3, "0"),
    provider: "infisical",
    mount: "production",
    revision,
    label: "github",
  };
}
