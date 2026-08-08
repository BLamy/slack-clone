export const ZERO_OFFSET = "0000000000000000_0000000000000000";
export const DEFAULT_CHAT_PATH = "/app?room=demo";

export * from "./principals.mjs";
export * from "./channels.mjs";
export * from "./messages.mjs";
export * from "./mentions.mjs";
export * from "./workspace.mjs";
export * from "./provider-registry.mjs";
export * from "./agent-config.mjs";
export * from "./agent-config-revisions.mjs";
export * from "./agent-administration.mjs";
export * from "./agent-roster.mjs";
export * from "./invocation-snapshot.mjs";
export * from "./invocation-run.mjs";
export * from "./run-queue.mjs";
export * from "./conversation-scheduling.mjs";
export * from "./run-control.mjs";

export function normalizeRoomId(roomId) {
  const normalized = String(roomId)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "durable-streams-demo";
}

export function normalizeMessageId(messageId) {
  const id = String(messageId ?? "").trim();
  if (!id) throw httpError(400, "Message id is required");
  return id;
}

export function normalizeMessageText(value) {
  const text = String(value ?? "")
    .trim()
    .slice(0, 2000);
  if (!text) throw httpError(400, "Message text is required");
  return text;
}

export function createMessageRecord({ roomId, input, user, id, timestamp }) {
  return {
    id,
    room: normalizeRoomId(roomId),
    actorId: String(user.sub ?? ""),
    user: String(user.name ?? user.email ?? "authenticated user").slice(0, 80),
    email: String(user.email ?? ""),
    text: normalizeMessageText(input.text),
    createdAt: timestamp,
  };
}

export function messageOwnedBy(record, user) {
  return typeof record.actorId === "string" && record.actorId.length > 0
    ? record.actorId === user.sub
    : typeof record.email === "string" &&
        record.email.length > 0 &&
        record.email === user.email;
}

export function createEditedMessage({ current, messageId, input, timestamp }) {
  return {
    ...current,
    id: messageId,
    text: normalizeMessageText(input.text),
    editedAt: timestamp,
  };
}

export function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
