import {
  channelMembershipKey,
  membershipIdFor,
  sameSubjectBinding,
  validateChannelId,
  validatePrincipalId,
  validateWorkspaceId,
} from "@stream-slack/protocol";
import { canonicalStateDigest, replayRecords } from "@stream-slack/reducers";

import { prepareConversationEvent } from "./conversation-auth.mjs";
import { canonicalSha256 } from "./canonical-json.mjs";
import { createInboundHttpServer } from "../http-server.mjs";

export const CAPSTONE_API_ERROR_CODES = Object.freeze({
  ACCESS_DENIED: "CAPSTONE_ACCESS_DENIED",
  AGENT_AUTH_FORBIDDEN: "CAPSTONE_AGENT_AUTH_FORBIDDEN",
  AUTHENTICATION_DENIED: "CAPSTONE_AUTHENTICATION_DENIED",
  CHANNEL_EXISTS: "CAPSTONE_CHANNEL_EXISTS",
  CHANNEL_NOT_FOUND: "CAPSTONE_CHANNEL_NOT_FOUND",
  INVALID_REQUEST: "CAPSTONE_INVALID_REQUEST",
  SERVER_CLOSED: "CAPSTONE_SERVER_CLOSED",
});

export class MultiUserChatApiError extends Error {
  constructor(code, detail, { statusCode = 403 } = {}) {
    super(`${code}: ${detail}`);
    this.name = "MultiUserChatApiError";
    this.code = code;
    this.detail = detail;
    this.statusCode = statusCode;
  }
}

export const CAPSTONE_PRINCIPALS = Object.freeze({
  ADA: "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb",
  LINUS: "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc",
  AGENT: "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd",
  SERVICE: "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_eeeeeeeeeeeeeeeeeeeeeeeeee",
});

export const CAPSTONE_CHANNELS = Object.freeze({
  PUBLIC: "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_11111111111111111111111111",
  PRIVATE: "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_22222222222222222222222222",
});

export const CAPSTONE_WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
export const CAPSTONE_DIRECTORY_STREAM = `workspace:${CAPSTONE_WORKSPACE_ID}/directory`;

const MESSAGE_OPERATION_EVENT_TYPES = Object.freeze({
  "channel.message.create": "channel.message.created",
  "channel.message.reply": "channel.message.replied",
  "channel.message.edit": "channel.message.edited",
  "channel.message.delete": "channel.message.deleted",
  "channel.reaction.add": "channel.message.reaction.added",
  "channel.reaction.remove": "channel.message.reaction.removed",
});
const PRIVATE_MEMBERSHIP_EVENT = "channel.membership.removed";
const INITIAL_CHECKPOINT = "-1";
const OFFSET_PREFIX = "0000000000000000_";
const BASE_TIMESTAMP = Date.parse("2026-08-04T00:00:00.000Z");

/**
 * A small server-side composition layer for the E1 capstone.
 *
 * The API keeps no authoritative state of its own. Every read replays the
 * configured Durable Streams source streams, while subscriptions are only
 * delivery state. That makes process/session loss and projection deletion
 * observable without changing the source facts.
 */
