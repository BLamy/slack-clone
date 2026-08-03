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
]);

export const REDUCER_ERROR_CODES = Object.freeze({
  DUPLICATE_EVENT_ID: "REDUCER_DUPLICATE_EVENT_ID",
  DUPLICATE_LOGICAL_ID: "REDUCER_DUPLICATE_LOGICAL_ID",
  ILLEGAL_TRANSITION: "REDUCER_ILLEGAL_TRANSITION",
  INVALID_EVENT_DATA: "REDUCER_INVALID_EVENT_DATA",
  INVALID_OFFSET: "REDUCER_INVALID_OFFSET",
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

export function reduceEnvelope(state, envelope, { offset = null } = {}) {
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
  reducer(next, envelope.data, { envelope, offset });
  next.appliedEventIds.push(envelope.eventId);
  next.eventProvenance.push({
    envelope: copyJson(envelope),
    offset,
  });
  return next;
}

export function replayRecords(records) {
  if (!Array.isArray(records)) {
    throw reducerError(
      REDUCER_ERROR_CODES.MALFORMED_ENVELOPE,
      "replay input must be an array of offset records",
      { path: "$.records" },
    );
  }

  let state = createInitialState();
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
    state = reduceEnvelope(state, envelope, { offset });
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
  assertUnique(state.entities.messages, data.messageId, "messageId", context);
  state.entities.messages = setKey(
    state.entities.messages,
    data.messageId,
    copyJson(data),
  );
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
