import { canonicalSha256, cloneJson, deepFreeze } from "./canonical.mjs";
import {
  CONNECTION_ERROR_CODES,
  connectionError,
  connectionNotFound,
} from "./errors.mjs";
import {
  CONNECTION_ACTIONS,
  normalizeConnectionDefinition,
  normalizeConnectionEvent,
  normalizeOpaqueIdForStore,
  normalizePrincipal,
  normalizeReason,
  normalizeSecretRef,
} from "./schema.mjs";
import {
  connectionStateDigest,
  connectionView,
  createInitialConnectionState,
  reduceConnectionEvent,
} from "./reducer.mjs";

export function createConnectionStore({
  tenantId,
  workspaceId,
  clock = () => new Date(),
  idFactory = defaultIdFactory(),
} = {}) {
  const scope = {
    tenantId: normalizeStoreIdentifier(tenantId, "$.tenantId"),
    workspaceId: normalizeStoreIdentifier(workspaceId, "$.workspaceId"),
  };
  if (typeof clock !== "function") {
    throw new TypeError("connection store clock must be a function");
  }
  if (typeof idFactory !== "function") {
    throw new TypeError("connection store idFactory must be a function");
  }

  let state = createInitialConnectionState();
  const events = [];
  const idempotency = new Map();

  function create(input = {}) {
    const actor = actorFromInput(input, scope);
    assertScope(actor, scope);
    assertManager(actor);
    const connectionId = input.connectionId ?? idFactory("connection");
    const definition = normalizeConnectionDefinition(
      {
        schemaVersion: input.schemaVersion,
        connectionId,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        owner: input.owner,
        provider: input.provider,
        integration: input.integration,
        label: input.label,
        metadata: input.metadata ?? {},
        secretRef: input.secretRef,
      },
      "$.connection",
    );
    assertOwnerScope(definition.owner, scope);
    const idempotencyKey = normalizeIdempotencyKey(
      input.idempotencyKey ?? idFactory("connection-create"),
    );
    return commit(
      "create",
      idempotencyKey,
      {
        connectionId: definition.connectionId,
        tenantId: definition.tenantId,
        workspaceId: definition.workspaceId,
        owner: definition.owner,
        provider: definition.provider,
        integration: definition.integration,
        label: definition.label,
        metadata: definition.metadata,
        secretRef: definition.secretRef,
      },
      actor.id,
      definition.connectionId,
    );
  }

  function rotate(input = {}) {
    const actor = actorFromInput(input, scope);
    const connection = requireForAction(
      input.connectionId,
      actor,
      "rotate",
      state,
    );
    const expectedRevision =
      input.expectedRevision ?? connection.activeRevision;
    const secretRef = normalizeSecretRef(input.secretRef, "$.secretRef");
    const idempotencyKey = normalizeIdempotencyKey(
      input.idempotencyKey ?? idFactory("connection-rotate"),
    );
    return commit(
      "rotate",
      idempotencyKey,
      {
        expectedRevision,
        revision: expectedRevision + 1,
        secretRef,
      },
      actor.id,
      connection.connectionId,
    );
  }

  function disable(input = {}) {
    const actor = actorFromInput(input, scope);
    const connection = requireForAction(
      input.connectionId,
      actor,
      "disable",
      state,
    );
    const idempotencyKey = normalizeIdempotencyKey(
      input.idempotencyKey ?? idFactory("connection-disable"),
    );
    return commit(
      "disable",
      idempotencyKey,
      { reason: normalizeReason(input.reason) },
      actor.id,
      connection.connectionId,
    );
  }

  function remove(input = {}) {
    const actor = actorFromInput(input, scope);
    const connection = requireForAction(
      input.connectionId,
      actor,
      "delete",
      state,
    );
    const idempotencyKey = normalizeIdempotencyKey(
      input.idempotencyKey ?? idFactory("connection-delete"),
    );
    return commit(
      "delete",
      idempotencyKey,
      { reason: normalizeReason(input.reason) },
      actor.id,
      connection.connectionId,
    );
  }

  function read(input = {}) {
    const actor = actorFromInput(input, scope);
    const connection = requireForAction(
      input.connectionId,
      actor,
      "read",
      state,
    );
    return connectionView(connection);
  }

  function captureForRun(input = {}) {
    const actor = actorFromInput(input, scope);
    const connection = requireForAction(
      input.connectionId,
      actor,
      "grant",
      state,
    );
    if (connection.status !== "active") {
      throw connectionError(
        CONNECTION_ERROR_CODES.NOT_ACTIVE,
        "connection does not accept new grants",
        { statusCode: 409 },
      );
    }
    const runId = normalizeStoreIdentifier(input.runId, "$.runId");
    const revision = connection.revisions.find(
      (candidate) => candidate.revision === connection.activeRevision,
    );
    if (!revision) {
      throw connectionError(
        CONNECTION_ERROR_CODES.INVALID_STATE,
        "active SecretRef revision is missing",
        { statusCode: 409 },
      );
    }
    const capturedAt = timestamp(clock);
    const capture = {
      schemaVersion: 1,
      connectionId: connection.connectionId,
      tenantId: connection.tenantId,
      workspaceId: connection.workspaceId,
      runId,
      revision: revision.revision,
      secretRef: cloneJson(revision.secretRef),
      capturedAt,
      bindingDigest: canonicalSha256({
        connectionId: connection.connectionId,
        revision: revision.revision,
        runId,
        secretRef: revision.secretRef,
        tenantId: connection.tenantId,
        workspaceId: connection.workspaceId,
      }),
    };
    return deepFreeze(capture);
  }

  function authorization(input = {}) {
    const actor = actorFromInput(input, scope);
    try {
      requireForAction(
        input.connectionId,
        actor,
        input.action ?? "read",
        state,
      );
      return { allowed: true, code: null };
    } catch (error) {
      return { allowed: false, code: error.code };
    }
  }

  function commit(operation, idempotencyKey, data, actorId, connectionId) {
    const identity = canonicalSha256({
      connectionId,
      data,
      operation,
      workspaceId: scope.workspaceId,
    });
    const idempotencySlot = operation + ":" + idempotencyKey;
    const previous = idempotency.get(idempotencySlot);
    if (previous) {
      if (previous.identity !== identity) {
        throw connectionError(
          CONNECTION_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          "idempotency key was reused for a different connection request",
          { statusCode: 409 },
        );
      }
      return resultFor(previous.event, true);
    }

    const current = state.connections[connectionId];
    const sequence = current ? current.sequence + 1 : 1;
    const event = normalizeConnectionEvent({
      schemaVersion: 1,
      eventId: idFactory("connection-event"),
      eventType: "connection." + operation + "d",
      workspaceId: scope.workspaceId,
      actorId,
      idempotencyKey,
      sequence,
      serverTimestamp: timestamp(clock),
      connectionId,
      data:
        operation === "create"
          ? data
          : operation === "rotate"
            ? data
            : { reason: data.reason },
    });
    state = reduceConnectionEvent(state, event);
    events.push(event);
    idempotency.set(idempotencySlot, { identity, event });
    return resultFor(event, false);
  }

  function resultFor(event, replayed) {
    return deepFreeze({
      event,
      connection: connectionView(state.connections[event.connectionId]),
      stateDigest: connectionStateDigest(state),
      replayed,
    });
  }

  function snapshot() {
    return deepFreeze(cloneJson(state));
  }

  function eventLog() {
    return deepFreeze(cloneJson(events));
  }

  return Object.freeze({
    captureForRun,
    create,
    delete: remove,
    disable,
    events: eventLog,
    get: read,
    read,
    rotate,
    snapshot,
    stateDigest: () => connectionStateDigest(state),
    authorization,
  });
}

