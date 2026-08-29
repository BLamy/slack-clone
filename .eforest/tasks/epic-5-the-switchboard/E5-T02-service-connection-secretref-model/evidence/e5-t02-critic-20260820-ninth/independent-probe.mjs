import assert from "node:assert/strict";
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

import Ajv2020 from "/opt/homebrew/lib/node_modules/verdaccio/node_modules/ajv/dist/2020.js";

const root = process.cwd();
const evidenceDirectory = path.dirname(fileURLToPath(import.meta.url));
const taskDirectory = path.dirname(path.dirname(evidenceDirectory));
const {
  CONNECTION_ERROR_CODES,
  createConnectionStore,
  normalizeConnectionDefinition,
  normalizeConnectionEvent,
  normalizeMetadata,
  normalizeOpaqueIdForStore,
  normalizeOwner,
  normalizePrincipal,
  normalizeReason,
  normalizeSecretRef,
  replayConnectionEvents,
} = await import(
  pathToFileURL(path.join(root, "packages/connections/src/index.mjs")).href
);
const exactHead = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const schema = JSON.parse(
  await readFile(
    path.join(
      root,
      "packages/connections/src/schemas/connection-events.v1.schema.json",
    ),
    "utf8",
  ),
);
const validator = new Ajv2020({ allErrors: true, strict: false }).compile(
  schema,
);

const scope = {
  tenantId: "tenant-ninth",
  workspaceId: "workspace-ninth",
};
const admin = {
  ...scope,
  id: "user-ninth-admin",
  kind: "user",
  role: "admin",
  capabilities: [],
};
const member = {
  ...scope,
  id: "user-ninth-member",
  kind: "user",
  role: "member",
  capabilities: [],
};

const findings = [];
const failures = [];

function addFinding(id, severity, summary, evidence) {
  findings.push({ id, severity, summary, evidence });
}

function outcome(action) {
  try {
    const value = action();
    return {
      accepted: true,
      resultType: Array.isArray(value) ? "array" : typeof value,
    };
  } catch (error) {
    return {
      accepted: false,
      code: error?.code ?? error?.name ?? "THROWN",
      path: error?.path ?? null,
    };
  }
}

function schemaOutcome(event) {
  const accepted = validator(event);
  return {
    accepted,
    errorCount: validator.errors?.length ?? 0,
  };
}

function expectRejected(label, result, source, severity = "high") {
  if (result.accepted) {
    addFinding(
      "E5-T02-CRITIC-NINTH-" + label.toUpperCase().replaceAll(".", "-"),
      severity,
      "A credential-shaped or malformed input crossed a required boundary",
      { source, label, outcome: result },
    );
  }
}

function expectAccepted(label, result, source, severity = "medium") {
  if (!result.accepted) {
    failures.push(label);
    addFinding(
      "E5-T02-CRITIC-NINTH-" + label.toUpperCase().replaceAll(".", "-"),
      severity,
      "A valid opaque compatibility value was rejected",
      { source, label, outcome: result },
    );
  }
}

function secretRef(revision = 1) {
  return {
    schemaVersion: 1,
    id: "secretref-ninth-" + String(revision).padStart(3, "0"),
    provider: "infisical",
    mount: "production",
    revision,
    label: "Ninth probe",
  };
}

function definition(overrides = {}) {
  return {
    schemaVersion: 1,
    connectionId: "connection-ninth-definition",
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    owner: { kind: "workspace", id: scope.workspaceId },
    provider: "github",
    integration: "issues",
    label: "Ninth probe",
    metadata: {},
    secretRef: secretRef(),
    ...overrides,
  };
}

function createdEvent(overrides = {}) {
  const base = {
    schemaVersion: 1,
    eventId: "event-ninth-created-001",
    eventType: "connection.created",
    workspaceId: scope.workspaceId,
    actorId: admin.id,
    idempotencyKey: "event-ninth-create-001",
    sequence: 1,
    serverTimestamp: "2026-08-20T12:00:00.000Z",
    connectionId: "connection-ninth-created",
    data: {
      connectionId: "connection-ninth-created",
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      owner: { kind: "workspace", id: scope.workspaceId },
      provider: "github",
      integration: "issues",
      label: "Ninth probe",
      metadata: {},
      secretRef: secretRef(),
      revision: 1,
    },
  };
  return {
    ...base,
    ...overrides,
    data: { ...base.data, ...(overrides.data ?? {}) },
  };
}

