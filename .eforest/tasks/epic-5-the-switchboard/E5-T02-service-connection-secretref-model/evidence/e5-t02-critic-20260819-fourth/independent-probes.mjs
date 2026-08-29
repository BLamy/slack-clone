import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONNECTION_ERROR_CODES,
  canonicalSha256,
  createConnectionStore,
  normalizeConnectionEvent,
  normalizeOpaqueIdForStore,
  normalizeOwner,
  normalizePrincipal,
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

const SCOPE = Object.freeze({
  tenantId: "tenant-critic-fourth",
  workspaceId: "workspace-critic-fourth",
});
const ADMIN = Object.freeze({
  ...SCOPE,
  id: "user-critic-admin",
  kind: "user",
  role: "admin",
});
const MEMBER = Object.freeze({
  ...SCOPE,
  id: "user-critic-member",
  kind: "user",
  role: "member",
});
const providerPrefix = ["g", "h", "p", "_"].join("");
const providerShape = providerPrefix + "A".repeat(32);
const neutralPlain = ["neutral", "opaque", "fourth", "value"].join("-");
const neutralBase64 = Buffer.from(neutralPlain).toString("base64");
const encodedProviderShape = Buffer.from(providerShape).toString("base64");

function ref(revision) {
  return {
    schemaVersion: 1,
    id: "secretref-critic-fourth-" + String(revision).padStart(3, "0"),
    provider: "infisical",
    mount: "production",
    revision,
    label: "critic",
  };
}

function makeStore() {
  let now = Date.parse("2026-08-19T23:00:00.000Z");
  return createConnectionStore({
    ...SCOPE,
    clock: () => new Date((now += 1000)),
  });
}

function attempt(action) {
  try {
    return { accepted: true, value: action() };
  } catch (error) {
    return {
      accepted: false,
      error: {
        code: error?.code ?? null,
        detail: error?.detail ?? null,
        path: error?.path ?? null,
        statusCode: error?.statusCode ?? null,
      },
    };
  }
}

function createWithMetadata(metadata, suffix) {
  const store = makeStore();
  const before = store.events().length;
  const result = attempt(() =>
    store.create({
      actor: ADMIN,
      connectionId: "connection-metadata-fourth-" + suffix,
      owner: { kind: "workspace", id: SCOPE.workspaceId },
      provider: "github",
      integration: "issues",
      label: "Metadata probe",
      metadata,
      secretRef: ref(1),
      idempotencyKey: "create-metadata-fourth-" + suffix,
    }),
  );
  return {
    accepted: result.accepted,
    error: result.error ?? null,
    appendedBefore: before,
    appendedAfter: store.events().length,
  };
}

function baseCreatedEvent() {
  return {
    schemaVersion: 1,
    eventId: "event-critic-fourth-base",
    eventType: "connection.created",
    workspaceId: SCOPE.workspaceId,
    actorId: ADMIN.id,
    idempotencyKey: "create-event-critic-fourth",
    sequence: 1,
    serverTimestamp: "2026-08-19T23:00:00.137Z",
    connectionId: "connection-schema-critic-fourth",
    data: {
      connectionId: "connection-schema-critic-fourth",
      tenantId: SCOPE.tenantId,
      workspaceId: SCOPE.workspaceId,
      owner: { kind: "workspace", id: SCOPE.workspaceId },
      provider: "github",
      integration: "issues",
      label: "Schema probe",
      metadata: { purpose: "independent-review" },
      secretRef: ref(1),
      revision: 1,
    },
  };
}

function baseRotatedEvent() {
  return {
    schemaVersion: 1,
    eventId: "event-critic-fourth-rotate",
    eventType: "connection.rotated",
    workspaceId: SCOPE.workspaceId,
    actorId: ADMIN.id,
    idempotencyKey: "rotate-event-critic-fourth",
    sequence: 2,
    serverTimestamp: "2026-08-19T23:00:00.274Z",
    connectionId: "connection-schema-critic-fourth",
    data: {
      expectedRevision: 1,
      revision: 2,
      secretRef: ref(2),
    },
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
    if (key === "$defs") output.definitions = adaptSchemaForAjv6(nested);
    else output[key] = adaptSchemaForAjv6(nested);
  }
  return output;
}

