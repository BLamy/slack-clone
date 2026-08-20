import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONNECTION_ERROR_CODES,
  canonicalSha256,
  createConnectionStore,
  normalizeConnectionEvent,
  normalizeSecretRef,
  replayConnectionEvents,
} from "@stream-slack/connections";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../../../../");
const schemaPath = path.join(
  root,
  "packages/connections/src/schemas/connection-events.v1.schema.json",
);
const require = createRequire(import.meta.url);
const Ajv = require(
  path.join(root, "node_modules/.pnpm/ajv@6.15.0/node_modules/ajv"),
);

const scope = Object.freeze({
  tenantId: "tenant-critic-third",
  workspaceId: "workspace-critic-third",
});
const admin = Object.freeze({
  ...scope,
  id: "user-critic-admin",
  kind: "user",
  role: "admin",
});
const member = Object.freeze({
  ...scope,
  id: "user-critic-member",
  kind: "user",
  role: "member",
});
const foreign = Object.freeze({
  tenantId: "tenant-critic-foreign",
  workspaceId: "workspace-critic-foreign",
  id: "user-critic-foreign",
  kind: "user",
  role: "admin",
});
const providerPrefix = ["g", "h", "p", "_"].join("");
const providerShape = providerPrefix + "a".repeat(32);
const marker = ["independent", "marker", "third"].join("-");

function ref(revision, suffix = "") {
  return {
    schemaVersion: 1,
    id: "secretref-critic-third-" + String(revision).padStart(3, "0") + suffix,
    provider: "infisical",
    mount: "production",
    revision,
    label: "critic",
  };
}

function makeStore(seed = 0) {
  let now = Date.parse("2026-08-19T22:00:00.000Z") + seed;
  let id = 0;
  return createConnectionStore({
    ...scope,
    clock: () => new Date((now += 137)),
    idFactory: (kind) => {
      id += 1;
      return kind + "-critic-third-" + String(id).padStart(4, "0");
    },
  });
}

function createWorkspaceConnection(store, connectionId, revision = 1) {
  return store.create({
    actor: admin,
    connectionId,
    owner: { kind: "workspace", id: scope.workspaceId },
    provider: "github",
    integration: "issues",
    label: "Critic connection",
    metadata: { purpose: "independent-review" },
    secretRef: ref(revision),
    idempotencyKey: "create-" + connectionId,
  });
}

function errorSummary(error) {
  return {
    code: error?.code ?? null,
    path: error?.path ?? null,
    statusCode: error?.statusCode ?? null,
  };
}

function attempt(operation) {
  try {
    return { accepted: true, value: operation() };
  } catch (error) {
    return { accepted: false, error: errorSummary(error) };
  }
}

function baseCreatedEvent() {
  return {
    schemaVersion: 1,
    eventId: "event-critic-third-base",
    eventType: "connection.created",
    workspaceId: scope.workspaceId,
    actorId: admin.id,
    idempotencyKey: "create-event-critic-third",
    sequence: 1,
    serverTimestamp: "2026-08-19T22:00:00.137Z",
    connectionId: "connection-schema-critic-third",
    data: {
      connectionId: "connection-schema-critic-third",
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      owner: { kind: "workspace", id: scope.workspaceId },
      provider: "github",
      integration: "issues",
      label: "Schema probe",
      metadata: { purpose: "independent-review" },
      secretRef: ref(1),
      revision: 1,
    },
  };
}

function baseRotatedEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: "event-critic-third-rotate",
    eventType: "connection.rotated",
    workspaceId: scope.workspaceId,
    actorId: admin.id,
    idempotencyKey: "rotate-event-critic-third",
    sequence: 2,
    serverTimestamp: "2026-08-19T22:00:00.274Z",
    connectionId: "connection-schema-critic-third",
    data: {
      expectedRevision: 1,
      revision: 2,
      secretRef: ref(2),
    },
    ...overrides,
  };
}

function adaptSchemaForAjv6(value) {
  if (Array.isArray(value)) return value.map(adaptSchemaForAjv6);
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") {
      return value.replaceAll("#/$defs/", "#/definitions/");
    }
    return value;
  }
  const output = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "$schema" || key === "$id") continue;
    if (key === "$defs") {
      output.definitions = adaptSchemaForAjv6(nested);
    } else {
      output[key] = adaptSchemaForAjv6(nested);
    }
  }
  return output;
}

