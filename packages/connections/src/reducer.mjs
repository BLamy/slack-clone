import { CONNECTION_ERROR_CODES, connectionError } from "./errors.mjs";
import {
  canonicalJson,
  canonicalSha256,
  cloneJson,
  deepFreeze,
} from "./canonical.mjs";
import {
  CONNECTION_SCHEMA_VERSION,
  normalizeConnectionEvent,
} from "./schema.mjs";

export function createInitialConnectionState() {
  return {
    schemaVersion: CONNECTION_SCHEMA_VERSION,
    connections: {},
    appliedEventIds: [],
    eventProvenance: [],
  };
}

export function reduceConnectionEvent(state, input) {
  const event = normalizeConnectionEvent(input);
  const currentState = state ?? createInitialConnectionState();
  assertState(currentState);
  if (currentState.appliedEventIds.includes(event.eventId)) {
    throw connectionError(
      CONNECTION_ERROR_CODES.DUPLICATE_EVENT,
      "connection event was already applied",
      { path: "$.eventId", statusCode: 409 },
    );
  }
  const next = cloneState(currentState);
  const current = next.connections[event.connectionId];
  if (event.eventType === "connection.created") {
    reduceCreated(next, event, current);
  } else if (event.eventType === "connection.rotated") {
    reduceRotated(event, current);
  } else if (event.eventType === "connection.disabled") {
    reduceDisabled(event, current);
  } else {
    reduceDeleted(event, current);
  }
  next.appliedEventIds.push(event.eventId);
  next.eventProvenance.push({
    eventId: event.eventId,
    eventType: event.eventType,
    sequence: event.sequence,
    connectionId: event.connectionId,
    eventDigest: canonicalSha256(event),
  });
  return next;
}

export function replayConnectionEvents(events) {
  if (!Array.isArray(events)) {
    throw connectionError(
      CONNECTION_ERROR_CODES.INVALID_EVENT,
      "connection replay input must be an array",
      { path: "$.events" },
    );
  }
  const unique = new Map();
  for (const input of events) {
    const event = normalizeConnectionEvent(input);
    const previous = unique.get(event.eventId);
    if (previous) {
      if (canonicalJson(previous) !== canonicalJson(event)) {
        throw connectionError(
          CONNECTION_ERROR_CODES.DUPLICATE_EVENT,
          "duplicate event id has conflicting bytes",
          { path: "$.eventId", statusCode: 409 },
        );
      }
      continue;
    }
    unique.set(event.eventId, event);
  }
  const ordered = [...unique.values()].sort(compareEvents);
  let state = createInitialConnectionState();
  for (const event of ordered) state = reduceConnectionEvent(state, event);
  return deepFreeze({
    finalState: state,
    state: state,
    connections: state.connections,
    appliedEventIds: state.appliedEventIds,
    eventProvenance: state.eventProvenance,
    stateDigest: connectionStateDigest(state),
    finalStateDigest: connectionStateDigest(state),
    eventDigest: canonicalSha256(ordered),
    orderedEvents: ordered,
  });
}

export function connectionStateDigest(state) {
  assertState(state);
  return canonicalSha256({
    schemaVersion: state.schemaVersion,
    connections: state.connections,
  });
}

export function connectionView(connection, { includeSecretRef = true } = {}) {
  if (!connection) return null;
  const view = cloneJson(connection);
  if (!includeSecretRef) {
    for (const revision of view.revisions) delete revision.secretRef;
  }
  return deepFreeze(view);
}

function reduceCreated(state, event, current) {
  if (current) {
    throw connectionError(
      CONNECTION_ERROR_CODES.INVALID_TRANSITION,
      "connection already exists",
      { path: "$.event.data.connectionId", statusCode: 409 },
    );
  }
  if (event.sequence !== 1 || event.data.revision !== 1) {
    throw connectionError(
      CONNECTION_ERROR_CODES.SEQUENCE_CONFLICT,
      "connection creation must be sequence one and revision one",
      { path: "$.event.sequence", statusCode: 409 },
    );
  }
  const data = event.data;
  state.connections[event.connectionId] = {
    schemaVersion: CONNECTION_SCHEMA_VERSION,
    connectionId: event.connectionId,
    tenantId: data.tenantId,
    workspaceId: data.workspaceId,
    owner: cloneJson(data.owner),
    provider: data.provider,
    integration: data.integration,
    label: data.label,
    metadata: cloneJson(data.metadata),
    status: "active",
    sequence: event.sequence,
    activeRevision: 1,
    revisions: [
      {
        revision: 1,
        secretRef: cloneJson(data.secretRef),
        committedAt: event.serverTimestamp,
        sourceEventId: event.eventId,
      },
    ],
    createdAt: event.serverTimestamp,
    updatedAt: event.serverTimestamp,
    tombstone: null,
  };
}

