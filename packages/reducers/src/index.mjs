import {
  directChannelIdFor,
  normalizeReactionName,
  validateConversationText,
  validateMessageContentType,
} from "@stream-slack/protocol";

import {
  canonicalStateDigest,
  canonicalStateJson,
} from "./canonical-state.mjs";

export {
  canonicalStateDigest,
  canonicalStateJson,
  sha256Hex,
} from "./canonical-state.mjs";

export const REDUCER_SCHEMA_VERSION = 1;

export const REDUCER_EVENT_TYPES_V1 = Object.freeze([
  "ledger.fixture-recorded",
  "workspace.directory.updated",
  "channel.message.created",
  "channel.message.replied",
  "channel.message.edited",
  "channel.message.deleted",
  "channel.message.reaction.added",
  "channel.message.reaction.removed",
  "agent.config.revised",
  "workspace.invocation.requested",
  "run.lifecycle.changed",
  "connection.config.revised",
  "workspace.audit.recorded",
  "projection.checkpointed",
  "principal.created",
  "principal.profile.updated",
  "principal.suspended",
  "principal.deactivated",
  "channel.created",
  "channel.renamed",
  "channel.archived",
  "channel.unarchived",
  "channel.membership.invited",
  "channel.membership.joined",
  "channel.membership.left",
  "channel.membership.removed",
  "channel.direct.created",
  "workspace.created",
  "workspace.membership.invited",
  "workspace.membership.accepted",
  "workspace.membership.role.changed",
  "workspace.membership.suspended",
  "workspace.membership.removed",
]);

export const REDUCER_ERROR_CODES = Object.freeze({
  DUPLICATE_EVENT_ID: "REDUCER_DUPLICATE_EVENT_ID",
  DUPLICATE_LOGICAL_ID: "REDUCER_DUPLICATE_LOGICAL_ID",
  ILLEGAL_TRANSITION: "REDUCER_ILLEGAL_TRANSITION",
  INVALID_EVENT_DATA: "REDUCER_INVALID_EVENT_DATA",
  INVALID_OFFSET: "REDUCER_INVALID_OFFSET",
  LEGACY_COMPACT_REPLAY_REQUIRED: "REDUCER_LEGACY_COMPACT_REPLAY_REQUIRED",
  MALFORMED_ENVELOPE: "REDUCER_MALFORMED_ENVELOPE",
  OFFSET_REUSED: "REDUCER_OFFSET_REUSED",
  PRINCIPAL_DUPLICATE_SUBJECT: "REDUCER_PRINCIPAL_DUPLICATE_SUBJECT",
  PRINCIPAL_INVALID_KIND: "REDUCER_PRINCIPAL_INVALID_KIND",
  PRINCIPAL_INVALID_OWNER: "REDUCER_PRINCIPAL_INVALID_OWNER",
  PRINCIPAL_INVALID_PROFILE: "REDUCER_PRINCIPAL_INVALID_PROFILE",
  PRINCIPAL_INVALID_RECORD: "REDUCER_PRINCIPAL_INVALID_RECORD",
  PRINCIPAL_INVALID_STATUS: "REDUCER_PRINCIPAL_INVALID_STATUS",
  PRINCIPAL_INVALID_SUBJECT: "REDUCER_PRINCIPAL_INVALID_SUBJECT",
  PRINCIPAL_LIFECYCLE: "REDUCER_PRINCIPAL_LIFECYCLE",
  PRINCIPAL_NOT_FOUND: "REDUCER_PRINCIPAL_NOT_FOUND",
  PRINCIPAL_PROFILE_REVISION: "REDUCER_PRINCIPAL_PROFILE_REVISION",
  PRINCIPAL_SCOPE_MISMATCH: "REDUCER_PRINCIPAL_SCOPE_MISMATCH",
  WORKSPACE_ALREADY_EXISTS: "REDUCER_WORKSPACE_ALREADY_EXISTS",
  WORKSPACE_BOOTSTRAP_INVALID: "REDUCER_WORKSPACE_BOOTSTRAP_INVALID",
  WORKSPACE_CAPABILITY_DENIED: "REDUCER_WORKSPACE_CAPABILITY_DENIED",
  WORKSPACE_DUPLICATE_MEMBERSHIP: "REDUCER_WORKSPACE_DUPLICATE_MEMBERSHIP",
  WORKSPACE_INVITE_INVALID: "REDUCER_WORKSPACE_INVITE_INVALID",
  WORKSPACE_INVITE_ACTOR_MISMATCH: "REDUCER_WORKSPACE_INVITE_ACTOR_MISMATCH",
  WORKSPACE_LAST_OWNER: "REDUCER_WORKSPACE_LAST_OWNER",
  WORKSPACE_MEMBERSHIP_INACTIVE: "REDUCER_WORKSPACE_MEMBERSHIP_INACTIVE",
  WORKSPACE_MEMBERSHIP_NOT_FOUND: "REDUCER_WORKSPACE_MEMBERSHIP_NOT_FOUND",
  WORKSPACE_NOT_FOUND: "REDUCER_WORKSPACE_NOT_FOUND",
  WORKSPACE_REVISION_CONFLICT: "REDUCER_WORKSPACE_REVISION_CONFLICT",
  WORKSPACE_ROLE_INVALID: "REDUCER_WORKSPACE_ROLE_INVALID",
  WORKSPACE_ROLE_KIND_MISMATCH: "REDUCER_WORKSPACE_ROLE_KIND_MISMATCH",
  WORKSPACE_SELF_ESCALATION: "REDUCER_WORKSPACE_SELF_ESCALATION",
  WORKSPACE_SCOPE_MISMATCH: "REDUCER_WORKSPACE_SCOPE_MISMATCH",
  CHANNEL_ARCHIVED: "REDUCER_CHANNEL_ARCHIVED",
  CHANNEL_DIRECT_DUPLICATE: "REDUCER_CHANNEL_DIRECT_DUPLICATE",
  CHANNEL_DIRECT_ID_MISMATCH: "REDUCER_CHANNEL_DIRECT_ID_MISMATCH",
  CHANNEL_DIRECT_PARTICIPANTS: "REDUCER_CHANNEL_DIRECT_PARTICIPANTS",
  CHANNEL_INVALID_DISPLAY_NAME: "REDUCER_CHANNEL_INVALID_DISPLAY_NAME",
  CHANNEL_INVALID_ID: "REDUCER_CHANNEL_INVALID_ID",
  CHANNEL_INVALID_KIND: "REDUCER_CHANNEL_INVALID_KIND",
  CHANNEL_INVALID_MEMBERSHIP: "REDUCER_CHANNEL_INVALID_MEMBERSHIP",
  CHANNEL_INVALID_STATUS: "REDUCER_CHANNEL_INVALID_STATUS",
  CHANNEL_MEMBERSHIP_DUPLICATE: "REDUCER_CHANNEL_MEMBERSHIP_DUPLICATE",
  CHANNEL_MEMBERSHIP_INACTIVE: "REDUCER_CHANNEL_MEMBERSHIP_INACTIVE",
  CHANNEL_MEMBERSHIP_NOT_FOUND: "REDUCER_CHANNEL_MEMBERSHIP_NOT_FOUND",
  CHANNEL_NOT_FOUND: "REDUCER_CHANNEL_NOT_FOUND",
  CHANNEL_PARTICIPANT_SERVICE: "REDUCER_CHANNEL_PARTICIPANT_SERVICE",
  CHANNEL_REVISION_CONFLICT: "REDUCER_CHANNEL_REVISION_CONFLICT",
  CHANNEL_SCOPE_MISMATCH: "REDUCER_CHANNEL_SCOPE_MISMATCH",
  MESSAGE_AUTHOR_MISMATCH: "REDUCER_MESSAGE_AUTHOR_MISMATCH",
  MESSAGE_CONTENT_TYPE: "REDUCER_MESSAGE_CONTENT_TYPE",
  MESSAGE_DELETED: "REDUCER_MESSAGE_DELETED",
  MESSAGE_MODERATOR_REQUIRED: "REDUCER_MESSAGE_MODERATOR_REQUIRED",
  MESSAGE_NOT_FOUND: "REDUCER_MESSAGE_NOT_FOUND",
  MESSAGE_REPLY_ROOT: "REDUCER_MESSAGE_REPLY_ROOT",
  MESSAGE_REVISION_CONFLICT: "REDUCER_MESSAGE_REVISION_CONFLICT",
  MESSAGE_TEXT: "REDUCER_MESSAGE_TEXT",
  UNKNOWN_EVENT_TYPE: "REDUCER_UNKNOWN_EVENT_TYPE",
  UNSUPPORTED_SCHEMA_VERSION: "REDUCER_UNSUPPORTED_SCHEMA_VERSION",
});

const OFFSET_PATTERN = /^[0-9a-f]{16}_[0-9a-f]{16}$/u;

export class ReducerError extends Error {
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      detail: this.detail,
      offset: this.offset,
      path: this.path,
    };
  }
}

function reducerError(code, detail, { offset = null, path = "$" } = {}) {
  const error = new ReducerError();
  error.name = "ReducerError";
  error.message = `${code} at ${offset ?? "<unknown-offset>"} ${path}: ${detail}`;
  error.code = code;
  error.detail = detail;
  error.offset = offset;
  error.path = path;
  return error;
}

export function createInitialState() {
  return {
    schemaVersion: REDUCER_SCHEMA_VERSION,
    appliedEventIds: [],
    eventProvenance: [],
    entities: {
      agents: {},
      connections: {},
      directory: {},
      fixtures: {},
      invocations: {},
      messages: {},
      projections: {},
      runs: {},
    },
    audits: {},
  };
}

export function reduceEnvelope(
  state,
  envelope,
  { allowLegacyCompactMessages = false, offset = null } = {},
) {
  assertEnvelope(envelope, offset);
  if (state?.schemaVersion !== REDUCER_SCHEMA_VERSION) {
    throw reducerError(
      REDUCER_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION,
      `state schema version must be ${REDUCER_SCHEMA_VERSION}`,
      { offset, path: "$.state.schemaVersion" },
    );
  }
  if (state.appliedEventIds.includes(envelope.eventId)) {
    throw reducerError(
      REDUCER_ERROR_CODES.DUPLICATE_EVENT_ID,
      `event ID ${envelope.eventId} was already applied`,
      { offset, path: "$.eventId" },
    );
  }

  const next = cloneState(state);
  const reducer = registryReducer(envelope.eventType);
  reducer(next, envelope.data, {
    allowLegacyCompactMessages,
    envelope,
    offset,
  });
  next.appliedEventIds.push(envelope.eventId);
  next.eventProvenance.push({
    envelope: copyJson(envelope),
    offset,
  });
  return next;
}

