import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CONNECTION_ERROR_CODES,
  createConnectionStore,
  normalizeConnectionDefinition,
  normalizeConnectionEvent,
  normalizeMetadata,
  normalizeOpaqueIdForStore,
  normalizePrincipal,
  normalizeReason,
} from "@stream-slack/connections";

const root = path.resolve(import.meta.dirname, "../../../../../..");
const evidenceDirectory = import.meta.dirname;
const schemaPath = path.join(
  root,
  "packages/connections/src/schemas/connection-events.v1.schema.json",
);
const sourcePath = path.join(root, "packages/connections/src/schema.mjs");
const exactHead = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const builderProductCommit = execFileSync("git", ["rev-parse", "HEAD^"], {
  cwd: root,
  encoding: "utf8",
}).trim();

const SCOPE = Object.freeze({
  tenantId: "tenant-critic-twelfth",
  workspaceId: "workspace-critic-twelfth",
});
const ADMIN = Object.freeze({
  ...SCOPE,
  id: "user-critic-twelfth-admin",
  kind: "user",
  role: "admin",
});
const findings = [];
const observations = [];

const AjvModule =
  await import("/opt/homebrew/lib/node_modules/verdaccio/node_modules/ajv/dist/2020.js");
const Ajv = AjvModule.default ?? AjvModule;
const ajv = new Ajv({ allErrors: true, strict: false });
const publicSchema = JSON.parse(await readFile(schemaPath, "utf8"));
const validatePublicEvent = ajv.compile(publicSchema);

const formatControls = [
  ["U+200B", "\u200b"],
  ["U+200D", "\u200d"],
  ["U+FEFF", "\ufeff"],
  ["U+202E", "\u202e"],
  ["U+2060", "\u2060"],
  ["U+2066", "\u2066"],
  ["U+180E", "\u180e"],
  ["U+061C", "\u061c"],
];

function secretRef(revision = 1) {
  return {
    schemaVersion: 1,
    id: "secretref-critic-twelfth-" + String(revision).padStart(3, "0"),
    provider: "infisical",
    mount: "production",
    revision,
    label: "broker ref",
  };
}

function createdEvent(metadata = {}, label = "Audit label", eventId) {
  return {
    schemaVersion: 1,
    eventId: eventId ?? "event-critic-twelfth-created",
    eventType: "connection.created",
    workspaceId: SCOPE.workspaceId,
    actorId: ADMIN.id,
    idempotencyKey: "idempotency-critic-twelfth-created",
    sequence: 1,
    serverTimestamp: "2026-08-20T16:00:00.000Z",
    connectionId: "connection-critic-twelfth",
    data: {
      connectionId: "connection-critic-twelfth",
      tenantId: SCOPE.tenantId,
      workspaceId: SCOPE.workspaceId,
      owner: { kind: "workspace", id: SCOPE.workspaceId },
      provider: "github",
      integration: "issues",
      label,
      metadata,
      secretRef: secretRef(),
      revision: 1,
    },
  };
}

function terminalEvent(reason) {
  return {
    schemaVersion: 1,
    eventId: "event-critic-twelfth-disabled",
    eventType: "connection.disabled",
    workspaceId: SCOPE.workspaceId,
    actorId: ADMIN.id,
    idempotencyKey: "idempotency-critic-twelfth-disabled",
    sequence: 2,
    serverTimestamp: "2026-08-20T16:00:01.000Z",
    connectionId: "connection-critic-twelfth",
    data: { reason },
  };
}

function connectionDefinition(metadata = {}, label = "Audit label") {
  return {
    connectionId: "connection-critic-twelfth",
    tenantId: SCOPE.tenantId,
    workspaceId: SCOPE.workspaceId,
    owner: { kind: "workspace", id: SCOPE.workspaceId },
    provider: "github",
    integration: "issues",
    label,
    metadata,
    secretRef: secretRef(),
  };
}

