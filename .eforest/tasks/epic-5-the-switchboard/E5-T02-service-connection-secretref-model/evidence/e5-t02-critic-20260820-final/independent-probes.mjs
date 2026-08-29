import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
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
  tenantId: "tenant-critic-final",
  workspaceId: "workspace-critic-final",
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

const providerPrefix = ["g", "h", "p", "_"].join("");
const providerValue = providerPrefix + "a".repeat(32);
const standardBase64 = Buffer.from(
  "neutral standard fixture " + "z".repeat(16),
).toString("base64");
const urlSafeBase64 = "a".repeat(22) + "-a";
const urlSafeUnderscore = "a".repeat(22) + "_a";
const urlSafePadded = urlSafeBase64 + "=";
const urlSafeShort = Buffer.from([
  105,
  ...Array.from({ length: 16 }, () => 255),
]).toString("base64url");
const urlSafeMalformedPadding = urlSafeBase64 + "===";
const mixedAlphabetBase64 = "a".repeat(22) + "-_";
const escapedJsonCredential =
  '{"\\u0074oken":' + JSON.stringify(providerValue) + "}";
const prototypePollutionMetadata = JSON.parse(
  '{"__proto__":{"' + "TOKEN" + '":' + JSON.stringify(providerValue) + "}}",
);

if (urlSafeBase64.length !== 24) {
  throw new Error("the neutral URL-safe fixture is not 24 characters");
}
if (
  Buffer.from(urlSafeBase64, "base64url").toString("base64url") !==
  urlSafeBase64
) {
  throw new Error(
    "the neutral URL-safe fixture is not RFC 4648 round-trip valid",
  );
}
if (
  urlSafeShort.length !== 23 ||
  Buffer.from(urlSafeShort, "base64url").toString("base64url") !== urlSafeShort
) {
  throw new Error(
    "the short URL-safe fixture is not RFC 4648 round-trip valid",
  );
}

const failures = [];
const result = {
  schemaVersion: 1,
  task: "E5-T02",
  exactHead,
  inputs: {
    neutralUrlSafeLength: urlSafeBase64.length,
    neutralUrlSafeUsesUrlSafeAlphabet: true,
    neutralUrlSafeConstructedAs: "22 repeated lowercase a characters plus -a",
    standardBase64Length: standardBase64.length,
    variantLengths: {
      paddedUrlSafe: urlSafePadded.length,
      shortUrlSafe: urlSafeShort.length,
      malformedPadding: urlSafeMalformedPadding.length,
      mixedAlphabet: mixedAlphabetBase64.length,
    },
  },
  runtime: runtimeFixture(),
  store: storeFixture(),
  compatibility: compatibilityFixture(),
  lifecycle: lifecycleFixture(),
  authz: authorizationFixture(),
  publicSchema: await publicSchemaFixture(),
  newAttack: newAttackFixture(),
};

result.findings = [
  ...result.runtime.findings,
  ...result.store.findings,
  ...result.compatibility.findings,
  ...result.publicSchema.findings,
  ...result.newAttack.findings,
];

