import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalStateDigest,
  createInitialState,
  REDUCER_ERROR_CODES,
  reduceEnvelope,
  ReducerError,
} from "@stream-slack/reducers";
import {
  MESSAGE_COMMANDS,
  MessageValidationError,
  normalizeConversationText,
  stampConversationActor,
  validateConversationCommand,
} from "@stream-slack/protocol";

import {
  authorizeConversationCommand,
  ConversationAuthorizationError,
  CONVERSATION_AUTH_ERROR_CODES,
  createConversationAuthorization,
} from "../../src/ledger/conversation-auth.mjs";

const WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHANNEL_ID = "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const OTHER_CHANNEL_ID =
  "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";
const FOREIGN_CHANNEL_ID =
  "ch_bbbbbbbbbbbbbbbbbbbbbbbbbb_cccccccccccccccccccccccccc";
const UNKNOWN_CHANNEL_ID =
  "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_eeeeeeeeeeeeeeeeeeeeeeeeee";
const AUTHOR_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const MEMBER_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const ADMIN_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";

test("conversation events retain revisions, actor attribution, tombstones, and reaction toggles", () => {
  const events = [
    event("channel.message.created", AUTHOR_ID, "a", {
      authorId: AUTHOR_ID,
      channelId: CHANNEL_ID,
      contentType: "text/plain",
      messageId: "root",
      rootMessageId: null,
      text: "Café",
    }),
    event("channel.message.replied", MEMBER_ID, "b", {
      authorId: MEMBER_ID,
      channelId: CHANNEL_ID,
      contentType: "text/plain",
      messageId: "reply",
      rootMessageId: "root",
      text: "A reply",
    }),
    event("channel.message.edited", AUTHOR_ID, "c", {
      channelId: CHANNEL_ID,
      contentType: "text/plain",
      expectedRevision: 1,
      messageId: "root",
      text: "Edited root",
    }),
    event("channel.message.reaction.added", MEMBER_ID, "d", {
      channelId: CHANNEL_ID,
      emoji: "thumbsup",
      messageId: "root",
    }),
    event("channel.message.reaction.added", MEMBER_ID, "e", {
      channelId: CHANNEL_ID,
      emoji: "thumbsup",
      messageId: "root",
    }),
    event("channel.message.reaction.removed", MEMBER_ID, "f", {
      channelId: CHANNEL_ID,
      emoji: "thumbsup",
      messageId: "root",
    }),
    event("channel.message.deleted", AUTHOR_ID, "g", {
      channelId: CHANNEL_ID,
      expectedRevision: 2,
      messageId: "root",
    }),
  ];

  let state = conversationProjectionState();
  for (const [index, conversationEvent] of events.entries()) {
    state = reduceEnvelope(state, conversationEvent, {
      offset: offset(index + 1),
    });
  }

  assert.equal(state.entities.messages.root.status, "deleted");
  assert.equal(state.entities.messages.root.revision, 3);
  assert.deepEqual(
    state.entities.messages.root.revisions.map(
      ({ actorId, kind, revision }) => ({
        actorId,
        kind,
        revision,
      }),
    ),
    [
      { actorId: AUTHOR_ID, kind: "created", revision: 1 },
      { actorId: AUTHOR_ID, kind: "edited", revision: 2 },
      { actorId: AUTHOR_ID, kind: "deleted", revision: 3 },
    ],
  );
  assert.equal(
    Object.values(state.entities.reactions).filter(
      ({ status }) => status === "active",
    ).length,
    0,
  );
  assert.equal(
    state.entities.reactions[`root\u0000${MEMBER_ID}\u0000thumbsup`].history
      .length,
    2,
  );
  assert.match(canonicalStateDigest(state), /^sha256:[0-9a-f]{64}$/u);
});