function reduceRotated(event, current) {
  assertCurrent(current, event);
  assertNextSequence(current, event);
  if (current.status !== "active") {
    throw connectionError(
      CONNECTION_ERROR_CODES.NOT_ACTIVE,
      "disabled or deleted connections cannot rotate",
      { statusCode: 409 },
    );
  }
  if (event.data.expectedRevision !== current.activeRevision) {
    throw connectionError(
      CONNECTION_ERROR_CODES.REVISION_CONFLICT,
      "rotation expected revision is stale",
      { path: "$.event.data.expectedRevision", statusCode: 409 },
    );
  }
  if (event.data.revision !== current.activeRevision + 1) {
    throw connectionError(
      CONNECTION_ERROR_CODES.REVISION_CONFLICT,
      "rotation revision must advance exactly once",
      { path: "$.event.data.revision", statusCode: 409 },
    );
  }
  current.sequence = event.sequence;
  current.activeRevision = event.data.revision;
  current.revisions.push({
    revision: event.data.revision,
    secretRef: cloneJson(event.data.secretRef),
    committedAt: event.serverTimestamp,
    sourceEventId: event.eventId,
  });
  current.updatedAt = event.serverTimestamp;
}

function reduceDisabled(event, current) {
  assertCurrent(current, event);
  assertNextSequence(current, event);
  if (current.status !== "active") {
    throw connectionError(
      CONNECTION_ERROR_CODES.INVALID_TRANSITION,
      "only active connections can be disabled",
      { statusCode: 409 },
    );
  }
  current.sequence = event.sequence;
  current.status = "disabled";
  current.updatedAt = event.serverTimestamp;
  current.disabledAt = event.serverTimestamp;
  current.disableReason = event.data.reason;
}

function reduceDeleted(event, current) {
  assertCurrent(current, event);
  assertNextSequence(current, event);
  if (current.status === "deleted") {
    throw connectionError(
      CONNECTION_ERROR_CODES.INVALID_TRANSITION,
      "connection is already deleted",
      { statusCode: 409 },
    );
  }
  current.sequence = event.sequence;
  current.status = "deleted";
  current.updatedAt = event.serverTimestamp;
  current.tombstone = {
    deletedAt: event.serverTimestamp,
    eventId: event.eventId,
    reason: event.data.reason,
  };
}

function assertCurrent(current, event) {
  if (!current) {
    throw connectionError(
      CONNECTION_ERROR_CODES.INVALID_STATE,
      "connection does not have a creation event",
      { path: "$.event.connectionId", statusCode: 409 },
    );
  }
  if (current.workspaceId !== event.workspaceId) {
    throw connectionError(
      CONNECTION_ERROR_CODES.SCOPE_MISMATCH,
      "connection belongs to another workspace",
      { statusCode: 409 },
    );
  }
}

function assertNextSequence(current, event) {
  if (event.sequence !== current.sequence + 1) {
    throw connectionError(
      CONNECTION_ERROR_CODES.SEQUENCE_CONFLICT,
      "connection event sequence is not the next committed sequence",
      { path: "$.event.sequence", statusCode: 409 },
    );
  }
}

function compareEvents(left, right) {
  if (left.connectionId !== right.connectionId) {
    return compareKeys(left.connectionId, right.connectionId);
  }
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  return compareKeys(left.eventId, right.eventId);
}

function compareKeys(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function cloneState(state) {
  return {
    schemaVersion: state.schemaVersion,
    connections: cloneJson(state.connections),
    appliedEventIds: [...state.appliedEventIds],
    eventProvenance: cloneJson(state.eventProvenance),
  };
}

function assertState(state) {
  if (
    !state ||
    state.schemaVersion !== CONNECTION_SCHEMA_VERSION ||
    !state.connections ||
    !Array.isArray(state.appliedEventIds) ||
    !Array.isArray(state.eventProvenance)
  ) {
    throw connectionError(
      CONNECTION_ERROR_CODES.INVALID_STATE,
      "connection state is invalid",
      { statusCode: 409 },
    );
  }
}