await writeFile(
  path.join(evidenceDirectory, "independent-probes.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));

if (failures.length > 0) {
  console.error(JSON.stringify({ criticFailures: failures }, null, 2));
  process.exitCode = 1;
}

function runtimeFixture() {
  const rejected = {};
  const variants = {};
  const eventIdFields = [
    "eventId",
    "workspaceId",
    "actorId",
    "idempotencyKey",
    "connectionId",
  ];

  for (const field of eventIdFields) {
    const outcome = attempt(() =>
      normalizeConnectionEvent(createdEvent({ [field]: urlSafeBase64 })),
    );
    requireCredentialRejection("event-id-" + field, outcome);
    rejected["event-id-" + field] = outcome;
  }

  const cases = {
    principalCapability: () =>
      normalizePrincipal({ ...admin, capabilities: [urlSafeBase64] }),
    opaqueId: () => normalizeOpaqueIdForStore(urlSafeBase64, "$.runId"),
    metadata: () => normalizeMetadata({ safe: urlSafeBase64 }),
    reason: () => normalizeReason(urlSafeBase64),
    eventTerminalReason: () =>
      normalizeConnectionEvent(terminalEvent({ reason: urlSafeBase64 })),
    connectionDefinitionMetadata: () =>
      normalizeConnectionDefinition(
        definition({
          connectionId: "connection-def",
          metadata: { safe: urlSafeBase64 },
        }),
      ),
    providerValue: () => normalizeMetadata({ safe: providerValue }),
    standardBase64: () => normalizeMetadata({ safe: standardBase64 }),
    paddedUrlSafe: () => normalizeMetadata({ safe: urlSafePadded }),
    underscoreUrlSafe: () => normalizeMetadata({ safe: urlSafeUnderscore }),
    mixedAlphabetBase64: () => normalizeMetadata({ safe: mixedAlphabetBase64 }),
  };

  for (const [name, action] of Object.entries(cases)) {
    const outcome = attempt(action);
    requireCredentialRejection(name, outcome);
    rejected[name] = outcome;
  }

  const lengthVariants = {
    shortUrlSafe: attempt(() => normalizeMetadata({ safe: urlSafeShort })),
    shortUrlSafeOpaqueId: attempt(() =>
      normalizeOpaqueIdForStore(urlSafeShort, "$.runId"),
    ),
    shortUrlSafeReason: attempt(() => normalizeReason(urlSafeShort)),
    shortUrlSafeCapability: attempt(() =>
      normalizePrincipal({ ...admin, capabilities: [urlSafeShort] }),
    ),
    malformedPadding: attempt(() =>
      normalizeMetadata({ safe: urlSafeMalformedPadding }),
    ),
  };
  variants.length = lengthVariants;

  const detector = {
    neutralUrlSafe: isCredentialMaterial(urlSafeBase64),
    standardBase64: isCredentialMaterial(standardBase64),
    providerValue: isCredentialMaterial(providerValue),
    shortUrlSafe: isCredentialMaterial(urlSafeShort),
    malformedPadding: isCredentialMaterial(urlSafeMalformedPadding),
  };
  require(detector.neutralUrlSafe === true &&
    detector.standardBase64 === true &&
    detector.providerValue ===
      true, "runtime detector did not classify required encoded/provider values");

  const findings = [];
  for (const [name, outcome] of Object.entries(lengthVariants)) {
    if (name !== "malformedPadding" && outcome.accepted) {
      failures.push("valid short URL-safe base64 accepted: " + name);
      findings.push({
        id: "E5-T02-CRITIC-FINAL-SHORT-" + name.toUpperCase(),
        severity: "high",
        summary:
          "A canonical short URL-safe base64 value crossed a runtime boundary",
        observation: { accepted: true, rawReturned: outcome.rawReturned },
      });
    }
  }
  return { rejected, variants, detector, findings };
}

function storeFixture() {
  const store = makeStore();
  const before = store.events().length;
  const createMetadata = attempt(() =>
    store.create({
      actor: admin,
      ...definition({
        connectionId: "connection-final-metadata",
        metadata: { safe: urlSafeBase64 },
      }),
      idempotencyKey: "create-final-metadata",
    }),
  );
  const createCapability = attempt(() =>
    store.create({
      actor: { ...admin, capabilities: [urlSafeBase64] },
      ...definition({ connectionId: "connection-final-capability" }),
      idempotencyKey: "create-final-capability",
    }),
  );
  const createConnectionId = attempt(() =>
    store.create({
      actor: admin,
      ...definition({ connectionId: urlSafeBase64 }),
      idempotencyKey: "create-final-connection-id",
    }),
  );
  const createShortMetadata = attempt(() =>
    store.create({
      actor: admin,
      ...definition({
        connectionId: "connection-short-metadata",
        metadata: { safe: urlSafeShort },
      }),
      idempotencyKey: "create-short-metadata",
    }),
  );
  const countAfterCreateAttacks = store.events().length;
  require(countAfterCreateAttacks ===
    before, "store create accepted URL-safe material or moved the event head");

  const valid = store.create({
    actor: admin,
    ...definition({ connectionId: "connection-final-store" }),
    idempotencyKey: "create-final-store",
  });
  const beforeActorAttacks = store.events().length;
  const authorization = attempt(() =>
    store.authorization({
      actor: { ...member, capabilities: [urlSafeBase64] },
      connectionId: valid.connection.connectionId,
      action: "grant",
    }),
  );
  const captureActor = attempt(() =>
    store.captureForRun({
      actor: { ...member, capabilities: [urlSafeBase64] },
      connectionId: valid.connection.connectionId,
      runId: "run-final-actor-capability",
    }),
  );
  const captureRunId = attempt(() =>
    store.captureForRun({
      actor: member,
      connectionId: valid.connection.connectionId,
      runId: urlSafeBase64,
    }),
  );
  const captureShortRunId = attempt(() =>
    store.captureForRun({
      actor: member,
      connectionId: valid.connection.connectionId,
      runId: urlSafeShort,
    }),
  );
  require(store.events().length ===
    beforeActorAttacks, "store authorization/capture attacks moved the event head");

  const terminalStore = makeStore();
  terminalStore.create({
    actor: admin,
    ...definition({ connectionId: "connection-terminal" }),
    idempotencyKey: "create-final-terminal",
  });
  const beforeTerminal = terminalStore.events().length;
  const disable = attempt(() =>
    terminalStore.disable({
      actor: admin,
      connectionId: "connection-terminal",
      reason: urlSafeBase64,
      idempotencyKey: "disable-final-url-safe",
    }),
  );
  const remove = attempt(() =>
    terminalStore.delete({
      actor: admin,
      connectionId: "connection-terminal",
      reason: urlSafeBase64,
      idempotencyKey: "delete-final-url-safe",
    }),
  );
  const disableShort = attempt(() =>
    terminalStore.disable({
      actor: admin,
      connectionId: "connection-terminal",
      reason: urlSafeShort,
      idempotencyKey: "disable-final-short",
    }),
  );
  require(terminalStore.events().length ===
    beforeTerminal, "terminal URL-safe reason moved the event head");

  const findings = [];
  for (const [name, outcome] of Object.entries({
    createMetadata,
    createCapability,
    createConnectionId,
    createShortMetadata,
    authorization,
    captureActor,
    captureRunId,
    captureShortRunId,
    disable,
    remove,
    disableShort,
  })) {
    if (outcome.accepted) {
      findings.push({
        id: "E5-T02-CRITIC-FINAL-" + name.toUpperCase(),
        severity: "high",
        summary: "URL-safe encoded material crossed the store boundary",
        observation: {
          accepted: true,
          rawReturned: outcome.rawReturned,
          eventCount: name.startsWith("create")
            ? countAfterCreateAttacks
            : terminalStore.events().length,
        },
      });
    }
  }

  return {
    create: {
      createMetadata,
      createCapability,
      createConnectionId,
      createShortMetadata,
    },
    authorization,
    capture: {
      actor: captureActor,
      runId: captureRunId,
      shortRunId: captureShortRunId,
    },
    terminal: { disable, delete: remove, shortReason: disableShort },
    eventCounts: {
      before,
      afterCreateAttacks: countAfterCreateAttacks,
      beforeActorAttacks,
      afterActorAttacks: store.events().length,
      beforeTerminal,
      afterTerminal: terminalStore.events().length,
    },
    findings,
  };
}

function compatibilityFixture() {
  const normalIds = [
    "connection-github",
    "secretref-github-001",
    "workspace-alpha",
    "connection-event-00000001",
    "connection-normal-identifier-000001",
    "run-20260820-normal-identifier",
  ];
  const opaque = Object.fromEntries(
    normalIds.map((id) => [id, attempt(() => normalizeOpaqueIdForStore(id))]),
  );
  const principal = attempt(() =>
    normalizePrincipal({
      ...admin,
      capabilities: ["connection.manage", "connection.read"],
    }),
  );
  const normalWorkspaceId = "workspace-normal-identifier-000001";
  const normalActorId = "user-normal-identifier-000001";
  const identifierEvents = {
    workspaceId: attempt(() =>
      normalizeConnectionEvent(
        createdEvent({
          workspaceId: normalWorkspaceId,
          data: {
            workspaceId: normalWorkspaceId,
            owner: { kind: "workspace", id: normalWorkspaceId },
          },
        }),
      ),
    ),
    actorId: attempt(() =>
      normalizeConnectionEvent(createdEvent({ actorId: normalActorId })),
    ),
  };
  const store = makeStore();
  const lifecycle = attempt(() =>
    store.create({
      actor: admin,
      ...definition({ connectionId: "connection-normal-identifier-000001" }),
      idempotencyKey: "create-normal-identifier-000001",
    }),
  );
  const findings = [];
  for (const [id, outcome] of Object.entries(opaque)) {
    if (!outcome.accepted) {
      failures.push("normal opaque identifier rejected: " + id);
      findings.push({
        id: "E5-T02-CRITIC-FINAL-COMPATIBILITY",
        severity: "medium",
        summary:
          "A valid opaque identifier was rejected as credential material",
        identifier: id,
        code: outcome.code,
        path: outcome.path,
      });
    }
  }
  if (!principal.accepted || !lifecycle.accepted) {
    failures.push("normal principal or lifecycle compatibility failed");
    findings.push({
      id: "E5-T02-CRITIC-FINAL-COMPATIBILITY-PRINCIPAL",
      severity: "medium",
      summary: "Normal principal or lifecycle compatibility failed",
      principal,
      lifecycle,
    });
  }
  for (const [field, outcome] of Object.entries(identifierEvents)) {
    if (!outcome.accepted) {
      failures.push("normal event identifier rejected: " + field);
      findings.push({
        id: "E5-T02-CRITIC-FINAL-COMPATIBILITY-EVENT-" + field.toUpperCase(),
        severity: "medium",
        summary:
          "A valid normal event identifier was rejected as credential material",
        field,
        code: outcome.code,
        path: outcome.path,
      });
    }
  }
  return { opaque, principal, lifecycle, identifierEvents, findings };
}

function lifecycleFixture() {
  const store = makeStore();
  const connectionId = "connection-lifecycle";
  store.create({
    actor: admin,
    ...definition({ connectionId }),
    idempotencyKey: "create-final-lifecycle",
  });
  const beforeRotate = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-final-stable",
  });
  store.rotate({
    actor: admin,
    connectionId,
    expectedRevision: 1,
    secretRef: secretRef(2),
    idempotencyKey: "rotate-final-lifecycle",
  });
  const sameRun = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-final-stable",
  });
  const newRun = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-final-new",
  });
  require(beforeRotate.revision === 1 &&
    sameRun.revision === 1 &&
    newRun.revision ===
      2, "rotation did not preserve the captured revision boundary");
  store.disable({
    actor: admin,
    connectionId,
    reason: "final-maintenance",
    idempotencyKey: "disable-final-lifecycle",
  });
  const existingAfterDisable = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-final-stable",
  });
  const disabledNewRun = attempt(() =>
    store.captureForRun({
      actor: member,
      connectionId,
      runId: "run-final-disabled",
    }),
  );
  store.delete({
    actor: admin,
    connectionId,
    reason: "final-retired",
    idempotencyKey: "delete-final-lifecycle",
  });
  const existingAfterDelete = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-final-stable",
  });
  const deletedNewRun = attempt(() =>
    store.captureForRun({
      actor: member,
      connectionId,
      runId: "run-final-deleted",
    }),
  );
  const events = store.events();
  const replayInput = [...events, ...events].reverse();
  const replay = replayConnectionEvents(replayInput);
  const replayAgain = replayConnectionEvents(replayInput);
  require(existingAfterDisable.revision === 1 &&
    existingAfterDelete.revision === 1 &&
    disabledNewRun.code === CONNECTION_ERROR_CODES.NOT_ACTIVE &&
    deletedNewRun.code ===
      CONNECTION_ERROR_CODES.NOT_ACTIVE, "lifecycle fencing or captured revision stability failed");
  require(replay.stateDigest === store.stateDigest() &&
    replay.stateDigest === replayAgain.stateDigest &&
    JSON.stringify(replay.connections) ===
      JSON.stringify(
        store.snapshot().connections,
      ), "duplicate/reordered replay did not converge");
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
      duplicateAndReorderedParity: true,
    },
  };
}