export function replayRecords(
  records,
  {
    allowLegacyCompactMessages = false,
    initialState = createInitialState(),
  } = {},
) {
  if (!Array.isArray(records)) {
    throw reducerError(
      REDUCER_ERROR_CODES.MALFORMED_ENVELOPE,
      "replay input must be an array of offset records",
      { path: "$.records" },
    );
  }

  let state = cloneState(initialState);
  const seenOffsets = new Set();
  const prefixes = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records.at(index);
    const offset = record?.offset ?? `index:${index}`;
    if (typeof offset !== "string" || offset.length === 0) {
      throw reducerError(
        REDUCER_ERROR_CODES.INVALID_OFFSET,
        "record offset must be a canonical Durable Streams offset",
        { offset: String(offset), path: `$.records[${index}].offset` },
      );
    }
    if (!OFFSET_PATTERN.test(offset)) {
      throw reducerError(
        REDUCER_ERROR_CODES.INVALID_OFFSET,
        "record offset must be a canonical Durable Streams offset",
        { offset, path: `$.records[${index}].offset` },
      );
    }
    if (seenOffsets.has(offset)) {
      throw reducerError(
        REDUCER_ERROR_CODES.OFFSET_REUSED,
        `offset ${offset} was supplied more than once`,
        { offset, path: `$.records[${index}].offset` },
      );
    }
    seenOffsets.add(offset);
    const envelope = record?.event ?? record?.envelope ?? record;
    state = reduceEnvelope(state, envelope, {
      allowLegacyCompactMessages,
      offset,
    });
    prefixes.push({
      index: index + 1,
      offset,
      state: cloneState(state),
      stateJson: canonicalStateJson(state),
      stateDigest: canonicalStateDigest(state),
    });
  }

  return {
    finalState: state,
    finalStateJson: canonicalStateJson(state),
    finalStateDigest: canonicalStateDigest(state),
    prefixes,
  };
}

export const REDUCER_REGISTRY_V1 = Object.freeze({
  "ledger.fixture-recorded": reduceFixtureRecorded,
  "workspace.directory.updated": reduceDirectoryUpdated,
  "channel.message.created": reduceMessageCreated,
  "channel.message.replied": reduceMessageReplied,
  "channel.message.edited": reduceMessageEdited,
  "channel.message.deleted": reduceMessageDeleted,
  "channel.message.reaction.added": reduceReactionAdded,
  "channel.message.reaction.removed": reduceReactionRemoved,
  "agent.config.revised": reduceAgentConfigRevised,
  "workspace.invocation.requested": reduceInvocationRequested,
  "run.lifecycle.changed": reduceRunLifecycleChanged,
  "connection.config.revised": reduceConnectionConfigRevised,
  "workspace.audit.recorded": reduceAuditRecorded,
  "projection.checkpointed": reduceProjectionCheckpointed,
  "principal.created": reducePrincipalCreated,
  "principal.profile.updated": reducePrincipalProfileUpdated,
  "principal.suspended": reducePrincipalSuspended,
  "principal.deactivated": reducePrincipalDeactivated,
  "channel.created": reduceChannelCreated,
  "channel.renamed": reduceChannelRenamed,
  "channel.archived": reduceChannelArchived,
  "channel.unarchived": reduceChannelUnarchived,
  "channel.membership.invited": reduceChannelMembershipInvited,
  "channel.membership.joined": reduceChannelMembershipJoined,
  "channel.membership.left": reduceChannelMembershipLeft,
  "channel.membership.removed": reduceChannelMembershipRemoved,
  "channel.direct.created": reduceDirectChannelCreated,
  "workspace.created": reduceWorkspaceCreated,
  "workspace.membership.invited": reduceWorkspaceMembershipInvited,
  "workspace.membership.accepted": reduceWorkspaceMembershipAccepted,
  "workspace.membership.role.changed": reduceWorkspaceMembershipRoleChanged,
  "workspace.membership.suspended": reduceWorkspaceMembershipSuspended,
  "workspace.membership.removed": reduceWorkspaceMembershipRemoved,
});

export function materializeMessages(records) {
  const messages = new Map();
  for (const record of records) {
    if (
      !record ||
      typeof record !== "object" ||
      typeof record.id !== "string"
    ) {
      if (record?.dispatch?.operation === "chat.room.reset") messages.clear();
      continue;
    }
    if (record.dispatch !== undefined) {
      const projected = { ...record };
      delete projected.dispatch;
      messages.set(record.id, projected);
    } else {
      messages.set(record.id, record);
    }
  }
  return [...messages.values()];
}

function assertEnvelope(envelope, offset) {
  if (!isRecord(envelope)) {
    throw reducerError(
      REDUCER_ERROR_CODES.MALFORMED_ENVELOPE,
      "event envelope must be an object",
      { offset, path: "$.event" },
    );
  }
  if (envelope.schemaVersion !== REDUCER_SCHEMA_VERSION) {
    throw reducerError(
      REDUCER_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION,
      `supported schema version is ${REDUCER_SCHEMA_VERSION}`,
      { offset, path: "$.event.schemaVersion" },
    );
  }
  if (!REDUCER_EVENT_TYPES_V1.includes(envelope.eventType)) {
    throw reducerError(
      REDUCER_ERROR_CODES.UNKNOWN_EVENT_TYPE,
      `event type ${String(envelope.eventType)} is not registered`,
      { offset, path: "$.event.eventType" },
    );
  }
  if (typeof envelope.eventId !== "string" || envelope.eventId.length === 0) {
    throw reducerError(
      REDUCER_ERROR_CODES.MALFORMED_ENVELOPE,
      "eventId must be a non-empty string",
      { offset, path: "$.event.eventId" },
    );
  }
  if (!isRecord(envelope.data)) {
    throw reducerError(
      REDUCER_ERROR_CODES.MALFORMED_ENVELOPE,
      "event data must be an object",
      { offset, path: "$.event.data" },
    );
  }
}

function reduceFixtureRecorded(state, data, context) {
  assertData(data, ["fixtureId", "value"], [], context);
  assertToken(data.fixtureId, "fixtureId", context);
  assertUnique(state.entities.fixtures, data.fixtureId, "fixtureId", context);
  state.entities.fixtures = setKey(state.entities.fixtures, data.fixtureId, {
    value: copyJson(data.value),
  });
}

function reduceDirectoryUpdated(state, data, context) {
  assertData(data, ["entityType", "id", "revision", "value"], [], context);
  assertToken(data.entityType, "entityType", context);
  assertToken(data.id, "id", context);
  assertRevision(data.revision, "revision", context);
  const current = getKey(state.entities.directory, data.id);
  if (current && data.revision <= current.revision) {
    failReducer(
      REDUCER_ERROR_CODES.ILLEGAL_TRANSITION,
      `directory revision ${data.revision} is not newer than ${current.revision}`,
      "revision",
      context,
    );
  }
  state.entities.directory = setKey(state.entities.directory, data.id, {
    entityType: data.entityType,
    id: data.id,
    revision: data.revision,
    value: copyJson(data.value),
  });
}

function reduceMessageCreated(state, data, context) {
  if (isConversationMessageData(data)) {
    assertData(
      data,
      [
        "authorId",
        "channelId",
        "contentType",
        "messageId",
        "rootMessageId",
        "text",
      ],
      [],
      context,
    );
    if (data.rootMessageId !== null) {
      failMessage(
        REDUCER_ERROR_CODES.MESSAGE_REPLY_ROOT,
        "a root message must have a null rootMessageId",
        "rootMessageId",
        context,
      );
    }
    assertConversationMessageIdentity(state, data, context);
    assertConversationText(data.text, context);
    assertConversationContentType(data.contentType, context);
    assertUnique(state.entities.messages, data.messageId, "messageId", context);
    state.entities.messages = setKey(
      state.entities.messages,
      data.messageId,
      createConversationMessageRecord(data, context, "created"),
    );
    return;
  }

  // E0's compact message event remains readable so old source streams retain
  // their historical state digests while the explicit v1 conversation shape
  // below carries revision and thread semantics.
  if (!context.allowLegacyCompactMessages) {
    failReducer(
      REDUCER_ERROR_CODES.LEGACY_COMPACT_REPLAY_REQUIRED,
      "compact message events require explicit E0-T05 replay compatibility",
      "messageId",
      context,
    );
  }
  assertData(data, ["messageId", "channelId", "authorId", "text"], [], context);
  assertToken(data.messageId, "messageId", context);
  assertToken(data.channelId, "channelId", context);
  assertToken(data.authorId, "authorId", context);
  if (typeof data.text !== "string") {
    failReducer(
      REDUCER_ERROR_CODES.INVALID_EVENT_DATA,
      "text must be a string",
      "text",
      context,
    );
  }
  assertConversationText(data.text, context);
  assertConversationMessageIdentity(state, data, context, {
    allowUnprojected: true,
  });
  assertUnique(state.entities.messages, data.messageId, "messageId", context);
  state.entities.messages = setKey(
    state.entities.messages,
    data.messageId,
    copyJson(data),
  );
}

function reduceMessageReplied(state, data, context) {
  assertData(
    data,
    [
      "authorId",
      "channelId",
      "contentType",
      "messageId",
      "rootMessageId",
      "text",
    ],
    [],
    context,
  );
  assertConversationMessageIdentity(state, data, context);
  assertConversationText(data.text, context);
  assertConversationContentType(data.contentType, context);
  assertToken(data.rootMessageId, "rootMessageId", context);
  if (data.rootMessageId === data.messageId) {
    failMessage(
      REDUCER_ERROR_CODES.MESSAGE_REPLY_ROOT,
      "a reply cannot reference itself",
      "rootMessageId",
      context,
    );
  }
  const root = getConversationMessage(state, data.rootMessageId);
  if (!root) {
    failMessage(
      REDUCER_ERROR_CODES.MESSAGE_REPLY_ROOT,
      "reply root does not exist",
      "rootMessageId",
      context,
    );
  }
  const rootWorkspaceId = root.workspaceId ?? context.envelope.workspaceId;
  if (
    rootWorkspaceId !== context.envelope.workspaceId ||
    root.channelId !== data.channelId ||
    (root.rootMessageId !== undefined && root.rootMessageId !== null) ||
    root.status === "deleted"
  ) {
    failMessage(
      REDUCER_ERROR_CODES.MESSAGE_REPLY_ROOT,
      "reply root must be a visible root in the same workspace and channel",
      "rootMessageId",
      context,
    );
  }
  assertUnique(state.entities.messages, data.messageId, "messageId", context);
  state.entities.messages = setKey(
    state.entities.messages,
    data.messageId,
    createConversationMessageRecord(data, context, "replied"),
  );
}

