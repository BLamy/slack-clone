import {
  agentConfigDigest,
  agentConfigRevisionId,
  normalizeAgentConfig,
  validateAgentConfigAgentId,
  validateAgentConfigRevisionEventData,
  ZERO_OFFSET,
} from "@stream-slack/protocol";
import { replayRecords } from "@stream-slack/reducers";

import { appendIssuedEvent } from "./append-boundary.mjs";
import {
  digestEventEnvelope,
  EVENT_ENVELOPE_SCHEMA_VERSION,
  issueEventEnvelope,
} from "./envelope.mjs";
import { streamNames } from "./topology.mjs";

export const AGENT_CONFIG_STREAM_ERROR_CODES = Object.freeze({
  APPEND_CONFLICT: "AGENT_CONFIG_STREAM_APPEND_CONFLICT",
  INVALID_REQUEST: "AGENT_CONFIG_STREAM_INVALID_REQUEST",
  INVALID_STATE: "AGENT_CONFIG_STREAM_INVALID_STATE",
  STALE_REVISION: "AGENT_CONFIG_STREAM_STALE_REVISION",
});

const REVISION_OPERATIONS = new Set(["create", "revise"]);
const LIFECYCLE_EVENT_TYPES = new Set([
  "agent.config.activated",
  "agent.config.disabled",
  "agent.config.retired",
]);

export class AgentConfigStreamError extends Error {
  constructor(code, detail, { statusCode = 409, ...metadata } = {}) {
    super(`${code}: ${detail}`);
    this.name = "AgentConfigStreamError";
    this.code = code;
    this.detail = detail;
    this.statusCode = statusCode;
    Object.assign(this, metadata);
  }

  toJSON() {
    return {
      code: this.code,
      currentRevision: this.currentRevision ?? null,
      currentRevisionId: this.currentRevisionId ?? null,
      detail: this.detail,
      expectedRevision: this.expectedRevision ?? null,
      expectedRevisionId: this.expectedRevisionId ?? null,
      name: this.name,
      statusCode: this.statusCode,
    };
  }
}

