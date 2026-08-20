import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CONNECTION_ERROR_CODES,
  canonicalSha256,
  createConnectionStore,
  normalizeMetadata,
  normalizeReason,
  replayConnectionEvents,
} from "@stream-slack/connections";

const root = path.resolve(import.meta.dirname, "../../../../../..");
const schema = JSON.parse(
  await readFile(
    path.join(
      root,
      "packages/connections/src/schemas/connection-events.v1.schema.json",
    ),
    "utf8",
  ),
);
const { default: Ajv2020 } = await import(
  pathToFileURL(path.join(process.env.AJV_ROOT, "dist/2020.js")).href
);
const validatePublic = new Ajv2020({ allErrors: true, strict: false }).compile(
  schema,
);

const metadataChecks = [
  checkMetadata(
    "depth-five-rejected",
    {
      level1: { level2: { level3: { level4: { level5: "value" } } } },
    },
    false,
  ),
  checkMetadata(
    "array-33-rejected",
    { values: Array(33).fill("value") },
    false,
  ),
  checkMetadata(
    "properties-65-rejected",
    Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`key${index}`, index]),
    ),
    false,
  ),
  checkMetadata("astral-512-accepted", { label: "🧪".repeat(512) }, true),
  checkMetadata("astral-513-rejected", { label: "🧪".repeat(513) }, false),
];

const reasonChecks = [
  checkReason("reason-160-accepted", "🧪".repeat(160), true),
  checkReason("reason-161-rejected", "🧪".repeat(161), false),
];

const lifecycle = lifecycleCheck();
const authorization = authorizationCheck();
const leakScan = leakageCheck(lifecycle);

const output = {
  schemaVersion: 1,
  task: "E5-T02",
  exactHead: process.env.EXACT_HEAD ?? "ba08576",
  metadataChecks,
  reasonChecks,
  lifecycle,
  authorization,
  leakScan,
};
const outputPath = process.env.OUTPUT_PATH;
if (outputPath)
  await writeFile(outputPath, JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify(output, null, 2));

function checkMetadata(name, metadata, accepted) {
  const event = makeEvent("connection-controls", "connection.created", {
    metadata,
    revision: 1,
  });
  const publicAccepted = validatePublic(event);
  let runtimeError = null;
  try {
    normalizeMetadata(metadata);
  } catch (error) {
    runtimeError = summarizeError(error);
  }
  assert.equal(publicAccepted, accepted, `${name}: public schema parity`);
  assert.equal(Boolean(runtimeError), !accepted, `${name}: runtime parity`);
  return {
    name,
    expected: accepted ? "accept" : "reject",
    publicSchemaAccepted: publicAccepted,
    runtimeError,
  };
}

function checkReason(name, reason, accepted) {
  const event = makeEvent("connection-reason", "connection.disabled", {
    reason,
  });
  const publicAccepted = validatePublic(event);
  let runtimeError = null;
  try {
    normalizeReason(reason);
  } catch (error) {
    runtimeError = summarizeError(error);
  }
  assert.equal(publicAccepted, accepted, `${name}: public schema parity`);
  assert.equal(Boolean(runtimeError), !accepted, `${name}: runtime parity`);
  return {
    name,
    expected: accepted ? "accept" : "reject",
    publicSchemaAccepted: publicAccepted,
    runtimeError,
  };
}

