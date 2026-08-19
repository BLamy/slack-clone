import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_PACK_ERROR_CODES,
  assembleContextPack,
  canonicalContextPack,
  createContextPack,
  encodeContextPack,
  replayContextPack,
} from "../../src/ledger/context-pack.mjs";
import {
  digestEventEnvelope,
  issueEventEnvelope,
} from "../../src/ledger/envelope.mjs";

const WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHANNEL_ID = "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const SIBLING_CHANNEL_ID =
  "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const AGENT_ID = "ag_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";
const AGENT_PRINCIPAL_ID =
  "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";
const AUTHOR_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_eeeeeeeeeeeeeeeeeeeeeeeeee";
const ADMIN_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_ffffffffffffffffffffffffff";
const CONFIG_STREAM = `agent:${AGENT_ID}/config`;
const DIRECTORY_STREAM = `workspace:${WORKSPACE_ID}/directory`;

test("assembles a cited, ACL-bound, canonical context pack and replays it", () => {
  const fixture = makeFixture();
  const pack = assembleContextPack(fixture.input);

  assert.equal(pack.kind, "context-pack");
  assert.equal(pack.schemaVersion, 1);
  assert.equal(pack.context.channelId, CHANNEL_ID);
  assert.equal(pack.instructions[0].trust, "trusted-instructions");
  assert.equal(
    pack.items.every((item) => item.trust === "untrusted-content"),
    true,
  );
  assert.equal(
    pack.items.every(
      (item) =>
        item.citation.stream === `channel:${CHANNEL_ID}` ||
        item.citation.stream === DIRECTORY_STREAM,
    ),
    true,
  );
  assert.equal(pack.items[0].citation.principalId, AUTHOR_ID);
  assert.equal(pack.items[0].citation.contentKind, "conversation-message");
  assert.equal(
    pack.omitted.some((item) => item.reason === "message-limit"),
    true,
  );
  assert.equal(pack.sourceHeads.length, 3);
  assert.equal(pack.packDigest, createContextPack(pack).packDigest);
  assert.equal(
    new TextDecoder().decode(encodeContextPack(pack)),
    canonicalContextPack(pack),
  );
  assert.deepEqual(replayContextPack(pack), pack);
  assert.notEqual(replayContextPack(pack), pack);
  assert.equal(JSON.stringify(pack).includes("sibling-canary"), false);
});

test("rejects private scope, stale membership, source-head drift, and unauthorized paths", () => {
  const fixture = makeFixture();
  assert.throws(
    () =>
      assembleContextPack({
        ...fixture.input,
        authorization: {
          ...fixture.input.authorization,
          channel: { ...fixture.input.authorization.channel, kind: "private" },
        },
      }),
    (error) => error.code === CONTEXT_PACK_ERROR_CODES.PRIVATE_SCOPE,
  );
  assert.throws(
    () =>
      assembleContextPack({
        ...fixture.input,
        authorization: {
          ...fixture.input.authorization,
          channelMembership: {
            ...fixture.input.authorization.channelMembership,
            status: "left",
          },
        },
      }),
    (error) => error.code === CONTEXT_PACK_ERROR_CODES.MEMBERSHIP_INACTIVE,
  );
  assert.throws(
    () =>
      assembleContextPack({
        ...fixture.input,
        sourceHeads: fixture.input.sourceHeads.map((head) =>
          head.stream === `channel:${CHANNEL_ID}`
            ? { ...head, digest: `sha256:${"0".repeat(64)}` }
            : head,
        ),
      }),
    (error) => error.code === CONTEXT_PACK_ERROR_CODES.SOURCE_HEAD,
  );
  assert.throws(
    () =>
      assembleContextPack({
        ...fixture.input,
        policy: { ...fixture.input.policy, workspaceInputPaths: ["docs"] },
        workspaceInputs: [
          {
            ...fixture.input.workspaceInputs[0],
            path: "private/secret.txt",
          },
        ],
      }),
    (error) => error.code === CONTEXT_PACK_ERROR_CODES.WORKSPACE_INPUT_SCOPE,
  );
});

test("refuses tampered pack bytes and credential-shaped content", () => {
  const fixture = makeFixture();
  const pack = assembleContextPack(fixture.input);
  const tampered = structuredClone(pack);
  tampered.items[0].content.text = "tampered";
  assert.throws(
    () => replayContextPack(tampered),
    (error) => error.code === CONTEXT_PACK_ERROR_CODES.DIGEST_MISMATCH,
  );
  assert.throws(
    () =>
      assembleContextPack({
        ...fixture.input,
        sourceRecords: fixture.input.sourceRecords.map((record) =>
          record.stream === `channel:${CHANNEL_ID}` &&
          record.event.data.messageId === "root"
            ? {
                ...record,
                event: {
                  ...record.event,
                  data: {
                    ...record.event.data,
                    text: "Bearer context-pack-canary-123456",
                  },
                },
              }
            : record,
        ),
      }),
    (error) =>
      error.code === CONTEXT_PACK_ERROR_CODES.SOURCE_INVALID ||
      error.code === CONTEXT_PACK_ERROR_CODES.PACK_INVALID ||
      error.code === CONTEXT_PACK_ERROR_CODES.TRIGGER_INVALID,
  );
});

