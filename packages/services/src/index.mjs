import {
  createEditedMessage,
  createMessageRecord,
  httpError,
  messageOwnedBy,
  normalizeMessageId,
  normalizeRoomId,
  normalizeMessageText,
} from "@stream-slack/protocol";

export function createChatService({
  streamStore,
  randomId,
  now,
  dispatch,
  workspaceId,
}) {
  if (typeof dispatch !== "function") {
    throw new TypeError("chat service requires the application dispatch door");
  }

  const requestSeeds = new Map();

  async function appendMessage(roomId, input, user, { idempotencyKey } = {}) {
    const stream = normalizeRoomId(roomId);
    const actorId = String(user.sub ?? "");
    const text = normalizeMessageText(input.text);
    const messageId = randomId();
    const requestKey = idempotencyKey ?? toIdempotencyKey(messageId);
    const snapshot = await streamStore.read(roomId, "-1");
    assertRoomActive(snapshot.records);
    const existing = idempotencyKey
      ? findExistingMessage(snapshot.records, {
          actorId,
          idempotencyKey,
          operation: "chat.message.create",
          room: stream,
          text,
        })
      : null;
    const seedKey = requestSeedKey({
      actorId,
      idempotencyKey: requestKey,
      operation: "chat.message.create",
      stream,
      text,
      workspaceId,
    });
    const message =
      existing ??
      requestSeeds.get(seedKey) ??
      createMessageRecord({
        roomId,
        input: { ...input, text },
        user,
        id: messageId,
        timestamp: now(),
      });
    if (idempotencyKey && !existing) requestSeeds.set(seedKey, message);

    try {
      const result = await dispatch({
        actorId,
        expectedHead: snapshot.nextOffset,
        idempotencyKey: requestKey,
        operation: "chat.message.create",
        payload: message,
        stream,
        workspaceId,
      });
      return {
        message: projectMessage(result.event ?? message),
        nextOffset: result.receipt.nextOffset,
        receipt: result.receipt,
      };
    } finally {
      if (requestSeeds.get(seedKey) === message) requestSeeds.delete(seedKey);
    }
  }

  async function archiveRoom(roomId, user, { idempotencyKey } = {}) {
    const stream = normalizeRoomId(roomId);
    const snapshot = await streamStore.read(stream, "-1");
    if (snapshot.records.some(isRoomArchivedRecord)) {
      return {
        archived: true,
        nextOffset: snapshot.nextOffset,
        receipt: { nextOffset: snapshot.nextOffset, replayed: true },
      };
    }
    const requestKey = idempotencyKey ?? toIdempotencyKey(randomId());
    const result = await dispatch({
      actorId: String(user?.sub ?? ""),
      expectedHead: snapshot.nextOffset,
      idempotencyKey: requestKey,
      operation: "chat.room.archived",
      payload: { kind: "room.archived", room: stream },
      stream,
      workspaceId,
    });
    return {
      archived: true,
      nextOffset: result.receipt.nextOffset,
      receipt: result.receipt,
    };
  }

  async function readMessages(roomId, offset = "-1", options) {
    const result = await streamStore.read(roomId, offset, options);
    return {
      ...result,
      roomArchived: result.records.some(isRoomArchivedRecord),
    };
  }

  async function readRoomStatus(roomId, options) {
    const result = await streamStore.read(roomId, "-1", options);
    return {
      archived: result.records.some(isRoomArchivedRecord),
      nextOffset: result.nextOffset,
      streamDigest: result.streamDigest,
    };
  }

  async function updateMessage(
    roomId,
    rawMessageId,
    input,
    user,
    { idempotencyKey } = {},
  ) {
    const messageId = normalizeMessageId(rawMessageId);
    const stream = normalizeRoomId(roomId);
    const actorId = String(user.sub ?? "");
    const text = normalizeMessageText(input.text);
    const snapshot = await streamStore.read(roomId, "-1");
    assertRoomActive(snapshot.records);
    const current = snapshot.records.findLast(
      (record) => record?.id === messageId,
    );
    if (!current) throw httpError(404, "Message not found");
    if (!messageOwnedBy(current, user)) {
      throw httpError(403, "You can only edit your own messages");
    }
    const requestKey = idempotencyKey ?? toIdempotencyKey(randomId());
    const existing = idempotencyKey
      ? findExistingMessage(snapshot.records, {
          actorId,
          idempotencyKey,
          messageId,
          operation: "chat.message.edit",
          room: stream,
          text,
        })
      : null;
    const seedKey = requestSeedKey({
      actorId,
      idempotencyKey: requestKey,
      messageId,
      operation: "chat.message.edit",
      stream,
      text,
      workspaceId,
    });
    const edited =
      existing ??
      requestSeeds.get(seedKey) ??
      createEditedMessage({
        current: withoutDispatch(current),
        messageId,
        input: { ...input, text },
        timestamp: now(),
      });
    if (idempotencyKey && !existing) requestSeeds.set(seedKey, edited);

    try {
      const result = await dispatch({
        actorId,
        expectedHead: snapshot.nextOffset,
        idempotencyKey: requestKey,
        operation: "chat.message.edit",
        payload: edited,
        stream,
        workspaceId,
      });
      return {
        message: projectMessage(result.event ?? edited),
        nextOffset: result.receipt.nextOffset,
        receipt: result.receipt,
      };
    } finally {
      if (requestSeeds.get(seedKey) === edited) requestSeeds.delete(seedKey);
    }
  }

  async function resetRoom(roomId, user, { idempotencyKey } = {}) {
    const stream = normalizeRoomId(roomId);
    const snapshot = await streamStore.read(stream, "-1");
    assertRoomActive(snapshot.records);
    const requestKey = idempotencyKey ?? toIdempotencyKey(randomId());
    const result = await dispatch({
      actorId: String(user?.sub ?? ""),
      expectedHead: snapshot.nextOffset,
      idempotencyKey: requestKey,
      operation: "chat.room.reset",
      payload: { kind: "room.reset", room: stream },
      stream,
      workspaceId,
    });
    const after = await streamStore.read(stream, "-1");
    return {
      nextOffset: result.receipt.nextOffset,
      receipt: result.receipt,
      streamDigest: after.streamDigest ?? null,
    };
  }

  return {
    appendMessage,
    archiveRoom,
    closeStreams: streamStore.close,
    ensureStream: streamStore.ensure,
    followMessages: streamStore.follow,
    normalizeRoomId,
    readMessages,
    readRoomStatus,
    resetRoom,
    updateMessage,
  };
}