async function schemaProbe() {
  const rawSchema = JSON.parse(await readFile(schemaPath, "utf8"));
  const ajv = new Ajv({ allErrors: true, schemaId: "auto", strict: false });
  const validate = ajv.compile(adaptSchemaForAjv6(rawSchema));
  const validateEvent = (event) => {
    const valid = validate(event);
    return {
      accepted: valid,
      errorCount: valid ? 0 : (validate.errors ?? []).length,
    };
  };
  const nestedCaseKey = baseCreatedEvent();
  nestedCaseKey.data.metadata = { nested: { ToKeN: "opaque" } };
  const nestedCaseValue = baseCreatedEvent();
  nestedCaseValue.data.metadata = { nested: { safe: "GHP_" + "a".repeat(32) } };
  const upperUrl = baseCreatedEvent();
  upperUrl.data.metadata = { endpoint: "HtTpS://example.invalid/review" };
  const jsonSecret = baseCreatedEvent();
  jsonSecret.data.metadata = {
    payload: JSON.stringify({ ToKeN: "opaque" }),
  };
  const providerValue = baseCreatedEvent();
  providerValue.data.metadata = { safe: "GHP_" + "a".repeat(32) };
  const labelShape = baseCreatedEvent();
  labelShape.data.label = providerShape;
  const recursiveSecret = baseCreatedEvent();
  recursiveSecret.data.metadata = {
    a: { b: { c: { safe: "HtTpS://example.invalid/nested" } } },
  };
  const nestedArray = baseCreatedEvent();
  nestedArray.data.metadata = {
    a: [{ b: { safe: "GHP_" + "a".repeat(32) } }],
  };
  const neutralBase64 = baseCreatedEvent();
  neutralBase64.data.metadata = {
    encodedValue: Buffer.from(marker + "-value").toString("base64"),
  };
  const opaqueEventId = baseRotatedEvent({ eventId: providerShape });
  const opaqueIdempotency = baseRotatedEvent({ idempotencyKey: providerShape });
  const opaqueConnection = baseRotatedEvent({ connectionId: providerShape });
  const identifierActor = baseRotatedEvent({ actorId: providerShape });
  const identifierWorkspace = baseRotatedEvent({ workspaceId: providerShape });
  const extraEvent = baseRotatedEvent({ extra: "unsupported" });
  const extraData = baseCreatedEvent();
  extraData.data.extra = "unsupported";
  const extraRef = baseCreatedEvent();
  extraRef.data.secretRef.extra = "unsupported";
  const cases = [
    ["nested-case-key", nestedCaseKey],
    ["nested-case-value", nestedCaseValue],
    ["uppercase-url", upperUrl],
    ["json-secret", jsonSecret],
    ["provider-prefix-value", providerValue],
    ["provider-prefix-label", labelShape],
    ["recursive-metadata", recursiveSecret],
    ["recursive-array-metadata", nestedArray],
    ["neutral-base64", neutralBase64],
    ["provider-prefix-opaque-event-id", opaqueEventId],
    ["provider-prefix-opaque-idempotency", opaqueIdempotency],
    ["provider-prefix-opaque-connection", opaqueConnection],
    ["provider-prefix-identifier-actor", identifierActor],
    ["provider-prefix-identifier-workspace", identifierWorkspace],
    ["extra-event-field", extraEvent],
    ["extra-created-data-field", extraData],
    ["extra-secretref-field", extraRef],
  ];
  return {
    validator: "Ajv 6 with in-memory $defs-to-definitions adaptation",
    baseline: validateEvent(baseCreatedEvent()),
    cases: Object.fromEntries(cases.map(([name, event]) => [name, validateEvent(event)])),
  };
}