function reduceMessageEdited(state, data, context) {
  assertData(
    data,
    ["channelId", "contentType", "expectedRevision", "messageId", "text"],
    [],
    context,
  );
  assertConversationTargetIdentity(data, context);
  assertConversationText(data.text, context);
  assertConversationContentType(data.contentType, context);
  assertRevision(data.expectedRevision, "expectedRevision", context);
  const current = requireConversationMessage(state, data.messageId, context);
  const normalized = normalizeConversationMessage(current, context);
  if (normalized.channelId !== data.channelId) {
    failMessage(
      REDUCER_ERROR_CODES.CHANNEL_SCOPE_MISMATCH,
      "message belongs to a different channel",
      "channelId",
      context,
    );
  }
  assertConversationChannelAccess(state, data.channelId, context, {
    allowArchived: false,
  });
  if (normalized.status === "deleted") {
    failMessage(
      REDUCER_ERROR_CODES.MESSAGE_DELETED,
      "deleted messages cannot be edited",
      "messageId",
      context,
    );
  }
  if (normalized.authorId !== context.envelope.actorId) {
    failMessage(
      REDUCER_ERROR_CODES.MESSAGE_AUTHOR_MISMATCH,
      "only the message author may edit a message",
      "messageId",
      context,
    );
  }
  if (data.expectedRevision !== normalized.revision) {
    failMessage(
      REDUCER_ERROR_CODES.MESSAGE_REVISION_CONFLICT,
      `message revision ${data.expectedRevision} is not current`,
      "expectedRevision",
      context,
    );
  }
  const revision = normalized.revision + 1;
  state.entities.messages = setKey(state.entities.messages, data.messageId, {
    ...normalized,
    contentType: data.contentType,
    revision,
    revisions: [
      ...normalized.revisions,
      revisionRecord({
        context,
        contentType: data.contentType,
        kind: "edited",
        revision,
        text: data.text,
      }),
    ],
    status: "active",
    text: data.text,
  });
}

function reduceMessageDeleted(state, data, context) {
  assertData(data, ["channelId", "expectedRevision", "messageId"], [], context);
  assertConversationTargetIdentity(data, context);
  assertRevision(data.expectedRevision, "expectedRevision", context);
  const current = requireConversationMessage(state, data.messageId, context);
  const normalized = normalizeConversationMessage(current, context);
  if (normalized.channelId !== data.channelId) {
    failMessage(
      REDUCER_ERROR_CODES.CHANNEL_SCOPE_MISMATCH,
      "message belongs to a different channel",
      "channelId",
      context,
    );
  }
  assertConversationChannelAccess(state, data.channelId, context, {
    allowArchived: false,
  });
  if (normalized.status === "deleted") {
    failMessage(
      REDUCER_ERROR_CODES.MESSAGE_DELETED,
      "message is already deleted",
      "messageId",
      context,
    );
  }
  if (data.expectedRevision !== normalized.revision) {
    failMessage(
      REDUCER_ERROR_CODES.MESSAGE_REVISION_CONFLICT,
      `message revision ${data.expectedRevision} is not current`,
      "expectedRevision",
      context,
    );
  }
  if (
    normalized.authorId !== context.envelope.actorId &&
    !conversationModerator(state, data.channelId, context.envelope.actorId)
  ) {
    failMessage(
      REDUCER_ERROR_CODES.MESSAGE_MODERATOR_REQUIRED,
      "only the author or an active channel moderator may delete a message",
      "messageId",
      context,
    );
  }
  const revision = normalized.revision + 1;
  state.entities.messages = setKey(state.entities.messages, data.messageId, {
    ...normalized,
    revision,
    revisions: [
      ...normalized.revisions,
      revisionRecord({
        context,
        contentType: normalized.contentType,
        kind: "deleted",
        revision,
        text: null,
      }),
    ],
    status: "deleted",
    text: null,
  });
}

function reduceReactionAdded(state, data, context) {
  reduceReaction(state, data, context, "added");
}

function reduceReactionRemoved(state, data, context) {
  reduceReaction(state, data, context, "removed");
}

function reduceReaction(state, data, context, kind) {
  assertData(data, ["channelId", "emoji", "messageId"], [], context);
  assertConversationTargetIdentity(data, context);
  assertReaction(data.emoji, context);
  const message = requireConversationMessage(state, data.messageId, context);
  const normalized = normalizeConversationMessage(message, context);
  if (normalized.channelId !== data.channelId) {
    failMessage(
      REDUCER_ERROR_CODES.CHANNEL_SCOPE_MISMATCH,
      "message belongs to a different channel",
      "channelId",
      context,
    );
  }
  assertConversationChannelAccess(state, data.channelId, context, {
    allowArchived: false,
  });
  if (kind === "added" && normalized.status === "deleted") {
    failMessage(
      REDUCER_ERROR_CODES.MESSAGE_DELETED,
      "deleted messages cannot receive reactions",
      "messageId",
      context,
    );
  }
  const key = reactionKey(data.messageId, context.envelope.actorId, data.emoji);
  const reactions = state.entities.reactions ?? {};
  const current = getKey(reactions, key);
  const desiredStatus = kind === "added" ? "active" : "removed";
  if (current?.status === desiredStatus) return;
  state.entities.reactions = setKey(reactions, key, {
    actorId: context.envelope.actorId,
    channelId: data.channelId,
    emoji: data.emoji,
    history: [
      ...(current?.history ?? []),
      {
        actorId: context.envelope.actorId,
        eventId: context.envelope.eventId,
        kind,
        offset: context.offset,
        status: desiredStatus,
      },
    ],
    messageId: data.messageId,
    revision: (current?.revision ?? 0) + 1,
    status: desiredStatus,
  });
}

function isConversationMessageData(data) {
  return (
    Object.hasOwn(data, "contentType") || Object.hasOwn(data, "rootMessageId")
  );
}

function assertConversationMessageIdentity(
  state,
  data,
  context,
  { allowUnprojected = false } = {},
) {
  assertConversationTargetIdentity(data, context);
  if (data.authorId !== context.envelope.actorId) {
    failMessage(
      REDUCER_ERROR_CODES.MESSAGE_AUTHOR_MISMATCH,
      "message author must match the authenticated event actor",
      "authorId",
      context,
    );
  }
  assertConversationChannelAccess(state, data.channelId, context, {
    allowArchived: false,
    allowUnprojected,
  });
}

function assertConversationTargetIdentity(data, context) {
  assertChannelId(data.channelId, "channelId", context);
  assertToken(data.messageId, "messageId", context);
}

function assertConversationText(value, context) {
  try {
    validateConversationText(value);
  } catch (error) {
    failMessage(
      REDUCER_ERROR_CODES.MESSAGE_TEXT,
      error instanceof Error ? (error.detail ?? error.message) : String(error),
      "text",
      context,
    );
  }
}

function assertConversationContentType(value, context) {
  try {
    validateMessageContentType(value);
  } catch (error) {
    failMessage(
      REDUCER_ERROR_CODES.MESSAGE_CONTENT_TYPE,
      error instanceof Error ? (error.detail ?? error.message) : String(error),
      "contentType",
      context,
    );
  }
}

function assertReaction(value, context) {
  try {
    normalizeReactionName(value);
  } catch (error) {
    failMessage(
      REDUCER_ERROR_CODES.MESSAGE_TEXT,
      error instanceof Error ? (error.detail ?? error.message) : String(error),
      "emoji",
      context,
    );
  }
}

function createConversationMessageRecord(data, context, kind) {
  return {
    authorId: data.authorId,
    channelId: data.channelId,
    contentType: data.contentType,
    messageId: data.messageId,
    revision: 1,
    revisions: [
      revisionRecord({
        context,
        contentType: data.contentType,
        kind,
        revision: 1,
        text: data.text,
      }),
    ],
    rootMessageId: data.rootMessageId,
    status: "active",
    text: data.text,
    workspaceId: context.envelope.workspaceId,
  };
}

function revisionRecord({ context, contentType, kind, revision, text }) {
  return {
    actorId: context.envelope.actorId,
    contentType,
    eventId: context.envelope.eventId,
    kind,
    offset: context.offset,
    revision,
    text,
  };
}

function requireConversationMessage(state, messageId, context) {
  const message = getConversationMessage(state, messageId);
  if (!message) {
    failMessage(
      REDUCER_ERROR_CODES.MESSAGE_NOT_FOUND,
      "message does not exist",
      "messageId",
      context,
    );
  }
  return message;
}

function getConversationMessage(state, messageId) {
  return getKey(state.entities.messages, messageId);
}

function normalizeConversationMessage(message, context) {
  if (Array.isArray(message.revisions)) return message;
  return {
    ...message,
    contentType: message.contentType ?? "text/plain",
    revision: 1,
    revisions: [
      {
        actorId: message.authorId,
        contentType: message.contentType ?? "text/plain",
        eventId: context.envelope.eventId,
        kind: "created",
        offset: context.offset,
        revision: 1,
        text: message.text,
      },
    ],
    rootMessageId: null,
    status: message.status ?? "active",
    workspaceId: message.workspaceId ?? context.envelope.workspaceId,
  };
}

function assertConversationChannelAccess(
  state,
  channelId,
  context,
  { allowArchived, allowUnprojected = false },
) {
  const channels = channelMap(state);
  if (Object.keys(channels).length === 0) {
    if (allowUnprojected && context.allowLegacyCompactMessages) return;
    failMessage(
      REDUCER_ERROR_CODES.CHANNEL_NOT_FOUND,
      "conversation channel projection is required before message append",
      "channelId",
      context,
    );
  }
  const channel = getKey(channels, channelId);
  if (!channel) {
    failMessage(
      REDUCER_ERROR_CODES.CHANNEL_NOT_FOUND,
      "conversation event references an unknown channel",
      "channelId",
      context,
    );
  }
  if (channel.workspaceId !== context.envelope.workspaceId) {
    failMessage(
      REDUCER_ERROR_CODES.CHANNEL_SCOPE_MISMATCH,
      "conversation channel belongs to another workspace",
      "channelId",
      context,
    );
  }
  if (!allowArchived && channel.status !== "active") {
    failMessage(
      REDUCER_ERROR_CODES.CHANNEL_ARCHIVED,
      "archived channels do not accept conversation mutations",
      "channelId",
      context,
    );
  }
  const workspaceMembership = getKey(
    membershipMap(state),
    membershipIdForReducer(
      context.envelope.workspaceId,
      context.envelope.actorId,
    ),
  );
  const channelMembership = getKey(
    channelMembershipMap(state),
    channelMembershipKeyForReducer(channelId, context.envelope.actorId),
  );
  if (
    !workspaceMembership ||
    workspaceMembership.status !== "active" ||
    !channelMembership ||
    channelMembership.status !== "active"
  ) {
    failMessage(
      REDUCER_ERROR_CODES.CHANNEL_MEMBERSHIP_INACTIVE,
      "conversation actor must be an active workspace and channel member",
      "channelId",
      context,
    );
  }
}

