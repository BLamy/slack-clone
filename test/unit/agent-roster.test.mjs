import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_AVAILABILITY_REASON_CODES,
  AGENT_ROSTER_ERROR_CODES,
  AGENT_PRESENCE_MAX_TTL_MS,
  agentRosterDigest,
  buildAgentRoster,
  clearTransientPresence,
  createProviderRegistry,
  createTransientPresence,
  deriveAgentAvailability,
  mergeTransientPresence,
  membershipIdFor,
  validateUniquePrincipalHandles,
} from "@stream-slack/protocol";

const WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER_ID = `pr_${WORKSPACE_ID.slice(3)}_${"b".repeat(26)}`;
const AGENT_ID = `ag_${WORKSPACE_ID.slice(3)}_${"c".repeat(26)}`;
const AGENT_PRINCIPAL_ID = `pr_${AGENT_ID.slice(3)}`;
const SERVICE_ID = `pr_${WORKSPACE_ID.slice(3)}_${"d".repeat(26)}`;
const CHANNEL_ID = `ch_${WORKSPACE_ID.slice(3)}_${"e".repeat(26)}`;
const CONFIG = {
  schemaVersion: 1,
  instructions: { system: "system", task: "task", guardrails: [] },
  context: {
    scope: "current-channel",
    includePrivate: false,
    includeThreadHistory: false,
    maxMessages: 10,
    maxBytes: 1024,
  },
  trigger: {
    events: ["manual"],
    requireMention: false,
    allowMessageEdits: false,
  },
  delegation: {
    enabled: false,
    maxDepth: 0,
    maxChildren: 0,
    allowCrossChannel: false,
  },
  concurrency: {
    maxConcurrentRuns: 2,
    maxConcurrentPerChannel: 1,
    queueStrategy: "serialize",
  },
  budgets: {
    timeoutSeconds: 60,
    maxInputTokens: 100,
    maxOutputTokens: 100,
    maxTotalTokens: 200,
    maxCostUsdCents: 10,
  },
  harness: {
    providerId: "scripted",
    providerVersion: "1.0.0",
    requiredCapabilities: ["structured-output"],
  },
  sandbox: {
    providerId: "scripted",
    providerVersion: "1.0.0",
    requiredCapabilities: ["ephemeral"],
    lifecycle: "ephemeral",
    networkPolicy: "deny-all",
  },
  workspaceInputs: { source: "none", paths: [], maxBytes: 0 },
  connectionGrants: { refs: [], maxCallsPerRun: 0 },
};

const OWNER = principal(OWNER_ID, "human", null, "owner");
const AGENT = principal(AGENT_PRINCIPAL_ID, "agent", OWNER_ID, "helper");
const SERVICE = principal(SERVICE_ID, "service", null, "service");
const AGENT_MEMBERSHIP = membership(AGENT_PRINCIPAL_ID, "agent", "active");
const OWNER_MEMBERSHIP = membership(OWNER_ID, "owner", "active");
const SERVICE_MEMBERSHIP = membership(SERVICE_ID, "service", "active");
const CONFIG_STATE = {
  activeConfig: CONFIG,
  activeRevisionId:
    "acr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  runnable: true,
  status: "active",
};

test("availability is derived from durable prerequisites and transient busy is display-only", () => {
  const registry = createProviderRegistry({ now: 0 });
  const base = deriveAgentAvailability({
    agentId: AGENT_ID,
    configState: CONFIG_STATE,
    now: 100,
    principal: AGENT,
    providerRegistry: registry,
    workspaceMembership: AGENT_MEMBERSHIP,
  });
  assert.equal(base.availability, "available");
  assert.equal(base.runnable, true);

  const busyPresence = createTransientPresence({
    agentId: AGENT_ID,
    observedAt: 100,
    state: "busy",
    ttlMs: 100,
    workspaceId: WORKSPACE_ID,
  });
  const busy = deriveAgentAvailability({
    agentId: AGENT_ID,
    configState: CONFIG_STATE,
    now: 150,
    principal: AGENT,
    providerRegistry: registry,
    transientPresence: busyPresence,
    workspaceMembership: AGENT_MEMBERSHIP,
  });
  assert.equal(busy.availability, "busy");
  assert.equal(busy.runnable, true);
  assert.equal(busy.presence.durable, false);

  const unhealthyRegistry = registry.updateStatus({
    selection: {
      kind: "harness",
      providerId: "scripted",
      providerVersion: "1.0.0",
    },
    health: "unhealthy",
  });
  const blocked = deriveAgentAvailability({
    agentId: AGENT_ID,
    configState: CONFIG_STATE,
    now: 150,
    principal: AGENT,
    providerRegistry: unhealthyRegistry,
    transientPresence: busyPresence,
    workspaceMembership: AGENT_MEMBERSHIP,
  });
  assert.equal(blocked.availability, "unavailable");
  assert.equal(blocked.runnable, false);
  assert.equal(
    blocked.availabilityReasons.some(
      ({ code }) => code === AGENT_AVAILABILITY_REASON_CODES.PROVIDER_UNHEALTHY,
    ),
    true,
  );
  assert.equal(blocked.busySource, null);

  const disabled = deriveAgentAvailability({
    agentId: AGENT_ID,
    configState: { ...CONFIG_STATE, status: "disabled", runnable: false },
    now: 150,
    principal: AGENT,
    providerRegistry: registry,
    transientPresence: busyPresence,
    workspaceMembership: AGENT_MEMBERSHIP,
  });
  assert.equal(disabled.availability, "disabled");
  assert.equal(disabled.runnable, false);
  assert.equal(
    disabled.availabilityReasons.some(
      ({ code }) => code === AGENT_AVAILABILITY_REASON_CODES.CONFIG_DISABLED,
    ),
    true,
  );
});

