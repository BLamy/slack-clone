import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialState,
  reduceEnvelope,
  ReducerError,
} from "@stream-slack/reducers";
import {
  stampConversationActor,
  validateAgentReplyProvenance,
  validateConversationCommand,
} from "@stream-slack/protocol";

import { sanitizeAgentReplyOutput } from "../../src/ledger/agent-replies.mjs";
import { canonicalSha256 } from "../../src/ledger/canonical-json.mjs";

const WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const HUMAN_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const AGENT_PRINCIPAL_ID =
  "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";
const AGENT_ID = "ag_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";
const CHANNEL_ID = "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const RUN_ID = "rn_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";

test("agent output redacts credentials and neutralizes executable markup", () => {
  const secret = `sk-${"z".repeat(24)}`;
  const output = sanitizeAgentReplyOutput(`<script>${secret}</script>`);
  assert.equal(output.redacted, true);
  assert.equal(output.text.includes(secret), false);
  assert.equal(output.text.includes("<script>"), false);
  assert.match(output.text, /&lt;script&gt;/u);
});

test("agent reply provenance is strict and cannot be accepted by a human path", () => {
  const provenance = validProvenance();
  assert.deepEqual(
    validateAgentReplyProvenance(provenance, {
      expectedAgentId: AGENT_ID,
      expectedAgentPrincipalId: AGENT_PRINCIPAL_ID,
      expectedChannelId: CHANNEL_ID,
      expectedWorkspaceId: WORKSPACE_ID,
    }),
    provenance,
  );
  assert.throws(
    () =>
      validateConversationCommand(
        "channel.message.reply",
        {
          agentReplyProvenance: provenance,
          channelId: CHANNEL_ID,
          contentType: "text/plain",
          messageId: "reply",
          rootMessageId: "root",
          text: "answer",
        },
        { workspaceId: WORKSPACE_ID },
      ),
    /agentReplyProvenance is not allowed/u,
  );
  const prepared = stampConversationActor(
    {
      operation: "channel.message.reply",
      payload: {
        agentReplyProvenance: provenance,
        channelId: CHANNEL_ID,
        contentType: "text/plain",
        messageId: "reply",
        rootMessageId: "root",
        text: "answer",
      },
    },
    AGENT_PRINCIPAL_ID,
    WORKSPACE_ID,
    { allowAgentReplyProvenance: true },
  );
  assert.equal(prepared.data.authorId, AGENT_PRINCIPAL_ID);
  assert.throws(
    () =>
      stampConversationActor(
        {
          operation: "channel.message.reply",
          payload: {
            agentReplyProvenance: {
              ...provenance,
              agentPrincipalId: HUMAN_ID,
            },
            channelId: CHANNEL_ID,
            contentType: "text/plain",
            messageId: "reply-2",
            rootMessageId: "root",
            text: "answer",
          },
        },
        AGENT_PRINCIPAL_ID,
        WORKSPACE_ID,
        { allowAgentReplyProvenance: true },
      ),
    (error) => error.code === "AGENT_REPLY_ACTOR_MISMATCH",
  );
});

test("the conversation reducer persists provenance and requires an active agent actor", () => {
  const state = conversationState();
  const root = event("channel.message.created", HUMAN_ID, "a", {
    authorId: HUMAN_ID,
    channelId: CHANNEL_ID,
    contentType: "text/plain",
    messageId: "root",
    rootMessageId: null,
    text: "trigger",
  });
  const replyData = stampConversationActor(
    {
      operation: "channel.message.reply",
      payload: {
        agentReplyProvenance: validProvenance(),
        channelId: CHANNEL_ID,
        contentType: "text/plain",
        messageId: "reply",
        rootMessageId: "root",
        text: "answer",
      },
    },
    AGENT_PRINCIPAL_ID,
    WORKSPACE_ID,
    { allowAgentReplyProvenance: true },
  ).data;
  const reply = event(
    "channel.message.replied",
    AGENT_PRINCIPAL_ID,
    "b",
    replyData,
  );
  let projected = reduceEnvelope(state, root, { offset: offset(1) });
  projected = reduceEnvelope(projected, reply, { offset: offset(2) });
  assert.equal(
    projected.entities.messages.reply.agentReplyProvenance.runId,
    RUN_ID,
  );

  const humanReply = event("channel.message.replied", HUMAN_ID, "c", {
    ...replyData,
    authorId: HUMAN_ID,
  });
  assert.throws(
    () => reduceEnvelope(projected, humanReply, { offset: offset(3) }),
    (error) =>
      error instanceof ReducerError &&
      error.code === "REDUCER_AGENT_REPLY_PROVENANCE",
  );
});

