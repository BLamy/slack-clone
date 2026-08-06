import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  AGENT_AVAILABILITY_REASON_CODES,
  createProviderRegistry as createReadinessRegistry,
  membershipIdFor,
  providerKey as readinessProviderKey,
} from "@stream-slack/protocol";
import { createChannelAuthorization } from "../src/ledger/channel-auth.mjs";
import { establishWorkspaceContext } from "../src/ledger/workspace-auth.mjs";
import { validateAndReplayDump } from "../src/ledger/replay.mjs";

const rosterModule = process.env.E2_T06_ROSTER_MODULE
  ? await import(
      pathToFileURL(path.resolve(process.env.E2_T06_ROSTER_MODULE)).href
    )
  : await import("@stream-slack/protocol");
const {
  AGENT_PRESENCE_DEFAULT_TTL_MS,
  AGENT_PRESENCE_MAX_TTL_MS,
  agentRosterDigest,
  buildAgentRoster,
  createTransientPresence,
  deriveAgentAvailability,
} = rosterModule;

const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-2-the-roster/E2-T06-agent-membership-and-presence",
);
const runId = String(
  process.env.TEST_RUN_ID ?? `verify-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/gu, "-");
const artifactRoot = path.resolve(
  root,
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e2-t06", runId),
);
const evidenceDirectory =
  process.env.PROMOTE_EVIDENCE === "1"
    ? path.join(taskDirectory, "evidence/e2-t06-final")
    : artifactRoot;
const implementationCommit = String(
  process.env.E2_T06_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();

const WORKSPACE_A = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const WORKSPACE_B = "ws_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADA = principal(WORKSPACE_A, "b", "human", null, "ada");
const LINUS = principal(WORKSPACE_A, "c", "human", null, "linus");
const SERVICE = principal(WORKSPACE_A, "d", "service", null, "audit-bot");
const AGENT_ID = `ag_${WORKSPACE_A.slice(3)}_${"f".repeat(26)}`;
const AGENT_PRINCIPAL_ID = `pr_${AGENT_ID.slice(3)}`;
const SIBLING_AGENT_ID = `ag_${WORKSPACE_B.slice(3)}_${"f".repeat(26)}`;
const UNKNOWN_AGENT_ID = `ag_${WORKSPACE_A.slice(3)}_${"z".repeat(26)}`;
const GENERAL_CHANNEL_ID = `ch_${WORKSPACE_A.slice(3)}_${"1".repeat(26)}`;
const PRIVATE_CHANNEL_ID = `ch_${WORKSPACE_A.slice(3)}_${"2".repeat(26)}`;
const CONFIG_PATH = path.join(
  root,
  ".eforest/tasks/epic-2-the-roster/E2-T01-versioned-agent-config-schema/fixtures/valid/agent-config.v1.json",
);
const CANARY = "Bearer e2-t06-presence-canary-123456789";

await main();

async function main() {
  await mkdir(evidenceDirectory, { recursive: true });
  if (process.env.PROMOTE_EVIDENCE === "1") {
    const trackedChanges = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      { cwd: root, encoding: "utf8" },
    ).trim();
    assert.equal(
      trackedChanges,
      "",
      "promoted E2-T06 evidence must start from a clean tracked implementation tree",
    );
  }

  const result = await verifyWorkflow();
  const sensitivity =
    process.env.E2_T06_SENSITIVITY_CHILD === "1"
      ? {
          mutationCount: 0,
          mutations: [],
          result: "CHILD",
          verifierDetectedMutant: true,
        }
      : await runSensitivity();
  const gates = runGates();
  assert.equal(result.result, "PASS");
  assert.equal(sensitivity.verifierDetectedMutant, true);

  const summary = {
    schemaVersion: 1,
    task: "E2-T06",
    runId,
    implementationCommit,
    result: "PASS",
    replayDescription:
      "Replay: N/A (server roster and presence projection) + mitigation: membership/readiness matrix, stale-heartbeat tests, manifests, and durable-state replay",
    skips:
      process.env.E2_T06_SKIP_GATES === "1"
        ? ["format", "lint", "typecheck", "test", "build"]
        : [],
    gates,
    replay: result.replay,
    roster: result.roster,
    membership: result.membership,
    readiness: result.readiness,
    transitions: result.transitions,
    sensitivity,
  };
  await writeJson("verification-summary.json", summary);
  await writeJson("roster-manifest.json", result.roster);
  await writeJson("membership-matrix.json", result.membership);
  await writeJson("readiness-inputs.json", result.readiness);
  await writeJson("durable-replay.json", result.replay);
  await writeJson("transition-matrix.json", result.transitions);
  await writeJson("sensitivity.json", sensitivity);
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        task: "E2-T06",
        implementationCommit,
        recordCount: result.replay.recordCount,
        rosterDigest: result.roster.rosterDigest,
        transitions: result.transitions.rows.length,
        sensitivity: sensitivity.verifierDetectedMutant,
        skips: summary.skips,
      },
      null,
      2,
    ),
  );
}

async function verifyWorkflow() {
  const { dump, replay } = await buildDurableFixture();
  const state = replay.finalState;
  const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  const configState = {
    activeConfig: config,
    activeRevisionId:
      "acr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    runnable: true,
    status: "active",
  };
  const registry = createReadinessRegistry({ now: 0 });
  const configs = { [AGENT_ID]: configState };
  const roster = buildAgentRoster({
    activeRuns: [],
    configs,
    now: 100,
    providerRegistry: registry,
    state,
    workspaceId: WORKSPACE_A,
  });
  const agentEntry = roster.directory.find(
    ({ principalId }) => principalId === AGENT_PRINCIPAL_ID,
  );
  const serviceEntry = roster.directory.find(
    ({ principalId }) => principalId === SERVICE.principalId,
  );
  assert.equal(agentEntry.kind, "agent");
  assert.equal(agentEntry.availability, "available");
  assert.equal(agentEntry.runnable, true);
  assert.equal(serviceEntry.kind, "service");
  assert.equal(serviceEntry.chatMember, false);
  const general = roster.channels.find(
    ({ channelId }) => channelId === GENERAL_CHANNEL_ID,
  );
  assert.deepEqual(
    general.members.map(({ kind }) => kind),
    ["human", "agent"],
  );
  assert.equal(
    general.members.some(
      ({ principalId }) => principalId === SERVICE.principalId,
    ),
    false,
  );
  const duplicatePrincipal = principal(
    WORKSPACE_A,
    "g",
    "human",
    null,
    "linus",
  );
  assert.throws(
    () =>
      buildAgentRoster({
        configs,
        now: 100,
        providerRegistry: registry,
        state: {
          ...state,
          entities: {
            ...state.entities,
            principals: {
              ...state.entities.principals,
              [duplicatePrincipal.principalId]: duplicatePrincipal,
            },
          },
        },
        workspaceId: WORKSPACE_A,
      }),
    (error) => error.code === "AGENT_ROSTER_DUPLICATE_HANDLE",
  );

  const matrix = await verifyMembershipContracts(state, dump.records);
  const readiness = readinessManifest(registry, config);
  const transitions = verifyAvailabilityTransitions({
    agent: state.entities.principals[AGENT_PRINCIPAL_ID],
    config,
    configState,
    registry,
    workspaceMembership:
      state.entities.memberships[
        membershipIdFor(WORKSPACE_A, AGENT_PRINCIPAL_ID)
      ],
  });
  const replayEvidence = {
    authority: "workspace:<id>/directory",
    finalStateDigest: replay.finalStateDigest,
    offsets: replay.prefixes.map(({ offset, stateDigest }) => ({
      offset,
      stateDigest,
    })),
    recordCount: dump.records.length,
    stream: `workspace:${WORKSPACE_A}/directory`,
  };
  const rosterEvidence = {
    agentCount: roster.directory.filter(({ kind }) => kind === "agent").length,
    channelCount: roster.channels.length,
    directoryKinds: roster.directory.map(({ kind }) => kind),
    rosterDigest: agentRosterDigest(roster),
    serviceChatMember: serviceEntry.chatMember,
    streamStateDigest: replay.finalStateDigest,
    workspaceId: WORKSPACE_A,
  };
  return {
    result: "PASS",
    membership: matrix,
    readiness,
    replay: replayEvidence,
    roster: rosterEvidence,
    transitions,
  };
}

async function buildDurableFixture() {
  const fixturePath = path.join(
    root,
    ".eforest/tasks/epic-1-the-workspace/E1-T03-channel-lifecycle-and-membership/fixtures/valid/channel-lifecycle.v1.json",
  );
  const base = JSON.parse(await readFile(fixturePath, "utf8"));
  const records = structuredClone(base.records);
  records.push(
    record(30, ADA, "principal.created", {
      kind: "agent",
      ownedBy: LINUS.principalId,
      principalId: AGENT_PRINCIPAL_ID,
      profile: {
        displayName: "Workspace Helper",
        email: "",
        handle: "workspace-helper",
      },
      subjectBinding: {
        audience: "stream-slack",
        issuer: "stream-slack-agent",
        subject: `agent:${AGENT_ID}`,
      },
    }),
  );
  records.push(
    record(31, ADA, "workspace.membership.invited", {
      expectedWorkspaceRevision: 5,
      inviteId: `iv_${WORKSPACE_A.slice(3)}_${"7".repeat(26)}`,
      principalId: AGENT_PRINCIPAL_ID,
      role: "agent",
    }),
  );
  records.push(
    record(32, AGENT_PRINCIPAL_ID, "workspace.membership.accepted", {
      expectedWorkspaceRevision: 6,
      inviteId: `iv_${WORKSPACE_A.slice(3)}_${"7".repeat(26)}`,
      principalId: AGENT_PRINCIPAL_ID,
    }),
  );
  records.push(
    record(33, ADA, "channel.membership.invited", {
      channelId: GENERAL_CHANNEL_ID,
      expectedChannelRevision: 4,
      inviteId: `iv_${WORKSPACE_A.slice(3)}_${"8".repeat(26)}`,
      principalId: AGENT_PRINCIPAL_ID,
    }),
  );
  records.push(
    record(34, AGENT_PRINCIPAL_ID, "channel.membership.joined", {
      channelId: GENERAL_CHANNEL_ID,
      expectedChannelRevision: 5,
      inviteId: `iv_${WORKSPACE_A.slice(3)}_${"8".repeat(26)}`,
      principalId: AGENT_PRINCIPAL_ID,
    }),
  );
  const dump = { records };
  const replay = validateAndReplayDump(dump);
  return { dump, replay };
}

async function verifyMembershipContracts(state, records) {
  const eventTypes = new Set(records.map(({ event }) => event.eventType));
  for (const eventType of [
    "workspace.membership.invited",
    "workspace.membership.accepted",
    "channel.membership.invited",
    "channel.membership.joined",
  ]) {
    assert.equal(
      eventTypes.has(eventType),
      true,
      `${eventType} is shared by the fixture`,
    );
  }
  const agentMembership =
    state.entities.memberships[
      membershipIdFor(WORKSPACE_A, AGENT_PRINCIPAL_ID)
    ];
  const agentChannelMembership =
    state.entities.channelMemberships[
      `${GENERAL_CHANNEL_ID}\u0000${AGENT_PRINCIPAL_ID}`
    ];
  assert.equal(agentMembership.role, "agent");
  assert.equal(agentMembership.status, "active");
  assert.equal(agentChannelMembership.status, "active");

  const authorization = createChannelAuthorization({
    lookupChannel: async (_workspaceId, channelId) =>
      state.entities.channels[channelId] ?? null,
    lookupChannelInvite: async (_workspaceId, _channelId, inviteId) =>
      state.entities.channelInvites[inviteId] ?? null,
    lookupChannelMembership: async (_workspaceId, channelId, principalId) =>
      state.entities.channelMemberships[`${channelId}\u0000${principalId}`] ??
      null,
    lookupWorkspaceMembership: async (_workspaceId, principalId) =>
      state.entities.memberships[membershipIdFor(WORKSPACE_A, principalId)] ??
      null,
    withChannelFence: async (_context, operation) => operation(),
  });
  const linusContext = establishWorkspaceContext({
    authenticatedPrincipalId: LINUS.principalId,
    trustedWorkspaceId: WORKSPACE_A,
  });
  await assert.rejects(
    authorization.authorizeDispatch(
      { principalId: AGENT_PRINCIPAL_ID },
      linusContext,
      {
        channelId: GENERAL_CHANNEL_ID,
        capability: "channel.membership.invite",
        dispatch: async () =>
          assert.fail("agent owner gained channel authority"),
      },
    ),
    (error) => error.code === "CHANNEL_ACCESS_DENIED",
  );
  await assert.rejects(
    authorization.authorizeDispatch(
      { principalId: AGENT_PRINCIPAL_ID },
      linusContext,
      {
        channelId: PRIVATE_CHANNEL_ID,
        capability: "channel.membership.join",
        dispatch: async () => assert.fail("agent owner moved an agent"),
      },
    ),
    (error) => error.code === "CHANNEL_ACCESS_DENIED",
  );

  assert.throws(
    () =>
      validateAndReplayDump({
        records: [
          ...records,
          record(35, SERVICE.principalId, "channel.membership.joined", {
            channelId: GENERAL_CHANNEL_ID,
            expectedChannelRevision: 6,
            principalId: SERVICE.principalId,
          }),
        ],
      }),
    (error) => error.code === "REDUCER_CHANNEL_PARTICIPANT_SERVICE",
  );
  assert.throws(
    () =>
      validateAndReplayDump({
        records: [
          ...records,
          record(36, LINUS.principalId, "channel.membership.joined", {
            channelId: PRIVATE_CHANNEL_ID,
            expectedChannelRevision:
              state.entities.channels[PRIVATE_CHANNEL_ID].revision,
            principalId: AGENT_PRINCIPAL_ID,
          }),
        ],
      }),
    (error) => error.code === "REDUCER_CHANNEL_SCOPE_MISMATCH",
  );
  assert.throws(
    () =>
      validateAndReplayDump({
        records: [
          ...records,
          record(37, ADA, "principal.created", {
            kind: "human",
            ownedBy: null,
            principalId: `pr_${WORKSPACE_A.slice(3)}_${"g".repeat(26)}`,
            profile: {
              displayName: "Duplicate Linus",
              email: "duplicate@example.test",
              handle: "linus",
            },
            subjectBinding: {
              audience: "stream-slack",
              issuer: "auth0",
              subject: "duplicate-linus",
            },
          }),
        ],
      }),
    (error) => error.code === "REDUCER_PRINCIPAL_DUPLICATE_HANDLE",
  );

  return {
    agent: {
      channelMembership: agentChannelMembership.status,
      kind: "agent",
      workspaceMembership: agentMembership.status,
    },
    human: {
      channelMembershipContract:
        "same channel.membership.invited/joined events",
      kind: "human",
      workspaceMembershipContract:
        "same workspace.membership.invited/accepted events",
    },
    ownerCapabilityRefused: true,
    rows: [
      { kind: "human", directory: true, channelMembership: true },
      { kind: "agent", directory: true, channelMembership: true },
      { kind: "service", directory: true, channelMembership: false },
    ],
    serviceExcluded: true,
    sharedEventTypes: [
      "workspace.membership.invited",
      "workspace.membership.accepted",
      "channel.membership.invited",
      "channel.membership.joined",
    ],
  };
}

function readinessManifest(registry, config) {
  const providers = ["harness", "sandbox"].map((kind) => {
    const selection = config[kind];
    const coordinates = {
      kind,
      providerId: selection.providerId,
      providerVersion: selection.providerVersion,
    };
    return {
      ...coordinates,
      providerKey: readinessProviderKey(coordinates),
      status: registry.status(coordinates),
    };
  });
  assert.equal(
    providers.every(({ status }) => status.available),
    true,
  );
  return {
    providerCount: providers.length,
    providers,
    registryManifestDigest: registry.manifestDigest(),
  };
}

function verifyAvailabilityTransitions({
  agent,
  config,
  configState,
  registry,
  workspaceMembership,
}) {
  const busy = createTransientPresence({
    agentId: AGENT_ID,
    observedAt: 100,
    state: "busy",
    ttlMs: AGENT_PRESENCE_DEFAULT_TTL_MS,
    workspaceId: WORKSPACE_A,
  });
  const sibling = createTransientPresence({
    agentId: SIBLING_AGENT_ID,
    observedAt: 100,
    state: "busy",
    ttlMs: AGENT_PRESENCE_DEFAULT_TTL_MS,
    workspaceId: WORKSPACE_B,
  });
  const stale = createTransientPresence({
    agentId: AGENT_ID,
    observedAt: 100,
    state: "busy",
    ttlMs: 10,
    workspaceId: WORKSPACE_A,
  });
  const rows = [];
  const observe = (
    name,
    value,
    expectedAvailability,
    expectedReason = null,
  ) => {
    assert.equal(value.availability, expectedAvailability, name);
    if (expectedReason) {
      assert.equal(
        value.availabilityReasons.some(({ code }) => code === expectedReason),
        true,
        `${name} must cite ${expectedReason}`,
      );
    }
    rows.push({
      availability: value.availability,
      name,
      reasonCodes: value.availabilityReasons.map(({ code }) => code),
      runnable: value.runnable,
    });
  };

  observe(
    "active prerequisites",
    deriveAgentAvailability({
      agent,
      agentId: AGENT_ID,
      configState,
      now: 100,
      principal: agent,
      providerRegistry: registry,
      workspaceMembership,
    }),
    "available",
  );
  const busyState = deriveAgentAvailability({
    agentId: AGENT_ID,
    configState,
    now: 105,
    principal: agent,
    providerRegistry: registry,
    transientPresence: busy,
    workspaceMembership,
  });
  observe("fresh busy presence", busyState, "busy");
  assert.equal(busyState.runnable, true);
  observe(
    "stale heartbeat",
    deriveAgentAvailability({
      agentId: AGENT_ID,
      configState,
      now: 111,
      principal: agent,
      providerRegistry: registry,
      transientPresence: stale,
      workspaceMembership,
    }),
    "available",
  );
  const siblingState = deriveAgentAvailability({
    agentId: AGENT_ID,
    configState,
    now: 105,
    principal: agent,
    providerRegistry: registry,
    transientPresence: sibling,
    workspaceMembership,
  });
  observe("sibling workspace heartbeat", siblingState, "available");
  assert.equal(siblingState.presence.accepted, false);
  observe(
    "suspended membership",
    deriveAgentAvailability({
      agentId: AGENT_ID,
      configState,
      now: 105,
      principal: agent,
      providerRegistry: registry,
      transientPresence: busy,
      workspaceMembership: {
        ...workspaceMembership,
        status: "suspended",
        revision: 2,
      },
    }),
    "unavailable",
    AGENT_AVAILABILITY_REASON_CODES.WORKSPACE_MEMBERSHIP_INACTIVE,
  );
  observe(
    "removed membership",
    deriveAgentAvailability({
      agentId: AGENT_ID,
      configState,
      now: 105,
      principal: agent,
      providerRegistry: registry,
      transientPresence: busy,
      workspaceMembership: {
        ...workspaceMembership,
        status: "removed",
        revision: 2,
      },
    }),
    "unavailable",
    AGENT_AVAILABILITY_REASON_CODES.WORKSPACE_MEMBERSHIP_INACTIVE,
  );
  observe(
    "disabled configuration",
    deriveAgentAvailability({
      agentId: AGENT_ID,
      configState: { ...configState, runnable: false, status: "disabled" },
      now: 105,
      principal: agent,
      providerRegistry: registry,
      transientPresence: busy,
      workspaceMembership,
    }),
    "disabled",
    AGENT_AVAILABILITY_REASON_CODES.CONFIG_DISABLED,
  );
  observe(
    "invalid configuration",
    deriveAgentAvailability({
      agentId: AGENT_ID,
      configState: {
        ...configState,
        activeConfig: {
          ...config,
          harness: { ...config.harness, requiredCapabilities: ["missing"] },
        },
      },
      now: 105,
      principal: agent,
      providerRegistry: registry,
      transientPresence: busy,
      workspaceMembership,
    }),
    "unavailable",
    AGENT_AVAILABILITY_REASON_CODES.CONFIG_INVALID,
  );
  const unhealthyRegistry = registry.updateStatus({
    selection: {
      kind: "harness",
      providerId: "scripted",
      providerVersion: "1.0.0",
    },
    health: "unhealthy",
  });
  observe(
    "provider health loss",
    deriveAgentAvailability({
      agentId: AGENT_ID,
      configState,
      now: 105,
      principal: agent,
      providerRegistry: unhealthyRegistry,
      transientPresence: busy,
      workspaceMembership,
    }),
    "unavailable",
    AGENT_AVAILABILITY_REASON_CODES.PROVIDER_UNHEALTHY,
  );
  const staleRegistry = registry.updateStatus({
    selection: {
      kind: "sandbox",
      providerId: "scripted",
      providerVersion: "1.0.0",
    },
    expiresAt: 50,
  });
  observe(
    "provider readiness expiry",
    deriveAgentAvailability({
      agentId: AGENT_ID,
      configState,
      now: 105,
      principal: agent,
      providerRegistry: staleRegistry,
      transientPresence: busy,
      workspaceMembership,
    }),
    "unavailable",
    AGENT_AVAILABILITY_REASON_CODES.PROVIDER_STALE,
  );
  const disabledHeartbeat = deriveAgentAvailability({
    agentId: AGENT_ID,
    configState: { ...configState, runnable: false, status: "disabled" },
    now: 105,
    principal: { ...agent, status: "suspended" },
    providerRegistry: registry,
    transientPresence: busy,
    workspaceMembership,
  });
  assert.equal(disabledHeartbeat.availability, "disabled");
  assert.equal(disabledHeartbeat.busySource, null);
  const unknown = deriveAgentAvailability({
    agentId: UNKNOWN_AGENT_ID,
    now: 105,
    principal: null,
    providerRegistry: registry,
    transientPresence: createTransientPresence({
      agentId: UNKNOWN_AGENT_ID,
      observedAt: 100,
      state: "busy",
      ttlMs: 10,
      workspaceId: WORKSPACE_A,
    }),
    workspaceMembership: null,
  });
  assert.equal(unknown.availability, "disabled");
  assert.equal(unknown.runnable, false);
  rows.push({
    availability: unknown.availability,
    name: "unknown agent heartbeat",
    reasonCodes: unknown.availabilityReasons.map(({ code }) => code),
    runnable: unknown.runnable,
  });
  assert.equal(
    unknown.availabilityReasons.some(
      ({ code }) =>
        code === AGENT_AVAILABILITY_REASON_CODES.PRINCIPAL_NOT_FOUND,
    ),
    true,
  );
  return {
    maxPresenceTtlMs: AGENT_PRESENCE_MAX_TTL_MS,
    rows,
    result: "PASS",
    staleHeartbeatDoesNotGrant: true,
  };
}

async function runSensitivity() {
  const sourceDirectory = path.join(root, "packages/protocol/src");
  await mkdir(path.join(taskDirectory, "work"), { recursive: true });
  const mutations = [
    {
      name: "remove immutable principal-kind labeling",
      needle: "kind: principal.kind,",
      replacement: 'kind: "human",',
    },
    {
      name: "remove provider-stale prerequisite",
      needle: "} else if (provider.stale) {",
      replacement: "} else if (false && provider.stale) {",
    },
    {
      name: "remove durable handle uniqueness",
      needle: `  validateUniquePrincipalHandles(principalRecords, {
    expectedWorkspaceId: normalizedWorkspaceId,
  });`,
      replacement: "  // handle uniqueness mutant",
    },
  ];
  const results = [];
  for (const mutation of mutations) {
    const sensitivityRoot = await mkdtemp(
      path.join(taskDirectory, "work/sensitivity-"),
    );
    try {
      const files = await readdir(sourceDirectory);
      for (const filename of files) {
        if (filename.endsWith(".mjs")) {
          await copyFile(
            path.join(sourceDirectory, filename),
            path.join(sensitivityRoot, filename),
          );
        }
      }
      const source = await readFile(
        path.join(sourceDirectory, "agent-roster.mjs"),
        "utf8",
      );
      assert.equal(source.split(mutation.needle).length - 1, 1, mutation.name);
      await writeFile(
        path.join(sensitivityRoot, "agent-roster.mjs"),
        source.replace(mutation.needle, mutation.replacement),
      );
      const childEnv = {
        ...process.env,
        E2_T06_ROSTER_MODULE: path.join(sensitivityRoot, "agent-roster.mjs"),
        E2_T06_SENSITIVITY_CHILD: "1",
        E2_T06_SKIP_GATES: "1",
        PROMOTE_EVIDENCE: "0",
        TEST_ARTIFACT_DIR: path.join(sensitivityRoot, "artifacts"),
        TEST_RUN_ID: `${runId}-${mutation.name.replace(/[^a-z0-9]+/giu, "-")}`,
      };
      const child = spawnSync(
        process.execPath,
        [path.join(root, "scripts/verify-e2-t06.mjs")],
        { cwd: root, encoding: "utf8", env: childEnv },
      );
      assert.notEqual(
        child.status,
        0,
        `${mutation.name} must make the real verifier go red`,
      );
      assert.doesNotMatch(child.stdout, new RegExp(CANARY, "u"));
      assert.doesNotMatch(child.stderr, new RegExp(CANARY, "u"));
      results.push({
        exitCode: child.status,
        mutation: mutation.name,
        result: "PASS",
        verifier: "scripts/verify-e2-t06.mjs",
        verifierDetectedMutant: true,
      });
    } finally {
      await rm(sensitivityRoot, { recursive: true, force: true });
    }
  }
  return {
    mutationCount: results.length,
    mutations: results,
    result: "PASS",
    verifierDetectedMutant: results.every(
      ({ verifierDetectedMutant }) => verifierDetectedMutant,
    ),
  };
}

function runGates() {
  if (process.env.E2_T06_SKIP_GATES === "1") return {};
  const commands = ["format:check", "lint", "typecheck", "test", "build"];
  const results = {};
  for (const command of commands) {
    const child = spawnSync("pnpm", [command], {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    });
    results[command] = {
      command: `pnpm ${command}`,
      exitCode: child.status,
    };
    if (child.status !== 0) {
      throw new Error(
        `pnpm ${command} failed:\n${child.stdout}\n${child.stderr}`,
      );
    }
  }
  return results;
}

function record(number, actor, eventType, data) {
  const token = number.toString().padStart(26, "0");
  return {
    offset: offset(number),
    event: {
      actorId: typeof actor === "string" ? actor : actor.principalId,
      causation: null,
      correlationId: `cr_${token}`,
      data,
      eventId: `ev_${token}`,
      eventType,
      idempotencyKey: `ik_${token}`,
      schemaVersion: 1,
      serverTimestamp: `2026-08-06T00:00:${String(number).padStart(2, "0")}.000Z`,
      workspaceId: WORKSPACE_A,
    },
  };
}

function offset(number) {
  return `0000000000000000_${number.toString().padStart(16, "0")}`;
}

function principal(workspaceId, suffix, kind, ownedBy, handle) {
  const principalId = `pr_${workspaceId.slice(3)}_${suffix.repeat(26)}`;
  return {
    kind,
    ownedBy,
    principalId,
    profile: {
      displayName: handle,
      email: kind === "service" ? "" : `${handle}@example.test`,
      handle,
    },
    profileRevision: 1,
    status: "active",
    subjectBinding: {
      audience: "stream-slack",
      issuer: kind === "agent" ? "stream-slack-agent" : "auth0",
      subject: `${kind}:${principalId}`,
    },
  };
}

async function writeJson(filename, value) {
  await writeFile(
    path.join(evidenceDirectory, filename),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}
