import assert from "node:assert/strict";
import test from "node:test";

import {
  bindMentionSources,
  MENTION_REFUSAL_CODES,
  parseMentionCandidates,
} from "@stream-slack/protocol";
import {
  canonicalStateDigest,
  createInitialState,
  REDUCER_ERROR_CODES,
  reduceEnvelope,
} from "@stream-slack/reducers";

import {
  bindAcceptedMentionSource,
  MentionResolutionError,
  resolveConversationMentions,
  resolveConversationMentionsStrict,
} from "../../src/ledger/mentions.mjs";
import {
  createMentionAwareConversationDispatcher,
  prepareConversationEvent,
} from "../../src/ledger/conversation-auth.mjs";

const WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHANNEL_ID = "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const AUTHOR_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADA_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";
const AGENT_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_eeeeeeeeeeeeeeeeeeeeeeeeee";
const SERVICE_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_ffffffffffffffffffffffffff";
const DISABLED_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_gggggggggggggggggggggggggg";
const AMBIGUOUS_A_ID =
  "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_hhhhhhhhhhhhhhhhhhhhhhhhhh";
const AMBIGUOUS_B_ID =
  "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_jjjjjjjjjjjjjjjjjjjjjjjjjj";
const OUTSIDER_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_kkkkkkkkkkkkkkkkkkkkkkkkkk";
const FOREIGN_ADA_ID =
  "pr_bbbbbbbbbbbbbbbbbbbbbbbbbb_dddddddddddddddddddddddddd";

test("mention parser uses UTF-8 spans and a deterministic Markdown exclusion policy", () => {
  const text =
    "Café @ada `@ada` and \\@ada\n> @ada\n```\n@ada\n```\nhttps://example.test/@ada @linus";
  const candidates = parseMentionCandidates(text);
  assert.deepEqual(
    candidates.map(({ handle, span, text: displayText }) => ({
      displayText,
      handle,
      span,
    })),
    [
      {
        displayText: "@ada",
        handle: "ada",
        span: { startByte: 6, endByte: 10 },
      },
      {
        displayText: "@linus",
        handle: "linus",
        span: { startByte: 74, endByte: 80 },
      },
    ],
  );
  const bytes = new TextEncoder().encode(text);
  assert.equal(new TextDecoder().decode(bytes.slice(6, 10)), "@ada");
  assert.equal(new TextDecoder().decode(bytes.slice(74, 80)), "@linus");
  assert.deepEqual(parseMentionCandidates("email ada@example.test @ada"), [
    {
      handle: "ada",
      text: "@ada",
      span: { startByte: 23, endByte: 27 },
    },
  ]);
});

test("mention parser treats invisible format controls as plain text", () => {
  for (const text of [
    "ada\u200b@example.test",
    "x\u2060@helper",
    "x\ufeff@helper",
    "x\u00ad@helper",
    "@ada\u200bxyz",
  ])
    assert.deepEqual(parseMentionCandidates(text), []);
  assert.deepEqual(
    parseMentionCandidates("👩‍💻 @ada").map(({ handle }) => handle),
    ["ada"],
  );
  assert.deepEqual(parseMentionCandidates("\\\\@helper"), [
    {
      handle: "helper",
      text: "@helper",
      span: { startByte: 2, endByte: 9 },
    },
  ]);
  assert.deepEqual(parseMentionCandidates("𝒜@helper"), []);
});

