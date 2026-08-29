import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

import {
  CONNECTION_ERROR_CODES,
  canonicalSha256,
  createConnectionStore,
  normalizeMetadata,
  normalizeReason,
  replayConnectionEvents,
} from "@stream-slack/connections";

const scope = { tenantId: "tenant-independent", workspaceId: "workspace-independent" };
const admin = { ...scope, id: "user-independent-admin", kind: "user", role: "admin" };
const member = { ...scope, id: "user-independent-member", kind: "user", role: "member" };
const secretRef = (revision) => ({
  schemaVersion: 1,
  id: `secretref-independent-${revision}`,
  provider: "infisical",
  mount: "production",
  revision,
  label: "independent",
});
let ticks = 0;
const makeStore = () =>
  createConnectionStore({
    ...scope,
    clock: () => new Date(Date.parse("2026-08-20T12:00:00.000Z") + ++ticks * 1000),
    idFactory: (() => {
      let id = 0;
      return (prefix) => `${prefix}-independent-${++id}`;
    })(),
  });

const lifecycle = makeStore();
const created = lifecycle.create({
  actor: admin,
  connectionId: "connection-independent-lifecycle",
  owner: { kind: "workspace", id: scope.workspaceId },
  provider: "github",
  integration: "issues",
  label: "Independent lifecycle",
  metadata: { account: "synthetic", purpose: "read-issues" },
  secretRef: secretRef(1),
  idempotencyKey: "create-independent-lifecycle",
});
const firstCapture = lifecycle.captureForRun({
  actor: member,
  connectionId: created.connection.connectionId,
  runId: "run-independent-first",
});
const rotated = lifecycle.rotate({
  actor: admin,
  connectionId: created.connection.connectionId,
  expectedRevision: 1,
  secretRef: secretRef(2),
  idempotencyKey: "rotate-independent-lifecycle",
});
const secondCapture = lifecycle.captureForRun({
  actor: member,
  connectionId: created.connection.connectionId,
  runId: "run-independent-second",
});
const repeatFirstCapture = lifecycle.captureForRun({
  actor: member,
  connectionId: created.connection.connectionId,
  runId: "run-independent-first",
});
assert.equal(firstCapture.revision, 1);
assert.equal(secondCapture.revision, 2);
assert.deepEqual(repeatFirstCapture, firstCapture);
assert.equal(rotated.connection.activeRevision, 2);
lifecycle.disable({
  actor: admin,
  connectionId: created.connection.connectionId,
  reason: "maintenance",
  idempotencyKey: "disable-independent-lifecycle",
});
assert.throws(
  () => lifecycle.captureForRun({ actor: member, connectionId: created.connection.connectionId, runId: "run-independent-disabled" }),
  (error) => error.code === CONNECTION_ERROR_CODES.NOT_ACTIVE,
);
lifecycle.delete({
  actor: admin,
  connectionId: created.connection.connectionId,
  reason: "retired",
  idempotencyKey: "delete-independent-lifecycle",
});
assert.equal(lifecycle.read({ actor: member, connectionId: created.connection.connectionId }).status, "deleted");
const lifecycleEvents = lifecycle.events();
const replay = replayConnectionEvents([...lifecycleEvents, ...lifecycleEvents].reverse());
assert.equal(replay.stateDigest, lifecycle.stateDigest());
assert.deepEqual(replay.connections, lifecycle.snapshot().connections);

