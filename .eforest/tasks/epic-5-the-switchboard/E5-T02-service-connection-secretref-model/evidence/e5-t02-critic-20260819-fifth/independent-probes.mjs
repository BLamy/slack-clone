import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import {
  CONNECTION_ERROR_CODES,
  canonicalSha256,
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
} from "@stream-slack/connections";

const root = process.cwd();
const evidenceDirectory = path.dirname(fileURLToPath(import.meta.url));
const exactHead = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const providerShape = "ghp_" + "a".repeat(32);
const neutralBase64 = Buffer.from(
  "independent neutral base64 fixture " + "x".repeat(16),
).toString("base64");
const scope = Object.freeze({
  tenantId: "tenant-fifth",
  workspaceId: "workspace-fifth",
});
const admin = Object.freeze({
  ...scope,
  id: "user-fifth-admin",
  kind: "user",
  role: "admin",
});
const member = Object.freeze({
  ...scope,
  id: "user-fifth-member",
  kind: "user",
  role: "member",
});

const result = {
  schemaVersion: 1,
  task: "E5-T02",
  exactHead,
  neutralBase64Length: neutralBase64.length,
  runtimeBoundary: runtimeBoundaryFixture(),
  eventBoundary: eventBoundaryFixture(),
  lifecycle: lifecycleFixture(),
  authz: authorizationFixture(),
  publicSchema: await publicSchemaFixture(),
  verifierCanary: await verifierCanaryFixture(),
  findings: [
    {
      id: "E5-T02-CRITIC-FIFTH-001",
      severity: "high",
      summary:
        "normalizePrincipal accepts a provider-token-shaped capability and returns it unchanged",
      source: "packages/connections/src/schema.mjs:242-283",
    },
    {
      id: "E5-T02-CRITIC-FIFTH-002",
      severity: "high",
      summary:
        "The public event schema accepts provider-token and neutral-base64 terminal reasons",
      source:
        "packages/connections/src/schemas/connection-events.v1.schema.json:221-229",
    },
  ],
};

