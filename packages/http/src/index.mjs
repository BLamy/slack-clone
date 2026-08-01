import { ZERO_OFFSET } from "@stream-slack/protocol";

export async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

export function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

export function sendError(response, error) {
  const statusCode = Number(error?.statusCode ?? 500);
  sendJson(response, statusCode, {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

export function createChatHttpDelivery({
  auth0EmulatorUrl,
  chatService,
  currentSession,
  durableStreamsUrl,
  emptyDigest,
  fetchFn,
  sessionUser,
  timers = globalThis,
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
        timer: null,
        polling: false,
      };
      rooms.set(room, state);
    }
    return state;
  }

  function writeSse(response, event, data) {
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  function broadcast(state, event, data) {
    for (const client of state.clients) writeSse(client, event, data);
  }

  async function pollRoom(state) {
    if (state.polling) return;
    state.polling = true;
    try {
      if (state.nextOffset === null) {
        const initial = await chatService.readMessages(state.room, "now");
        state.nextOffset = initial.nextOffset;
      }
      const result = await chatService.readMessages(
        state.room,
        state.nextOffset,
      );
      state.nextOffset = result.nextOffset;
      for (const message of result.records)
        broadcast(state, "message", message);
      if (result.records.length > 0) {
        state.streamDigest = (
          await chatService.readMessages(state.room, "-1")
        ).streamDigest;
      }
      broadcast(state, "status", {
        durableStreamsUrl,
        stream: `/rooms/${state.room}/messages`,
        nextOffset: state.nextOffset,
        streamDigest: state.streamDigest,
        clients: state.clients.size,
      });
    } catch (error) {
      broadcast(state, "error", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      state.polling = false;
      if (state.clients.size > 0) {
        state.timer = timers.setTimeout(() => void pollRoom(state), 350);
      } else {
        state.timer = null;
        state.nextOffset = null;
      }
    }
  }

  function startPolling(state) {
    if (!state.timer && !state.polling) void pollRoom(state);
  }

  async function handleApi(request, response, url) {
    if (url.pathname === "/api/health") {
      await chatService.ensureStream("healthcheck");
      const authResponse = await fetchFn(
        `${auth0EmulatorUrl}/.well-known/openid-configuration`,
      );
      sendJson(response, 200, {
        ok: true,
        app: "slack-clone",
        durableStreamsUrl,
        auth0EmulatorUrl,
        auth0: authResponse.ok,
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
      const state = roomState(room);
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      state.clients.add(response);
      const snapshot = await chatService.readMessages(room, "-1");
      writeSse(response, "snapshot", {
        messages: snapshot.messages,
        durableStreamsUrl,
        stream: `/rooms/${room}/messages`,
        nextOffset: snapshot.nextOffset,
        streamDigest: snapshot.streamDigest,
      });
      state.streamDigest = snapshot.streamDigest;
      if (state.nextOffset === null) state.nextOffset = snapshot.nextOffset;
      startPolling(state);

      const keepAlive = timers.setInterval(
        () => response.write(": keep-alive\n\n"),
        10000,
      );
      request.on("close", () => {
        timers.clearInterval(keepAlive);
        state.clients.delete(response);
      });
      return true;
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
      const result = await chatService.appendMessage(
        room,
        await readJson(request),
        user,
      );
      sendJson(response, 201, {
        ok: true,
        room,
        message: result.message,
        nextOffset: result.nextOffset,
      });
      return true;
    }

    if (resource === "messages" && messageId && request.method === "PATCH") {
      const result = await chatService.updateMessage(
        room,
        messageId,
        await readJson(request),
        user,
      );
      sendJson(response, 200, {
        ok: true,
        room,
        message: result.message,
        nextOffset: result.nextOffset,
      });
      return true;
    }

    if (resource === "messages" && request.method === "DELETE") {
      await chatService.resetRoom(room);
      const state = roomState(room);
      state.nextOffset = null;
      state.streamDigest = emptyDigest;
      broadcast(state, "reset", {
        room,
        nextOffset: ZERO_OFFSET,
        streamDigest: emptyDigest,
      });
      sendJson(response, 200, { ok: true, room });
      return true;
    }

    return false;
  }

  function close() {
    for (const state of rooms.values()) {
      if (state.timer) timers.clearTimeout(state.timer);
      for (const client of state.clients) client.end();
      state.clients.clear();
    }
    rooms.clear();
  }

  return { close, handleApi };
}
