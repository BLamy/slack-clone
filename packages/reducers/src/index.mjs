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
]);

export const REDUCER_ERROR_CODES = Object.freeze({
  DUPLICATE_EVENT_ID: "REDUCER_DUPLICATE_EVENT_ID",
  DUPLICATE_LOGICAL_ID: "REDUCER_DUPLICATE_LOGICAL_ID",
  ILLEGAL_TRANSITION: "REDUCER_ILLEGAL_TRANSITION",
  INVALID_EVENT_DATA: "REDUCER_INVALID_EVENT_DATA",
  MALFORMED_ENVELOPE: "REDUCER_MALFORMED_ENVELOPE",
  OFFSET_REUSED: "REDUCER_OFFSET_REUSED",
  UNKNOWN_EVENT_TYPE: "REDUCER_UNKNOWN_EVENT_TYPE",
  UNSUPPORTED_SCHEMA_VERSION: "REDUCER_UNSUPPORTED_SCHEMA_VERSION",
});

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
        REDUCER_ERROR_CODES.MALFORMED_ENVELOPE,
        "record offset must be a non-empty string",
        { offset: String(offset), path: `$.records[${index}].offset` },
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

function assertData(data, required, optional, context) {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(data, key)) {
      failReducer(
        REDUCER_ERROR_CODES.INVALID_EVENT_DATA,
        `${key} is required`,
        key,
        context,
      );
    }
  }
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) {
      failReducer(
        REDUCER_ERROR_CODES.INVALID_EVENT_DATA,
        `${key} is not allowed`,
        key,
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