function terminalEvent(reason = "maintenance", overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: "event-ninth-terminal-001",
    eventType: "connection.disabled",
    workspaceId: scope.workspaceId,
    actorId: admin.id,
    idempotencyKey: "event-ninth-disable-001",
    sequence: 2,
    serverTimestamp: "2026-08-20T12:00:01.000Z",
    connectionId: "connection-ninth-created",
    data: { reason },
    ...overrides,
  };
}

function makeStore(label = "store") {
  let tick = 0;
  return createConnectionStore({
    ...scope,
    clock: () =>
      new Date(Date.parse("2026-08-20T12:00:00.000Z") + ++tick * 1000),
    idFactory: (kind) => kind + "-ninth-" + label + "-" + String(tick + 1),
  });
}

function createBase(store, connectionId = "connection-ninth-base") {
  return store.create({
    actor: admin,
    connectionId,
    owner: { kind: "workspace", id: scope.workspaceId },
    provider: "github",
    integration: "issues",
    label: "Ninth base",
    metadata: { safe: "value" },
    secretRef: secretRef(),
    idempotencyKey: "create-" + connectionId,
  });
}

function canonicalUrlSafe(bytesLength, expectedLength) {
  for (let seed = 0; seed < 256; seed += 1) {
    const bytes = Buffer.from(
      Array.from(
        { length: bytesLength },
        (_, index) => (seed + index * 37 + 251) & 0xff,
      ),
    );
    const value = bytes.toString("base64url");
    if (
      value.length === expectedLength &&
      /[-_]/u.test(value) &&
      Buffer.from(value, "base64url").equals(bytes)
    ) {
      return value;
    }
  }
  throw new Error("could not derive a canonical base64url fixture");
}

const urlSafe23 = canonicalUrlSafe(17, 23);
const urlSafeLong = canonicalUrlSafe(18, 24);
const standardBase64 = Buffer.from(urlSafe23, "base64url").toString("base64");
const providerToken = ["ghp", "_", "A".repeat(32)].join("");
const dash = "-".repeat(5);
const privateKey = [
  dash + "BEGIN",
  " ",
  "RSA",
  " ",
  "PRIVATE",
  " KEY",
  dash,
  "\n",
  "x".repeat(16),
  "\n" + dash + "END RSA",
  " ",
  "PRIVATE",
  " KEY",
  dash,
].join("");
const endpoint = ["https", "://user:pass@example.invalid/service"].join("");
const connectionString = [
  "host=db.example.invalid;user=app;pass",
  "word=synthetic",
].join("");
const assignment = ["client", "-", "secret=synthetic"].join("");
const credentialAssignment = ["pass", "word=synthetic"].join("");
const ordinaryLongId = "connection-opaque-" + "z".repeat(40);
const controls = [
  0x200b, 0x200d, 0xfeff, 0x202e, 0x2060, 0x2066, 0x180e, 0x061c,
].map((codePoint) => ({
  name: "U+" + codePoint.toString(16).toUpperCase().padStart(4, "0"),
  value: String.fromCodePoint(codePoint),
}));

assert.equal(urlSafe23.length, 23);
assert.equal(
  Buffer.from(urlSafe23, "base64url").toString("base64url"),
  urlSafe23,
);
assert.ok(urlSafeLong.length > urlSafe23.length);
assert.equal(
  Buffer.from(urlSafeLong, "base64url").toString("base64url"),
  urlSafeLong,
);

function insertControl(value, control) {
  const index = Math.max(1, Math.floor(value.length / 2));
  return value.slice(0, index) + control + value.slice(index);
}

function wrapControl(value, control) {
  return control + value + control;
}

function wrapWhitespace(value, whitespace) {
  return whitespace + value + whitespace;
}

