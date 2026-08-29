import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-5-the-switchboard/E5-T02-service-connection-secretref-model",
);
const exactHead = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const scope = Object.freeze({
  tenantId: "tenant-fresh-critic",
  workspaceId: "workspace-fresh-critic",
});
const admin = Object.freeze({
  ...scope,
  id: "user-fresh-admin",
  kind: "user",
  role: "admin",
});
const member = Object.freeze({
  ...scope,
  id: "user-fresh-member",
  kind: "user",
  role: "member",
});
const providerPrefix = String.fromCharCode(103, 104, 112, 95);
const providerShape = providerPrefix + "a".repeat(32);
const neutralStandard = Buffer.from(
  "neutral standard fixture " + "z".repeat(16),
).toString("base64");
const urlSafe23 = canonicalUrlSafe(17);
const urlSafeLong = canonicalUrlSafe(24);
const zeroWidthUrlSafe =
  urlSafe23.slice(0, 10) + String.fromCodePoint(0x200b) + urlSafe23.slice(10);
const longConnectionId = "connection-fresh-opaque-identifier-000001";
const longWorkspaceId = "workspace-fresh-opaque-identifier-000001";
const longActorId = "user-fresh-opaque-identifier-000001";
const longRunId = "run-fresh-opaque-identifier-000001";
const escapedJsonCredential = '{"\\u0074oken":"opaque-value"}';
const parsedPrototypeKey = JSON.parse('{"__proto__":{"safe":"opaque-value"}}');
const caseVariantKey = { ToKeN: "opaque-value" };
const privateKeyShape = ["-----BEGIN ", "PRIVATE KEY", "-----"].join("");
const urlShape = ["https", "://", "example.invalid/service"].join("");
const assignmentShape = ["password", "=", "opaque-value"].join("");
const connectionStringShape = ["host=service.invalid", "port=5432"].join(";");
const jsonCredentialShape = JSON.stringify({
  [String.fromCharCode(116, 111, 107, 101, 110)]: "opaque-value",
});
const failures = [];
const findings = [];

if (
  urlSafe23.length !== 23 ||
  Buffer.from(urlSafe23, "base64url").toString("base64url") !== urlSafe23 ||
  urlSafeLong.length <= 23 ||
  Buffer.from(urlSafeLong, "base64url").toString("base64url") !== urlSafeLong
) {
  throw new Error(
    "generated URL-safe fixtures are not canonical RFC 4648 values",
  );
}

const result = {
  schemaVersion: 1,
  task: "E5-T02",
  exactHead,
  inputs: {
    canonicalUrlSafe: [
      { name: "url-safe-23", length: urlSafe23.length, roundTrip: true },
      { name: "url-safe-long", length: urlSafeLong.length, roundTrip: true },
    ],
    whitespaceWrappers: ["spaces", "tabs", "unicode-space"],
    hiddenFormatCharacter: {
      name: "zero-width-space-inside-canonical-url-safe",
      canonicalLength: urlSafe23.length,
      attackedLength: zeroWidthUrlSafe.length,
    },
    explicitIdentifierShapes: [
      "provider-token",
      "private-key",
      "url",
      "connection-string",
      "assignment",
      "json",
    ],
  },
  runtime: runtimeBoundaryFixture(),
  store: storeBoundaryFixture(),
  identifierPolicy: identifierPolicyFixture(),
  eventIdentity: eventIdentityFixture(),
  adversarialInputs: adversarialFixture(),
  lifecycle: lifecycleFixture(),
  authorization: authorizationFixture(),
  publicSchema: await publicSchemaFixture(),
  sensitivity: await detectorSensitivityFixture(),
};

result.findings = findings;
if (findings.length > 0) {
  failures.push(
    "independent probe findings refute one or more required boundaries",
  );
}
result.leakScan = await writeAndScanResult(result);
if (result.leakScan.leaked) {
  failures.push("critic evidence leak scan found a forbidden durable match");
}

if (failures.length > 0) {
  console.error(
    JSON.stringify(
      { verdict: "refuted", failureCount: failures.length, failures },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify(
      { verdict: "verified", exactHead, findingCount: findings.length },
      null,
      2,
    ),
  );
}

function canonicalUrlSafe(byteCount) {
  return Buffer.from(
    Array.from(
      { length: byteCount },
      (_, index) => (index * 37 + 11 + (index === 0 ? 94 : 0)) & 0xff,
    ),
  ).toString("base64url");
}

function wrappers(value) {
  return {
    spaces: "  " + value + "  ",
    tabs: "\t" + value + "\t",
    "unicode-space": "\u00a0" + value + "\u00a0",
  };
}

function attempt(action) {
  try {
    const value = action();
    return { accepted: true, summary: summarize(value) };
  } catch (error) {
    return {
      accepted: false,
      code: error?.code ?? error?.name ?? "unknown",
      path: error?.path ?? null,
      statusCode: error?.statusCode ?? null,
    };
  }
}

function summarize(value) {
  if (typeof value === "string") {
    return { type: "string", length: value.length };
  }
  if (typeof value === "boolean") return { type: "boolean", value };
  if (value === null || value === undefined) return { type: String(value) };
  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }
  if (typeof value === "object") {
    return {
      type: "object",
      keys: Object.keys(value).sort().slice(0, 24),
      digest: canonicalSha256(value),
    };
  }
  return { type: typeof value };
}