export function createMultiUserChatApi({
  streamStore,
  workspaceId = CAPSTONE_WORKSPACE_ID,
  sourceStreams = [],
} = {}) {
  if (
    !streamStore ||
    typeof streamStore.ensure !== "function" ||
    typeof streamStore.read !== "function" ||
    typeof streamStore.append !== "function"
  ) {
    throw new TypeError("multi-user chat API requires a Durable Streams store");
  }
  validateWorkspaceId(workspaceId);

  const directoryStream = `workspace:${workspaceId}/directory`;
  const streams = new Set([directoryStream, ...sourceStreams]);
  const subscriptions = new Set();
  let mutationTail = Promise.resolve();
  let closed = false;

  function enqueue(operation) {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.catch(() => {});
    return result;
  }

  async function readSourceDump() {
    const records = [];
    for (const stream of streams) {
      await streamStore.ensure(stream);
      const snapshot = await streamStore.read(stream, INITIAL_CHECKPOINT);
      snapshot.records.forEach((event, index) => {
        records.push({
          digest: canonicalSha256(event),
          event,
          offset: sourceOffset(index + 1),
          stream,
        });
      });
    }
    records.sort(compareSourceRecords);
    return records;
  }

  async function replaySource() {
    const sourceDump = await readSourceDump();
    const replayed = replayRecords(
      sourceDump.map((record, index) => ({
        event: record.event,
        offset: replayOffset(index + 1),
      })),
    );
    return { replayed, sourceDump };
  }

  async function currentState() {
    return (await replaySource()).replayed.finalState;
  }

  async function appendEventUnlocked({
    actorId,
    data,
    eventType,
    idempotencyKey,
    stream,
  }) {
    if (closed) {
      throw new MultiUserChatApiError(
        CAPSTONE_API_ERROR_CODES.SERVER_CLOSED,
        "multi-user chat API is closed",
        { statusCode: 503 },
      );
    }
    validatePrincipalId(actorId, { expectedWorkspaceId: workspaceId });
    streams.add(stream);
    const existingSource = await readSourceDump();
    const existing = existingSource.find(
      (record) => record.event.idempotencyKey === idempotencyKey,
    );
    if (existing) {
      return resultForSource(existing, { replayed: true });
    }

    const eventNumber = existingSource.length + 1;
    const event = {
      actorId,
      causation: null,
      correlationId: `cr_${tokenFor(0x1000)}`,
      data: structuredClone(data),
      eventId: `ev_${tokenFor(eventNumber)}`,
      eventType,
      idempotencyKey,
      schemaVersion: 1,
      serverTimestamp: new Date(
        BASE_TIMESTAMP + eventNumber * 1000,
      ).toISOString(),
      workspaceId,
    };

    const nextReplay = [
      ...existingSource.map((record, index) => ({
        event: record.event,
        offset: replayOffset(index + 1),
      })),
      { event, offset: replayOffset(existingSource.length + 1) },
    ];
    try {
      replayRecords(nextReplay);
    } catch (error) {
      throw new MultiUserChatApiError(
        error?.code ?? CAPSTONE_API_ERROR_CODES.INVALID_REQUEST,
        error?.detail ??
          (error instanceof Error ? error.message : String(error)),
        { statusCode: 422 },
      );
    }

    const snapshot = await streamStore.read(stream, INITIAL_CHECKPOINT);
    const appended = await streamStore.append(stream, event, {
      streamSeq: snapshot.nextOffset,
    });
    const refreshed = await readSourceDump();
    const source = refreshed.find(
      (record) => record.event.eventId === event.eventId,
    );
    if (!source) {
      throw new MultiUserChatApiError(
        CAPSTONE_API_ERROR_CODES.INVALID_REQUEST,
        "durable append was not visible in the source dump",
        { statusCode: 502 },
      );
    }
    await notifySubscriptions(source);
    return {
      event,
      receipt: {
        eventDigest: canonicalSha256(event),
        idempotencyKey,
        nextOffset: source.offset,
        providerNextOffset: appended.nextOffset,
        replayed: false,
        stream,
      },
      source,
    };
  }

  function appendEvent(input) {
    return enqueue(() => appendEventUnlocked(input));
  }

  async function bootstrap() {
    return enqueue(async () => {
      const existing = await readSourceDump();
      if (existing.length > 0) return existing;
      const directory = directoryStream;
      const events = bootstrapEvents(workspaceId);
      const appended = [];
      for (const entry of events) {
        const result = await appendEventUnlocked({
          ...entry,
          stream: directory,
        });
        appended.push(result);
      }
      return appended;
    });
  }

  async function authenticate({ principalId, subject }) {
    const state = await currentState();
    const principal = state.entities.principals?.[principalId];
    const membership =
      state.entities.memberships?.[membershipIdFor(workspaceId, principalId)];
    if (!principal || membership?.status !== "active") {
      throw authDenied();
    }
    if (principal.kind === "agent") {
      throw new MultiUserChatApiError(
        CAPSTONE_API_ERROR_CODES.AGENT_AUTH_FORBIDDEN,
        "agent principals cannot authenticate as their human owner",
        { statusCode: 403 },
      );
    }
    if (principal.kind !== "human") throw authDenied();
    if (
      !sameSubjectBinding(principal.subjectBinding, {
        audience: "stream-slack",
        issuer: "auth0",
        subject,
      })
    ) {
      throw new MultiUserChatApiError(
        CAPSTONE_API_ERROR_CODES.AUTHENTICATION_DENIED,
        "authenticated subject is not bound to this principal",
        { statusCode: 401 },
      );
    }
    return publicPrincipal(principal);
  }

  async function readDirectory(principalId) {
    const state = await currentState();
    assertWorkspaceMember(state, principalId);
    return Object.values(state.entities.principals ?? {})
      .filter((principal) => {
        const membership =
          state.entities.memberships?.[
            membershipIdFor(workspaceId, principal.principalId)
          ];
        return membership?.status === "active" && principal.status === "active";
      })
      .sort((left, right) => left.principalId.localeCompare(right.principalId))
      .map(publicPrincipal);
  }

  async function listChannels(principalId) {
    const state = await currentState();
    assertWorkspaceMember(state, principalId);
    return Object.values(state.entities.channels ?? {})
      .filter((channel) => channel.status === "active")
      .filter((channel) => canReadChannel(state, channel, principalId))
      .sort((left, right) => left.channelId.localeCompare(right.channelId))
      .map((channel) => publicChannel(state, channel));
  }

  async function readChannel(principalId, channelId) {
    const { replayed, sourceDump } = await replaySource();
    const state = replayed.finalState;
    const channel = state.entities.channels?.[channelId];
    assertReadable(state, channel, principalId);
    const messages = Object.values(state.entities.messages ?? {})
      .filter(
        (message) =>
          message.channelId === channelId && message.status === "active",
      )
      .sort((left, right) => messageOrder(left, right, state))
      .map(publicMessage);
    const channelRecords = sourceDump.filter(
      (record) => record.stream === `channel:${channelId}`,
    );
    return {
      channel: publicChannel(state, channel),
      messages,
      nextOffset: channelRecords.at(-1)?.offset ?? sourceOffset(0),
      stateDigest: canonicalStateDigest(state),
      streamDigest: canonicalSha256(
        channelRecords.map((record) => record.event),
      ),
    };
  }

  async function createChannel(
    actorId,
    { channelId, displayName = "", kind, participantIds = [] } = {},
  ) {
    return enqueue(async () => {
      const state = await currentState();
      assertWorkspaceMember(state, actorId);
      const workspaceMembership =
        state.entities.memberships[membershipIdFor(workspaceId, actorId)];
      if (
        !workspaceMembership ||
        !["owner", "admin", "member"].includes(workspaceMembership.role)
      ) {
        throw accessDenied();
      }
      validateChannelId(channelId, { expectedWorkspaceId: workspaceId });
      if (state.entities.channels?.[channelId]) {
        throw new MultiUserChatApiError(
          CAPSTONE_API_ERROR_CODES.CHANNEL_EXISTS,
          "channel identifier is already present",
          { statusCode: 409 },
        );
      }
      const participants =
        kind === "direct"
          ? [...new Set([actorId, ...participantIds])].sort()
          : [actorId, CAPSTONE_PRINCIPALS.LINUS, CAPSTONE_PRINCIPALS.AGENT];
      const first = await appendEventUnlocked({
        actorId,
        data:
          kind === "direct"
            ? {
                channelId,
                creatorId: actorId,
                participantIds: participants,
              }
            : {
                channelId,
                creatorId: actorId,
                displayName,
                kind,
              },
        eventType:
          kind === "direct" ? "channel.direct.created" : "channel.created",
        idempotencyKey: keyFor(`channel:${channelId}:create`),
        stream: `channel:${channelId}`,
      });
      if (kind !== "direct") {
        for (const principalId of participants.filter((id) => id !== actorId)) {
          const afterCreate = await currentState();
          const channel = afterCreate.entities.channels[channelId];
          const inviteId = `iv_${workspaceId.slice(3)}_${tokenFor(
            stableNumber(`invite:${channelId}:${principalId}`),
          )}`;
          await appendEventUnlocked({
            actorId,
            data: {
              channelId,
              expectedChannelRevision: channel.revision,
              inviteId,
              principalId,
            },
            eventType: "channel.membership.invited",
            idempotencyKey: keyFor(
              `channel:${channelId}:invite:${principalId}`,
            ),
            stream: `channel:${channelId}`,
          });
          const joined = await currentState();
          await appendEventUnlocked({
            actorId: principalId,
            data: {
              channelId,
              expectedChannelRevision:
                joined.entities.channels[channelId].revision,
              inviteId,
              principalId,
            },
            eventType: "channel.membership.joined",
            idempotencyKey: keyFor(`channel:${channelId}:join:${principalId}`),
            stream: `channel:${channelId}`,
          });
        }
      }
      return {
        ...first,
        channel: (await readChannel(actorId, channelId)).channel,
      };
    });
  }

  async function mutateMessage(
    actorId,
    channelId,
    operation,
    payload,
    idempotencyKey,
  ) {
    return enqueue(async () => {
      const effectiveIdempotencyKey =
        idempotencyKey ??
        keyFor(`${operation}:${channelId}:${payload.messageId}`);
      const existingSource = (await readSourceDump()).find(
        (record) => record.event.idempotencyKey === effectiveIdempotencyKey,
      );
      if (existingSource) {
        const replayedResult = resultForSource(existingSource, {
          replayed: true,
        });
        return {
          ...replayedResult,
          message:
            (await readChannel(actorId, channelId)).messages.find(
              (message) => message.messageId === payload.messageId,
            ) ?? null,
          mentionSources: bindMentionSources(replayedResult),
        };
      }
      const state = await currentState();
      let prepared;
      try {
        prepared = prepareConversationEvent({
          actorId,
          operation,
          payload: { ...payload, channelId },
          state,
          workspaceId,
        });
      } catch (error) {
        if (
          error?.code === "CONVERSATION_ACCESS_DENIED" ||
          error?.code === "CONVERSATION_MEMBERSHIP_INACTIVE" ||
          error?.code === "CONVERSATION_MESSAGE_NOT_FOUND"
        ) {
          throw accessDenied();
        }
        throw error;
      }
      const result = await appendEventUnlocked({
        actorId,
        data: prepared.data,
        eventType: MESSAGE_OPERATION_EVENT_TYPES[operation],
        idempotencyKey: effectiveIdempotencyKey,
        stream: `channel:${channelId}`,
      });
      return {
        ...result,
        message:
          (await readChannel(actorId, channelId)).messages.find(
            (message) => message.messageId === payload.messageId,
          ) ?? null,
        mentionSources: bindMentionSources(result),
      };
    });
  }

  async function removeChannelMember(actorId, channelId, principalId) {
    return enqueue(async () => {
      const state = await currentState();
      const channel = state.entities.channels?.[channelId];
      assertReadable(state, channel, actorId);
      const result = await appendEventUnlocked({
        actorId,
        data: {
          channelId,
          expectedChannelRevision: channel.revision,
          principalId,
          reason: "membership revoked during live session",
        },
        eventType: PRIVATE_MEMBERSHIP_EVENT,
        idempotencyKey: keyFor(`channel:${channelId}:remove:${principalId}`),
        stream: `channel:${channelId}`,
      });
      return result;
    });
  }

  async function updateProfile(actorId, principalId, profile, idempotencyKey) {
    return enqueue(async () => {
      const state = await currentState();
      assertWorkspaceMember(state, actorId);
      const target = state.entities.principals?.[principalId];
      if (!target || target.ownedBy !== actorId) throw accessDenied();
      return appendEventUnlocked({
        actorId,
        data: {
          principalId,
          profile,
          revision: target.profileRevision + 1,
        },
        eventType: "principal.profile.updated",
        idempotencyKey:
          idempotencyKey ??
          keyFor(`profile:${principalId}:${target.profileRevision + 1}`),
        stream: directoryStream,
      });
    });
  }

  async function subscribe({
    channelId,
    fromOffset = INITIAL_CHECKPOINT,
    onClose = () => {},
    onFrame,
    principalId,
  }) {
    if (typeof onFrame !== "function")
      throw new TypeError("subscription requires onFrame");
    const initial = await readChannel(principalId, channelId);
    const subscription = {
      channelId,
      closed: false,
      onClose,
      onFrame,
      principalId,
      tail: Promise.resolve(),
    };
    subscriptions.add(subscription);
    const source = (await readSourceDump()).filter(
      (record) => record.stream === `channel:${channelId}`,
    );
    const deliver = (name, data, offset = null) => {
      subscription.tail = subscription.tail.then(() =>
        subscription.closed ? undefined : onFrame({ data, name, offset }),
      );
      return subscription.tail;
    };
    if (fromOffset === INITIAL_CHECKPOINT) {
      await deliver(
        "snapshot",
        {
          channel: initial.channel,
          messages: initial.messages,
          nextOffset: initial.nextOffset,
          stateDigest: initial.stateDigest,
          streamDigest: initial.streamDigest,
        },
        initial.nextOffset,
      );
    } else {
      const start = source.findIndex((record) => record.offset === fromOffset);
      if (start === -1 && fromOffset !== sourceOffset(0)) {
        closeSubscription(subscription);
        throw new MultiUserChatApiError(
          CAPSTONE_API_ERROR_CODES.INVALID_REQUEST,
          "live checkpoint is not present on this channel stream",
          { statusCode: 409 },
        );
      }
      await deliver(
        "resume",
        {
          fromOffset,
          nextOffset: fromOffset,
        },
        fromOffset,
      );
      for (const record of source.slice(start + 1)) {
        await deliverFrameForSubscription(subscription, record, deliver);
      }
    }
    if (!subscription.closed) {
      await deliver(
        "status",
        {
          nextOffset: initial.nextOffset,
          stateDigest: initial.stateDigest,
          streamDigest: initial.streamDigest,
        },
        initial.nextOffset,
      );
    }
    return Object.freeze({
      close: (reason = "client closed") =>
        closeSubscription(subscription, reason),
      get closed() {
        return subscription.closed;
      },
    });
  }

  async function notifySubscriptions(source) {
    if (!source.stream.startsWith("channel:")) return;
    for (const subscription of [...subscriptions]) {
      if (
        subscription.closed ||
        subscription.channelId !== source.event.data?.channelId
      ) {
        continue;
      }
      const state = await currentState();
      const channel = state.entities.channels?.[subscription.channelId];
      const stillReadable =
        channel && canReadChannel(state, channel, subscription.principalId);
      if (!stillReadable) {
        const code = CAPSTONE_API_ERROR_CODES.ACCESS_DENIED;
        await enqueueSubscriptionFrame(
          subscription,
          "terminal",
          {
            action: "close",
            code,
            nextOffset: source.offset,
            terminal: true,
          },
          source.offset,
        );
        closeSubscription(subscription, "authorization revoked");
        continue;
      }
      await enqueueSubscriptionFrame(
        subscription,
        source.event.eventType === PRIVATE_MEMBERSHIP_EVENT
          ? "membership"
          : "message",
        {
          event: source.event,
          nextOffset: source.offset,
          source: {
            digest: source.digest,
            offset: source.offset,
            stream: source.stream,
          },
        },
        source.offset,
      );
      const channelSnapshot = await readChannel(
        subscription.principalId,
        subscription.channelId,
      );
      await enqueueSubscriptionFrame(
        subscription,
        "status",
        {
          nextOffset: channelSnapshot.nextOffset,
          stateDigest: channelSnapshot.stateDigest,
          streamDigest: channelSnapshot.streamDigest,
        },
        channelSnapshot.nextOffset,
      );
    }
  }

  function closeSubscription(subscription, reason = "subscription closed") {
    if (subscription.closed) return;
    subscription.closed = true;
    subscriptions.delete(subscription);
    try {
      subscription.onClose(reason);
    } catch {
      // A disconnected HTTP response must not poison source mutation.
    }
  }

  async function close() {
    closed = true;
    for (const subscription of [...subscriptions]) {
      await enqueueSubscriptionFrame(
        subscription,
        "terminal",
        {
          action: "close",
          code: "CAPSTONE_SERVER_SHUTDOWN",
          terminal: true,
        },
        null,
      );
      closeSubscription(subscription, "server shutdown");
    }
  }

  return Object.freeze({
    appendEvent,
    authenticate,
    bootstrap,
    close,
    createChannel,
    currentState,
    directoryStream,
    listChannels,
    mutateMessage,
    readChannel,
    readDirectory,
    readSourceDump,
    removeChannelMember,
    sourceStreams: streams,
    subscribe,
    updateProfile,
    workspaceId,
  });

  async function deliverFrameForSubscription(subscription, source, deliver) {
    const state = await currentState();
    const channel = state.entities.channels?.[subscription.channelId];
    if (!channel || !canReadChannel(state, channel, subscription.principalId)) {
      await deliver(
        "terminal",
        {
          action: "close",
          code: CAPSTONE_API_ERROR_CODES.ACCESS_DENIED,
          nextOffset: source.offset,
          terminal: true,
        },
        source.offset,
      );
      closeSubscription(subscription, "authorization revoked");
      return;
    }
    await deliver(
      source.event.eventType === PRIVATE_MEMBERSHIP_EVENT
        ? "membership"
        : "message",
      {
        event: source.event,
        nextOffset: source.offset,
        source: {
          digest: source.digest,
          offset: source.offset,
          stream: source.stream,
        },
      },
      source.offset,
    );
  }

  async function enqueueSubscriptionFrame(subscription, name, data, offset) {
    subscription.tail = subscription.tail.then(
      () =>
        subscription.closed
          ? undefined
          : subscription.onFrame({ data, name, offset }),
      () =>
        subscription.closed
          ? undefined
          : subscription.onFrame({ data, name, offset }),
    );
    return subscription.tail;
  }

  function resultForSource(source, { replayed = false } = {}) {
    return {
      event: source.event,
      receipt: {
        eventDigest: canonicalSha256(source.event),
        idempotencyKey: source.event.idempotencyKey,
        nextOffset: source.offset,
        providerNextOffset: null,
        replayed,
        stream: source.stream,
      },
      source,
    };
  }

  function bindMentionSources(result) {
    const mentions = result.event?.data?.mentions;
    if (!Array.isArray(mentions) || mentions.length === 0) return [];
    return mentions.map((mention) => ({
      ...mention,
      source: {
        digest: canonicalStateDigest(result.event.data),
        offset: result.source.offset,
        stream: result.source.stream,
      },
    }));
  }
}

