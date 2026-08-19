import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  canonicalParticipantIds,
  channelIdFor,
  directChannelIdFor,
  participantSetKey,
} from "@stream-slack/protocol";
import { REDUCER_ERROR_CODES, reduceEnvelope } from "@stream-slack/reducers";

import { validateAndReplayDump } from "../../src/ledger/replay.mjs";
import { sha256Digest } from "../../packages/protocol/src/sha256.mjs";
import {
  createChannelAuthorization,
  createChannelFence,
} from "../../src/ledger/channel-auth.mjs";
import { establishWorkspaceContext } from "../../src/ledger/workspace-auth.mjs";

const WORKSPACE_A = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const WORKSPACE_B = "ws_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const OWNER_A = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const MEMBER_A = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const SERVICE_A = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";
const NON_MEMBER_A = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_ffffffffffffffffffffffffff";
const PUBLIC_A = "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_11111111111111111111111111";
const PRIVATE_A = "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_22222222222222222222222222";
const PRIVATE_B = "ch_bbbbbbbbbbbbbbbbbbbbbbbbbb_44444444444444444444444444";
const DIRECT_A = directChannelIdFor(WORKSPACE_A, [OWNER_A, MEMBER_A]);

const fixturePath = path.resolve(
  ".eforest/tasks/epic-1-the-workspace/E1-T03-channel-lifecycle-and-membership/fixtures/valid/channel-lifecycle.v1.json",
);

test("channel identifiers and direct participant sets are canonical", () => {
  assert.equal(
    channelIdFor(WORKSPACE_A, "11111111111111111111111111"),
    PUBLIC_A,
  );
  assert.equal(directChannelIdFor(WORKSPACE_A, [MEMBER_A, OWNER_A]), DIRECT_A);
  assert.notEqual(
    DIRECT_A,
    directChannelIdFor(WORKSPACE_A, [OWNER_A, NON_MEMBER_A]),
  );
  assert.notEqual(
    DIRECT_A,
    directChannelIdFor(WORKSPACE_A, [SERVICE_A, NON_MEMBER_A]),
  );
  assert.deepEqual(canonicalParticipantIds([MEMBER_A, OWNER_A]), [
    OWNER_A,
    MEMBER_A,
  ]);
  assert.equal(
    participantSetKey([MEMBER_A, OWNER_A]),
    `${OWNER_A}\u0000${MEMBER_A}`,
  );
  assert.throws(() => canonicalParticipantIds([OWNER_A, OWNER_A]), {
    code: "CHANNEL_DIRECT_PARTICIPANTS",
  });
});

test("direct identifiers stay collision-free across a generated corpus", () => {
  const identifiers = new Set();
  for (let index = 0; index < 5000; index += 1) {
    const participantIds = [
      syntheticPrincipalId(WORKSPACE_A, index * 2),
      syntheticPrincipalId(WORKSPACE_A, index * 2 + 1),
    ];
    const channelId = directChannelIdFor(WORKSPACE_A, participantIds);
    assert.equal(
      identifiers.has(channelId),
      false,
      `direct identity collision at generated set ${index}`,
    );
    identifiers.add(channelId);
  }
  assert.equal(identifiers.size, 5000);
});