async function publicSchemaProbe() {
  const rawSchema = JSON.parse(await readFile(schemaPath, "utf8"));
  const ajv = new Ajv({ allErrors: true, schemaId: "auto", strict: false });
  const validate = ajv.compile(adaptSchemaForAjv6(rawSchema));
  const validateEvent = (event) => {
    const accepted = validate(event);
    return {
      accepted,
      errorCount: validate.errors?.length ?? 0,
    };
  };

  const cases = {};
  const actor = baseRotatedEvent();
  actor.actorId = providerShape;
  cases["provider-prefix-identifier-actor"] = actor;
  const workspace = baseRotatedEvent();
  workspace.workspaceId = providerShape;
  cases["provider-prefix-identifier-workspace"] = workspace;
  for (const field of ["eventId", "idempotencyKey", "connectionId"]) {
    const event = baseRotatedEvent();
    event[field] = providerShape;
    cases["provider-prefix-opaque-" + field] = event;
  }
  const label = baseCreatedEvent();
  label.data.label = providerShape;
  cases["provider-prefix-label"] = label;
  const nestedKey = baseCreatedEvent();
  nestedKey.data.metadata = { nested: { ToKeN: "opaque" } };
  cases["nested-case-key"] = nestedKey;
  const nestedValue = baseCreatedEvent();
  nestedValue.data.metadata = {
    nested: { safe: providerPrefix.toUpperCase() + "a".repeat(32) },
  };
  cases["nested-case-value"] = nestedValue;
  const uppercaseUrl = baseCreatedEvent();
  uppercaseUrl.data.metadata = { endpoint: "HtTpS://example.invalid/fourth" };
  cases["uppercase-url"] = uppercaseUrl;
  const jsonSecret = baseCreatedEvent();
  jsonSecret.data.metadata = {
    payload: JSON.stringify({ ToKeN: "opaque" }),
  };
  cases["json-secret"] = jsonSecret;
  const recursiveMetadata = baseCreatedEvent();
  recursiveMetadata.data.metadata = {
    a: { b: { c: { safe: "HtTpS://example.invalid/nested" } } },
  };
  cases["recursive-metadata"] = recursiveMetadata;
  const recursiveArray = baseCreatedEvent();
  recursiveArray.data.metadata = {
    a: [{ b: { safe: providerPrefix.toUpperCase() + "a".repeat(32) } }],
  };
  cases["recursive-array-metadata"] = recursiveArray;
  const neutral = baseCreatedEvent();
  neutral.data.metadata = { encodedValue: neutralBase64 };
  cases["neutral-base64"] = neutral;
  const extraEvent = baseRotatedEvent();
  extraEvent.extra = "unsupported";
  cases["extra-event-field"] = extraEvent;
  const extraData = baseCreatedEvent();
  extraData.data.extra = "unsupported";
  cases["extra-created-data-field"] = extraData;
  const extraRef = baseCreatedEvent();
  extraRef.data.secretRef.extra = "unsupported";
  cases["extra-secretref-field"] = extraRef;

  const outcomes = Object.fromEntries(
    Object.entries(cases).map(([name, event]) => [name, validateEvent(event)]),
  );
  assert.equal(validateEvent(baseCreatedEvent()).accepted, true);
  for (const [name, outcome] of Object.entries(outcomes)) {
    assert.equal(
      outcome.accepted,
      false,
      name + " was accepted by public schema",
    );
  }
  return {
    validator: "Ajv 6 with in-memory $defs-to-definitions adaptation",
    baseline: validateEvent(baseCreatedEvent()),
    cases: outcomes,
  };
}

