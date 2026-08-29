import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CONNECTION_ERROR_CODES,
  canonicalSha256,
  createConnectionStore,
  isCredentialMaterial,
  normalizeConnectionDefinition,
  normalizeConnectionEvent,
  normalizeMetadata,
  normalizeOpaqueIdForStore,
  normalizeOwner,
  normalizePrincipal,
  normalizeReason,
  normalizeSecretRef,
  replayConnectionEvents,
} from "@stream-slack/connections";

const root = process.cwd();
const evidenceDirectory = path.dirname(fileURLToPath(import.meta.url));
const exactHead = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const scope = Object.freeze({
  tenantId: "tenant-independent",
  workspaceId: "workspace-independent",
});
const admin = Object.freeze({
  ...scope,
  id: "user-admin",
  kind: "user",
  role: "admin",
});
const member = Object.freeze({
  ...scope,
  id: "user-member",
  kind: "user",
  role: "member",
});
const failures = [];

const providerShape = String.fromCharCode(103, 104, 112, 95) + "a".repeat(32);
const neutralStandard = Buffer.from(
  "neutral standard fixture " + "z".repeat(16),
).toString("base64");
const urlSafe23 = urlSafeFixture(17);
const urlSafeLong = urlSafeFixture(24);
const paddedUrlSafe = " " + urlSafe23 + " ";
const longOpaque = "connection-normal-identifier-000001";
const longWorkspace = "workspace-normal-identifier-000001";
const longActor = "user-normal-identifier-000001";
const longRun = "run-20260820-normal-identifier";

assertRoundTrip(urlSafe23, 23);
assertRoundTrip(urlSafeLong, urlSafeLong.length);

const result = {
  schemaVersion: 1,
  task: "E5-T02",
  exactHead,
  inputs: {
    canonicalUrlSafeLength: urlSafe23.length,
    canonicalUrlSafeRoundTrip: true,
    longerUrlSafeLength: urlSafeLong.length,
    longerUrlSafeRoundTrip: true,
    longerOpaqueIdentifierLength: longOpaque.length,
    opaqueUrlSafeIsCompatibilityInput: true,
  },
  runtime: runtimeBoundaryFixture(),
  store: storeBoundaryFixture(),
  compatibility: compatibilityFixture(),
  eventIdentity: eventIdentityFixture(),
  adversarialInputs: adversarialFixture(),
  lifecycle: lifecycleFixture(),
  authz: authorizationFixture(),
  publicSchema: await publicSchemaFixture(),
  sensitivity: await detectorSensitivityFixture(),
};

result.findings = [
  ...result.runtime.findings,
  ...result.store.findings,
  ...result.compatibility.findings,
  ...result.eventIdentity.findings,
  ...result.adversarialInputs.findings,
  ...result.publicSchema.findings,
];
const firstScan = await leakScan();
result.leakScan = firstScan;
await writeFile(
  path.join(evidenceDirectory, "independent-probes.json"),
  JSON.stringify(result, null, 2) + "\n",
);
const finalScan = await leakScan();
result.leakScan = finalScan;
await writeFile(
  path.join(evidenceDirectory, "independent-probes.json"),
  JSON.stringify(result, null, 2) + "\n",
);
if (firstScan.leaked || finalScan.leaked) {
  failures.push("independent evidence leak scan found a durable match");
}

console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) {
  console.error(JSON.stringify({ criticFailures: failures }, null, 2));
  process.exitCode = 1;
}

