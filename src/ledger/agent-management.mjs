import {
  validateAgentConfigAgentId,
  validateAgentConfigRevisionId,
  validatePrincipalId,
  validatePrincipalProfile,
  validateSubjectBinding,
  validateWorkspaceId,
} from "@stream-slack/protocol";

import { readJson, sendJson } from "@stream-slack/http";

import { digestEventEnvelope, issueEventEnvelope } from "./envelope.mjs";
import {
  createAgentConfigStream,
  AgentConfigStreamError,
} from "./agent-config-stream.mjs";

const AGENT_ROUTE =
  /^\/api\/workspaces\/([^/]+)\/agents(?:\/([^/]+)(?:\/(config|history|revisions|activate|disable|revoke))?)?$/u;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const STABLE_EVENT_TIMESTAMP = "2026-08-06T00:00:00.000Z";
const CURSOR_KEYS = ["kind", "index", "version"];
const IDEMPOTENCY_PATTERN = /^ik_[0-9a-hjkmnp-tv-z]{26}$/u;
const CREATE_KEYS = ["agentId", "ownerPrincipalId", "profile"];
const CONFIG_KEYS = ["config", "expectedRevision", "expectedRevisionId"];
const ACTIVATE_KEYS = ["expectedRevision", "expectedRevisionId", "revisionId"];
const LIFECYCLE_KEYS = ["expectedRevision", "expectedRevisionId"];
const SECRET_KEY_PATTERN =
  /(?:api[-_]?key|authorization|credential|environment|password|secret|token)/iu;
const SECRET_VALUE_PATTERN =
  /(?:bearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}|-----BEGIN [^-]*PRIVATE KEY-----)/iu;

export const AGENT_MANAGEMENT_ERROR_CODES = Object.freeze({
  AUTHENTICATION_REQUIRED: "AGENT_MANAGEMENT_AUTHENTICATION_REQUIRED",
  CONFLICT: "AGENT_MANAGEMENT_CONFLICT",
  INVALID_CURSOR: "AGENT_MANAGEMENT_INVALID_CURSOR",
  INVALID_REQUEST: "AGENT_MANAGEMENT_INVALID_REQUEST",
  METHOD_NOT_ALLOWED: "AGENT_MANAGEMENT_METHOD_NOT_ALLOWED",
  NOT_FOUND: "AGENT_MANAGEMENT_NOT_FOUND",
  INTERNAL: "AGENT_MANAGEMENT_INTERNAL_ERROR",
});

export class AgentManagementError extends Error {
  constructor(code, detail, { statusCode = 400 } = {}) {
    super(`${code}: ${detail}`);
    this.name = "AgentManagementError";
    this.code = code;
    this.detail = detail;
    this.statusCode = statusCode;
  }
}