const freeFormCases = [
  { name: "canonical-23", value: urlSafe23 },
  { name: "canonical-long", value: urlSafeLong },
  { name: "standard-base64", value: standardBase64 },
  { name: "provider-token", value: providerToken },
  { name: "private-key", value: privateKey },
  { name: "url", value: endpoint },
  { name: "connection-string", value: connectionString },
  { name: "assignment", value: assignment },
  { name: "credential-assignment", value: credentialAssignment },
];
for (const base of [urlSafe23, urlSafeLong, standardBase64]) {
  for (const whitespace of [" ", "\t", "\u00a0"]) {
    freeFormCases.push({
      name:
        (base === urlSafe23
          ? "canonical-23"
          : base === urlSafeLong
            ? "canonical-long"
            : "standard-base64") +
        "-wrapped-" +
        (whitespace === " " ? "space" : whitespace === "\t" ? "tab" : "nbsp"),
      value: wrapWhitespace(base, whitespace),
    });
  }
}
for (const control of controls) {
  for (const base of [urlSafe23, urlSafeLong]) {
    const baseName = base === urlSafe23 ? "canonical-23" : "canonical-long";
    freeFormCases.push({
      name: baseName + "-" + control.name + "-inserted",
      value: insertControl(base, control.value),
    });
    freeFormCases.push({
      name: baseName + "-" + control.name + "-wrapped",
      value: wrapControl(base, control.value),
    });
  }
  for (const [shape, value] of [
    ["provider-token", providerToken],
    ["private-key", privateKey],
    ["url", endpoint],
    ["connection-string", connectionString],
  ]) {
    freeFormCases.push({
      name: shape + "-" + control.name + "-inserted",
      value: insertControl(value, control.value),
    });
    freeFormCases.push({
      name: shape + "-" + control.name + "-wrapped",
      value: wrapControl(value, control.value),
    });
  }
  freeFormCases.push(
    {
      name: "provider-token-prefix-" + control.name,
      value: ["ghp", control.value, "_", "A".repeat(32)].join(""),
    },
    {
      name: "private-key-header-" + control.name,
      value: [
        dash + "BEGIN",
        " ",
        control.value,
        "RSA",
        " ",
        "PRIVATE",
        " KEY",
        dash,
        "\n",
        "x".repeat(16),
        "\n" + dash + "END RSA",
        " ",
        "PRIVATE",
        " KEY",
        dash,
      ].join(""),
    },
    {
      name: "url-scheme-" + control.name,
      value: [
        "http",
        control.value,
        "s://user:pass@example.invalid/service",
      ].join(""),
    },
    {
      name: "connection-string-key-" + control.name,
      value: [
        "host=db.example.invalid;pass",
        control.value,
        "word=synthetic",
      ].join(""),
    },
  );
}

const freeFormBoundaries = [
  "metadata",
  "label",
  "reason",
  "capability",
  "connection-definition-metadata",
  "terminal-data",
];

function runtimeFreeForm(value, boundary) {
  switch (boundary) {
    case "metadata":
      return normalizeMetadata({ safe: value });
    case "label":
      return normalizeConnectionDefinition(definition({ label: value })).label;
    case "reason":
      return normalizeReason(value);
    case "capability":
      return normalizePrincipal({ ...admin, capabilities: [value] })
        .capabilities;
    case "connection-definition-metadata":
      return normalizeConnectionDefinition(
        definition({ metadata: { safe: value } }),
      ).metadata;
    case "terminal-data":
      return normalizeConnectionEvent(terminalEvent(value)).data.reason;
    default:
      throw new Error("unknown runtime free-form boundary");
  }
}

function storeFreeForm(value, boundary) {
  const store = makeStore(boundary);
  const connectionId = "connection-ninth-" + boundary;
  const beforeCreate = store.events().length;
  if (
    boundary === "metadata" ||
    boundary === "connection-definition-metadata" ||
    boundary === "label"
  ) {
    store.create({
      actor: admin,
      connectionId,
      owner: { kind: "workspace", id: scope.workspaceId },
      provider: "github",
      integration: "issues",
      label: boundary === "label" ? value : "Ninth store",
      metadata:
        boundary === "metadata" || boundary === "connection-definition-metadata"
          ? { safe: value }
          : {},
      secretRef: secretRef(),
      idempotencyKey: "create-" + boundary,
    });
  } else {
    createBase(store, connectionId);
    const operation =
      boundary === "reason" || boundary === "capability"
        ? "disable"
        : "disable";
    if (boundary === "capability") {
      store.authorization({
        actor: { ...member, capabilities: [value] },
        connectionId,
      });
    } else {
      store[operation]({
        actor: admin,
        connectionId,
        reason: value,
        idempotencyKey: operation + "-" + boundary,
      });
    }
  }
  return { eventCount: store.events().length, beforeCreate };
}

function publicFreeForm(value, boundary) {
  if (boundary === "label") {
    return schemaOutcome(createdEvent({ data: { label: value } }));
  }
  if (
    boundary === "metadata" ||
    boundary === "connection-definition-metadata"
  ) {
    return schemaOutcome(createdEvent({ data: { metadata: { safe: value } } }));
  }
  if (boundary === "terminal-data" || boundary === "reason") {
    return schemaOutcome(terminalEvent(value));
  }
  return { accepted: false, skipped: true };
}