function runtimeBoundaryFixture() {
  const rejected = {};
  const findings = [];
  const freeFormCases = {
    metadata23: () => normalizeMetadata({ safe: urlSafe23 }),
    metadataLong: () => normalizeMetadata({ safe: urlSafeLong }),
    definitionMetadata23: () =>
      normalizeConnectionDefinition(
        definition({ metadata: { safe: urlSafe23 } }),
      ),
    definitionMetadataLong: () =>
      normalizeConnectionDefinition(
        definition({ metadata: { safe: urlSafeLong } }),
      ),
    label23: () =>
      normalizeConnectionDefinition(definition({ label: urlSafe23 })),
    labelLong: () =>
      normalizeConnectionDefinition(definition({ label: urlSafeLong })),
    reason23: () => normalizeReason(urlSafe23),
    reasonLong: () => normalizeReason(urlSafeLong),
    terminalReason23: () =>
      normalizeConnectionEvent(terminalEvent({ reason: urlSafe23 })),
    terminalReasonLong: () =>
      normalizeConnectionEvent(terminalEvent({ reason: urlSafeLong })),
    capability23: () =>
      normalizePrincipal({ ...admin, capabilities: [urlSafe23] }),
    capabilityLong: () =>
      normalizePrincipal({ ...admin, capabilities: [urlSafeLong] }),
    standardBase64: () => normalizeMetadata({ safe: neutralStandard }),
    providerShape: () => normalizeMetadata({ safe: providerShape }),
  };
  for (const [name, action] of Object.entries(freeFormCases)) {
    const outcome = attempt(action);
    expectCredentialRejection(name, outcome);
    rejected[name] = outcome;
  }

  const paddedCanonicalization = {};
  const padded = {
    label: attempt(() => {
      const normalized = normalizeConnectionDefinition(
        definition({ label: paddedUrlSafe }),
      );
      paddedCanonicalization.labelReturnedCanonical =
        normalized.label === urlSafe23;
      return normalized;
    }),
    reason: attempt(() => {
      const normalized = normalizeReason(paddedUrlSafe);
      paddedCanonicalization.reasonReturnedCanonical = normalized === urlSafe23;
      return normalized;
    }),
    metadata: attempt(() => {
      const normalized = normalizeMetadata({ safe: paddedUrlSafe });
      paddedCanonicalization.metadataRetainedWrapped =
        normalized.safe === paddedUrlSafe;
      return normalized;
    }),
  };
  if (padded.label.accepted) {
    addFinding(
      findings,
      "E5-T02-CRITIC-INDEPENDENT-001",
      "high",
      "Whitespace-wrapped URL-safe material is trimmed after detection and accepted as a label",
      { boundary: "runtime.label", outcome: padded.label },
    );
  }
  if (padded.reason.accepted) {
    addFinding(
      findings,
      "E5-T02-CRITIC-INDEPENDENT-002",
      "high",
      "Whitespace-wrapped URL-safe material is trimmed after detection and accepted as a reason",
      { boundary: "runtime.reason", outcome: padded.reason },
    );
  }
  if (padded.metadata.accepted) {
    addFinding(
      findings,
      "E5-T02-CRITIC-INDEPENDENT-003",
      "high",
      "Whitespace-wrapped URL-safe material crossed the metadata normalizer",
      { boundary: "runtime.metadata", outcome: padded.metadata },
    );
  }
  return {
    requiredFreeFormRejections: rejected,
    paddedFreeFormAttack: padded,
    paddedCanonicalization,
    detector: {
      canonicalUrlSafe: isCredentialMaterial(urlSafe23),
      longerUrlSafe: isCredentialMaterial(urlSafeLong),
      standardBase64: isCredentialMaterial(neutralStandard),
      providerShape: isCredentialMaterial(providerShape),
    },
    findings,
  };
}