function authorizationFixture() {
  const store = makeStore();
  const connectionId = "connection-authz";
  store.create({
    actor: admin,
    ...definition({ connectionId }),
    idempotencyKey: "create-final-authz",
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
  require(ownership.memberRead === true &&
    ownership.memberGrant === true &&
    ownership.memberDelete === false, "ownership authorization parity failed");

  const foreign = {
    ...admin,
    tenantId: "tenant-final-foreign",
    workspaceId: "workspace-final-foreign",
  };
  const operations = {
    read: () => store.read({ actor: foreign, connectionId }),
    grant: () =>
      store.captureForRun({
        actor: foreign,
        connectionId,
        runId: "run-final-foreign",
      }),
    rotate: () =>
      store.rotate({
        actor: foreign,
        connectionId,
        expectedRevision: 1,
        secretRef: secretRef(2),
        idempotencyKey: "rotate-final-foreign",
      }),
    disable: () =>
      store.disable({
        actor: foreign,
        connectionId,
        idempotencyKey: "disable-final-foreign",
      }),
    delete: () =>
      store.delete({
        actor: foreign,
        connectionId,
        idempotencyKey: "delete-final-foreign",
      }),
  };
  const before = store.stateDigest();
  const foreignErrors = {};
  const unknownErrors = {};
  for (const [operation, action] of Object.entries(operations)) {
    foreignErrors[operation] = notFoundOutcome(action);
    unknownErrors[operation] = notFoundOutcome(() => {
      const input = { actor: foreign, connectionId: "connection-unknown" };
      if (operation === "grant") input.runId = "run-final-foreign";
      if (operation === "rotate") {
        input.expectedRevision = 1;
        input.secretRef = secretRef(2);
        input.idempotencyKey = "rotate-final-unknown";
      }
      if (operation === "disable" || operation === "delete") {
        input.idempotencyKey = operation + "-final-unknown";
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
    connectionId: "connection-unknown",
  });
  const errorsEqual =
    JSON.stringify(foreignErrors) === JSON.stringify(unknownErrors);
  const authorizationEqual =
    JSON.stringify(foreignAuthorization) ===
    JSON.stringify(unknownAuthorization);
  require(errorsEqual &&
    authorizationEqual, "foreign and unknown authz differed");
  require(store.stateDigest() ===
    before, "authz probes moved the state digest");
  return {
    ownership,
    foreignErrors,
    unknownErrors,
    foreignAuthorization,
    unknownAuthorization,
    foreignUnknownEqual: errorsEqual && authorizationEqual,
    stateDigestUnchanged: store.stateDigest() === before,
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
  const normalConnectionId = "connection-normal-identifier-000001";
  const cases = {
    safe: createdEvent(),
    terminalSafe: terminalEvent({ reason: "maintenance" }),
    metadataUrlSafe: createdEvent({
      data: { metadata: { safe: urlSafeBase64 } },
    }),
    terminalUrlSafe: terminalEvent({ reason: urlSafeBase64 }),
    eventIdUrlSafe: createdEvent({ eventId: urlSafeBase64 }),
    workspaceIdUrlSafe: createdEvent({ workspaceId: urlSafeBase64 }),
    actorIdUrlSafe: createdEvent({ actorId: urlSafeBase64 }),
    idempotencyKeyUrlSafe: createdEvent({ idempotencyKey: urlSafeBase64 }),
    connectionIdUrlSafe: createdEvent({
      connectionId: urlSafeBase64,
      data: { connectionId: urlSafeBase64 },
    }),
    metadataStandard: createdEvent({
      data: { metadata: { safe: standardBase64 } },
    }),
    terminalStandard: terminalEvent({ reason: standardBase64 }),
    metadataProviderValue: createdEvent({
      data: { metadata: { safe: providerValue } },
    }),
    metadataPaddedUrlSafe: createdEvent({
      data: { metadata: { safe: urlSafePadded } },
    }),
    metadataMixedAlphabet: createdEvent({
      data: { metadata: { safe: mixedAlphabetBase64 } },
    }),
    metadataShortUrlSafe: createdEvent({
      data: { metadata: { safe: urlSafeShort } },
    }),
    terminalShortUrlSafe: terminalEvent({ reason: urlSafeShort }),
    eventIdShortUrlSafe: createdEvent({ eventId: urlSafeShort }),
    metadataMalformedPadding: createdEvent({
      data: { metadata: { safe: urlSafeMalformedPadding } },
    }),
    metadataNestedCase: createdEvent({
      data: {
        metadata: {
          outer: {
            safe: { [["AUTH", "ORIZATION"].join("")]: "opaque-value" },
          },
        },
      },
    }),
    metadataRecursiveProvider: createdEvent({
      data: {
        metadata: {
          one: { two: { three: { four: { five: providerValue } } } },
        },
      },
    }),
    extraTop: createdEvent({ extraField: "unsupported" }),
    extraCreated: createdEvent({ data: { extraField: "unsupported" } }),
    extraSecretRef: createdEvent({
      data: { secretRef: { ...secretRef(1), extraField: "unsupported" } },
    }),
    extraOwner: createdEvent({
      data: {
        owner: {
          kind: "workspace",
          id: scope.workspaceId,
          extraField: "unsupported",
        },
      },
    }),
    normalLongIdentifier: createdEvent({
      connectionId: normalConnectionId,
      data: { connectionId: normalConnectionId },
    }),
    escapedJsonCredential: createdEvent({
      data: { metadata: { safe: escapedJsonCredential } },
    }),
    prototypePollutionMetadata: createdEvent({
      data: { metadata: prototypePollutionMetadata },
    }),
  };
  const outcomes = {};
  for (const [name, value] of Object.entries(cases)) {
    const accepted = validate(value);
    outcomes[name] = {
      accepted,
      errorCount: validate.errors?.length ?? 0,
    };
  }
  const requiredRejected = [
    "metadataUrlSafe",
    "terminalUrlSafe",
    "eventIdUrlSafe",
    "workspaceIdUrlSafe",
    "actorIdUrlSafe",
    "idempotencyKeyUrlSafe",
    "connectionIdUrlSafe",
    "metadataStandard",
    "terminalStandard",
    "metadataProviderValue",
    "metadataPaddedUrlSafe",
    "metadataMixedAlphabet",
    "metadataShortUrlSafe",
    "terminalShortUrlSafe",
    "eventIdShortUrlSafe",
    "metadataNestedCase",
    "metadataRecursiveProvider",
    "extraTop",
    "extraCreated",
    "extraSecretRef",
    "extraOwner",
    "prototypePollutionMetadata",
  ];
  const findings = [];
  for (const name of requiredRejected) {
    if (outcomes[name].accepted) {
      failures.push("public schema accepted " + name);
      findings.push({
        id: "E5-T02-CRITIC-FINAL-SCHEMA-" + name.toUpperCase(),
        severity: "high",
        summary:
          "Public Draft-2020-12 schema accepted a required secret-shaped case",
        case: name,
      });
    }
  }
  if (!outcomes.safe.accepted || !outcomes.terminalSafe.accepted) {
    failures.push("public schema rejected a safe control");
  }
  if (!outcomes.normalLongIdentifier.accepted) {
    failures.push("public schema rejected a valid long opaque identifier");
    findings.push({
      id: "E5-T02-CRITIC-FINAL-SCHEMA-NORMAL-ID",
      severity: "medium",
      summary:
        "Public schema rejected a valid opaque identifier as base64-shaped",
      case: "normalLongIdentifier",
    });
  }
  if (outcomes.escapedJsonCredential.accepted) {
    findings.push({
      id: "E5-T02-CRITIC-FINAL-ESCAPED-JSON",
      severity: "high",
      summary:
        "Public schema accepted a JSON string whose credential key is Unicode-escaped",
      observation: {
        schemaAccepted: true,
        runtimeRejects: true,
      },
      source:
        "packages/connections/src/schemas/connection-events.v1.schema.json:73-98,158-180",
    });
  }
  return {
    validator: "Ajv 8 Draft 2020-12",
    module: ajvPath,
    outcomes,
    findings,
  };
}

function newAttackFixture() {
  const runtimeEscaped = attempt(() =>
    normalizeMetadata({ safe: escapedJsonCredential }),
  );
  const runtimePrototype = attempt(() =>
    normalizeMetadata(prototypePollutionMetadata),
  );
  const findings = [];
  if (runtimeEscaped.accepted) {
    findings.push({
      id: "E5-T02-CRITIC-FINAL-ESCAPED-JSON-RUNTIME",
      severity: "high",
      summary: "Runtime accepted a Unicode-escaped credential key in JSON text",
      observation: { accepted: true, rawReturned: runtimeEscaped.rawReturned },
    });
  }
  if (runtimePrototype.accepted) {
    findings.push({
      id: "E5-T02-CRITIC-FINAL-PROTOTYPE-POLLUTION",
      severity: "high",
      summary: "Runtime accepted a prototype-pollution-shaped metadata object",
      observation: {
        accepted: true,
        rawReturned: runtimePrototype.rawReturned,
      },
    });
  }
  return {
    attack: "Unicode-escaped JSON credential key and parsed __proto__ metadata",
    runtimeEscaped,
    runtimePrototype,
    findings,
  };
}

function createdEvent(overrides = {}) {
  const { data: dataOverrides = {}, ...topOverrides } = overrides;
  return {
    schemaVersion: 1,
    eventId: "event-final-created",
    eventType: "connection.created",
    workspaceId: scope.workspaceId,
    actorId: admin.id,
    idempotencyKey: "create-final-event",
    sequence: 1,
    serverTimestamp: "2026-08-20T12:00:00.000Z",
    connectionId: "connection-final-event",
    ...topOverrides,
    data: {
      ...definition({ connectionId: "connection-final-event" }),
      ...dataOverrides,
      revision: 1,
    },
  };
}

function terminalEvent({ reason, ...topOverrides } = {}) {
  return {
    ...createdEvent(topOverrides),
    eventType: "connection.deleted",
    data: { reason },
  };
}

function definition(overrides = {}) {
  return {
    connectionId: "connection-final-default",
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    owner: { kind: "workspace", id: scope.workspaceId },
    provider: "github",
    integration: "issues",
    label: "Critic final connection",
    metadata: {},
    secretRef: secretRef(1),
    ...overrides,
  };
}

function secretRef(revision) {
  return {
    schemaVersion: 1,
    id: "secretref-final-" + String(revision).padStart(3, "0"),
    provider: "infisical",
    mount: "production",
    revision,
    label: "github",
  };
}

function makeStore() {
  let now = Date.parse("2026-08-20T12:00:00.000Z");
  return createConnectionStore({
    ...scope,
    clock: () => new Date((now += 1000)),
  });
}

function attempt(action) {
  try {
    const value = action();
    const serialized = JSON.stringify(value);
    return {
      accepted: true,
      rawReturned:
        serialized.includes(urlSafeBase64) ||
        serialized.includes(providerValue),
      code: null,
      path: null,
      statusCode: null,
    };
  } catch (error) {
    return {
      accepted: false,
      rawReturned: false,
      code: error?.code ?? error?.name ?? "UNKNOWN",
      path: error?.path ?? null,
      statusCode: error?.statusCode ?? null,
    };
  }
}

function notFoundOutcome(action) {
  const outcome = attempt(action);
  require(outcome.accepted === false &&
    outcome.code ===
      CONNECTION_ERROR_CODES.NOT_FOUND, "foreign or unknown operation was not a typed not-found refusal");
  return {
    code: outcome.code,
    path: outcome.path,
    statusCode: outcome.statusCode,
  };
}

function requireCredentialRejection(name, outcome) {
  if (
    outcome.accepted ||
    outcome.code !== CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL
  ) {
    failures.push({
      name,
      expected: CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL,
      observed: outcome,
    });
  }
}

function require(condition, message) {
  if (!condition) failures.push(message);
}
