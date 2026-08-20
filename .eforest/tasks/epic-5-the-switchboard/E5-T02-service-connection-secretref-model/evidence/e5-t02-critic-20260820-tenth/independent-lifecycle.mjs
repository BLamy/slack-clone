import { writeFile } from "node:fs/promises";
import {
  CONNECTION_ERROR_CODES,
  canonicalSha256,
  createConnectionStore,
  replayConnectionEvents,
} from "../../../../../../packages/connections/src/index.mjs";

const evidenceDirectory = new URL("./", import.meta.url);
const scope = {
  tenantId: "tenant-critic-lifecycle",
  workspaceId: "workspace-critic-lifecycle",
};
const admin = {
  ...scope,
  id: "admin-critic-lifecycle",
  kind: "user",
  role: "admin",
};
const member = {
  ...scope,
  id: "member-critic-lifecycle",
  kind: "user",
  role: "member",
};
let tick = 0;
const store = createConnectionStore({
  ...scope,
  clock: () => new Date(Date.UTC(2026, 7, 20, 0, 0, ++tick)),
});

function secretRef(revision) {
  return {
    schemaVersion: 1,
    id: "secret-ref-critic-lifecycle-" + revision,
    provider: "infisical",
    mount: "production",
    revision,
  };
}

const observations = [];
const findings = [];

function check(name, observed, expected) {
  const passed = JSON.stringify(observed) === JSON.stringify(expected);
  observations.push({ name, passed, observed, expected });
  if (!passed) findings.push({ name, observed, expected });
}

function expectError(name, action, expectedCode) {
  try {
    action();
    check(name, { accepted: true }, { accepted: false, code: expectedCode });
  } catch (error) {
    check(
      name,
      { accepted: false, code: error.code },
      { accepted: false, code: expectedCode },
    );
  }
}

const created = store.create({
  actor: admin,
  connectionId: "connection-critic-lifecycle",
  owner: { kind: "workspace", id: scope.workspaceId },
  provider: "github",
  integration: "issues",
  label: "Critic lifecycle",
  metadata: { purpose: "independent-lifecycle" },
  secretRef: secretRef(1),
  idempotencyKey: "create-critic-lifecycle",
});
check("create-active-revision", created.connection.activeRevision, 1);

const capturedBeforeRotate = store.captureForRun({
  actor: member,
  connectionId: "connection-critic-lifecycle",
  runId: "run-critic-first",
});
const rotated = store.rotate({
  actor: admin,
  connectionId: "connection-critic-lifecycle",
  expectedRevision: 1,
  secretRef: secretRef(2),
  idempotencyKey: "rotate-critic-lifecycle",
});
const capturedSameRunAfterRotate = store.captureForRun({
  actor: member,
  connectionId: "connection-critic-lifecycle",
  runId: "run-critic-first",
});
const capturedAfterRotate = store.captureForRun({
  actor: member,
  connectionId: "connection-critic-lifecycle",
  runId: "run-critic-second",
});
check("rotation-advances-revision", rotated.connection.activeRevision, 2);
check("existing-run-keeps-revision", capturedSameRunAfterRotate.revision, 1);
check(
  "existing-run-keeps-binding",
  capturedSameRunAfterRotate.bindingDigest,
  capturedBeforeRotate.bindingDigest,
);
check("new-run-gets-revision", capturedAfterRotate.revision, 2);
check(
  "new-run-has-different-binding",
  capturedAfterRotate.bindingDigest !== capturedBeforeRotate.bindingDigest,
  true,
);

const beforeStale = store.events().length;
expectError(
  "stale-rotation-is-fenced",
  () =>
    store.rotate({
      actor: admin,
      connectionId: "connection-critic-lifecycle",
      expectedRevision: 1,
      secretRef: secretRef(3),
      idempotencyKey: "rotate-critic-stale",
    }),
  CONNECTION_ERROR_CODES.REVISION_CONFLICT,
);
check("stale-rotation-does-not-append", store.events().length, beforeStale);

store.disable({
  actor: admin,
  connectionId: "connection-critic-lifecycle",
  reason: "maintenance",
  idempotencyKey: "disable-critic-lifecycle",
});
expectError(
  "disabled-connection-fences-new-grant",
  () =>
    store.captureForRun({
      actor: member,
      connectionId: "connection-critic-lifecycle",
      runId: "run-critic-after-disable",
    }),
  CONNECTION_ERROR_CODES.NOT_ACTIVE,
);
store.delete({
  actor: admin,
  connectionId: "connection-critic-lifecycle",
  reason: "retired",
  idempotencyKey: "delete-critic-lifecycle",
});
const deletedView = store.read({
  actor: member,
  connectionId: "connection-critic-lifecycle",
});
check(
  "delete-records-tombstone",
  {
    status: deletedView.status,
    tombstonePresent: Boolean(deletedView.tombstone),
  },
  { status: "deleted", tombstonePresent: true },
);
check(
  "captured-snapshot-survives-terminal-fence",
  {
    revision: capturedBeforeRotate.revision,
    secretRefRevision: capturedBeforeRotate.secretRef.revision,
  },
  { revision: 1, secretRefRevision: 1 },
);
expectError(
  "deleted-connection-fences-new-grant",
  () =>
    store.captureForRun({
      actor: member,
      connectionId: "connection-critic-lifecycle",
      runId: "run-critic-after-delete",
    }),
  CONNECTION_ERROR_CODES.NOT_ACTIVE,
);
expectError(
  "deleted-connection-fences-rotation",
  () =>
    store.rotate({
      actor: admin,
      connectionId: "connection-critic-lifecycle",
      expectedRevision: 2,
      secretRef: secretRef(3),
      idempotencyKey: "rotate-critic-after-delete",
    }),
  CONNECTION_ERROR_CODES.NOT_ACTIVE,
);

const events = store.events();
const replayed = replayConnectionEvents([...events, ...events].reverse());
check(
  "duplicate-reordered-replay-state",
  replayed.stateDigest,
  store.stateDigest(),
);
check(
  "duplicate-reordered-replay-view",
  canonicalSha256(replayed.connections),
  canonicalSha256(store.snapshot().connections),
);
check(
  "replay-applies-one-copy",
  replayed.appliedEventIds.length,
  events.length,
);

const foreign = {
  tenantId: "tenant-foreign-critic-lifecycle",
  workspaceId: "workspace-foreign-critic-lifecycle",
  id: "admin-foreign-critic-lifecycle",
  kind: "user",
  role: "admin",
};
const digestBeforeAuthz = store.stateDigest();
let foreignError;
let unknownError;
try {
  store.read({ actor: foreign, connectionId: "connection-critic-lifecycle" });
} catch (error) {
  foreignError = error.toJSON();
}
try {
  store.read({ actor: member, connectionId: "connection-critic-unknown" });
} catch (error) {
  unknownError = error.toJSON();
}
check("foreign-and-unknown-errors-match", foreignError, unknownError);
check("authz-probes-do-not-move-state", store.stateDigest(), digestBeforeAuthz);

const result = {
  schemaVersion: 1,
  task: "E5-T02",
  fixture:
    "independent lifecycle with new tenant, workspace, connection, and run ids",
  eventCount: events.length,
  stateDigest: store.stateDigest(),
  observations,
  findingCount: findings.length,
  findings,
  canaryValuesPersisted: false,
};
await writeFile(
  new URL("./independent-lifecycle.json", evidenceDirectory),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    eventCount: result.eventCount,
    findingCount: result.findingCount,
  }),
);
process.exitCode = findings.length === 0 ? 0 : 1;