function runtimeBoundaryProbe() {
  const metadataCases = {
    "neutral-base64": { encodedValue: neutralBase64 },
    "direct-provider-token": { encodedValue: providerShape },
    "encoded-provider-token": { encodedValue: encodedProviderShape },
    "uppercase-url": { endpoint: "HtTpS://example.invalid/fourth" },
    "json-secret": { payload: JSON.stringify({ ToKeN: "opaque" }) },
    "nested-case-key": { nested: { ToKeN: "opaque" } },
    "nested-case-value": {
      nested: { safe: providerPrefix.toUpperCase() + "a".repeat(32) },
    },
  };
  const results = Object.fromEntries(
    Object.entries(metadataCases).map(([name, metadata]) => [
      name,
      createWithMetadata(metadata, name),
    ]),
  );
  for (const [name, result] of Object.entries(results)) {
    assert.equal(result.accepted, false, name + " was accepted at runtime");
    assert.equal(result.error.code, CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL);
    assert.equal(result.appendedBefore, 0);
    assert.equal(result.appendedAfter, 0);
  }

  const boundary = {};
  for (const field of [
    "eventId",
    "actorId",
    "workspaceId",
    "idempotencyKey",
    "connectionId",
  ]) {
    const event = baseRotatedEvent();
    event[field] = providerShape;
    const result = attempt(() => normalizeConnectionEvent(event));
    assert.equal(result.accepted, false, field + " event boundary accepted");
    assert.equal(result.error.code, CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL);
    boundary[field] = result.error;
  }

  const generatedStore = createConnectionStore({
    ...SCOPE,
    idFactory: (kind) =>
      kind === "connection-event"
        ? providerShape
        : kind + "-critic-fourth-generated",
  });
  const generatedBefore = generatedStore.events().length;
  const generated = attempt(() =>
    generatedStore.create({
      actor: ADMIN,
      connectionId: "connection-generated-boundary-fourth",
      owner: { kind: "workspace", id: SCOPE.workspaceId },
      provider: "github",
      integration: "issues",
      label: "Generated boundary",
      metadata: {},
      secretRef: ref(1),
      idempotencyKey: "generated-boundary-fourth",
    }),
  );
  assert.equal(generated.accepted, false);
  assert.equal(
    generated.error.code,
    CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL,
  );
  assert.equal(generatedStore.events().length, generatedBefore);

  return {
    metadata: results,
    eventBoundary: boundary,
    generatedEventId: {
      accepted: generated.accepted,
      error: generated.error,
      appendedBefore: generatedBefore,
      appendedAfter: generatedStore.events().length,
    },
  };
}

