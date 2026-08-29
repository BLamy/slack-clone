import { readFile, writeFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";
import {
  createConnectionStore,
  normalizeMetadata,
} from "@stream-slack/connections";

const root = process.cwd();
const schema = JSON.parse(
  await readFile(
    `${root}/packages/connections/src/schemas/connection-events.v1.schema.json`,
    "utf8",
  ),
);
const validatePublic = new Ajv2020({ allErrors: true, strict: false }).compile(
  schema,
);

const percent = (value, predicate = () => true) =>
  [...value]
    .map((character, index) => {
      if (!predicate(character, index)) return character;
      return `%${character.codePointAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
const fullyPercent = (value) => percent(value);
const doublePercent = (value) => fullyPercent(fullyPercent(value));
const mixedPercent = (value) =>
  percent(value, (_character, index) => index % 2 === 0);
const encodedPrefix = (prefix) => fullyPercent(prefix);
const tokenTail = "A".repeat(32);

const cases = [
  ["ordinary-percent", { note: "release%20candidate%3A%20green" }, false],
  [
    "ordinary-double-percent",
    { note: "release%2520candidate%253A%2520green" },
    false,
  ],
  ["raw-json", { payload: '{"token":"independent-redacted"}' }, true],
  [
    "fully-percent-json",
    { payload: fullyPercent('{"token":"independent-redacted"}') },
    true,
  ],
  [
    "mixed-percent-json",
    { payload: mixedPercent('{"token":"independent-redacted"}') },
    true,
  ],
  [
    "double-percent-json",
    { payload: doublePercent('{"token":"independent-redacted"}') },
    true,
  ],
  [
    "double-mixed-percent-json",
    { payload: fullyPercent(mixedPercent('{"token":"independent-redacted"}')) },
    true,
  ],
  ["percent-json-key", { payload: '{"%74oken":"independent-redacted"}' }, true],
  [
    "double-percent-json-key",
    { payload: '{"%2574oken":"independent-redacted"}' },
    true,
  ],
  [
    "escaped-json-key",
    { payload: '{"\\u0074oken":"independent-redacted"}' },
    true,
  ],
  [
    "password-assignment",
    { assignment: "password=independent-redacted" },
    true,
  ],
  ["secret-assignment", { assignment: "secret: independent-redacted" }, true],
  [
    "client-secret-assignment",
    { assignment: "client-secret=independent-redacted" },
    true,
  ],
  [
    "client-underscore-assignment",
    { assignment: "client_secret=independent-redacted" },
    true,
  ],
  [
    "client-space-assignment",
    { assignment: "client secret=independent-redacted" },
    true,
  ],
  [
    "mixed-prefixed-client-secret-assignment",
    {
      assignment: `prefix-${mixedPercent("client-secret=independent-redacted")}`,
    },
    true,
  ],
  [
    "double-mixed-client-secret-assignment",
    {
      assignment: fullyPercent(
        mixedPercent("client-secret=independent-redacted"),
      ),
    },
    true,
  ],
  [
    "encoded-equals-client-secret-assignment",
    { assignment: "client-secret%3Dindependent-redacted" },
    true,
  ],
  [
    "double-encoded-equals-client-secret-assignment",
    { assignment: "client-secret%253Dindependent-redacted" },
    true,
  ],
  [
    "unicode-confusable-assignment",
    { assignment: "tοken=independent-redacted" },
    true,
  ],
  ["unicode-confusable-key", { tοken: "independent-redacted" }, true],
  ["raw-url", { endpoint: "https://example.invalid/service" }, true],
  ["raw-ssh-url", { endpoint: "ssh://user@example.invalid" }, true],
  [
    "raw-postgres-url",
    { endpoint: "postgresql://user:pass@example.invalid/db" },
    true,
  ],
  [
    "mixed-percent-url",
    { endpoint: "h%74tps%3A%2F%2Fexample.invalid%2Fservice" },
    true,
  ],
  [
    "double-percent-url",
    { endpoint: doublePercent("https://example.invalid/service") },
    true,
  ],
  ["raw-private-key-pem", { material: "-----BEGIN PRIVATE KEY-----" }, true],
  [
    "percent-private-key-pem",
    { material: fullyPercent("-----BEGIN PRIVATE KEY-----") },
    true,
  ],
  [
    "double-mixed-private-key-pem",
    { material: fullyPercent(mixedPercent("-----BEGIN PRIVATE KEY-----")) },
    true,
  ],
  [
    "raw-rsa-private-key-pem",
    { material: "-----BEGIN RSA PRIVATE KEY-----" },
    true,
  ],
  [
    "percent-rsa-private-key-pem",
    { material: fullyPercent("-----BEGIN RSA PRIVATE KEY-----") },
    true,
  ],
  ["base64", { encoded: "c3VwZXItaW5kZXBlbmRlbnQtc2VjcmV0" }, true],
  ["base64url", { encoded: "a".repeat(22) + "-a" }, true],
  ["base64url-whitespace", { encoded: `  ${"a".repeat(22)}-a  ` }, true],
  ["zero-width-format-control", { note: "safe\u200bvalue" }, true],
  ["word-joiner-format-control", { note: "safe\u2060value" }, true],
  ["rtl-format-control", { note: "safe\u2066value" }, true],
  [
    "nested-cookie",
    { nested: { headers: { cookie: "session=independent" } } },
    true,
  ],
  ["private-key-field", { privateKey: "independent-redacted" }, true],
  [
    "connection-string-field",
    { connectionString: "postgres://independent" },
    true,
  ],
];

for (const [name, prefix] of [
  ["ghp", "ghp_"],
  ["sk", "sk-"],
  ["rk", "rk-"],
  ["pk", "pk-"],
  ["github_pat", "github_pat_"],
  ["xoxb", "xoxb-"],
  ["xoxa", "xoxa-"],
  ["xoxp", "xoxp-"],
  ["xoxr", "xoxr-"],
  ["xoxs", "xoxs-"],
]) {
  const token = prefix + tokenTail;
  cases.push([`${name}-raw`, { encodedValue: token }, true]);
  cases.push([
    `${name}-mixed-percent-prefix`,
    { encodedValue: `${encodedPrefix(prefix)}${tokenTail}` },
    true,
  ]);
  cases.push([
    `${name}-double-percent-prefix`,
    { encodedValue: `${doublePercent(prefix)}${tokenTail}` },
    true,
  ]);
}

const familyCases = [];
for (const control of [
  "\u200b",
  "\u200c",
  "\u200d",
  "\u200e",
  "\u200f",
  "\ufeff",
  "\u2060",
  "\u2066",
]) {
  familyCases.push([
    `format-control-${control.codePointAt(0).toString(16)}`,
    { note: `safe${control}value` },
    true,
  ]);
}
cases.push(...familyCases);

const results = [];
const findings = [];

for (const [index, [name, metadata, shouldReject]] of cases.entries()) {
  const event = makeEvent(metadata, index);
  const publicAccepted = validatePublic(event);
  const publicErrors = publicAccepted
    ? []
    : (validatePublic.errors ?? []).map((error) => ({
        keyword: error.keyword,
        instancePath: error.instancePath,
        schemaPath: error.schemaPath,
      }));

  let runtimeError = null;
  try {
    normalizeMetadata(metadata);
  } catch (error) {
    runtimeError = { code: error?.code ?? null, path: error?.path ?? null };
  }

  const store = createConnectionStore({
    tenantId: "tenant-alpha",
    workspaceId: "workspace-alpha",
    clock: () => new Date("2026-08-20T12:00:00.000Z"),
    idFactory: (() => {
      let sequence = 0;
      return (prefix) => `${prefix}-independent-${++sequence}`;
    })(),
  });
  let storeError = null;
  try {
    store.create({
      actor: {
        id: "user-admin",
        kind: "user",
        role: "admin",
        tenantId: "tenant-alpha",
        workspaceId: "workspace-alpha",
      },
      connectionId: `connection-independent-${String(index).padStart(3, "0")}`,
      owner: { kind: "workspace", id: "workspace-alpha" },
      provider: "github",
      integration: "issues",
      label: "Independent boundary fixture",
      metadata,
      secretRef: {
        schemaVersion: 1,
        id: "secretref-independent-001",
        provider: "infisical",
        mount: "production",
        revision: 1,
        label: "independent",
      },
      idempotencyKey: `create-independent-${String(index).padStart(3, "0")}`,
    });
  } catch (error) {
    storeError = { code: error?.code ?? null, path: error?.path ?? null };
  }
  const appendedEvents = store.events().length;
  const observation = {
    name,
    expected: shouldReject ? "reject" : "accept",
    publicSchemaAccepted: publicAccepted,
    publicErrors,
    runtimeRejected: Boolean(runtimeError),
    runtimeError,
    storeRejected: Boolean(storeError),
    storeError,
    appendedEvents,
  };
  results.push(observation);
  if (shouldReject) {
    if (
      publicAccepted ||
      !runtimeError ||
      !storeError ||
      appendedEvents !== 0
    ) {
      findings.push(observation);
    }
  } else if (
    publicAccepted === false ||
    runtimeError ||
    storeError ||
    appendedEvents !== 1
  ) {
    findings.push(observation);
  }
}

const output = {
  schemaVersion: 1,
  exactHead: process.env.EXACT_HEAD ?? "5d35c66",
  caseCount: results.length,
  tokenFamilies: [
    "ghp",
    "sk",
    "rk",
    "pk",
    "github_pat",
    "xoxb",
    "xoxa",
    "xoxp",
    "xoxr",
    "xoxs",
  ],
  findings,
  results,
};
const outputPath = process.env.OUTPUT_PATH;
if (outputPath)
  await writeFile(outputPath, JSON.stringify(output, null, 2) + "\n");
console.log(
  JSON.stringify(
    { caseCount: output.caseCount, findingCount: findings.length, findings },
    null,
    2,
  ),
);
if (findings.length > 0) process.exitCode = 2;

function makeEvent(metadata, index) {
  return {
    schemaVersion: 1,
    eventId: `event-independent-${index}`,
    eventType: "connection.created",
    workspaceId: "workspace-alpha",
    actorId: "user-admin",
    idempotencyKey: `idempotency-independent-${index}`,
    sequence: 1,
    serverTimestamp: "2026-08-20T12:00:00.000Z",
    connectionId: `connection-independent-${index}`,
    data: {
      schemaVersion: 1,
      connectionId: `connection-independent-${index}`,
      tenantId: "tenant-alpha",
      workspaceId: "workspace-alpha",
      owner: { kind: "workspace", id: "workspace-alpha" },
      provider: "github",
      integration: "issues",
      label: "Independent boundary fixture",
      metadata,
      secretRef: {
        schemaVersion: 1,
        id: "secretref-independent-001",
        provider: "infisical",
        mount: "production",
        revision: 1,
        label: "independent",
      },
      revision: 1,
    },
  };
}
