import { validateChannelId } from "./channels.mjs";
import { validatePrincipalId } from "./principals.mjs";

export const MESSAGE_SCHEMA_VERSION = 1;

export const MESSAGE_CONTENT_TYPES = Object.freeze(["text/plain"]);

export const MESSAGE_EVENT_TYPES_V1 = Object.freeze([
  "channel.message.created",
  "channel.message.replied",
  "channel.message.edited",
  "channel.message.deleted",
  "channel.message.reaction.added",
  "channel.message.reaction.removed",
]);

export const MESSAGE_MAX_TEXT_LENGTH = 4_000;
export const MESSAGE_MAX_REACTION_LENGTH = 64;

export const MESSAGE_COMMANDS = Object.freeze({
  "channel.message.create": "channel.message.created",
  "channel.message.reply": "channel.message.replied",
  "channel.message.edit": "channel.message.edited",
  "channel.message.delete": "channel.message.deleted",
  "channel.reaction.add": "channel.message.reaction.added",
  "channel.reaction.remove": "channel.message.reaction.removed",
});

export const MESSAGE_ERROR_CODES = Object.freeze({
  CONTROL_CHARACTER: "MESSAGE_CONTROL_CHARACTER",
  INVALID_CONTENT_TYPE: "MESSAGE_INVALID_CONTENT_TYPE",
  INVALID_REACTION: "MESSAGE_INVALID_REACTION",
  INVALID_TEXT: "MESSAGE_INVALID_TEXT",
  INVALID_UNICODE: "MESSAGE_INVALID_UNICODE",
  TEXT_TOO_LARGE: "MESSAGE_TEXT_TOO_LARGE",
});

const BIDI_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export class MessageValidationError extends Error {
  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      name: this.name,
      path: this.path,
    };
  }
}

export function messageError(code, path, detail) {
  const error = new MessageValidationError(`${code} at ${path}: ${detail}`);
  error.name = "MessageValidationError";
  error.code = code;
  error.path = path;
  error.detail = detail;
  return error;
}

export function normalizeConversationText(value, path = "$.text") {
  if (typeof value !== "string") {
    throw messageError(
      MESSAGE_ERROR_CODES.INVALID_TEXT,
      path,
      "message text must be a string",
    );
  }
  assertUnicode(value, path);
  const normalized = value.normalize("NFC");
  if (normalized.length === 0) {
    throw messageError(
      MESSAGE_ERROR_CODES.INVALID_TEXT,
      path,
      "message text must not be empty",
    );
  }
  if (normalized.length > MESSAGE_MAX_TEXT_LENGTH) {
    throw messageError(
      MESSAGE_ERROR_CODES.TEXT_TOO_LARGE,
      path,
      `message text must be at most ${MESSAGE_MAX_TEXT_LENGTH} code units`,
    );
  }
  for (const character of normalized) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint <= 31 ||
      (codePoint >= 128 && codePoint <= 159) ||
      codePoint === 127 ||
      BIDI_CONTROL_PATTERN.test(character)
    ) {
      throw messageError(
        MESSAGE_ERROR_CODES.CONTROL_CHARACTER,
        path,
        "message text must not contain control or bidi formatting characters",
      );
    }
  }
  return normalized;
}

export function validateConversationText(value, path = "$.text") {
  const normalized = normalizeConversationText(value, path);
  if (value !== normalized) {
    throw messageError(
      MESSAGE_ERROR_CODES.INVALID_UNICODE,
      path,
      "message text must be NFC-normalized before append",
    );
  }
  return value;
}

export function validateMessageContentType(value, path = "$.contentType") {
  if (typeof value !== "string" || !MESSAGE_CONTENT_TYPES.includes(value)) {
    throw messageError(
      MESSAGE_ERROR_CODES.INVALID_CONTENT_TYPE,
      path,
      "conversation messages accept only text/plain",
    );
  }
  return value;
}

export function normalizeReactionName(value, path = "$.emoji") {
  if (typeof value !== "string") {
    throw messageError(
      MESSAGE_ERROR_CODES.INVALID_REACTION,
      path,
      "reaction name must be a string",
    );
  }
  assertUnicode(value, path);
  const normalized = value.normalize("NFC");
  if (
    normalized.length === 0 ||
    normalized.length > MESSAGE_MAX_REACTION_LENGTH ||
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint <= 31 ||
        (codePoint >= 128 && codePoint <= 159) ||
        codePoint === 127 ||
        BIDI_CONTROL_PATTERN.test(character)
      );
    })
  ) {
    throw messageError(
      MESSAGE_ERROR_CODES.INVALID_REACTION,
      path,
      `reaction name must be 1-${MESSAGE_MAX_REACTION_LENGTH} printable NFC characters`,
    );
  }
  if (value !== normalized) {
    throw messageError(
      MESSAGE_ERROR_CODES.INVALID_UNICODE,
      path,
      "reaction name must be NFC-normalized before append",
    );
  }
  return normalized;
}