function capture(action) {
  try {
    const result = action();
    if (result && typeof result.accepted === "boolean") return result;
    return {
      accepted: true,
      code: null,
      path: null,
      appended: result?.appended ?? null,
    };
  } catch (error) {
    return {
      accepted: false,
      code: error?.code ?? "UNKNOWN",
      path: error?.path ?? null,
      appended: error?.appended ?? null,
    };
  }
}

function newStore() {
  let id = 0;
  return createConnectionStore({
    ...SCOPE,
    clock: () => new Date("2026-08-20T16:00:00.000Z"),
    idFactory: (kind) => kind + "-critic-twelfth-" + String(++id),
  });
}

function storeMetadata(metadata, label = "Audit label") {
  const store = newStore();
  const before = store.events().length;
  try {
    store.create({
      actor: ADMIN,
      connectionId: "connection-critic-twelfth",
      owner: { kind: "workspace", id: SCOPE.workspaceId },
      provider: "github",
      integration: "issues",
      label,
      metadata,
      secretRef: secretRef(),
      idempotencyKey: "create-critic-twelfth",
    });
  } catch (error) {
    error.appended = store.events().length - before;
    throw error;
  }
  return { appended: store.events().length - before };
}

function storeReason(reason) {
  const store = newStore();
  store.create({
    actor: ADMIN,
    connectionId: "connection-critic-twelfth",
    owner: { kind: "workspace", id: SCOPE.workspaceId },
    provider: "github",
    integration: "issues",
    label: "Audit label",
    metadata: {},
    secretRef: secretRef(),
    idempotencyKey: "create-critic-twelfth",
  });
  const before = store.events().length;
  try {
    store.disable({
      actor: ADMIN,
      connectionId: "connection-critic-twelfth",
      reason,
      idempotencyKey: "disable-critic-twelfth",
    });
  } catch (error) {
    error.appended = store.events().length - before;
    throw error;
  }
  return { appended: store.events().length - before };
}

function publicEvent(boundary, value, eventId = undefined) {
  const event =
    boundary === "metadata"
      ? createdEvent(
          value && typeof value === "object" ? value : { candidate: value },
        )
      : boundary === "label"
        ? createdEvent({}, value)
        : boundary === "eventId"
          ? createdEvent({}, "Audit label", value)
          : terminalEvent(value);
  const valid = validatePublicEvent(event);
  return {
    accepted: Boolean(valid),
    errors: valid
      ? []
      : (validatePublicEvent.errors ?? []).slice(0, 4).map((error) => ({
          instancePath: error.instancePath,
          keyword: error.keyword,
          schemaPath: error.schemaPath,
        })),
  };
}

function boundaryActions(value) {
  const metadata = { candidate: value };
  return {
    "runtime-metadata": () => normalizeMetadata(metadata),
    "runtime-definition-metadata": () =>
      normalizeConnectionDefinition(connectionDefinition(metadata)),
    "runtime-event-metadata": () =>
      normalizeConnectionEvent(createdEvent(metadata)),
    "store-metadata": () => storeMetadata(metadata),
    "public-metadata": () => publicEvent("metadata", value),
    "runtime-definition-label": () =>
      normalizeConnectionDefinition(connectionDefinition({}, value)),
    "runtime-event-label": () =>
      normalizeConnectionEvent(createdEvent({}, value)),
    "store-label": () => storeMetadata({}, value),
    "public-label": () => publicEvent("label", value),
    "runtime-reason": () => normalizeReason(value),
    "runtime-event-reason": () =>
      normalizeConnectionEvent(terminalEvent(value)),
    "store-reason": () => storeReason(value),
    "public-reason": () => publicEvent("reason", value),
  };
}

function positiveBoundaryActions(value) {
  const metadata = { candidate: value };
  return {
    "runtime-metadata": () => normalizeMetadata(metadata),
    "runtime-definition-metadata": () =>
      normalizeConnectionDefinition(connectionDefinition(metadata)),
    "runtime-event-metadata": () =>
      normalizeConnectionEvent(createdEvent(metadata)),
    "store-metadata": () => storeMetadata(metadata),
    "public-metadata": () => publicEvent("metadata", value),
    "runtime-reason": () => normalizeReason(value),
    "runtime-event-reason": () =>
      normalizeConnectionEvent(terminalEvent(value)),
    "store-reason": () => storeReason(value),
    "public-reason": () => publicEvent("reason", value),
  };
}