const freeFormMatrix = [];
for (const testCase of freeFormCases) {
  for (const boundary of freeFormBoundaries) {
    const runtime = outcome(() => runtimeFreeForm(testCase.value, boundary));
    const publicResult = publicFreeForm(testCase.value, boundary);
    const storeResult = outcome(() => storeFreeForm(testCase.value, boundary));
    const row = {
      case: testCase.name,
      boundary,
      runtime,
      store: storeResult,
      public: publicResult,
    };
    freeFormMatrix.push(row);
    expectRejected(
      "runtime-free-form-" + testCase.name + "-" + boundary,
      runtime,
      "packages/connections/src/schema.mjs:673-689,768-774",
    );
    if (boundary !== "capability") {
      expectRejected(
        "store-free-form-" + testCase.name + "-" + boundary,
        storeResult,
        "packages/connections/src/store.mjs:45-153,237-277",
      );
      expectRejected(
        "schema-free-form-" + testCase.name + "-" + boundary,
        publicResult,
        "packages/connections/src/schemas/connection-events.v1.schema.json:105-139,177-222,224-280",
      );
    }
  }
}

const escapedKey = "\\" + "u0074" + "oken";
const escapedJson = '{"' + escapedKey + '":"synthetic"}';
const caseJson = '{"' + ["To", "Ke", "N"].join("") + '":"synthetic"}';
const nestedCaseObject = {
  safe: { [["To", "Ke", "N"].join("")]: "synthetic" },
};
const parsedPrototypeObject = JSON.parse('{"__proto__":{"safe":"synthetic"}}');
const controlJsonCases = controls.map(({ name, value }) => ({
  name,
  value: '{"' + ["to", value, "ken"].join("") + '":"synthetic"}',
}));
const jsonCases = [
  { name: "unicode-escaped-json-key", value: escapedJson },
  { name: "case-variant-json-key", value: caseJson },
  ...controlJsonCases.map((entry) => ({
    name: "format-control-json-key-" + entry.name,
    value: entry.value,
  })),
];
const jsonMatrix = [];
for (const testCase of jsonCases) {
  for (const boundary of freeFormBoundaries) {
    const runtime = outcome(() => runtimeFreeForm(testCase.value, boundary));
    const store = outcome(() => storeFreeForm(testCase.value, boundary));
    const publicResult = publicFreeForm(testCase.value, boundary);
    jsonMatrix.push({
      case: testCase.name,
      boundary,
      runtime,
      store,
      public: publicResult,
    });
    expectRejected(
      "runtime-json-" + testCase.name + "-" + boundary,
      runtime,
      "packages/connections/src/schema.mjs:673-687,385-438",
    );
    expectRejected(
      "store-json-" + testCase.name + "-" + boundary,
      store,
      "packages/connections/src/store.mjs:45-153,237-277",
    );
    if (boundary !== "capability") {
      expectRejected(
        "schema-json-" + testCase.name + "-" + boundary,
        publicResult,
        "packages/connections/src/schemas/connection-events.v1.schema.json:130-138,182-215",
      );
    }
  }
}

const specialRuntime = [
  ["nested-case-key", nestedCaseObject],
  ["parsed-prototype-key", parsedPrototypeObject],
];
const cyclicObject = {};
cyclicObject.self = cyclicObject;
specialRuntime.push(["cyclic-object", cyclicObject]);
let deepObject = "synthetic";
for (let depth = 0; depth < 8; depth += 1) deepObject = { nested: deepObject };
specialRuntime.push(["deep-metadata", deepObject]);
const specialMatrix = [];
for (const [name, value] of specialRuntime) {
  const runtime = outcome(() => normalizeMetadata(value));
  const store = outcome(() => {
    const target = makeStore(name);
    createBase(target, "connection-ninth-special-" + name);
    return target.create({
      actor: admin,
      connectionId: "connection-ninth-special-" + name,
      owner: { kind: "workspace", id: scope.workspaceId },
      provider: "github",
      integration: "issues",
      label: "duplicate",
      metadata: value,
      secretRef: secretRef(),
      idempotencyKey: "duplicate-special-" + name,
    });
  });
  specialMatrix.push({ name, runtime, store });
  expectRejected(
    "runtime-special-" + name,
    runtime,
    "packages/connections/src/schema.mjs:562-658,801-820",
  );
  expectRejected(
    "store-special-" + name,
    store,
    "packages/connections/src/store.mjs:45-85",
  );
}

