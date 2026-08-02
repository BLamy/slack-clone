import { ZERO_OFFSET } from "@stream-slack/protocol";

const DEFAULT_TIMERS = Object.freeze({
  clearInterval: (timer) => globalThis.clearInterval(timer),
  setInterval: (callback, delay) => globalThis.setInterval(callback, delay),
});

export async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

export function sendJson(response, statusCode, value) {
  if (response.headersSent || response.writableEnded || response.destroyed) {
    return false;
  }
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
  return true;
}

export function sendError(response, error) {
  if (response.headersSent || response.writableEnded || response.destroyed) {
    if (!response.writableEnded && !response.destroyed) response.end();
    return false;
  }
  const statusCode = Number(error?.statusCode ?? 500);
  return sendJson(response, statusCode, {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

export function createChatHttpDelivery({
  auth0Health,
  auth0EmulatorUrl,
  chatService,
  currentSession,
  durableStreamsUrl,
  emptyDigest,
  sessionUser,
  timers = DEFAULT_TIMERS,
}) {
  const rooms = new Map();

  function roomState(roomId) {
    const room = chatService.normalizeRoomId(roomId);
    let state = rooms.get(room);
    if (!state) {
      state = {
        room,
        clients: new Set(),
        nextOffset: null,
        streamDigest: emptyDigest,
        follow: null,
        followGeneration: 0,
        starting: null,
      };
      rooms.set(room, state);
    }
    return state;
  }

  function writeSse(response, event, data) {
    if (response.destroyed || response.writableEnded) return false;
    try {
      response.write(`event: ${event}\n`);
      response.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      return false;
    }
  }

  function removeClient(state, client) {
    if (!state.clients.delete(client)) return;
    timers.clearInterval(client.keepAlive);
    if (state.clients.size === 0) stopFollowing(state, "last client left");
  }

  function broadcast(state, event, data) {
    for (const client of [...state.clients]) {
      if (!writeSse(client.response, event, data)) {
        removeClient(state, client);
      }
    }
  }

  function broadcastStatus(state) {
    broadcast(state, "status", {
      durableStreamsUrl,
      stream: `/rooms/${state.room}/messages`,
      nextOffset: state.nextOffset ?? ZERO_OFFSET,
      streamDigest: state.streamDigest,
      clients: state.clients.size,
    });
  }

  function stopFollowing(state, reason) {
    state.followGeneration += 1;
    state.follow?.cancel(reason);
    state.follow = null;
    state.starting = null;
  }

  function startFollowing(state) {
    if (
      state.clients.size === 0 ||
      state.follow ||
      state.starting ||
      state.nextOffset === null
    ) {
      return;
    }

    const generation = state.followGeneration + 1;
    state.followGeneration = generation;
    state.starting = chatService
      .followMessages(state.room, state.nextOffset, {
        live: "sse",
        onBatch: async (batch) => {
          if (generation !== state.followGeneration) return;
          state.nextOffset = batch.nextOffset;
          let resetSnapshot = null;
          for (const record of batch.records) {
            if (record?.dispatch?.operation === "chat.room.reset") {
              resetSnapshot ??= await chatService.readMessages(
                state.room,
                "-1",
              );
              if (generation !== state.followGeneration) return;
              state.nextOffset = resetSnapshot.nextOffset;
              state.streamDigest = resetSnapshot.streamDigest;
              broadcast(state, "reset", {
                room: state.room,
                nextOffset: state.nextOffset,
                streamDigest: state.streamDigest,
              });
            } else {
              broadcast(state, "message", record);
            }
          }
          if (!resetSnapshot && batch.records.length > 0) {
            const snapshot = await chatService.readMessages(state.room, "-1");
            if (generation !== state.followGeneration) return;
            state.nextOffset = snapshot.nextOffset;
            state.streamDigest = snapshot.streamDigest;
          }
          broadcastStatus(state);
        },
      })
      .then((follow) => {
        state.starting = null;
        if (generation !== state.followGeneration || state.clients.size === 0) {
          follow.cancel("room follow superseded");
          return;
        }
        state.follow = follow;
        follow.closed
          .catch((error) => {
            if (generation !== state.followGeneration) return;
            broadcast(state, "error", {
              message: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            if (generation === state.followGeneration) state.follow = null;
          });
      })
      .catch((error) => {
        if (generation !== state.followGeneration) return;
        state.starting = null;
        broadcast(state, "error", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  async function handleEvents(request, response, room) {
    const state = roomState(room);
    const disconnect = new AbortController();
    const abortBeforeHeaders = () => disconnect.abort("client disconnected");
    request.once("aborted", abortBeforeHeaders);

    let snapshot;
    try {
      snapshot = await chatService.readMessages(room, "-1", {
        signal: disconnect.signal,
      });
    } finally {
      request.removeListener("aborted", abortBeforeHeaders);
    }
    if (disconnect.signal.aborted || response.destroyed) return true;

    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const client = {
      response,
      keepAlive: null,
    };
    state.clients.add(client);
    state.nextOffset = snapshot.nextOffset;
    state.streamDigest = snapshot.streamDigest;
    writeSse(response, "snapshot", {
      messages: snapshot.messages,
      durableStreamsUrl,
      stream: `/rooms/${room}/messages`,
      nextOffset: snapshot.nextOffset,
      streamDigest: snapshot.streamDigest,
    });
    client.keepAlive = timers.setInterval(() => {
      if (response.destroyed || response.writableEnded) {
        removeClient(state, client);
        return;
      }
      response.write(": keep-alive\n\n");
    }, 10_000);
    response.once("close", () => removeClient(state, client));
    startFollowing(state);
    return true;
  }

  async function handleApi(request, response, url) {
    if (url.pathname === "/api/health") {
      await chatService.ensureStream("healthcheck");
      const authHealthy = await auth0Health();
      sendJson(response, 200, {
        ok: true,
        app: "slack-clone",
        durableStreamsUrl,
        auth0EmulatorUrl,
        auth0: authHealthy,
      });
      return true;
    }

    if (url.pathname === "/api/session") {
      const session = currentSession(request);
      if (!session) {
        sendJson(response, 401, { ok: false, error: "not_authenticated" });
        return true;
      }
      sendJson(response, 200, {
        ok: true,
        user: session.user,
        provider: { name: "Auth0 emulator", url: auth0EmulatorUrl },
      });
      return true;
    }

    const match = url.pathname.match(
      /^\/api\/rooms\/([^/]+)\/(messages|events)(?:\/([^/]+))?$/,
    );
    if (!match) return false;
    const user = sessionUser(request);
    if (!user) {
      sendJson(response, 401, { ok: false, error: "not_authenticated" });
      return true;
    }

    const room = chatService.normalizeRoomId(decodeURIComponent(match[1]));
    const resource = match[2];
    const messageId = match[3] ? decodeURIComponent(match[3]) : null;

    if (resource === "events" && request.method === "GET") {
      return handleEvents(request, response, room);
    }

    if (resource === "messages" && request.method === "GET") {
      const result = await chatService.readMessages(room, "-1");
      sendJson(response, 200, {
        ok: true,
        room,
        stream: `/rooms/${room}/messages`,
        durableStreamsUrl,
        nextOffset: result.nextOffset,
        streamDigest: result.streamDigest,
        messages: result.messages,
      });
      return true;
    }

    if (resource === "messages" && request.method === "POST") {
      const input = await readJson(request);
      const result = await chatService.appendMessage(room, input, user, {
        idempotencyKey:
          typeof request.headers["idempotency-key"] === "string"
            ? request.headers["idempotency-key"]
            : undefined,
      });
      startFollowing(roomState(room));
      sendJson(response, 201, {
        ok: true,
        room,
        message: result.message,
        nextOffset: result.nextOffset,
      });
      return true;
    }

    if (resource === "messages" && messageId && request.method === "PATCH") {
      const input = await readJson(request);
      const result = await chatService.updateMessage(
        room,
        messageId,
        input,
        user,
        {
          idempotencyKey:
            typeof request.headers["idempotency-key"] === "string"
              ? request.headers["idempotency-key"]
              : undefined,
        },
      );
      startFollowing(roomState(room));
      sendJson(response, 200, {
        ok: true,
        room,
        message: result.message,
        nextOffset: result.nextOffset,
      });
      return true;
    }

    if (resource === "messages" && request.method === "DELETE") {
      const state = roomState(room);
      stopFollowing(state, "room reset");
      const reset = await chatService.resetRoom(room, user, {
        idempotencyKey:
          typeof request.headers["idempotency-key"] === "string"
            ? request.headers["idempotency-key"]
            : undefined,
      });
      state.nextOffset = reset.nextOffset;
      state.streamDigest = reset.streamDigest ?? emptyDigest;
      broadcast(state, "reset", {
        room,
        nextOffset: state.nextOffset,
        streamDigest: state.streamDigest,
      });
      startFollowing(state);
      sendJson(response, 200, {
        ok: true,
        room,
        nextOffset: state.nextOffset,
        streamDigest: state.streamDigest,
      });
      return true;
    }

    return false;
  }

  function close() {
    for (const state of rooms.values()) {
      stopFollowing(state, "HTTP delivery closed");
      for (const client of [...state.clients]) {
        timers.clearInterval(client.keepAlive);
        if (!client.response.writableEnded && !client.response.destroyed) {
          client.response.end();
        }
      }
      state.clients.clear();
    }
    rooms.clear();
  }

  return { close, handleApi };
}
