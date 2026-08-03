const DEFAULT_TIMERS = Object.freeze({
  clearInterval: (timer) => globalThis.clearInterval(timer),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
  setInterval: (callback, delay) => globalThis.setInterval(callback, delay),
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
});

const MAX_CHECKPOINT_BYTES = 512;
const MAX_SSE_FRAME_BYTES = 1_000_000;
const MAX_PENDING_SSE_BYTES = 4_000_000;
const MAX_PENDING_SSE_FRAMES = 128;
const BACKPRESSURE_TIMEOUT_MS = 5_000;
const INITIAL_CHECKPOINT = "-1";

export const LIVE_CHAT_ERROR_CODES = Object.freeze({
  AUTHORIZATION_REVOKED: "LIVE_AUTHORIZATION_REVOKED",
  BACKPRESSURE_TIMEOUT: "LIVE_BACKPRESSURE_TIMEOUT",
  CHECKPOINT_CONFLICT: "LIVE_CHECKPOINT_CONFLICT",
  CHECKPOINT_INVALID: "LIVE_CHECKPOINT_INVALID",
  FRAME_TOO_LARGE: "LIVE_FRAME_TOO_LARGE",
  SERVER_SHUTDOWN: "LIVE_SERVER_SHUTDOWN",
  SESSION_REVOKED: "LIVE_SESSION_REVOKED",
  STREAM_CLOSED: "LIVE_STREAM_CLOSED",
  UPSTREAM_FAILURE: "LIVE_UPSTREAM_FAILURE",
});