test("resolver returns canonical human and agent facts and typed identity-neutral refusals", () => {
  const state = mentionState();
  const result = resolveConversationMentions({
    channelId: CHANNEL_ID,
    state,
    text: "@ada @helper @service @disabled @outsider @ambiguous @foreign",
    workspaceId: WORKSPACE_ID,
  });
  assert.deepEqual(
    result.mentions.map(({ handle, kind, principalId }) => ({
      handle,
      kind,
      principalId,
    })),
    [
      { handle: "ada", kind: "human", principalId: ADA_ID },
      { handle: "helper", kind: "agent", principalId: AGENT_ID },
    ],
  );
  assert.deepEqual(
    result.refusals.map(({ code }) => code),
    [
      MENTION_REFUSAL_CODES.TARGET_SERVICE,
      MENTION_REFUSAL_CODES.TARGET_DISABLED,
      MENTION_REFUSAL_CODES.TARGET_NOT_MEMBER,
      MENTION_REFUSAL_CODES.AMBIGUOUS_TARGET,
      MENTION_REFUSAL_CODES.TARGET_UNKNOWN,
    ],
  );
  assert.equal(JSON.stringify(result.refusals).includes(ADA_ID), false);
  assert.throws(
    () =>
      resolveConversationMentionsStrict({
        channelId: CHANNEL_ID,
        state,
        text: "@outsider",
        workspaceId: WORKSPACE_ID,
      }),
    (error) => {
      assert.ok(error instanceof MentionResolutionError);
      assert.equal(error.code, MENTION_REFUSAL_CODES.TARGET_NOT_MEMBER);
      assert.equal(error.message.includes(ADA_ID), false);
      return true;
    },
  );
});

test("conversation preparation resolves mentions only after channel authorization", () => {
  const state = mentionState();
  const prepared = prepareConversationEvent({
    actorId: AUTHOR_ID,
    operation: "channel.message.create",
    payload: {
      channelId: CHANNEL_ID,
      contentType: "text/plain",
      messageId: "message-1",
      rootMessageId: null,
      text: "hello @ada and @helper",
    },
    state,
    workspaceId: WORKSPACE_ID,
  });
  assert.deepEqual(
    prepared.data.mentions.map(({ principalId, span }) => ({
      principalId,
      span,
    })),
    [
      { principalId: ADA_ID, span: { startByte: 6, endByte: 10 } },
      { principalId: AGENT_ID, span: { startByte: 15, endByte: 22 } },
    ],
  );
  assert.deepEqual(prepared.mentionResolution.refusals, []);
});

test("accepted dispatch binds the immutable receipt source without changing display authority", () => {
  const mentions = [
    {
      handle: "ada",
      kind: "human",
      principalId: ADA_ID,
      span: { startByte: 6, endByte: 10 },
      text: "@ada",
    },
  ];
  const bound = bindAcceptedMentionSource(
    {
      event: { channelId: CHANNEL_ID, mentions },
      receipt: {
        eventDigest: `sha256:${"a".repeat(64)}`,
        nextOffset: "0000000000000000_0000000000000007",
        workspaceId: WORKSPACE_ID,
      },
    },
    { text: "hello @ada" },
  );
  assert.deepEqual(bound.event.mentions[0].source, {
    digest: canonicalStateDigest({ channelId: CHANNEL_ID, mentions }),
    offset: "0000000000000000_0000000000000007",
    stream: `channel:${CHANNEL_ID}`,
  });
  assert.deepEqual(
    bindMentionSources(
      mentions,
      {
        digest: `sha256:${"b".repeat(64)}`,
        offset: "0000000000000000_0000000000000008",
        stream: `channel:${CHANNEL_ID}`,
      },
      { expectedWorkspaceId: WORKSPACE_ID, text: "hello @ada" },
    )[0].span,
    mentions[0].span,
  );
});

test("mention-aware dispatch fences resolution and appends canonical facts", async () => {
  const state = mentionState();
  let fenceCalls = 0;
  let dispatchedRequest;
  const dispatch = createMentionAwareConversationDispatcher({
    dispatch: async (request) => {
      dispatchedRequest = request;
      return {
        event: { ...request.payload },
        receipt: {
          eventDigest: `sha256:${"c".repeat(64)}`,
          nextOffset: offset(9),
          workspaceId: WORKSPACE_ID,
        },
      };
    },
    lookupState: async () => state,
    withChannelFence: async (_context, operation) => {
      fenceCalls += 1;
      return operation();
    },
  });
  const result = await dispatch({
    actorId: AUTHOR_ID,
    operation: "channel.message.create",
    payload: {
      channelId: CHANNEL_ID,
      contentType: "text/plain",
      messageId: "fenced-message",
      rootMessageId: null,
      text: "hello @ada",
    },
    stream: `channel:${CHANNEL_ID}`,
    workspaceId: WORKSPACE_ID,
  });
  assert.equal(fenceCalls, 1);
  assert.equal(dispatchedRequest.payload.mentions[0].principalId, ADA_ID);
  assert.equal(result.event.mentions[0].source.offset, offset(9));
  assert.equal(
    result.event.mentions[0].source.digest,
    canonicalStateDigest(dispatchedRequest.payload),
  );
});