test("thread roots reject missing, cross-channel, deleted, and reply-to-reply references", () => {
  const root = event("channel.message.created", AUTHOR_ID, "a", {
    authorId: AUTHOR_ID,
    channelId: CHANNEL_ID,
    contentType: "text/plain",
    messageId: "root",
    rootMessageId: null,
    text: "root",
  });
  const reply = event("channel.message.replied", AUTHOR_ID, "b", {
    authorId: AUTHOR_ID,
    channelId: CHANNEL_ID,
    contentType: "text/plain",
    messageId: "reply",
    rootMessageId: "root",
    text: "reply",
  });
  const stateWithRoot = reduceEnvelope(conversationProjectionState(), root, {
    offset: offset(1),
  });
  assertReducerFailure(
    () =>
      reduceEnvelope(
        stateWithRoot,
        {
          ...reply,
          data: { ...reply.data, channelId: OTHER_CHANNEL_ID },
        },
        { offset: offset(2) },
      ),
    REDUCER_ERROR_CODES.MESSAGE_REPLY_ROOT,
  );
  assertReducerFailure(
    () =>
      reduceEnvelope(
        stateWithRoot,
        {
          ...reply,
          data: { ...reply.data, rootMessageId: "missing" },
        },
        { offset: offset(2) },
      ),
    REDUCER_ERROR_CODES.MESSAGE_REPLY_ROOT,
  );
  const stateWithReply = reduceEnvelope(stateWithRoot, reply, {
    offset: offset(2),
  });
  assertReducerFailure(
    () =>
      reduceEnvelope(
        stateWithReply,
        {
          ...reply,
          eventId: "ev_hhhhhhhhhhhhhhhhhhhhhhhhhh",
          idempotencyKey: "ik_hhhhhhhhhhhhhhhhhhhhhhhhhh",
          data: { ...reply.data, messageId: "reply-2", rootMessageId: "reply" },
        },
        { offset: offset(3) },
      ),
    REDUCER_ERROR_CODES.MESSAGE_REPLY_ROOT,
  );
});

test("legacy compact messages retain actor and workspace scope", () => {
  const compact = event("channel.message.created", AUTHOR_ID, "a", {
    authorId: AUTHOR_ID,
    channelId: CHANNEL_ID,
    messageId: "legacy-root",
    text: "legacy text",
  });
  assertReducerFailure(
    () =>
      reduceEnvelope(
        conversationProjectionState(),
        {
          ...compact,
          data: { ...compact.data, channelId: FOREIGN_CHANNEL_ID },
        },
        { allowLegacyCompactMessages: true, offset: offset(1) },
      ),
    REDUCER_ERROR_CODES.CHANNEL_SCOPE_MISMATCH,
  );
  assertReducerFailure(
    () =>
      reduceEnvelope(
        conversationProjectionState(),
        {
          ...compact,
          data: { ...compact.data, channelId: UNKNOWN_CHANNEL_ID },
        },
        { allowLegacyCompactMessages: true, offset: offset(1) },
      ),
    REDUCER_ERROR_CODES.CHANNEL_NOT_FOUND,
  );
  assertReducerFailure(
    () =>
      reduceEnvelope(
        conversationProjectionState(),
        { ...compact, data: { ...compact.data, authorId: MEMBER_ID } },
        { allowLegacyCompactMessages: true, offset: offset(1) },
      ),
    REDUCER_ERROR_CODES.MESSAGE_AUTHOR_MISMATCH,
  );
  for (const text of ["bad\u0000text", "bad\u0085text"]) {
    assertReducerFailure(
      () =>
        reduceEnvelope(
          conversationProjectionState(),
          { ...compact, data: { ...compact.data, text } },
          { allowLegacyCompactMessages: true, offset: offset(1) },
        ),
      REDUCER_ERROR_CODES.MESSAGE_TEXT,
    );
  }
  assertReducerFailure(
    () =>
      reduceEnvelope(conversationProjectionState(), compact, {
        offset: offset(1),
      }),
    REDUCER_ERROR_CODES.LEGACY_COMPACT_REPLAY_REQUIRED,
  );
  const replayed = reduceEnvelope(conversationProjectionState(), compact, {
    allowLegacyCompactMessages: true,
    offset: offset(1),
  });
  assert.deepEqual(replayed.entities.messages["legacy-root"], compact.data);
});