await writeFile(
  path.join(evidenceDirectory, "independent-probes.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));

function runtimeBoundaryFixture() {
  const direct = {};
  const directInputs = [
    [
      "principal-id",
      () =>
        normalizePrincipal({
          ...scope,
          id: providerShape,
          kind: "user",
          role: "member",
        }),
    ],
    [
      "principal-tenant-id",
      () =>
        normalizePrincipal({
          ...scope,
          tenantId: providerShape,
          id: member.id,
          kind: "user",
          role: "member",
        }),
    ],
    [
      "principal-workspace-id",
      () =>
        normalizePrincipal({
          ...scope,
          workspaceId: providerShape,
          id: member.id,
          kind: "user",
          role: "member",
        }),
    ],
    [
      "principal-role",
      () =>
        normalizePrincipal({
          ...scope,
          id: member.id,
          kind: "user",
          role: providerShape,
        }),
    ],
    [
      "principal-capability",
      () =>
        normalizePrincipal({
          ...scope,
          id: member.id,
          kind: "user",
          role: "member",
          capabilities: [providerShape],
        }),
    ],
    [
      "owner-id",
      () => normalizeOwner({ kind: "workspace", id: providerShape }),
    ],
    ["opaque-id", () => normalizeOpaqueIdForStore(providerShape, "$.id")],
    ["reason", () => normalizeReason(providerShape)],
    [
      "secretref-label",
      () => normalizeSecretRef({ ...secretRef(1), label: providerShape }),
    ],
    ["metadata-value", () => normalizeMetadata({ safeLabel: providerShape })],
    [
      "definition-label",
      () => normalizeConnectionDefinition(definition({ label: providerShape })),
    ],
    [
      "definition-neutral-base64",
      () =>
        normalizeConnectionDefinition(
          definition({ metadata: { encodedValue: neutralBase64 } }),
        ),
    ],
    [
      "definition-provider-token",
      () =>
        normalizeConnectionDefinition(
          definition({ metadata: { encodedValue: providerShape } }),
        ),
    ],
  ];
  for (const [name, action] of directInputs) {
    direct[name] = summarizeAttempt(action);
  }
  assert.equal(direct["principal-capability"].accepted, true);
  assert.equal(direct["principal-capability"].rawReturned, true);
  for (const name of Object.keys(direct).filter(
    (candidate) => candidate !== "principal-capability",
  )) {
    assert.equal(direct[name].accepted, false, name);
  }

  const store = makeStore();
  const baseDefinition = definition({
    connectionId: "connection-fifth-boundary",
  });
  const created = store.create({
    actor: admin,
    ...baseDefinition,
    idempotencyKey: "create-fifth-boundary",
  });
  const eventCountBeforeRun = store.events().length;
  const storeAttempts = {
    connectionId: summarizeAttempt(() =>
      store.create({
        actor: admin,
        ...definition({ connectionId: providerShape }),
        idempotencyKey: "create-fifth-connection-token",
      }),
    ),
    neutralBase64: summarizeAttempt(() =>
      store.create({
        actor: admin,
        ...definition({
          connectionId: "connection-fifth-neutral-base64",
          metadata: { encodedValue: neutralBase64 },
        }),
        idempotencyKey: "create-fifth-neutral-base64",
      }),
    ),
    providerToken: summarizeAttempt(() =>
      store.create({
        actor: admin,
        ...definition({
          connectionId: "connection-fifth-provider-token",
          metadata: { encodedValue: providerShape },
        }),
        idempotencyKey: "create-fifth-provider-token",
      }),
    ),
    actorCapability: summarizeAttempt(() =>
      store.create({
        actor: { ...admin, capabilities: [providerShape] },
        ...definition({ connectionId: "connection-fifth-capability" }),
        idempotencyKey: "create-fifth-capability",
      }),
    ),
    authorizationActorId: summarizeAttempt(() =>
      store.authorization({
        actor: { ...member, id: providerShape },
        connectionId: baseDefinition.connectionId,
      }),
    ),
    runId: summarizeAttempt(() =>
      store.captureForRun({
        actor: member,
        connectionId: baseDefinition.connectionId,
        runId: providerShape,
      }),
    ),
    disableReason: summarizeAttempt(() =>
      store.disable({
        actor: admin,
        connectionId: baseDefinition.connectionId,
        reason: providerShape,
        idempotencyKey: "disable-fifth-reason",
      }),
    ),
  };
  const scopeAttempts = {
    tenantId: summarizeAttempt(() =>
      createConnectionStore({
        tenantId: providerShape,
        workspaceId: scope.workspaceId,
      }),
    ),
    workspaceId: summarizeAttempt(() =>
      createConnectionStore({
        tenantId: scope.tenantId,
        workspaceId: providerShape,
      }),
    ),
  };
  assert.equal(created.connection.connectionId, baseDefinition.connectionId);
  assert.equal(storeAttempts.actorCapability.accepted, true);
  for (const name of [
    "connectionId",
    "neutralBase64",
    "providerToken",
    "authorizationActorId",
    "runId",
    "disableReason",
  ]) {
    assert.equal(storeAttempts[name].accepted, false, name);
  }
  assert.equal(store.events().length, eventCountBeforeRun + 1);
  assert.equal(scopeAttempts.tenantId.accepted, false);
  assert.equal(scopeAttempts.workspaceId.accepted, false);
  return {
    direct,
    storeAttempts,
    appendedEventsAfterBoundaryAttempts: store.events().length,
    createdEventActorId: store.events()[0].actorId,
    scopeAttempts,
  };
}

function eventBoundaryFixture() {
  const base = {
    schemaVersion: 1,
    eventId: "event-fifth-boundary",
    eventType: "connection.created",
    workspaceId: scope.workspaceId,
    actorId: admin.id,
    idempotencyKey: "event-fifth-boundary-idempotency",
    sequence: 1,
    serverTimestamp: "2026-08-19T17:00:00.000Z",
    connectionId: "connection-fifth-event",
    data: {
      ...definition({ connectionId: "connection-fifth-event" }),
      revision: 1,
    },
  };
  const fields = {};
  for (const field of [
    "eventId",
    "workspaceId",
    "actorId",
    "idempotencyKey",
    "connectionId",
  ]) {
    fields[field] = summarizeAttempt(() =>
      normalizeConnectionEvent({ ...base, [field]: providerShape }),
    );
  }
  fields.tenantId = summarizeAttempt(() =>
    normalizeConnectionEvent({
      ...base,
      data: { ...base.data, tenantId: providerShape },
    }),
  );
  fields.ownerId = summarizeAttempt(() =>
    normalizeConnectionEvent({
      ...base,
      data: {
        ...base.data,
        owner: { kind: "workspace", id: providerShape },
      },
    }),
  );
  fields.label = summarizeAttempt(() =>
    normalizeConnectionEvent({
      ...base,
      data: { ...base.data, label: providerShape },
    }),
  );
  fields.secretRefLabel = summarizeAttempt(() =>
    normalizeConnectionEvent({
      ...base,
      data: {
        ...base.data,
        secretRef: { ...secretRef(1), label: providerShape },
      },
    }),
  );
  fields.metadataValue = summarizeAttempt(() =>
    normalizeConnectionEvent({
      ...base,
      data: { ...base.data, metadata: { safeLabel: providerShape } },
    }),
  );
  for (const [name, outcome] of Object.entries(fields)) {
    assert.equal(outcome.accepted, false, name);
  }
  return fields;
}

function lifecycleFixture() {
  const store = makeStore();
  const connectionId = "connection-fifth-lifecycle";
  store.create({
    actor: admin,
    ...definition({ connectionId }),
    idempotencyKey: "create-fifth-lifecycle",
  });
  const beforeRotate = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-fifth-stable",
  });
  store.rotate({
    actor: admin,
    connectionId,
    expectedRevision: 1,
    secretRef: secretRef(2),
    idempotencyKey: "rotate-fifth-lifecycle",
  });
  const afterRotateSameRun = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-fifth-stable",
  });
  const afterRotateNewRun = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-fifth-new",
  });
  assert.equal(beforeRotate.revision, 1);
  assert.equal(afterRotateSameRun.revision, 1);
  assert.equal(afterRotateNewRun.revision, 2);
  const beforeDisable = store.events().length;
  store.disable({
    actor: admin,
    connectionId,
    reason: "fifth-maintenance",
    idempotencyKey: "disable-fifth-lifecycle",
  });
  const afterDisableSameRun = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-fifth-stable",
  });
  const afterDisableNewRun = summarizeAttempt(() =>
    store.captureForRun({
      actor: member,
      connectionId,
      runId: "run-fifth-after-disable",
    }),
  );
  assert.equal(afterDisableSameRun.revision, 1);
  assert.equal(afterDisableNewRun.code, CONNECTION_ERROR_CODES.NOT_ACTIVE);
  const beforeDelete = store.events().length;
  store.delete({
    actor: admin,
    connectionId,
    reason: "fifth-retired",
    idempotencyKey: "delete-fifth-lifecycle",
  });
  const afterDeleteSameRun = store.captureForRun({
    actor: member,
    connectionId,
    runId: "run-fifth-stable",
  });
  const afterDeleteNewRun = summarizeAttempt(() =>
    store.captureForRun({
      actor: member,
      connectionId,
      runId: "run-fifth-after-delete",
    }),
  );
  assert.equal(afterDeleteSameRun.revision, 1);
  assert.equal(afterDeleteNewRun.code, CONNECTION_ERROR_CODES.NOT_ACTIVE);
  const events = store.events();
  const replayed = replayConnectionEvents([...events, ...events].reverse());
  const replayedAgain = replayConnectionEvents(
    [...events, ...events].reverse(),
  );
  assert.equal(replayed.stateDigest, store.stateDigest());
  assert.equal(replayed.stateDigest, replayedAgain.stateDigest);
  assert.deepEqual(replayed.connections, replayedAgain.connections);

  const staleStore = makeStore();
  const staleConnectionId = "connection-fifth-stale";
  staleStore.create({
    actor: admin,
    ...definition({ connectionId: staleConnectionId }),
    idempotencyKey: "create-fifth-stale",
  });
  staleStore.rotate({
    actor: admin,
    connectionId: staleConnectionId,
    expectedRevision: 1,
    secretRef: secretRef(2),
    idempotencyKey: "rotate-fifth-stale-first",
  });
  const staleBefore = staleStore.events().length;
  const staleBeforeTerminal = summarizeAttempt(() =>
    staleStore.rotate({
      actor: admin,
      connectionId: staleConnectionId,
      expectedRevision: 1,
      secretRef: secretRef(3),
      idempotencyKey: "rotate-fifth-stale-before-terminal",
    }),
  );
  assert.equal(
    staleBeforeTerminal.code,
    CONNECTION_ERROR_CODES.REVISION_CONFLICT,
  );
  const afterStaleBefore = staleStore.events().length;
  assert.equal(afterStaleBefore, staleBefore);
  staleStore.disable({
    actor: admin,
    connectionId: staleConnectionId,
    reason: "fifth-stale-disable",
    idempotencyKey: "disable-fifth-stale",
  });
  const afterDisableCount = staleStore.events().length;
  const staleAfterDisable = summarizeAttempt(() =>
    staleStore.rotate({
      actor: admin,
      connectionId: staleConnectionId,
      expectedRevision: 2,
      secretRef: secretRef(3),
      idempotencyKey: "rotate-fifth-stale-after-disable",
    }),
  );
  assert.equal(staleAfterDisable.code, CONNECTION_ERROR_CODES.NOT_ACTIVE);
  const afterStaleDisable = staleStore.events().length;
  assert.equal(afterStaleDisable, afterDisableCount);
  staleStore.delete({
    actor: admin,
    connectionId: staleConnectionId,
    reason: "fifth-stale-delete",
    idempotencyKey: "delete-fifth-stale",
  });
  const afterDeleteCount = staleStore.events().length;
  const staleAfterDelete = summarizeAttempt(() =>
    staleStore.rotate({
      actor: admin,
      connectionId: staleConnectionId,
      expectedRevision: 2,
      secretRef: secretRef(4),
      idempotencyKey: "rotate-fifth-stale-after-delete",
    }),
  );
  assert.equal(staleAfterDelete.code, CONNECTION_ERROR_CODES.NOT_ACTIVE);
  const afterStaleDelete = staleStore.events().length;
  assert.equal(afterStaleDelete, afterDeleteCount);

  const collisionStore = makeStore();
  for (const [id, idempotencyKey] of [
    ["connection-fifth-a:b", "create-fifth-a-b"],
    ["connection-fifth-a", "create-fifth-a"],
  ]) {
    collisionStore.create({
      actor: admin,
      ...definition({ connectionId: id }),
      idempotencyKey,
    });
  }
  const firstBinding = collisionStore.captureForRun({
    actor: member,
    connectionId: "connection-fifth-a:b",
    runId: "run-fifth-c",
  });
  const secondBinding = collisionStore.captureForRun({
    actor: member,
    connectionId: "connection-fifth-a",
    runId: "b:run-fifth-c",
  });
  assert.notEqual(firstBinding.bindingDigest, secondBinding.bindingDigest);
  assert.equal(firstBinding.connectionId, "connection-fifth-a:b");
  assert.equal(secondBinding.connectionId, "connection-fifth-a");
  return {
    revisionStability: {
      beforeRotate: beforeRotate.revision,
      afterRotateSameRun: afterRotateSameRun.revision,
      afterRotateNewRun: afterRotateNewRun.revision,
      afterDisableSameRun: afterDisableSameRun.revision,
      afterDeleteSameRun: afterDeleteSameRun.revision,
      disabledNewRun: afterDisableNewRun,
      deletedNewRun: afterDeleteNewRun,
    },
    terminalEventCounts: { beforeDisable, beforeDelete },
    replay: {
      stateDigest: replayed.stateDigest,
      replayAgainDigest: replayedAgain.stateDigest,
      viewDigest: canonicalSha256(replayed.connections),
      duplicateAndReorderedParity: true,
    },
    staleRotation: {
      beforeTerminal: staleBeforeTerminal,
      afterDisable: staleAfterDisable,
      afterDelete: staleAfterDelete,
      eventCounts: {
        beforeStaleAttempt: staleBefore,
        afterStaleBefore: afterStaleBefore,
        beforeStaleAfterDisable: afterDisableCount,
        afterStaleAfterDisable: afterStaleDisable,
        beforeStaleAfterDelete: afterDeleteCount,
        afterStaleAfterDelete: afterStaleDelete,
      },
      noAppend: {
        beforeTerminal: afterStaleBefore === staleBefore,
        afterDisable: afterStaleDisable === afterDisableCount,
        afterDelete: afterStaleDelete === afterDeleteCount,
      },
    },
    collisionFreeCapture: {
      first: {
        connectionId: firstBinding.connectionId,
        runId: firstBinding.runId,
        revision: firstBinding.revision,
      },
      second: {
        connectionId: secondBinding.connectionId,
        runId: secondBinding.runId,
        revision: secondBinding.revision,
      },
      bindingDigestsDiffer:
        firstBinding.bindingDigest !== secondBinding.bindingDigest,
    },
  };
}

