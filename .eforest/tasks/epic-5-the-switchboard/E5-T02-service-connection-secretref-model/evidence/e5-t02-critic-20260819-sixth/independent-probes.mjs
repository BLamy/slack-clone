import assert from "node:assert/strict";
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
const providerToken = "ghp_" + "a".repeat(32);
const neutralBase64 = Buffer.from(
  "neutral standard base64 fixture " + "x".repeat(16),
).toString("base64");
const neutralBase64Url = "a" + "a".repeat(21) + "-a";
assert.equal(
  Buffer.from(neutralBase64Url, "base64url").toString("base64url"),
  neutralBase64Url,
);
const scope = Object.freeze({
  tenantId: "tenant-sixth",
  workspaceId: "workspace-sixth",
});
const admin = Object.freeze({
  ...scope,
  id: "user-sixth-admin",
  kind: "user",
  role: "admin",
});
const member = Object.freeze({
  ...scope,
  id: "user-sixth-member",
  kind: "user",
  role: "member",
});

const result = {
  schemaVersion: 1,
  task: "E5-T02",
  exactHead,
  inputs: {
    neutralStandardBase64Length: neutralBase64.length,
    neutralBase64UrlLength: neutralBase64Url.length,
    neutralBase64UrlUsesUrlSafeAlphabet: true,
  },
  runtimeBoundaries: runtimeBoundaryFixture(),
  storeBoundaries: storeBoundaryFixture(),
  lifecycle: lifecycleFixture(),
  authz: authorizationFixture(),
  publicSchema: await publicSchemaFixture(),
  findings: [
    {
      id: "E5-T02-CRITIC-SIXTH-001",
      severity: "high",
      summary:
        "RFC 4648 URL-safe base64 values bypass the runtime credential detector and are accepted by metadata, reason, opaque-id, capability, capture, and terminal-event paths",
      source:
        "packages/connections/src/schema.mjs:661-672,714-731; packages/connections/src/store.mjs:166-219,237-277; packages/connections/src/schemas/connection-events.v1.schema.json:73-98,225-230",
    },
  ],
};

