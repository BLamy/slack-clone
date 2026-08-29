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

const SCOPE = Object.freeze({
  tenantId: "tenant-critic-eleventh",
  workspaceId: "workspace-critic-eleventh",
});
const ADMIN = Object.freeze({
  ...SCOPE,
  id: "user-critic-eleventh",
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
    id: "secretref-critic-eleventh-" + String(revision).padStart(3, "0"),
    provider: "infisical",
    mount: "production",
    revision,
    label: "broker ref",
  };
}

function createdEvent(metadata = {}, label = "Audit label") {
  return {
    schemaVersion: 1,
    eventId: "event-critic-eleventh-created",
    eventType: "connection.created",
    workspaceId: SCOPE.workspaceId,
    actorId: ADMIN.id,
    idempotencyKey: "idempotency-critic-eleventh-created",
    sequence: 1,
    serverTimestamp: "2026-08-20T15:00:00.000Z",
    connectionId: "connection-critic-eleventh",
    data: {
      connectionId: "connection-critic-eleventh",
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
    eventId: "event-critic-eleventh-disabled",
    eventType: "connection.disabled",
    workspaceId: SCOPE.workspaceId,
    actorId: ADMIN.id,
    idempotencyKey: "idempotency-critic-eleventh-disabled",
    sequence: 2,
    serverTimestamp: "2026-08-20T15:00:01.000Z",
    connectionId: "connection-critic-eleventh",
    data: { reason },
  };
}

function connectionDefinition(metadata = {}, label = "Audit label") {
  return {
    connectionId: "connection-critic-eleventh",
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
    const value = action();
    if (value && typeof value.accepted === "boolean") return value;
    return {
      accepted: true,
      code: null,
      path: null,
      appended: value?.appended,
    };
  } catch (error) {
    return {
      accepted: false,
      code: error?.code ?? "UNKNOWN",
      path: error?.path ?? null,
    };
  }
}

function newStore() {
  let id = 0;
  return createConnectionStore({
    ...SCOPE,
    clock: () => new Date("2026-08-20T15:00:00.000Z"),
    idFactory: (kind) => kind + "-critic-eleventh-" + String(++id),
  });
}

function storeMetadata(metadata, label = "Audit label") {
  const store = newStore();
  const before = store.events().length;
  store.create({
    actor: ADMIN,
    connectionId: "connection-critic-eleventh",
    owner: { kind: "workspace", id: SCOPE.workspaceId },
    provider: "github",
    integration: "issues",
    label,
    metadata,
    secretRef: secretRef(),
    idempotencyKey: "create-critic-eleventh",
  });
  return { appended: store.events().length - before };
}

function storeReason(reason) {
  const store = newStore();
  store.create({
    actor: ADMIN,
    connectionId: "connection-critic-eleventh",
    owner: { kind: "workspace", id: SCOPE.workspaceId },
    provider: "github",
    integration: "issues",
    label: "Audit label",
    metadata: {},
    secretRef: secretRef(),
    idempotencyKey: "create-critic-eleventh",
  });
  const before = store.events().length;
  store.disable({
    actor: ADMIN,
    connectionId: "connection-critic-eleventh",
    reason,
    idempotencyKey: "disable-critic-eleventh",
  });
  return { appended: store.events().length - before };
}

function storeLabel(label) {
  return storeMetadata({}, label);
}

function publicEvent(boundary, value) {
  const event =
    boundary === "metadata"
      ? createdEvent(
          value && typeof value === "object" ? value : { candidate: value },
        )
      : boundary === "label"
        ? createdEvent({}, value)
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
    "store-label": () => storeLabel(value),
    "public-label": () => publicEvent("label", value),
    "runtime-reason": () => normalizeReason(value),
    "runtime-event-reason": () =>
      normalizeConnectionEvent(terminalEvent(value)),
    "store-reason": () => storeReason(value),
    "public-reason": () => publicEvent("reason", value),
  };
}

function recordExpected(name, action, expectedAccepted) {
  const result = capture(action);
  observations.push({
    name,
    accepted: result.accepted,
    expectedAccepted,
    code: result.code,
    path: result.path,
  });
  if (result.accepted !== expectedAccepted) {
    findings.push({
      id: "E5-T02-CRITIC-ELEVENTH-" + name,
      name,
      expectedAccepted,
      actualAccepted: result.accepted,
      code: result.code,
      path: result.path,
    });
  }
  return result;
}