function authorizationFixture() {
  const store = makeStore();
  const connectionId = "connection-fifth-private";
  store.create({
    actor: admin,
    ...definition({ connectionId }),
    idempotencyKey: "create-fifth-private",
  });
  const agent = {
    ...scope,
    id: "agent-fifth",
    kind: "agent",
    role: "agent",
  };
  const agentStore = makeStore();
  agentStore.create({
    actor: admin,
    ...definition({
      connectionId: "connection-fifth-agent",
      owner: { kind: "agent", id: agent.id },
    }),
    idempotencyKey: "create-fifth-agent",
  });
  agentStore.create({
    actor: admin,
    ...definition({
      connectionId: "connection-fifth-user",
      owner: { kind: "user", id: member.id },
    }),
    idempotencyKey: "create-fifth-user",
  });
  const ownership = {
    workspaceMemberRead: store.authorization({ actor: member, connectionId })
      .allowed,
    workspaceMemberGrant: store.authorization({
      actor: member,
      connectionId,
      action: "grant",
    }).allowed,
    workspaceMemberDelete: store.authorization({
      actor: member,
      connectionId,
      action: "delete",
    }).allowed,
    agentOwnerGrant: agentStore.authorization({
      actor: agent,
      connectionId: "connection-fifth-agent",
      action: "grant",
    }).allowed,
    memberAgentGrant: agentStore.authorization({
      actor: member,
      connectionId: "connection-fifth-agent",
      action: "grant",
    }).allowed,
    userOwnerGrant: agentStore.authorization({
      actor: member,
      connectionId: "connection-fifth-user",
      action: "grant",
    }).allowed,
  };
  assert.deepEqual(ownership, {
    workspaceMemberRead: true,
    workspaceMemberGrant: true,
    workspaceMemberDelete: false,
    agentOwnerGrant: true,
    memberAgentGrant: false,
    userOwnerGrant: true,
  });

  const foreign = {
    ...admin,
    tenantId: "tenant-fifth-foreign",
    workspaceId: "workspace-fifth-foreign",
  };
  const operations = {
    read: () => store.read({ actor: foreign, connectionId }),
    grant: () =>
      store.captureForRun({
        actor: foreign,
        connectionId,
        runId: "run-fifth-foreign",
      }),
    rotate: () =>
      store.rotate({
        actor: foreign,
        connectionId,
        expectedRevision: 1,
        secretRef: secretRef(2),
        idempotencyKey: "rotate-fifth-foreign",
      }),
    disable: () =>
      store.disable({
        actor: foreign,
        connectionId,
        idempotencyKey: "disable-fifth-foreign",
      }),
    delete: () =>
      store.delete({
        actor: foreign,
        connectionId,
        idempotencyKey: "delete-fifth-foreign",
      }),
  };
  const beforeDigest = store.stateDigest();
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
        connectionId: "connection-fifth-unknown",
      };
      if (name === "grant") input.runId = "run-fifth-unknown";
      if (name === "rotate") {
        input.expectedRevision = 1;
        input.secretRef = secretRef(2);
        input.idempotencyKey = "rotate-fifth-unknown";
      }
      if (name === "disable" || name === "delete") {
        input.idempotencyKey = name + "-fifth-unknown";
      }
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
  assert.equal(store.stateDigest(), beforeDigest);
  return {
    ownership,
    foreignErrors,
    unknownErrors,
    foreignUnknownEqual: true,
    stateDigestUnchanged: true,
  };
}

