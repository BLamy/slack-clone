import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CONNECTION_ERROR_CODES,
  createConnectionStore,
  normalizeMetadata,
} from "@stream-slack/connections";

const root = path.resolve(import.meta.dirname, "../../../../../..");
const schemaPath =
  process.env.SCHEMA_PATH ??
  path.join(
    root,
    "packages/connections/src/schemas/connection-events.v1.schema.json",
  );
const ajvRoot = process.env.AJV_ROOT;
assert(ajvRoot, "AJV_ROOT is required");
const { default: Ajv2020 } = await import(
  pathToFileURL(path.join(ajvRoot, "dist/2020.js")).href
);

const schema = JSON.parse(await readFile(schemaPath, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validatePublic = ajv.compile(schema);

const ordinaryPercentText = "release%20candidate%3A%20green";
const json = '{"token":"redacted-token-value"}';
const fullyPercentJson = encodeURIComponent(json);
const doubleFullyPercentJson = encodeURIComponent(fullyPercentJson);
const mixedPercentJson = '%7B"%74o%6Ben"%3A"%72a%77-%74o%6Ben-%76a%6Cue"%7D';
const doubleMixedPercentJson = encodeURIComponent(mixedPercentJson);
const rawPrivateMarker = "-----BEGIN PRIVATE KEY-----";
const percentPrivateMarker = encodeURIComponent(rawPrivateMarker);

const cases = [
  ["ordinary-percent-positive", { note: ordinaryPercentText }, false],
  ["json-raw", { payload: json }, true],
  ["json-fully-percent-one-pass", { payload: fullyPercentJson }, true],
  ["json-fully-percent-two-pass", { payload: doubleFullyPercentJson }, true],
  ["json-mixed-percent-one-pass", { payload: mixedPercentJson }, true],
  ["json-mixed-percent-two-pass", { payload: doubleMixedPercentJson }, true],
  [
    "json-escaped-key",
    { payload: '{"\\u0074oken":"redacted-token-value"}' },
    true,
  ],
  ["password-assignment", { assignment: "password=redacted" }, true],
  ["secret-assignment", { assignment: "secret: redacted" }, true],
  ["client-secret-assignment", { assignment: "client-secret=redacted" }, true],
  [
    "prefixed-client-secret-assignment",
    { assignment: "prefix-client_secret=redacted" },
    true,
  ],
  ["private-key-assignment", { assignment: "private-key=redacted" }, true],
  ["private-key-marker", { material: rawPrivateMarker }, true],
  ["private-key-marker-percent", { material: percentPrivateMarker }, true],
  [
    "client-secret-mixed-percent",
    { assignment: "prefix%2Dcl%69ent%2Dsecr%65t%3Dredacted" },
    true,
  ],
  [
    "client-secret-double-percent",
    {
      assignment: encodeURIComponent(
        encodeURIComponent("client-secret=redacted"),
      ),
    },
    true,
  ],
  [
    "client-secret-double-mixed-percent",
    { assignment: "cl%2569ent-%2573ecre%2574%253Dredacted" },
    true,
  ],
  [
    "url-raw",
    { endpoint: "https://user:password@example.invalid/service" },
    true,
  ],
  [
    "url-percent-one-pass",
    { endpoint: encodeURIComponent("https://example.invalid/service") },
    true,
  ],
  [
    "url-percent-two-pass",
    {
      endpoint: encodeURIComponent(
        encodeURIComponent("https://example.invalid/service"),
      ),
    },
    true,
  ],
  [
    "url-mixed-percent",
    { endpoint: "h%74tps%3A%2F%2Fexample.invalid%2Fservice" },
    true,
  ],
  ["unicode-confusable-key", { tοken: "redacted-token-value" }, true],
  [
    "unicode-confusable-assignment",
    { assignment: "tοken=redacted-token-value" },
    true,
  ],
  ["unicode-confusable-value", { note: "tοken=redacted-token-value" }, true],
  ["zero-width-value", { note: "to\u200bken=redacted-token-value" }, true],
  ["format-control-value", { note: "redacted\u2060value" }, true],
  [
    "nested-cookie",
    { nested: { headers: { cookie: "session=redacted" } } },
    true,
  ],
  ["base64", { encoded: "c3VwZXItc2VjcmV0LXRva2VuLXZhbHVl" }, true],
  ["base64url", { encoded: "a".repeat(22) + "-a" }, true],
];

for (const field of ["password", "secret", "private-key"]) {
  const rawAssignment = `${field}=redacted`;
  const mixedAssignment = mixedPercent(rawAssignment);
  cases.push([
    `${field}-assignment-mixed-percent`,
    { assignment: mixedAssignment },
    true,
  ]);
  cases.push([
    `${field}-assignment-double-mixed-percent`,
    { assignment: encodeURIComponent(mixedAssignment) },
    true,
  ]);
}

for (const [name, control] of [
  ["200b", "\u200b"],
  ["200c", "\u200c"],
  ["200d", "\u200d"],
  ["200e", "\u200e"],
  ["200f", "\u200f"],
  ["feff", "\ufeff"],
  ["2060", "\u2060"],
  ["2066", "\u2066"],
]) {
  cases.push([`format-control-${name}`, { note: `safe${control}value` }, true]);
}

const providerFamilies = [
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
];
for (const [name, prefix] of providerFamilies) {
  const token = prefix + "A".repeat(32);
  cases.push([`${name}-raw`, { encodedValue: token }, true]);
  cases.push([
    `${name}-mixed-percent-prefix`,
    { encodedValue: encodeProviderPrefix(prefix) + "A".repeat(32) },
    true,
  ]);
  cases.push([
    `${name}-double-percent-token`,
    { encodedValue: encodeURIComponent(encodeURIComponent(token)) },
    true,
  ]);
}

const resultCases = [];
const publicFindings = [];
const runtimeFindings = [];
const appendFindings = [];
for (let index = 0; index < cases.length; index += 1) {
  const [name, metadata, shouldReject] = cases[index];
  const event = makeEvent(index, metadata);
  const publicAccepted = validatePublic(event);
  const publicErrors = publicAccepted
    ? []
    : summarizeAjvErrors(validatePublic.errors);

  let runtimeError = null;
  try {
    normalizeMetadata(metadata);
  } catch (error) {
    runtimeError = summarizeError(error);
  }

  const store = makeStore();
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
      connectionId: `connection-critic-${String(index).padStart(3, "0")}`,
      owner: { kind: "workspace", id: "workspace-alpha" },
      provider: "github",
      integration: "issues",
      label: "Independent boundary fixture",
      metadata,
      secretRef: {
        schemaVersion: 1,
        id: "secretref-critic-001",
        provider: "infisical",
        mount: "production",
        revision: 1,
        label: "critic",
      },
      idempotencyKey: `create-critic-${String(index).padStart(3, "0")}`,
    });
  } catch (error) {
    storeError = summarizeError(error);
  }
  const appended = store.events().length;

  const observation = {
    name,
    expected: shouldReject ? "reject" : "accept",
    publicSchemaAccepted: publicAccepted,
    publicSchemaErrors: publicErrors,
    runtimeRejected: Boolean(runtimeError),
    runtimeError,
    storeRejected: Boolean(storeError),
    storeError,
    appendedEvents: appended,
  };
  resultCases.push(observation);

  if (shouldReject) {
    if (publicAccepted) publicFindings.push(observation);
    if (!runtimeError) runtimeFindings.push(observation);
    if (storeError === null || appended !== 0) appendFindings.push(observation);
  } else if (!publicAccepted || runtimeError || storeError || appended !== 1) {
    publicFindings.push(observation);
  }
}

