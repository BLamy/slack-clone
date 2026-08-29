import { writeFile } from "node:fs/promises";

import Ajv2020 from "/opt/homebrew/lib/node_modules/verdaccio/node_modules/ajv/dist/2020.js";
import schema from "../../../../../../packages/connections/src/schemas/connection-events.v1.schema.json" with { type: "json" };
import {
  createConnectionStore,
  normalizeMetadata,
  normalizeReason,
} from "@stream-slack/connections";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);
const ref = {
  schemaVersion: 1,
  id: "secretref-github-001",
  provider: "infisical",
  mount: "production",
  revision: 1,
  label: "github",
};
const baseEvent = {
  schemaVersion: 1,
  eventId: "event-created-001",
  eventType: "connection.created",
  workspaceId: "workspace-alpha",
  actorId: "user-admin",
  idempotencyKey: "create-github",
  sequence: 1,
  serverTimestamp: "2026-08-20T12:00:00.000Z",
  connectionId: "connection-github",
  data: {
    schemaVersion: 1,
    connectionId: "connection-github",
    tenantId: "tenant-alpha",
    workspaceId: "workspace-alpha",
    owner: { kind: "workspace", id: "workspace-alpha" },
    provider: "github",
    integration: "issues",
    label: "GitHub",
    metadata: {},
    secretRef: ref,
    revision: 1,
  },
};

const hex = (character) =>
  "%" + character.codePointAt(0).toString(16).toUpperCase().padStart(2, "0");
const percentEncode = (value, predicate = () => true) =>
  [...value]
    .map((character, index) =>
      predicate(character, index) ? hex(character) : character,
    )
    .join("");
const fullyPercentEncode = (value) => percentEncode(value);
const doublePercentEncode = (value) =>
  fullyPercentEncode(fullyPercentEncode(value));
const mixedPercentEncode = (value) =>
  percentEncode(value, (_character, index) => index % 2 === 0);
const assignment = (name, separator = "=") =>
  name + separator + "raw-secret-value";