test("roster preserves principal kinds, excludes services from chat members, and rejects duplicate handles", () => {
  const state = {
    entities: {
      principals: {
        [OWNER_ID]: OWNER,
        [AGENT_PRINCIPAL_ID]: AGENT,
        [SERVICE_ID]: SERVICE,
      },
      memberships: {
        [OWNER_MEMBERSHIP.membershipId]: OWNER_MEMBERSHIP,
        [AGENT_MEMBERSHIP.membershipId]: AGENT_MEMBERSHIP,
        [SERVICE_MEMBERSHIP.membershipId]: SERVICE_MEMBERSHIP,
      },
      channels: {
        [CHANNEL_ID]: {
          channelId: CHANNEL_ID,
          displayName: "assistants",
          kind: "public",
          revision: 2,
          status: "active",
          workspaceId: WORKSPACE_ID,
        },
      },
      channelMemberships: {
        [`${CHANNEL_ID}\u0000${OWNER_ID}`]: channelMembership(
          CHANNEL_ID,
          OWNER_ID,
        ),
        [`${CHANNEL_ID}\u0000${AGENT_PRINCIPAL_ID}`]: channelMembership(
          CHANNEL_ID,
          AGENT_PRINCIPAL_ID,
        ),
        [`${CHANNEL_ID}\u0000${SERVICE_ID}`]: channelMembership(
          CHANNEL_ID,
          SERVICE_ID,
        ),
      },
      agents: { [AGENT_ID]: CONFIG_STATE },
    },
  };
  const roster = buildAgentRoster({
    now: 100,
    providerRegistry: createProviderRegistry({ now: 0 }),
    state,
    workspaceId: WORKSPACE_ID,
  });
  assert.deepEqual(
    roster.directory.map(({ kind }) => kind),
    ["agent", "human", "service"],
  );
  const channel = roster.channels[0];
  assert.deepEqual(
    channel.members.map(({ kind }) => kind),
    ["agent", "human"],
  );
  assert.equal(
    channel.members.some(({ principalId }) => principalId === SERVICE_ID),
    false,
  );
  assert.equal(
    roster.directory.find(
      ({ principalId }) => principalId === AGENT_PRINCIPAL_ID,
    ).kind,
    "agent",
  );
  assert.equal(
    roster.directory.find(({ principalId }) => principalId === SERVICE_ID)
      .chatMember,
    false,
  );
  assert.match(agentRosterDigest(roster), /^sha256:[0-9a-f]{64}$/u);

  const duplicate = {
    ...AGENT,
    profile: { ...AGENT.profile, handle: OWNER.profile.handle },
  };
  assert.throws(
    () =>
      validateUniquePrincipalHandles([OWNER, duplicate], {
        expectedWorkspaceId: WORKSPACE_ID,
      }),
    (error) => error.code === AGENT_ROSTER_ERROR_CODES.DUPLICATE_HANDLE,
  );
});

test("presence is bounded, ordered, disposable, and cannot alter durable inputs", () => {
  const first = createTransientPresence({
    agentId: AGENT_ID,
    observedAt: 10,
    state: "busy",
    ttlMs: 20,
    workspaceId: WORKSPACE_ID,
  });
  assert.throws(
    () =>
      createTransientPresence({
        agentId: AGENT_ID,
        observedAt: 10,
        state: "busy",
        ttlMs: AGENT_PRESENCE_MAX_TTL_MS + 1,
        workspaceId: WORKSPACE_ID,
      }),
    (error) => error.code === "AGENT_ROSTER_INVALID_PRESENCE",
  );
  const merged = mergeTransientPresence({}, first, { now: 10 });
  const stale = createTransientPresence({
    agentId: AGENT_ID,
    observedAt: 20,
    state: "idle",
    ttlMs: 10,
    workspaceId: WORKSPACE_ID,
  });
  const next = mergeTransientPresence(merged, stale, { now: 20 });
  assert.equal(next[AGENT_ID].state, "idle");
  assert.deepEqual(clearTransientPresence(next, AGENT_ID), {});

  const durable = { authorization: "active", membershipRevision: 2 };
  const before = JSON.stringify(durable);
  deriveAgentAvailability({
    agentId: AGENT_ID,
    configState: CONFIG_STATE,
    now: 15,
    principal: AGENT,
    providerRegistry: createProviderRegistry({ now: 0 }),
    transientPresence: first,
    workspaceMembership: AGENT_MEMBERSHIP,
  });
  assert.equal(JSON.stringify(durable), before);
});

function principal(principalId, kind, ownedBy, handle) {
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
      issuer: "stream-slack",
      subject: `${kind}:${principalId}`,
    },
  };
}

function membership(principalId, role, status) {
  return {
    membershipId: membershipIdFor(WORKSPACE_ID, principalId),
    principalId,
    revision: 1,
    role,
    status,
    workspaceId: WORKSPACE_ID,
  };
}

function channelMembership(channelId, principalId) {
  return {
    channelId,
    principalId,
    revision: 1,
    status: "active",
    workspaceId: WORKSPACE_ID,
  };
}