test("text boundary rejects non-NFC, C0/C1 controls, bidi formatting, markup content types, and unpaired surrogates", () => {
  assert.equal(normalizeConversationText("Cafe\u0301"), "Café");
  for (const value of [
    "Cafe\u0301",
    "bad\ntext",
    "bad\u0085text",
    "bad\u202Etext",
    "bad\ud800",
  ]) {
    assert.throws(
      () =>
        validateConversationCommand(
          "channel.message.create",
          {
            channelId: CHANNEL_ID,
            contentType: "text/plain",
            messageId: "m",
            rootMessageId: null,
            text: value,
          },
          { workspaceId: WORKSPACE_ID },
        ),
      MessageValidationError,
    );
  }
  assert.throws(
    () =>
      validateConversationCommand(
        "channel.message.create",
        {
          channelId: CHANNEL_ID,
          contentType: "text/html",
          messageId: "m",
          rootMessageId: null,
          text: "<b>unsafe</b>",
        },
        { workspaceId: WORKSPACE_ID },
      ),
    MessageValidationError,
  );
  assert.deepEqual(
    MESSAGE_COMMANDS["channel.message.edit"],
    "channel.message.edited",
  );
});

test("conversation dispatch policy binds actor identity and grants moderator delete only through active membership", () => {
  const state = conversationState();
  const created = authorizeConversationCommand({
    actorId: AUTHOR_ID,
    operation: "channel.message.create",
    payload: {
      channelId: CHANNEL_ID,
      contentType: "text/plain",
      messageId: "root",
      rootMessageId: null,
      text: "root",
    },
    state,
    workspaceId: WORKSPACE_ID,
  });
  assert.equal(created.data.authorId, AUTHOR_ID);
  assert.equal(created.capability, "channel.message.write");
  state.entities.messages.root = {
    authorId: AUTHOR_ID,
    channelId: CHANNEL_ID,
    messageId: "root",
    revision: 1,
    rootMessageId: null,
    status: "active",
    text: "root",
    workspaceId: WORKSPACE_ID,
  };
  const deleted = authorizeConversationCommand({
    actorId: ADMIN_ID,
    operation: "channel.message.delete",
    payload: { channelId: CHANNEL_ID, expectedRevision: 1, messageId: "root" },
    state,
    workspaceId: WORKSPACE_ID,
  });
  assert.equal(deleted.capability, "channel.message.delete");
  assert.throws(
    () =>
      authorizeConversationCommand({
        actorId: MEMBER_ID,
        operation: "channel.message.edit",
        payload: {
          channelId: CHANNEL_ID,
          contentType: "text/plain",
          expectedRevision: 1,
          messageId: "root",
          text: "forged",
        },
        state,
        workspaceId: WORKSPACE_ID,
      }),
    (error) => {
      assert.ok(error instanceof ConversationAuthorizationError);
      assert.equal(
        error.code,
        CONVERSATION_AUTH_ERROR_CODES.MESSAGE_NOT_AUTHOR,
      );
      return true;
    },
  );
  assert.throws(
    () =>
      stampConversationActor(
        {
          operation: "channel.message.create",
          payload: {
            actorId: MEMBER_ID,
            channelId: CHANNEL_ID,
            contentType: "text/plain",
            messageId: "m",
            rootMessageId: null,
            text: "spoof",
          },
        },
        AUTHOR_ID,
        WORKSPACE_ID,
      ),
    MessageValidationError,
  );
});