function recordSecretCase(name, value) {
  const boundaryResults = {};
  for (const [boundary, action] of Object.entries(boundaryActions(value))) {
    const result = capture(action);
    boundaryResults[boundary] = {
      accepted: result.accepted,
      code: result.code,
      path: result.path,
      appended: result.appended,
    };
    if (result.accepted) {
      findings.push({
        id: "E5-T02-CRITIC-ELEVENTH-SECRET-" + name + "-" + boundary,
        name,
        boundary,
        code: result.code,
        path: result.path,
        appended: result.appended ?? null,
      });
    }
  }
  return { name, boundaryResults };
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
];
for (const [name, value] of assignments) {
  secretCases.push(recordSecretCase(name, value));
}

for (const [codePoint, control] of formatControls) {
  secretCases.push(
    recordSecretCase(
      "url-scheme-" + codePoint,
      "https" + control + "://user:password@example.invalid/service",
    ),
  );
  secretCases.push(
    recordSecretCase(
      "base64url-embedded-" + codePoint,
      "a".repeat(10) + control + "a".repeat(11) + "-a",
    ),
  );
}

const jsonCases = [
  ["json-lowercase-key", '{"token":"<redacted>"}'],
  ["json-uppercase-key", '{"TOKEN":"<redacted>"}'],
  ["json-escaped-lowercase-key", '{"\\u0074oken":"<redacted>"}'],
  ["json-escaped-uppercase-key", '{"\\u0054OKEN":"<redacted>"}'],
  ["json-client-secret-key", '{"client_secret":"<redacted>"}'],
];
for (const [name, value] of jsonCases) {
  secretCases.push(recordSecretCase(name, value));
}

const additionalCases = [
  ["percent-encoded-assignment", "client%2Dsecret=<redacted>"],
  ["percent-encoded-json-key", '{"%74oken":"<redacted>"}'],
];
for (const [name, value] of additionalCases) {
  secretCases.push(recordSecretCase(name, value));
}

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

async function detectorSensitivity() {
  const scratchDirectory = await mkdtemp(
    path.join(evidenceDirectory, "detector-sensitivity-"),
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
    const assignmentLine = source
      .split("\n")
      .findIndex(
        (line) =>
          line.includes("client[\\s_-]?secret") &&
          line.includes("password|token|secret"),
      );
    assert.notEqual(assignmentLine, -1);
    const lines = source.split("\n");
    lines.splice(assignmentLine, 1);
    await writeFile(mutatedPath, lines.join("\n"));
    const moduleUrl = pathToFileURL(mutatedPath).href;
    const fixture = JSON.stringify(
      connectionDefinition({ candidate: "client-secret=<redacted>" }),
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
        id: "E5-T02-CRITIC-ELEVENTH-SENSITIVITY",
        name: "assignment-detector-branch-removal",
        expectedMutatedAcceptance: true,
        actualMutatedAcceptance: false,
      });
    }
    return {
      branchRemoved: "client-secret assignment value detector",
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
  critic: "eleventh-independent",
  exactHead,
  requiredAttackCounts: {
    assignmentForms: assignments.length,
    unicodeFormatControls: formatControls.length,
    jsonForms: jsonCases.length,
    additionalAttacks: additionalCases.length,
  },
  secretCases,
  resourceBoundaryObservationCount: observations.length,
  resourceBoundaryFindings: findings.filter(
    (finding) =>
      finding.id.includes("metadata-") || finding.id.includes("reason-"),
  ),
  additionalAttackResults: secretCases.filter(({ name }) =>
    additionalCases.some(([additionalName]) => additionalName === name),
  ),
  sensitivity,
  findings,
  verdict: findings.length === 0 ? "verified" : "refuted",
  replay:
    "Replay: N/A (server connection model) + mitigation: cold-clone reducer replay, secret-shaped input corpus, authz matrix, exact lifecycle digests, and independent boundary probes",
};
await writeFile(
  path.join(evidenceDirectory, "independent-probes.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(JSON.stringify(summary, null, 2));
if (findings.length > 0) process.exitCode = 1;