function conversationModerator(state, channelId, principalId) {
  const channel = getKey(channelMap(state), channelId);
  const channelMembership = getKey(
    channelMembershipMap(state),
    channelMembershipKeyForReducer(channelId, principalId),
  );
  const workspaceMembership = getKey(
    membershipMap(state),
    membershipIdForReducer(channel?.workspaceId ?? "", principalId),
  );
  return Boolean(
    channel &&
    channelMembership?.status === "active" &&
    workspaceMembership?.status === "active" &&
    (channel.creatorId === principalId ||
      ["owner", "admin"].includes(workspaceMembership.role)),
  );
}

function reactionKey(messageId, actorId, emoji) {
  return `${messageId}\u0000${actorId}\u0000${emoji}`;
}

function failMessage(code, detail, field, context) {
  throw reducerError(code, detail, {
    offset: context.offset,
    path: `$.event.data.${field}`,
  });
}

function reduceAgentConfigRevised(state, data, context) {
  assertData(data, ["agentId", "revision", "config"], [], context);
  assertToken(data.agentId, "agentId", context);
  assertRevision(data.revision, "revision", context);
  const current = getKey(state.entities.agents, data.agentId);
  if (current && data.revision <= current.revision) {
    failReducer(
      REDUCER_ERROR_CODES.ILLEGAL_TRANSITION,
      `agent revision ${data.revision} is not newer than ${current.revision}`,
      "revision",
      context,
    );
  }
  state.entities.agents = setKey(state.entities.agents, data.agentId, {
    agentId: data.agentId,
    revision: data.revision,
    config: copyJson(data.config),
  });
}

function reduceInvocationRequested(state, data, context) {
  assertData(
    data,
    ["invocationId", "agentId", "channelId", "prompt"],
    [],
    context,
  );
  assertToken(data.invocationId, "invocationId", context);
  assertToken(data.agentId, "agentId", context);
  assertToken(data.channelId, "channelId", context);
  if (typeof data.prompt !== "string") {
    failReducer(
      REDUCER_ERROR_CODES.INVALID_EVENT_DATA,
      "prompt must be a string",
      "prompt",
      context,
    );
  }
  assertUnique(
    state.entities.invocations,
    data.invocationId,
    "invocationId",
    context,
  );
  state.entities.invocations = setKey(
    state.entities.invocations,
    data.invocationId,
    copyJson(data),
  );
}

function reduceRunLifecycleChanged(state, data, context) {
  assertData(data, ["runId", "from", "to"], ["invocationId"], context);
  assertToken(data.runId, "runId", context);
  assertTransitionValue(data.from, "from", context);
  assertToken(data.to, "to", context);
  const current = getKey(state.entities.runs, data.runId);
  const currentState = current?.to ?? null;
  if (data.from !== currentState || !allowedTransition(data.from, data.to)) {
    failReducer(
      REDUCER_ERROR_CODES.ILLEGAL_TRANSITION,
      `run cannot transition from ${String(currentState)} to ${data.to}`,
      "to",
      context,
    );
  }
  const history = current?.history ?? [];
  state.entities.runs = setKey(state.entities.runs, data.runId, {
    from: data.from,
    history: [...history, { from: data.from, to: data.to }],
    invocationId: data.invocationId ?? current?.invocationId ?? null,
    runId: data.runId,
    to: data.to,
  });
}

function reduceConnectionConfigRevised(state, data, context) {
  assertData(data, ["connectionId", "revision", "metadata"], [], context);
  assertToken(data.connectionId, "connectionId", context);
  assertRevision(data.revision, "revision", context);
  const current = getKey(state.entities.connections, data.connectionId);
  if (current && data.revision <= current.revision) {
    failReducer(
      REDUCER_ERROR_CODES.ILLEGAL_TRANSITION,
      `connection revision ${data.revision} is not newer than ${current.revision}`,
      "revision",
      context,
    );
  }
  state.entities.connections = setKey(
    state.entities.connections,
    data.connectionId,
    {
      connectionId: data.connectionId,
      metadata: copyJson(data.metadata),
      revision: data.revision,
    },
  );
}

function reduceAuditRecorded(state, data, context) {
  assertData(data, ["auditId", "action", "subjectId"], ["detail"], context);
  assertToken(data.auditId, "auditId", context);
  assertToken(data.action, "action", context);
  assertToken(data.subjectId, "subjectId", context);
  assertUnique(state.audits, data.auditId, "auditId", context);
  state.audits = setKey(state.audits, data.auditId, copyJson(data));
}

function reduceProjectionCheckpointed(state, data, context) {
  assertData(
    data,
    ["projectionId", "sequence", "sourceStream", "sourceOffset", "stateDigest"],
    [],
    context,
  );
  assertToken(data.projectionId, "projectionId", context);
  assertRevision(data.sequence, "sequence", context);
  assertStream(data.sourceStream, "sourceStream", context);
  assertToken(data.sourceOffset, "sourceOffset", context);
  if (!/^sha256:[0-9a-f]{64}$/u.test(data.stateDigest)) {
    failReducer(
      REDUCER_ERROR_CODES.INVALID_EVENT_DATA,
      "stateDigest must be sha256",
      "stateDigest",
      context,
    );
  }
  const current = getKey(state.entities.projections, data.projectionId);
  if (current && data.sequence <= current.sequence) {
    failReducer(
      REDUCER_ERROR_CODES.ILLEGAL_TRANSITION,
      `projection sequence ${data.sequence} is not newer than ${current.sequence}`,
      "sequence",
      context,
    );
  }
  state.entities.projections = setKey(
    state.entities.projections,
    data.projectionId,
    copyJson(data),
  );
}

function reducePrincipalCreated(state, data, context) {
  assertData(
    data,
    ["kind", "ownedBy", "principalId", "profile", "subjectBinding"],
    [],
    context,
  );
  assertPrincipalId(data.principalId, "principalId", context);
  assertPrincipalKind(data.kind, context);
  assertPrincipalProfile(data.profile, context);
  assertSubjectBinding(data.subjectBinding, context);

  if (data.kind === "agent") {
    if (data.ownedBy === null) {
      failPrincipal(
        REDUCER_ERROR_CODES.PRINCIPAL_INVALID_OWNER,
        "agent principals require a human owner",
        "ownedBy",
        context,
      );
    }
    assertPrincipalId(data.ownedBy, "ownedBy", context);
    if (data.ownedBy === data.principalId) {
      failPrincipal(
        REDUCER_ERROR_CODES.PRINCIPAL_INVALID_OWNER,
        "an agent cannot own itself",
        "ownedBy",
        context,
      );
    }
    const owner = getPrincipal(state, data.ownedBy);
    if (!owner) {
      failPrincipal(
        REDUCER_ERROR_CODES.PRINCIPAL_INVALID_OWNER,
        "agent owner must already exist in the workspace",
        "ownedBy",
        context,
      );
    }
    if (owner.kind !== "human" || owner.status !== "active") {
      failPrincipal(
        REDUCER_ERROR_CODES.PRINCIPAL_INVALID_OWNER,
        "agent owner must be an active human principal",
        "ownedBy",
        context,
      );
    }
  } else if (data.ownedBy !== null) {
    failPrincipal(
      REDUCER_ERROR_CODES.PRINCIPAL_INVALID_OWNER,
      "only agent principals may carry an owner reference",
      "ownedBy",
      context,
    );
  }

  const principals = principalMap(state);
  assertUnique(principals, data.principalId, "principalId", context);
  for (const principal of Object.values(principals)) {
    if (
      principalSubjectKey(principal.subjectBinding) ===
      principalSubjectKey(data.subjectBinding)
    ) {
      failPrincipal(
        REDUCER_ERROR_CODES.PRINCIPAL_DUPLICATE_SUBJECT,
        "subject binding is already assigned to another principal",
        "subjectBinding",
        context,
      );
    }
  }

  state.entities.principals = setKey(principals, data.principalId, {
    kind: data.kind,
    ownedBy: data.ownedBy,
    principalId: data.principalId,
    profile: copyJson(data.profile),
    profileRevision: 1,
    status: "active",
    subjectBinding: copyJson(data.subjectBinding),
  });
}

function reducePrincipalProfileUpdated(state, data, context) {
  assertData(data, ["principalId", "profile", "revision"], [], context);
  assertPrincipalId(data.principalId, "principalId", context);
  assertPrincipalProfile(data.profile, context);
  assertRevision(data.revision, "revision", context);

  const current = getPrincipal(state, data.principalId);
  if (!current) {
    failPrincipal(
      REDUCER_ERROR_CODES.PRINCIPAL_NOT_FOUND,
      "principal profile update references an unknown principal",
      "principalId",
      context,
    );
  }
  if (data.revision !== current.profileRevision + 1) {
    failPrincipal(
      REDUCER_ERROR_CODES.PRINCIPAL_PROFILE_REVISION,
      `profile revision must advance from ${current.profileRevision} to ${current.profileRevision + 1}`,
      "revision",
      context,
    );
  }

  state.entities.principals = setKey(principalMap(state), data.principalId, {
    ...current,
    profile: copyJson(data.profile),
    profileRevision: data.revision,
  });
}

function reducePrincipalSuspended(state, data, context) {
  reducePrincipalLifecycle(state, data, "suspended", context);
}

function reducePrincipalDeactivated(state, data, context) {
  reducePrincipalLifecycle(state, data, "deactivated", context);
}

function reducePrincipalLifecycle(state, data, nextStatus, context) {
  assertData(data, ["principalId"], ["reason"], context);
  assertPrincipalId(data.principalId, "principalId", context);
  if (Object.hasOwn(data, "reason")) {
    assertReason(data.reason, context);
  }

  const current = getPrincipal(state, data.principalId);
  if (!current) {
    failPrincipal(
      REDUCER_ERROR_CODES.PRINCIPAL_NOT_FOUND,
      `principal ${data.principalId} does not exist`,
      "principalId",
      context,
    );
  }
  const allowed =
    nextStatus === "suspended"
      ? current.status === "active"
      : current.status === "active" || current.status === "suspended";
  if (!allowed) {
    failPrincipal(
      REDUCER_ERROR_CODES.PRINCIPAL_LIFECYCLE,
      `principal cannot transition from ${current.status} to ${nextStatus}`,
      "principalId",
      context,
    );
  }

  state.entities.principals = setKey(principalMap(state), data.principalId, {
    ...current,
    status: nextStatus,
  });
}