export function assertConnectionAccess(connection, principal, action = "read") {
  if (!CONNECTION_ACTIONS.includes(action)) {
    throw connectionError(
      CONNECTION_ERROR_CODES.INVALID_REQUEST,
      "connection action is unsupported",
      { path: "$.action" },
    );
  }
  const actor = normalizePrincipal(principal);
  if (
    actor.tenantId !== connection.tenantId ||
    actor.workspaceId !== connection.workspaceId
  ) {
    throw connectionNotFound();
  }
  if (isManager(actor)) return actor;
  const ownerMatches =
    connection.owner.kind === "workspace"
      ? true
      : connection.owner.kind === "agent"
        ? actor.kind === "agent" && actor.id === connection.owner.id
        : actor.kind === "user" && actor.id === connection.owner.id;
  if (!ownerMatches) {
    throw connectionError(
      CONNECTION_ERROR_CODES.FORBIDDEN,
      "principal is not authorized for this connection",
      { statusCode: 403 },
    );
  }
  if (
    ["rotate", "disable", "delete"].includes(action) &&
    connection.owner.kind === "workspace"
  ) {
    throw connectionError(
      CONNECTION_ERROR_CODES.FORBIDDEN,
      "workspace-owned connection mutations require an administrator",
      { statusCode: 403 },
    );
  }
  return actor;
}