function isRoomArchivedRecord(record) {
  return record?.dispatch?.operation === "chat.room.archived";
}

function assertRoomActive(records) {
  if (records.some(isRoomArchivedRecord)) {
    const error = httpError(409, "chat channel is archived");
    error.code = "CHAT_ROOM_ARCHIVED";
    throw error;
  }
}

function projectMessage(record) {
  if (!record || typeof record !== "object") return record;
  const message = { ...record };
  delete message.dispatch;
  return message;
}

function withoutDispatch(record) {
  if (!record || typeof record !== "object") return record;
  const message = { ...record };
  delete message.dispatch;
  return message;
}

function findExistingMessage(records, expected) {
  const record = records.findLast(
    (candidate) =>
      candidate?.dispatch?.idempotencyKey === expected.idempotencyKey &&
      candidate.dispatch.operation === expected.operation,
  );
  if (
    !record ||
    record.room !== expected.room ||
    record.actorId !== expected.actorId ||
    record.text !== expected.text ||
    (expected.messageId !== undefined && record.id !== expected.messageId)
  ) {
    return null;
  }
  return withoutDispatch(record);
}

function requestSeedKey({
  actorId,
  idempotencyKey,
  messageId,
  operation,
  stream,
  text,
  workspaceId,
}) {
  return JSON.stringify([
    actorId,
    idempotencyKey,
    messageId ?? null,
    operation,
    stream,
    text,
    workspaceId,
  ]);
}

function toIdempotencyKey(value) {
  const token = String(value)
    .replaceAll("-", "")
    .replace(/[^0-9a-hjkmnp-tv-z]/gu, "a")
    .slice(0, 26)
    .padEnd(26, "0");
  return `ik_${token}`;
}