test("conversation dispatch refuses to run without a linearizable fence", async () => {
  const authorization = createConversationAuthorization({
    lookupState: async () => conversationState(),
  });
  await assert.rejects(
    () =>
      authorization.authorizeDispatch({
        actorId: AUTHOR_ID,
        operation: "channel.message.create",
        payload: {
          channelId: CHANNEL_ID,
          contentType: "text/plain",
          messageId: "fenced-root",
          rootMessageId: null,
          text: "fenced",
        },
        workspaceId: WORKSPACE_ID,
      }),
    (error) => {
      assert.ok(error instanceof ConversationAuthorizationError);
      assert.equal(error.code, CONVERSATION_AUTH_ERROR_CODES.FENCE_REQUIRED);
      return true;
    },
  );
  let lookupCalls = 0;
  const skippedAuthorization = createConversationAuthorization({
    lookupState: async () => {
      lookupCalls += 1;
      return conversationState();
    },
    withChannelFence: async () => "not-authorized",
  });
  await assert.rejects(
    () =>
      skippedAuthorization.authorizeDispatch({
        actorId: AUTHOR_ID,
        operation: "channel.message.create",
        payload: {
          channelId: CHANNEL_ID,
          contentType: "text/plain",
          messageId: "skipped-root",
          rootMessageId: null,
          text: "skipped",
        },
        workspaceId: WORKSPACE_ID,
      }),
    (error) => {
      assert.ok(error instanceof ConversationAuthorizationError);
      assert.equal(error.code, CONVERSATION_AUTH_ERROR_CODES.FENCE_REQUIRED);
      return true;
    },
  );
  assert.equal(lookupCalls, 0);
});

function conversationProjectionState() {
  const state = createInitialState();
  state.entities.channels = {};
  state.entities.channelMemberships = {};
  state.entities.memberships = {};
  for (const channelId of [CHANNEL_ID, OTHER_CHANNEL_ID]) {
    state.entities.channels[channelId] = {
      channelId,
      creatorId: AUTHOR_ID,
      status: "active",
      workspaceId: WORKSPACE_ID,
    };
    for (const principalId of [AUTHOR_ID, MEMBER_ID]) {
      state.entities.channelMemberships[`${channelId}\u0000${principalId}`] = {
        channelId,
        principalId,
        status: "active",
        workspaceId: WORKSPACE_ID,
      };
    }
  }
  for (const principalId of [AUTHOR_ID, MEMBER_ID]) {
    state.entities.memberships[
      `mb_${WORKSPACE_ID.slice(3)}_${principalId.slice(30)}`
    ] = {
      principalId,
      status: "active",
      workspaceId: WORKSPACE_ID,
    };
  }
  return state;
}

function conversationState() {
  return {
    entities: {
      channels: {
        [CHANNEL_ID]: {
          channelId: CHANNEL_ID,
          creatorId: AUTHOR_ID,
          status: "active",
          workspaceId: WORKSPACE_ID,
        },
      },
      channelMemberships: {
        [`${CHANNEL_ID}\u0000${AUTHOR_ID}`]: {
          channelId: CHANNEL_ID,
          principalId: AUTHOR_ID,
          status: "active",
        },
        [`${CHANNEL_ID}\u0000${MEMBER_ID}`]: {
          channelId: CHANNEL_ID,
          principalId: MEMBER_ID,
          status: "active",
        },
        [`${CHANNEL_ID}\u0000${ADMIN_ID}`]: {
          channelId: CHANNEL_ID,
          principalId: ADMIN_ID,
          status: "active",
        },
      },
      memberships: {
        [`mb_${WORKSPACE_ID.slice(3)}_${AUTHOR_ID.slice(30)}`]: {
          principalId: AUTHOR_ID,
          role: "member",
          status: "active",
          workspaceId: WORKSPACE_ID,
        },
        [`mb_${WORKSPACE_ID.slice(3)}_${MEMBER_ID.slice(30)}`]: {
          principalId: MEMBER_ID,
          role: "member",
          status: "active",
          workspaceId: WORKSPACE_ID,
        },
        [`mb_${WORKSPACE_ID.slice(3)}_${ADMIN_ID.slice(30)}`]: {
          principalId: ADMIN_ID,
          role: "admin",
          status: "active",
          workspaceId: WORKSPACE_ID,
        },
      },
      messages: {},
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
    serverTimestamp: "2026-08-03T00:00:00.000Z",
    workspaceId: WORKSPACE_ID,
  };
}

function offset(index) {
  return `0000000000000000_${index.toString(16).padStart(16, "0")}`;
}

function assertReducerFailure(operation, code) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof ReducerError);
    assert.equal(error.code, code);
    return true;
  });
}