export function createAgentManagementApi({
  dispatchDoor,
  sessionUser,
  streamStore,
  workspaceAuthorization,
  workspaceDirectory,
  workspaceId,
}) {
  if (!dispatchDoor || typeof dispatchDoor.dispatch !== "function") {
    throw new TypeError("agent management requires a dispatch door");
  }
  if (typeof sessionUser !== "function") {
    throw new TypeError("agent management requires sessionUser");
  }
  if (!streamStore || typeof streamStore.read !== "function") {
    throw new TypeError("agent management requires a Durable Streams store");
  }
  for (const method of [
    "authorizeDispatch",
    "authorizeRead",
    "contextForRequest",
  ]) {
    if (typeof workspaceAuthorization?.[method] !== "function") {
      throw new TypeError(
        `agent management workspace authorization requires ${method}`,
      );
    }
  }
  for (const method of ["lookupPrincipal", "read"]) {
    if (typeof workspaceDirectory?.[method] !== "function") {
      throw new TypeError(
        `agent management workspace directory requires ${method}`,
      );
    }
  }
  validateWorkspaceId(workspaceId);

  function configStream(agentId) {
    return createAgentConfigStream({
      agentId,
      dispatch: dispatchDoor.dispatch,
      recover: dispatchDoor.recover,
      streamStore,
      workspaceId,
    });
  }

  async function handleApi(request, response, url) {
    const match = url.pathname.match(AGENT_ROUTE);
    if (!match) return false;

    try {
      const user = sessionUser(request);
      if (!user?.sub) {
        throw new AgentManagementError(
          AGENT_MANAGEMENT_ERROR_CODES.AUTHENTICATION_REQUIRED,
          "an authenticated workspace session is required",
          { statusCode: 401 },
        );
      }
      const requestedWorkspaceId = decodeSegment(match[1], "workspaceId");
      const agentId = match[2] ? decodeSegment(match[2], "agentId") : null;
      const resource = match[3] ?? null;
      const context = await workspaceAuthorization.contextForRequest({
        request,
        url,
        user,
      });
      if (context.workspaceId !== requestedWorkspaceId) {
        throw new AgentManagementError(
          AGENT_MANAGEMENT_ERROR_CODES.NOT_FOUND,
          "workspace was not found",
          { statusCode: 404 },
        );
      }

      if (request.method === "GET") {
        await workspaceAuthorization.authorizeRead(context, {
          capability: "workspace.directory.read",
        });
        const result = await readOperation({
          agentId,
          context,
          resource,
          url,
        });
        sendJson(response, 200, result);
        return true;
      }

      if (request.method !== "POST") {
        throw new AgentManagementError(
          AGENT_MANAGEMENT_ERROR_CODES.METHOD_NOT_ALLOWED,
          "agent management accepts GET and POST requests",
          { statusCode: 405 },
        );
      }

      let body;
      try {
        body = await readJson(request);
      } catch {
        throw invalidRequest("request body must be valid JSON");
      }
      const idempotencyKey = requireIdempotencyKey(request);
      const metadata = requestMetadata(request, url, {
        agentId,
        body,
        resource,
        requestedWorkspaceId,
      });
      const result = await workspaceAuthorization.authorizeDispatch(
        metadata,
        context,
        {
          capability: "workspace.directory.mutate",
          dispatch: () =>
            mutateOperation({
              agentId,
              body,
              context,
              idempotencyKey,
              resource,
              workspaceId: context.workspaceId,
            }),
        },
      );
      sendJson(response, result.httpStatus ?? 200, result.body ?? result);
      return true;
    } catch (error) {
      sendJson(response, statusForError(error), errorResponse(error));
      return true;
    }
  }

  async function readOperation({ agentId, resource, url }) {
    if (!agentId) {
      if (url.searchParams.has("agentId")) {
        throw invalidRequest("agentId belongs in the path");
      }
      const page = parsePage(url, "agents");
      return listAgents(page);
    }
    validateAgentId(agentId);
    if (url.searchParams.has("workspaceId")) {
      throw invalidRequest("workspaceId belongs in the path");
    }
    if (resourceIsHistory(url.pathname)) {
      return history(agentId, parsePage(url, "history"));
    }
    if (resource !== null) {
      throw methodNotAllowed(
        "only the agent resource and /history support GET",
      );
    }
    if (url.pathname.endsWith("/config")) {
      throw methodNotAllowed(
        "configuration reads are part of the agent resource",
      );
    }
    return getAgent(agentId);
  }

  async function mutateOperation({
    agentId,
    body,
    context,
    idempotencyKey,
    resource,
    workspaceId: requestedWorkspaceId,
  }) {
    if (requestedWorkspaceId !== workspaceId) {
      throw new AgentManagementError(
        AGENT_MANAGEMENT_ERROR_CODES.NOT_FOUND,
        "workspace was not found",
        { statusCode: 404 },
      );
    }
    if (!agentId) {
      if (resource !== null) throw invalidRequest("agent resource is missing");
      return {
        body: await createAgent({
          actorId: context.principalId,
          body,
          context,
          idempotencyKey,
        }),
        httpStatus: 201,
      };
    }
    validateAgentId(agentId);
    if (resource === "config") {
      return {
        body: await createConfig({
          actorId: context.principalId,
          agentId,
          body,
          context,
          idempotencyKey,
        }),
        httpStatus: 201,
      };
    }
    if (resource === "revisions") {
      return {
        body: await reviseConfig({
          actorId: context.principalId,
          agentId,
          body,
          context,
          idempotencyKey,
        }),
        httpStatus: 201,
      };
    }
    if (resource === "activate") {
      return {
        body: await transitionConfig({
          actorId: context.principalId,
          agentId,
          body,
          context,
          event: "activate",
          idempotencyKey,
        }),
      };
    }
    if (resource === "disable") {
      return {
        body: await transitionConfig({
          actorId: context.principalId,
          agentId,
          body,
          context,
          event: "disable",
          idempotencyKey,
        }),
      };
    }
    if (resource === "revoke") {
      return {
        body: await transitionConfig({
          actorId: context.principalId,
          agentId,
          body,
          context,
          event: "revoke",
          idempotencyKey,
        }),
      };
    }
    throw methodNotAllowed(
      "agent mutations require /config, /revisions, /activate, /disable, or /revoke",
    );
  }

  async function createAgent({ actorId, body, context, idempotencyKey }) {
    assertExactKeys(body, CREATE_KEYS);
    const profile = validateProfile(body.profile);
    const ownerPrincipalId = body.ownerPrincipalId ?? actorId;
    validatePrincipalId(ownerPrincipalId, { expectedWorkspaceId: workspaceId });
    const directory = await workspaceDirectory.read();
    const owner = directory.state.entities.principals?.[ownerPrincipalId];
    if (!owner || owner.kind !== "human" || owner.status !== "active") {
      throw new AgentManagementError(
        AGENT_MANAGEMENT_ERROR_CODES.CONFLICT,
        "agent owner must be an active human workspace principal",
        { statusCode: 409 },
      );
    }
    const agentId =
      body.agentId ?? `ag_${workspaceId.slice(3)}_${idempotencyKey.slice(3)}`;
    validateAgentId(agentId);
    const principalId = principalIdForAgentId(agentId);
    const existing = directory.state.entities.principals?.[principalId];
    if (existing && !hasDispatchTarget(directory.records, idempotencyKey)) {
      throw new AgentManagementError(
        AGENT_MANAGEMENT_ERROR_CODES.CONFLICT,
        "agent principal already exists",
        { statusCode: 409 },
      );
    }
    const data = {
      kind: "agent",
      ownedBy: ownerPrincipalId,
      principalId,
      profile,
      subjectBinding: {
        audience: "stream-slack",
        issuer: "stream-slack",
        subject: `agent:${agentId}`,
      },
    };
    validateSubjectBinding(data.subjectBinding);
    const committed = await dispatchEvent({
      actorId,
      context,
      data,
      eventType: "principal.created",
      expectedHead: directory.nextOffset,
      idempotencyKey,
      operation: "agent.principal.create",
      stream: workspaceDirectory.stream,
    });
    const agent = await getAgent(agentId);
    return {
      agent: agent.agent,
      configuration: agent.configuration,
      ok: true,
      receipt: publicReceipt(committed, "agent.principal.create"),
      source: agent.source,
    };
  }

  async function createConfig({
    actorId,
    agentId,
    body,
    context,
    idempotencyKey,
  }) {
    const input = validateConfigInput(body, { create: true });
    await requireAgent(agentId);
    const stream = configStream(agentId);
    const committed = await stream.create(
      configRequest({
        actorId,
        agentId,
        context,
        idempotencyKey,
        input,
      }),
    );
    return configMutationResponse(agentId, committed, "agent.config.created");
  }

  async function reviseConfig({
    actorId,
    agentId,
    body,
    context,
    idempotencyKey,
  }) {
    const input = validateConfigInput(body, { create: false });
    await requireAgent(agentId);
    const stream = configStream(agentId);
    const committed = await stream.revise(
      configRequest({
        actorId,
        agentId,
        context,
        idempotencyKey,
        input,
      }),
    );
    return configMutationResponse(agentId, committed, "agent.config.revised");
  }

  async function transitionConfig({
    actorId,
    agentId,
    body,
    context,
    event,
    idempotencyKey,
  }) {
    const input = validateLifecycleInput(body, event);
    await requireAgent(agentId);
    const stream = configStream(agentId);
    const committed = await stream[event === "revoke" ? "retire" : event](
      configRequest({
        actorId,
        agentId,
        context,
        idempotencyKey,
        input,
      }),
    );
    const current = await getAgent(agentId);
    return {
      agent: current.agent,
      configuration: current.configuration,
      ok: true,
      receipt: publicReceipt(
        committed,
        `agent.config.${event === "revoke" ? "retired" : `${event}d`}`,
      ),
      source: current.source,
      revoked: event === "revoke" ? true : undefined,
    };
  }

  async function configMutationResponse(agentId, committed, operation) {
    const current = await getAgent(agentId);
    return {
      agent: current.agent,
      configRevision: {
        configDigest: committed.event.data.configDigest ?? null,
        revision: committed.revision,
        revisionId: committed.revisionId,
      },
      configuration: current.configuration,
      ok: true,
      receipt: publicReceipt(committed, operation),
      source: current.source,
    };
  }

  function configRequest({ actorId, agentId, context, idempotencyKey, input }) {
    return {
      actorId,
      agentId,
      causation: null,
      clock: () => new Date(STABLE_EVENT_TIMESTAMP),
      config: input.config,
      correlationId: correlationIdFor(idempotencyKey),
      dispatchContext: context,
      eventId: eventIdFor(idempotencyKey),
      expectedRevision: input.expectedRevision,
      expectedRevisionId: input.expectedRevisionId,
      idempotencyKey,
      revisionId: input.revisionId,
    };
  }

  async function getAgent(agentId) {
    const directory = await workspaceDirectory.read();
    const principalId = principalIdForAgentId(agentId);
    const principal = directory.state.entities.principals?.[principalId];
    if (!principal || principal.kind !== "agent") {
      throw notFound("agent principal was not found");
    }
    const config = configStream(agentId);
    const snapshot = await config.read();
    const configState = snapshot.state.entities.agents?.[agentId] ?? null;
    return {
      agent: publicPrincipal(principal, agentId),
      configuration: publicConfigState(configState),
      ok: true,
      source: {
        directoryDigest: directory.streamDigest,
        directoryStateDigest: directory.stateDigest,
        configDigest: snapshot.streamDigest,
        configStateDigest: snapshot.stateDigest,
      },
    };
  }

  async function listAgents(page) {
    const directory = await workspaceDirectory.read();
    const principals = directory.state.entities.principals ?? {};
    const order = principalCreationOrder(directory, principals);
    const start = page.cursor?.index ?? 0;
    const selected = order.slice(start, start + page.limit);
    const agents = [];
    for (const agentId of selected) {
      agents.push((await getAgent(agentId)).agent);
    }
    const nextIndex = start + selected.length;
    return {
      agents,
      nextCursor:
        nextIndex < order.length
          ? encodeCursor({ index: nextIndex, kind: "agents", version: 1 })
          : null,
      ok: true,
      page: {
        limit: page.limit,
        returned: agents.length,
        start,
        streamDigest: directory.streamDigest,
        stateDigest: directory.stateDigest,
      },
    };
  }

  async function history(agentId, page) {
    await requireAgent(agentId);
    const snapshot = await configStream(agentId).read();
    const state = snapshot.state.entities.agents?.[agentId] ?? null;
    const entries = state
      ? [
          ...state.revisions.map((revision) => ({
            config: redactValue(revision.config),
            configDigest: revision.configDigest,
            eventId: revision.eventId,
            expectedRevision: revision.expectedRevision,
            kind: "revision",
            predecessorRevisionId: revision.predecessorRevisionId,
            revision: revision.revision,
            revisionId: revision.revisionId,
            sourceOffset: revision.sourceOffset,
          })),
          ...state.transitions
            .filter(
              ({ eventType }) =>
                eventType !== "agent.config.created" &&
                eventType !== "agent.config.revised",
            )
            .map((transition) => ({
              actorId: transition.actorId,
              eventId: transition.eventId,
              eventType: transition.eventType,
              kind: "lifecycle",
              revisionId: transition.revisionId,
              sourceOffset: transition.sourceOffset,
              statusAfter: transition.statusAfter,
              statusBefore: transition.statusBefore,
            })),
        ].sort((left, right) =>
          left.sourceOffset.localeCompare(right.sourceOffset),
        )
      : [];
    const start = page.cursor?.index ?? 0;
    const selected = entries.slice(start, start + page.limit);
    const nextIndex = start + selected.length;
    return {
      agentId,
      entries: selected,
      nextCursor:
        nextIndex < entries.length
          ? encodeCursor({ index: nextIndex, kind: "history", version: 1 })
          : null,
      ok: true,
      page: {
        limit: page.limit,
        returned: selected.length,
        start,
        streamDigest: snapshot.streamDigest,
        stateDigest: snapshot.stateDigest,
      },
    };
  }

  async function requireAgent(agentId) {
    const principalId = principalIdForAgentId(agentId);
    const principal = await workspaceDirectory.lookupPrincipal(
      workspaceId,
      principalId,
    );
    if (!principal || principal.kind !== "agent") {
      throw notFound("agent principal was not found");
    }
    return principal;
  }

  async function dispatchEvent({
    actorId,
    context,
    data,
    eventType,
    expectedHead,
    idempotencyKey,
    operation,
    stream,
  }) {
    const envelope = issueEventEnvelope(
      {
        actorId,
        causation: null,
        correlationId: correlationIdFor(idempotencyKey),
        data,
        eventType,
        idempotencyKey,
        schemaVersion: 1,
        workspaceId,
      },
      {
        clock: () => new Date(STABLE_EVENT_TIMESTAMP),
        eventId: eventIdFor(idempotencyKey),
      },
    );
    const digest = digestEventEnvelope(envelope);
    const result = await dispatchDoor.dispatch(
      {
        actorId,
        expectedHead,
        idempotencyKey,
        operation,
        payload: { digest, event: envelope },
        stream,
        workspaceId,
      },
      { context },
    );
    const sourceEvent = result.event?.event ?? result.event;
    if (sourceEvent?.eventType !== eventType) {
      throw new AgentManagementError(
        AGENT_MANAGEMENT_ERROR_CODES.CONFLICT,
        "idempotency receipt is bound to a different agent event",
        { statusCode: 409 },
      );
    }
    return {
      digest,
      event: sourceEvent,
      nextOffset: result.receipt.nextOffset,
      receipt: result.receipt,
      stream,
    };
  }

  return Object.freeze({ handleApi });
}

