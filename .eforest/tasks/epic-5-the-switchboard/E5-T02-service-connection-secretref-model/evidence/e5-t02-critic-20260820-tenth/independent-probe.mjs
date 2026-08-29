import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import Ajv2020 from "/opt/homebrew/lib/node_modules/verdaccio/node_modules/ajv/dist/2020.js";
import {
  CONNECTION_ERROR_CODES,
  createConnectionStore,
  normalizeConnectionDefinition,
  normalizeConnectionEvent,
  normalizeMetadata,
  normalizeReason,
} from "../../../../../../packages/connections/src/index.mjs";

const evidenceDirectory = new URL("./", import.meta.url);
const schemaPath = new URL(
  "../../../../../../packages/connections/src/schemas/connection-events.v1.schema.json",
  import.meta.url,
);
const schema = JSON.parse(await readFile(schemaPath, "utf8"));
const ajv = new Ajv2020({ allErrors: false, strict: false });
const validateEvent = ajv.compile(schema);

const IDS = Object.freeze({
  tenantId: "tenant-critic-tenth",
  workspaceId: "workspace-critic-tenth",
  actorId: "admin-critic-tenth",
  connectionId: "connection-critic-tenth",
  eventId: "event-critic-tenth",
  idempotencyKey: "idempotency-critic-tenth",
  secretRefId: "secret-ref-critic-tenth",
});
const ADMIN = Object.freeze({
  tenantId: IDS.tenantId,
  workspaceId: IDS.workspaceId,
  id: IDS.actorId,
  kind: "user",
  role: "admin",
  capabilities: [],
});
const SECRET_REF = Object.freeze({
  schemaVersion: 1,
  id: IDS.secretRefId,
  provider: "infisical",
  mount: "production",
  revision: 1,
});
const FORMAT_CONTROLS = Object.freeze([
  ["U+200B", "\u200b"],
  ["U+200D", "\u200d"],
  ["U+FEFF", "\ufeff"],
  ["U+202E", "\u202e"],
  ["U+2060", "\u2060"],
  ["U+2066", "\u2066"],
  ["U+180E", "\u180e"],
  ["U+061C", "\u061c"],
]);

const cases = [];
const findings = [];

function errorSummary(error) {
  return {
    code: error?.code ?? null,
    path: error?.path ?? null,
    name: error?.name ?? null,
  };
}

function runRuntime(name, action, expectedAccepted = false, extra = {}) {
  let accepted = false;
  let error = null;
  let result = null;
  try {
    result = action();
    accepted = true;
  } catch (caught) {
    error = errorSummary(caught);
  }
  const observation = { name, expectedAccepted, accepted, error, ...extra };
  cases.push({ boundary: "runtime", ...observation });
  if (accepted !== expectedAccepted) {
    findings.push({
      id: "E5-T02-CRITIC-TENTH-RUNTIME-" + name,
      boundary: "runtime",
      observation,
    });
  }
  return { accepted, error, result };
}

function runStore(name, metadata, expectedAccepted = false) {
  const store = createConnectionStore({
    tenantId: IDS.tenantId,
    workspaceId: IDS.workspaceId,
    clock: () => new Date("2026-08-20T00:00:00.000Z"),
  });
  let accepted = false;
  let error = null;
  try {
    store.create({
      actor: ADMIN,
      connectionId: IDS.connectionId,
      owner: { kind: "workspace", id: IDS.workspaceId },
      provider: "github",
      integration: "issues",
      label: "Critic connection",
      metadata,
      secretRef: SECRET_REF,
      idempotencyKey: IDS.idempotencyKey,
    });
    accepted = true;
  } catch (caught) {
    error = errorSummary(caught);
  }
  const appendedEvents = store.events().length;
  const observation = {
    name,
    expectedAccepted,
    accepted,
    appendedEvents,
    error,
  };
  cases.push({ boundary: "store", ...observation });
  if (
    accepted !== expectedAccepted ||
    (!expectedAccepted && appendedEvents !== 0)
  ) {
    findings.push({
      id: "E5-T02-CRITIC-TENTH-STORE-" + name,
      boundary: "store",
      observation,
    });
  }
  return observation;
}

function eventBase(eventType = "connection.created") {
  const data =
    eventType === "connection.created"
      ? {
          schemaVersion: 1,
          connectionId: IDS.connectionId,
          tenantId: IDS.tenantId,
          workspaceId: IDS.workspaceId,
          owner: { kind: "workspace", id: IDS.workspaceId },
          provider: "github",
          integration: "issues",
          label: "Critic connection",
          metadata: {},
          secretRef: SECRET_REF,
          revision: 1,
        }
      : { reason: null };
  return {
    schemaVersion: 1,
    eventId: IDS.eventId,
    eventType,
    workspaceId: IDS.workspaceId,
    actorId: IDS.actorId,
    idempotencyKey: IDS.idempotencyKey,
    sequence: 1,
    serverTimestamp: "2026-08-20T00:00:00.000Z",
    connectionId: IDS.connectionId,
    data,
  };
}