function requireCredentialRejection(name, outcome) {
  if (
    outcome.accepted ||
    outcome.code !== CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL
  ) {
    failures.push(name + " did not produce a credential-material rejection");
    addFinding(
      "E5-T02-CRITIC-FRESH-FREEFORM-" + slug(name),
      "high",
      "Credential-shaped free-form material crossed a runtime boundary",
      { boundary: name, observed: outcome },
    );
  }
}

function requireAnyRejection(name, outcome) {
  if (outcome.accepted) {
    failures.push(name + " was accepted");
    addFinding(
      "E5-T02-CRITIC-FRESH-REJECTION-" + slug(name),
      "high",
      "An explicitly credential-shaped input was accepted",
      { boundary: name, observed: outcome },
    );
  }
}

function requireAccepted(name, outcome) {
  if (!outcome.accepted) {
    failures.push(name + " was rejected");
    addFinding(
      "E5-T02-CRITIC-FRESH-COMPATIBILITY-" + slug(name),
      "medium",
      "An ordinary opaque identifier failed its compatibility contract",
      { boundary: name, observed: outcome },
    );
  }
}

function addFinding(id, severity, summary, observation) {
  findings.push({ id, severity, summary, observation });
}

function slug(value) {
  return value.replace(/[^A-Za-z0-9]+/gu, "-").toUpperCase();
}

function definition(overrides = {}) {
  const base = {
    connectionId: "connection-fresh-base",
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    owner: { kind: "workspace", id: scope.workspaceId },
    provider: "github",
    integration: "issues",
    label: "Fresh critic connection",
    metadata: {},
    secretRef: secretRef(1),
  };
  return {
    ...base,
    ...overrides,
    owner: { ...base.owner, ...(overrides.owner ?? {}) },
    secretRef: overrides.secretRef ?? base.secretRef,
    metadata: overrides.metadata ?? base.metadata,
  };
}

function secretRef(revision) {
  return {
    schemaVersion: 1,
    id: "secretref-fresh-" + String(revision).padStart(3, "0"),
    provider: "infisical",
    mount: "production",
    revision,
    label: "github",
  };
}

function createdEvent(overrides = {}) {
  const base = {
    schemaVersion: 1,
    eventId: "event-fresh-created-001",
    eventType: "connection.created",
    workspaceId: scope.workspaceId,
    actorId: admin.id,
    idempotencyKey: "idempotency-fresh-created-001",
    sequence: 1,
    serverTimestamp: "2026-08-20T10:00:00.000Z",
    connectionId: "connection-fresh-event-001",
    data: {
      ...definition({ connectionId: "connection-fresh-event-001" }),
      revision: 1,
    },
  };
  return {
    ...base,
    ...overrides,
    data: {
      ...base.data,
      ...(overrides.data ?? {}),
      owner: { ...base.data.owner, ...(overrides.data?.owner ?? {}) },
      secretRef: overrides.data?.secretRef ?? base.data.secretRef,
      metadata: overrides.data?.metadata ?? base.data.metadata,
    },
  };
}

function terminalEvent({ reason = "maintenance", ...overrides } = {}) {
  return {
    schemaVersion: 1,
    eventId: "event-fresh-terminal-001",
    eventType: "connection.disabled",
    workspaceId: scope.workspaceId,
    actorId: admin.id,
    idempotencyKey: "idempotency-fresh-terminal-001",
    sequence: 2,
    serverTimestamp: "2026-08-20T10:00:01.000Z",
    connectionId: "connection-fresh-event-001",
    data: { reason },
    ...overrides,
  };
}