function lifecycleProbe() {
  const store = makeStore();
  store.create({
    actor: ADMIN,
    connectionId: "connection-stability-fourth",
    owner: { kind: "workspace", id: SCOPE.workspaceId },
    provider: "github",
    integration: "issues",
    label: "Stability probe",
    metadata: { purpose: "capture-stability" },
    secretRef: ref(1),
    idempotencyKey: "create-stability-fourth",
  });
  const first = store.captureForRun({
    actor: MEMBER,
    connectionId: "connection-stability-fourth",
    runId: "run-stable-fourth",
  });
  store.rotate({
    actor: ADMIN,
    connectionId: "connection-stability-fourth",
    expectedRevision: 1,
    secretRef: ref(2),
    idempotencyKey: "rotate-stability-fourth",
  });
  const afterRotate = store.captureForRun({
    actor: MEMBER,
    connectionId: "connection-stability-fourth",
    runId: "run-stable-fourth",
  });
  store.disable({
    actor: ADMIN,
    connectionId: "connection-stability-fourth",
    reason: "review",
    idempotencyKey: "disable-stability-fourth",
  });
  const afterDisable = store.captureForRun({
    actor: MEMBER,
    connectionId: "connection-stability-fourth",
    runId: "run-stable-fourth",
  });
  store.delete({
    actor: ADMIN,
    connectionId: "connection-stability-fourth",
    reason: "retired",
    idempotencyKey: "delete-stability-fourth",
  });
  const afterDelete = store.captureForRun({
    actor: MEMBER,
    connectionId: "connection-stability-fourth",
    runId: "run-stable-fourth",
  });
  const newAfterDisableOrDelete = attempt(() =>
    store.captureForRun({
      actor: MEMBER,
      connectionId: "connection-stability-fourth",
      runId: "run-new-after-delete-fourth",
    }),
  );
  assert.equal(first.revision, 1);
  assert.equal(afterRotate.revision, 1);
  assert.equal(afterDisable.revision, 1);
  assert.equal(afterDelete.revision, 1);
  assert.equal(first.bindingDigest, afterRotate.bindingDigest);
  assert.equal(first.bindingDigest, afterDisable.bindingDigest);
  assert.equal(first.bindingDigest, afterDelete.bindingDigest);
  assert.equal(newAfterDisableOrDelete.accepted, false);
  assert.equal(
    newAfterDisableOrDelete.error.code,
    CONNECTION_ERROR_CODES.NOT_ACTIVE,
  );

  const events = store.events();
  const replayInput = [...events, ...events].reverse();
  const replay = replayConnectionEvents(replayInput);
  const replayAgain = replayConnectionEvents(replayInput);
  assert.equal(replay.stateDigest, store.stateDigest());
  assert.equal(replay.stateDigest, replayAgain.stateDigest);
  assert.equal(replay.eventDigest, replayAgain.eventDigest);
  assert.deepEqual(replay.connections, replayAgain.connections);

  const staleStore = makeStore();
  staleStore.create({
    actor: ADMIN,
    connectionId: "connection-stale-fourth",
    owner: { kind: "workspace", id: SCOPE.workspaceId },
    provider: "github",
    integration: "issues",
    label: "Stale rotation",
    metadata: {},
    secretRef: ref(1),
    idempotencyKey: "create-stale-fourth",
  });
  staleStore.rotate({
    actor: ADMIN,
    connectionId: "connection-stale-fourth",
    expectedRevision: 1,
    secretRef: ref(2),
    idempotencyKey: "rotate-stale-success-fourth",
  });
  const staleBeforeCount = staleStore.events().length;
  const staleBeforeTerminal = attempt(() =>
    staleStore.rotate({
      actor: ADMIN,
      connectionId: "connection-stale-fourth",
      expectedRevision: 1,
      secretRef: ref(3),
      idempotencyKey: "rotate-stale-before-fourth",
    }),
  );
  assert.equal(staleBeforeTerminal.accepted, false);
  assert.equal(
    staleBeforeTerminal.error.code,
    CONNECTION_ERROR_CODES.REVISION_CONFLICT,
  );
  assert.equal(staleStore.events().length, staleBeforeCount);
  staleStore.disable({
    actor: ADMIN,
    connectionId: "connection-stale-fourth",
    reason: "review",
    idempotencyKey: "disable-stale-fourth",
  });
  const staleAfterCount = staleStore.events().length;
  const staleAfterTerminal = attempt(() =>
    staleStore.rotate({
      actor: ADMIN,
      connectionId: "connection-stale-fourth",
      expectedRevision: 2,
      secretRef: ref(3),
      idempotencyKey: "rotate-stale-after-fourth",
    }),
  );
  assert.equal(staleAfterTerminal.accepted, false);
  assert.equal(
    staleAfterTerminal.error.code,
    CONNECTION_ERROR_CODES.NOT_ACTIVE,
  );
  assert.equal(staleStore.events().length, staleAfterCount);

  return {
    revisions: {
      first: first.revision,
      afterRotate: afterRotate.revision,
      afterDisable: afterDisable.revision,
      afterDelete: afterDelete.revision,
    },
    bindingStableAcrossTerminalStates: true,
    newGrantAfterTerminal: newAfterDisableOrDelete.error,
    staleRotation: {
      beforeTerminal: staleBeforeTerminal.error,
      afterTerminal: staleAfterTerminal.error,
      beforeCount: staleBeforeCount,
      afterRejectedCount: staleStore.events().length,
    },
    replay: {
      duplicateInputCount: replayInput.length,
      stateDigest: replay.stateDigest,
      replayAgainStateDigest: replayAgain.stateDigest,
      eventDigest: replay.eventDigest,
      replayAgainEventDigest: replayAgain.eventDigest,
      viewDigest: canonicalSha256(replay.connections),
    },
  };
}