function schemaResult(name, event, expectedAccepted = false, extra = {}) {
  const accepted = validateEvent(event);
  const rawErrors = validateEvent.errors ?? [];
  const errors = rawErrors.slice(0, 4).map((error) => ({
    instancePath: error.instancePath,
    keyword: error.keyword,
    schemaPath: error.schemaPath,
  }));
  const observation = {
    name,
    expectedAccepted,
    accepted,
    errorCount: rawErrors.length,
    errors,
    ...extra,
  };
  cases.push({ boundary: "public-schema", ...observation });
  if (accepted !== expectedAccepted) {
    findings.push({
      id: "E5-T02-CRITIC-TENTH-SCHEMA-" + name,
      boundary: "public-schema",
      observation,
    });
  }
  return observation;
}

function publicMetadataEvent(metadata) {
  const event = eventBase();
  event.data.metadata = metadata;
  return event;
}

function publicReasonEvent(reason) {
  const event = eventBase("connection.disabled");
  event.data.reason = reason;
  return event;
}

function publicLabelEvent(label) {
  const event = eventBase();
  event.data.label = label;
  return event;
}

function runtimeDefinition(metadata, label = "Critic connection") {
  return {
    schemaVersion: 1,
    connectionId: IDS.connectionId,
    tenantId: IDS.tenantId,
    workspaceId: IDS.workspaceId,
    owner: { kind: "workspace", id: IDS.workspaceId },
    provider: "github",
    integration: "issues",
    label,
    metadata,
    secretRef: SECRET_REF,
  };
}

function metadataValue(value) {
  return { candidate: value };
}

function jsonCredentialValue(keyLiteral) {
  return '{"' + keyLiteral + '":"redacted"}';
}

function objectChain(levels, leaf) {
  let value = leaf;
  for (let level = levels; level >= 1; level -= 1) {
    value = { ["level" + level]: value };
  }
  return { root: value };
}

function arrayChain(levels, leaf) {
  let value = leaf;
  for (let level = levels; level >= 1; level -= 1) value = [value];
  return { root: value };
}

function addCredentialCase(tag, value) {
  runRuntime("assignment-" + tag + "-metadata", () =>
    normalizeMetadata(metadataValue(value)),
  );
  runRuntime("assignment-" + tag + "-reason", () => normalizeReason(value));
  runRuntime("assignment-" + tag + "-definition", () =>
    normalizeConnectionDefinition(runtimeDefinition(metadataValue(value))),
  );
  runRuntime("assignment-" + tag + "-created-event", () =>
    normalizeConnectionEvent(publicMetadataEvent(metadataValue(value))),
  );
  runRuntime("assignment-" + tag + "-disabled-event", () =>
    normalizeConnectionEvent(publicReasonEvent(value)),
  );
  runRuntime("assignment-" + tag + "-label", () =>
    normalizeConnectionDefinition(runtimeDefinition({}, value)),
  );
  runStore("assignment-" + tag, metadataValue(value));
  schemaResult(
    "assignment-" + tag + "-metadata",
    publicMetadataEvent(metadataValue(value)),
  );
  schemaResult("assignment-" + tag + "-reason", publicReasonEvent(value));
  schemaResult("assignment-" + tag + "-label", publicLabelEvent(value));
}

for (const [tag, value] of [
  ["hyphen", "client-secret=redacted"],
  ["underscore", "client_secret = redacted"],
  ["space", "client secret\t=\tredacted"],
  ["case-variant", "CLIENT SECRET=redacted"],
  ["embedded-hyphen", "prefix-client-secret=redacted"],
  ["embedded-underscore", "prefix_client_secret=redacted"],
]) {
  addCredentialCase(tag, value);
}

for (const [name, control] of FORMAT_CONTROLS) {
  const url =
    "https" +
    control +
    "://user:" +
    ["pass", "word"].join("") +
    "@example.invalid/service";
  const base64Url = "a".repeat(10) + control + "a".repeat(11) + "-a";
  for (const [tag, value] of [
    ["url", url],
    ["base64url", base64Url],
  ]) {
    const label = "A" + control + "b";
    runRuntime("format-control-" + name + "-" + tag + "-metadata", () =>
      normalizeMetadata(metadataValue(value)),
    );
    runRuntime("format-control-" + name + "-" + tag + "-reason", () =>
      normalizeReason(value),
    );
    runRuntime("format-control-" + name + "-" + tag + "-definition", () =>
      normalizeConnectionDefinition(runtimeDefinition(metadataValue(value))),
    );
    runRuntime("format-control-" + name + "-" + tag + "-event", () =>
      normalizeConnectionEvent(publicMetadataEvent(metadataValue(value))),
    );
    runRuntime("format-control-" + name + "-" + tag + "-label", () =>
      normalizeConnectionDefinition(runtimeDefinition({}, label)),
    );
    runStore("format-control-" + name + "-" + tag, metadataValue(value));
    schemaResult(
      "format-control-" + name + "-" + tag + "-metadata",
      publicMetadataEvent(metadataValue(value)),
    );
    schemaResult(
      "format-control-" + name + "-" + tag + "-reason",
      publicReasonEvent(value),
    );
    schemaResult(
      "format-control-" + name + "-" + tag + "-label",
      publicLabelEvent(label),
    );
  }
}