export function createAgentConfigStream({
  agentId,
  dispatch = null,
  recover = null,
  producerEpoch = 0,
  producerId = null,
  streamStore,
  workspaceId,
}) {
  if (
    !streamStore ||
    typeof streamStore.read !== "function" ||
    typeof streamStore.append !== "function"
  ) {
    throw new TypeError(
      "agent config stream requires a Durable Streams store with read and append",
    );
  }
  validateAgentConfigAgentId(agentId, { expectedWorkspaceId: workspaceId });
  const stream = streamNames.agentConfig(workspaceId, agentId);
  if (producerId !== null && typeof producerId !== "string") {
    throw new TypeError("agent config producerId must be a string or null");
  }
  if (dispatch !== null && typeof dispatch !== "function") {
    throw new TypeError("agent config dispatch must be a function or null");
  }
  if (recover !== null && typeof recover !== "function") {
    throw new TypeError("agent config recover must be a function or null");
  }
  if (!Number.isSafeInteger(producerEpoch) || producerEpoch < 0) {
    throw new TypeError(
      "agent config producerEpoch must be a non-negative safe integer",
    );
  }

  let producerSequence = 0;

  async function read({ signal } = {}) {
    const snapshot = await streamStore.read(stream, "-1", { signal });
    const replay = replayAgentConfigStream(snapshot.records);
    return {
      ...snapshot,
      replay,
      stream,
      state: replay.finalState,
      stateDigest: replay.finalStateDigest,
    };
  }

  async function create(request) {
    return appendRevision("create", request);
  }

  async function revise(request) {
    return appendRevision("revise", request);
  }

  async function appendRevision(operation, request) {
    if (!REVISION_OPERATIONS.has(operation)) {
      throw new AgentConfigStreamError(
        AGENT_CONFIG_STREAM_ERROR_CODES.INVALID_REQUEST,
        "revision operation is not registered",
        { statusCode: 400 },
      );
    }
    const snapshot = await readSnapshot(request?.signal);
    const current = currentAgentConfig(snapshot.records);
    const expected = expectedHead(request, current);
    if (recover) {
      const recovered = await recoverExisting({
        data: revisionData({
          agentId,
          config: normalizeAgentConfig(request?.config),
          expected,
          headRevision: expected.revision,
        }),
        eventType:
          operation === "create"
            ? "agent.config.created"
            : "agent.config.revised",
        request,
        snapshot,
      });
      if (recovered) {
        return {
          ...recovered,
          revision: recovered.event.data.revision,
          revisionId: recovered.event.data.revisionId,
        };
      }
    }
    assertExpectedHead(expected, current);
    if (current?.status === "retired") {
      throw new AgentConfigStreamError(
        AGENT_CONFIG_STREAM_ERROR_CODES.INVALID_REQUEST,
        "retired agent configuration cannot receive a revision",
        { statusCode: 409 },
      );
    }

    const config = normalizeAgentConfig(request?.config);
    const eventType =
      operation === "create" ? "agent.config.created" : "agent.config.revised";
    const data = revisionData({
      agentId,
      config,
      expected,
      headRevision: current?.headRevision ?? 0,
    });
    validateRevisionData(eventType, data, workspaceId);
    const committed = await appendEvent({
      data,
      eventType,
      request,
      snapshot,
    });
    return {
      ...committed,
      revision: data.revision,
      revisionId: data.revisionId,
    };
  }

  async function activate(request) {
    return appendLifecycle("agent.config.activated", request);
  }

  async function disable(request) {
    return appendLifecycle("agent.config.disabled", request);
  }

  async function retire(request) {
    return appendLifecycle("agent.config.retired", request);
  }

  async function appendLifecycle(eventType, request) {
    if (!LIFECYCLE_EVENT_TYPES.has(eventType)) {
      throw new AgentConfigStreamError(
        AGENT_CONFIG_STREAM_ERROR_CODES.INVALID_REQUEST,
        "lifecycle event is not registered",
        { statusCode: 400 },
      );
    }
    const snapshot = await readSnapshot(request?.signal);
    const current = currentAgentConfig(snapshot.records);
    if (!current) {
      throw new AgentConfigStreamError(
        AGENT_CONFIG_STREAM_ERROR_CODES.INVALID_STATE,
        "agent configuration stream has no created revision",
        { statusCode: 409 },
      );
    }
    const expected = expectedHead(request, current);
    if (recover) {
      const recovered = await recoverExisting({
        data: lifecycleData(eventType, request, expected, agentId),
        eventType,
        request,
        snapshot,
      });
      if (recovered) return recovered;
    }
    assertExpectedHead(expected, current);
    assertLifecycleAllowed(eventType, request, current);
    const data = {
      agentId,
      expectedRevision: expected.revision,
      expectedRevisionId: expected.revisionId,
    };
    if (eventType === "agent.config.activated") {
      data.revisionId = request?.revisionId;
    }
    validateRevisionData(eventType, data, workspaceId);
    const committed = await appendEvent({
      data,
      eventType,
      request,
      snapshot,
    });
    return {
      ...committed,
      revisionId: data.revisionId ?? null,
    };
  }

  async function appendEvent({ data, eventType, request, snapshot }) {
    const input = eventInput({ data, eventType, request, workspaceId });
    let dispatchReceipt = null;
    const producer =
      producerId === null
        ? undefined
        : {
            epoch: producerEpoch,
            id: producerId,
            seq: producerSequence,
          };
    try {
      const committed = await appendIssuedEvent({
        append: async ({ digest, envelope }) => {
          if (dispatch) {
            const dispatched = await dispatch(
              {
                actorId: request?.actorId,
                expectedHead: snapshot.nextOffset,
                idempotencyKey: request?.idempotencyKey,
                operation: eventType,
                payload: { digest, event: envelope },
                stream,
                workspaceId,
              },
              {
                context: request?.dispatchContext ?? null,
                signal: request?.signal,
              },
            );
            dispatchReceipt = dispatched.receipt;
            return {
              appendResult: { nextOffset: dispatched.receipt.nextOffset },
              digest,
              envelope,
            };
          }
          const appendResult = await streamStore.append(
            stream,
            { digest, event: envelope },
            {
              producer,
              signal: request?.signal,
              streamSeq: snapshot.nextOffset,
            },
          );
          producerSequence += 1;
          return { appendResult, digest, envelope };
        },
        input,
        issuance: {
          clock: request?.clock ?? (() => new Date()),
          eventId: request?.eventId,
        },
      });
      return {
        digest: committed.digest,
        event: committed.envelope,
        nextOffset: committed.appendResult.nextOffset,
        receipt: dispatchReceipt,
        stream,
      };
    } catch (error) {
      if (isAppendConflict(error)) {
        const latest = await readSnapshot(request?.signal);
        const current = currentAgentConfig(latest.records);
        throw new AgentConfigStreamError(
          AGENT_CONFIG_STREAM_ERROR_CODES.STALE_REVISION,
          "agent configuration stream head changed before append",
          {
            currentRevision: current?.headRevision ?? 0,
            currentRevisionId: current?.lastRevisionId ?? null,
            expectedRevision: data.expectedRevision,
            expectedRevisionId: data.expectedRevisionId,
          },
        );
      }
      throw error;
    }
  }

  async function readSnapshot(signal) {
    return streamStore.read(stream, "-1", { signal });
  }

  async function recoverExisting({ data, eventType, request, snapshot }) {
    if (!recover || !request?.idempotencyKey) return null;
    const input = eventInput({ data, eventType, request, workspaceId });
    const envelope = issueEventEnvelope(input, {
      clock: request?.clock ?? (() => new Date()),
      eventId: request?.eventId,
    });
    const digest = digestEventEnvelope(envelope);
    const recovered = await recover(
      {
        actorId: request?.actorId,
        expectedHead: snapshot.nextOffset,
        idempotencyKey: request?.idempotencyKey,
        operation: eventType,
        payload: { digest, event: envelope },
        stream,
        workspaceId,
      },
      {
        context: request?.dispatchContext ?? null,
        signal: request?.signal,
      },
    );
    if (!recovered) return null;
    const recoveredEnvelope = recovered.event?.event ?? recovered.event;
    if (
      recoveredEnvelope?.eventType !== eventType ||
      recoveredEnvelope?.eventId !== envelope.eventId ||
      recoveredEnvelope?.data?.agentId !== agentId
    ) {
      throw new AgentConfigStreamError(
        AGENT_CONFIG_STREAM_ERROR_CODES.INVALID_STATE,
        "idempotent dispatch receipt does not match the requested agent configuration event",
        { statusCode: 409 },
      );
    }
    return {
      digest,
      event: recoveredEnvelope,
      nextOffset: recovered.receipt.nextOffset,
      receipt: recovered.receipt,
      stream,
    };
  }

  return Object.freeze({
    activate,
    create,
    disable,
    read,
    revise,
    retire,
    stream,
  });
}