function runtimeBoundaryFixture() {
  const rows = {};
  const values = [
    ["url-safe-23", urlSafe23],
    ["url-safe-long", urlSafeLong],
    ...Object.entries(wrappers(urlSafe23)).map(([name, value]) => [
      "url-safe-23-" + name,
      value,
    ]),
    ...Object.entries(wrappers(urlSafeLong)).map(([name, value]) => [
      "url-safe-long-" + name,
      value,
    ]),
  ];
  for (const [valueName, value] of values) {
    const row = {
      metadata: attempt(() => normalizeMetadata({ safe: value })),
      definitionMetadata: attempt(() =>
        normalizeConnectionDefinition(
          definition({ metadata: { safe: value } }),
        ),
      ),
      label: attempt(() =>
        normalizeConnectionDefinition(definition({ label: value })),
      ),
      secretRefLabel: attempt(() =>
        normalizeSecretRef({ ...secretRef(1), label: value }),
      ),
      reason: attempt(() => normalizeReason(value)),
      terminalData: attempt(() =>
        normalizeConnectionEvent(terminalEvent({ reason: value })),
      ),
      capability: attempt(() =>
        normalizePrincipal({ ...admin, capabilities: [value] }),
      ),
    };
    for (const [boundary, outcome] of Object.entries(row)) {
      requireCredentialRejection(
        "runtime." + valueName + "." + boundary,
        outcome,
      );
    }
    rows[valueName] = row;
  }

  for (const [name, value] of Object.entries({
    standardBase64: neutralStandard,
    providerToken: providerShape,
    url: urlShape,
    connectionString: connectionStringShape,
    assignment: assignmentShape,
    json: jsonCredentialShape,
    privateKey: privateKeyShape,
    escapedJson: escapedJsonCredential,
  })) {
    const outcome = attempt(() => normalizeMetadata({ safe: value }));
    requireCredentialRejection("runtime.explicit." + name, outcome);
    rows["explicit-" + name] = outcome;
  }

  const hidden = {
    detector: isCredentialMaterial(zeroWidthUrlSafe),
    metadata: attempt(() => normalizeMetadata({ safe: zeroWidthUrlSafe })),
    definitionMetadata: attempt(() =>
      normalizeConnectionDefinition(
        definition({ metadata: { safe: zeroWidthUrlSafe } }),
      ),
    ),
    label: attempt(() =>
      normalizeConnectionDefinition(definition({ label: zeroWidthUrlSafe })),
    ),
    reason: attempt(() => normalizeReason(zeroWidthUrlSafe)),
    terminalData: attempt(() =>
      normalizeConnectionEvent(terminalEvent({ reason: zeroWidthUrlSafe })),
    ),
    capability: attempt(() =>
      normalizePrincipal({ ...admin, capabilities: [zeroWidthUrlSafe] }),
    ),
  };
  for (const [boundary, outcome] of Object.entries(hidden).filter(
    ([name]) => name !== "detector",
  )) {
    if (outcome.accepted) {
      addFinding(
        "E5-T02-CRITIC-FRESH-ZERO-WIDTH-" + slug(boundary),
        "high",
        "An invisible Unicode format character bypassed generic encoded-value detection in a free-form path",
        {
          boundary: "runtime." + boundary,
          canonicalLength: urlSafe23.length,
          attackedLength: zeroWidthUrlSafe.length,
          detectorClassifiedAsCredential: hidden.detector,
          outcome,
        },
      );
    }
  }
  rows.zeroWidthInternal = hidden;
  return { canonicalAndWhitespace: rows, explicitShapes: true };
}