function collisionProbe() {
  const store = makeStore();
  for (const [connectionId, idempotencyKey] of [
    ["connection-critic-a:b", "create-collision-a-b-fourth"],
    ["connection-critic-a", "create-collision-a-fourth"],
  ]) {
    store.create({
      actor: ADMIN,
      connectionId,
      owner: { kind: "workspace", id: SCOPE.workspaceId },
      provider: "github",
      integration: "issues",
      label: "Collision probe",
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
  return {
    collisionAvoided: true,
    firstBinding: {
      connectionId: first.connectionId,
      runId: first.runId,
      revision: first.revision,
      bindingDigest: first.bindingDigest,
    },
    secondBinding: {
      connectionId: second.connectionId,
      runId: second.runId,
      revision: second.revision,
      bindingDigest: second.bindingDigest,
    },
  };
}

function apiIdentifierBoundaryProbe() {
  const lowerProviderShape = providerPrefix + "a".repeat(32);
  const normalizedStoreId = attempt(() =>
    normalizeOpaqueIdForStore(lowerProviderShape, "$.runId"),
  );
  const normalizedPrincipal = attempt(() =>
    normalizePrincipal({
      ...SCOPE,
      id: lowerProviderShape,
      kind: "user",
      role: "admin",
    }),
  );
  const principalWithProviderWorkspace = attempt(() =>
    normalizePrincipal({
      tenantId: SCOPE.tenantId,
      workspaceId: lowerProviderShape,
      id: "user-critic-fourth",
      kind: "user",
      role: "member",
    }),
  );
  const normalizedOwner = attempt(() =>
    normalizeOwner({ kind: "workspace", id: lowerProviderShape }),
  );
  const store = makeStore();
  store.create({
    actor: ADMIN,
    connectionId: "connection-api-id-fourth",
    owner: { kind: "workspace", id: SCOPE.workspaceId },
    provider: "github",
    integration: "issues",
    label: "API identifier probe",
    metadata: {},
    secretRef: ref(1),
    idempotencyKey: "create-api-id-fourth",
  });
  const captureEventCountBefore = store.events().length;
  const capture = attempt(() =>
    store.captureForRun({
      actor: ADMIN,
      connectionId: "connection-api-id-fourth",
      runId: lowerProviderShape,
    }),
  );
  const captureEventCountAfter = store.events().length;
  const authorizedWithProviderShape = attempt(() =>
    store.authorization({
      actor: {
        ...SCOPE,
        id: lowerProviderShape,
        kind: "user",
        role: "admin",
      },
      connectionId: "connection-api-id-fourth",
    }),
  );
  assert.equal(normalizedStoreId.accepted, true);
  assert.equal(normalizedPrincipal.accepted, true);
  assert.equal(principalWithProviderWorkspace.accepted, true);
  assert.equal(normalizedOwner.accepted, true);
  assert.equal(capture.accepted, true);
  assert.equal(capture.value.runId, lowerProviderShape);
  assert.equal(authorizedWithProviderShape.accepted, true);
  assert.equal(authorizedWithProviderShape.value.allowed, true);
  return {
    result: "REFUTED",
    shape: "lowercase provider-token prefix plus 32-character body",
    accepted: {
      normalizeOpaqueIdForStore: normalizedStoreId.accepted,
      normalizePrincipalId: normalizedPrincipal.accepted,
      normalizePrincipalWorkspaceId: principalWithProviderWorkspace.accepted,
      normalizeOwnerId: normalizedOwner.accepted,
      captureForRun: capture.accepted,
      authorizationWithProviderShapedActor:
        authorizedWithProviderShape.value.allowed,
    },
    capturedRunIdMatchesSubmittedShape:
      capture.value.runId === lowerProviderShape,
    captureEventCountBefore,
    captureEventCountAfter,
    source: [
      "packages/connections/src/schema.mjs:190-283",
      "packages/connections/src/schema.mjs:720-733",
      "packages/connections/src/store.mjs:166-219",
      "packages/connections/src/store.mjs:378-393",
    ],
  };
}

function authorizationProbe() {
  const store = makeStore();
  store.create({
    actor: ADMIN,
    connectionId: "connection-auth-fourth",
    owner: { kind: "workspace", id: SCOPE.workspaceId },
    provider: "github",
    integration: "issues",
    label: "Authorization probe",
    metadata: {},
    secretRef: ref(1),
    idempotencyKey: "create-auth-fourth",
  });
  const foreign = {
    ...ADMIN,
    tenantId: "tenant-foreign-fourth",
    workspaceId: "workspace-foreign-fourth",
  };
  const operations = {
    read: () =>
      store.read({ actor: foreign, connectionId: "connection-auth-fourth" }),
    grant: () =>
      store.captureForRun({
        actor: foreign,
        connectionId: "connection-auth-fourth",
        runId: "run-foreign-fourth",
      }),
    rotate: () =>
      store.rotate({
        actor: foreign,
        connectionId: "connection-auth-fourth",
        expectedRevision: 1,
        secretRef: ref(2),
        idempotencyKey: "rotate-foreign-fourth",
      }),
    disable: () =>
      store.disable({
        actor: foreign,
        connectionId: "connection-auth-fourth",
        idempotencyKey: "disable-foreign-fourth",
      }),
    delete: () =>
      store.delete({
        actor: foreign,
        connectionId: "connection-auth-fourth",
        idempotencyKey: "delete-foreign-fourth",
      }),
  };
  const before = store.stateDigest();
  const foreignErrors = {};
  const unknownErrors = {};
  for (const [operation, action] of Object.entries(operations)) {
    const foreignResult = attempt(action);
    assert.equal(foreignResult.accepted, false);
    assert.equal(foreignResult.error.code, CONNECTION_ERROR_CODES.NOT_FOUND);
    foreignErrors[operation] = foreignResult.error;
    const unknownInput = {
      actor: foreign,
      connectionId: "connection-unknown-fourth",
    };
    if (operation === "grant") unknownInput.runId = "run-unknown-fourth";
    if (operation === "rotate") {
      unknownInput.expectedRevision = 1;
      unknownInput.secretRef = ref(2);
      unknownInput.idempotencyKey = "rotate-unknown-fourth";
    }
    if (operation === "disable" || operation === "delete") {
      unknownInput.idempotencyKey = operation + "-unknown-fourth";
    }
    const unknownAction =
      operation === "read"
        ? () => store.read(unknownInput)
        : operation === "grant"
          ? () => store.captureForRun(unknownInput)
          : operation === "rotate"
            ? () => store.rotate(unknownInput)
            : operation === "disable"
              ? () => store.disable(unknownInput)
              : () => store.delete(unknownInput);
    const unknownResult = attempt(unknownAction);
    assert.equal(unknownResult.accepted, false);
    assert.equal(unknownResult.error.code, CONNECTION_ERROR_CODES.NOT_FOUND);
    unknownErrors[operation] = unknownResult.error;
  }
  assert.deepEqual(foreignErrors, unknownErrors);
  assert.equal(store.stateDigest(), before);
  assert.equal(store.events().length, 1);
  return {
    foreignErrors,
    unknownErrors,
    equal: JSON.stringify(foreignErrors) === JSON.stringify(unknownErrors),
    stateDigestBefore: before,
    stateDigestAfter: store.stateDigest(),
    eventCount: store.events().length,
  };
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(fullPath)));
    else files.push(fullPath);
  }
  return files.sort();
}