export class LiveChatDeliveryError extends Error {
  constructor(code, detail, { statusCode = 400, cause } = {}) {
    super(detail, { cause });
    this.name = "LiveChatDeliveryError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function validateLiveCheckpoint(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_CHECKPOINT_BYTES ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint <= 31 ||
        (codePoint >= 128 && codePoint <= 159) ||
        codePoint === 127
      );
    })
  ) {
    throw new LiveChatDeliveryError(
      LIVE_CHAT_ERROR_CODES.CHECKPOINT_INVALID,
      "live chat checkpoint is not a valid opaque value",
      { statusCode: 400 },
    );
  }
  return value;
}

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
    ...(error?.code ? { code: error.code } : {}),
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
  revalidateSubscription = null,
  workspaceAuthorization = null,
  timers = DEFAULT_TIMERS,
}) {
  const rooms = new Map();
  const clock = { ...DEFAULT_TIMERS, ...timers };

  if (workspaceAuthorization !== null) {
    for (const method of [
      "authorizeDispatch",
      "authorizeRead",
      "authorizeSubscription",
      "contextForRequest",
    ]) {
      if (typeof workspaceAuthorization[method] !== "function") {
        throw new TypeError(
          `workspace authorization requires ${method} capability`,
        );
      }
    }
  }

  if (
    revalidateSubscription !== null &&
    typeof revalidateSubscription !== "function"
  ) {
    throw new TypeError("revalidateSubscription must be a function");
  }

  const revalidateLive =
    revalidateSubscription ??
    (workspaceAuthorization
      ? ({ context }) =>
          workspaceAuthorization.authorizeRead(context, {
            capability: "workspace.subscribe",
          })
      : null);

  function roomState(roomId) {
    const room = chatService.normalizeRoomId(roomId);
    let state = rooms.get(room);
    if (!state) {
      state = {
        room,
        clients: new Set(),
      };
      rooms.set(room, state);
    }
    return state;
  }

  function removeClient(state, client) {
    if (!state.clients.delete(client)) return;
    client.closed = true;
    clock.clearInterval(client.keepAlive);
    client.follow?.cancel("live client removed");
    client.follow = null;
    client.starting = null;
    client.abortController.abort("live client removed");
    if (state.clients.size === 0 && rooms.get(state.room) === state) {
      rooms.delete(state.room);
    }
  }

  function frameFor(event, data, checkpoint) {
    const serialized = JSON.stringify(data);
    const id = checkpoint === undefined ? "" : `id: ${checkpoint}\n`;
    const frame = `${id}event: ${event}\ndata: ${serialized}\n\n`;
    if (Buffer.byteLength(frame, "utf8") > MAX_SSE_FRAME_BYTES) {
      throw new LiveChatDeliveryError(
        LIVE_CHAT_ERROR_CODES.FRAME_TOO_LARGE,
        "live chat event exceeds the bounded delivery frame",
        { statusCode: 413 },
      );
    }
    return frame;
  }

  function waitForDrain(client) {
    return new Promise((resolve) => {
      const response = client.response;
      let timer = null;
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clock.clearTimeout(timer);
        response.removeListener?.("drain", onDrain);
        response.removeListener?.("close", onClose);
        response.removeListener?.("error", onClose);
        resolve(ok);
      };
      const onDrain = () => finish(true);
      const onClose = () => finish(false);
      response.once?.("drain", onDrain);
      response.once?.("close", onClose);
      response.once?.("error", onClose);
      timer = clock.setTimeout(() => finish(false), BACKPRESSURE_TIMEOUT_MS);
      if (response.destroyed || response.writableEnded || client.closed) {
        finish(false);
      }
    });
  }

  async function writeRaw(client, frame) {
    if (
      client.closed ||
      client.response.destroyed ||
      client.response.writableEnded
    ) {
      return false;
    }
    let accepted;
    try {
      accepted = client.response.write(frame);
    } catch {
      return false;
    }
    if (accepted === false && !(await waitForDrain(client))) {
      throw new LiveChatDeliveryError(
        LIVE_CHAT_ERROR_CODES.BACKPRESSURE_TIMEOUT,
        "live chat client did not drain its bounded response buffer",
        { statusCode: 409 },
      );
    }
    return !client.closed && !client.response.destroyed;
  }

  function enqueueRaw(client, frame) {
    const frameBytes = Buffer.byteLength(frame, "utf8");
    if (
      client.closed ||
      client.pendingFrames >= MAX_PENDING_SSE_FRAMES ||
      client.pendingBytes + frameBytes > MAX_PENDING_SSE_BYTES
    ) {
      return Promise.reject(
        new LiveChatDeliveryError(
          LIVE_CHAT_ERROR_CODES.BACKPRESSURE_TIMEOUT,
          "live chat client exceeded its bounded response buffer",
          { statusCode: 409 },
        ),
      );
    }
    client.pendingFrames += 1;
    client.pendingBytes += frameBytes;
    const operation = client.writeTail.then(
      () => writeRaw(client, frame),
      () => writeRaw(client, frame),
    );
    const settled = operation.finally(() => {
      client.pendingFrames -= 1;
      client.pendingBytes -= frameBytes;
    });
    client.writeTail = settled.catch(() => {});
    return settled;
  }

  function enqueueSse(client, event, data, checkpoint) {
    return enqueueRaw(client, frameFor(event, data, checkpoint));
  }

  async function terminateClient(
    state,
    client,
    { code, detail, checkpoint = client.lastAckedOffset, resync = false },
  ) {
    if (client.terminalPromise) return client.terminalPromise;
    client.terminating = true;
    client.follow?.cancel(detail);
    client.abortController.abort(detail);
    const payload = {
      action: resync
        ? "resync"
        : code === LIVE_CHAT_ERROR_CODES.SERVER_SHUTDOWN ||
            code === LIVE_CHAT_ERROR_CODES.SESSION_REVOKED ||
            code === LIVE_CHAT_ERROR_CODES.AUTHORIZATION_REVOKED
          ? "close"
          : "reconnect",
      code,
      detail,
      nextOffset: checkpoint,
      room: state.room,
      terminal: true,
    };
    client.terminalPromise = client.writeTail
      .then(async () => {
        if (!client.response.destroyed && !client.response.writableEnded) {
          try {
            await writeRaw(client, frameFor("terminal", payload, checkpoint));
          } catch {
            // The response may already be backpressured or disconnected.
          }
          if (!client.response.writableEnded && !client.response.destroyed) {
            client.response.end();
          }
        }
      })
      .catch(() => {})
      .finally(() => removeClient(state, client));
    return client.terminalPromise;
  }

  async function revalidateClient(client) {
    if (
      typeof currentSession === "function" &&
      !currentSession(client.request)
    ) {
      throw new LiveChatDeliveryError(
        LIVE_CHAT_ERROR_CODES.SESSION_REVOKED,
        "live chat session is no longer authenticated",
        { statusCode: 401 },
      );
    }
    if (!revalidateLive) return true;
    const result = await revalidateLive({
      checkpoint: client.lastAckedOffset,
      context: client.context,
      request: client.request,
      room: client.state.room,
    });
    if (result === false || (result && result.ok === false)) {
      throw new LiveChatDeliveryError(
        LIVE_CHAT_ERROR_CODES.AUTHORIZATION_REVOKED,
        "live chat authorization is no longer valid",
        { statusCode: 404 },
      );
    }
    return true;
  }

  async function deliverRecords(
    client,
    records,
    nextOffset,
    {
      revalidate = true,
      streamDigest,
      upToDate = false,
      streamClosed = false,
    } = {},
  ) {
    if (revalidate) await revalidateClient(client);
    for (const record of records) {
      if (record?.dispatch?.operation === "chat.room.reset") {
        await enqueueSse(client, "reset", {
          room: client.state.room,
          nextOffset,
          streamDigest: client.streamDigest,
        });
      } else {
        await enqueueSse(client, "message", record);
      }
    }
    if (records.length > 0 || upToDate || streamClosed) {
      const status = {
        clients: client.state.clients.size,
        durableStreamsUrl,
        nextOffset,
        stream: `/rooms/${client.state.room}/messages`,
        streamDigest:
          streamDigest === undefined ? client.streamDigest : streamDigest,
      };
      await enqueueSse(client, "status", status, nextOffset);
      client.lastAckedOffset = validateLiveCheckpoint(nextOffset);
      if (streamDigest !== undefined) client.streamDigest = streamDigest;
    }
    if (streamClosed && !client.closed) {
      await terminateClient(client.state, client, {
        code: LIVE_CHAT_ERROR_CODES.STREAM_CLOSED,
        detail: "the durable chat stream is closed",
        checkpoint: client.lastAckedOffset,
      });
    }
  }

  function startFollowing(client) {
    if (client.closed || client.follow || client.starting) return;
    client.starting = chatService
      .followMessages(client.state.room, client.lastAckedOffset, {
        live: "sse",
        signal: client.abortController.signal,
        onBatch: async (batch) => {
          if (client.closed) return;
          try {
            await deliverRecords(client, batch.records, batch.nextOffset, {
              streamClosed: batch.streamClosed,
              upToDate: batch.upToDate,
            });
            if (batch.records.length > 0 && !client.closed) {
              const snapshot = await chatService.readMessages(
                client.state.room,
                INITIAL_CHECKPOINT,
              );
              if (client.closed) return;
              client.streamDigest = snapshot.streamDigest;
              await enqueueSse(
                client,
                "status",
                {
                  clients: client.state.clients.size,
                  durableStreamsUrl,
                  nextOffset: client.lastAckedOffset,
                  stream: `/rooms/${client.state.room}/messages`,
                  streamDigest: client.streamDigest,
                },
                client.lastAckedOffset,
              );
            }
          } catch (error) {
            if (client.closed) return;
            const code =
              error instanceof LiveChatDeliveryError &&
              error.code === LIVE_CHAT_ERROR_CODES.SESSION_REVOKED
                ? LIVE_CHAT_ERROR_CODES.SESSION_REVOKED
                : error instanceof LiveChatDeliveryError &&
                    error.code === LIVE_CHAT_ERROR_CODES.AUTHORIZATION_REVOKED
                  ? LIVE_CHAT_ERROR_CODES.AUTHORIZATION_REVOKED
                  : (error?.code ?? LIVE_CHAT_ERROR_CODES.UPSTREAM_FAILURE);
            await terminateClient(client.state, client, {
              code,
              detail:
                code === LIVE_CHAT_ERROR_CODES.SESSION_REVOKED
                  ? "live chat session is no longer authenticated"
                  : code === LIVE_CHAT_ERROR_CODES.AUTHORIZATION_REVOKED
                    ? "live chat authorization is no longer valid"
                    : error instanceof Error
                      ? error.message
                      : String(error),
              checkpoint: client.lastAckedOffset,
              resync: code === LIVE_CHAT_ERROR_CODES.BACKPRESSURE_TIMEOUT,
            });
          }
        },
      })
      .then((follow) => {
        client.starting = null;
        if (client.closed || client.terminating) {
          follow.cancel("live client superseded");
          return;
        }
        client.follow = follow;
        follow.closed
          .then(() => {
            if (client.closed || client.terminating) return;
            return terminateClient(client.state, client, {
              code: LIVE_CHAT_ERROR_CODES.STREAM_CLOSED,
              detail: "the live durable stream ended",
              checkpoint: client.lastAckedOffset,
            });
          })
          .catch((error) => {
            if (client.closed || client.terminating) return;
            return terminateClient(client.state, client, {
              code: error?.code ?? LIVE_CHAT_ERROR_CODES.UPSTREAM_FAILURE,
              detail: error instanceof Error ? error.message : String(error),
              checkpoint: client.lastAckedOffset,
            });
          });
      })
      .catch((error) => {
        client.starting = null;
        if (client.closed || client.terminating) return;
        void terminateClient(client.state, client, {
          code: error?.code ?? LIVE_CHAT_ERROR_CODES.UPSTREAM_FAILURE,
          detail: error instanceof Error ? error.message : String(error),
          checkpoint: client.lastAckedOffset,
        });
      });
  }

  async function handleEvents(
    request,
    response,
    room,
    { context = null, resumeOffset = INITIAL_CHECKPOINT } = {},
  ) {
    const state = roomState(room);
    const disconnect = new AbortController();
    const client = {
      abortController: disconnect,
      closed: false,
      context,
      follow: null,
      keepAlive: null,
      lastAckedOffset: resumeOffset,
      pendingBytes: 0,
      pendingFrames: 0,
      request,
      response,
      starting: null,
      state,
      streamDigest: emptyDigest,
      terminalPromise: null,
      terminating: false,
      writeTail: Promise.resolve(),
    };
    state.clients.add(client);
    const abortBeforeHeaders = () => {
      disconnect.abort("client disconnected");
      removeClient(state, client);
    };
    request.once("aborted", abortBeforeHeaders);
    response.once("close", () => removeClient(state, client));
    if (context === null) {
      try {
        await revalidateClient(client);
      } catch (error) {
        request.removeListener("aborted", abortBeforeHeaders);
        removeClient(state, client);
        throw error;
      }
    }

    let snapshot;
    try {
      snapshot = await chatService.readMessages(room, resumeOffset, {
        signal: disconnect.signal,
      });
    } catch (error) {
      const disconnected = disconnect.signal.aborted || response.destroyed;
      removeClient(state, client);
      if (disconnected) return true;
      if (resumeOffset !== INITIAL_CHECKPOINT) {
        throw new LiveChatDeliveryError(
          LIVE_CHAT_ERROR_CODES.CHECKPOINT_INVALID,
          "live chat resume checkpoint was rejected by the stream",
          { statusCode: 409, cause: error },
        );
      }
      throw new LiveChatDeliveryError(
        LIVE_CHAT_ERROR_CODES.UPSTREAM_FAILURE,
        "live chat snapshot could not be read",
        { statusCode: 502, cause: error },
      );
    } finally {
      request.removeListener("aborted", abortBeforeHeaders);
    }
    if (disconnect.signal.aborted || response.destroyed || client.closed) {
      removeClient(state, client);
      return true;
    }
    try {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      if (resumeOffset === INITIAL_CHECKPOINT) {
        await enqueueSse(
          client,
          "snapshot",
          {
            messages: snapshot.messages,
            durableStreamsUrl,
            stream: `/rooms/${room}/messages`,
            nextOffset: snapshot.nextOffset,
            streamDigest: snapshot.streamDigest,
          },
          snapshot.nextOffset,
        );
        client.lastAckedOffset = validateLiveCheckpoint(snapshot.nextOffset);
        client.streamDigest = snapshot.streamDigest;
      } else {
        await enqueueSse(
          client,
          "resume",
          {
            fromOffset: resumeOffset,
            nextOffset: resumeOffset,
            room,
          },
          resumeOffset,
        );
        await deliverRecords(client, snapshot.records, snapshot.nextOffset, {
          revalidate: false,
          streamDigest: undefined,
          upToDate: true,
        });
      }
    } catch (error) {
      if (client.closed || disconnect.signal.aborted || response.destroyed) {
        removeClient(state, client);
        return true;
      }
      await terminateClient(state, client, {
        code:
          error instanceof LiveChatDeliveryError
            ? error.code
            : LIVE_CHAT_ERROR_CODES.UPSTREAM_FAILURE,
        detail:
          error instanceof Error
            ? error.message
            : "live chat delivery could not start",
        checkpoint: client.lastAckedOffset,
        resync:
          error?.code === LIVE_CHAT_ERROR_CODES.BACKPRESSURE_TIMEOUT ||
          error?.code === LIVE_CHAT_ERROR_CODES.FRAME_TOO_LARGE,
      });
      return true;
    }
    client.keepAlive = clock.setInterval(() => {
      if (client.closed || response.destroyed || response.writableEnded) {
        removeClient(state, client);
        return;
      }
      void revalidateClient(client)
        .then(() => enqueueRaw(client, ": keep-alive\n\n"))
        .catch((error) => {
          void terminateClient(state, client, {
            code:
              error?.code === LIVE_CHAT_ERROR_CODES.SESSION_REVOKED
                ? LIVE_CHAT_ERROR_CODES.SESSION_REVOKED
                : LIVE_CHAT_ERROR_CODES.AUTHORIZATION_REVOKED,
            detail:
              error instanceof Error
                ? error.message
                : "live chat authorization is no longer valid",
            checkpoint: client.lastAckedOffset,
          });
        });
    }, 10_000);
    startFollowing(client);
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

    const workspaceContext = workspaceAuthorization
      ? await workspaceAuthorization.contextForRequest({ request, url, user })
      : null;

    const room = chatService.normalizeRoomId(decodeURIComponent(match[1]));
    const resource = match[2];
    const messageId = match[3] ? decodeURIComponent(match[3]) : null;

    if (resource === "events" && request.method === "GET") {
      let resumeOffset;
      try {
        resumeOffset = parseResumeCheckpoint(request, url);
      } catch (error) {
        sendError(response, error);
        return true;
      }
      if (!workspaceAuthorization) {
        return handleEvents(request, response, room, { resumeOffset });
      }
      return workspaceAuthorization.authorizeSubscription(
        requestMetadata(request, url, { room }),
        workspaceContext,
        {
          capability: "workspace.subscribe",
          register: () =>
            handleEvents(request, response, room, {
              context: workspaceContext,
              resumeOffset,
            }),
        },
      );
    }

    if (resource === "messages" && request.method === "GET") {
      const result = workspaceAuthorization
        ? await workspaceAuthorization
            .authorizeRead(workspaceContext, {
              capability: "workspace.read",
            })
            .then(() => chatService.readMessages(room, "-1"))
        : await chatService.readMessages(room, "-1");
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
      const result = workspaceAuthorization
        ? await workspaceAuthorization.authorizeDispatch(
            requestMetadata(request, url, { body: input, room }),
            workspaceContext,
            {
              capability: "workspace.message.mutate",
              dispatch: () =>
                chatService.appendMessage(room, input, user, {
                  idempotencyKey: idempotencyKey(request),
                }),
            },
          )
        : await chatService.appendMessage(room, input, user, {
            idempotencyKey: idempotencyKey(request),
          });
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
      const update = () =>
        chatService.updateMessage(room, messageId, input, user, {
          idempotencyKey: idempotencyKey(request),
        });
      const result = workspaceAuthorization
        ? await workspaceAuthorization.authorizeDispatch(
            requestMetadata(request, url, {
              body: input,
              messageId,
              room,
            }),
            workspaceContext,
            {
              capability: "workspace.message.mutate",
              dispatch: update,
            },
          )
        : await update();
      sendJson(response, 200, {
        ok: true,
        room,
        message: result.message,
        nextOffset: result.nextOffset,
      });
      return true;
    }

    if (resource === "messages" && request.method === "DELETE") {
      const resetRoom = async () => {
        const reset = await chatService.resetRoom(room, user, {
          idempotencyKey: idempotencyKey(request),
        });
        return reset;
      };
      const reset = workspaceAuthorization
        ? await workspaceAuthorization.authorizeDispatch(
            requestMetadata(request, url, { room }),
            workspaceContext,
            {
              capability: "workspace.message.mutate",
              dispatch: resetRoom,
            },
          )
        : await resetRoom();
      sendJson(response, 200, {
        ok: true,
        room,
        nextOffset: reset.nextOffset,
        streamDigest: reset.streamDigest ?? emptyDigest,
      });
      return true;
    }

    return false;
  }

  function close() {
    for (const state of rooms.values()) {
      for (const client of [...state.clients]) {
        void terminateClient(state, client, {
          code: LIVE_CHAT_ERROR_CODES.SERVER_SHUTDOWN,
          detail: "live chat delivery is shutting down",
          checkpoint: client.lastAckedOffset,
        });
      }
    }
  }

  return { close, handleApi };
}