function validateAgentId(agentId) {
  try {
    return validateAgentConfigAgentId(agentId);
  } catch (error) {
    throw invalidRequest(error?.detail ?? "agentId is invalid");
  }
}

function validateProfile(profile) {
  try {
    return structuredClone(validatePrincipalProfile(profile));
  } catch (error) {
    throw invalidRequest(error?.detail ?? "profile is invalid");
  }
}

function validateConfigInput(body, { create }) {
  assertExactKeys(body, CONFIG_KEYS);
  if (
    create &&
    (body.expectedRevision !== 0 || body.expectedRevisionId !== null)
  ) {
    throw invalidRequest(
      "config creation must expect revision zero and no predecessor",
    );
  }
  if (!create && body.expectedRevision < 1) {
    throw invalidRequest(
      "config revision must name a positive expected revision",
    );
  }
  if (
    !Number.isSafeInteger(body.expectedRevision) ||
    body.expectedRevision < 0
  ) {
    throw invalidRequest(
      "expectedRevision must be a non-negative safe integer",
    );
  }
  if (body.expectedRevisionId !== null) {
    try {
      validateAgentConfigRevisionId(body.expectedRevisionId);
    } catch (error) {
      throw invalidRequest(error?.detail ?? "expectedRevisionId is invalid");
    }
  }
  if (!create && body.expectedRevisionId === null) {
    throw invalidRequest("config revision requires expectedRevisionId");
  }
  return {
    config: body.config,
    expectedRevision: body.expectedRevision,
    expectedRevisionId: body.expectedRevisionId,
  };
}