function reduceChannelCreated(state, data, context) {
  assertData(
    data,
    ["channelId", "creatorId", "displayName", "kind"],
    [],
    context,
  );
  assertChannelId(data.channelId, "channelId", context);
  assertPrincipalId(data.creatorId, "creatorId", context);
  assertChannelKind(data.kind, context);
  assertChannelDisplayName(data.displayName, context);
  if (data.kind === "direct") {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_INVALID_KIND,
      "direct channels require channel.direct.created",
      "kind",
      context,
    );
  }
  if (data.creatorId !== context.envelope.actorId) {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_SCOPE_MISMATCH,
      "channel creator must be the event actor",
      "creatorId",
      context,
    );
  }
  requireActiveWorkspacePrincipal(state, data.creatorId, context);
  const creator = getPrincipal(state, data.creatorId);
  if (creator.kind === "service") {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_PARTICIPANT_SERVICE,
      "service principals may not create conversations",
      "creatorId",
      context,
    );
  }
  assertUnique(channelMap(state), data.channelId, "channelId", context);
  const membershipKey = channelMembershipKeyForReducer(
    data.channelId,
    data.creatorId,
  );
  assertUnique(
    channelMembershipMap(state),
    membershipKey,
    "creatorId",
    context,
  );
  state.entities.channels = setKey(channelMap(state), data.channelId, {
    channelId: data.channelId,
    creatorId: data.creatorId,
    displayName: data.displayName,
    kind: data.kind,
    participantIds: null,
    revision: 1,
    status: "active",
    workspaceId: context.envelope.workspaceId,
  });
  state.entities.channelMemberships = setKey(
    channelMembershipMap(state),
    membershipKey,
    {
      channelId: data.channelId,
      principalId: data.creatorId,
      revision: 1,
      status: "active",
      workspaceId: context.envelope.workspaceId,
    },
  );
}

function reduceDirectChannelCreated(state, data, context) {
  assertData(data, ["channelId", "creatorId", "participantIds"], [], context);
  assertChannelId(data.channelId, "channelId", context);
  assertPrincipalId(data.creatorId, "creatorId", context);
  const participantIds = canonicalPrincipalIds(data.participantIds, context);
  if (!participantIds.includes(data.creatorId)) {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_DIRECT_PARTICIPANTS,
      "direct channel creator must be a participant",
      "creatorId",
      context,
    );
  }
  for (const principalId of participantIds) {
    const principal = requireActiveWorkspacePrincipal(
      state,
      principalId,
      context,
    );
    if (principal.kind === "service") {
      failChannel(
        REDUCER_ERROR_CODES.CHANNEL_PARTICIPANT_SERVICE,
        "service principals may not join direct conversations",
        "participantIds",
        context,
      );
    }
  }
  const expectedChannelId = directChannelIdFor(
    context.envelope.workspaceId,
    participantIds,
  );
  if (data.channelId !== expectedChannelId) {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_DIRECT_ID_MISMATCH,
      "direct channel id must be derived from its participant set",
      "channelId",
      context,
    );
  }
  if (data.creatorId !== context.envelope.actorId) {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_SCOPE_MISMATCH,
      "direct channel creator must be the event actor",
      "creatorId",
      context,
    );
  }
  const participantKey = participantSetKeyForReducer(participantIds);
  if (hasKey(directChannelMap(state), participantKey)) {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_DIRECT_DUPLICATE,
      "an equivalent direct channel already exists",
      "participantIds",
      context,
    );
  }
  assertUnique(channelMap(state), data.channelId, "channelId", context);
  state.entities.channels = setKey(channelMap(state), data.channelId, {
    channelId: data.channelId,
    creatorId: data.creatorId,
    displayName: "",
    kind: "direct",
    participantIds: copyJson(participantIds),
    revision: 1,
    status: "active",
    workspaceId: context.envelope.workspaceId,
  });
  state.entities.directChannels = setKey(
    directChannelMap(state),
    participantKey,
    data.channelId,
  );
  for (const principalId of participantIds) {
    const membershipKey = channelMembershipKeyForReducer(
      data.channelId,
      principalId,
    );
    state.entities.channelMemberships = setKey(
      channelMembershipMap(state),
      membershipKey,
      {
        channelId: data.channelId,
        principalId,
        revision: 1,
        status: "active",
        workspaceId: context.envelope.workspaceId,
      },
    );
  }
}

function reduceChannelRenamed(state, data, context) {
  assertData(
    data,
    ["channelId", "displayName", "expectedChannelRevision"],
    [],
    context,
  );
  const channel = requireChannel(state, data.channelId, context);
  assertChannelRevision(data.expectedChannelRevision, channel, context);
  assertChannelDisplayName(data.displayName, context);
  if (channel.kind === "direct") {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_INVALID_KIND,
      "direct participant sets are immutable",
      "channelId",
      context,
    );
  }
  if (channel.status !== "active") {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_ARCHIVED,
      "archived channels do not accept renames",
      "channelId",
      context,
    );
  }
  requireChannelManager(state, channel, context);
  advanceChannel(state, channel, {
    displayName: data.displayName,
    status: channel.status,
  });
}

function reduceChannelArchived(state, data, context) {
  reduceChannelStatus(state, data, "archived", context);
}

function reduceChannelUnarchived(state, data, context) {
  reduceChannelStatus(state, data, "active", context);
}

function reduceChannelStatus(state, data, nextStatus, context) {
  assertData(
    data,
    ["channelId", "expectedChannelRevision"],
    ["reason"],
    context,
  );
  const channel = requireChannel(state, data.channelId, context);
  assertChannelRevision(data.expectedChannelRevision, channel, context);
  requireChannelManager(state, channel, context);
  if (channel.status === nextStatus) {
    failChannel(
      REDUCER_ERROR_CODES.ILLEGAL_TRANSITION,
      `channel is already ${nextStatus}`,
      "channelId",
      context,
    );
  }
  if (Object.hasOwn(data, "reason")) {
    assertChannelReason(data.reason, context);
  }
  advanceChannel(state, channel, {
    reason: data.reason ?? null,
    status: nextStatus,
  });
}

function reduceChannelMembershipInvited(state, data, context) {
  assertData(
    data,
    ["channelId", "expectedChannelRevision", "inviteId", "principalId"],
    [],
    context,
  );
  const channel = requireChannel(state, data.channelId, context);
  assertChannelRevision(data.expectedChannelRevision, channel, context);
  assertInviteId(data.inviteId, "inviteId", context);
  assertPrincipalId(data.principalId, "principalId", context);
  requireChannelManager(state, channel, context);
  if (channel.status !== "active") {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_ARCHIVED,
      "archived channels do not accept membership changes",
      "channelId",
      context,
    );
  }
  const principal = requireActiveWorkspacePrincipal(
    state,
    data.principalId,
    context,
  );
  if (principal.kind === "service") {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_PARTICIPANT_SERVICE,
      "service principals may not join conversations",
      "principalId",
      context,
    );
  }
  const membershipKey = channelMembershipKeyForReducer(
    data.channelId,
    data.principalId,
  );
  const current = getKey(channelMembershipMap(state), membershipKey);
  if (current?.status === "active" || current?.status === "removed") {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_MEMBERSHIP_DUPLICATE,
      "principal already has a non-rejoinable channel membership",
      "principalId",
      context,
    );
  }
  for (const invite of Object.values(channelInviteMap(state))) {
    if (
      invite.channelId === data.channelId &&
      invite.principalId === data.principalId &&
      invite.status === "pending"
    ) {
      failChannel(
        REDUCER_ERROR_CODES.CHANNEL_MEMBERSHIP_DUPLICATE,
        "principal already has a pending channel invite",
        "principalId",
        context,
      );
    }
  }
  if (hasKey(channelInviteMap(state), data.inviteId)) {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_MEMBERSHIP_DUPLICATE,
      "channel invite id is already in use",
      "inviteId",
      context,
    );
  }
  state.entities.channelInvites = setKey(
    channelInviteMap(state),
    data.inviteId,
    {
      channelId: data.channelId,
      inviteId: data.inviteId,
      invitedBy: context.envelope.actorId,
      principalId: data.principalId,
      revision: 1,
      status: "pending",
      workspaceId: context.envelope.workspaceId,
    },
  );
  advanceChannel(state, channel, {});
}

function reduceChannelMembershipJoined(state, data, context) {
  assertData(
    data,
    ["channelId", "expectedChannelRevision", "principalId"],
    ["inviteId"],
    context,
  );
  const channel = requireChannel(state, data.channelId, context);
  assertChannelRevision(data.expectedChannelRevision, channel, context);
  assertPrincipalId(data.principalId, "principalId", context);
  requireActiveWorkspacePrincipal(state, data.principalId, context);
  if (data.principalId !== context.envelope.actorId) {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_SCOPE_MISMATCH,
      "only the joining principal may accept a channel membership",
      "principalId",
      context,
    );
  }
  if (channel.kind === "direct") {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_INVALID_KIND,
      "direct channel participants are fixed at creation",
      "channelId",
      context,
    );
  }
  if (channel.status !== "active") {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_ARCHIVED,
      "archived channels do not accept membership changes",
      "channelId",
      context,
    );
  }
  const membershipKey = channelMembershipKeyForReducer(
    data.channelId,
    data.principalId,
  );
  const current = getKey(channelMembershipMap(state), membershipKey);
  if (current?.status === "active" || current?.status === "removed") {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_MEMBERSHIP_DUPLICATE,
      "principal is already an active or removed channel member",
      "principalId",
      context,
    );
  }
  let invite = null;
  if (channel.kind === "private" || Object.hasOwn(data, "inviteId")) {
    if (!Object.hasOwn(data, "inviteId")) {
      failChannel(
        REDUCER_ERROR_CODES.CHANNEL_MEMBERSHIP_NOT_FOUND,
        "private channel membership requires an invite",
        "inviteId",
        context,
      );
    }
    assertInviteId(data.inviteId, "inviteId", context);
    invite = getKey(channelInviteMap(state), data.inviteId);
    if (
      !invite ||
      invite.channelId !== data.channelId ||
      invite.principalId !== data.principalId ||
      invite.status !== "pending"
    ) {
      failChannel(
        REDUCER_ERROR_CODES.CHANNEL_MEMBERSHIP_NOT_FOUND,
        "channel invite is not valid for this principal",
        "inviteId",
        context,
      );
    }
  }
  state.entities.channelMemberships = setKey(
    channelMembershipMap(state),
    membershipKey,
    {
      channelId: data.channelId,
      principalId: data.principalId,
      revision: (current?.revision ?? 0) + 1,
      status: "active",
      workspaceId: context.envelope.workspaceId,
    },
  );
  if (invite) {
    state.entities.channelInvites = setKey(
      channelInviteMap(state),
      invite.inviteId,
      {
        ...invite,
        revision: invite.revision + 1,
        status: "accepted",
      },
    );
  }
  advanceChannel(state, channel, {});
}