const authz = makeStore();
for (const [connectionId, owner] of [
  ["connection-independent-workspace", { kind: "workspace", id: scope.workspaceId }],
  ["connection-independent-agent", { kind: "agent", id: "agent-independent" }],
  ["connection-independent-user", { kind: "user", id: member.id }],
]) {
  authz.create({
    actor: admin,
    connectionId,
    owner,
    provider: "github",
    integration: "issues",
    label: "Independent authz",
    metadata: {},
    secretRef: secretRef(1),
    idempotencyKey: `create-${connectionId}`,
  });
}
const agent = { ...scope, id: "agent-independent", kind: "agent", role: "agent" };
const authzRows = [
  ["workspace-member-read", authz.authorization({ actor: member, connectionId: "connection-independent-workspace" }), true],
  ["workspace-member-grant", authz.authorization({ actor: member, connectionId: "connection-independent-workspace", action: "grant" }), true],
  ["workspace-member-delete", authz.authorization({ actor: member, connectionId: "connection-independent-workspace", action: "delete" }), false],
  ["agent-owner-grant", authz.authorization({ actor: agent, connectionId: "connection-independent-agent", action: "grant" }), true],
  ["member-agent-grant", authz.authorization({ actor: member, connectionId: "connection-independent-agent", action: "grant" }), false],
  ["user-owner-grant", authz.authorization({ actor: member, connectionId: "connection-independent-user", action: "grant" }), true],
  ["admin-delete-agent", authz.authorization({ actor: admin, connectionId: "connection-independent-agent", action: "delete" }), true],
];
for (const [, row, expected] of authzRows) assert.equal(row.allowed, expected);
const foreignUnknown = {};
for (const action of ["read", "grant", "rotate", "disable", "delete"]) {
  const foreign = authz.authorization({ actor: { ...member, tenantId: "tenant-foreign" }, connectionId: "connection-independent-workspace", action });
  const unknown = authz.authorization({ actor: member, connectionId: "connection-independent-missing", action });
  assert.deepEqual(foreign, unknown);
  foreignUnknown[action] = { foreign, unknown };
}
const authzDigestBefore = authz.stateDigest();
assert.equal(authz.stateDigest(), authzDigestBefore);

const bounds = {};
const tooDeep = { a: { b: { c: { d: { e: "value" } } } } };
assert.throws(() => normalizeMetadata(tooDeep), (error) => error.code === CONNECTION_ERROR_CODES.INVALID_REQUEST);
bounds.depth = "rejected";
assert.throws(
  () => normalizeMetadata(Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`key${index}`, index]))),
  (error) => error.code === CONNECTION_ERROR_CODES.INVALID_REQUEST,
);
bounds.objectWidth65 = "rejected";
assert.throws(() => normalizeMetadata({ values: Array.from({ length: 33 }, (_, index) => index) }), (error) => error.code === CONNECTION_ERROR_CODES.INVALID_REQUEST);
bounds.arrayWidth33 = "rejected";
assert.deepEqual(normalizeMetadata({ label: "🧪".repeat(512) }), { label: "🧪".repeat(512) });
bounds.astral512CodePoints = "accepted";
assert.throws(() => normalizeMetadata({ label: "🧪".repeat(513) }), (error) => error.code === CONNECTION_ERROR_CODES.INVALID_REQUEST);
bounds.astral513CodePoints = "rejected";
assert.throws(() => normalizeReason("🧪".repeat(161)), (error) => error.code === CONNECTION_ERROR_CODES.INVALID_REQUEST);
bounds.reason161CodePoints = "rejected";

const canary = "ghp_INDEPENDENT_CANARY_VALUE";
const beforeCanaryEvents = authz.events().length;
assert.throws(
  () => authz.create({
    actor: admin,
    connectionId: "connection-independent-canary",
    owner: { kind: "workspace", id: scope.workspaceId },
    provider: "github",
    integration: "issues",
    label: "Independent canary",
    metadata: { note: canary },
    secretRef: secretRef(1),
    idempotencyKey: "create-independent-canary",
  }),
  (error) => error.code === CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL,
);
assert.equal(authz.events().length, beforeCanaryEvents);
const persisted = JSON.stringify({ events: authz.events(), snapshot: authz.snapshot() });
assert.equal(persisted.includes(canary), false);

const output = {
  exactHead: process.env.EXACT_HEAD ?? "5d35c66",
  lifecycle: {
    eventCount: lifecycleEvents.length,
    replayDigest: replay.stateDigest,
    storeDigest: lifecycle.stateDigest(),
    equal: replay.stateDigest === lifecycle.stateDigest(),
    capturedRevisions: [firstCapture.revision, secondCapture.revision, repeatFirstCapture.revision],
    terminalStatus: lifecycle.read({ actor: member, connectionId: created.connection.connectionId }).status,
  },
  authorization: { rows: Object.fromEntries(authzRows.map(([name, row]) => [name, row])), foreignUnknown },
  bounds,
  leakage: { canaryPersisted: persisted.includes(canary), appendedEventsBefore: beforeCanaryEvents, appendedEventsAfter: authz.events().length },
  digests: { lifecycle: canonicalSha256(lifecycle.snapshot()), authz: authz.stateDigest() },
};
if (process.env.OUTPUT_PATH) await writeFile(process.env.OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify(output, null, 2));