const extraRuntime = {
  event: outcome(() =>
    normalizeConnectionEvent({ ...createdEvent(), extraField: "synthetic" }),
  ),
  data: outcome(() =>
    normalizeConnectionEvent(
      createdEvent({ data: { extraField: "synthetic" } }),
    ),
  ),
  secretRef: outcome(() =>
    normalizeSecretRef({ ...secretRef(), extraField: "synthetic" }),
  ),
  owner: outcome(() =>
    normalizeOwner({
      kind: "workspace",
      id: scope.workspaceId,
      extraField: "synthetic",
    }),
  ),
  definition: outcome(() =>
    normalizeConnectionDefinition({ ...definition(), extraField: "synthetic" }),
  ),
};
for (const [name, result] of Object.entries(extraRuntime)) {
  expectRejected(
    "runtime-extra-" + name,
    result,
    "packages/connections/src/schema.mjs:74-80,131-146,201-206,301-317,474-492",
  );
}
const extraPublic = {
  event: schemaOutcome({ ...createdEvent(), extraField: "synthetic" }),
  data: schemaOutcome(createdEvent({ data: { extraField: "synthetic" } })),
  secretRef: schemaOutcome(
    createdEvent({
      data: { secretRef: { ...secretRef(), extraField: "synthetic" } },
    }),
  ),
  owner: schemaOutcome(
    createdEvent({
      data: {
        owner: {
          kind: "workspace",
          id: scope.workspaceId,
          extraField: "synthetic",
        },
      },
    }),
  ),
};
for (const [name, result] of Object.entries(extraPublic)) {
  expectRejected(
    "schema-extra-" + name,
    result,
    "packages/connections/src/schemas/connection-events.v1.schema.json:18,155-176,224-280",
  );
}
const prototypePublic = schemaOutcome(
  createdEvent({ data: { metadata: parsedPrototypeObject } }),
);
expectRejected(
  "schema-parsed-prototype-key",
  prototypePublic,
  "packages/connections/src/schemas/connection-events.v1.schema.json:184-198",
);
const deepPublic = schemaOutcome(
  createdEvent({ data: { metadata: { nested: deepObject } } }),
);
if (deepPublic.accepted) {
  addFinding(
    "E5-T02-CRITIC-NINTH-SCHEMA-UNBOUNDED-METADATA",
    "medium",
    "The public schema accepts metadata deeper than the runtime depth limit",
    {
      source:
        "packages/connections/src/schema.mjs:562-569; packages/connections/src/schemas/connection-events.v1.schema.json:199-222",
      depth: 9,
      outcome: deepPublic,
    },
  );
}

const identifierFields = [
  "eventId",
  "actorId",
  "workspaceId",
  "idempotencyKey",
  "connectionId",
];
const identifierShapes = [
  ["provider-token", providerToken],
  ["private-key", privateKey],
  ["url", endpoint],
  ["connection-string", connectionString],
  ["assignment", assignment],
  ["unicode-escaped-json", escapedJson],
];
const identifierMatrix = [];
for (const [shape, value] of identifierShapes) {
  for (const field of identifierFields) {
    const event = createdEvent();
    event[field] = value;
    if (field === "workspaceId") event.data.workspaceId = value;
    if (field === "connectionId") event.data.connectionId = value;
    const runtime = outcome(() => normalizeConnectionEvent(event));
    const publicResult = schemaOutcome(event);
    identifierMatrix.push({ shape, field, runtime, public: publicResult });
    expectRejected(
      "runtime-identifier-" + shape + "-" + field,
      runtime,
      "packages/connections/src/schema.mjs:292-373,740-762",
    );
    expectRejected(
      "schema-identifier-" + shape + "-" + field,
      publicResult,
      "packages/connections/src/schemas/connection-events.v1.schema.json:73-150",
    );
  }
}
for (const control of controls) {
  const value = insertControl(providerToken, control.value);
  const event = createdEvent({ eventId: value });
  const runtime = outcome(() => normalizeConnectionEvent(event));
  const publicResult = schemaOutcome(event);
  identifierMatrix.push({
    shape: "provider-token-" + control.name + "-inserted",
    field: "eventId",
    runtime,
    public: publicResult,
  });
  expectRejected(
    "runtime-identifier-provider-token-" + control.name,
    runtime,
    "packages/connections/src/schema.mjs:673-705,750-762",
  );
  expectRejected(
    "schema-identifier-provider-token-" + control.name,
    publicResult,
    "packages/connections/src/schemas/connection-events.v1.schema.json:73-150",
  );
}
const ordinaryEventMatrix = [];
for (const field of identifierFields) {
  const event = createdEvent();
  event[field] = ordinaryLongId;
  if (field === "workspaceId") event.data.workspaceId = ordinaryLongId;
  if (field === "connectionId") event.data.connectionId = ordinaryLongId;
  const runtime = outcome(() => normalizeConnectionEvent(event));
  const publicResult = schemaOutcome(event);
  ordinaryEventMatrix.push({ field, runtime, public: publicResult });
  expectAccepted(
    "runtime-long-identifier-" + field,
    runtime,
    "packages/connections/src/schema.mjs:740-762",
  );
  expectAccepted(
    "schema-long-identifier-" + field,
    publicResult,
    "packages/connections/src/schemas/connection-events.v1.schema.json:141-150",
  );
}
const directIdentifierMatrix = {
  opaque: outcome(() => normalizeOpaqueIdForStore(ordinaryLongId)),
  owner: outcome(() =>
    normalizeOwner({ kind: "workspace", id: ordinaryLongId }),
  ),
  principal: outcome(() =>
    normalizePrincipal({
      ...member,
      id: ordinaryLongId,
      workspaceId: ordinaryLongId,
    }),
  ),
  providerOpaque: outcome(() => normalizeOpaqueIdForStore(providerToken)),
  providerOwner: outcome(() =>
    normalizeOwner({ kind: "workspace", id: providerToken }),
  ),
  providerPrincipal: outcome(() =>
    normalizePrincipal({ ...member, id: providerToken }),
  ),
};
expectAccepted(
  "runtime-direct-long-opaque",
  directIdentifierMatrix.opaque,
  "packages/connections/src/schema.mjs:740-762",
);
expectAccepted(
  "runtime-direct-long-owner",
  directIdentifierMatrix.owner,
  "packages/connections/src/schema.mjs:195-223",
);
expectAccepted(
  "runtime-direct-long-principal",
  directIdentifierMatrix.principal,
  "packages/connections/src/schema.mjs:226-289",
);
for (const [name, result] of Object.entries(directIdentifierMatrix)) {
  if (name.startsWith("provider")) {
    expectRejected(
      "runtime-direct-" + name,
      result,
      "packages/connections/src/schema.mjs:673-705,740-762",
    );
  }
}