function storeBoundaryFixture() {
  const store = makeStore();
  const before = store.events().length;
  const findings = [];
  const attempts = {
    metadata23: attempt(() =>
      store.create({
        actor: admin,
        ...definition({
          connectionId: "connection-store-metadata-23",
          metadata: { safe: urlSafe23 },
        }),
        idempotencyKey: "create-store-metadata-23",
      }),
    ),
    metadataLong: attempt(() =>
      store.create({
        actor: admin,
        ...definition({
          connectionId: "connection-store-metadata-long",
          metadata: { safe: urlSafeLong },
        }),
        idempotencyKey: "create-store-metadata-long",
      }),
    ),
    label23: attempt(() =>
      store.create({
        actor: admin,
        ...definition({
          connectionId: "connection-store-label-23",
          label: urlSafe23,
        }),
        idempotencyKey: "create-store-label-23",
      }),
    ),
    capability23: attempt(() =>
      store.create({
        actor: { ...admin, capabilities: [urlSafe23] },
        ...definition({ connectionId: "connection-store-capability-23" }),
        idempotencyKey: "create-store-capability-23",
      }),
    ),
    metadataPadded: attempt(() =>
      store.create({
        actor: admin,
        ...definition({
          connectionId: "connection-store-metadata-padded",
          metadata: { safe: paddedUrlSafe },
        }),
        idempotencyKey: "create-store-metadata-padded",
      }),
    ),
    connectionIdUrlSafeCompatibility: attempt(() =>
      store.create({
        actor: admin,
        ...definition({ connectionId: urlSafe23 }),
        idempotencyKey: "create-store-opaque-url-safe",
      }),
    ),
  };
  for (const [name, outcome] of Object.entries(attempts)) {
    if (name === "connectionIdUrlSafeCompatibility") {
      expectAccepted("store-opaque-url-safe", outcome);
    } else if (name === "metadataPadded") {
      if (outcome.accepted) {
        addFinding(
          findings,
          "E5-T02-CRITIC-INDEPENDENT-005",
          "high",
          "Whitespace-wrapped URL-safe material crossed store metadata append",
          {
            boundary: "store.create.metadata",
            outcome,
            eventCountAfter: store.events().length,
            persistedAsWrapped:
              store.snapshot().connections["connection-store-metadata-padded"]
                ?.metadata?.safe === paddedUrlSafe,
          },
        );
      }
    } else {
      expectCredentialRejection("store-" + name, outcome);
    }
  }
  const afterCreate = store.events().length;
  const paddedMetadataPersisted =
    store.snapshot().connections["connection-store-metadata-padded"]?.metadata
      ?.safe === paddedUrlSafe;
  const expectedAfterCreate =
    before + 1 + (attempts.metadataPadded.accepted ? 1 : 0);
  if (afterCreate !== expectedAfterCreate) {
    failures.push(
      "store create free-form/opaque append partition was unexpected",
    );
  }

  const terminal = {
    canonical23: terminalReasonAttempt(urlSafe23, "disable-store-23"),
    longer: terminalReasonAttempt(urlSafeLong, "disable-store-long"),
    padded: terminalReasonAttempt(paddedUrlSafe, "disable-store-padded"),
  };
  if (terminal.padded.outcome.accepted) {
    addFinding(
      findings,
      "E5-T02-CRITIC-INDEPENDENT-004",
      "high",
      "Whitespace-wrapped URL-safe material reached store terminal append after reason trimming",
      {
        boundary: "store.disable.reason",
        before: terminal.padded.before,
        after: terminal.padded.after,
      },
    );
  }
  for (const [name, row] of Object.entries(terminal)) {
    if (name !== "padded")
      expectCredentialRejection("store-terminal-" + name, row.outcome);
  }

  const captureStore = makeStore();
  captureStore.create({
    actor: admin,
    ...definition({ connectionId: "connection-store-capture" }),
    idempotencyKey: "create-store-capture",
  });
  const captureBefore = captureStore.events().length;
  const capture = {
    urlSafeOpaque: attempt(() =>
      captureStore.captureForRun({
        actor: member,
        connectionId: "connection-store-capture",
        runId: urlSafe23,
      }),
    ),
    longOpaque: attempt(() =>
      captureStore.captureForRun({
        actor: member,
        connectionId: "connection-store-capture",
        runId: longRun,
      }),
    ),
    providerShape: attempt(() =>
      captureStore.captureForRun({
        actor: member,
        connectionId: "connection-store-capture",
        runId: providerShape,
      }),
    ),
    capability: attempt(() =>
      captureStore.captureForRun({
        actor: { ...member, capabilities: [urlSafe23] },
        connectionId: "connection-store-capture",
        runId: "run-store-capability",
      }),
    ),
  };
  expectAccepted("capture-opaque-url-safe", capture.urlSafeOpaque);
  expectAccepted("capture-long-opaque", capture.longOpaque);
  expectCredentialRejection("capture-provider-shape", capture.providerShape);
  expectCredentialRejection("capture-capability", capture.capability);
  if (captureStore.events().length !== captureBefore) {
    failures.push("store capture/authz probes moved the event head");
  }

  return {
    create: attempts,
    createEventCounts: { before, afterCreate, opaqueCompatibilityAppended: 1 },
    paddedMetadataPersisted,
    terminal,
    capture,
    captureEventCountUnchanged: captureStore.events().length === captureBefore,
    findings,
  };
}

function compatibilityFixture() {
  const findings = [];
  const runtime = {
    opaqueUrlSafe: attempt(() => normalizeOpaqueIdForStore(urlSafe23)),
    opaqueLong: attempt(() => normalizeOpaqueIdForStore(longOpaque)),
    principalWorkspace: attempt(() =>
      normalizePrincipal({ ...member, workspaceId: longWorkspace }),
    ),
    principalId: attempt(() =>
      normalizePrincipal({ ...member, id: longActor }),
    ),
    ownerId: attempt(() =>
      normalizeOwner({ kind: "workspace", id: longWorkspace }),
    ),
    runId: attempt(() => normalizeOpaqueIdForStore(longRun)),
  };
  for (const [name, outcome] of Object.entries(runtime)) {
    expectAccepted("compatibility-" + name, outcome);
  }
  const store = makeStore();
  const lifecycle = attempt(() =>
    store.create({
      actor: admin,
      ...definition({ connectionId: longOpaque }),
      idempotencyKey: "create-long-opaque-identifier",
    }),
  );
  expectAccepted("compatibility-store-long-opaque", lifecycle);
  if (
    Object.values(runtime).some((outcome) => !outcome.accepted) ||
    !lifecycle.accepted
  ) {
    addFinding(
      findings,
      "E5-T02-CRITIC-INDEPENDENT-COMPATIBILITY",
      "medium",
      "A valid opaque identifier failed the identifier compatibility contract",
      { runtime, lifecycle },
    );
  }
  return { runtime, lifecycle, findings };
}

