import {
  createEditedMessage,
  createMessageRecord,
  httpError,
  messageOwnedBy,
  normalizeMessageId,
  normalizeRoomId,
} from "@stream-slack/protocol";

export function createChatService({ streamStore, randomId, now }) {
  async function appendMessage(roomId, input, user) {
    const message = createMessageRecord({
      roomId,
      input,
      user,
      id: randomId(),
      timestamp: now(),
    });
    return streamStore.append(roomId, message);
  }

  async function updateMessage(roomId, rawMessageId, input, user) {
    const messageId = normalizeMessageId(rawMessageId);
    const current = (await streamStore.read(roomId, "-1")).records.findLast(
      (record) => record?.id === messageId,
    );
    if (!current) throw httpError(404, "Message not found");
    if (!messageOwnedBy(current, user)) {
      throw httpError(403, "You can only edit your own messages");
    }
    return streamStore.append(
      roomId,
      createEditedMessage({ current, messageId, input, timestamp: now() }),
    );
  }

  async function resetRoom(roomId) {
    await streamStore.remove(roomId);
    await streamStore.ensure(roomId);
  }

  return {
    appendMessage,
    ensureStream: streamStore.ensure,
    normalizeRoomId,
    readMessages: streamStore.read,
    resetRoom,
    updateMessage,
  };
}