/**
 * Expose the capstone adapter over a deliberately small HTTP/SSE surface. The
 * session map is intentionally disposable and never participates in replay.
 */
export function createMultiUserChatHttpServer({
  api,
  host = "127.0.0.1",
  port = 0,
} = {}) {
  if (!api || typeof api.authenticate !== "function") {
    throw new TypeError("capstone HTTP server requires the API adapter");
  }
  const sessions = new Map();
  let sessionNumber = 0;

  const server = createInboundHttpServer(async (request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? `${host}:${port}`}`,
    );
    try {
      if (url.pathname === "/api/capstone/health" && request.method === "GET") {
        sendJson(response, 200, { ok: true, workspaceId: api.workspaceId });
        return;
      }
      if (
        url.pathname === "/api/capstone/sessions" &&
        request.method === "POST"
      ) {
        const input = await readJson(request);
        const principal = await api.authenticate(input);
        const sessionId = `capstone-session-${++sessionNumber}`;
        sessions.set(sessionId, principal);
        sendJson(response, 201, {
          ok: true,
          principal,
          session: `Bearer ${sessionId}`,
        });
        return;
      }

      const principal = sessions.get(sessionIdFrom(request));
      if (!principal) {
        sendJson(response, 401, {
          code: "CAPSTONE_AUTHENTICATION_REQUIRED",
          ok: false,
        });
        return;
      }
      const principalId = principal.principalId;

      if (
        url.pathname === "/api/capstone/directory" &&
        request.method === "GET"
      ) {
        sendJson(response, 200, {
          directory: await api.readDirectory(principalId),
          ok: true,
        });
        return;
      }
      if (
        url.pathname === "/api/capstone/channels" &&
        request.method === "POST"
      ) {
        const input = await readJson(request);
        const result = await api.createChannel(principalId, input);
        sendJson(response, 201, {
          channel: result.channel,
          nextOffset: result.receipt.nextOffset,
          ok: true,
        });
        return;
      }
      if (
        url.pathname === "/api/capstone/channels" &&
        request.method === "GET"
      ) {
        sendJson(response, 200, {
          channels: await api.listChannels(principalId),
          ok: true,
        });
        return;
      }

      const channelMatch = url.pathname.match(
        /^\/api\/capstone\/channels\/([^/]+)(?:\/(.*))?$/u,
      );
      if (!channelMatch) {
        sendJson(response, 404, { code: "CAPSTONE_NOT_FOUND", ok: false });
        return;
      }
      const channelId = decodeURIComponent(channelMatch[1]);
      const resource = channelMatch[2] ?? null;
      const resourceParts = resource
        ? resource.split("/").map((part) => decodeURIComponent(part))
        : [];

      if (!resource && request.method === "GET") {
        sendJson(response, 200, {
          ...(await api.readChannel(principalId, channelId)),
          ok: true,
        });
        return;
      }
      if (resourceParts[0] === "events" && request.method === "GET") {
        const offset = url.searchParams.get("offset") ?? INITIAL_CHECKPOINT;
        await api.readChannel(principalId, channelId);
        response.writeHead(200, {
          "Cache-Control": "no-cache, no-store",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream; charset=utf-8",
          "X-Accel-Buffering": "no",
        });
        let subscription;
        const close = () => subscription?.close("HTTP client closed");
        response.once("close", close);
        subscription = await api.subscribe({
          channelId,
          fromOffset: offset,
          onClose: () => {
            if (!response.writableEnded && !response.destroyed) response.end();
          },
          onFrame: async ({ data, name, offset: frameOffset }) => {
            if (response.writableEnded || response.destroyed) return;
            const id = frameOffset ? `id: ${frameOffset}\n` : "";
            response.write(
              `${id}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`,
            );
          },
          principalId,
        });
        return;
      }
      if (
        resourceParts[0] === "members" &&
        resourceParts[2] === "remove" &&
        resourceParts[1] &&
        request.method === "POST"
      ) {
        const result = await api.removeChannelMember(
          principalId,
          channelId,
          resourceParts[1],
        );
        sendJson(response, 200, {
          nextOffset: result.receipt.nextOffset,
          ok: true,
        });
        return;
      }
      if (
        resourceParts[0] === "messages" &&
        resourceParts.length === 1 &&
        request.method === "POST"
      ) {
        const input = await readJson(request);
        const operation = input.rootMessageId
          ? "channel.message.reply"
          : "channel.message.create";
        const result = await api.mutateMessage(
          principalId,
          channelId,
          operation,
          {
            contentType: "text/plain",
            messageId: input.messageId,
            rootMessageId: input.rootMessageId ?? null,
            text: input.text,
          },
          request.headers["idempotency-key"],
        );
        sendJson(response, 201, {
          mentionSources: result.mentionSources,
          message: result.message,
          nextOffset: result.receipt.nextOffset,
          ok: true,
          replayed: result.receipt.replayed,
        });
        return;
      }

      const messageId =
        resourceParts[0] === "messages" ? resourceParts[1] : null;
      if (
        messageId &&
        resourceParts.length === 2 &&
        request.method === "PATCH"
      ) {
        const input = await readJson(request);
        const result = await api.mutateMessage(
          principalId,
          channelId,
          "channel.message.edit",
          {
            contentType: "text/plain",
            expectedRevision: input.expectedRevision,
            messageId,
            text: input.text,
          },
          request.headers["idempotency-key"],
        );
        sendJson(response, 200, {
          message: result.message,
          nextOffset: result.receipt.nextOffset,
          ok: true,
        });
        return;
      }
      if (
        messageId &&
        resourceParts.length === 2 &&
        request.method === "DELETE"
      ) {
        const input = await readJson(request);
        const result = await api.mutateMessage(
          principalId,
          channelId,
          "channel.message.delete",
          {
            expectedRevision: input.expectedRevision,
            messageId,
          },
          request.headers["idempotency-key"],
        );
        sendJson(response, 200, {
          message: result.message,
          nextOffset: result.receipt.nextOffset,
          ok: true,
        });
        return;
      }
      if (
        messageId &&
        resourceParts[2] === "reactions" &&
        resourceParts.length === 3 &&
        request.method === "POST"
      ) {
        const input = await readJson(request);
        const operation =
          input.action === "remove"
            ? "channel.reaction.remove"
            : "channel.reaction.add";
        const result = await api.mutateMessage(
          principalId,
          channelId,
          operation,
          { emoji: input.emoji, messageId },
          request.headers["idempotency-key"],
        );
        sendJson(response, 200, {
          message: result.message,
          nextOffset: result.receipt.nextOffset,
          ok: true,
        });
        return;
      }
      sendJson(response, 404, { code: "CAPSTONE_NOT_FOUND", ok: false });
    } catch (error) {
      sendError(response, error);
    }
  });

  return Object.freeze({
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve(server.address());
        });
      }),
    server,
  });
}

function assertWorkspaceMember(state, principalId) {
  const workspaceId =
    Object.keys(state.entities.workspaces ?? {})[0] ?? CAPSTONE_WORKSPACE_ID;
  let membership;
  try {
    membership =
      state.entities.memberships?.[membershipIdFor(workspaceId, principalId)];
  } catch {
    throw accessDenied();
  }
  if (!membership || membership.status !== "active") throw accessDenied();
}

function assertReadable(state, channel, principalId) {
  if (!channel || channel.status !== "active") {
    throw new MultiUserChatApiError(
      CAPSTONE_API_ERROR_CODES.CHANNEL_NOT_FOUND,
      "channel is not visible",
      { statusCode: 404 },
    );
  }
  assertWorkspaceMember(state, principalId);
  if (!canReadChannel(state, channel, principalId)) throw accessDenied();
}

function canReadChannel(state, channel, principalId) {
  if (channel.kind === "public") return true;
  return (
    state.entities.channelMemberships?.[
      channelMembershipKey(channel.channelId, principalId)
    ]?.status === "active"
  );
}

function publicChannel(state, channel) {
  const members = Object.values(state.entities.channelMemberships ?? {})
    .filter(
      (membership) =>
        membership.channelId === channel.channelId &&
        membership.status === "active",
    )
    .map((membership) => membership.principalId)
    .sort();
  return {
    channelId: channel.channelId,
    displayName: channel.displayName,
    kind: channel.kind,
    participantIds: channel.participantIds,
    revision: channel.revision,
    status: channel.status,
    memberIds: members,
    workspaceId: channel.workspaceId,
  };
}

function publicMessage(message) {
  return structuredClone(message);
}

function publicPrincipal(principal) {
  return {
    kind: principal.kind,
    ownedBy: principal.ownedBy,
    principalId: principal.principalId,
    profile: structuredClone(principal.profile),
    status: principal.status,
  };
}

function messageOrder(left, right, state) {
  const leftEvent = state.eventProvenance.find(
    ({ envelope }) => envelope.data?.messageId === left.messageId,
  );
  const rightEvent = state.eventProvenance.find(
    ({ envelope }) => envelope.data?.messageId === right.messageId,
  );
  return (leftEvent?.offset ?? "").localeCompare(rightEvent?.offset ?? "");
}

function compareSourceRecords(left, right) {
  return (
    left.event.serverTimestamp.localeCompare(right.event.serverTimestamp) ||
    left.event.eventId.localeCompare(right.event.eventId)
  );
}

function sourceOffset(sequence) {
  return `${OFFSET_PREFIX}${sequence.toString(16).padStart(16, "0")}`;
}

function replayOffset(sequence) {
  return `${OFFSET_PREFIX}${(0x100000000 + sequence).toString(16).padStart(16, "0")}`;
}

function tokenFor(value) {
  return Math.max(0, Number(value)).toString(16).padStart(26, "0").slice(-26);
}

function stableNumber(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) + 1;
}

function keyFor(value) {
  return `ik_${tokenFor(stableNumber(value))}`;
}

function authDenied() {
  return new MultiUserChatApiError(
    CAPSTONE_API_ERROR_CODES.AUTHENTICATION_DENIED,
    "principal authentication was refused",
    { statusCode: 401 },
  );
}

function accessDenied() {
  return new MultiUserChatApiError(
    CAPSTONE_API_ERROR_CODES.ACCESS_DENIED,
    "channel access denied",
    { statusCode: 404 },
  );
}

function bootstrapEvents(workspaceId) {
  const ada = CAPSTONE_PRINCIPALS.ADA;
  const linus = CAPSTONE_PRINCIPALS.LINUS;
  const agent = CAPSTONE_PRINCIPALS.AGENT;
  const service = CAPSTONE_PRINCIPALS.SERVICE;
  const principal = (
    actorId,
    token,
    principalId,
    kind,
    handle,
    ownedBy = null,
  ) => ({
    actorId,
    data: {
      kind,
      ownedBy,
      principalId,
      profile: {
        displayName: handle[0].toUpperCase() + handle.slice(1),
        email: kind === "service" ? "" : `${handle}@example.test`,
        handle,
      },
      subjectBinding: {
        audience: "stream-slack",
        issuer: kind === "human" ? "auth0" : "stream-slack",
        subject: `${kind}:${handle}`,
      },
    },
    eventType: "principal.created",
    idempotencyKey: `ik_${tokenFor(token)}`,
  });
  const events = [
    principal(ada, 1, ada, "human", "ada"),
    principal(ada, 2, linus, "human", "linus"),
    principal(ada, 3, agent, "agent", "helper", ada),
    principal(ada, 4, service, "service", "audit-service"),
    {
      actorId: ada,
      data: {
        displayName: "Capstone Workspace",
        ownerPrincipalId: ada,
        workspaceId,
      },
      eventType: "workspace.created",
      idempotencyKey: `ik_${tokenFor(5)}`,
    },
  ];
  let workspaceRevision = 1;
  let inviteToken = 20;
  for (const [principalId, role] of [
    [linus, "member"],
    [agent, "agent"],
    [service, "service"],
  ]) {
    const inviteId = `iv_${workspaceId.slice(3)}_${tokenFor(inviteToken++)}`;
    events.push({
      actorId: ada,
      data: {
        expectedWorkspaceRevision: workspaceRevision,
        inviteId,
        principalId,
        role,
      },
      eventType: "workspace.membership.invited",
      idempotencyKey: `ik_${tokenFor(inviteToken++)}`,
    });
    workspaceRevision += 1;
    events.push({
      actorId: principalId,
      data: {
        expectedWorkspaceRevision: workspaceRevision,
        inviteId,
        principalId,
      },
      eventType: "workspace.membership.accepted",
      idempotencyKey: `ik_${tokenFor(inviteToken++)}`,
    });
    workspaceRevision += 1;
  }
  return events;
}

function sessionIdFrom(request) {
  const value = request.headers.authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice("Bearer ".length) : "";
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new MultiUserChatApiError(
      CAPSTONE_API_ERROR_CODES.INVALID_REQUEST,
      "request body must be JSON",
      { statusCode: 400 },
    );
  }
}

function sendJson(response, statusCode, value) {
  if (response.headersSent || response.writableEnded || response.destroyed)
    return;
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function sendError(response, error) {
  sendJson(response, Number(error?.statusCode ?? 500), {
    code: error?.code ?? "CAPSTONE_INTERNAL_ERROR",
    error: error instanceof Error ? error.message : String(error),
    ok: false,
  });
}