function reduceChannelMembershipLeft(state, data, context) {
  assertData(
    data,
    ["channelId", "expectedChannelRevision", "principalId"],
    [],
    context,
  );
  const channel = requireChannel(state, data.channelId, context);
  assertChannelRevision(data.expectedChannelRevision, channel, context);
  assertPrincipalId(data.principalId, "principalId", context);
  if (data.principalId !== context.envelope.actorId) {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_SCOPE_MISMATCH,
      "only the leaving principal may leave a channel",
      "principalId",
      context,
    );
  }
  if (channel.kind === "direct") {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_INVALID_KIND,
      "direct channel participants are immutable",
      "channelId",
      context,
    );
  }
  if (channel.status !== "active") {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_ARCHIVED,
      "archived channels do not accept membership changes",
      "channelId",
      context,
    );
  }
  const membershipKey = channelMembershipKeyForReducer(
    data.channelId,
    data.principalId,
  );
  const current = getKey(channelMembershipMap(state), membershipKey);
  if (!current || current.status !== "active") {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_MEMBERSHIP_INACTIVE,
      "principal is not an active channel member",
      "principalId",
      context,
    );
  }
  state.entities.channelMemberships = setKey(
    channelMembershipMap(state),
    membershipKey,
    { ...current, revision: current.revision + 1, status: "left" },
  );
  advanceChannel(state, channel, {});
}

function reduceChannelMembershipRemoved(state, data, context) {
  assertData(
    data,
    ["channelId", "expectedChannelRevision", "principalId"],
    ["reason"],
    context,
  );
  const channel = requireChannel(state, data.channelId, context);
  assertChannelRevision(data.expectedChannelRevision, channel, context);
  assertPrincipalId(data.principalId, "principalId", context);
  requireChannelManager(state, channel, context);
  if (channel.kind === "direct") {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_INVALID_KIND,
      "direct channel participants are immutable",
      "channelId",
      context,
    );
  }
  if (channel.status !== "active") {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_ARCHIVED,
      "archived channels do not accept membership changes",
      "channelId",
      context,
    );
  }
  if (data.principalId === channel.creatorId) {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_MEMBERSHIP_INACTIVE,
      "channel creator may not be removed",
      "principalId",
      context,
    );
  }
  if (Object.hasOwn(data, "reason")) {
    assertChannelReason(data.reason, context);
  }
  const membershipKey = channelMembershipKeyForReducer(
    data.channelId,
    data.principalId,
  );
  const current = getKey(channelMembershipMap(state), membershipKey);
  if (!current || current.status !== "active") {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_MEMBERSHIP_INACTIVE,
      "principal is not an active channel member",
      "principalId",
      context,
    );
  }
  state.entities.channelMemberships = setKey(
    channelMembershipMap(state),
    membershipKey,
    {
      ...current,
      reason: data.reason ?? null,
      revision: current.revision + 1,
      status: "removed",
    },
  );
  advanceChannel(state, channel, {});
}

function assertChannelId(value, field, context) {
  const match =
    typeof value === "string"
      ? value.match(/^ch_([0-9a-hjkmnp-tv-z]{26})_([0-9a-hjkmnp-tv-z]{26})$/u)
      : null;
  if (!match || `ws_${match[1]}` !== context.envelope.workspaceId) {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_SCOPE_MISMATCH,
      "channel id belongs to a different workspace",
      field,
      context,
    );
  }
}

function assertChannelKind(value, context) {
  if (!new Set(["public", "private", "direct"]).has(value)) {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_INVALID_KIND,
      "channel kind must be public, private, or direct",
      "kind",
      context,
    );
  }
}

function assertChannelDisplayName(value, context) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 80 ||
    hasControlCharacter(value)
  ) {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_INVALID_DISPLAY_NAME,
      "display name must be 1-80 characters without control characters",
      "displayName",
      context,
    );
  }
}

function assertChannelReason(value, context) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 240 ||
    hasControlCharacter(value)
  ) {
    failChannel(
      REDUCER_ERROR_CODES.INVALID_EVENT_DATA,
      "reason must be a bounded string without control characters",
      "reason",
      context,
    );
  }
}

function assertChannelRevision(expected, channel, context) {
  assertRevision(expected, "expectedChannelRevision", context);
  if (expected !== channel.revision) {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_REVISION_CONFLICT,
      `channel revision ${expected} is not current`,
      "expectedChannelRevision",
      context,
    );
  }
}

function canonicalPrincipalIds(value, context) {
  if (!Array.isArray(value) || value.length < 2) {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_DIRECT_PARTICIPANTS,
      "direct channel requires at least two participants",
      "participantIds",
      context,
    );
  }
  const canonical = [...value].sort();
  for (let index = 0; index < canonical.length; index += 1) {
    assertPrincipalId(canonical.at(index), `participantIds[${index}]`, context);
    if (index > 0 && canonical.at(index) === canonical.at(index - 1)) {
      failChannel(
        REDUCER_ERROR_CODES.CHANNEL_DIRECT_PARTICIPANTS,
        "direct channel participants must be unique",
        "participantIds",
        context,
      );
    }
  }
  return canonical;
}

function requireChannel(state, channelId, context) {
  assertChannelId(channelId, "channelId", context);
  const channel = getKey(channelMap(state), channelId);
  if (!channel) {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_NOT_FOUND,
      "channel does not exist",
      "channelId",
      context,
    );
  }
  return channel;
}

function requireActiveWorkspacePrincipal(state, principalId, context) {
  const membershipId = membershipIdForReducer(
    context.envelope.workspaceId,
    principalId,
  );
  const membership = getKey(membershipMap(state), membershipId);
  const principal = getPrincipal(state, principalId);
  if (
    !membership ||
    membership.status !== "active" ||
    !principal ||
    principal.status !== "active"
  ) {
    failChannel(
      REDUCER_ERROR_CODES.CHANNEL_MEMBERSHIP_INACTIVE,
      "principal must have an active workspace membership",
      "principalId",
      context,
    );
  }
  return principal;
}

function requireChannelManager(state, channel, context) {
  const workspaceMembership = getKey(
    membershipMap(state),
    membershipIdForReducer(
      context.envelope.workspaceId,
      context.envelope.actorId,
    ),
  );
  const channelMembership = getKey(
    channelMembershipMap(state),
    channelMembershipKeyForReducer(channel.channelId, context.envelope.actorId),
  );
  if (
    !workspaceMembership ||
    workspaceMembership.status !== "active" ||
    !channelMembership ||
    channelMembership.status !== "active" ||
    (channel.creatorId !== context.envelope.actorId &&
      !["owner", "admin"].includes(workspaceMembership.role))
  ) {
    failChannel(
      REDUCER_ERROR_CODES.WORKSPACE_CAPABILITY_DENIED,
      "active channel membership or workspace administration is required",
      "actorId",
      context,
    );
  }
  return workspaceMembership;
}

function advanceChannel(state, channel, updates) {
  state.entities.channels = setKey(channelMap(state), channel.channelId, {
    ...channel,
    ...updates,
    revision: channel.revision + 1,
  });
}

function channelMap(state) {
  return state.entities.channels ?? {};
}

function channelMembershipMap(state) {
  return state.entities.channelMemberships ?? {};
}

function channelInviteMap(state) {
  return state.entities.channelInvites ?? {};
}

function directChannelMap(state) {
  return state.entities.directChannels ?? {};
}

function channelMembershipKeyForReducer(channelId, principalId) {
  return `${channelId}\u0000${principalId}`;
}

function participantSetKeyForReducer(participantIds) {
  return participantIds.join("\u0000");
}

function failChannel(code, detail, field, context) {
  throw reducerError(code, detail, {
    offset: context.offset,
    path: `$.event.data.${field}`,
  });
}

const PRINCIPAL_WORKSPACE_TOKEN = "[0-9a-hjkmnp-tv-z]{26}";
const PRINCIPAL_ID_PATTERN = new RegExp(
  `^pr_(${PRINCIPAL_WORKSPACE_TOKEN})_(${PRINCIPAL_WORKSPACE_TOKEN})$`,
  "u",
);
const PRINCIPAL_KINDS = new Set(["human", "agent", "service"]);
const PRINCIPAL_ISSUER_PATTERN = /^[a-z][a-z0-9._:-]{1,63}$/u;
const PRINCIPAL_HANDLE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const PRINCIPAL_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/u;
const PRINCIPAL_SUBJECT_FORBIDDEN_PATTERN =
  /^(?:bearer\s|basic\s|password[=:]|secret[=:]|session[=:]|token[=:])/iu;

function assertPrincipalId(value, field, context) {
  if (typeof value !== "string") {
    failPrincipal(
      REDUCER_ERROR_CODES.PRINCIPAL_SCOPE_MISMATCH,
      "principal id must be a string",
      field,
      context,
    );
  }
  const match = value.match(PRINCIPAL_ID_PATTERN);
  if (!match) {
    failPrincipal(
      REDUCER_ERROR_CODES.PRINCIPAL_SCOPE_MISMATCH,
      "principal id must be a lowercase workspace-scoped identifier",
      field,
      context,
    );
  }
  if (`ws_${match[1]}` !== context.envelope.workspaceId) {
    failPrincipal(
      REDUCER_ERROR_CODES.PRINCIPAL_SCOPE_MISMATCH,
      "principal id belongs to a different workspace",
      field,
      context,
    );
  }
}

function assertPrincipalKind(value, context) {
  if (typeof value !== "string" || !PRINCIPAL_KINDS.has(value)) {
    failPrincipal(
      REDUCER_ERROR_CODES.PRINCIPAL_INVALID_KIND,
      "kind must be human, agent, or service",
      "kind",
      context,
    );
  }
}

function assertPrincipalProfile(value, context) {
  if (!isRecord(value)) {
    failPrincipal(
      REDUCER_ERROR_CODES.PRINCIPAL_INVALID_PROFILE,
      "profile must be an object",
      "profile",
      context,
    );
  }
  assertData(value, ["displayName", "email", "handle"], [], context, "profile");
  assertBoundPrincipalString(
    value.displayName,
    160,
    "profile.displayName",
    context,
  );
  assertBoundPrincipalString(value.handle, 64, "profile.handle", context);
  if (!PRINCIPAL_HANDLE_PATTERN.test(value.handle)) {
    failPrincipal(
      REDUCER_ERROR_CODES.PRINCIPAL_INVALID_PROFILE,
      "handle must be lowercase and use only letters, digits, dot, underscore, or hyphen",
      "profile.handle",
      context,
    );
  }
  if (
    typeof value.email !== "string" ||
    value.email.length > 320 ||
    hasControlCharacter(value.email)
  ) {
    failPrincipal(
      REDUCER_ERROR_CODES.PRINCIPAL_INVALID_PROFILE,
      "email must be a bounded string without control characters",
      "profile.email",
      context,
    );
  }
  if (value.email && !PRINCIPAL_EMAIL_PATTERN.test(value.email)) {
    failPrincipal(
      REDUCER_ERROR_CODES.PRINCIPAL_INVALID_PROFILE,
      "email must be an address or an empty service value",
      "profile.email",
      context,
    );
  }
}