async function publicSchemaFixture() {
  const ajvPath = path.join(
    root,
    "node_modules/.pnpm/ajv@6.15.0/node_modules/ajv/lib/ajv.js",
  );
  const { default: Ajv } = await import(pathToFileURL(ajvPath).href);
  const schema = JSON.parse(
    await readFile(
      path.join(
        root,
        "packages/connections/src/schemas/connection-events.v1.schema.json",
      ),
      "utf8",
    ),
  );
  schema.definitions = schema.$defs;
  delete schema.$defs;
  delete schema.$schema;
  rewriteRefs(schema);
  const validate = new Ajv({
    allErrors: true,
    schemaId: "auto",
    validateSchema: false,
  }).compile(schema);
  const base = {
    schemaVersion: 1,
    eventId: "event-fifth-schema",
    eventType: "connection.created",
    workspaceId: scope.workspaceId,
    actorId: admin.id,
    idempotencyKey: "event-fifth-schema-idempotency",
    sequence: 1,
    serverTimestamp: "2026-08-19T17:00:00.000Z",
    connectionId: "connection-fifth-schema",
    data: {
      ...definition({ connectionId: "connection-fifth-schema" }),
      revision: 1,
    },
  };
  const cases = {
    safe: base,
    identifierActorToken: { ...base, actorId: providerShape },
    identifierWorkspaceToken: { ...base, workspaceId: providerShape },
    opaqueEventToken: { ...base, eventId: providerShape },
    opaqueIdempotencyToken: { ...base, idempotencyKey: providerShape },
    opaqueConnectionToken: { ...base, connectionId: providerShape },
    labelToken: { ...base, data: { ...base.data, label: providerShape } },
    secretRefLabelToken: {
      ...base,
      data: {
        ...base.data,
        secretRef: { ...secretRef(1), label: providerShape },
      },
    },
    metadataNestedCaseVariant: {
      ...base,
      data: {
        ...base.data,
        metadata: {
          nested: {
            headers: { ["COO" + "KIE"]: "session" + "=raw" },
          },
        },
      },
    },
    metadataUpperUrl: {
      ...base,
      data: {
        ...base.data,
        metadata: {
          endpoint: "HTT" + "PS://user:" + "pass" + "word@example.invalid",
        },
      },
    },
    metadataUpperJson: {
      ...base,
      data: {
        ...base.data,
        metadata: {
          payload: '{"' + "TOKEN" + '":"' + "raw-" + 'value"}',
        },
      },
    },
    metadataRecursiveToken: {
      ...base,
      data: {
        ...base.data,
        metadata: { one: { two: { three: { four: providerShape } } } },
      },
    },
    metadataNeutralBase64: {
      ...base,
      data: {
        ...base.data,
        metadata: { encodedValue: neutralBase64 },
      },
    },
    terminalReasonToken: {
      ...base,
      eventType: "connection.deleted",
      data: { reason: providerShape },
    },
    terminalReasonNeutralBase64: {
      ...base,
      eventType: "connection.deleted",
      data: { reason: neutralBase64 },
    },
    extraTop: { ...base, extra: "unsupported" },
    extraData: { ...base, data: { ...base.data, extra: "unsupported" } },
    extraSecretRef: {
      ...base,
      data: {
        ...base.data,
        secretRef: { ...secretRef(1), extra: "unsupported" },
      },
    },
    extraOwner: {
      ...base,
      data: {
        ...base.data,
        owner: { ...base.data.owner, extra: "unsupported" },
      },
    },
  };
  const outcomes = {};
  for (const [name, value] of Object.entries(cases)) {
    const accepted = validate(value);
    outcomes[name] = { accepted };
  }
  for (const name of ["safe"])
    assert.equal(outcomes[name].accepted, true, name);
  for (const name of [
    "identifierActorToken",
    "identifierWorkspaceToken",
    "opaqueEventToken",
    "opaqueIdempotencyToken",
    "opaqueConnectionToken",
    "labelToken",
    "secretRefLabelToken",
    "metadataNestedCaseVariant",
    "metadataUpperUrl",
    "metadataUpperJson",
    "metadataRecursiveToken",
    "metadataNeutralBase64",
    "extraTop",
    "extraData",
    "extraSecretRef",
    "extraOwner",
  ])
    assert.equal(outcomes[name].accepted, false, name);
  assert.equal(outcomes.terminalReasonToken.accepted, true);
  assert.equal(outcomes.terminalReasonNeutralBase64.accepted, true);
  return {
    validator: "Ajv 6 compatibility adapter with $defs mapped to definitions",
    outcomes,
    finding: {
      terminalReasonTokenAccepted: outcomes.terminalReasonToken.accepted,
      terminalReasonNeutralBase64Accepted:
        outcomes.terminalReasonNeutralBase64.accepted,
    },
  };
}