export function validateMessageEventType(value, path = "$.eventType") {
  if (typeof value !== "string" || !MESSAGE_EVENT_TYPES_V1.includes(value)) {
    throw messageError(
      MESSAGE_ERROR_CODES.INVALID_TEXT,
      path,
      "event type is not registered for the conversation contract",
    );
  }
  return value;
}

export function validateConversationCommand(operation, payload, options = {}) {
  const eventType = eventTypeForOperation(operation);
  if (!eventType) {
    throw messageError(
      MESSAGE_ERROR_CODES.INVALID_TEXT,
      "$.operation",
      "conversation operation is not registered",
    );
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw messageError(
      MESSAGE_ERROR_CODES.INVALID_TEXT,
      "$.payload",
      "conversation command payload must be an object",
    );
  }
  const required = requiredKeysForOperation(operation);
  const allowed = new Set(required);
  for (const key of required) {
    if (!Object.hasOwn(payload, key)) {
      throw messageError(
        MESSAGE_ERROR_CODES.INVALID_TEXT,
        `$.payload.${key}`,
        `${key} is required`,
      );
    }
  }
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      throw messageError(
        MESSAGE_ERROR_CODES.INVALID_TEXT,
        `$.payload.${key}`,
        `${key} is not allowed; actor identity is server supplied`,
      );
    }
  }
  validateChannelId(payload.channelId, {
    expectedWorkspaceId: options.workspaceId,
    path: "$.payload.channelId",
  });
  if (
    typeof payload.messageId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,200}$/u.test(payload.messageId)
  ) {
    throw messageError(
      MESSAGE_ERROR_CODES.INVALID_TEXT,
      "$.payload.messageId",
      "messageId must be a bounded token",
    );
  }
  if (operation === "channel.message.create") {
    if (payload.rootMessageId !== null) {
      throw messageError(
        MESSAGE_ERROR_CODES.INVALID_TEXT,
        "$.payload.rootMessageId",
        "root message commands must use null rootMessageId",
      );
    }
  } else if (operation === "channel.message.reply") {
    if (
      typeof payload.rootMessageId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,200}$/u.test(payload.rootMessageId)
    ) {
      throw messageError(
        MESSAGE_ERROR_CODES.INVALID_TEXT,
        "$.payload.rootMessageId",
        "reply commands require a bounded root message id",
      );
    }
  }
  if (
    operation.includes("message.") &&
    operation !== "channel.message.delete"
  ) {
    validateMessageContentType(payload.contentType);
    validateConversationText(payload.text);
  }
  if (operation === "channel.message.delete") {
    assertPositiveRevision(payload.expectedRevision);
  }
  if (operation === "channel.message.edit") {
    assertPositiveRevision(payload.expectedRevision);
  }
  if (operation.includes("reaction.")) normalizeReactionName(payload.emoji);
  return Object.freeze({
    data: {
      ...payload,
      ...(operation.includes("message.") &&
      operation !== "channel.message.delete"
        ? { text: payload.text }
        : {}),
    },
    eventType,
    operation,
  });
}

export function stampConversationActor(command, actorId, workspaceId) {
  validatePrincipalId(actorId, { expectedWorkspaceId: workspaceId });
  const validated = validateConversationCommand(
    command.operation,
    command.payload,
    { workspaceId },
  );
  if (
    command.operation === "channel.message.create" ||
    command.operation === "channel.message.reply"
  ) {
    return {
      ...validated,
      data: { ...validated.data, authorId: actorId },
    };
  }
  return validated;
}

function assertUnicode(value, path) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        throw messageError(
          MESSAGE_ERROR_CODES.INVALID_UNICODE,
          path,
          "text contains an unpaired UTF-16 surrogate",
        );
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw messageError(
        MESSAGE_ERROR_CODES.INVALID_UNICODE,
        path,
        "text contains an unpaired UTF-16 surrogate",
      );
    }
  }
}

function eventTypeForOperation(operation) {
  switch (operation) {
    case "channel.message.create":
      return "channel.message.created";
    case "channel.message.reply":
      return "channel.message.replied";
    case "channel.message.edit":
      return "channel.message.edited";
    case "channel.message.delete":
      return "channel.message.deleted";
    case "channel.reaction.add":
      return "channel.message.reaction.added";
    case "channel.reaction.remove":
      return "channel.message.reaction.removed";
    default:
      return null;
  }
}

function requiredKeysForOperation(operation) {
  switch (operation) {
    case "channel.message.create":
    case "channel.message.reply":
      return ["channelId", "contentType", "messageId", "rootMessageId", "text"];
    case "channel.message.edit":
      return [
        "channelId",
        "contentType",
        "expectedRevision",
        "messageId",
        "text",
      ];
    case "channel.message.delete":
      return ["channelId", "expectedRevision", "messageId"];
    case "channel.reaction.add":
    case "channel.reaction.remove":
      return ["channelId", "emoji", "messageId"];
    default:
      return [];
  }
}

function assertPositiveRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw messageError(
      MESSAGE_ERROR_CODES.INVALID_TEXT,
      "$.payload.expectedRevision",
      "expectedRevision must be a positive integer",
    );
  }
}
