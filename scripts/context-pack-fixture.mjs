import {
  digestEventEnvelope,
  issueEventEnvelope,
} from "../src/ledger/envelope.mjs";

export const CONTEXT_PACK_FIXTURE = Object.freeze({
  workspaceId: "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  channelId: "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb",
  siblingChannelId: "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc",
  agentId: "ag_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd",
  agentPrincipalId: "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd",
  authorId: "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_eeeeeeeeeeeeeeeeeeeeeeeeee",
  adminId: "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_ffffffffffffffffffffffffff",
});

export function buildContextPackFixture({ maxMessages = 2 } = {}) {
  const {
    adminId,
    agentId,
    channelId,
    siblingChannelId,
    workspaceId,
    authorId,
    agentPrincipalId,
  } = CONTEXT_PACK_FIXTURE;
  const configStream = `agent:${agentId}/config`;
  const directoryStream = `workspace:${workspaceId}/directory`;
  const channelStream = `channel:${channelId}`;
  const records = [
    record(channelStream, 1, "channel.message.created", authorId, {
      authorId,
      channelId,
      contentType: "text/plain",
      messageId: "root",
      rootMessageId: null,
      text: "Trigger message",
    }),
    record(channelStream, 2, "channel.message.replied", authorId, {
      authorId,
      channelId,
      contentType: "text/plain",
      messageId: "reply",
      rootMessageId: "root",
      text: "Nearby reply",
    }),
    record(channelStream, 3, "channel.message.created", authorId, {
      authorId,
      channelId,
      contentType: "text/plain",
      messageId: "old",
      rootMessageId: null,
      text: "Older history",
    }),
    record(configStream, 4, "agent.config.revised", adminId, {
      agentId,
      revision: 2,
    }),
    record(directoryStream, 5, "workspace.directory.updated", adminId, {
      revision: 4,
    }),
    record(
      `channel:${siblingChannelId}`,
      6,
      "channel.message.created",
      authorId,
      {
        authorId,
        channelId: siblingChannelId,
        contentType: "text/plain",
        messageId: "sibling",
        rootMessageId: null,
        text: "sibling-canary",
      },
    ),
  ];
  const sourceHeads = [configStream, directoryStream, channelStream].map(
    (stream) =>
      sourceRef(
        records.filter((candidate) => candidate.stream === stream).at(-1),
      ),
  );
  const input = {
    agentId,
    authorization: {
      channel: {
        channelId,
        kind: "public",
        revision: 2,
        status: "active",
        workspaceId,
      },
      channelMembership: {
        channelId,
        principalId: agentPrincipalId,
        revision: 1,
        status: "active",
        workspaceId,
      },
      workspaceMembership: {
        principalId: agentPrincipalId,
        revision: 3,
        role: "agent",
        status: "active",
        workspaceId,
      },
    },
    context: { channelId, scope: "current-channel", threadId: null },
    instructions: [
      {
        id: "task",
        revision: 2,
        source: sourceRef(
          records.find((record) => record.stream === configStream),
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
      maxMessages,
      workspaceInputPaths: ["docs"],
    },
    sourceHeads,
    sourceRecords: records,
    trigger: {
      channelId,
      messageId: "root",
      source: sourceRef(records[0]),
      threadId: null,
    },
    workspaceId,
    workspaceInputs: [
      {
        bytes: 11,
        digest: `sha256:${"1".repeat(64)}`,
        path: "docs/readme.md",
        source: sourceRef(
          records.find((record) => record.stream === directoryStream),
        ),
        text: "hello docs",
      },
    ],
  };
  return { input, records, sourceHeads };
}

function record(stream, sequence, eventType, actorId, data) {
  const suffix = String.fromCharCode(96 + sequence);
  const event = issueEventEnvelope(
    {
      actorId,
      causation: null,
      correlationId: `cr_${suffix.repeat(26)}`,
      data,
      eventType,
      idempotencyKey: `ik_${suffix.repeat(26)}`,
      schemaVersion: 1,
      workspaceId: CONTEXT_PACK_FIXTURE.workspaceId,
    },
    {
      clock: () => new Date(`2026-08-07T00:00:0${sequence}.000Z`),
      eventId: `ev_${suffix.repeat(26)}`,
    },
  );
  return { event, offset: offset(sequence), stream };
}

function sourceRef(record) {
  return {
    digest: digestEventEnvelope(record.event),
    offset: record.offset,
    stream: record.stream,
  };
}

function offset(sequence) {
  return `${sequence.toString(16).padStart(16, "0")}_${"0".repeat(16)}`;
}