await writeFile(
  path.join(evidenceDirectory, "independent-probes.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));

function runtimeBoundaryFixture() {
  const rejected = {};
  const accepted = {};
  const cases = [
    [
      "principal-capability-provider-token",
      () => normalizePrincipal({ ...admin, capabilities: [providerToken] }),
      "reject",
    ],
    [
      "principal-capability-standard-base64",
      () => normalizePrincipal({ ...admin, capabilities: [neutralBase64] }),
      "reject",
    ],
    [
      "principal-capability-case-variant",
      () =>
        normalizePrincipal({
          ...admin,
          capabilities: ["GHP_" + "A".repeat(32)],
        }),
      "reject",
    ],
    [
      "principal-capability-url-safe-base64",
      () => normalizePrincipal({ ...admin, capabilities: [neutralBase64Url] }),
      "accept-finding",
    ],
    [
      "principal-capability-recursive-case-key",
      () =>
        normalizePrincipal({
          ...admin,
          capabilities: [{ safe: { ["AUTH" + "ORIZATION"]: "opaque-value" } }],
        }),
      "reject",
    ],
    [
      "principal-extra-field",
      () => normalizePrincipal({ ...admin, extraField: "unsupported" }),
      "reject-any",
    ],
    ["reason-provider-token", () => normalizeReason(providerToken), "reject"],
    ["reason-standard-base64", () => normalizeReason(neutralBase64), "reject"],
    [
      "metadata-case-variant-url",
      () =>
        normalizeMetadata({ safe: "HTTPS://user:password@example.invalid" }),
      "reject",
    ],
    [
      "metadata-case-variant-json",
      () =>
        normalizeMetadata({
          safe: '{"' + "TOKEN" + '":"' + "opaque-value" + '"}',
        }),
      "reject",
    ],
    [
      "metadata-recursive-provider-token",
      () =>
        normalizeMetadata({
          one: { two: { three: { four: { five: providerToken } } } },
        }),
      "reject",
    ],
    [
      "metadata-extra-field",
      () =>
        normalizeConnectionDefinition(
          definition({ extraField: "unsupported" }),
        ),
      "reject-any",
    ],
    [
      "secretref-extra-field",
      () => normalizeSecretRef({ ...secretRef(1), extraField: "unsupported" }),
      "reject-any",
    ],
    [
      "owner-provider-token",
      () => normalizeOwner({ kind: "workspace", id: providerToken }),
      "reject",
    ],
    [
      "opaque-id-provider-token",
      () => normalizeOpaqueIdForStore(providerToken),
      "reject",
    ],
    [
      "opaque-id-url-safe-base64",
      () => normalizeOpaqueIdForStore(neutralBase64Url),
      "accept-finding",
    ],
    [
      "metadata-url-safe-base64",
      () => normalizeMetadata({ safe: neutralBase64Url }),
      "accept-finding",
    ],
    [
      "reason-url-safe-base64",
      () => normalizeReason(neutralBase64Url),
      "accept-finding",
    ],
    [
      "event-terminal-reason-url-safe-base64",
      () =>
        normalizeConnectionEvent(terminalEvent({ reason: neutralBase64Url })),
      "accept-finding",
    ],
    [
      "event-opaque-id-url-safe-base64",
      () =>
        normalizeConnectionEvent({
          ...createdEvent(),
          eventId: neutralBase64Url,
        }),
      "accept-finding",
    ],
  ];

  for (const [name, action, expectation] of cases) {
    const outcome = summarizeAttempt(action);
    if (expectation === "reject") {
      assert.equal(outcome.accepted, false, name);
      assert.equal(
        outcome.code,
        CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL,
        name,
      );
      rejected[name] = outcome;
    } else if (expectation === "reject-any") {
      assert.equal(outcome.accepted, false, name);
      rejected[name] = outcome;
    } else {
      assert.equal(outcome.accepted, true, name);
      accepted[name] = outcome;
    }
  }

  assert.equal(isCredentialMaterial(neutralBase64), true);
  assert.equal(isCredentialMaterial(neutralBase64Url), false);
  return {
    rejected,
    accepted,
    detector: { standardBase64: true, urlSafeBase64: false },
  };
}

function storeBoundaryFixture() {
  const store = makeStore();
  const valid = definition({ connectionId: "connection-sixth-store" });
  const initialCount = store.events().length;
  const capabilityCreate = summarizeAttempt(() =>
    store.create({
      actor: { ...admin, capabilities: [neutralBase64Url] },
      ...valid,
      idempotencyKey: "create-sixth-capability-url-safe",
    }),
  );
  assert.equal(capabilityCreate.accepted, true);
  assert.equal(store.events().length, initialCount + 1);

  const second = store.create({
    actor: admin,
    ...definition({ connectionId: "connection-sixth-boundary" }),
    idempotencyKey: "create-sixth-boundary",
  });
  const beforeRejected = store.events().length;
  const providerCreate = summarizeAttempt(() =>
    store.create({
      actor: { ...admin, capabilities: [providerToken] },
      ...definition({ connectionId: "connection-sixth-provider-capability" }),
      idempotencyKey: "create-sixth-capability-provider",
    }),
  );
  assert.equal(providerCreate.accepted, false);
  assert.equal(providerCreate.code, CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL);
  const rejectedCreate = summarizeAttempt(() =>
    store.create({
      actor: { ...admin, capabilities: [neutralBase64] },
      ...definition({ connectionId: "connection-sixth-standard-base64" }),
      idempotencyKey: "create-sixth-capability-standard",
    }),
  );
  assert.equal(rejectedCreate.accepted, false);
  assert.equal(rejectedCreate.code, CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL);

  const authorizationUrlSafe = summarizeAttempt(() =>
    store.authorization({
      actor: { ...member, capabilities: [neutralBase64Url] },
      connectionId: second.connection.connectionId,
      action: "grant",
    }),
  );
  assert.equal(authorizationUrlSafe.accepted, true);
  const authorizationStandard = summarizeAttempt(() =>
    store.authorization({
      actor: { ...member, capabilities: [neutralBase64] },
      connectionId: second.connection.connectionId,
      action: "grant",
    }),
  );
  assert.equal(authorizationStandard.accepted, false);
  assert.equal(
    authorizationStandard.code,
    CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL,
  );
  const authorizationProvider = summarizeAttempt(() =>
    store.authorization({
      actor: { ...member, capabilities: [providerToken] },
      connectionId: second.connection.connectionId,
      action: "grant",
    }),
  );
  assert.equal(authorizationProvider.accepted, false);
  assert.equal(
    authorizationProvider.code,
    CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL,
  );

  const captureActorUrlSafe = summarizeAttempt(() =>
    store.captureForRun({
      actor: { ...member, capabilities: [neutralBase64Url] },
      connectionId: second.connection.connectionId,
      runId: "run-sixth-capability-url-safe",
    }),
  );
  assert.equal(captureActorUrlSafe.accepted, true);
  const captureActorProvider = summarizeAttempt(() =>
    store.captureForRun({
      actor: { ...member, capabilities: [providerToken] },
      connectionId: second.connection.connectionId,
      runId: "run-sixth-provider-capability",
    }),
  );
  assert.equal(captureActorProvider.accepted, false);
  assert.equal(
    captureActorProvider.code,
    CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL,
  );
  const captureRunIdUrlSafe = summarizeAttempt(() =>
    store.captureForRun({
      actor: member,
      connectionId: second.connection.connectionId,
      runId: neutralBase64Url,
    }),
  );
  assert.equal(captureRunIdUrlSafe.accepted, true);
  assert.equal(captureRunIdUrlSafe.rawReturned, true);

  const captureStandard = summarizeAttempt(() =>
    store.captureForRun({
      actor: member,
      connectionId: second.connection.connectionId,
      runId: neutralBase64,
    }),
  );
  assert.equal(captureStandard.accepted, false);
  assert.equal(
    captureStandard.code,
    CONNECTION_ERROR_CODES.CREDENTIAL_MATERIAL,
  );
  assert.equal(store.events().length, beforeRejected + 0);

  const terminalStore = makeStore();
  terminalStore.create({
    actor: admin,
    ...definition({ connectionId: "connection-sixth-terminal" }),
    idempotencyKey: "create-sixth-terminal",
  });
  const beforeDisable = terminalStore.events().length;
  const disableUrlSafe = summarizeAttempt(() =>
    terminalStore.disable({
      actor: admin,
      connectionId: "connection-sixth-terminal",
      reason: neutralBase64Url,
      idempotencyKey: "disable-sixth-url-safe",
    }),
  );
  assert.equal(disableUrlSafe.accepted, true);
  assert.equal(terminalStore.events().length, beforeDisable + 1);

  return {
    capabilityCreate,
    providerCreate,
    rejectedCreate,
    authorization: {
      urlSafe: authorizationUrlSafe,
      standard: authorizationStandard,
      provider: authorizationProvider,
    },
    captureActorUrlSafe,
    captureActorProvider,
    captureRunIdUrlSafe,
    captureStandard,
    terminalReasonUrlSafe: disableUrlSafe,
    eventCounts: {
      afterCapabilityCreate: initialCount + 1,
      afterRejectedCreate: store.events().length,
      terminalAfterUrlSafeReason: terminalStore.events().length,
    },
  };
}

function lifecycleFixture() {
  const store = makeStore();
  const connectionId = "connection-sixth-lifecycle";
  store.create({
    actor: admin,
    ...definition({ connectionId }),
    idempotencyKey: "create-sixth-lifecycle",
  });
  const beforeRotate = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-sixth-stable",
  });
  store.rotate({
    actor: admin,
    connectionId,
    expectedRevision: 1,
    secretRef: secretRef(2),
    idempotencyKey: "rotate-sixth-lifecycle",
  });
  const afterRotateSameRun = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-sixth-stable",
  });
  const afterRotateNewRun = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-sixth-new",
  });
  assert.equal(beforeRotate.revision, 1);
  assert.equal(afterRotateSameRun.revision, 1);
  assert.equal(afterRotateNewRun.revision, 2);
  store.disable({
    actor: admin,
    connectionId,
    reason: "sixth-maintenance",
    idempotencyKey: "disable-sixth-lifecycle",
  });
  assert.equal(
    store.captureForRun({
      actor: member,
      connectionId,
      runId: "run-sixth-stable",
    }).revision,
    1,
  );
  const disabledNewRun = summarizeAttempt(() =>
    store.captureForRun({
      actor: member,
      connectionId,
      runId: "run-sixth-disabled",
    }),
  );
  assert.equal(disabledNewRun.code, CONNECTION_ERROR_CODES.NOT_ACTIVE);
  store.delete({
    actor: admin,
    connectionId,
    reason: "sixth-retired",
    idempotencyKey: "delete-sixth-lifecycle",
  });
  assert.equal(
    store.captureForRun({
      actor: member,
      connectionId,
      runId: "run-sixth-stable",
    }).revision,
    1,
  );
  const deletedNewRun = summarizeAttempt(() =>
    store.captureForRun({
      actor: member,
      connectionId,
      runId: "run-sixth-deleted",
    }),
  );
  assert.equal(deletedNewRun.code, CONNECTION_ERROR_CODES.NOT_ACTIVE);

  const events = store.events();
  const input = [...events, ...events].reverse();
  const replay = replayConnectionEvents(input);
  const replayAgain = replayConnectionEvents(input);
  assert.equal(replay.stateDigest, store.stateDigest());
  assert.equal(replay.stateDigest, replayAgain.stateDigest);
  assert.deepEqual(replay.connections, replayAgain.connections);
  return {
    revisionStability: {
      beforeRotate: beforeRotate.revision,
      afterRotateSameRun: afterRotateSameRun.revision,
      afterRotateNewRun: afterRotateNewRun.revision,
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
  const connectionId = "connection-sixth-authz";
  store.create({
    actor: admin,
    ...definition({ connectionId }),
    idempotencyKey: "create-sixth-authz",
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
  assert.deepEqual(ownership, {
    memberRead: true,
    memberGrant: true,
    memberDelete: false,
  });
  const foreign = {
    ...admin,
    tenantId: "tenant-sixth-foreign",
    workspaceId: "workspace-sixth-foreign",
  };
  const operations = {
    read: () => store.read({ actor: foreign, connectionId }),
    grant: () =>
      store.captureForRun({
        actor: foreign,
        connectionId,
        runId: "run-sixth-foreign",
      }),
    rotate: () =>
      store.rotate({
        actor: foreign,
        connectionId,
        expectedRevision: 1,
        secretRef: secretRef(2),
        idempotencyKey: "rotate-sixth-foreign",
      }),
    disable: () =>
      store.disable({
        actor: foreign,
        connectionId,
        idempotencyKey: "disable-sixth-foreign",
      }),
    delete: () =>
      store.delete({
        actor: foreign,
        connectionId,
        idempotencyKey: "delete-sixth-foreign",
      }),
  };
  const before = store.stateDigest();
  const foreignErrors = Object.fromEntries(
    Object.entries(operations).map(([name, action]) => [
      name,
      errorJson(action),
    ]),
  );
  const unknownErrors = Object.fromEntries(
    Object.keys(operations).map((name) => {
      const input = {
        actor: foreign,
        connectionId: "connection-sixth-unknown",
      };
      if (name === "grant") input.runId = "run-sixth-unknown";
      if (name === "rotate") {
        input.expectedRevision = 1;
        input.secretRef = secretRef(2);
        input.idempotencyKey = "rotate-sixth-unknown";
      }
      if (name === "disable" || name === "delete")
        input.idempotencyKey = name + "-sixth-unknown";
      return [
        name,
        errorJson(() => {
          if (name === "read") return store.read(input);
          if (name === "grant") return store.captureForRun(input);
          if (name === "rotate") return store.rotate(input);
          if (name === "disable") return store.disable(input);
          return store.delete(input);
        }),
      ];
    }),
  );
  assert.deepEqual(foreignErrors, unknownErrors);
  assert.equal(store.stateDigest(), before);
  return {
    ownership,
    foreignErrors,
    unknownErrors,
    foreignUnknownEqual: true,
    stateDigestUnchanged: true,
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
  const base = createdEvent();
  const cases = {
    safe: base,
    terminalSafe: terminalEvent({ reason: "maintenance" }),
    terminalProviderToken: terminalEvent({ reason: providerToken }),
    terminalStandardBase64: terminalEvent({ reason: neutralBase64 }),
    terminalUrlSafeBase64: terminalEvent({ reason: neutralBase64Url }),
    terminalUpperUrl: terminalEvent({
      reason: "HTTPS://user:password@example.invalid",
    }),
    terminalUpperJson: terminalEvent({
      reason: '{"' + "TOKEN" + '":"' + "opaque-value" + '"}',
    }),
    metadataUrlSafeBase64: createdEvent({
      metadata: { safe: neutralBase64Url },
    }),
    metadataNestedCaseVariant: createdEvent({
      metadata: { safe: { ["AUTH" + "ORIZATION"]: "opaque-value" } },
    }),
    metadataRecursiveProviderToken: createdEvent({
      metadata: { one: { two: { three: { four: { five: providerToken } } } } },
    }),
    metadataExtraCreated: createdEvent({ extraField: "unsupported" }),
    opaqueEventUrlSafeBase64: { ...base, eventId: neutralBase64Url },
    extraTop: { ...base, extraField: "unsupported" },
    extraTerminal: terminalEvent({
      reason: "maintenance",
      extraField: "unsupported",
    }),
    extraSecretRef: createdEvent({
      secretRef: { ...secretRef(1), extraField: "unsupported" },
    }),
    extraOwner: createdEvent({
      owner: {
        kind: "workspace",
        id: scope.workspaceId,
        extraField: "unsupported",
      },
    }),
  };
  const outcomes = {};
  for (const [name, value] of Object.entries(cases)) {
    const accepted = validate(value);
    outcomes[name] = { accepted, errorCount: validate.errors?.length ?? 0 };
  }
  assert.equal(outcomes.safe.accepted, true);
  assert.equal(outcomes.terminalSafe.accepted, true);
  for (const name of [
    "terminalProviderToken",
    "terminalStandardBase64",
    "terminalUpperUrl",
    "terminalUpperJson",
    "metadataNestedCaseVariant",
    "metadataRecursiveProviderToken",
    "extraTop",
    "extraTerminal",
    "extraSecretRef",
    "extraOwner",
  ])
    assert.equal(outcomes[name].accepted, false, name);
  for (const name of [
    "terminalUrlSafeBase64",
    "metadataUrlSafeBase64",
    "opaqueEventUrlSafeBase64",
  ])
    assert.equal(outcomes[name].accepted, true, name);
  return {
    validator: "Ajv 8 Draft 2020-12",
    module: ajvPath,
    outcomes,
    finding: {
      terminalUrlSafeBase64Accepted: outcomes.terminalUrlSafeBase64.accepted,
      metadataUrlSafeBase64Accepted: outcomes.metadataUrlSafeBase64.accepted,
      opaqueEventUrlSafeBase64Accepted:
        outcomes.opaqueEventUrlSafeBase64.accepted,
    },
  };
}

function createdEvent(overrides = {}) {
  const dataOverrides = {
    ...overrides,
    owner: overrides.owner ?? { kind: "workspace", id: scope.workspaceId },
    secretRef: overrides.secretRef ?? secretRef(1),
    metadata: overrides.metadata ?? {},
  };
  return {
    schemaVersion: 1,
    eventId: "event-sixth-created",
    eventType: "connection.created",
    workspaceId: scope.workspaceId,
    actorId: admin.id,
    idempotencyKey: "create-sixth-event",
    sequence: 1,
    serverTimestamp: "2026-08-19T18:00:00.000Z",
    connectionId: "connection-sixth-event",
    data: {
      ...definition({ connectionId: "connection-sixth-event" }),
      ...dataOverrides,
      revision: 1,
    },
  };
}

function terminalEvent({ reason, ...extra } = {}) {
  return {
    ...createdEvent(),
    eventType: "connection.deleted",
    data: { reason, ...extra },
  };
}

function definition(overrides = {}) {
  return {
    connectionId: "connection-sixth-default",
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    owner: { kind: "workspace", id: scope.workspaceId },
    provider: "github",
    integration: "issues",
    label: "Sixth critic connection",
    metadata: {},
    secretRef: secretRef(1),
    ...overrides,
  };
}

function secretRef(revision) {
  return {
    schemaVersion: 1,
    id: "secretref-sixth-" + String(revision).padStart(3, "0"),
    provider: "infisical",
    mount: "production",
    revision,
    label: "github",
  };
}

function makeStore() {
  let now = Date.parse("2026-08-19T18:00:00.000Z");
  return createConnectionStore({
    ...scope,
    clock: () => new Date((now += 1000)),
  });
}

function summarizeAttempt(action) {
  try {
    const value = action();
    return {
      accepted: true,
      rawReturned: JSON.stringify(value).includes(neutralBase64Url),
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

function errorJson(action) {
  const outcome = summarizeAttempt(action);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.code, CONNECTION_ERROR_CODES.NOT_FOUND);
  return {
    code: outcome.code,
    path: outcome.path,
    statusCode: outcome.statusCode,
  };
}