function runtimeEnvelopeProbe() {
  const fields = ["eventId", "actorId", "idempotencyKey", "connectionId"];
  const outcomes = {};
  for (const field of fields) {
    const event = baseRotatedEvent({ [field]: providerShape });
    outcomes[field] = attempt(() => normalizeConnectionEvent(event));
    delete outcomes[field].value;
  }
  const injectedFactoryStore = createConnectionStore({
    ...scope,
    idFactory: (kind) =>
      kind === "connection-event"
        ? providerShape
        : kind + "-critic-third-event-boundary",
  });
  const before = injectedFactoryStore.events().length;
  const createAttempt = attempt(() =>
    injectedFactoryStore.create({
      actor: admin,
      connectionId: "connection-event-boundary-third",
      owner: { kind: "workspace", id: scope.workspaceId },
      provider: "github",
      integration: "issues",
      label: "Event boundary",
      metadata: {},
      secretRef: ref(1),
      idempotencyKey: "create-event-boundary-third",
    }),
  );
  return {
    fields: Object.fromEntries(
      Object.entries(outcomes).map(([field, outcome]) => [field, {
        accepted: outcome.accepted,
        error: outcome.error ?? null,
      }]),
    ),
    generatedEventId: {
      accepted: createAttempt.accepted,
      error: createAttempt.error ?? null,
      appendedBefore: before,
      appendedAfter: injectedFactoryStore.events().length,
    },
  };
}

function metadataBoundaryProbe() {
  const attacks = [
    ["neutral-base64", { encodedValue: Buffer.from(marker + "-value").toString("base64") }],
    ["provider-base64", { encodedValue: Buffer.from(providerShape).toString("base64") }],
    ["json-case-secret", { payload: JSON.stringify({ ToKeN: marker }) }],
    ["uppercase-url", { endpoint: "HtTpS://user:password@example.invalid/third" }],
    [
      "multiline-key",
      {
        material: [
          "-----BEGIN ",
          "RSA PRIVATE KEY",
          "-----\nredacted\n-----END ",
          "RSA PRIVATE KEY",
          "-----",
        ].join(""),
      },
    ],
    [
      "confusable-key",
      { [[String.fromCodePoint(0x03bf), "ken"].join("")]: marker },
    ],
    [
      "nested-cookie",
      { nested: { headers: { [["coo", "kie"].join("")]: "session=" + "r".repeat(16) } } },
    ],
    [
      "connection-string",
      { dsn: ["host=db.invalid", "user=app", "password=" + "r".repeat(16)].join(";") },
    ],
  ];
  const store = makeStore(41);
  const results = {};
  for (const [name, metadata] of attacks) {
    const before = store.events().length;
    const result = attempt(() => store.create({
      actor: admin,
      connectionId: "connection-metadata-third-" + name,
      owner: { kind: "workspace", id: scope.workspaceId },
      provider: "github",
      integration: "issues",
      label: "Metadata probe",
      metadata,
      secretRef: ref(1),
      idempotencyKey: "metadata-third-" + name,
    }));
    results[name] = {
      accepted: result.accepted,
      error: result.error ?? null,
      appendedBefore: before,
      appendedAfter: store.events().length,
    };
  }
  const eventBytes = JSON.stringify(store.events());
  const encodedMarker = Buffer.from(marker + "-value").toString("base64");
  const encodedProviderShape = Buffer.from(providerShape).toString("base64");
  return {
    results,
    appendedEvents: store.events().length,
    markerPersisted:
      eventBytes.includes(marker) ||
      eventBytes.includes(providerShape) ||
      eventBytes.includes(encodedMarker) ||
      eventBytes.includes(encodedProviderShape),
  };
}