function eventInput({ data, eventType, request, workspaceId }) {
  return {
    actorId: request?.actorId,
    causation: request?.causation ?? null,
    correlationId: request?.correlationId,
    data,
    eventType,
    idempotencyKey: request?.idempotencyKey,
    schemaVersion: EVENT_ENVELOPE_SCHEMA_VERSION,
    workspaceId,
  };
}

function revisionData({ agentId, config, expected, headRevision }) {
  const configDigest = agentConfigDigest(config);
  const revision = headRevision + 1;
  return {
    agentId,
    config,
    configDigest,
    expectedRevision: expected.revision,
    expectedRevisionId: expected.revisionId,
    predecessorRevisionId: expected.revisionId,
    revision,
    revisionId: agentConfigRevisionId({ agentId, configDigest, revision }),
  };
}

function lifecycleData(eventType, request, expected, agentId) {
  const data = {
    agentId,
    expectedRevision: expected.revision,
    expectedRevisionId: expected.revisionId,
  };
  if (eventType === "agent.config.activated") {
    data.revisionId = request?.revisionId;
  }
  return data;
}

export function replayAgentConfigStream(records) {
  if (!Array.isArray(records)) {
    throw new AgentConfigStreamError(
      AGENT_CONFIG_STREAM_ERROR_CODES.INVALID_STATE,
      "agent configuration stream records must be an array",
      { statusCode: 400 },
    );
  }
  return replayRecords(
    records.map((record, index) => ({
      event: record?.event ?? record?.envelope ?? record,
      offset: record?.offset ?? syntheticOffset(index + 1),
    })),
  );
}