function validateLifecycleInput(body, event) {
  const keys = event === "activate" ? ACTIVATE_KEYS : LIFECYCLE_KEYS;
  assertExactKeys(body, keys);
  if (
    !Number.isSafeInteger(body.expectedRevision) ||
    body.expectedRevision < 1
  ) {
    throw invalidRequest("expectedRevision must be a positive safe integer");
  }
  try {
    validateAgentConfigRevisionId(body.expectedRevisionId);
  } catch (error) {
    throw invalidRequest(error?.detail ?? "expectedRevisionId is invalid");
  }
  if (event === "activate") {
    try {
      validateAgentConfigRevisionId(body.revisionId);
    } catch (error) {
      throw invalidRequest(error?.detail ?? "revisionId is invalid");
    }
  }
  return {
    expectedRevision: body.expectedRevision,
    expectedRevisionId: body.expectedRevisionId,
    revisionId: body.revisionId,
  };
}

function publicPrincipal(principal, agentId) {
  return {
    agentId,
    kind: principal.kind,
    ownedBy: principal.ownedBy,
    principalId: principal.principalId,
    profile: redactValue(principal.profile),
    profileRevision: principal.profileRevision,
    status: principal.status,
  };
}

function principalIdForAgentId(agentId) {
  validateAgentId(agentId);
  return `pr_${agentId.slice(3)}`;
}