test("replay retains the original stable target and source digest after a handle change", () => {
  const state = mentionState();
  const text = "hello @ada";
  const mention = resolveConversationMentions({
    channelId: CHANNEL_ID,
    state,
    text,
    workspaceId: WORKSPACE_ID,
  }).mentions[0];
  const created = event("channel.message.created", AUTHOR_ID, "a", {
    authorId: AUTHOR_ID,
    channelId: CHANNEL_ID,
    contentType: "text/plain",
    messageId: "mentioned-message",
    mentions: [mention],
    rootMessageId: null,
    text,
  });
  const profileUpdate = event("principal.profile.updated", AUTHOR_ID, "b", {
    principalId: ADA_ID,
    profile: {
      displayName: "Ada New Handle",
      email: "ada@example.test",
      handle: "ada-renamed",
    },
    revision: 2,
  });
  const first = reduceEnvelope(state, created, {
    offset: offset(1),
  });
  const second = reduceEnvelope(first, profileUpdate, {
    offset: offset(2),
  });
  assert.equal(
    second.entities.principals[ADA_ID].profile.handle,
    "ada-renamed",
  );
  assert.equal(
    second.entities.messages["mentioned-message"].mentions[0].principalId,
    ADA_ID,
  );
  assert.equal(
    second.entities.messages["mentioned-message"].mentions[0].handle,
    "ada",
  );
  assert.equal(
    second.entities.messages["mentioned-message"].mentions[0].source.digest,
    canonicalStateDigest(created.data),
  );
  assert.equal(
    second.entities.messages["mentioned-message"].mentions[0].source.offset,
    offset(1),
  );
});

test("reducer rejects mention facts hidden inside Markdown exclusions", () => {
  const fact = {
    handle: "ada",
    kind: "human",
    principalId: ADA_ID,
    span: { startByte: 1, endByte: 5 },
    text: "@ada",
  };
  assert.throws(
    () =>
      reduceEnvelope(
        mentionState(),
        event("channel.message.created", AUTHOR_ID, "f", {
          authorId: AUTHOR_ID,
          channelId: CHANNEL_ID,
          contentType: "text/plain",
          messageId: "inline-code-mention",
          mentions: [fact],
          rootMessageId: null,
          text: "`@ada`",
        }),
        { offset: offset(1) },
      ),
    (error) => error.code === REDUCER_ERROR_CODES.MENTION_INVALID,
  );
});

test("reducer rejects a valid display handle bound to another principal", () => {
  assert.throws(
    () =>
      reduceEnvelope(
        mentionState(),
        event("channel.message.created", AUTHOR_ID, "g", {
          authorId: AUTHOR_ID,
          channelId: CHANNEL_ID,
          contentType: "text/plain",
          messageId: "substituted-principal-mention",
          mentions: [
            {
              handle: "ada",
              kind: "human",
              principalId: AUTHOR_ID,
              span: { startByte: 6, endByte: 10 },
              text: "@ada",
            },
          ],
          rootMessageId: null,
          text: "hello @ada",
        }),
        { offset: offset(1) },
      ),
    (error) => error.code === REDUCER_ERROR_CODES.MENTION_HANDLE_MISMATCH,
  );
});

test("reducer rejects an ambiguous canonical display handle", () => {
  assert.throws(
    () =>
      reduceEnvelope(
        mentionState(),
        event("channel.message.created", AUTHOR_ID, "h", {
          authorId: AUTHOR_ID,
          channelId: CHANNEL_ID,
          contentType: "text/plain",
          messageId: "ambiguous-mention",
          mentions: [
            {
              handle: "ambiguous",
              kind: "human",
              principalId: AMBIGUOUS_A_ID,
              span: { startByte: 6, endByte: 16 },
              text: "@ambiguous",
            },
          ],
          rootMessageId: null,
          text: "hello @ambiguous",
        }),
        { offset: offset(1) },
      ),
    (error) => error.code === REDUCER_ERROR_CODES.MENTION_AMBIGUOUS_TARGET,
  );
});