test("protocol SHA-256 digest matches the known abc vector", () => {
  assert.equal(
    Buffer.from(sha256Digest("abc")).toString("hex"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("channel fixture replays into two isolated public/private/direct topologies", async () => {
  const dump = JSON.parse(await readFile(fixturePath, "utf8"));
  const first = validateAndReplayDump(dump);
  const second = validateAndReplayDump(structuredClone(dump));
  assert.equal(first.finalStateJson, second.finalStateJson);
  assert.equal(first.finalStateDigest, second.finalStateDigest);
  assert.equal(Object.keys(first.finalState.entities.channels).length, 6);
  assert.equal(first.finalState.entities.channels[PUBLIC_A].status, "active");
  assert.equal(first.finalState.entities.channels[PRIVATE_A].kind, "private");
  assert.deepEqual(
    first.finalState.entities.channels[DIRECT_A].participantIds,
    [OWNER_A, MEMBER_A],
  );
  assert.equal(
    Object.values(first.finalState.entities.channelMemberships).some(
      ({ principalId }) => principalId === SERVICE_A,
    ),
    false,
  );
  assert.equal(
    Object.values(first.finalState.entities.channels).every(
      ({ workspaceId }) =>
        workspaceId === WORKSPACE_A || workspaceId === WORKSPACE_B,
    ),
    true,
  );
});

test("channel reducer rejects stale, cross-tenant, service, duplicate, and direct mutations", async () => {
  const dump = JSON.parse(await readFile(fixturePath, "utf8"));
  const state = validateAndReplayDump(dump).finalState;
  const nextOffset = "0000000000000000_0000000000000030";
  const expectFailure = (event, code) => {
    assert.throws(
      () => reduceEnvelope(state, event, { offset: nextOffset }),
      (error) => error.code === code,
    );
  };
  expectFailure(
    envelope(
      OWNER_A,
      "channel.direct.created",
      {
        channelId: DIRECT_A,
        creatorId: OWNER_A,
        participantIds: [OWNER_A, MEMBER_A],
      },
      WORKSPACE_A,
      30,
    ),
    REDUCER_ERROR_CODES.CHANNEL_DIRECT_DUPLICATE,
  );
  expectFailure(
    envelope(
      OWNER_A,
      "channel.direct.created",
      {
        channelId: channelIdFor(WORKSPACE_A, "66666666666666666666666666"),
        creatorId: OWNER_A,
        participantIds: [OWNER_A, MEMBER_A],
      },
      WORKSPACE_A,
      30,
    ),
    REDUCER_ERROR_CODES.CHANNEL_DIRECT_ID_MISMATCH,
  );
  expectFailure(
    envelope(
      SERVICE_A,
      "channel.created",
      {
        channelId: channelIdFor(WORKSPACE_A, "55555555555555555555555555"),
        creatorId: SERVICE_A,
        displayName: "service-room",
        kind: "private",
      },
      WORKSPACE_A,
      31,
    ),
    REDUCER_ERROR_CODES.CHANNEL_PARTICIPANT_SERVICE,
  );
  expectFailure(
    envelope(
      OWNER_A,
      "channel.renamed",
      {
        channelId: DIRECT_A,
        displayName: "replacement",
        expectedChannelRevision: 1,
      },
      WORKSPACE_A,
      32,
    ),
    REDUCER_ERROR_CODES.CHANNEL_INVALID_KIND,
  );
  expectFailure(
    envelope(
      OWNER_A,
      "channel.archived",
      { channelId: PUBLIC_A, expectedChannelRevision: 1 },
      WORKSPACE_A,
      33,
    ),
    REDUCER_ERROR_CODES.CHANNEL_REVISION_CONFLICT,
  );
  expectFailure(
    envelope(
      OWNER_A,
      "channel.renamed",
      {
        channelId: PRIVATE_B,
        displayName: "cross-tenant",
        expectedChannelRevision: 1,
      },
      WORKSPACE_A,
      34,
    ),
    REDUCER_ERROR_CODES.CHANNEL_SCOPE_MISMATCH,
  );
});

test("channel authorization is leak-neutral and rechecks membership for every read path", async () => {
  const dump = JSON.parse(await readFile(fixturePath, "utf8"));
  const state = validateAndReplayDump(dump).finalState;
  const channels = state.entities.channels;
  const channelMemberships = state.entities.channelMemberships;
  const workspaceMemberships = state.entities.memberships;
  const authorization = createChannelAuthorization({
    lookupChannel: async (workspaceId, channelId) => {
      const channel = channels[channelId];
      return channel?.workspaceId === workspaceId ? channel : null;
    },
    lookupChannelMembership: async (workspaceId, channelId, principalId) =>
      Object.values(channelMemberships).find(
        (membership) =>
          membership.workspaceId === workspaceId &&
          membership.channelId === channelId &&
          membership.principalId === principalId,
      ) ?? null,
    lookupWorkspaceMembership: async (workspaceId, principalId) =>
      Object.values(workspaceMemberships).find(
        (membership) =>
          membership.workspaceId === workspaceId &&
          membership.principalId === principalId,
      ) ?? null,
    withChannelFence: createChannelFence(),
  });
  const memberContext = establishWorkspaceContext({
    authenticatedPrincipalId: MEMBER_A,
    trustedWorkspaceId: WORKSPACE_A,
  });
  const nonMemberContext = establishWorkspaceContext({
    authenticatedPrincipalId:
      "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_ffffffffffffffffffffffffff",
    trustedWorkspaceId: WORKSPACE_A,
  });

  const memberRead = await authorization.authorizeRead(memberContext, {
    channelId: PRIVATE_A,
  });
  const memberDiscovery = await authorization.authorizeDiscovery(
    memberContext,
    {
      channelId: PRIVATE_A,
    },
  );
  assert.equal(memberRead.channel.channelId, PRIVATE_A);
  assert.equal(memberDiscovery.channel.channelId, PRIVATE_A);
  assert.equal(typeof memberRead.revalidate, "function");

  const observedErrors = [];
  for (const pathName of ["snapshot", "projection", "search"]) {
    try {
      await authorization.authorizeRead(nonMemberContext, {
        channelId: PRIVATE_A,
        path: pathName,
      });
      assert.fail(`${pathName} unexpectedly disclosed a private channel`);
    } catch (error) {
      observedErrors.push(JSON.stringify(error.toJSON()));
      assert.equal(error.statusCode, 404);
      assert.equal(error.detail.includes(PRIVATE_A), false);
    }
  }
  await assert.rejects(
    authorization.authorizeSubscription(
      { stream: `channel:${PRIVATE_A}` },
      nonMemberContext,
      { channelId: PRIVATE_A, register: async () => assert.fail() },
    ),
  );
  await assert.rejects(
    authorization.authorizeDispatch(
      { payload: { channelId: PRIVATE_A } },
      nonMemberContext,
      {
        channelId: PRIVATE_A,
        dispatch: async () => assert.fail(),
      },
    ),
  );
  assert.equal(new Set(observedErrors).size, 1);
  await assert.rejects(
    authorization.authorizeRead(memberContext, {
      channelId: PRIVATE_B,
    }),
  );
});

test("archived channels stay readable but reject writes", async () => {
  const dump = JSON.parse(await readFile(fixturePath, "utf8"));
  const replay = validateAndReplayDump(dump);
  const archivedState = replay.prefixes.find(
    ({ state }) => state.entities.channels?.[PUBLIC_A]?.status === "archived",
  ).state;
  const ownerContext = establishWorkspaceContext({
    authenticatedPrincipalId: OWNER_A,
    trustedWorkspaceId: WORKSPACE_A,
  });
  const authorization = authorizationFor(archivedState);
  await authorization.authorizeRead(ownerContext, { channelId: PUBLIC_A });
  await assert.rejects(
    authorization.authorizeDispatch(
      { payload: { text: "blocked" } },
      ownerContext,
      { channelId: PUBLIC_A, dispatch: async () => assert.fail() },
    ),
  );
});

function authorizationFor(state, overrides = {}) {
  return createChannelAuthorization({
    lookupChannel: async (workspaceId, channelId) => {
      const channel = state.entities.channels[channelId];
      return channel?.workspaceId === workspaceId ? channel : null;
    },
    lookupChannelMembership: async (workspaceId, channelId, principalId) =>
      Object.values(state.entities.channelMemberships ?? {}).find(
        (membership) =>
          membership.workspaceId === workspaceId &&
          membership.channelId === channelId &&
          membership.principalId === principalId,
      ) ?? null,
    lookupWorkspaceMembership: async (workspaceId, principalId) =>
      Object.values(state.entities.memberships ?? {}).find(
        (membership) =>
          membership.workspaceId === workspaceId &&
          membership.principalId === principalId,
      ) ?? null,
    withChannelFence: createChannelFence(),
    ...overrides,
  });
}

function envelope(actorId, eventType, data, workspaceId, sequence) {
  const token = String(sequence).padStart(26, "0");
  return {
    actorId,
    causation: null,
    correlationId: `cr_${token}`,
    data,
    eventId: `ev_${token}`,
    eventType,
    idempotencyKey: `ik_${token}`,
    schemaVersion: 1,
    serverTimestamp: `2026-08-02T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    workspaceId,
  };
}

function syntheticPrincipalId(workspaceId, index) {
  return `pr_${workspaceId.slice(3)}_${index.toString(16).padStart(26, "0")}`;
}