function validProvenance() {
  return {
    agentId: AGENT_ID,
    agentPrincipalId: AGENT_PRINCIPAL_ID,
    attemptId: "at_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    channelId: CHANNEL_ID,
    contextDigest: digest("context"),
    contextRef: {
      digest: digest("context"),
      offset: offset(9),
      stream: `run:${RUN_ID}`,
    },
    invocationId: "iv_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    invocationRef: {
      digest: digest("invocation"),
      offset: offset(1),
      stream: `workspace:${WORKSPACE_ID}/invocations`,
    },
    leaseGeneration: 1,
    runId: RUN_ID,
    schemaVersion: 1,
    snapshotDigest: digest("snapshot"),
    snapshotRef: {
      digest: digest("config"),
      offset: offset(1),
      stream: `agent:${AGENT_ID}/config`,
    },
    sourceMention: {
      digest: digest("source"),
      offset: offset(1),
      stream: `channel:${CHANNEL_ID}`,
    },
    threadRootMessageId: "root",
  };
}

function conversationState() {
  const state = createInitialState();
  state.entities.channels = {
    [CHANNEL_ID]: {
      channelId: CHANNEL_ID,
      status: "active",
      workspaceId: WORKSPACE_ID,
    },
  };
  state.entities.channelMemberships = {
    [`${CHANNEL_ID}\u0000${HUMAN_ID}`]: membership(HUMAN_ID),
    [`${CHANNEL_ID}\u0000${AGENT_PRINCIPAL_ID}`]:
      membership(AGENT_PRINCIPAL_ID),
  };
  state.entities.memberships = {
    [membershipKey(HUMAN_ID)]: {
      principalId: HUMAN_ID,
      role: "member",
      status: "active",
      workspaceId: WORKSPACE_ID,
    },
    [membershipKey(AGENT_PRINCIPAL_ID)]: {
      principalId: AGENT_PRINCIPAL_ID,
      role: "agent",
      status: "active",
      workspaceId: WORKSPACE_ID,
    },
  };
  state.entities.principals = {
    [AGENT_PRINCIPAL_ID]: {
      kind: "agent",
      principalId: AGENT_PRINCIPAL_ID,
      status: "active",
    },
  };
  return state;
}

function membership(principalId) {
  return {
    channelId: CHANNEL_ID,
    principalId,
    status: "active",
    workspaceId: WORKSPACE_ID,
  };
}

function membershipKey(principalId) {
  return `mb_${WORKSPACE_ID.slice(3)}_${principalId.slice(30)}`;
}

function event(eventType, actorId, token, data) {
  return {
    actorId,
    causation: null,
    correlationId: `cr_${"a".repeat(26)}`,
    data,
    eventId: `ev_${token.repeat(26)}`,
    eventType,
    idempotencyKey: `ik_${token.repeat(26)}`,
    schemaVersion: 1,
    serverTimestamp: "2026-08-08T00:00:00.000Z",
    workspaceId: WORKSPACE_ID,
  };
}

function digest(value) {
  return canonicalSha256({ value });
}

function offset(value) {
  return `0000000000000000_${value.toString(16).padStart(16, "0")}`;
}