const cases = [
  ["ordinary-percent", { value: "hello%20world" }, true],
  ["ordinary-double-percent", { value: "hello%2520world" }, true],
  ["raw-json", { payload: '{"token":"raw-token-value"}' }, false],
  ["escaped-json", { payload: '{"\\u0074oken":"raw-token-value"}' }, false],
  [
    "fully-percent-json",
    { payload: fullyPercentEncode('{"token":"raw-token-value"}') },
    false,
  ],
  [
    "mixed-percent-json",
    { payload: mixedPercentEncode('{"token":"raw-token-value"}') },
    false,
  ],
  [
    "double-percent-json",
    { payload: doublePercentEncode('{"token":"raw-token-value"}') },
    false,
  ],
  [
    "double-mixed-percent-json",
    {
      payload: fullyPercentEncode(
        mixedPercentEncode('{"token":"raw-token-value"}'),
      ),
    },
    false,
  ],
  ["percent-json-key", { payload: '{"%74oken":"raw-token-value"}' }, false],
  [
    "double-percent-json-key",
    { payload: '{"%2574oken":"raw-token-value"}' },
    false,
  ],
  ["raw-client-secret", { assignment: assignment("client-secret") }, false],
  ["raw-password", { assignment: assignment("password") }, false],
  ["raw-secret", { assignment: assignment("secret") }, false],
  ["raw-private-key", { assignment: assignment("private-key") }, false],
  [
    "raw-prefixed-client-secret",
    { assignment: "prefix-" + assignment("client-secret") },
    false,
  ],
  [
    "mixed-client-secret",
    { assignment: mixedPercentEncode(assignment("client-secret")) },
    false,
  ],
  [
    "double-client-secret",
    { assignment: doublePercentEncode(assignment("client-secret")) },
    false,
  ],
  [
    "double-mixed-client-secret",
    {
      assignment: fullyPercentEncode(
        mixedPercentEncode(assignment("client-secret")),
      ),
    },
    false,
  ],
  [
    "double-mixed-prefixed-client-secret",
    {
      assignment: fullyPercentEncode(
        "prefix-" + mixedPercentEncode(assignment("client-secret")),
      ),
    },
    false,
  ],
  [
    "encoded-equals-client-secret",
    { assignment: "client-secret%3Draw-secret-value" },
    false,
  ],
  [
    "double-encoded-equals-client-secret",
    { assignment: "client-secret%253Draw-secret-value" },
    false,
  ],
  ["mixed-password", { assignment: "p%61ss%77ord%3Draw-secret-value" }, false],
  [
    "double-mixed-password",
    { assignment: "p%2561ss%2577ord%253Draw-secret-value" },
    false,
  ],
  ["mixed-secret", { assignment: "s%65cr%65t%3Draw-secret-value" }, false],
  [
    "double-mixed-private-key",
    { assignment: "pr%2569v%2561te%2Dkey%253Draw-secret-value" },
    false,
  ],
  ["raw-url", { endpoint: "https://example.invalid/service" }, false],
  [
    "mixed-url",
    { endpoint: "h%74tps%3A%2F%2Fexample.invalid%2Fservice" },
    false,
  ],
  [
    "double-url",
    { endpoint: "%2568%2574tps%253A%252F%252Fexample.invalid%252Fservice" },
    false,
  ],
  [
    "double-mixed-url",
    {
      endpoint: fullyPercentEncode("h%74tps%3A%2F%2Fexample.invalid%2Fservice"),
    },
    false,
  ],
  ["raw-ssh-url", { endpoint: "ssh://user@example.invalid" }, false],
  [
    "raw-postgres-url",
    { endpoint: "postgresql://user:pass@example.invalid/db" },
    false,
  ],
  ["raw-ghp", { encodedValue: "ghp_" + "A".repeat(32) }, false],
  ["mixed-ghp", { encodedValue: "g%68p%5F" + "A".repeat(32) }, false],
  ["double-ghp", { encodedValue: "%2567%2568p%255F" + "A".repeat(32) }, false],
  [
    "double-mixed-ghp",
    { encodedValue: fullyPercentEncode("g%68p%5F" + "A".repeat(32)) },
    false,
  ],
  ["raw-xoxb", { encodedValue: "xoxb-" + "A".repeat(16) }, false],
  ["raw-xoxa", { encodedValue: "xoxa-" + "A".repeat(16) }, false],
  ["raw-xoxp", { encodedValue: "xoxp-" + "A".repeat(16) }, false],
  ["raw-xoxr", { encodedValue: "xoxr-" + "A".repeat(16) }, false],
  ["raw-xoxs", { encodedValue: "xoxs-" + "A".repeat(16) }, false],
  ["raw-pem", { material: "-----BEGIN PRIVATE KEY-----" }, false],
  [
    "mixed-pem",
    { material: "%2D%2D%2D%2D%2DBEGIN%20PRIVATE%20KEY%2D%2D%2D%2D%2D" },
    false,
  ],
  [
    "double-pem",
    { material: doublePercentEncode("-----BEGIN PRIVATE KEY-----") },
    false,
  ],
  [
    "double-mixed-pem",
    {
      material: fullyPercentEncode(
        mixedPercentEncode("-----BEGIN PRIVATE KEY-----"),
      ),
    },
    false,
  ],
  ["base64", { encoded: "c3VwZXItc2VjcmV0LXRva2VuLXZhbHVl" }, false],
  ["base64url", { encoded: "a".repeat(21) + "-a" }, false],
  ["base64url-whitespace", { encoded: "  " + "a".repeat(21) + "-a  " }, false],
  ["base64url-binary", { encoded: "________________________________" }, false],
  ["raw-token-value", { value: "token: raw-token-value" }, false],
  ["case-token-value", { value: "ToKeN = raw-token-value" }, false],
  ["whitespace-token-value", { value: "  token = raw-token-value  " }, false],
  ["zero-width-value", { value: "to\u200bken=raw-token-value" }, false],
  ["confusable-value", { value: "tοken=raw-token-value" }, false],
  ["token-key", { token: "raw-token-value" }, false],
  ["case-token-key", { ToKeN: "raw-token-value" }, false],
  ["whitespace-token-key", { " token ": "raw-token-value" }, false],
  ["zero-width-token-key", { "to\u200bken": "raw-token-value" }, false],
  ["confusable-token-key", { tοken: "raw-token-value" }, false],
];