function makeFixture() {
  const events = [
    sourceEvent("channel.message.created", AUTHOR_ID, "a", {
      authorId: AUTHOR_ID,
      channelId: CHANNEL_ID,
      contentType: "text/plain",
      messageId: "root",
      rootMessageId: null,
      text: "Trigger message",
    }),
    sourceEvent("channel.message.replied", AUTHOR_ID, "b", {
      authorId: AUTHOR_ID,
      channelId: CHANNEL_ID,
      contentType: "text/plain",
      messageId: "reply",
      rootMessageId: "root",
      text: "Nearby reply",
    }),
    sourceEvent("channel.message.created", AUTHOR_ID, "c", {
      authorId: AUTHOR_ID,
      channelId: CHANNEL_ID,
      contentType: "text/plain",
      messageId: "old",
      rootMessageId: null,
      text: "Older history",
    }),
    sourceEvent("agent.config.revised", ADMIN_ID, "d", {
      agentId: AGENT_ID,
      revision: 2,
    }),
    sourceEvent("workspace.directory.updated", ADMIN_ID, "e", {
      revision: 4,
    }),
    sourceEvent("channel.message.created", AUTHOR_ID, "f", {
      authorId: AUTHOR_ID,
      channelId: SIBLING_CHANNEL_ID,
      contentType: "text/plain",
      messageId: "sibling",
      rootMessageId: null,
      text: "sibling-canary",
    }),
  ];
  const records = events.map((event, index) => ({
    event,
    offset: offset(index + 1),
    stream:
      event.data.channelId === SIBLING_CHANNEL_ID
        ? `channel:${SIBLING_CHANNEL_ID}`
        : event.eventType.startsWith("channel.")
          ? `channel:${CHANNEL_ID}`
          : event.eventType.startsWith("agent.")
            ? CONFIG_STREAM
            : DIRECTORY_STREAM,
  }));
  const sourceHeads = [
    CONFIG_STREAM,
    DIRECTORY_STREAM,
    `channel:${CHANNEL_ID}`,
  ].map((stream) => {
    const record = records
      .filter((candidate) => candidate.stream === stream)
      .at(-1);
    return {
      digest: digestEventEnvelope(record.event),
      offset: record.offset,
      stream,
    };
  });
  const input = {
    agentId: AGENT_ID,
    authorization: {
      channel: {
        channelId: CHANNEL_ID,
        kind: "public",
        revision: 2,
        status: "active",
        workspaceId: WORKSPACE_ID,
      },
      channelMembership: {
        channelId: CHANNEL_ID,
        principalId: AGENT_PRINCIPAL_ID,
        revision: 1,
        status: "active",
        workspaceId: WORKSPACE_ID,
      },
      workspaceMembership: {
        principalId: AGENT_PRINCIPAL_ID,
        revision: 3,
        role: "agent",
        status: "active",
        workspaceId: WORKSPACE_ID,
      },
    },
    context: {
      channelId: CHANNEL_ID,
      scope: "current-channel",
      threadId: null,
    },
    instructions: [
      {
        id: "task",
        revision: 2,
        source: sourceRef(
          records.find((record) => record.stream === CONFIG_STREAM),
        ),
        text: "Answer from cited context only.",
      },
    ],
    policy: {
      includePrivate: false,
      includeThreadHistory: true,
      maxAttachmentBytes: 64_000,
      maxBytes: 20_000,
      maxEstimatedTokens: 4_000,
      maxHistoryDepth: 100,
      maxItems: 8,
      maxMessages: 2,
      workspaceInputPaths: ["docs"],
    },
    sourceHeads,
    sourceRecords: records,
    trigger: {
      channelId: CHANNEL_ID,
      messageId: "root",
      source: sourceRef(records[0]),
      threadId: null,
    },
    workspaceId: WORKSPACE_ID,
    workspaceInputs: [
      {
        bytes: 11,
        digest: `sha256:${"1".repeat(64)}`,
        path: "docs/readme.md",
        source: sourceRef(
          records.find((record) => record.stream === DIRECTORY_STREAM),
        ),
        text: "hello docs",
      },
    ],
  };
  return { input, records };
}

function sourceEvent(eventType, actorId, suffix, data) {
  return issueEventEnvelope(
    {
      actorId,
      causation: null,
      correlationId: `cr_${suffix.repeat(26)}`,
      data,
      eventType,
      idempotencyKey: `ik_${suffix.repeat(26)}`,
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
    },
    {
      clock: () =>
        new Date(`2026-08-07T00:00:0${suffix === "a" ? "1" : "2"}.000Z`),
      eventId: `ev_${suffix.repeat(26)}`,
    },
  );
}

function sourceRef(record) {
  return {
    digest: digestEventEnvelope(record.event),
    offset: record.offset,
    stream: record.stream,
  };
}

function offset(number) {
  return `${number.toString(16).padStart(16, "0")}_${"0".repeat(16)}`;
}