async function scanForNeedles(needles) {
  const files = await listFiles(here);
  const findings = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const needle of needles) {
      if (content.includes(needle)) {
        findings.push({ file: path.relative(here, file), needle });
      }
    }
  }
  return { files, findings };
}

async function evidenceProbe() {
  const marker = ["critic", "fourth", "transient", "marker"].join("-");
  const temporary = path.join(here, ".independent-canary.tmp");
  await writeFile(temporary, marker + "\n" + providerShape + "\n");
  const transient = await scanForNeedles([marker, providerShape]);
  await unlink(temporary);
  const persistentBeforeResult = await scanForNeedles([marker, providerShape]);
  assert.equal(transient.findings.length >= 2, true);
  assert.equal(persistentBeforeResult.findings.length, 0);
  return {
    transientDetected: transient.findings.length >= 2,
    persistentMarkerLeak: persistentBeforeResult.findings.some(
      ({ needle }) => needle === marker,
    ),
    persistentProviderShapeLeak: persistentBeforeResult.findings.some(
      ({ needle }) => needle === providerShape,
    ),
    filesChecked: persistentBeforeResult.files.map((file) =>
      path.relative(here, file),
    ),
  };
}

const result = {
  schemaVersion: 1,
  task: "E5-T02",
  criticHead: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  publicSchema: await publicSchemaProbe(),
  runtimeBoundary: runtimeBoundaryProbe(),
  lifecycle: lifecycleProbe(),
  captureKeyCollision: collisionProbe(),
  apiIdentifierBoundary: apiIdentifierBoundaryProbe(),
  authorization: authorizationProbe(),
  evidence: await evidenceProbe(),
};

await writeFile(
  path.join(here, "independent-probes.json"),
  JSON.stringify(result, null, 2) + "\n",
);
const finalEvidenceScan = await scanForNeedles([
  ["critic", "fourth", "transient", "marker"].join("-"),
  providerShape,
]);
assert.equal(finalEvidenceScan.findings.length, 0);
result.evidence.finalFilesChecked = finalEvidenceScan.files.map((file) =>
  path.relative(here, file),
);
await writeFile(
  path.join(here, "independent-probes.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
