import {
  createEditedMessage,
  createMessageRecord,
  httpError,
  messageOwnedBy,
  normalizeMessageId,
  normalizeRoomId,
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

  async function appendMessage(roomId, input, user, { idempotencyKey } = {}) {
    const messageId = randomId();
    const message = createMessageRecord({
      roomId,
      input,
      user,
      id: messageId,
      timestamp: now(),
    });
    const snapshot = await streamStore.read(roomId, "-1");
    const result = await dispatch({
      actorId: String(user.sub ?? ""),
      expectedHead: snapshot.nextOffset,
      idempotencyKey: idempotencyKey ?? toIdempotencyKey(messageId),
      operation: "chat.message.create",
      payload: message,
      stream: normalizeRoomId(roomId),
      workspaceId,
    });
    return {
      message: projectMessage(result.event ?? message),
      nextOffset: result.receipt.nextOffset,
      receipt: result.receipt,
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
    const snapshot = await streamStore.read(roomId, "-1");
    const current = snapshot.records.findLast(
      (record) => record?.id === messageId,
    );
    if (!current) throw httpError(404, "Message not found");
    if (!messageOwnedBy(current, user)) {
      throw httpError(403, "You can only edit your own messages");
    }
    const edited = createEditedMessage({
      current: withoutDispatch(current),
      messageId,
      input,
      timestamp: now(),
    });
    const result = await dispatch({
      actorId: String(user.sub ?? ""),
      expectedHead: snapshot.nextOffset,
      idempotencyKey: idempotencyKey ?? toIdempotencyKey(randomId()),
      operation: "chat.message.edit",
      payload: edited,
      stream: normalizeRoomId(roomId),
      workspaceId,
    });
    return {
      message: projectMessage(result.event ?? edited),
      nextOffset: result.receipt.nextOffset,
      receipt: result.receipt,
    };
  }

  async function resetRoom(roomId) {
    await streamStore.remove(roomId);
    await streamStore.ensure(roomId);
  }

  return {
    appendMessage,
    closeStreams: streamStore.close,
    ensureStream: streamStore.ensure,
    followMessages: streamStore.follow,
    normalizeRoomId,
    readMessages: streamStore.read,
    resetRoom,
    updateMessage,
  };
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

function toIdempotencyKey(value) {
  const token = String(value)
    .replaceAll("-", "")
    .replace(/[^0-9a-hjkmnp-tv-z]/gu, "a")
    .slice(0, 26)
    .padEnd(26, "0");
  return `ik_${token}`;
}