const output = {
  schemaVersion: 1,
  task: "E5-T02",
  exactHead: process.env.EXACT_HEAD ?? "ba08576",
  command: "independent Ajv 2020/runtime/store matrix",
  caseCount: resultCases.length,
  providerFamilies: providerFamilies.map(([name]) => name),
  findings: {
    publicSchemaBoundary: publicFindings,
    runtimeBoundary: runtimeFindings,
    appendBoundary: appendFindings,
  },
  controls: {
    ordinaryPercentTextAccepted: resultCases.find(
      ({ name }) => name === "ordinary-percent-positive",
    ),
    allRequestedProviderFamiliesExercised: providerFamilies.every(([name]) =>
      resultCases.some(({ name: caseName }) => caseName === `${name}-raw`),
    ),
  },
  results: resultCases,
};
const outputPath = process.env.OUTPUT_PATH;
if (outputPath)
  await writeFile(outputPath, JSON.stringify(output, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      exactHead: output.exactHead,
      caseCount: output.caseCount,
      publicFindingCount: publicFindings.length,
      runtimeFindingCount: runtimeFindings.length,
      appendFindingCount: appendFindings.length,
      ordinaryPercentTextAccepted:
        output.controls.ordinaryPercentTextAccepted?.publicSchemaAccepted ===
          true &&
        output.controls.ordinaryPercentTextAccepted?.runtimeRejected ===
          false &&
        output.controls.ordinaryPercentTextAccepted?.storeRejected === false &&
        output.controls.ordinaryPercentTextAccepted?.appendedEvents === 1,
    },
    null,
    2,
  ),
);

function makeEvent(index, metadata) {
  const suffix = String(index).padStart(3, "0");
  const connectionId = `connection-critic-${suffix}`;
  return {
    schemaVersion: 1,
    eventId: `event-critic-${suffix}`,
    eventType: "connection.created",
    workspaceId: "workspace-alpha",
    actorId: "user-admin",
    idempotencyKey: `idempotency-critic-${suffix}`,
    sequence: 1,
    serverTimestamp: "2026-08-20T12:00:00.000Z",
    connectionId,
    data: {
      schemaVersion: 1,
      connectionId,
      tenantId: "tenant-alpha",
      workspaceId: "workspace-alpha",
      owner: { kind: "workspace", id: "workspace-alpha" },
      provider: "github",
      integration: "issues",
      label: "Independent boundary fixture",
      metadata,
      secretRef: {
        schemaVersion: 1,
        id: "secretref-critic-001",
        provider: "infisical",
        mount: "production",
        revision: 1,
        label: "critic",
      },
      revision: 1,
    },
  };
}

function makeStore() {
  return createConnectionStore({
    tenantId: "tenant-alpha",
    workspaceId: "workspace-alpha",
    clock: () => new Date("2026-08-20T12:00:00.000Z"),
    idFactory: (kind) => `${kind}-critic-001`,
  });
}

function encodeProviderPrefix(prefix) {
  return [...prefix]
    .map((character, index) =>
      index % 2 === 0 ? encodeURIComponent(character) : character,
    )
    .join("");
}

function mixedPercent(value) {
  return [...value]
    .map((character, index) =>
      index % 2 === 0 ? character : encodeURIComponent(character),
    )
    .join("");
}

function summarizeError(error) {
  return {
    code: error?.code ?? error?.name ?? "Error",
    path: error?.path ?? null,
  };
}

function summarizeAjvErrors(errors) {
  return (errors ?? []).slice(0, 4).map((error) => ({
    instancePath: error.instancePath ?? error.dataPath ?? "",
    keyword: error.keyword,
    schemaPath: error.schemaPath,
  }));
}