function currentAgentConfig(records) {
  const replay = replayAgentConfigStream(records);
  const agents = replay.finalState.entities.agents;
  const values = Object.values(agents);
  const current = values.find((value) => Array.isArray(value.revisions));
  if (
    values.some((value) => Array.isArray(value.revisions) && value !== current)
  ) {
    throw new AgentConfigStreamError(
      AGENT_CONFIG_STREAM_ERROR_CODES.INVALID_STATE,
      "agent configuration stream contains more than one agent",
      { statusCode: 400 },
    );
  }
  return current ?? null;
}

function expectedHead(request, current) {
  const revision =
    request && Object.hasOwn(request, "expectedRevision")
      ? request.expectedRevision
      : (current?.headRevision ?? 0);
  const revisionId =
    request && Object.hasOwn(request, "expectedRevisionId")
      ? request.expectedRevisionId
      : (current?.lastRevisionId ?? null);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new AgentConfigStreamError(
      AGENT_CONFIG_STREAM_ERROR_CODES.INVALID_REQUEST,
      "expectedRevision must be a non-negative safe integer",
      { statusCode: 400 },
    );
  }
  return { revision, revisionId };
}

function assertExpectedHead(expected, current) {
  const currentRevision = current?.headRevision ?? 0;
  const currentRevisionId = current?.lastRevisionId ?? null;
  if (
    expected.revision !== currentRevision ||
    expected.revisionId !== currentRevisionId
  ) {
    throw new AgentConfigStreamError(
      AGENT_CONFIG_STREAM_ERROR_CODES.STALE_REVISION,
      "expected revision is not the current stream head",
      {
        currentRevision,
        currentRevisionId,
        expectedRevision: expected.revision,
        expectedRevisionId: expected.revisionId,
      },
    );
  }
}

function assertLifecycleAllowed(eventType, request, current) {
  if (eventType === "agent.config.activated") {
    if (current.status === "retired") {
      throw new AgentConfigStreamError(
        AGENT_CONFIG_STREAM_ERROR_CODES.INVALID_REQUEST,
        "retired agent configuration cannot be activated",
        { statusCode: 409 },
      );
    }
    if (
      !current.revisions.some(
        (revision) => revision.revisionId === request?.revisionId,
      )
    ) {
      throw new AgentConfigStreamError(
        AGENT_CONFIG_STREAM_ERROR_CODES.INVALID_REQUEST,
        "activation target revision is not in the agent history",
        { statusCode: 409 },
      );
    }
    if (
      current.status === "active" &&
      current.activeRevisionId === request?.revisionId
    ) {
      throw new AgentConfigStreamError(
        AGENT_CONFIG_STREAM_ERROR_CODES.INVALID_REQUEST,
        "activation target revision is already active",
        { statusCode: 409 },
      );
    }
    return;
  }
  if (eventType === "agent.config.disabled" && current.status !== "active") {
    throw new AgentConfigStreamError(
      AGENT_CONFIG_STREAM_ERROR_CODES.INVALID_REQUEST,
      `agent configuration cannot be disabled from ${current.status}`,
      { statusCode: 409 },
    );
  }
  if (eventType === "agent.config.retired" && current.status === "retired") {
    throw new AgentConfigStreamError(
      AGENT_CONFIG_STREAM_ERROR_CODES.INVALID_REQUEST,
      "retired agent configuration is terminal",
      { statusCode: 409 },
    );
  }
}

function validateRevisionData(eventType, data, workspaceId) {
  try {
    return validateAgentConfigRevisionEventData(eventType, data, {
      expectedWorkspaceId: workspaceId,
    });
  } catch (error) {
    throw new AgentConfigStreamError(
      AGENT_CONFIG_STREAM_ERROR_CODES.INVALID_REQUEST,
      error?.detail ?? "agent configuration event data is invalid",
      { statusCode: 400 },
    );
  }
}

function isAppendConflict(error) {
  return (
    error?.code === "APPEND_CONFLICT" ||
    error?.code === "STALE_FENCE" ||
    error?.status === 409 ||
    error?.statusCode === 409
  );
}

function syntheticOffset(sequence) {
  return `${ZERO_OFFSET.slice(0, 17)}${sequence.toString(16).padStart(16, "0")}`;
}