function lifecycleProbe() {
  const store = makeStore(79);
  const connectionId = "connection-lifecycle-third";
  createWorkspaceConnection(store, connectionId);
  const first = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-lifecycle-third",
  });
  const rotated = store.rotate({
    actor: admin,
    connectionId,
    expectedRevision: 1,
    secretRef: ref(2),
    idempotencyKey: "rotate-lifecycle-third",
  });
  const secondRun = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-lifecycle-third-new",
  });
  const sameRun = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-lifecycle-third",
  });
  const staleBeforeTerminalCount = store.events().length;
  const staleBeforeTerminal = attempt(() => store.rotate({
    actor: admin,
    connectionId,
    expectedRevision: 1,
    secretRef: ref(3),
    idempotencyKey: "rotate-stale-third",
  }));
  const staleBeforeTerminalUnchanged =
    store.events().length === staleBeforeTerminalCount;
  store.disable({
    actor: admin,
    connectionId,
    reason: "review",
    idempotencyKey: "disable-lifecycle-third",
  });
  const sameAfterDisable = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-lifecycle-third",
  });
  const newAfterDisable = attempt(() => store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-after-disable-third",
  }));
  const staleAfterDisableCount = store.events().length;
  const staleAfterDisable = attempt(() => store.rotate({
    actor: admin,
    connectionId,
    expectedRevision: 2,
    secretRef: ref(3),
    idempotencyKey: "rotate-disabled-third",
  }));
  const staleAfterDisableUnchanged = store.events().length === staleAfterDisableCount;
  store.delete({
    actor: admin,
    connectionId,
    reason: "retired",
    idempotencyKey: "delete-lifecycle-third",
  });
  const sameAfterDelete = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-lifecycle-third",
  });
  const newAfterDelete = attempt(() => store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-after-delete-third",
  }));
  const staleAfterDeleteCount = store.events().length;
  const staleAfterDelete = attempt(() => store.rotate({
    actor: admin,
    connectionId,
    expectedRevision: 2,
    secretRef: ref(3),
    idempotencyKey: "rotate-deleted-third",
  }));
  const staleAfterDeleteUnchanged = store.events().length === staleAfterDeleteCount;
  const view = store.read({ actor: member, connectionId });
  const duplicatedReordered = [...store.events(), ...store.events()].reverse();
  const replayOne = replayConnectionEvents(duplicatedReordered);
  const replayTwo = replayConnectionEvents(duplicatedReordered);
  return {
    revisions: {
      first: first.revision,
      secondRun: secondRun.revision,
      sameRun: sameRun.revision,
      sameRunAfterDisable: sameAfterDisable.revision,
      sameRunAfterDelete: sameAfterDelete.revision,
      activeAfterRotate: rotated.connection.activeRevision,
    },
    sameRunStable: first.bindingDigest === sameRun.bindingDigest,
    priorRunPreservedThroughTerminals:
      first.bindingDigest === sameAfterDisable.bindingDigest &&
      first.bindingDigest === sameAfterDelete.bindingDigest,
    newGrantAfterDisable: {
      accepted: newAfterDisable.accepted,
      error: newAfterDisable.error ?? null,
    },
    newGrantAfterDelete: {
      accepted: newAfterDelete.accepted,
      error: newAfterDelete.error ?? null,
    },
    staleRotation: {
      beforeTerminal: {
        accepted: staleBeforeTerminal.accepted,
        error: staleBeforeTerminal.error ?? null,
        noAppend: staleBeforeTerminalUnchanged,
      },
      afterDisable: {
        accepted: staleAfterDisable.accepted,
        error: staleAfterDisable.error ?? null,
        noAppend: staleAfterDisableUnchanged,
      },
      afterDelete: {
        accepted: staleAfterDelete.accepted,
        error: staleAfterDelete.error ?? null,
        noAppend: staleAfterDeleteUnchanged,
      },
    },
    tombstone: {
      status: view.status,
      hasTombstone: Boolean(view.tombstone),
      reason: view.tombstone?.reason ?? null,
    },
    replay: {
      duplicateInputCount: duplicatedReordered.length,
      stateDigest: replayOne.stateDigest,
      secondStateDigest: replayTwo.stateDigest,
      eventDigest: replayOne.eventDigest,
      secondEventDigest: replayTwo.eventDigest,
      stateEqual: replayOne.stateDigest === replayTwo.stateDigest,
      viewDigest: canonicalSha256(replayOne.connections),
      secondViewDigest: canonicalSha256(replayTwo.connections),
    },
  };
}

function collisionProbe() {
  const store = makeStore(113);
  const firstConnection = "connection-critic-a:b";
  const secondConnection = "connection-critic-a";
  createWorkspaceConnection(store, firstConnection);
  createWorkspaceConnection(store, secondConnection);
  const firstCapture = store.captureForRun({
    actor: member,
    connectionId: firstConnection,
    runId: "run-critic-c",
  });
  const collision = attempt(() => store.captureForRun({
    actor: member,
    connectionId: secondConnection,
    runId: "b:run-critic-c",
  }));
  return {
    firstBinding: {
      connectionId: firstCapture.connectionId,
      runId: firstCapture.runId,
      revision: firstCapture.revision,
    },
    secondRequest: {
      connectionId: secondConnection,
      runId: "b:run-critic-c",
    },
    returnedBinding: collision.accepted
      ? {
          connectionId: collision.value.connectionId,
          runId: collision.value.runId,
          revision: collision.value.revision,
        }
      : null,
    collisionDetected:
      collision.accepted && collision.value.connectionId !== secondConnection,
  };
}

