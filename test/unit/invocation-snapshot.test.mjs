import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  INVOCATION_SNAPSHOT_ERROR_CODES,
  agentConfigDigest,
  agentConfigRevisionId,
  canonicalInvocationSnapshot,
  checkInvocationSnapshotUse,
  createInvocationSnapshot,
  createProviderRegistry,
  encodeInvocationSnapshot,
  invocationSnapshotDigest,
  membershipIdFor,
  replayInvocationSnapshot,
} from "@stream-slack/protocol";

const CONFIG = JSON.parse(
  await readFile(
    ".eforest/tasks/epic-2-the-roster/E2-T01-versioned-agent-config-schema/fixtures/valid/agent-config.v1.json",
    "utf8",
  ),
);
const WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const AGENT_ID = `ag_${WORKSPACE_ID.slice(3)}_${"f".repeat(26)}`;
const PRINCIPAL_ID = `pr_${AGENT_ID.slice(3)}`;
const CHANNEL_ID = `ch_${WORKSPACE_ID.slice(3)}_${"1".repeat(26)}`;
const PROVIDER_CONFIGURATIONS = {
  harness: { protocol: "scripted-harness-v1" },
  sandbox: { protocol: "scripted-sandbox-v1" },
};
const BASE_SOURCE_HEADS = {
  config: {
    offset: "0000000000000030_aaaaaaaaaaaaaaaa",
    stateDigest: `sha256:${"1".repeat(64)}`,
    stream: `agent:${AGENT_ID}/config`,
  },
  directory: {
    offset: "0000000000000040_bbbbbbbbbbbbbbbb",
    stateDigest: `sha256:${"2".repeat(64)}`,
    stream: `workspace:${WORKSPACE_ID}/directory`,
  },
};

test("resolves a frozen canonical snapshot and replays its exact bytes", () => {
  const input = makeInput();
  const snapshot = createInvocationSnapshot(input);

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.kind, "invocation-snapshot");
  assert.equal(snapshot.agentId, AGENT_ID);
  assert.equal(snapshot.workspaceId, WORKSPACE_ID);
  assert.equal(
    snapshot.config.activeRevisionId,
    input.configState.activeRevisionId,
  );
  assert.equal(snapshot.config.revision, 1);
  assert.equal(snapshot.config.sourceOffset, BASE_SOURCE_HEADS.config.offset);
  assert.equal(snapshot.providers.harness.providerVersion, "1.0.0");
  assert.equal(snapshot.providers.sandbox.providerVersion, "1.0.0");
  assert.equal(snapshot.providers.compatibility.status, "compatible");
  assert.equal(snapshot.membership.principalId, PRINCIPAL_ID);
  assert.equal(snapshot.membership.status, "active");
  assert.equal(snapshot.context.scope, "current-channel");
  assert.equal(snapshot.context.channelId, CHANNEL_ID);
  assert.equal(snapshot.budget.limits.maxTotalTokens, 12000);
  assert.equal(snapshot.workspaceInputs.files.length, 2);
  assert.equal(snapshot.connectionGrants.refs.length, 2);
  assert.match(snapshot.snapshotDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(snapshot.snapshotDigest, invocationSnapshotDigest(snapshot));
  assert.equal(
    new TextDecoder().decode(encodeInvocationSnapshot(snapshot)),
    canonicalInvocationSnapshot(snapshot),
  );
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.config.agentConfig), true);
  assert.equal(Object.isFrozen(snapshot.connectionGrants.refs), true);

  const replay = replayInvocationSnapshot(snapshot);
  assert.deepEqual(replay, snapshot);
  assert.notEqual(replay, snapshot);
  assert.equal(replay.snapshotDigest, snapshot.snapshotDigest);
});