function parseResumeCheckpoint(request, url) {
  const queryOffsets = url.searchParams.getAll("offset");
  if (queryOffsets.length > 1) {
    throw new LiveChatDeliveryError(
      LIVE_CHAT_ERROR_CODES.CHECKPOINT_CONFLICT,
      "live chat supplied more than one offset checkpoint",
      { statusCode: 400 },
    );
  }

  const queryOffset = queryOffsets[0] ?? null;
  const headerOffset =
    request.headers?.["last-event-id"] ??
    request.headers?.["Last-Event-ID"] ??
    null;
  if (
    queryOffset !== null &&
    headerOffset !== null &&
    queryOffset !== headerOffset
  ) {
    throw new LiveChatDeliveryError(
      LIVE_CHAT_ERROR_CODES.CHECKPOINT_CONFLICT,
      "live chat offset and Last-Event-ID checkpoints differ",
      { statusCode: 409 },
    );
  }
  return validateLiveCheckpoint(
    queryOffset ?? headerOffset ?? INITIAL_CHECKPOINT,
  );
}

function idempotencyKey(request) {
  return typeof request.headers["idempotency-key"] === "string"
    ? request.headers["idempotency-key"]
    : undefined;
}

function requestMetadata(request, url, { body, messageId, room } = {}) {
  return {
    ...(body === undefined ? {} : { body }),
    headers: request.headers,
    ...(messageId === undefined ? {} : { messageId }),
    path: request.url ?? url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    ...(room === undefined ? {} : { room }),
  };
}