for (const [tag, keyLiteral] of [
  ["raw-lower", "token"],
  ["raw-case", "ToKeN"],
  ["unicode-escaped-lower", "\\u0074oken"],
  ["unicode-escaped-case", "\\u0054oKeN"],
  ["unicode-escaped-client-secret", "client\\u002dsecret"],
]) {
  const value = jsonCredentialValue(keyLiteral);
  runRuntime("json-key-" + tag + "-metadata", () =>
    normalizeMetadata(metadataValue(value)),
  );
  runRuntime("json-key-" + tag + "-event", () =>
    normalizeConnectionEvent(publicMetadataEvent(metadataValue(value))),
  );
  runStore("json-key-" + tag, metadataValue(value));
  schemaResult("json-key-" + tag, publicMetadataEvent(metadataValue(value)));
}

for (const [tag, metadata, expectedAccepted] of [
  ["object-depth-3-scalar", objectChain(3, "value"), true],
  ["object-depth-3-empty", objectChain(3, {}), true],
  ["object-depth-4-empty", objectChain(4, {}), false],
  ["object-depth-4-scalar", objectChain(4, "value"), false],
  ["object-depth-4-nonempty", objectChain(4, { level5: "value" }), false],
  ["object-depth-5-scalar", objectChain(5, "value"), false],
  ["array-depth-3-scalar", arrayChain(3, "value"), true],
  ["array-depth-3-empty", arrayChain(3, []), true],
  ["array-depth-4-empty", arrayChain(4, []), false],
  ["array-depth-4-nonempty", arrayChain(4, ["value"]), false],
  ["array-depth-5-scalar", arrayChain(5, "value"), false],
]) {
  runRuntime(
    "metadata-boundary-" + tag,
    () => normalizeMetadata(metadata),
    expectedAccepted,
  );
  runStore("metadata-boundary-" + tag, metadata, expectedAccepted);
  schemaResult(
    "metadata-boundary-" + tag,
    publicMetadataEvent(metadata),
    expectedAccepted,
  );
}

const width64 = Object.fromEntries(
  Array.from({ length: 64 }, (_, index) => ["key" + index, "value"]),
);
const width65 = Object.fromEntries(
  Array.from({ length: 65 }, (_, index) => ["key" + index, "value"]),
);
for (const [tag, metadata, expectedAccepted] of [
  ["width-64", width64, true],
  ["width-65", width65, false],
]) {
  runRuntime(
    "metadata-boundary-" + tag,
    () => normalizeMetadata(metadata),
    expectedAccepted,
  );
  runStore("metadata-boundary-" + tag, metadata, expectedAccepted);
  schemaResult(
    "metadata-boundary-" + tag,
    publicMetadataEvent(metadata),
    expectedAccepted,
  );
}

const astralMetadata = { candidate: "🧪".repeat(512) };
runRuntime(
  "metadata-astral-string-512-code-points",
  () => normalizeMetadata(astralMetadata),
  false,
);
runStore("metadata-astral-string-512-code-points", astralMetadata, false);
schemaResult(
  "metadata-astral-string-512-code-points",
  publicMetadataEvent(astralMetadata),
  false,
);

const summary = {
  schemaId: schema.$id,
  generatedAt: "2026-08-20",
  controlsTested: FORMAT_CONTROLS.map(([name]) => name),
  caseCount: cases.length,
  findingCount: findings.length,
  findings,
  cases,
  canaryValuesPersisted: false,
};
await writeFile(
  new URL("./independent-probes.json", evidenceDirectory),
  JSON.stringify(summary, null, 2) + "\n",
);
assert.equal(summary.canaryValuesPersisted, false);
console.log(
  JSON.stringify({
    caseCount: summary.caseCount,
    findingCount: summary.findingCount,
    findings: summary.findings.map(({ id, boundary, observation }) => ({
      id,
      boundary,
      name: observation.name,
      accepted: observation.accepted,
      appendedEvents: observation.appendedEvents ?? null,
    })),
  }),
);
process.exitCode = findings.length === 0 ? 0 : 1;