function lifecycleProbe() {
  const store = makeStore("lifecycle");
  const created = createBase(store, "connection-ninth-lifecycle");
  const beforeRotate = store.captureForRun({
    actor: member,
    connectionId: created.connection.connectionId,
    runId: "run-ninth-same",
  });
  const rotated = store.rotate({
    actor: admin,
    connectionId: created.connection.connectionId,
    expectedRevision: 1,
    secretRef: secretRef(2),
    idempotencyKey: "rotate-ninth-lifecycle",
  });
  const sameRun = store.captureForRun({
    actor: member,
    connectionId: created.connection.connectionId,
    runId: "run-ninth-same",
  });
  const newRun = store.captureForRun({
    actor: member,
    connectionId: created.connection.connectionId,
    runId: "run-ninth-new",
  });
  assert.equal(beforeRotate.revision, 1);
  assert.equal(sameRun.revision, 1);
  assert.equal(newRun.revision, 2);
  assert.equal(sameRun.bindingDigest, beforeRotate.bindingDigest);
  assert.notEqual(newRun.bindingDigest, beforeRotate.bindingDigest);
  store.disable({
    actor: admin,
    connectionId: created.connection.connectionId,
    reason: "maintenance",
    idempotencyKey: "disable-ninth-lifecycle",
  });
  const existingCapture = store.captureForRun({
    actor: member,
    connectionId: created.connection.connectionId,
    runId: "run-ninth-same",
  });
  const afterDisable = outcome(() =>
    store.captureForRun({
      actor: member,
      connectionId: created.connection.connectionId,
      runId: "run-ninth-after-disable",
    }),
  );
  store.delete({
    actor: admin,
    connectionId: created.connection.connectionId,
    reason: "retired",
    idempotencyKey: "delete-ninth-lifecycle",
  });
  const view = store.read({
    actor: member,
    connectionId: created.connection.connectionId,
  });
  const afterDelete = outcome(() =>
    store.captureForRun({
      actor: member,
      connectionId: created.connection.connectionId,
      runId: "run-ninth-after-delete",
    }),
  );
  assert.equal(existingCapture.revision, 1);
  assert.equal(view.status, "deleted");
  assert.equal(view.tombstone.reason, "retired");
  assert.equal(afterDisable.code, CONNECTION_ERROR_CODES.NOT_ACTIVE);
  assert.equal(afterDelete.code, CONNECTION_ERROR_CODES.NOT_ACTIVE);
  const events = store.events();
  const replay = replayConnectionEvents([...events, ...events].reverse());
  const replayAgain = replayConnectionEvents([...events, ...events].reverse());
  assert.equal(replay.stateDigest, store.stateDigest());
  assert.equal(replay.stateDigest, replayAgain.stateDigest);
  assert.equal(replay.eventDigest, replayAgain.eventDigest);
  return {
    createdRevision: created.connection.activeRevision,
    rotatedRevision: rotated.connection.activeRevision,
    captures: {
      beforeRotate: beforeRotate.revision,
      sameRunAfterRotate: sameRun.revision,
      newRun: newRun.revision,
      existingAfterDisable: existingCapture.revision,
    },
    fencing: { afterDisable, afterDelete },
    tombstone: {
      status: view.status,
      reason: view.tombstone.reason,
      hasEventId: Boolean(view.tombstone.eventId),
    },
    replay: {
      eventCount: events.length,
      stateDigestEqual: true,
      eventDigestEqual: true,
    },
  };
}
const lifecycle = lifecycleProbe();