function storeBoundaryFixture() {
  const rows = {};
  const values = [
    ["url-safe-23", urlSafe23],
    ["url-safe-long", urlSafeLong],
    ...Object.entries(wrappers(urlSafe23)).map(([name, value]) => [
      "url-safe-23-" + name,
      value,
    ]),
    ...Object.entries(wrappers(urlSafeLong)).map(([name, value]) => [
      "url-safe-long-" + name,
      value,
    ]),
  ];
  for (const [valueName, value] of values) {
    const store = makeStore();
    const before = store.events().length;
    const metadata = attempt(() =>
      store.create({
        actor: admin,
        ...definition({
          connectionId:
            "connection-fresh-metadata-" + slug(valueName).toLowerCase(),
          metadata: { safe: value },
        }),
        idempotencyKey:
          "create-fresh-metadata-" + slug(valueName).toLowerCase(),
      }),
    );
    const label = attempt(() =>
      store.create({
        actor: admin,
        ...definition({
          connectionId:
            "connection-fresh-label-" + slug(valueName).toLowerCase(),
          label: value,
        }),
        idempotencyKey: "create-fresh-label-" + slug(valueName).toLowerCase(),
      }),
    );
    const capability = attempt(() =>
      store.create({
        actor: { ...admin, capabilities: [value] },
        ...definition({
          connectionId:
            "connection-fresh-capability-" + slug(valueName).toLowerCase(),
        }),
        idempotencyKey:
          "create-fresh-capability-" + slug(valueName).toLowerCase(),
      }),
    );
    for (const [boundary, outcome] of Object.entries({
      metadata,
      label,
      capability,
    })) {
      requireCredentialRejection(
        "store." + valueName + "." + boundary,
        outcome,
      );
    }
    if (store.events().length !== before) {
      failures.push("store create free-form boundary moved the event head");
      addFinding(
        "E5-T02-CRITIC-FRESH-STORE-APPEND-" + slug(valueName),
        "high",
        "A rejected free-form store input appended an authoritative event",
        { valueName, before, after: store.events().length },
      );
    }

    const disableStore = makeStore();
    disableStore.create({
      actor: admin,
      ...definition({ connectionId: "connection-fresh-disable" }),
      idempotencyKey: "create-fresh-disable",
    });
    const disableBefore = disableStore.events().length;
    const disable = attempt(() =>
      disableStore.disable({
        actor: admin,
        connectionId: "connection-fresh-disable",
        reason: value,
        idempotencyKey: "disable-fresh-" + slug(valueName).toLowerCase(),
      }),
    );
    requireCredentialRejection(
      "store." + valueName + ".disableReason",
      disable,
    );
    if (disableStore.events().length !== disableBefore) {
      failures.push("store disable free-form boundary moved the event head");
    }

    const deleteStore = makeStore();
    deleteStore.create({
      actor: admin,
      ...definition({ connectionId: "connection-fresh-delete" }),
      idempotencyKey: "create-fresh-delete",
    });
    const deleteBefore = deleteStore.events().length;
    const remove = attempt(() =>
      deleteStore.delete({
        actor: admin,
        connectionId: "connection-fresh-delete",
        reason: value,
        idempotencyKey: "delete-fresh-" + slug(valueName).toLowerCase(),
      }),
    );
    requireCredentialRejection("store." + valueName + ".deleteReason", remove);
    if (deleteStore.events().length !== deleteBefore) {
      failures.push("store delete free-form boundary moved the event head");
    }
    rows[valueName] = {
      create: { metadata, label, capability },
      disable,
      delete: remove,
      eventCounts: {
        createBefore: before,
        createAfter: store.events().length,
        disableBefore: disableBefore,
        disableAfter: disableStore.events().length,
        deleteBefore,
        deleteAfter: deleteStore.events().length,
      },
    };
  }

  const hiddenStore = makeStore();
  const hiddenCreate = attempt(() =>
    hiddenStore.create({
      actor: admin,
      ...definition({
        connectionId: "connection-fresh-hidden-value",
        metadata: { safe: zeroWidthUrlSafe },
      }),
      idempotencyKey: "create-fresh-hidden-value",
    }),
  );
  if (hiddenCreate.accepted) {
    addFinding(
      "E5-T02-CRITIC-FRESH-ZERO-WIDTH-STORE",
      "high",
      "An invisible Unicode format character bypassed the store free-form boundary and was appendable",
      {
        boundary: "store.create.metadata",
        eventCount: hiddenStore.events().length,
        canonicalLength: urlSafe23.length,
        attackedLength: zeroWidthUrlSafe.length,
        persistedMetadataKeys: hiddenStore.snapshot().connections[
          "connection-fresh-hidden-value"
        ]?.metadata
          ? Object.keys(
              hiddenStore.snapshot().connections[
                "connection-fresh-hidden-value"
              ].metadata,
            )
          : [],
      },
    );
  }

  const identifierStore = makeStore();
  const ordinaryCreate = attempt(() =>
    identifierStore.create({
      actor: admin,
      ...definition({ connectionId: longConnectionId }),
      idempotencyKey: "create-fresh-ordinary-id",
    }),
  );
  requireAccepted("store.longOpaqueConnectionId", ordinaryCreate);
  const capture = attempt(() =>
    identifierStore.captureForRun({
      actor: member,
      connectionId: longConnectionId,
      runId: longRunId,
    }),
  );
  requireAccepted("store.longOpaqueRunId", capture);
  const providerConnection = attempt(() =>
    makeStore().create({
      actor: admin,
      ...definition({ connectionId: providerShape }),
      idempotencyKey: "create-fresh-provider-id",
    }),
  );
  requireAnyRejection("store.providerTokenConnectionId", providerConnection);
  const providerCapture = attempt(() =>
    identifierStore.captureForRun({
      actor: member,
      connectionId: longConnectionId,
      runId: providerShape,
    }),
  );
  requireAnyRejection("store.providerTokenRunId", providerCapture);
  rows.identifierCompatibility = {
    ordinaryCreate,
    capture,
    providerConnection,
    providerCapture,
    eventCountAfterIdentifierChecks: identifierStore.events().length,
  };
  return rows;
}