function recordSecretCase(name, value) {
  const boundaryResults = {};
  for (const [boundary, action] of Object.entries(boundaryActions(value))) {
    const result = capture(action);
    boundaryResults[boundary] = result;
    if (result.accepted || result.appended > 0) {
      findings.push({
        id: "E5-T02-CRITIC-TWELFTH-SECRET-" + name + "-" + boundary,
        name,
        boundary,
        code: result.code,
        path: result.path,
        appended: result.appended,
      });
    }
  }
  return { name, boundaryResults };
}

function recordExpected(name, action, expectedAccepted) {
  const result = capture(action);
  observations.push({
    name,
    accepted: result.accepted,
    expectedAccepted,
    code: result.code,
    path: result.path,
    appended: result.appended,
  });
  if (result.accepted !== expectedAccepted) {
    findings.push({
      id: "E5-T02-CRITIC-TWELFTH-" + name,
      name,
      expectedAccepted,
      actualAccepted: result.accepted,
      code: result.code,
      path: result.path,
      appended: result.appended,
    });
  }
  return result;
}

function recordPositiveCase(name, value) {
  for (const [boundary, action] of Object.entries(
    positiveBoundaryActions(value),
  )) {
    recordExpected(name + "-" + boundary, action, true);
  }
}

const secretCases = [];
const assignments = [
  ["assignment-client-secret", "client-secret=<redacted>"],
  ["assignment-client-underscore-secret", "client_secret=<redacted>"],
  ["assignment-client-space-secret", "client secret=<redacted>"],
  ["assignment-prefixed-hyphen", "prefix-client-secret=<redacted>"],
  ["assignment-prefixed-underscore", "prefix_client_secret=<redacted>"],
  ["assignment-prefixed-space", "prefix client secret=<redacted>"],
  ["assignment-case-variant", "PREFIX_CLIENT_SECRET=<redacted>"],
  ["assignment-percent-separator-lower", "client%2dsecret=<redacted>"],
  ["assignment-percent-letters-mixed", "cl%69ent-%73ecret=<redacted>"],
  ["assignment-percent-key-mixed", "%63lient%5Fsecre%74=<redacted>"],
  [
    "assignment-percent-prefixed-mixed",
    "prefix%2Dcl%69ent%2dsecr%65t=<redacted>",
  ],
  ["assignment-percent-space", "client%20secret=<redacted>"],
  ["assignment-percent-equals", "client%2dsecret%3d<redacted>"],
  [
    "assignment-percent-prefixed-equals",
    "prefix%2Dclient%5Fsecret%3D<redacted>",
  ],
];
for (const [name, value] of assignments) {
  secretCases.push(recordSecretCase(name, value));
}

const neutralUrlSafeBase64 = "a".repeat(20) + "-a";
const neutralStandardBase64 = "A".repeat(20) + "+A";
for (const [codePoint, control] of formatControls) {
  secretCases.push(
    recordSecretCase(
      "url-scheme-" + codePoint,
      "https" + control + "://example.invalid/service",
    ),
  );
  secretCases.push(
    recordSecretCase(
      "url-safe-base64-" + codePoint,
      neutralUrlSafeBase64.slice(0, 10) +
        control +
        neutralUrlSafeBase64.slice(10),
    ),
  );
  secretCases.push(
    recordSecretCase(
      "standard-base64-" + codePoint,
      neutralStandardBase64.slice(0, 10) +
        control +
        neutralStandardBase64.slice(10),
    ),
  );
}