test("rejects a scratch snapshot with a deleted source digest", () => {
  const input = makeInput();
  const snapshot = createInvocationSnapshot(input);
  const tampered = structuredClone(snapshot);
  delete tampered.sourceManifest.config.stateDigest;

  assert.throws(
    () => replayInvocationSnapshot(tampered),
    (error) =>
      error.code === INVOCATION_SNAPSHOT_ERROR_CODES.SNAPSHOT_DIGEST_MISMATCH,
  );

  const decision = checkInvocationSnapshotUse({
    ...input,
    snapshot: tampered,
  });
  assert.equal(decision.allowed, false);
  assert.equal(
    decision.code,
    INVOCATION_SNAPSHOT_ERROR_CODES.SNAPSHOT_DIGEST_MISMATCH,
  );
});

test("keeps historical bytes stable while a later resolution gets a new digest", () => {
  const input = makeInput();
  const snapshot = createInvocationSnapshot(input);
  const historicalBytes = JSON.stringify(snapshot);

  const updatedConfig = structuredClone(input.config);
  updatedConfig.instructions.task =
    "A reconfigured task must not rewrite history.";
  const updated = createInvocationSnapshot(
    makeInput({
      config: updatedConfig,
      sourceHeads: {
        ...BASE_SOURCE_HEADS,
        config: {
          ...BASE_SOURCE_HEADS.config,
          offset: "0000000000000031_cccccccccccccccc",
          stateDigest: `sha256:${"3".repeat(64)}`,
        },
      },
    }),
  );

  assert.notEqual(updated.snapshotDigest, snapshot.snapshotDigest);
  assert.equal(JSON.stringify(snapshot), historicalBytes);
  assert.equal(
    replayInvocationSnapshot(snapshot).snapshotDigest,
    snapshot.snapshotDigest,
  );
});

test("refuses disabled, out-of-scope, unhealthy, incompatible, expired, and over-budget inputs", () => {
  const base = makeInput();
  const unhealthyRegistry = base.providerRegistry.updateStatus({
    selection: {
      kind: "harness",
      providerId: "scripted",
      providerVersion: "1.0.0",
    },
    health: "unhealthy",
  });
  const incompatibleRegistry = createProviderRegistry({
    descriptors: base.providerRegistry
      .list()
      .map((descriptor) =>
        descriptor.providerId === "scripted"
          ? { ...descriptor, compatibleWith: [] }
          : descriptor,
      ),
  });
  const cases = [
    [
      "disabled configuration",
      {
        configState: {
          ...base.configState,
          runnable: false,
          status: "disabled",
        },
      },
      INVOCATION_SNAPSHOT_ERROR_CODES.AGENT_CONFIG_INACTIVE,
    ],
    [
      "suspended membership",
      {
        workspaceMembership: {
          ...base.workspaceMembership,
          revision: 2,
          status: "suspended",
        },
      },
      INVOCATION_SNAPSHOT_ERROR_CODES.MEMBERSHIP_INACTIVE,
    ],
    [
      "non-member scope",
      {
        workspaceMembership: {
          ...base.workspaceMembership,
          principalId: `pr_${WORKSPACE_ID.slice(3)}_${"e".repeat(26)}`,
        },
      },
      INVOCATION_SNAPSHOT_ERROR_CODES.MEMBERSHIP_INACTIVE,
    ],
    [
      "unhealthy provider",
      { providerRegistry: unhealthyRegistry },
      INVOCATION_SNAPSHOT_ERROR_CODES.PROVIDER_RESOLUTION_REFUSED,
    ],
    [
      "incompatible providers",
      { providerRegistry: incompatibleRegistry },
      INVOCATION_SNAPSHOT_ERROR_CODES.PROVIDER_RESOLUTION_REFUSED,
    ],
    [
      "expired grant",
      {
        connectionGrants: base.connectionGrants.map((grant) => ({
          ...grant,
          expiresAt: base.now,
        })),
      },
      INVOCATION_SNAPSHOT_ERROR_CODES.CONNECTION_GRANT_EXPIRED,
    ],
    [
      "over-budget input",
      {
        budgetUsage: {
          costUsdCents: 0,
          elapsedSeconds: 0,
          inputTokens: 8001,
          outputTokens: 0,
          totalTokens: 8001,
        },
      },
      INVOCATION_SNAPSHOT_ERROR_CODES.BUDGET_EXCEEDED,
    ],
    [
      "cross-workspace grant",
      {
        connectionGrants: base.connectionGrants.map((grant) => ({
          ...grant,
          workspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbbbb",
        })),
      },
      INVOCATION_SNAPSHOT_ERROR_CODES.CONNECTION_GRANT_SCOPE_MISMATCH,
    ],
  ];

  for (const [name, overrides, code] of cases) {
    assert.throws(
      () => createInvocationSnapshot(makeInput(overrides)),
      (error) => {
        assert.equal(error.code, code, name);
        assert.equal(error.message.includes("Bearer"), false, name);
        return true;
      },
      name,
    );
  }
});