function authzProbe() {
  const store = makeStore("authz");
  const connectionId = "connection-ninth-authz";
  createBase(store, connectionId);
  const foreign = {
    ...admin,
    tenantId: "tenant-other-ninth",
    workspaceId: "workspace-other-ninth",
  };
  const before = store.stateDigest();
  const operations = {
    read: () => store.read({ actor: foreign, connectionId }),
    grant: () =>
      store.captureForRun({
        actor: foreign,
        connectionId,
        runId: "run-ninth-foreign",
      }),
    rotate: () =>
      store.rotate({
        actor: foreign,
        connectionId,
        expectedRevision: 1,
        secretRef: secretRef(2),
        idempotencyKey: "rotate-foreign-ninth",
      }),
    disable: () =>
      store.disable({
        actor: foreign,
        connectionId,
        idempotencyKey: "disable-foreign-ninth",
      }),
    delete: () =>
      store.delete({
        actor: foreign,
        connectionId,
        idempotencyKey: "delete-foreign-ninth",
      }),
  };
  const errors = {};
  for (const [name, action] of Object.entries(operations)) {
    const foreignResult = outcome(action);
    const unknownInput = {
      actor: foreign,
      connectionId: "connection-ninth-unknown",
    };
    if (name === "grant") unknownInput.runId = "run-ninth-unknown";
    if (name === "rotate")
      Object.assign(unknownInput, {
        expectedRevision: 1,
        secretRef: secretRef(2),
        idempotencyKey: "rotate-unknown-ninth",
      });
    if (name === "disable" || name === "delete")
      unknownInput.idempotencyKey = name + "-unknown-ninth";
    const unknownResult = outcome(() => {
      if (name === "read") return store.read(unknownInput);
      if (name === "grant") return store.captureForRun(unknownInput);
      if (name === "rotate") return store.rotate(unknownInput);
      if (name === "disable") return store.disable(unknownInput);
      return store.delete(unknownInput);
    });
    errors[name] = {
      foreign: foreignResult,
      unknown: unknownResult,
      equal: JSON.stringify(foreignResult) === JSON.stringify(unknownResult),
    };
    assert.equal(foreignResult.code, CONNECTION_ERROR_CODES.NOT_FOUND);
    assert.equal(unknownResult.code, CONNECTION_ERROR_CODES.NOT_FOUND);
    assert.equal(errors[name].equal, true);
  }
  assert.equal(store.stateDigest(), before);
  return { errors, stateDigestUnchanged: true };
}
const authz = authzProbe();

