import {
  stampConversationActor,
  validateChannelId,
  validatePrincipalId,
  validateWorkspaceId,
} from "@stream-slack/protocol";

export const CONVERSATION_AUTH_ERROR_CODES = Object.freeze({
  ACCESS_DENIED: "CONVERSATION_ACCESS_DENIED",
  CHANNEL_ARCHIVED: "CONVERSATION_CHANNEL_ARCHIVED",
  CHANNEL_NOT_FOUND: "CONVERSATION_CHANNEL_NOT_FOUND",
  MESSAGE_NOT_FOUND: "CONVERSATION_MESSAGE_NOT_FOUND",
  MESSAGE_NOT_AUTHOR: "CONVERSATION_MESSAGE_NOT_AUTHOR",
  MESSAGE_DUPLICATE: "CONVERSATION_MESSAGE_DUPLICATE",
  REVISION_CONFLICT: "CONVERSATION_REVISION_CONFLICT",
  MODERATOR_REQUIRED: "CONVERSATION_MODERATOR_REQUIRED",
  ROOT_INVALID: "CONVERSATION_ROOT_INVALID",
  MEMBERSHIP_INACTIVE: "CONVERSATION_MEMBERSHIP_INACTIVE",
});

export class ConversationAuthorizationError extends Error {
  constructor(code, detail, { statusCode = 403 } = {}) {
    super(`${code}: ${detail}`);
    this.name = "ConversationAuthorizationError";
    this.code = code;
    this.detail = detail;
    this.statusCode = statusCode;
  }

  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      statusCode: this.statusCode,
    };
  }
}

export function authorizeConversationCommand({
  actorId,
  operation,
  payload,
  state,
  workspaceId,
}) {
  try {
    validateWorkspaceId(workspaceId);
    validatePrincipalId(actorId, { expectedWorkspaceId: workspaceId });
    const prepared = stampConversationActor(
      { operation, payload },
      actorId,
      workspaceId,
    );
    const channel = get(state?.entities?.channels, payload.channelId);
    if (!channel || channel.workspaceId !== workspaceId) {
      throw new ConversationAuthorizationError(
        CONVERSATION_AUTH_ERROR_CODES.CHANNEL_NOT_FOUND,
        "conversation channel is not visible in this workspace",
        { statusCode: 404 },
      );
    }
    validateChannelId(channel.channelId, { expectedWorkspaceId: workspaceId });
    if (channel.status !== "active") {
      throw new ConversationAuthorizationError(
        CONVERSATION_AUTH_ERROR_CODES.CHANNEL_ARCHIVED,
        "archived channels do not accept conversation commands",
      );
    }
    requireActiveMembership(state, workspaceId, channel.channelId, actorId);

    const messages = state.entities.messages ?? {};
    if (operation === "channel.message.create") {
      if (get(messages, payload.messageId)) {
        throw new ConversationAuthorizationError(
          CONVERSATION_AUTH_ERROR_CODES.MESSAGE_DUPLICATE,
          "message id is already present in this channel",
          { statusCode: 409 },
        );
      }
      return Object.freeze({
        ...prepared,
        capability: "channel.message.write",
      });
    }
    if (operation === "channel.message.reply") {
      const root = get(messages, payload.rootMessageId);
      if (
        !root ||
        (root.workspaceId ?? workspaceId) !== workspaceId ||
        root.channelId !== payload.channelId ||
        root.status === "deleted" ||
        (root.rootMessageId !== undefined && root.rootMessageId !== null)
      ) {
        throw new ConversationAuthorizationError(
          CONVERSATION_AUTH_ERROR_CODES.ROOT_INVALID,
          "reply root must be a visible root in the same workspace and channel",
        );
      }
      if (get(messages, payload.messageId)) {
        throw new ConversationAuthorizationError(
          CONVERSATION_AUTH_ERROR_CODES.MESSAGE_DUPLICATE,
          "message id is already present in this channel",
          { statusCode: 409 },
        );
      }
      return Object.freeze({
        ...prepared,
        capability: "channel.message.reply",
      });
    }

    const message = get(messages, payload.messageId);
    if (
      !message ||
      (message.workspaceId ?? workspaceId) !== workspaceId ||
      message.channelId !== payload.channelId
    ) {
      throw new ConversationAuthorizationError(
        CONVERSATION_AUTH_ERROR_CODES.MESSAGE_NOT_FOUND,
        "message is not visible in this workspace and channel",
        { statusCode: 404 },
      );
    }
    if (operation === "channel.message.edit" && message.authorId !== actorId) {
      throw new ConversationAuthorizationError(
        CONVERSATION_AUTH_ERROR_CODES.MESSAGE_NOT_AUTHOR,
        "only the message author may edit",
      );
    }
    if (
      (operation === "channel.message.edit" ||
        operation === "channel.message.delete") &&
      payload.expectedRevision !== (message.revision ?? 1)
    ) {
      throw new ConversationAuthorizationError(
        CONVERSATION_AUTH_ERROR_CODES.REVISION_CONFLICT,
        `message revision ${payload.expectedRevision} is not current`,
        { statusCode: 409 },
      );
    }
    if (
      operation === "channel.message.delete" &&
      message.authorId !== actorId &&
      !isModerator(state, channel, actorId)
    ) {
      throw new ConversationAuthorizationError(
        CONVERSATION_AUTH_ERROR_CODES.MODERATOR_REQUIRED,
        "delete requires the author or an active channel moderator",
      );
    }
    if (
      message.status === "deleted" &&
      operation !== "channel.reaction.remove"
    ) {
      throw new ConversationAuthorizationError(
        CONVERSATION_AUTH_ERROR_CODES.ACCESS_DENIED,
        "deleted messages cannot be mutated",
      );
    }
    return Object.freeze({
      ...prepared,
      capability:
        operation === "channel.message.edit"
          ? "channel.message.edit"
          : operation === "channel.message.delete"
            ? "channel.message.delete"
            : "channel.reaction",
    });
  } catch (error) {
    if (error instanceof ConversationAuthorizationError) throw error;
    throw new ConversationAuthorizationError(
      CONVERSATION_AUTH_ERROR_CODES.ACCESS_DENIED,
      error instanceof Error ? (error.detail ?? error.message) : String(error),
      { statusCode: 400 },
    );
  }
}