function assertSubjectBinding(value, context) {
  if (!isRecord(value)) {
    failPrincipal(
      REDUCER_ERROR_CODES.PRINCIPAL_INVALID_SUBJECT,
      "subjectBinding must be an object",
      "subjectBinding",
      context,
    );
  }
  assertData(
    value,
    ["audience", "issuer", "subject"],
    [],
    context,
    "subjectBinding",
  );
  assertBoundPrincipalString(
    value.issuer,
    64,
    "subjectBinding.issuer",
    context,
  );
  if (!PRINCIPAL_ISSUER_PATTERN.test(value.issuer)) {
    failPrincipal(
      REDUCER_ERROR_CODES.PRINCIPAL_INVALID_SUBJECT,
      "issuer must be a lowercase provider name",
      "subjectBinding.issuer",
      context,
    );
  }
  assertBoundPrincipalString(
    value.audience,
    128,
    "subjectBinding.audience",
    context,
  );
  assertBoundPrincipalString(
    value.subject,
    256,
    "subjectBinding.subject",
    context,
  );
  if (PRINCIPAL_SUBJECT_FORBIDDEN_PATTERN.test(value.subject)) {
    failPrincipal(
      REDUCER_ERROR_CODES.PRINCIPAL_INVALID_SUBJECT,
      "subject binding must not contain a bearer or secret credential",
      "subjectBinding.subject",
      context,
    );
  }
}

function assertReason(value, context) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 240 ||
    hasControlCharacter(value)
  ) {
    failPrincipal(
      REDUCER_ERROR_CODES.PRINCIPAL_INVALID_STATUS,
      "reason must be a bounded string without control characters",
      "reason",
      context,
    );
  }
}

function assertBoundPrincipalString(value, maxLength, field, context) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    hasControlCharacter(value)
  ) {
    failPrincipal(
      REDUCER_ERROR_CODES.PRINCIPAL_INVALID_RECORD,
      "value must be a non-empty bounded string without control characters",
      field,
      context,
    );
  }
}

function failPrincipal(code, detail, field, context) {
  throw reducerError(code, detail, {
    offset: context.offset,
    path: `$.event.data.${field}`,
  });
}

function principalMap(state) {
  return state.entities.principals ?? {};
}

function getPrincipal(state, principalId) {
  return getKey(principalMap(state), principalId);
}

function principalSubjectKey(value) {
  return `${value.issuer}\u0000${value.audience}\u0000${value.subject}`;
}

function hasControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

function reduceWorkspaceCreated(state, data, context) {
  assertData(
    data,
    ["displayName", "ownerPrincipalId", "workspaceId"],
    [],
    context,
  );
  assertWorkspaceIdValue(data.workspaceId, "workspaceId", context);
  assertBoundWorkspaceString(data.displayName, 160, "displayName", context);
  assertPrincipalId(data.ownerPrincipalId, "ownerPrincipalId", context);
  if (data.ownerPrincipalId !== context.envelope.actorId) {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_BOOTSTRAP_INVALID,
      "workspace bootstrap actor must be the initial owner",
      "ownerPrincipalId",
      context,
    );
  }
  const owner = getPrincipal(state, data.ownerPrincipalId);
  if (!owner || owner.kind !== "human" || owner.status !== "active") {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_BOOTSTRAP_INVALID,
      "workspace owner must be an existing active human principal",
      "ownerPrincipalId",
      context,
    );
  }
  const workspaces = workspaceMap(state);
  assertUnique(workspaces, data.workspaceId, "workspaceId", context);
  const membershipId = membershipIdForReducer(
    data.workspaceId,
    data.ownerPrincipalId,
  );
  const memberships = membershipMap(state);
  assertUnique(memberships, membershipId, "membershipId", context);
  state.entities.workspaces = setKey(workspaces, data.workspaceId, {
    createdBy: data.ownerPrincipalId,
    displayName: data.displayName,
    ownerMembershipId: membershipId,
    revision: 1,
    status: "active",
    workspaceId: data.workspaceId,
  });
  state.entities.memberships = setKey(memberships, membershipId, {
    invitedBy: null,
    inviteId: null,
    membershipId,
    principalId: data.ownerPrincipalId,
    reason: null,
    revision: 1,
    role: "owner",
    status: "active",
    workspaceId: data.workspaceId,
  });
}

function reduceWorkspaceMembershipInvited(state, data, context) {
  assertData(
    data,
    ["expectedWorkspaceRevision", "inviteId", "principalId", "role"],
    [],
    context,
  );
  const workspace = requireWorkspace(state, context);
  assertWorkspaceRevision(data.expectedWorkspaceRevision, workspace, context);
  const actorMembership = requireActorCapability(
    state,
    context,
    "workspace.membership.invite",
  );
  assertPrincipalId(data.principalId, "principalId", context);
  assertInviteId(data.inviteId, "inviteId", context);
  assertWorkspaceRole(data.role, context);
  if (data.role === "owner" && actorMembership.role !== "owner") {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_CAPABILITY_DENIED,
      "only an owner may invite an owner",
      "role",
      context,
    );
  }
  const principal = getPrincipal(state, data.principalId);
  if (!principal || principal.status !== "active") {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_MEMBERSHIP_INACTIVE,
      "invite target must be an existing active principal",
      "principalId",
      context,
    );
  }
  assertRoleKind(principal, data.role, context);
  const membershipId = membershipIdForReducer(
    context.envelope.workspaceId,
    data.principalId,
  );
  if (hasKey(membershipMap(state), membershipId)) {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_DUPLICATE_MEMBERSHIP,
      "principal already has a membership in this workspace",
      "principalId",
      context,
    );
  }
  const invites = inviteMap(state);
  assertUnique(invites, data.inviteId, "inviteId", context);
  state.entities.invites = setKey(invites, data.inviteId, {
    acceptedBy: null,
    inviteId: data.inviteId,
    invitedBy: context.envelope.actorId,
    principalId: data.principalId,
    revision: 1,
    role: data.role,
    status: "pending",
    workspaceId: context.envelope.workspaceId,
  });
  advanceWorkspace(state, workspace, context);
}

function reduceWorkspaceMembershipAccepted(state, data, context) {
  assertData(
    data,
    ["expectedWorkspaceRevision", "inviteId", "principalId"],
    [],
    context,
  );
  const workspace = requireWorkspace(state, context);
  assertWorkspaceRevision(data.expectedWorkspaceRevision, workspace, context);
  assertPrincipalId(data.principalId, "principalId", context);
  assertInviteId(data.inviteId, "inviteId", context);
  if (context.envelope.actorId !== data.principalId) {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_INVITE_ACTOR_MISMATCH,
      "only the invited principal may accept this invite",
      "principalId",
      context,
    );
  }
  const invite = getKey(inviteMap(state), data.inviteId);
  if (
    !invite ||
    invite.status !== "pending" ||
    invite.principalId !== data.principalId ||
    invite.workspaceId !== context.envelope.workspaceId
  ) {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_INVITE_INVALID,
      "invite is missing, consumed, or bound to another principal",
      "inviteId",
      context,
    );
  }
  const principal = getPrincipal(state, data.principalId);
  if (!principal || principal.status !== "active") {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_MEMBERSHIP_INACTIVE,
      "invited principal is not active",
      "principalId",
      context,
    );
  }
  assertRoleKind(principal, invite.role, context);
  const membershipId = membershipIdForReducer(
    context.envelope.workspaceId,
    data.principalId,
  );
  if (hasKey(membershipMap(state), membershipId)) {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_DUPLICATE_MEMBERSHIP,
      "principal already has a membership in this workspace",
      "principalId",
      context,
    );
  }
  state.entities.invites = setKey(inviteMap(state), data.inviteId, {
    ...invite,
    acceptedBy: data.principalId,
    revision: invite.revision + 1,
    status: "accepted",
  });
  state.entities.memberships = setKey(membershipMap(state), membershipId, {
    invitedBy: invite.invitedBy,
    inviteId: invite.inviteId,
    membershipId,
    principalId: data.principalId,
    reason: null,
    revision: 1,
    role: invite.role,
    status: "active",
    workspaceId: context.envelope.workspaceId,
  });
  advanceWorkspace(state, workspace, context);
}

function reduceWorkspaceMembershipRoleChanged(state, data, context) {
  assertData(
    data,
    [
      "expectedMembershipRevision",
      "expectedWorkspaceRevision",
      "membershipId",
      "role",
    ],
    [],
    context,
  );
  const workspace = requireWorkspace(state, context);
  assertWorkspaceRevision(data.expectedWorkspaceRevision, workspace, context);
  const actorMembership = requireActorCapability(
    state,
    context,
    "workspace.membership.role.change",
  );
  const target = requireTargetMembership(state, data, context, true);
  assertWorkspaceRole(data.role, context);
  const targetPrincipal = getPrincipal(state, target.principalId);
  assertRoleKind(targetPrincipal, data.role, context);
  if (target.principalId === context.envelope.actorId) {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_SELF_ESCALATION,
      "a principal may not change its own membership role",
      "membershipId",
      context,
    );
  }
  if (
    actorMembership.role !== "owner" &&
    (target.role === "owner" || data.role === "owner")
  ) {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_CAPABILITY_DENIED,
      "only an owner may change an owner membership or grant owner role",
      "role",
      context,
    );
  }
  if (
    target.role === "owner" &&
    data.role !== "owner" &&
    countNonRemovedOwners(state, context.envelope.workspaceId) <= 1
  ) {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_LAST_OWNER,
      "workspace must retain at least one owner",
      "role",
      context,
    );
  }
  state.entities.memberships = setKey(membershipMap(state), data.membershipId, {
    ...target,
    reason: null,
    revision: target.revision + 1,
    role: data.role,
  });
  advanceWorkspace(state, workspace, context);
}

function reduceWorkspaceMembershipSuspended(state, data, context) {
  reduceWorkspaceMembershipStatus(state, data, "suspended", context);
}

function reduceWorkspaceMembershipRemoved(state, data, context) {
  reduceWorkspaceMembershipStatus(state, data, "removed", context);
}