function lifecycleCheck() {
  let clockTick = 0;
  let idTick = 0;
  const store = createConnectionStore({
    tenantId: "tenant-alpha",
    workspaceId: "workspace-alpha",
    clock: () =>
      new Date(Date.parse("2026-08-20T12:00:00.000Z") + ++clockTick * 1000),
    idFactory: (kind) =>
      `${kind}-controls-${String(++idTick).padStart(3, "0")}`,
  });
  const admin = principal("user-admin", "user", "admin");
  const member = principal("user-member", "user", "member");
  store.create({
    actor: admin,
    connectionId: "connection-controls",
    owner: { kind: "workspace", id: "workspace-alpha" },
    provider: "github",
    integration: "issues",
    label: "Controls",
    metadata: { account: "stream-slack", purpose: "read-issues" },
    secretRef: ref(1),
    idempotencyKey: "create-controls",
  });
  const firstCapture = store.captureForRun({
    actor: member,
    connectionId: "connection-controls",
    runId: "run-controls-first",
  });
  store.rotate({
    actor: admin,
    connectionId: "connection-controls",
    expectedRevision: 1,
    secretRef: ref(2),
    idempotencyKey: "rotate-controls",
  });
  const sameRunCapture = store.captureForRun({
    actor: member,
    connectionId: "connection-controls",
    runId: "run-controls-first",
  });
  const newRunCapture = store.captureForRun({
    actor: member,
    connectionId: "connection-controls",
    runId: "run-controls-second",
  });
  assert.equal(firstCapture.revision, 1);
  assert.equal(sameRunCapture.revision, 1);
  assert.equal(newRunCapture.revision, 2);
  assert.equal(sameRunCapture.bindingDigest, firstCapture.bindingDigest);

  store.disable({
    actor: admin,
    connectionId: "connection-controls",
    reason: "maintenance",
    idempotencyKey: "disable-controls",
  });
  let disabledCaptureError = null;
  try {
    store.captureForRun({
      actor: member,
      connectionId: "connection-controls",
      runId: "run-controls-disabled",
    });
  } catch (error) {
    disabledCaptureError = summarizeError(error);
  }
  assert.equal(disabledCaptureError.code, CONNECTION_ERROR_CODES.NOT_ACTIVE);
  store.delete({
    actor: admin,
    connectionId: "connection-controls",
    reason: "retired",
    idempotencyKey: "delete-controls",
  });
  const view = store.read({
    actor: member,
    connectionId: "connection-controls",
  });
  assert.equal(view.status, "deleted");
  assert.equal(view.tombstone.reason, "retired");

  const events = store.events();
  const replay = replayConnectionEvents([...events, ...events].reverse());
  assert.equal(replay.stateDigest, store.stateDigest());
  assert.deepEqual(replay.connections, store.snapshot().connections);
  assert.equal(
    replay.stateDigest,
    replayConnectionEvents([...events, ...events].reverse()).stateDigest,
  );
  return {
    eventCount: events.length,
    activeRevisionAfterRotate: 2,
    capturedRevisions: {
      firstRun: firstCapture.revision,
      sameRunAfterRotate: sameRunCapture.revision,
      secondRun: newRunCapture.revision,
    },
    disabledCaptureError,
    terminalStatus: view.status,
    tombstoneReason: view.tombstone.reason,
    originalStateDigest: store.stateDigest(),
    duplicateReorderedReplayDigest: replay.stateDigest,
    replayParity: replay.stateDigest === store.stateDigest(),
    replayViewDigest: canonicalSha256(replay.connections),
    events,
  };
}