function requireForAction(connectionId, actor, action, currentState) {
  const normalizedId = normalizeOpaqueIdForStore(
    connectionId,
    "$.connectionId",
  );
  const connection = stateForActor(normalizedId);
  assertConnectionAccess(connection, actor, action);
  return connection;

  function stateForActor(id) {
    const found = currentState.connections[id];
    if (!found) throw connectionNotFound();
    if (
      found.tenantId !== actor.tenantId ||
      found.workspaceId !== actor.workspaceId
    ) {
      throw connectionNotFound();
    }
    return found;
  }
}

function actorFromInput(input, scope) {
  const candidate = input.actor ?? input.principal;
  if (candidate) return normalizePrincipal(candidate, "$.actor");
  if (input.actorId) {
    return normalizePrincipal(
      {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        id: input.actorId,
        kind: input.actorKind ?? "user",
        role: input.actorRole ?? "admin",
        capabilities: input.capabilities ?? [],
      },
      "$.actor",
    );
  }
  throw connectionError(
    CONNECTION_ERROR_CODES.INVALID_REQUEST,
    "actor is required",
    { path: "$.actor" },
  );
}

function assertManager(actor) {
  if (!isManager(actor)) {
    throw connectionError(
      CONNECTION_ERROR_CODES.FORBIDDEN,
      "connection management requires an administrator",
      { statusCode: 403 },
    );
  }
}

function isManager(actor) {
  return (
    ["owner", "admin"].includes(actor.role) ||
    actor.capabilities.includes("connection.manage")
  );
}

function assertOwnerScope(owner, scope) {
  if (owner.kind === "workspace" && owner.id !== scope.workspaceId) {
    throw connectionError(
      CONNECTION_ERROR_CODES.SCOPE_MISMATCH,
      "workspace connection owner does not match the stream workspace",
      { statusCode: 409 },
    );
  }
}

function assertScope(actor, scope) {
  if (
    actor.tenantId !== scope.tenantId ||
    actor.workspaceId !== scope.workspaceId
  ) {
    throw connectionError(
      CONNECTION_ERROR_CODES.SCOPE_MISMATCH,
      "actor is outside the connection store scope",
      { statusCode: 403 },
    );
  }
}

function normalizeIdempotencyKey(value) {
  return normalizeOpaqueIdForStore(value, "$.idempotencyKey");
}

function normalizeStoreIdentifier(value, path) {
  return normalizeOpaqueIdForStore(value, path);
}

function timestamp(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw connectionError(
      CONNECTION_ERROR_CODES.INVALID_REQUEST,
      "connection clock returned an invalid timestamp",
      { statusCode: 400 },
    );
  }
  return value.toISOString();
}

function defaultIdFactory() {
  let counter = 0;
  return (kind) => {
    counter += 1;
    return kind + "-" + String(counter).padStart(8, "0");
  };
}