function authzProbe() {
  const store = makeStore(151);
  const connectionId = "connection-authz-third";
  createWorkspaceConnection(store, connectionId);
  const operations = {
    read: () => store.read({ actor: foreign, connectionId }),
    grant: () => store.captureForRun({
      actor: foreign,
      connectionId,
      runId: "run-foreign-third",
    }),
    rotate: () => store.rotate({
      actor: foreign,
      connectionId,
      expectedRevision: 1,
      secretRef: ref(2),
      idempotencyKey: "rotate-foreign-third",
    }),
    disable: () => store.disable({
      actor: foreign,
      connectionId,
      idempotencyKey: "disable-foreign-third",
    }),
    delete: () => store.delete({
      actor: foreign,
      connectionId,
      idempotencyKey: "delete-foreign-third",
    }),
  };
  const before = store.stateDigest();
  const foreignResults = {};
  const unknownResults = {};
  for (const [operation, call] of Object.entries(operations)) {
    foreignResults[operation] = attempt(call).error;
    const unknownInput = { actor: foreign, connectionId: "connection-unknown-third" };
    if (operation === "grant") unknownInput.runId = "run-unknown-third";
    if (operation === "rotate") {
      unknownInput.expectedRevision = 1;
      unknownInput.secretRef = ref(2);
      unknownInput.idempotencyKey = "rotate-unknown-third";
    }
    if (operation === "disable" || operation === "delete") {
      unknownInput.idempotencyKey = operation + "-unknown-third";
    }
    const unknownCall =
      operation === "read"
        ? () => store.read(unknownInput)
        : operation === "grant"
          ? () => store.captureForRun(unknownInput)
          : operation === "rotate"
            ? () => store.rotate(unknownInput)
            : operation === "disable"
              ? () => store.disable(unknownInput)
              : () => store.delete(unknownInput);
    unknownResults[operation] = attempt(unknownCall).error;
  }
  return {
    foreignResults,
    unknownResults,
    equal: JSON.stringify(foreignResults) === JSON.stringify(unknownResults),
    stateDigestBefore: before,
    stateDigestAfter: store.stateDigest(),
    unchanged: before === store.stateDigest(),
  };
}

async function evidenceProbe() {
  const transient = path.join(here, ".independent-marker-transient");
  await writeFile(transient, marker + "\n");
  let transientDetected = false;
  try {
    const content = await readFile(transient, "utf8");
    transientDetected = content.includes(marker);
  } finally {
    await unlink(transient);
  }
  const files = await listFiles(here);
  const persistentContents = await Promise.all(files.map((file) => readFile(file, "utf8")));
  return {
    transientDetectorSawMarker: transientDetected,
    persistentMarkerLeak: persistentContents.some((content) => content.includes(marker)),
    persistentProviderShapeLeak: persistentContents.some((content) => content.includes(providerShape)),
    checkedFiles: files.map((file) => path.relative(here, file)).sort(),
  };
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else files.push(full);
  }
  return files;
}

const result = {
  schemaVersion: 1,
  task: "E5-T02",
  probeSeed: 20260819,
  runtimeEnvelope: runtimeEnvelopeProbe(),
  publicSchema: await schemaProbe(),
  metadataBoundary: metadataBoundaryProbe(),
  lifecycle: lifecycleProbe(),
  captureKeyCollision: collisionProbe(),
  "authorization": authzProbe(),
  evidence: await evidenceProbe(),
};

assert.equal(result.runtimeEnvelope.generatedEventId.appendedAfter, 0);
await writeFile(
  path.join(here, "independent-probes.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify({
  task: result.task,
  schemaActorAccepted: result.publicSchema.cases["provider-prefix-identifier-actor"].accepted,
  captureKeyCollisionDetected: result.captureKeyCollision.collisionDetected,
  metadataAppendedEvents: result.metadataBoundary.appendedEvents,
  evidenceMarkerLeak: result.evidence.persistentMarkerLeak,
  evidenceProviderShapeLeak: result.evidence.persistentProviderShapeLeak,
}));