function eventIdentityFixture() {
  const fields = [
    "eventId",
    "workspaceId",
    "actorId",
    "idempotencyKey",
    "connectionId",
  ];
  const runtime = { urlSafeAccepted: {}, providerRejected: {} };
  const findings = [];
  for (const field of fields) {
    const urlOutcome = attempt(() =>
      normalizeConnectionEvent(createdEvent({ [field]: urlSafe23 })),
    );
    const providerOutcome = attempt(() =>
      normalizeConnectionEvent(createdEvent({ [field]: providerShape })),
    );
    expectAccepted("event-identity-url-safe-" + field, urlOutcome);
    expectCredentialRejection(
      "event-identity-provider-" + field,
      providerOutcome,
    );
    runtime.urlSafeAccepted[field] = urlOutcome;
    runtime.providerRejected[field] = providerOutcome;
  }
  return { runtime, findings };
}

function adversarialFixture() {
  const findings = [];
  const recursive = { safe: "value" };
  recursive.self = recursive;
  const unicodeKey = JSON.parse(
    '{"' +
      String.fromCodePoint(0x0074, 0x006f, 0x006b, 0x0065, 0x006e) +
      '":"opaque"}',
  );
  const caseKeyName = ["To", "Ke", "N"].join("");
  const caseKey = { [caseKeyName]: "opaque" };
  const parsedPrototype = JSON.parse(
    '{"__proto__":{"' + ["To", "Ke", "N"].join("") + '":"opaque"}}',
  );
  const runtime = {
    recursive: attempt(() =>
      normalizeConnectionDefinition(definition({ metadata: recursive })),
    ),
    caseVariantKey: attempt(() => normalizeMetadata(caseKey)),
    unicodeEscapedKey: attempt(() => normalizeMetadata(unicodeKey)),
    parsedPrototypeKey: attempt(() => normalizeMetadata(parsedPrototype)),
    extraDefinitionField: attempt(() =>
      normalizeConnectionDefinition({
        ...definition(),
        unexpectedField: "value",
      }),
    ),
    extraSecretRefField: attempt(() =>
      normalizeSecretRef({ ...secretRef(1), unexpectedField: "value" }),
    ),
    extraEventField: attempt(() =>
      normalizeConnectionEvent({ ...createdEvent(), unexpectedField: "value" }),
    ),
  };
  for (const [name, outcome] of Object.entries(runtime)) {
    if (name === "recursive" || name.startsWith("extra")) {
      if (outcome.accepted)
        failures.push("adversarial input was accepted: " + name);
    } else {
      expectCredentialRejection("adversarial-" + name, outcome);
    }
  }
  return { runtime, findings };
}

function lifecycleFixture() {
  const store = makeStore();
  const connectionId = "connection-independent-lifecycle";
  store.create({
    actor: admin,
    ...definition({ connectionId }),
    idempotencyKey: "create-independent-lifecycle",
  });
  const beforeRotate = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-independent-stable",
  });
  store.rotate({
    actor: admin,
    connectionId,
    expectedRevision: 1,
    secretRef: secretRef(2),
    idempotencyKey: "rotate-independent-lifecycle",
  });
  const sameRun = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-independent-stable",
  });
  const newRun = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-independent-new",
  });
  store.disable({
    actor: admin,
    connectionId,
    reason: "maintenance",
    idempotencyKey: "disable-independent-lifecycle",
  });
  const existingAfterDisable = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-independent-stable",
  });
  const disabledNewRun = attempt(() =>
    store.captureForRun({
      actor: member,
      connectionId,
      runId: "run-independent-disabled",
    }),
  );
  store.delete({
    actor: admin,
    connectionId,
    reason: "retired",
    idempotencyKey: "delete-independent-lifecycle",
  });
  const existingAfterDelete = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-independent-stable",
  });
  const deletedNewRun = attempt(() =>
    store.captureForRun({
      actor: member,
      connectionId,
      runId: "run-independent-deleted",
    }),
  );
  const events = store.events();
  const replay = replayConnectionEvents([...events, ...events].reverse());
  const replayAgain = replayConnectionEvents([...events, ...events].reverse());
  const passed =
    beforeRotate.revision === 1 &&
    sameRun.revision === 1 &&
    newRun.revision === 2 &&
    existingAfterDisable.revision === 1 &&
    existingAfterDelete.revision === 1 &&
    disabledNewRun.code === CONNECTION_ERROR_CODES.NOT_ACTIVE &&
    deletedNewRun.code === CONNECTION_ERROR_CODES.NOT_ACTIVE &&
    replay.stateDigest === store.stateDigest() &&
    replay.stateDigest === replayAgain.stateDigest;
  if (!passed) failures.push("lifecycle/capture/replay parity failed");
  return {
    revisionStability: {
      beforeRotate: beforeRotate.revision,
      sameRunAfterRotate: sameRun.revision,
      newRunAfterRotate: newRun.revision,
      existingAfterDisable: existingAfterDisable.revision,
      existingAfterDelete: existingAfterDelete.revision,
    },
    disabledNewRun,
    deletedNewRun,
    replay: {
      stateDigest: replay.stateDigest,
      replayAgainDigest: replayAgain.stateDigest,
      viewDigest: canonicalSha256(replay.connections),
      duplicateAndReorderedParity: passed,
    },
  };
}