test("binds source scope and projects no provider token or grant secret", () => {
  const canary = "Bearer e2-t07-invocation-canary-123456789";
  const input = makeInput({
    connectionGrants: makeGrants().map((grant) => ({
      ...grant,
      resolverToken: canary,
      environment: { FORBIDDEN: canary },
    })),
  });
  const snapshot = createInvocationSnapshot(input);
  const bytes = JSON.stringify(snapshot);
  assert.equal(bytes.includes(canary), false);
  assert.equal(bytes.includes("resolverToken"), false);
  assert.equal(bytes.includes("environment"), false);

  assert.throws(
    () =>
      createInvocationSnapshot(
        makeInput({
          providerConfigurations: {
            harness: { protocol: "scripted-harness-v1", secret: canary },
            sandbox: PROVIDER_CONFIGURATIONS.sandbox,
          },
        }),
      ),
    (error) => {
      assert.equal(
        error.code,
        INVOCATION_SNAPSHOT_ERROR_CODES.PROVIDER_RESOLUTION_REFUSED,
      );
      assert.equal(error.message.includes(canary), false);
      return true;
    },
  );

  assert.throws(
    () =>
      createInvocationSnapshot(
        makeInput({
          sourceHeads: {
            ...BASE_SOURCE_HEADS,
            directory: {
              ...BASE_SOURCE_HEADS.directory,
              stream: "workspace:ws_bbbbbbbbbbbbbbbbbbbbbbbbbb/directory",
            },
          },
        }),
      ),
    (error) => error.code === INVOCATION_SNAPSHOT_ERROR_CODES.STALE_SOURCE,
  );
});

test("rejects non-provider authority before touching the provider registry", () => {
  const base = makeInput();
  const cases = [
    {
      connectionGrants: base.connectionGrants.map((grant) => ({
        ...grant,
        expiresAt: base.now,
      })),
    },
    {
      budgetUsage: {
        costUsdCents: 0,
        elapsedSeconds: 0,
        inputTokens: 8001,
        outputTokens: 0,
        totalTokens: 8001,
      },
    },
    {
      connectionGrants: base.connectionGrants.map((grant) => ({
        ...grant,
        workspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbbbb",
      })),
    },
  ];
  for (const overrides of cases) {
    const calls = { describe: 0, manifestDigest: 0, resolveConfiguration: 0 };
    const registry = {
      ...base.providerRegistry,
      describe(...args) {
        calls.describe += 1;
        return base.providerRegistry.describe(...args);
      },
      manifestDigest(...args) {
        calls.manifestDigest += 1;
        return base.providerRegistry.manifestDigest(...args);
      },
      resolveConfiguration(...args) {
        calls.resolveConfiguration += 1;
        return base.providerRegistry.resolveConfiguration(...args);
      },
    };
    assert.throws(
      () =>
        createInvocationSnapshot(
          makeInput({ ...overrides, providerRegistry: registry }),
        ),
      /INVOCATION_SNAPSHOT/u,
    );
    assert.deepEqual(calls, {
      describe: 0,
      manifestDigest: 0,
      resolveConfiguration: 0,
    });
  }
});