function runtimeDecision(metadata) {
  try {
    normalizeMetadata(metadata, "$.connection.metadata");
    const store = createConnectionStore({
      tenantId: "tenant-alpha",
      workspaceId: "workspace-alpha",
      clock: () => new Date("2026-08-20T12:00:00.000Z"),
    });
    store.create({
      actor: {
        tenantId: "tenant-alpha",
        workspaceId: "workspace-alpha",
        id: "user-admin",
        kind: "user",
        role: "admin",
      },
      connectionId: "connection-github",
      owner: { kind: "workspace", id: "workspace-alpha" },
      provider: "github",
      integration: "issues",
      label: "GitHub",
      metadata,
      secretRef: ref,
      idempotencyKey: "create-github",
    });
    return { accepted: true };
  } catch (error) {
    return { accepted: false, code: error?.code, path: error?.path };
  }
}

function schemaDecision(metadata) {
  const event = structuredClone(baseEvent);
  event.data.metadata = metadata;
  const accepted = validate(event);
  return {
    accepted,
    errors: accepted ? [] : validate.errors?.slice(0, 2),
  };
}

const results = cases.map(([name, metadata, expectedAccepted]) => {
  const runtime = runtimeDecision(metadata);
  const publicSchema = schemaDecision(metadata);
  return {
    name,
    metadata,
    expectedAccepted,
    runtime,
    publicSchema,
    parity: runtime.accepted === publicSchema.accepted,
  };
});

const bounds = {};
for (const [name, metadata] of [
  ["depth-five", { l1: { l2: { l3: { l4: { l5: "value" } } } } }],
  ["array-33", { values: Array.from({ length: 33 }, (_, index) => index) }],
  [
    "properties-65",
    Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => ["key" + index, index]),
    ),
  ],
  ["astral-512", { label: "🧪".repeat(512) }],
  ["astral-513", { label: "🧪".repeat(513) }],
]) {
  bounds[name] = {
    runtime: runtimeDecision(metadata),
    publicSchema: schemaDecision(metadata),
  };
}

const reasonResults = {};
for (const [name, reason] of [
  ["reason-160-astral", "🧪".repeat(160)],
  ["reason-161-astral", "🧪".repeat(161)],
  ["reason-token", "token = raw-secret"],
  ["reason-percent-url", "h%74tps%3A%2F%2Fexample.invalid"],
]) {
  let runtime;
  try {
    normalizeReason(reason);
    runtime = { accepted: true };
  } catch (error) {
    runtime = { accepted: false, code: error?.code, path: error?.path };
  }
  const event = structuredClone(baseEvent);
  event.eventType = "connection.deleted";
  event.data = { reason };
  const publicAccepted = validate(event);
  reasonResults[name] = {
    runtime,
    publicSchema: {
      accepted: publicAccepted,
      errors: publicAccepted ? [] : validate.errors?.slice(0, 2),
    },
  };
}

const output = {
  schemaVersion: 1,
  generated: "independent-critic-f273604",
  total: results.length,
  runtimeRejected: results.filter(({ runtime }) => !runtime.accepted).length,
  schemaRejected: results.filter(({ publicSchema }) => !publicSchema.accepted)
    .length,
  parityMismatches: results.filter(({ parity }) => !parity),
  unexpectedRuntimeResults: results.filter(
    ({ runtime, expectedAccepted }) => runtime.accepted !== expectedAccepted,
  ),
  bounds,
  reasonResults,
};
const serialized = JSON.stringify(output, null, 2) + "\n";
if (process.env.PROBE_OUTPUT)
  await writeFile(process.env.PROBE_OUTPUT, serialized);
console.log(serialized);