function identifierPolicyFixture() {
  const runtime = {};
  const explicit = {
    providerToken: providerShape,
    privateKey: privateKeyShape,
    url: urlShape,
    connectionString: connectionStringShape,
    assignment: assignmentShape,
    json: jsonCredentialShape,
  };
  for (const [name, value] of Object.entries(explicit)) {
    const outcomes = {
      opaqueId: attempt(() => normalizeOpaqueIdForStore(value, "$.id")),
      principalId: attempt(() => normalizePrincipal({ ...admin, id: value })),
      principalWorkspace: attempt(() =>
        normalizePrincipal({ ...member, workspaceId: value }),
      ),
      ownerId: attempt(() => normalizeOwner({ kind: "workspace", id: value })),
    };
    for (const [boundary, outcome] of Object.entries(outcomes)) {
      requireAnyRejection(
        "runtime.identifier." + name + "." + boundary,
        outcome,
      );
    }
    runtime[name] = outcomes;
  }
  const ordinary = {
    opaqueId: attempt(() => normalizeOpaqueIdForStore(longConnectionId)),
    principalId: attempt(() =>
      normalizePrincipal({ ...admin, id: longActorId }),
    ),
    principalWorkspace: attempt(() =>
      normalizePrincipal({ ...member, workspaceId: longWorkspaceId }),
    ),
    ownerId: attempt(() =>
      normalizeOwner({ kind: "workspace", id: longWorkspaceId }),
    ),
    runId: attempt(() => normalizeOpaqueIdForStore(longRunId)),
  };
  for (const [name, outcome] of Object.entries(ordinary)) {
    requireAccepted("runtime.identifier.ordinary." + name, outcome);
  }
  return { explicitRejected: runtime, ordinaryAccepted: ordinary };
}

function eventIdentityFixture() {
  const fields = [
    "eventId",
    "workspaceId",
    "actorId",
    "idempotencyKey",
    "connectionId",
  ];
  const ordinary = {};
  const explicit = {};
  for (const field of fields) {
    const ordinaryValue = {
      eventId: "event-fresh-opaque-identifier-000001",
      workspaceId: longWorkspaceId,
      actorId: longActorId,
      idempotencyKey: "idempotency-fresh-opaque-identifier-000001",
      connectionId: longConnectionId,
    }[field];
    const ordinaryEvent = createdEvent({ [field]: ordinaryValue });
    if (field === "connectionId") {
      ordinaryEvent.data.connectionId = ordinaryValue;
    }
    if (field === "workspaceId") {
      ordinaryEvent.data.workspaceId = ordinaryValue;
      ordinaryEvent.data.owner.id = ordinaryValue;
    }
    const ordinaryOutcome = attempt(() =>
      normalizeConnectionEvent(ordinaryEvent),
    );
    requireAccepted("runtime.eventIdentity.ordinary." + field, ordinaryOutcome);
    ordinary[field] = ordinaryOutcome;

    const providerEvent = createdEvent({ [field]: providerShape });
    if (field === "connectionId")
      providerEvent.data.connectionId = providerShape;
    if (field === "workspaceId") {
      providerEvent.data.workspaceId = providerShape;
      providerEvent.data.owner.id = providerShape;
    }
    const providerOutcome = attempt(() =>
      normalizeConnectionEvent(providerEvent),
    );
    requireAnyRejection(
      "runtime.eventIdentity.provider." + field,
      providerOutcome,
    );
    explicit[field] = providerOutcome;
  }
  return { ordinaryAccepted: ordinary, explicitRejected: explicit };
}