function authorizationFixture() {
  const store = makeStore();
  const connectionId = "connection-independent-authz";
  store.create({
    actor: admin,
    ...definition({ connectionId }),
    idempotencyKey: "create-independent-authz",
  });
  const ownership = {
    memberRead: store.authorization({ actor: member, connectionId }).allowed,
    memberGrant: store.authorization({
      actor: member,
      connectionId,
      action: "grant",
    }).allowed,
    memberDelete: store.authorization({
      actor: member,
      connectionId,
      action: "delete",
    }).allowed,
  };
  const foreign = {
    ...admin,
    tenantId: "tenant-foreign",
    workspaceId: "workspace-foreign",
  };
  const operations = {
    read: () => store.read({ actor: foreign, connectionId }),
    grant: () =>
      store.captureForRun({
        actor: foreign,
        connectionId,
        runId: "run-foreign",
      }),
    rotate: () =>
      store.rotate({
        actor: foreign,
        connectionId,
        expectedRevision: 1,
        secretRef: secretRef(2),
        idempotencyKey: "rotate-foreign",
      }),
    disable: () =>
      store.disable({
        actor: foreign,
        connectionId,
        idempotencyKey: "disable-foreign",
      }),
    delete: () =>
      store.delete({
        actor: foreign,
        connectionId,
        idempotencyKey: "delete-foreign",
      }),
  };
  const before = store.stateDigest();
  const foreignErrors = {};
  const unknownErrors = {};
  for (const [operation, action] of Object.entries(operations)) {
    foreignErrors[operation] = notFoundOutcome(action);
    const unknownId = "connection-unknown";
    unknownErrors[operation] = notFoundOutcome(() => {
      if (operation === "read")
        return store.read({ actor: foreign, connectionId: unknownId });
      if (operation === "grant")
        return store.captureForRun({
          actor: foreign,
          connectionId: unknownId,
          runId: "run-foreign",
        });
      if (operation === "rotate")
        return store.rotate({
          actor: foreign,
          connectionId: unknownId,
          expectedRevision: 1,
          secretRef: secretRef(2),
          idempotencyKey: "rotate-unknown",
        });
      if (operation === "disable")
        return store.disable({
          actor: foreign,
          connectionId: unknownId,
          idempotencyKey: "disable-unknown",
        });
      return store.delete({
        actor: foreign,
        connectionId: unknownId,
        idempotencyKey: "delete-unknown",
      });
    });
  }
  const foreignAuthorization = store.authorization({
    actor: foreign,
    connectionId,
  });
  const unknownAuthorization = store.authorization({
    actor: foreign,
    connectionId: "connection-unknown",
  });
  const errorsEqual =
    JSON.stringify(foreignErrors) === JSON.stringify(unknownErrors);
  const authorizationEqual =
    JSON.stringify(foreignAuthorization) ===
    JSON.stringify(unknownAuthorization);
  const stateDigestUnchanged = store.stateDigest() === before;
  if (
    !ownership.memberRead ||
    !ownership.memberGrant ||
    ownership.memberDelete ||
    !errorsEqual ||
    !authorizationEqual ||
    !stateDigestUnchanged
  ) {
    failures.push("authorization ownership or foreign/unknown parity failed");
  }
  return {
    ownership,
    foreignErrors,
    unknownErrors,
    foreignAuthorization,
    unknownAuthorization,
    foreignUnknownEqual: errorsEqual && authorizationEqual,
    stateDigestUnchanged,
  };
}