function agentIdForPrincipalId(principalId) {
  if (typeof principalId !== "string" || !principalId.startsWith("pr_")) {
    return null;
  }
  const agentId = `ag_${principalId.slice(3)}`;
  try {
    return validateAgentConfigAgentId(agentId) ? agentId : null;
  } catch {
    return null;
  }
}

function publicConfigState(state) {
  if (!state) return null;
  return {
    activeConfig: redactValue(state.activeConfig),
    activeRevisionId: state.activeRevisionId,
    headRevision: state.headRevision,
    lastRevisionId: state.lastRevisionId,
    runnable: state.runnable,
    status: state.status,
  };
}

function publicReceipt(committed, operation) {
  return {
    dispatchEventDigest: committed.receipt?.eventDigest ?? null,
    eventDigest: committed.digest,
    idempotencyKey: committed.receipt?.idempotencyKey ?? null,
    nextOffset: committed.nextOffset,
    operation,
    requestDigest: committed.receipt?.requestDigest ?? null,
    status: committed.receipt?.status ?? "accepted",
    stream: committed.stream,
  };
}

function principalCreationOrder(directory, principals) {
  const order = [];
  for (const provenance of directory.state.eventProvenance ?? []) {
    const event = provenance.envelope;
    if (event?.eventType !== "principal.created") continue;
    const principalId = event.data?.principalId;
    const agentId = agentIdForPrincipalId(principalId);
    if (
      event.data?.kind === "agent" &&
      principals[principalId]?.kind === "agent" &&
      agentId !== null &&
      !order.includes(agentId)
    ) {
      order.push(agentId);
    }
  }
  return order;
}