export function createConversationAuthorization({
  lookupState,
  withChannelFence,
} = {}) {
  if (typeof lookupState !== "function") {
    throw new TypeError("conversation authorization requires lookupState");
  }
  const fence =
    withChannelFence ??
    (async (_context, operation) => {
      if (typeof operation !== "function") {
        throw new TypeError("conversation authorization requires an operation");
      }
      return operation();
    });

  async function authorizeDispatch(request, context = {}) {
    const channelId = request?.payload?.channelId;
    const state = await lookupState(request.workspaceId, channelId);
    return fence(
      {
        channelId,
        principalId: request.actorId,
        workspaceId: request.workspaceId,
        ...context,
      },
      () =>
        authorizeConversationCommand({
          actorId: request.actorId,
          operation: request.operation,
          payload: request.payload,
          state,
          workspaceId: request.workspaceId,
        }),
    );
  }

  return Object.freeze({ authorizeDispatch });
}

export function prepareConversationEvent({
  actorId,
  operation,
  payload,
  state,
  workspaceId,
}) {
  return authorizeConversationCommand({
    actorId,
    operation,
    payload,
    state,
    workspaceId,
  });
}

function requireActiveMembership(state, workspaceId, channelId, principalId) {
  const workspaceMembership = get(
    state.entities.memberships,
    membershipIdFor(workspaceId, principalId),
  );
  const channelMembership = get(
    state.entities.channelMemberships,
    `${channelId}\u0000${principalId}`,
  );
  if (
    workspaceMembership?.status !== "active" ||
    channelMembership?.status !== "active"
  ) {
    throw new ConversationAuthorizationError(
      CONVERSATION_AUTH_ERROR_CODES.MEMBERSHIP_INACTIVE,
      "an active workspace and channel membership is required",
    );
  }
}

function isModerator(state, channel, principalId) {
  const channelMembership = get(
    state.entities.channelMemberships,
    `${channel.channelId}\u0000${principalId}`,
  );
  const workspaceMembership = get(
    state.entities.memberships,
    membershipIdFor(channel.workspaceId, principalId),
  );
  return Boolean(
    channelMembership?.status === "active" &&
    workspaceMembership?.status === "active" &&
    (channel.creatorId === principalId ||
      ["owner", "admin"].includes(workspaceMembership.role)),
  );
}

function membershipIdFor(workspaceId, principalId) {
  return `mb_${workspaceId.slice(3)}_${principalId.slice(30)}`;
}

function get(map, key) {
  if (!map || typeof map !== "object") return undefined;
  return Object.entries(map).find(([entryKey]) => entryKey === key)?.[1];
}