test("reducer refuses disabled and non-member mention targets", () => {
  for (const [token, target, expectedCode] of [
    [
      "i",
      {
        handle: "disabled",
        kind: "human",
        principalId: DISABLED_ID,
        span: { startByte: 6, endByte: 15 },
        text: "@disabled",
      },
      REDUCER_ERROR_CODES.MENTION_TARGET_DISABLED,
    ],
    [
      "j",
      {
        handle: "outsider",
        kind: "human",
        principalId: OUTSIDER_ID,
        span: { startByte: 6, endByte: 15 },
        text: "@outsider",
      },
      REDUCER_ERROR_CODES.MENTION_TARGET_NOT_MEMBER,
    ],
  ]) {
    assert.throws(
      () =>
        reduceEnvelope(
          mentionState(),
          event("channel.message.created", AUTHOR_ID, token, {
            authorId: AUTHOR_ID,
            channelId: CHANNEL_ID,
            contentType: "text/plain",
            messageId: `${target.handle}-mention-target`,
            mentions: [target],
            rootMessageId: null,
            text: `hello @${target.handle}`,
          }),
          { offset: offset(1) },
        ),
      (error) => error.code === expectedCode,
    );
  }
});

function mentionState() {
  const state = createInitialState();
  state.entities.principals = {
    [AUTHOR_ID]: principal(AUTHOR_ID, "author", "human"),
    [ADA_ID]: principal(ADA_ID, "ada", "human"),
    [AGENT_ID]: principal(AGENT_ID, "helper", "agent", AUTHOR_ID),
    [SERVICE_ID]: principal(SERVICE_ID, "service", "service"),
    [DISABLED_ID]: principal(
      DISABLED_ID,
      "disabled",
      "human",
      null,
      "suspended",
    ),
    [AMBIGUOUS_A_ID]: principal(AMBIGUOUS_A_ID, "ambiguous", "human"),
    [AMBIGUOUS_B_ID]: principal(AMBIGUOUS_B_ID, "ambiguous", "human"),
    [OUTSIDER_ID]: principal(OUTSIDER_ID, "outsider", "human"),
    [FOREIGN_ADA_ID]: principal(FOREIGN_ADA_ID, "foreign", "human"),
  };
  state.entities.channels = {
    [CHANNEL_ID]: {
      channelId: CHANNEL_ID,
      creatorId: AUTHOR_ID,
      status: "active",
      workspaceId: WORKSPACE_ID,
    },
  };
  state.entities.memberships = {};
  state.entities.channelMemberships = {};
  for (const principalId of [
    AUTHOR_ID,
    ADA_ID,
    AGENT_ID,
    SERVICE_ID,
    DISABLED_ID,
    AMBIGUOUS_A_ID,
    AMBIGUOUS_B_ID,
  ]) {
    state.entities.memberships[`mb_${principalId.slice(3)}`] = {
      principalId,
      status: "active",
      workspaceId: WORKSPACE_ID,
    };
    state.entities.channelMemberships[`${CHANNEL_ID}\u0000${principalId}`] = {
      channelId: CHANNEL_ID,
      principalId,
      status: "active",
      workspaceId: WORKSPACE_ID,
    };
  }
  state.entities.memberships[`mb_${DISABLED_ID.slice(3)}`].status = "active";
  state.entities.channels[CHANNEL_ID].workspaceId = WORKSPACE_ID;
  return state;
}

function principal(
  principalId,
  handle,
  kind,
  ownedBy = null,
  status = "active",
) {
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
    status,
    subjectBinding: {
      audience: "stream-slack",
      issuer: "auth0",
      subject: principalId,
    },
  };
}

function event(eventType, actorId, token, data) {
  return {
    actorId,
    causation: null,
    correlationId: "cr_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    data,
    eventId: `ev_${token.repeat(26)}`,
    eventType,
    idempotencyKey: `ik_${token.repeat(26)}`,
    schemaVersion: 1,
    serverTimestamp: "2026-08-04T00:00:00.000Z",
    workspaceId: WORKSPACE_ID,
  };
}

function offset(sequence) {
  return `0000000000000000_${sequence.toString(16).padStart(16, "0")}`;
}