const jsonCases = [
  ["json-lowercase-key", '{"token":"<redacted>"}'],
  ["json-uppercase-key", '{"TOKEN":"<redacted>"}'],
  ["json-camel-case-key", '{"clientSecret":"<redacted>"}'],
  ["json-escaped-lowercase-key", '{"\\u0074oken":"<redacted>"}'],
  ["json-escaped-uppercase-key", '{"\\u0054OKEN":"<redacted>"}'],
  ["json-escaped-mixed-key", '{"\\u0063lient\\u005fsecret":"<redacted>"}'],
  ["json-client-secret-key", '{"client_secret":"<redacted>"}'],
];
for (const [name, value] of jsonCases) {
  secretCases.push(recordSecretCase(name, value));
}

const percentCases = [
  ["percent-json-key-lower", '{"%74oken":"<redacted>"}'],
  ["percent-json-key-uppercase-mixed", '{"%54%4f%4b%45%4e":"<redacted>"}'],
  ["percent-json-client-secret-mixed", '{"%63lient%5F%73ecret":"<redacted>"}'],
  ["percent-json-key-encoded-brace", '{"%2574oken":"<redacted>"}'],
  ["percent-url-scheme", "h%74tps%3A%2F%2Fexample.invalid%2Fservice"],
  ["percent-provider-prefix", "g%68p%5F" + "a".repeat(16)],
  ["percent-double-assignment", "client%252dsecret%253d<redacted>"],
];
for (const [name, value] of percentCases) {
  secretCases.push(recordSecretCase(name, value));
}

recordPositiveCase("ordinary-percent-text", "release%2F2026%20notes");

const validDepth = {
  level1: { level2: { level3: { level4: {} } } },
};
const tooDeep = {
  level1: { level2: { level3: { level4: { level5: "safe" } } } },
};
const validArrayDepth = { levels: [[["safe"]]] };
const tooDeepArray = { levels: [[[["safe"]]]] };
const array32 = {
  values: Array.from({ length: 32 }, (_, index) => "v" + index),
};
const array33 = {
  values: Array.from({ length: 33 }, (_, index) => "v" + index),
};
const width64 = Object.fromEntries(
  Array.from({ length: 64 }, (_, index) => ["key" + index, index]),
);
const width65 = Object.fromEntries(
  Array.from({ length: 65 }, (_, index) => ["key" + index, index]),
);
const astral512 = { value: "🧪".repeat(512) };
const astral513 = { value: "🧪".repeat(513) };

for (const [name, value, expectedAccepted] of [
  ["metadata-depth-boundary", validDepth, true],
  ["metadata-depth-overflow", tooDeep, false],
  ["metadata-array-depth-boundary", validArrayDepth, true],
  ["metadata-array-depth-overflow", tooDeepArray, false],
  ["metadata-array-32", array32, true],
  ["metadata-array-33", array33, false],
  ["metadata-width-64", width64, true],
  ["metadata-width-65", width65, false],
  ["metadata-astral-512-code-points", astral512, true],
  ["metadata-astral-513-code-points", astral513, false],
]) {
  recordExpected(
    name + "-runtime",
    () => normalizeMetadata(value),
    expectedAccepted,
  );
  recordExpected(
    name + "-definition",
    () => normalizeConnectionDefinition(connectionDefinition(value)),
    expectedAccepted,
  );
  recordExpected(
    name + "-event",
    () => normalizeConnectionEvent(createdEvent(value)),
    expectedAccepted,
  );
  recordExpected(name + "-store", () => storeMetadata(value), expectedAccepted);
  recordExpected(
    name + "-public",
    () => publicEvent("metadata", value),
    expectedAccepted,
  );
}

for (const [name, value, expectedAccepted] of [
  ["reason-160-code-points", "🧪".repeat(160), true],
  ["reason-161-code-points", "🧪".repeat(161), false],
]) {
  recordExpected(
    name + "-runtime",
    () => normalizeReason(value),
    expectedAccepted,
  );
  recordExpected(
    name + "-event",
    () => normalizeConnectionEvent(terminalEvent(value)),
    expectedAccepted,
  );
  recordExpected(name + "-store", () => storeReason(value), expectedAccepted);
  recordExpected(
    name + "-public",
    () => publicEvent("reason", value),
    expectedAccepted,
  );
}