function parsePage(url, kind) {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? DEFAULT_PAGE_SIZE : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw invalidRequest(
      `limit must be an integer between 1 and ${MAX_PAGE_SIZE}`,
    );
  }
  const rawCursor = url.searchParams.get("cursor");
  const cursor = rawCursor ? decodeCursor(rawCursor, kind) : null;
  return { cursor, limit };
}

function encodeCursor(value) {
  return encodeURIComponent(JSON.stringify(value));
}

function decodeCursor(value, kind) {
  try {
    const parsed = JSON.parse(value);
    if (
      !parsed ||
      Object.keys(parsed).length !== CURSOR_KEYS.length ||
      !CURSOR_KEYS.every((key) => Object.hasOwn(parsed, key)) ||
      parsed.kind !== kind ||
      parsed.version !== 1 ||
      !Number.isSafeInteger(parsed.index) ||
      parsed.index < 0
    ) {
      throw new Error("cursor shape is invalid");
    }
    return parsed;
  } catch {
    throw new AgentManagementError(
      AGENT_MANAGEMENT_ERROR_CODES.INVALID_CURSOR,
      "cursor is not a valid opaque pagination cursor",
      { statusCode: 400 },
    );
  }
}

function hasDispatchTarget(records, idempotencyKey) {
  return records.some(
    (record) => record?.dispatch?.idempotencyKey === idempotencyKey,
  );
}