function reduceWorkspaceMembershipStatus(state, data, nextStatus, context) {
  assertData(
    data,
    ["expectedMembershipRevision", "expectedWorkspaceRevision", "membershipId"],
    ["reason"],
    context,
  );
  const workspace = requireWorkspace(state, context);
  assertWorkspaceRevision(data.expectedWorkspaceRevision, workspace, context);
  const capability =
    nextStatus === "suspended"
      ? "workspace.membership.suspend"
      : "workspace.membership.remove";
  const actorMembership = requireActorCapability(state, context, capability);
  const target = requireTargetMembership(state, data, context, false);
  if (target.status === "removed") {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_MEMBERSHIP_INACTIVE,
      "removed membership cannot be changed",
      "membershipId",
      context,
    );
  }
  if (nextStatus === "suspended" && target.status !== "active") {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_MEMBERSHIP_INACTIVE,
      "only an active membership may be suspended",
      "membershipId",
      context,
    );
  }
  if (actorMembership.role !== "owner" && target.role === "owner") {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_CAPABILITY_DENIED,
      "only an owner may change an owner membership",
      "membershipId",
      context,
    );
  }
  if (target.role === "owner") {
    const ownerCount =
      nextStatus === "suspended"
        ? countActiveOwners(state, context.envelope.workspaceId)
        : countNonRemovedOwners(state, context.envelope.workspaceId);
    if (ownerCount <= 1) {
      failWorkspace(
        REDUCER_ERROR_CODES.WORKSPACE_LAST_OWNER,
        "workspace must retain at least one owner",
        "membershipId",
        context,
      );
    }
  }
  if (Object.hasOwn(data, "reason")) {
    assertBoundWorkspaceString(data.reason, 240, "reason", context);
  }
  state.entities.memberships = setKey(membershipMap(state), data.membershipId, {
    ...target,
    reason: data.reason ?? null,
    revision: target.revision + 1,
    status: nextStatus,
  });
  advanceWorkspace(state, workspace, context);
}

const WORKSPACE_ID_PATTERN = /^ws_[0-9a-hjkmnp-tv-z]{26}$/u;
const MEMBERSHIP_ID_PATTERN =
  /^mb_([0-9a-hjkmnp-tv-z]{26})_([0-9a-hjkmnp-tv-z]{26})$/u;
const INVITE_ID_PATTERN =
  /^iv_([0-9a-hjkmnp-tv-z]{26})_([0-9a-hjkmnp-tv-z]{26})$/u;
const WORKSPACE_ROLES = new Set([
  "owner",
  "admin",
  "member",
  "guest",
  "agent",
  "service",
]);
const WORKSPACE_ADMIN_CAPABILITIES = new Set([
  "workspace.membership.invite",
  "workspace.membership.role.change",
  "workspace.membership.suspend",
  "workspace.membership.remove",
]);

function assertWorkspaceIdValue(value, field, context) {
  if (typeof value !== "string" || !WORKSPACE_ID_PATTERN.test(value)) {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_SCOPE_MISMATCH,
      "workspace id must be a lowercase workspace identifier",
      field,
      context,
    );
  }
  if (value !== context.envelope.workspaceId) {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_SCOPE_MISMATCH,
      "workspace id belongs to a different workspace",
      field,
      context,
    );
  }
}

function assertMembershipId(value, field, context) {
  const match =
    typeof value === "string" ? value.match(MEMBERSHIP_ID_PATTERN) : null;
  if (!match || `ws_${match[1]}` !== context.envelope.workspaceId) {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_SCOPE_MISMATCH,
      "membership id belongs to a different workspace",
      field,
      context,
    );
  }
}

function assertInviteId(value, field, context) {
  const match =
    typeof value === "string" ? value.match(INVITE_ID_PATTERN) : null;
  if (!match || `ws_${match[1]}` !== context.envelope.workspaceId) {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_SCOPE_MISMATCH,
      "invite id belongs to a different workspace",
      field,
      context,
    );
  }
}

function assertWorkspaceRole(value, context) {
  if (typeof value !== "string" || !WORKSPACE_ROLES.has(value)) {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_ROLE_INVALID,
      "role is not registered",
      "role",
      context,
    );
  }
}

function assertRoleKind(principal, role, context) {
  if (!principal) {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_MEMBERSHIP_INACTIVE,
      "membership principal does not exist",
      "principalId",
      context,
    );
  }
  const kindMatches = ["owner", "admin", "member", "guest"].includes(role)
    ? principal.kind === "human"
    : principal.kind === role;
  if (!kindMatches) {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_ROLE_KIND_MISMATCH,
      "role is not valid for the principal kind",
      "role",
      context,
    );
  }
}

function requireWorkspace(state, context) {
  const workspace = getKey(workspaceMap(state), context.envelope.workspaceId);
  if (!workspace || workspace.status !== "active") {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_NOT_FOUND,
      "workspace is not active",
      "workspaceId",
      context,
    );
  }
  return workspace;
}

function requireActorCapability(state, context, capability) {
  const membershipId = membershipIdForReducer(
    context.envelope.workspaceId,
    context.envelope.actorId,
  );
  const membership = getKey(membershipMap(state), membershipId);
  if (
    !membership ||
    membership.status !== "active" ||
    !workspaceRoleHasCapability(membership.role, capability)
  ) {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_CAPABILITY_DENIED,
      "active membership does not grant this capability",
      "actorId",
      context,
    );
  }
  return membership;
}

function workspaceRoleHasCapability(role, capability) {
  return (
    (role === "owner" || role === "admin") &&
    WORKSPACE_ADMIN_CAPABILITIES.has(capability)
  );
}

function requireTargetMembership(state, data, context, activeOnly) {
  assertMembershipId(data.membershipId, "membershipId", context);
  const membership = getKey(membershipMap(state), data.membershipId);
  if (!membership) {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_MEMBERSHIP_NOT_FOUND,
      "membership does not exist",
      "membershipId",
      context,
    );
  }
  if (membership.workspaceId !== context.envelope.workspaceId) {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_SCOPE_MISMATCH,
      "membership belongs to a different workspace",
      "membershipId",
      context,
    );
  }
  if (membership.revision !== data.expectedMembershipRevision) {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_REVISION_CONFLICT,
      `membership revision ${data.expectedMembershipRevision} is not current`,
      "expectedMembershipRevision",
      context,
    );
  }
  if (activeOnly && membership.status !== "active") {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_MEMBERSHIP_INACTIVE,
      "membership is not active",
      "membershipId",
      context,
    );
  }
  return membership;
}

function assertWorkspaceRevision(expected, workspace, context) {
  assertRevision(expected, "expectedWorkspaceRevision", context);
  if (expected !== workspace.revision) {
    failWorkspace(
      REDUCER_ERROR_CODES.WORKSPACE_REVISION_CONFLICT,
      `workspace revision ${expected} is not current`,
      "expectedWorkspaceRevision",
      context,
    );
  }
}

function advanceWorkspace(state, workspace, context) {
  state.entities.workspaces = setKey(
    workspaceMap(state),
    context.envelope.workspaceId,
    { ...workspace, revision: workspace.revision + 1 },
  );
}

function countActiveOwners(state, workspaceId) {
  return Object.values(membershipMap(state)).filter(
    (membership) =>
      membership.workspaceId === workspaceId &&
      membership.role === "owner" &&
      membership.status === "active",
  ).length;
}

function countNonRemovedOwners(state, workspaceId) {
  return Object.values(membershipMap(state)).filter(
    (membership) =>
      membership.workspaceId === workspaceId &&
      membership.role === "owner" &&
      membership.status !== "removed",
  ).length;
}

function failWorkspace(code, detail, field, context) {
  throw reducerError(code, detail, {
    offset: context.offset,
    path: `$.event.data.${field}`,
  });
}

function assertBoundWorkspaceString(value, maxLength, field, context) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    hasControlCharacter(value)
  ) {
    failWorkspace(
      REDUCER_ERROR_CODES.INVALID_EVENT_DATA,
      "value must be a bounded string without control characters",
      field,
      context,
    );
  }
}

function workspaceMap(state) {
  return state.entities.workspaces ?? {};
}

function membershipMap(state) {
  return state.entities.memberships ?? {};
}

function inviteMap(state) {
  return state.entities.invites ?? {};
}

function membershipIdForReducer(workspaceId, principalId) {
  return `mb_${workspaceId.slice(3)}_${principalId.slice(30)}`;
}

function assertData(data, required, optional, context, pathPrefix = "") {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(data, key)) {
      failReducer(
        REDUCER_ERROR_CODES.INVALID_EVENT_DATA,
        `${key} is required`,
        pathPrefix ? `${pathPrefix}.${key}` : key,
        context,
      );
    }
  }
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) {
      failReducer(
        REDUCER_ERROR_CODES.INVALID_EVENT_DATA,
        `${key} is not allowed`,
        pathPrefix ? `${pathPrefix}.${key}` : key,
        context,
      );
    }
  }
}

function assertToken(value, key, context) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/u.test(value)) {
    failReducer(
      REDUCER_ERROR_CODES.INVALID_EVENT_DATA,
      `${key} must be a bounded token`,
      key,
      context,
    );
  }
}

function assertStream(value, key, context) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:/-]{1,400}$/u.test(value)) {
    failReducer(
      REDUCER_ERROR_CODES.INVALID_EVENT_DATA,
      `${key} must be a bounded stream name`,
      key,
      context,
    );
  }
}

function assertTransitionValue(value, key, context) {
  if (value !== null) assertToken(value, key, context);
}

function assertRevision(value, key, context) {
  if (!Number.isSafeInteger(value) || value < 1) {
    failReducer(
      REDUCER_ERROR_CODES.INVALID_EVENT_DATA,
      `${key} must be a positive integer`,
      key,
      context,
    );
  }
}

function assertUnique(map, key, field, context) {
  if (hasKey(map, key)) {
    failReducer(
      REDUCER_ERROR_CODES.DUPLICATE_LOGICAL_ID,
      `${field} ${key} was already applied`,
      field,
      context,
    );
  }
}

function allowedTransition(from, to) {
  if (from === null) return to === "queued";
  if (from === "queued") return to === "running" || to === "cancelled";
  if (from === "running") {
    return to === "succeeded" || to === "failed" || to === "cancelled";
  }
  return false;
}

function failReducer(code, detail, field, context) {
  throw reducerError(code, detail, {
    offset: context.offset,
    path: `$.event.data.${field}`,
  });
}

function cloneState(state) {
  return {
    schemaVersion: state.schemaVersion,
    appliedEventIds: [...state.appliedEventIds],
    eventProvenance: copyJson(state.eventProvenance),
    entities: Object.fromEntries(
      Object.entries(state.entities).map(([key, value]) => [
        key,
        copyJson(value),
      ]),
    ),
    audits: copyJson(state.audits),
  };
}

function copyJson(value) {
  if (Array.isArray(value)) return value.map((item) => copyJson(item));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, copyJson(item)]),
    );
  }
  return value;
}

function registryReducer(eventType) {
  for (const [registeredType, reducer] of Object.entries(REDUCER_REGISTRY_V1)) {
    if (registeredType === eventType) return reducer;
  }
  return undefined;
}

function getKey(map, key) {
  for (const [entryKey, value] of Object.entries(map)) {
    if (entryKey === key) return value;
  }
  return undefined;
}

function hasKey(map, key) {
  for (const [entryKey] of Object.entries(map)) {
    if (entryKey === key) return true;
  }
  return false;
}

function setKey(map, key, value) {
  const entries = Object.entries(map).filter(([entryKey]) => entryKey !== key);
  entries.push([key, value]);
  return Object.fromEntries(entries);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