function recordIdentifierCompatibility() {
  const cases = [
    ["opaque-neutral-base64url", neutralUrlSafeBase64, true],
    ["opaque-provider-token", "ghp_" + "a".repeat(24), false],
    ["opaque-percent-provider-token", "g%68p%5F" + "a".repeat(16), false],
  ];
  for (const [name, value, expectedAccepted] of cases) {
    recordExpected(
      name + "-opaque-id",
      () => normalizeOpaqueIdForStore(value),
      expectedAccepted,
    );
    recordExpected(
      name + "-principal-capability",
      () =>
        normalizePrincipal({
          ...SCOPE,
          id: "user-critic-twelfth-member",
          kind: "user",
          role: "member",
          capabilities: [value],
        }),
      name === "opaque-neutral-base64url" ? false : expectedAccepted,
    );
  }
  recordExpected(
    "opaque-ordinary-long-id",
    () => normalizeOpaqueIdForStore("connection-ordinary-percent-safe-2026"),
    true,
  );
}
recordIdentifierCompatibility();

async function detectorSensitivity() {
  const scratchDirectory = await mkdtemp(
    path.join(evidenceDirectory, "percent-detector-sensitivity-"),
  );
  try {
    await copyFile(sourcePath, path.join(scratchDirectory, "schema.mjs"));
    await copyFile(
      path.join(root, "packages/connections/src/errors.mjs"),
      path.join(scratchDirectory, "errors.mjs"),
    );
    await copyFile(
      path.join(root, "packages/connections/src/canonical.mjs"),
      path.join(scratchDirectory, "canonical.mjs"),
    );
    const mutatedPath = path.join(scratchDirectory, "schema.mjs");
    const source = await readFile(mutatedPath, "utf8");
    const original =
      "const decodedCandidate = decodeCredentialCandidate(value);";
    assert.equal(source.includes(original), true);
    await writeFile(
      mutatedPath,
      source.replace(original, "const decodedCandidate = value;"),
    );
    const moduleUrl = pathToFileURL(mutatedPath).href;
    const fixture = JSON.stringify(
      connectionDefinition({ candidate: "client%2dsecret%3d<redacted>" }),
    );
    const probe =
      "import { normalizeConnectionDefinition } from " +
      JSON.stringify(moduleUrl) +
      "; normalizeConnectionDefinition(" +
      fixture +
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
      findings.push({
        id: "E5-T02-CRITIC-TWELFTH-SENSITIVITY",
        name: "percent-decoding-branch-removal",
        expectedMutatedAcceptance: true,
        actualMutatedAcceptance: false,
      });
    }
    return {
      branchRemoved:
        "bounded percent-decoding before credential classification",
      mutatedFixtureAccepted: mutatedAccepted,
      verifierWouldTurnRed: mutatedAccepted,
    };
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true });
  }
}

const sensitivity = await detectorSensitivity();
const summary = {
  schemaVersion: 1,
  task: "E5-T02",
  critic: "twelfth-independent",
  exactHead,
  builderProductCommit,
  requiredAttacks: {
    assignmentForms: assignments.length,
    unicodeFormatControls: formatControls.length,
    jsonForms: jsonCases.length,
    percentForms: percentCases.length,
    metadataBoundaries: 10,
    reasonBoundaries: 2,
    ordinaryPercentPositiveControl: true,
    additionalAttack: "double-encoded and percent-encoded URL/provider forms",
  },
  secretCases,
  resourceBoundaryObservations: observations,
  sensitivity,
  findings,
  verdict: findings.length === 0 ? "verified" : "refuted",
  replay:
    "Replay: N/A (server connection model) + mitigation: cold-clone reducer replay, secret-shaped input corpus, authz matrix, exact lifecycle digests, and independent runtime/store/public boundary probes",
};
await writeFile(
  path.join(evidenceDirectory, "independent-probes.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(JSON.stringify(summary, null, 2));
if (findings.length > 0) process.exitCode = 1;