async function publicSchemaFixture() {
  const ajvPath =
    process.env.AJV_2020_MODULE ??
    "/opt/homebrew/lib/node_modules/verdaccio/node_modules/ajv/dist/2020.js";
  const { default: Ajv2020 } = await import(pathToFileURL(ajvPath).href);
  const schema = JSON.parse(
    await readFile(
      path.join(
        root,
        "packages/connections/src/schemas/connection-events.v1.schema.json",
      ),
      "utf8",
    ),
  );
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
    schema,
  );
  const caseKeyName = ["To", "Ke", "N"].join("");
  const cases = {
    metadata23: createdEvent({ data: { metadata: { safe: urlSafe23 } } }),
    metadataLong: createdEvent({ data: { metadata: { safe: urlSafeLong } } }),
    label23: createdEvent({ data: { label: urlSafe23 } }),
    labelLong: createdEvent({ data: { label: urlSafeLong } }),
    reason23: terminalEvent({ reason: urlSafe23 }),
    reasonLong: terminalEvent({ reason: urlSafeLong }),
    paddedLabel: createdEvent({ data: { label: paddedUrlSafe } }),
    paddedReason: terminalEvent({ reason: paddedUrlSafe }),
    paddedMetadata: createdEvent({
      data: { metadata: { safe: paddedUrlSafe } },
    }),
    standardBase64: createdEvent({
      data: { metadata: { safe: neutralStandard } },
    }),
    providerShape: createdEvent({
      data: { metadata: { safe: providerShape } },
    }),
    caseVariantKey: createdEvent({
      data: { metadata: { [caseKeyName]: "opaque" } },
    }),
    unicodeEscapedKey: createdEvent({
      data: {
        metadata: JSON.parse(
          '{"' +
            String.fromCodePoint(0x0074, 0x006f, 0x006b, 0x0065, 0x006e) +
            '":"opaque"}',
        ),
      },
    }),
    parsedPrototypeKey: createdEvent({
      data: { metadata: JSON.parse('{"__proto__":{"safe":"opaque"}}') },
    }),
    extraEventField: { ...createdEvent(), unexpectedField: "value" },
    extraDataField: createdEvent({ data: { unexpectedField: "value" } }),
    longIdentifiers: createdEvent({
      eventId: "event-long-identifier-000001",
      workspaceId: longWorkspace,
      actorId: longActor,
      idempotencyKey: "idempotency-long-identifier-000001",
      connectionId: longOpaque,
      data: {
        connectionId: longOpaque,
        workspaceId: longWorkspace,
        owner: { kind: "workspace", id: longWorkspace },
      },
    }),
  };
  const urlSafeIdentity = {};
  const providerIdentity = {};
  for (const field of [
    "eventId",
    "workspaceId",
    "actorId",
    "idempotencyKey",
    "connectionId",
  ]) {
    const urlEvent = createdEvent({ [field]: urlSafe23 });
    const providerEvent = createdEvent({ [field]: providerShape });
    urlSafeIdentity[field] = schemaAttempt(validate, urlEvent);
    providerIdentity[field] = schemaAttempt(validate, providerEvent);
  }
  const outcomes = Object.fromEntries(
    Object.entries(cases).map(([name, event]) => [
      name,
      schemaAttempt(validate, event),
    ]),
  );
  const findings = [];
  for (const name of [
    "metadata23",
    "metadataLong",
    "label23",
    "labelLong",
    "reason23",
    "reasonLong",
    "standardBase64",
    "providerShape",
    "caseVariantKey",
    "unicodeEscapedKey",
    "parsedPrototypeKey",
    "extraEventField",
    "extraDataField",
  ]) {
    if (outcomes[name].accepted) {
      addFinding(
        findings,
        "E5-T02-CRITIC-INDEPENDENT-SCHEMA-" + name.toUpperCase(),
        "high",
        "Public schema accepted a rejected free-form or malformed input",
        { case: name, outcome: outcomes[name] },
      );
    }
  }
  for (const name of ["paddedLabel", "paddedReason", "paddedMetadata"]) {
    if (outcomes[name].accepted) {
      addFinding(
        findings,
        "E5-T02-CRITIC-INDEPENDENT-SCHEMA-PADDED-" + name.toUpperCase(),
        "high",
        "Public schema accepted whitespace-wrapped encoded material",
        { case: name, outcome: outcomes[name] },
      );
    }
  }
  for (const [field, outcome] of Object.entries(urlSafeIdentity)) {
    expectAccepted("schema-url-safe-identity-" + field, outcome);
  }
  for (const [field, outcome] of Object.entries(providerIdentity)) {
    if (outcome.accepted)
      addFinding(
        findings,
        "E5-T02-CRITIC-INDEPENDENT-SCHEMA-PROVIDER-" + field.toUpperCase(),
        "high",
        "Public identifier schema accepted an explicit provider-shaped identifier",
        { field, outcome },
      );
  }
  expectAccepted("schema-long-identifiers", outcomes.longIdentifiers);
  return {
    freeFormAndAdversarial: outcomes,
    urlSafeIdentity,
    providerIdentity,
    findings,
  };
}