function requireIdempotencyKey(request) {
  const value = request.headers?.["idempotency-key"];
  if (typeof value !== "string" || !IDEMPOTENCY_PATTERN.test(value)) {
    throw invalidRequest("Idempotency-Key header is required for mutations");
  }
  return value;
}

function requestMetadata(request, url, fields) {
  return {
    ...fields,
    headers: request.headers,
    path: request.url ?? url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
  };
}

function decodeSegment(value, name) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw invalidRequest(`${name} path segment is malformed`);
  }
}

function resourceIsHistory(pathname) {
  return pathname.endsWith("/history");
}

function assertExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest("request body must be an object");
  }
  const expected = new Set(expectedKeys);
  if (
    Object.keys(value).length !== expectedKeys.length ||
    Object.keys(value).some((key) => !expected.has(key)) ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw invalidRequest("request body has an invalid schema");
  }
}

function errorResponse(error) {
  if (error instanceof AgentManagementError) {
    return {
      ok: false,
      code: error.code,
      error: redactText(error.detail),
    };
  }
  if (error instanceof AgentConfigStreamError) {
    return {
      ok: false,
      code: error.code,
      currentRevision: error.currentRevision ?? null,
      currentRevisionId: error.currentRevisionId ?? null,
      error: redactText(error.detail),
      expectedRevision: error.expectedRevision ?? null,
      expectedRevisionId: error.expectedRevisionId ?? null,
    };
  }
  if (
    typeof error?.code === "string" &&
    typeof error?.statusCode === "number"
  ) {
    return {
      ok: false,
      code: error.code,
      error: redactText(error.detail ?? "agent management request was refused"),
    };
  }
  if (
    typeof error?.code === "string" &&
    error.code.startsWith("AGENT_CONFIG_")
  ) {
    return {
      ok: false,
      code: error.code,
      error: redactText(error.detail ?? "agent configuration is invalid"),
    };
  }
  return {
    ok: false,
    code: AGENT_MANAGEMENT_ERROR_CODES.INTERNAL,
    error: "agent management request failed",
  };
}

function statusForError(error) {
  if (Number.isInteger(error?.statusCode) && error.statusCode >= 400) {
    return error.statusCode;
  }
  if (
    typeof error?.code === "string" &&
    error.code.startsWith("AGENT_CONFIG_")
  ) {
    return 400;
  }
  if (error?.code === "WORKSPACE_ACCESS_DENIED") return 404;
  if (error?.code === "WORKSPACE_CONTEXT_REQUIRED") return 401;
  return 500;
}

function invalidRequest(detail) {
  return new AgentManagementError(
    AGENT_MANAGEMENT_ERROR_CODES.INVALID_REQUEST,
    detail,
    { statusCode: 400 },
  );
}

function methodNotAllowed(detail) {
  return new AgentManagementError(
    AGENT_MANAGEMENT_ERROR_CODES.METHOD_NOT_ALLOWED,
    detail,
    { statusCode: 405 },
  );
}

function notFound(detail) {
  return new AgentManagementError(
    AGENT_MANAGEMENT_ERROR_CODES.NOT_FOUND,
    detail,
    { statusCode: 404 },
  );
}

function eventIdFor(idempotencyKey) {
  return `ev_${idempotencyKey.slice(3)}`;
}

function correlationIdFor(idempotencyKey) {
  return `cr_${idempotencyKey.slice(3)}`;
}

function redactValue(value) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value !== "object") return value;
  const output = {};
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redactValue(nested);
    }
  }
  return output;
}

function redactText(value) {
  const text = String(value);
  return SECRET_VALUE_PATTERN.test(text) ? "[REDACTED]" : text.slice(0, 2_000);
}