function adversarialFixture() {
  const recursive = { nested: { safe: urlSafe23 } };
  recursive.self = recursive;
  const cases = {
    recursive: attempt(() => normalizeMetadata(recursive)),
    caseVariantKey: attempt(() => normalizeMetadata(caseVariantKey)),
    unicodeEscapedKey: attempt(() =>
      normalizeMetadata(JSON.parse('{"\\u0074oken":"opaque-value"}')),
    ),
    parsedPrototypeKey: attempt(() => normalizeMetadata(parsedPrototypeKey)),
    escapedJsonCredential: attempt(() =>
      normalizeMetadata({ safe: escapedJsonCredential }),
    ),
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
  for (const [name, outcome] of Object.entries(cases)) {
    if (name === "caseVariantKey" || name === "unicodeEscapedKey") {
      requireCredentialRejection("runtime.adversarial." + name, outcome);
    } else if (name === "escapedJsonCredential") {
      requireCredentialRejection("runtime.adversarial." + name, outcome);
    } else {
      requireAnyRejection("runtime.adversarial." + name, outcome);
    }
  }
  return cases;
}

function lifecycleFixture() {
  const store = makeStore();
  const connectionId = "connection-fresh-lifecycle";
  store.create({
    actor: admin,
    ...definition({ connectionId }),
    idempotencyKey: "create-fresh-lifecycle",
  });
  const beforeRotate = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-fresh-stable",
  });
  store.rotate({
    actor: admin,
    connectionId,
    expectedRevision: 1,
    secretRef: secretRef(2),
    idempotencyKey: "rotate-fresh-lifecycle",
  });
  const sameRun = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-fresh-stable",
  });
  const newRun = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-fresh-new",
  });
  store.disable({
    actor: admin,
    connectionId,
    reason: "fresh-maintenance",
    idempotencyKey: "disable-fresh-lifecycle",
  });
  const existingAfterDisable = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-fresh-stable",
  });
  const disabledNewRun = attempt(() =>
    store.captureForRun({
      actor: member,
      connectionId,
      runId: "run-fresh-disabled",
    }),
  );
  store.delete({
    actor: admin,
    connectionId,
    reason: "fresh-retired",
    idempotencyKey: "delete-fresh-lifecycle",
  });
  const existingAfterDelete = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-fresh-stable",
  });
  const deletedNewRun = attempt(() =>
    store.captureForRun({
      actor: member,
      connectionId,
      runId: "run-fresh-deleted",
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
  if (!passed)
    failures.push("lifecycle, capture, or duplicate replay parity failed");
  return {
    passed,
    revisions: {
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
  const connectionId = "connection-fresh-authz";
  store.create({
    actor: admin,
    ...definition({ connectionId }),
    idempotencyKey: "create-fresh-authz",
  });
  const ownership = {
    memberRead: store.authorization({ actor: member, connectionId }),
    memberGrant: store.authorization({
      actor: member,
      connectionId,
      action: "grant",
    }),
    memberDelete: store.authorization({
      actor: member,
      connectionId,
      action: "delete",
    }),
  };
  const foreign = {
    ...admin,
    tenantId: "tenant-fresh-foreign",
    workspaceId: "workspace-fresh-foreign",
  };
  const operations = {
    read: () => store.read({ actor: foreign, connectionId }),
    grant: () =>
      store.captureForRun({
        actor: foreign,
        connectionId,
        runId: "run-fresh-foreign",
      }),
    rotate: () =>
      store.rotate({
        actor: foreign,
        connectionId,
        expectedRevision: 1,
        secretRef: secretRef(2),
        idempotencyKey: "rotate-fresh-foreign",
      }),
    disable: () =>
      store.disable({
        actor: foreign,
        connectionId,
        idempotencyKey: "disable-fresh-foreign",
      }),
    delete: () =>
      store.delete({
        actor: foreign,
        connectionId,
        idempotencyKey: "delete-fresh-foreign",
      }),
  };
  const before = store.stateDigest();
  const foreignErrors = {};
  const unknownErrors = {};
  for (const [operation, action] of Object.entries(operations)) {
    foreignErrors[operation] = notFoundOutcome(action);
    unknownErrors[operation] = notFoundOutcome(() => {
      const input = {
        actor: foreign,
        connectionId: "connection-fresh-unknown",
      };
      if (operation === "grant") input.runId = "run-fresh-foreign";
      if (operation === "rotate") {
        input.expectedRevision = 1;
        input.secretRef = secretRef(2);
        input.idempotencyKey = "rotate-fresh-unknown";
      }
      if (operation === "disable" || operation === "delete") {
        input.idempotencyKey = operation + "-fresh-unknown";
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
    });
  }
  const foreignAuthorization = store.authorization({
    actor: foreign,
    connectionId,
  });
  const unknownAuthorization = store.authorization({
    actor: foreign,
    connectionId: "connection-fresh-unknown",
  });
  const equal =
    JSON.stringify(foreignErrors) === JSON.stringify(unknownErrors) &&
    JSON.stringify(foreignAuthorization) ===
      JSON.stringify(unknownAuthorization) &&
    store.stateDigest() === before;
  if (!equal)
    failures.push("authorization parity or foreign/unknown neutrality failed");
  return {
    ownership,
    foreignErrors,
    unknownErrors,
    foreignAuthorization,
    unknownAuthorization,
    foreignUnknownParity: equal,
    stateDigestUnchanged: store.stateDigest() === before,
  };
}

function notFoundOutcome(action) {
  const outcome = attempt(action);
  if (outcome.accepted || outcome.code !== CONNECTION_ERROR_CODES.NOT_FOUND) {
    failures.push(
      "foreign or unknown authorization did not return typed not-found",
    );
  }
  return outcome;
}

async function publicSchemaFixture() {
  const ajvPath =
    process.env.AJV_2020_MODULE ??
    "/opt/homebrew/lib/node_modules/verdaccio/node_modules/ajv/dist/2020.js";
  const schema = JSON.parse(
    await readFile(
      path.join(
        root,
        "packages/connections/src/schemas/connection-events.v1.schema.json",
      ),
      "utf8",
    ),
  );
  const { default: Ajv2020 } = await import(pathToFileURL(ajvPath).href);
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
    schema,
  );
  const outcomes = {};
  const freeFormValues = [
    ["url-safe-23", urlSafe23],
    ["url-safe-long", urlSafeLong],
    ...Object.entries(wrappers(urlSafe23)).map(([name, value]) => [
      "url-safe-23-" + name,
      value,
    ]),
    ...Object.entries(wrappers(urlSafeLong)).map(([name, value]) => [
      "url-safe-long-" + name,
      value,
    ]),
    ["standard-base64", neutralStandard],
    ["provider-token", providerShape],
    ["private-key", privateKeyShape],
    ["url", urlShape],
    ["connection-string", connectionStringShape],
    ["assignment", assignmentShape],
    ["json", jsonCredentialShape],
    ["escaped-json", escapedJsonCredential],
  ];
  for (const [name, value] of freeFormValues) {
    for (const [boundary, event] of Object.entries({
      metadata: createdEvent({ data: { metadata: { safe: value } } }),
      label: createdEvent({ data: { label: value } }),
      reason: terminalEvent({ reason: value }),
    })) {
      const outcome = schemaAttempt(validate, event);
      outcomes[name + "." + boundary] = outcome;
      if (outcome.accepted) {
        addFinding(
          "E5-T02-CRITIC-FRESH-SCHEMA-" + slug(name + "-" + boundary),
          "high",
          "The public schema accepted credential-shaped material in a free-form path",
          { boundary: name + "." + boundary, outcome },
        );
      }
    }
  }

  const hiddenEvents = {
    metadata: createdEvent({
      data: { metadata: { safe: zeroWidthUrlSafe } },
    }),
    label: createdEvent({ data: { label: zeroWidthUrlSafe } }),
    reason: terminalEvent({ reason: zeroWidthUrlSafe }),
  };
  for (const [boundary, event] of Object.entries(hiddenEvents)) {
    const outcome = schemaAttempt(validate, event);
    outcomes["zero-width." + boundary] = outcome;
    if (outcome.accepted) {
      addFinding(
        "E5-T02-CRITIC-FRESH-SCHEMA-ZERO-WIDTH-" + slug(boundary),
        "high",
        "The public schema accepted an invisible Unicode format character around encoded material",
        {
          boundary: "schema." + boundary,
          canonicalLength: urlSafe23.length,
          attackedLength: zeroWidthUrlSafe.length,
          outcome,
        },
      );
    }
  }

  const recursive = createdEvent({
    data: { metadata: { outer: { inner: { safe: urlSafe23 } } } },
  });
  const adversarial = {
    recursive: recursive,
    caseVariantKey: createdEvent({ data: { metadata: caseVariantKey } }),
    unicodeEscapedKey: createdEvent({
      data: { metadata: JSON.parse('{"\\u0074oken":"opaque-value"}') },
    }),
    parsedPrototypeKey: createdEvent({
      data: { metadata: parsedPrototypeKey },
    }),
    extraEvent: { ...createdEvent(), unexpectedField: "value" },
    extraData: createdEvent({ data: { unexpectedField: "value" } }),
    extraSecretRef: createdEvent({
      data: { secretRef: { ...secretRef(1), unexpectedField: "value" } },
    }),
    extraOwner: createdEvent({
      data: {
        owner: {
          kind: "workspace",
          id: scope.workspaceId,
          unexpectedField: "value",
        },
      },
    }),
  };
  for (const [name, event] of Object.entries(adversarial)) {
    const outcome = schemaAttempt(validate, event);
    outcomes["adversarial." + name] = outcome;
    if (outcome.accepted) {
      addFinding(
        "E5-T02-CRITIC-FRESH-SCHEMA-ADVERSARIAL-" + slug(name),
        "high",
        "The public schema accepted a recursive, key-confusable, or extra-field attack",
        { case: name, outcome },
      );
    }
  }

  const longIdentifierEvent = createdEvent({
    eventId: "event-fresh-opaque-identifier-000001",
    workspaceId: longWorkspaceId,
    actorId: longActorId,
    idempotencyKey: "idempotency-fresh-opaque-identifier-000001",
    connectionId: longConnectionId,
    data: {
      connectionId: longConnectionId,
      workspaceId: longWorkspaceId,
      owner: { kind: "workspace", id: longWorkspaceId },
    },
  });
  outcomes.longOrdinaryIdentifiers = schemaAttempt(
    validate,
    longIdentifierEvent,
  );
  if (!outcomes.longOrdinaryIdentifiers.accepted) {
    failures.push("public schema rejected long ordinary opaque identifiers");
    addFinding(
      "E5-T02-CRITIC-FRESH-SCHEMA-LONG-ID",
      "medium",
      "The public identifier schema rejected a valid ordinary opaque identifier",
      { outcome: outcomes.longOrdinaryIdentifiers },
    );
  }

  const providerIdentity = {};
  for (const field of [
    "eventId",
    "workspaceId",
    "actorId",
    "idempotencyKey",
    "connectionId",
  ]) {
    const event = createdEvent({ [field]: providerShape });
    if (field === "workspaceId") {
      event.data.workspaceId = providerShape;
      event.data.owner.id = providerShape;
    }
    if (field === "connectionId") event.data.connectionId = providerShape;
    providerIdentity[field] = schemaAttempt(validate, event);
    if (providerIdentity[field].accepted) {
      addFinding(
        "E5-T02-CRITIC-FRESH-SCHEMA-PROVIDER-ID-" + slug(field),
        "high",
        "The public identifier schema accepted an explicit provider-shaped identifier",
        { field, outcome: providerIdentity[field] },
      );
    }
  }

  const staticShape = {
    labelRef: schema.$defs.label?.not?.$ref,
    metadataStringRef: schema.$defs.metadataValue?.oneOf?.find(
      (entry) => entry.type === "string",
    )?.not?.$ref,
    terminalReasonRef: schema.$defs.terminalData?.properties?.reason?.not?.$ref,
    identifierRef: schema.$defs.identifier?.not?.$ref,
    opaqueIdRef: schema.$defs.opaqueId?.not?.$ref,
  };
  const expectedStaticShape = {
    labelRef: "#/$defs/credentialValueShape",
    metadataStringRef: "#/$defs/credentialValueShape",
    terminalReasonRef: "#/$defs/credentialValueShape",
    identifierRef: "#/$defs/identifierCredentialShape",
    opaqueIdRef: "#/$defs/identifierCredentialShape",
  };
  if (JSON.stringify(staticShape) !== JSON.stringify(expectedStaticShape)) {
    failures.push("public schema does not preserve the requested shape split");
    addFinding(
      "E5-T02-CRITIC-FRESH-SCHEMA-SHAPE-SPLIT",
      "high",
      "Public schema free-form and identifier shape references diverged from policy",
      { staticShape },
    );
  }
  return { outcomes, providerIdentity, staticShape, expectedStaticShape };
}

function schemaAttempt(validate, value) {
  const accepted = validate(value);
  return {
    accepted,
    errorCount: validate.errors?.length ?? 0,
    firstError: validate.errors?.[0]
      ? {
          keyword: validate.errors[0].keyword,
          instancePath: validate.errors[0].instancePath,
          schemaPath: validate.errors[0].schemaPath,
        }
      : null,
  };
}

async function detectorSensitivityFixture() {
  const scratch = await mkdtemp(
    path.join(taskDirectory, "work/fresh-sensitivity-"),
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
    const detectorLine =
      "if (!allowGenericBase64 && isBase64EncodedValue(value)) return true;";
    if (!source.includes(detectorLine)) {
      failures.push("detector sensitivity mutation target was not found");
      return { mutationTargetFound: false };
    }
    await writeFile(schemaPath, source.replace(detectorLine, ""));
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
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      mutatedAccepted = true;
    } catch {
      mutatedAccepted = false;
    }
    if (!mutatedAccepted) {
      failures.push(
        "removing the generic base64 detector did not turn the verifier red",
      );
      addFinding(
        "E5-T02-CRITIC-FRESH-SENSITIVITY",
        "high",
        "The generic base64 detector sensitivity mutation stayed rejecting",
        { mutatedAccepted },
      );
    }
    return {
      mutationTargetFound: true,
      branchRemoved: "generic standard and URL-safe base64 detector",
      mutatedFixtureAccepted: mutatedAccepted,
      verifierWouldTurnRed: mutatedAccepted,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function makeStore() {
  let now = Date.parse("2026-08-20T10:00:00.000Z");
  return createConnectionStore({
    ...scope,
    clock: () => new Date((now += 1000)),
  });
}

async function writeAndScanResult(value) {
  await writeFile(
    path.join(evidenceDirectory, "independent-probes.json"),
    JSON.stringify(value, null, 2) + "\n",
  );
  const files = (await listJsonFiles(evidenceDirectory)).sort();
  const patterns = [
    /-----BEGIN [^-]*PRIVATE KEY-----/iu,
    /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/iu,
    /\b(?:password|token|cookie|authorization)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/iu,
    /(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?|amqp):\/\/\S+/iu,
  ];
  const findings = [];
  for (const name of files) {
    const content = await readFile(path.join(evidenceDirectory, name), "utf8");
    for (const [rule, pattern] of patterns.entries()) {
      if (pattern.test(content)) findings.push({ file: name, rule });
    }
  }
  const scan = { leaked: findings.length > 0, filesChecked: files, findings };
  value.leakScan = scan;
  await writeFile(
    path.join(evidenceDirectory, "independent-probes.json"),
    JSON.stringify(value, null, 2) + "\n",
  );
  return scan;
}

async function listJsonFiles(directory, relative = "") {
  const entries = await readdir(path.join(directory, relative), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonFiles(directory, child)));
    } else if (entry.name.endsWith(".json")) {
      files.push(child);
    }
  }
  return files;
}