async function detectorSensitivityFixture() {
  const workDirectory = path.join(
    root,
    ".eforest/tasks/epic-5-the-switchboard/E5-T02-service-connection-secretref-model/work",
  );
  await mkdir(workDirectory, { recursive: true });
  const scratch = await mkdtemp(
    path.join(workDirectory, "independent-detector-sensitivity-"),
  );
  const sourceDirectory = path.join(scratch, "src");
  await mkdir(sourceDirectory, { recursive: true });
  const schemaPath = path.join(sourceDirectory, "schema.mjs");
  try {
    await Promise.all([
      copyFile(
        path.join(root, "packages/connections/src/schema.mjs"),
        schemaPath,
      ),
      copyFile(
        path.join(root, "packages/connections/src/errors.mjs"),
        path.join(sourceDirectory, "errors.mjs"),
      ),
      copyFile(
        path.join(root, "packages/connections/src/canonical.mjs"),
        path.join(sourceDirectory, "canonical.mjs"),
      ),
    ]);
    const source = await readFile(schemaPath, "utf8");
    const marker =
      "if (!allowGenericBase64 && isBase64EncodedValue(value)) return true;";
    if (!source.includes(marker)) {
      failures.push("base64 detector sensitivity marker was not found");
      return { branchFound: false, mutatedAccepted: false };
    }
    await writeFile(
      schemaPath,
      source.replace(
        marker,
        "if (false && isBase64EncodedValue(value)) return true;",
      ),
    );
    const fixture = definition({ metadata: { safe: urlSafe23 } });
    const probe =
      "import { normalizeConnectionDefinition } from " +
      JSON.stringify(pathToFileURL(schemaPath).href) +
      "; normalizeConnectionDefinition(" +
      JSON.stringify(fixture) +
      ");";
    let mutatedAccepted = false;
    try {
      execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      });
      mutatedAccepted = true;
    } catch {
      mutatedAccepted = false;
    }
    if (!mutatedAccepted)
      failures.push(
        "removing the base64 detector did not make its fixture accepted",
      );
    return {
      branchFound: true,
      branchRemoved: "generic base64 value detector",
      fixture: "canonical URL-safe free-form value",
      mutatedAccepted,
      verifierWouldTurnRed: mutatedAccepted,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function terminalReasonAttempt(reason, idempotencyKey) {
  const store = makeStore();
  store.create({
    actor: admin,
    ...definition({ connectionId: "connection-terminal-probe" }),
    idempotencyKey: "create-terminal-probe",
  });
  const before = store.events().length;
  const outcome = attempt(() =>
    store.disable({
      actor: admin,
      connectionId: "connection-terminal-probe",
      reason,
      idempotencyKey,
    }),
  );
  return { outcome, before, after: store.events().length };
}

function makeStore() {
  let now = Date.parse("2026-08-20T16:00:00.000Z");
  return createConnectionStore({
    ...scope,
    clock: () => new Date((now += 1000)),
  });
}

function definition(overrides = {}) {
  return {
    schemaVersion: 1,
    connectionId: "connection-probe",
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    owner: { kind: "workspace", id: scope.workspaceId },
    provider: "github",
    integration: "issues",
    label: "Probe connection",
    metadata: { purpose: "probe" },
    secretRef: secretRef(1),
    ...overrides,
  };
}

function secretRef(revision) {
  return {
    schemaVersion: 1,
    id: "secretref-independent-" + String(revision).padStart(3, "0"),
    provider: "infisical",
    mount: "production",
    revision,
    label: "github",
  };
}

function createdEvent(overrides = {}) {
  const connectionId = overrides.connectionId ?? "connection-event-probe";
  const workspaceId = overrides.workspaceId ?? scope.workspaceId;
  const baseData = {
    schemaVersion: 1,
    connectionId,
    tenantId: scope.tenantId,
    workspaceId,
    owner: { kind: "workspace", id: workspaceId },
    provider: "github",
    integration: "issues",
    label: "Event probe",
    metadata: {},
    secretRef: secretRef(1),
    revision: 1,
  };
  return {
    schemaVersion: 1,
    eventId: "event-independent-000001",
    eventType: "connection.created",
    workspaceId,
    actorId: "user-event-probe",
    idempotencyKey: "idempotency-independent-000001",
    sequence: 1,
    serverTimestamp: "2026-08-20T16:00:00.000Z",
    connectionId,
    ...overrides,
    data: { ...baseData, ...(overrides.data ?? {}) },
  };
}

function terminalEvent({ reason, ...overrides } = {}) {
  return {
    schemaVersion: 1,
    eventId: "event-terminal-probe-000001",
    eventType: "connection.disabled",
    workspaceId: scope.workspaceId,
    actorId: "user-event-probe",
    idempotencyKey: "idempotency-terminal-probe-000001",
    sequence: 2,
    serverTimestamp: "2026-08-20T16:00:01.000Z",
    connectionId: "connection-event-probe",
    data: { reason },
    ...overrides,
  };
}

function urlSafeFixture(byteLength) {
  return Buffer.from([
    105,
    ...Array.from({ length: byteLength - 1 }, () => 255),
  ]).toString("base64url");
}

function assertRoundTrip(value, expectedLength) {
  if (
    value.length !== expectedLength ||
    Buffer.from(value, "base64url").toString("base64url") !== value
  ) {
    throw new Error("URL-safe fixture is not canonical and round-trip valid");
  }
}

function attempt(action) {
  try {
    const value = action();
    return {
      accepted: true,
      outputDigest: canonicalSha256({
        value: typeof value === "string" ? value : (value ?? null),
      }),
    };
  } catch (error) {
    return {
      accepted: false,
      code: error?.code ?? "UNEXPECTED_ERROR",
      path: error?.path ?? null,
      statusCode: error?.statusCode ?? null,
      errorType: error?.name ?? "Error",
    };
  }
}

function schemaAttempt(validate, value) {
  const accepted = validate(value);
  return {
    accepted,
    errors: accepted
      ? []
      : (validate.errors ?? []).map((error) => ({
          instancePath: error.instancePath ?? "",
          keyword: error.keyword,
        })),
  };
}

function expectCredentialRejection(name, outcome) {
  if (
    !outcome.accepted &&
    outcome.code === CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL
  )
    return;
  failures.push("expected credential rejection was not observed: " + name);
}

function expectAccepted(name, outcome) {
  if (outcome.accepted) return;
  failures.push("expected compatibility acceptance was not observed: " + name);
}

function addFinding(collection, id, severity, summary, observation) {
  collection.push({ id, severity, summary, observation });
  failures.push(id);
}

function notFoundOutcome(action) {
  try {
    action();
    return { accepted: true };
  } catch (error) {
    return {
      accepted: false,
      code: error?.code ?? "UNEXPECTED_ERROR",
      detail: error?.detail ?? null,
      path: error?.path ?? null,
      statusCode: error?.statusCode ?? null,
    };
  }
}

async function leakScan() {
  const canaryWord = ["can", "ary"].join("");
  const canaryOne = ["e5", "-t02", "-connection-", canaryWord, "-value"].join(
    "",
  );
  const canaryTwo = ["critic-independent-e5-t02-", canaryWord, "-value"].join(
    "",
  );
  const credentialFieldNames = [
    "api[_-]?key",
    "client[_-]?secret",
    "password",
    "token",
    "cookie",
    "authorization",
  ].join("|");
  const patterns = [
    new RegExp(canaryOne + "|" + canaryTwo, "iu"),
    new RegExp(["-----BEGIN ", "[^-]*", "PRIVATE ", "KEY-----"].join(""), "iu"),
    new RegExp(
      "\\b(?:" + ["bear", "er|basic"].join("") + ")\\s+[A-Za-z0-9._~+/=-]{8,}",
      "iu",
    ),
    new RegExp(
      "\\b(?:" +
        credentialFieldNames +
        ")\\s*[:=]\\s*[\"']?[A-Za-z0-9._~+/=-]{8,}",
      "iu",
    ),
    new RegExp(
      "(?:postgres(?:ql)?|mysql|redis|mongodb(?:\\+srv)?|amqp):\\/\\/\\S+",
      "iu",
    ),
    new RegExp(
      "\\b(?:[A-Za-z0-9][A-Za-z0-9._-]{2,}[-_]" +
        canaryWord +
        "(?:[-_][A-Za-z0-9._-]+)*|" +
        canaryWord +
        "[-_](?!scan(?:\\.|$))[A-Za-z0-9._-]{2,})\\b",
      "iu",
    ),
  ];
  const files = (await listFiles(evidenceDirectory)).filter(
    (file) => path.extname(file) === ".json",
  );
  const findings = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const [rule, pattern] of patterns.entries()) {
      if (pattern.test(content))
        findings.push({ file: path.relative(evidenceDirectory, file), rule });
    }
  }
  return {
    filesChecked: files
      .map((file) => path.relative(evidenceDirectory, file))
      .sort(),
    findings,
    leaked: findings.length > 0,
  };
}

async function listFiles(directory) {
  const entries = await (
    await import("node:fs/promises")
  ).readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else files.push(full);
  }
  return files;
}
