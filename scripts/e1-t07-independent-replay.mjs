import {
  canonicalStateDigest,
  createInitialState,
  reduceEnvelope,
} from "@stream-slack/reducers";

const ROW_KINDS = [
  "workspace",
  "directory",
  "principal",
  "membership",
  "channel",
  "channelMembership",
  "message",
  "thread",
  "reaction",
  "unread",
];

export function replayIndependentPrefixes(records, workspaceId) {
  let state = createInitialState();
  const prefixes = [];
  for (const [index, record] of records.entries()) {
    state = reduceEnvelope(state, record.event, {
      offset: independentOffset(index + 1),
    });
    prefixes.push({
      rows: independentProjection(state, workspaceId),
      sequence: index + 1,
      stateDigest: canonicalStateDigest(state),
    });
  }
  return prefixes;
}

export function independentProjection(state, workspaceId) {
  const rows = emptyRows();
  addMapRows(rows, "workspace", state.entities.workspaces, workspaceId);
  addMapRows(rows, "directory", state.entities.directory, workspaceId);
  addMapRows(rows, "principal", state.entities.principals, workspaceId);
  addMapRows(rows, "membership", state.entities.memberships, workspaceId);
  addMapRows(rows, "channel", state.entities.channels, workspaceId);
  addMapRows(
    rows,
    "channelMembership",
    state.entities.channelMemberships,
    workspaceId,
  );
  addMapRows(rows, "message", state.entities.messages, workspaceId);
  addMapRows(rows, "reaction", state.entities.reactions, workspaceId);

  const messages = Object.values(state.entities.messages ?? {}).filter(
    (message) => message.workspaceId === workspaceId,
  );
  const threads = new Map();
  for (const message of messages) {
    const rootMessageId = message.rootMessageId ?? message.messageId;
    const thread = threads.get(rootMessageId) ?? {
      channelId: message.channelId,
      messageIds: [],
      rootMessageId,
    };
    thread.messageIds.push(message.messageId);
    threads.set(rootMessageId, thread);
  }
  for (const thread of threads.values()) {
    thread.messageIds.sort();
    addLogicalRow(rows, "thread", thread.rootMessageId, thread, workspaceId);
  }

  const memberships = Object.values(state.entities.memberships ?? {}).filter(
    (membership) =>
      membership.workspaceId === workspaceId && membership.status === "active",
  );
  const channels = Object.values(state.entities.channels ?? {}).filter(
    (channel) =>
      channel.workspaceId === workspaceId && channel.status === "active",
  );
  const channelMemberships = state.entities.channelMemberships ?? {};
  for (const membership of memberships) {
    for (const channel of channels) {
      const channelMembership =
        channelMemberships[
          `${channel.channelId}\u0000${membership.principalId}`
        ];
      if (channel.kind !== "public" && channelMembership?.status !== "active")
        continue;
      const unreadMessages = messages.filter(
        (message) =>
          message.channelId === channel.channelId &&
          message.status !== "deleted" &&
          message.authorId !== membership.principalId,
      );
      addLogicalRow(
        rows,
        "unread",
        `${channel.channelId}\u0000${membership.principalId}`,
        {
          channelId: channel.channelId,
          count: unreadMessages.length,
          principalId: membership.principalId,
        },
        workspaceId,
      );
    }
  }

  for (const kind of ROW_KINDS) {
    rows[kind].sort((left, right) => `${left.id}`.localeCompare(`${right.id}`));
  }
  return rows;
}

function addMapRows(rows, kind, values, workspaceId) {
  for (const [id, value] of Object.entries(values ?? {})) {
    if (value?.workspaceId !== undefined && value.workspaceId !== workspaceId)
      continue;
    addLogicalRow(rows, kind, id, value, workspaceId);
  }
}

function addLogicalRow(rows, kind, id, value, workspaceId) {
  rows[kind].push({
    id,
    kind,
    value: structuredClone(value),
    workspaceId,
  });
}

function emptyRows() {
  return Object.fromEntries(ROW_KINDS.map((kind) => [kind, []]));
}

function independentOffset(sequence) {
  return `0000000000000000_${sequence.toString(16).padStart(16, "0")}`;
}