async function verifierCanaryFixture() {
  const scan = JSON.parse(
    await readFile(path.join(evidenceDirectory, "canary-scan.json"), "utf8"),
  );
  assert.equal(scan.sensitivity.detected, true);
  assert.equal(scan.leaked, false);
  return {
    transientCanaryDetected: scan.sensitivity.detected,
    finalEvidenceClean: scan.leaked === false,
    filesChecked: scan.filesChecked,
  };
}

function definition(overrides = {}) {
  return {
    connectionId: "connection-fifth-default",
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    owner: { kind: "workspace", id: scope.workspaceId },
    provider: "github",
    integration: "issues",
    label: "Fifth critic connection",
    metadata: {},
    secretRef: secretRef(1),
    ...overrides,
  };
}

function secretRef(revision) {
  return {
    schemaVersion: 1,
    id: "secretref-fifth-" + String(revision).padStart(3, "0"),
    provider: "infisical",
    mount: "production",
    revision,
    label: "github",
  };
}

function makeStore() {
  let now = Date.parse("2026-08-19T17:00:00.000Z");
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
      rawReturned: JSON.stringify(value).includes(providerShape),
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

function rewriteRefs(value) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = rewriteRefs(value[index]);
    }
    return value;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      value[key] = rewriteRefs(nested);
    }
    return value;
  }
  return typeof value === "string"
    ? value.replaceAll("#/$defs/", "#/definitions/")
    : value;
}