async function hiddenFormatSensitivity() {
  const workDirectory = path.join(taskDirectory, "work");
  await mkdir(workDirectory, { recursive: true });
  const scratch = await mkdtemp(
    path.join(workDirectory, "ninth-hidden-format-sensitivity-"),
  );
  try {
    const sourceDirectory = path.join(scratch, "src");
    await mkdir(sourceDirectory, { recursive: true });
    const schemaPath = path.join(sourceDirectory, "schema.mjs");
    await copyFile(
      path.join(root, "packages/connections/src/schema.mjs"),
      schemaPath,
    );
    await copyFile(
      path.join(root, "packages/connections/src/errors.mjs"),
      path.join(sourceDirectory, "errors.mjs"),
    );
    await copyFile(
      path.join(root, "packages/connections/src/canonical.mjs"),
      path.join(sourceDirectory, "canonical.mjs"),
    );
    const source = await readFile(schemaPath, "utf8");
    const marker = 'return value.normalize("NFKC").replace(/\\p{Cf}/gu, "");';
    assert.ok(source.includes(marker));
    await writeFile(schemaPath, source.replace(marker, "return value;"));
    const mutatedDefinition = definition({
      metadata: { safe: insertControl(urlSafe23, controls[0].value) },
    });
    const probe =
      "import { normalizeConnectionDefinition } from " +
      JSON.stringify(pathToFileURL(schemaPath).href) +
      "; normalizeConnectionDefinition(" +
      JSON.stringify(mutatedDefinition) +
      ");";
    let mutatedAccepted = false;
    let mutatedError = null;
    try {
      execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      mutatedAccepted = true;
    } catch (error) {
      mutatedAccepted = false;
      mutatedError = {
        name: error?.name ?? "Error",
        message: String(error?.message ?? "").slice(0, 120),
      };
    }
    assert.equal(mutatedAccepted, true);
    const mutatedSchema = structuredClone(schema);
    const genericPatterns = mutatedSchema.$defs.credentialValueShape.anyOf;
    const hiddenBranch = genericPatterns.findIndex((entry) =>
      String(entry.pattern ?? "").includes("\\p{Cf}"),
    );
    assert.notEqual(hiddenBranch, -1);
    genericPatterns.splice(hiddenBranch, 1);
    const mutatedValidator = new Ajv2020({
      allErrors: true,
      strict: false,
    }).compile(mutatedSchema);
    const publicMutantAccepted = mutatedValidator(
      createdEvent({
        data: {
          metadata: { safe: insertControl(urlSafe23, controls[0].value) },
        },
      }),
    );
    assert.equal(publicMutantAccepted, true);
    return {
      runtime: {
        branchRemoved: "Unicode format-control candidate normalization",
        mutatedFixtureAccepted: mutatedAccepted,
        mutatedError,
        verifierWouldTurnRed: mutatedAccepted,
      },
      publicSchema: {
        branchRemoved: "format-control-aware generic free-form pattern",
        mutatedFixtureAccepted: true,
        verifierWouldTurnRed: true,
      },
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
const sensitivity = await hiddenFormatSensitivity();

async function scanEvidence() {
  const files = [];
  async function visit(directory) {
    const entries = (await import("node:fs/promises")).readdir(directory, {
      withFileTypes: true,
    });
    for (const entry of await entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else files.push(target);
    }
  }
  await visit(evidenceDirectory);
  const patterns = [
    new RegExp(
      ["e5-t02-", "connection-", "ca", "nary", "-", "value"].join(""),
      "iu",
    ),
    new RegExp(
      ["-----BE", "GIN ", "[^-]*", "PRIVATE KEY", "-----"].join(""),
      "iu",
    ),
    /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/iu,
    /\b(?:api[_-]?key|client[_-]?secret|password|token|cookie|authorization)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/iu,
    /(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?|amqp):\/\/\S+/iu,
  ];
  const findings = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const [rule, pattern] of patterns.entries()) {
      if (pattern.test(content))
        findings.push({ file: path.relative(evidenceDirectory, file), rule });
    }
  }
  return { leaked: findings.length > 0, filesChecked: files.length, findings };
}

const result = {
  schemaVersion: 1,
  task: "E5-T02",
  exactHead,
  inputSummary: {
    canonicalUrlSafeLengths: [urlSafe23.length, urlSafeLong.length],
    standardBase64Length: standardBase64.length,
    formatControls: controls.map(({ name }) => name),
    freeFormCaseCount: freeFormCases.length,
    freeFormBoundaries,
    identifierFields,
    identifierShapeCount: identifierShapes.length,
  },
  freeFormMatrix,
  jsonMatrix,
  specialMatrix,
  extraRuntime,
  extraPublic,
  prototypePublic,
  deepPublic,
  identifierMatrix,
  ordinaryEventMatrix,
  directIdentifierMatrix,
  lifecycle,
  authz,
  sensitivity,
  failures,
  findings,
  verdict: findings.length === 0 ? "verified" : "refuted",
  replayEvidence:
    "Replay: N/A (server connection model) + mitigation: detached exact-head replay, runtime/store/public boundary probes, lifecycle/capture, authz parity, leak scan, and sensitivity mutation",
};
await writeFile(
  path.join(evidenceDirectory, "independent-probes.json"),
  JSON.stringify(result, null, 2) + "\n",
);
const leakScan = await scanEvidence();
result.leakScan = leakScan;
await writeFile(
  path.join(evidenceDirectory, "independent-probes.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      exactHead,
      verdict: result.verdict,
      findingCount: findings.length,
      failureCount: failures.length,
      freeFormCaseCount: freeFormCases.length,
      leakScan,
      evidenceDirectory,
    },
    null,
    2,
  ),
);
if (findings.length > 0 || failures.length > 0 || leakScan.leaked)
  process.exitCode = 1;