test("revalidates current authority after every referenced input is revoked", () => {
  const input = makeInput();
  const snapshot = createInvocationSnapshot(input);
  const revoked = makeInput({
    connectionGrants: input.connectionGrants.map((grant) => ({
      ...grant,
      revision: grant.revision + 1,
      status: "revoked",
    })),
  });
  const decision = checkInvocationSnapshotUse({
    ...revoked,
    snapshot,
  });

  assert.equal(decision.allowed, false);
  assert.equal(
    decision.code,
    INVOCATION_SNAPSHOT_ERROR_CODES.CONNECTION_GRANT_REVISION_MISMATCH,
  );
  assert.equal(
    replayInvocationSnapshot(snapshot).snapshotDigest,
    snapshot.snapshotDigest,
  );
});

function makeInput(overrides = {}) {
  const config = structuredClone(overrides.config ?? CONFIG);
  const now = overrides.now ?? 100;
  const sourceHeads = structuredClone(
    overrides.sourceHeads ?? BASE_SOURCE_HEADS,
  );
  const configDigest = agentConfigDigest(config);
  const revisionId = agentConfigRevisionId({
    agentId: AGENT_ID,
    configDigest,
    revision: 1,
  });
  const base = {
    agentId: AGENT_ID,
    budgetUsage: null,
    channelMembership: {
      channelId: CHANNEL_ID,
      principalId: PRINCIPAL_ID,
      revision: 4,
      status: "active",
    },
    config,
    configState: {
      activeConfig: config,
      activeRevisionId: revisionId,
      revisions: [
        {
          agentId: AGENT_ID,
          config,
          configDigest,
          revision: 1,
          revisionId,
          sourceOffset: sourceHeads.config.offset,
          workspaceId: WORKSPACE_ID,
        },
      ],
      runnable: true,
      status: "active",
    },
    connectionGrants: makeGrants(config, now),
    context: {
      channelId: CHANNEL_ID,
      scope: "current-channel",
      threadId: null,
    },
    now,
    principal: {
      kind: "agent",
      principalId: PRINCIPAL_ID,
      profileRevision: 2,
      status: "active",
    },
    providerConfigurations: structuredClone(PROVIDER_CONFIGURATIONS),
    providerRegistry: createProviderRegistry({ now: 0 }),
    sourceHeads,
    workspaceInputManifest: {
      files: [
        {
          bytes: 10,
          digest: `sha256:${"4".repeat(64)}`,
          path: "README.md",
        },
        {
          bytes: 20,
          digest: `sha256:${"5".repeat(64)}`,
          path: "docs/index.md",
        },
      ],
      maxBytes: config.workspaceInputs.maxBytes,
      paths: [...config.workspaceInputs.paths],
      source: config.workspaceInputs.source,
      sourceOffset: sourceHeads.directory.offset,
      sourceStream: sourceHeads.directory.stream,
      stateDigest: sourceHeads.directory.stateDigest,
    },
    workspaceMembership: {
      membershipId: membershipIdFor(WORKSPACE_ID, PRINCIPAL_ID),
      principalId: PRINCIPAL_ID,
      revision: 7,
      role: "agent",
      status: "active",
      workspaceId: WORKSPACE_ID,
    },
  };
  return { ...base, ...overrides };
}

function makeGrants(config = CONFIG, now = 100) {
  return config.connectionGrants.refs.map((ref, index) => ({
    ...ref,
    agentId: AGENT_ID,
    expiresAt: now + 400,
    sourceOffset: `00000000000000${50 + index}_cccccccccccccccc`,
    sourceStream: `connection:${ref.connectionId}/config`,
    stateDigest: `sha256:${String(6 + index).repeat(64)}`,
    status: "active",
    workspaceId: WORKSPACE_ID,
  }));
}