function authorizationCheck() {
  let idTick = 0;
  const store = createConnectionStore({
    tenantId: "tenant-alpha",
    workspaceId: "workspace-alpha",
    idFactory: (kind) => `${kind}-authz-${String(++idTick).padStart(3, "0")}`,
  });
  const admin = principal("user-admin", "user", "admin");
  const member = principal("user-member", "user", "member");
  for (const [connectionId, owner] of [
    ["connection-workspace", { kind: "workspace", id: "workspace-alpha" }],
    ["connection-agent", { kind: "agent", id: "agent-alpha" }],
    ["connection-user", { kind: "user", id: "user-member" }],
  ]) {
    store.create({
      actor: admin,
      connectionId,
      owner,
      provider: "github",
      integration: "issues",
      label: "Authz",
      metadata: {},
      secretRef: ref(1),
      idempotencyKey: `create-${connectionId}`,
    });
  }
  const rows = [
    [
      "workspace-member-read",
      store.authorization({
        actor: member,
        connectionId: "connection-workspace",
      }),
    ],
    [
      "workspace-member-grant",
      store.authorization({
        actor: member,
        connectionId: "connection-workspace",
        action: "grant",
      }),
    ],
    [
      "user-owner-read",
      store.authorization({ actor: member, connectionId: "connection-user" }),
    ],
    [
      "agent-member-read",
      store.authorization({ actor: member, connectionId: "connection-agent" }),
    ],
    [
      "foreign-read",
      store.authorization({
        actor: principal(
          "foreign",
          "user",
          "member",
          "tenant-foreign",
          "workspace-foreign",
        ),
        connectionId: "connection-workspace",
      }),
    ],
  ].map(([name, value]) => ({ name, ...value }));
  assert.equal(
    rows.find(({ name }) => name === "workspace-member-read").allowed,
    true,
  );
  assert.equal(
    rows.find(({ name }) => name === "workspace-member-grant").allowed,
    true,
  );
  assert.equal(
    rows.find(({ name }) => name === "user-owner-read").allowed,
    true,
  );
  assert.equal(
    rows.find(({ name }) => name === "agent-member-read").allowed,
    false,
  );
  assert.equal(rows.find(({ name }) => name === "foreign-read").allowed, false);

  const before = store.stateDigest();
  const foreign = principal(
    "foreign",
    "user",
    "admin",
    "tenant-foreign",
    "workspace-foreign",
  );
  const comparisons = [];
  for (const operation of ["read", "grant", "rotate", "disable", "delete"]) {
    const capture = (connectionId) => {
      try {
        if (operation === "read")
          return store.read({ actor: foreign, connectionId });
        if (operation === "grant")
          return store.captureForRun({
            actor: foreign,
            connectionId,
            runId: "run-foreign",
          });
        if (operation === "rotate")
          return store.rotate({
            actor: foreign,
            connectionId,
            expectedRevision: 1,
            secretRef: ref(2),
            idempotencyKey: "rotate-foreign",
          });
        if (operation === "disable")
          return store.disable({
            actor: foreign,
            connectionId,
            reason: "x",
            idempotencyKey: "disable-foreign",
          });
        return store.delete({
          actor: foreign,
          connectionId,
          reason: "x",
          idempotencyKey: "delete-foreign",
        });
      } catch (error) {
        return summarizeError(error);
      }
    };
    const known = capture("connection-workspace");
    const unknown = capture("connection-unknown");
    assert.deepEqual(
      known,
      unknown,
      `${operation}: foreign and unknown response mismatch`,
    );
    assert.equal(known.code, CONNECTION_ERROR_CODES.NOT_FOUND);
    comparisons.push({ operation, known, unknown, equal: true });
  }
  assert.equal(store.stateDigest(), before);
  return { rows, comparisons, stateDigestUnchanged: true };
}

function leakageCheck(lifecycle) {
  const serialized = JSON.stringify(lifecycle.events);
  const forbidden = [
    "redacted-token-value",
    "redacted-password",
    "redacted-private-key",
    "raw-client-secret",
  ];
  const matches = forbidden.filter((value) => serialized.includes(value));
  assert.deepEqual(matches, []);
  return { leaked: false, forbiddenCanaryMatches: matches };
}

function makeEvent(connectionId, eventType, data) {
  const createdData = {
    schemaVersion: 1,
    connectionId,
    tenantId: "tenant-alpha",
    workspaceId: "workspace-alpha",
    owner: { kind: "workspace", id: "workspace-alpha" },
    provider: "github",
    integration: "issues",
    label: "Controls",
    metadata: {},
    secretRef: ref(1),
    revision: 1,
    ...data,
  };
  return {
    schemaVersion: 1,
    eventId: `event-${connectionId}`,
    eventType,
    workspaceId: "workspace-alpha",
    actorId: "user-admin",
    idempotencyKey: `idempotency-${connectionId}`,
    sequence: 1,
    serverTimestamp: "2026-08-20T12:00:00.000Z",
    connectionId,
    data: eventType === "connection.created" ? createdData : data,
  };
}

function ref(revision) {
  return {
    schemaVersion: 1,
    id: `secretref-controls-${String(revision).padStart(3, "0")}`,
    provider: "infisical",
    mount: "production",
    revision,
    label: "controls",
  };
}

function principal(
  id,
  kind,
  role,
  tenantId = "tenant-alpha",
  workspaceId = "workspace-alpha",
) {
  return { id, kind, role, tenantId, workspaceId };
}

function summarizeError(error) {
  return {
    code: error?.code ?? error?.name ?? "Error",
    path: error?.path ?? null,
  };
}
