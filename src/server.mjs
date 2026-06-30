import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");

const PORT = Number(process.env.PORT ?? 5175);
const HOST = process.env.HOST ?? "127.0.0.1";
const DURABLE_STREAMS_URL = process.env.DURABLE_STREAMS_URL ?? "http://127.0.0.1:4100";
const EMULATE_TOKEN = process.env.EMULATE_TOKEN ?? "test_token_admin";
const ZERO_OFFSET = "0000000000000000_0000000000000000";

const rooms = new Map();

function authHeaders(contentType) {
  return {
    Authorization: `Bearer ${EMULATE_TOKEN}`,
    ...(contentType ? { "Content-Type": contentType } : {}),
  };
}

function normalizeRoomId(roomId) {
  const normalized = roomId.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "durable-streams-demo";
}

function streamUrl(roomId, query = "") {
  const room = encodeURIComponent(normalizeRoomId(roomId));
  return `${DURABLE_STREAMS_URL}/rooms/${room}/messages${query}`;
}

async function ensureStream(roomId) {
  const res = await fetch(streamUrl(roomId), {
    method: "PUT",
    headers: authHeaders("application/json"),
    body: "[]",
  });

  if (res.status === 200 || res.status === 201) return;

  const text = await res.text();
  throw new Error(`Failed to create durable stream for ${roomId}: ${res.status} ${text}`);
}

async function deleteStream(roomId) {
  const res = await fetch(streamUrl(roomId), {
    method: "DELETE",
    headers: authHeaders(),
  });

  if (res.status === 204 || res.status === 404) return;

  const text = await res.text();
  throw new Error(`Failed to delete durable stream for ${roomId}: ${res.status} ${text}`);
}

async function readMessages(roomId, offset = "-1") {
  await ensureStream(roomId);
  const res = await fetch(streamUrl(roomId, `?offset=${encodeURIComponent(offset)}`), {
    method: "GET",
    headers: authHeaders(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to read durable stream for ${roomId}: ${res.status} ${text}`);
  }

  const nextOffset = res.headers.get("Stream-Next-Offset") ?? ZERO_OFFSET;
  const messages = await res.json();
  return { messages: Array.isArray(messages) ? messages : [], nextOffset };
}

async function appendMessage(roomId, input) {
  await ensureStream(roomId);

  const message = {
    id: crypto.randomUUID(),
    room: normalizeRoomId(roomId),
    user: String(input.user ?? "visitor").slice(0, 40),
    text: String(input.text ?? "").trim().slice(0, 2000),
    createdAt: new Date().toISOString(),
  };

  if (!message.text) {
    const err = new Error("Message text is required");
    err.statusCode = 400;
    throw err;
  }

  const res = await fetch(streamUrl(roomId), {
    method: "POST",
    headers: authHeaders("application/json"),
    body: JSON.stringify(message),
  });

  if (res.status === 200 || res.status === 204) {
    return { message, nextOffset: res.headers.get("Stream-Next-Offset") ?? ZERO_OFFSET };
  }

  const text = await res.text();
  throw new Error(`Failed to append message to durable stream for ${roomId}: ${res.status} ${text}`);
}

function roomState(roomId) {
  const room = normalizeRoomId(roomId);
  let state = rooms.get(room);
  if (!state) {
    state = {
      room,
      clients: new Set(),
      nextOffset: null,
      timer: null,
      polling: false,
    };
    rooms.set(room, state);
  }
  return state;
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(state, event, data) {
  for (const client of state.clients) {
    writeSse(client, event, data);
  }
}

async function pollRoom(state) {
  if (state.polling) return;
  state.polling = true;

  try {
    if (state.nextOffset === null) {
      const initial = await readMessages(state.room, "now");
      state.nextOffset = initial.nextOffset;
    }

    const result = await readMessages(state.room, state.nextOffset);
    state.nextOffset = result.nextOffset;

    for (const message of result.messages) {
      broadcast(state, "message", message);
    }

    broadcast(state, "status", {
      durableStreamsUrl: DURABLE_STREAMS_URL,
      stream: `/rooms/${state.room}/messages`,
      nextOffset: state.nextOffset,
      clients: state.clients.size,
    });
  } catch (err) {
    broadcast(state, "error", {
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    state.polling = false;
    if (state.clients.size > 0) {
      state.timer = setTimeout(() => {
        void pollRoom(state);
      }, 350);
    } else {
      state.timer = null;
      state.nextOffset = null;
    }
  }
}

function startPolling(state) {
  if (!state.timer && !state.polling) {
    void pollRoom(state);
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text);
}

function sendJson(res, statusCode, value) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function sendError(res, err) {
  const statusCode = Number(err?.statusCode ?? 500);
  sendJson(res, statusCode, {
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  });
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/health") {
    await ensureStream("healthcheck");
    sendJson(res, 200, {
      ok: true,
      app: "slack-clone",
      durableStreamsUrl: DURABLE_STREAMS_URL,
    });
    return true;
  }

  const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(messages|events)$/);
  if (!match) return false;

  const room = normalizeRoomId(decodeURIComponent(match[1]));
  const resource = match[2];

  if (resource === "events" && req.method === "GET") {
    const state = roomState(room);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    state.clients.add(res);
    const snapshot = await readMessages(room, "-1");
    writeSse(res, "snapshot", {
      messages: snapshot.messages,
      durableStreamsUrl: DURABLE_STREAMS_URL,
      stream: `/rooms/${room}/messages`,
      nextOffset: snapshot.nextOffset,
    });
    if (state.nextOffset === null) {
      state.nextOffset = snapshot.nextOffset;
    }
    startPolling(state);

    const keepAlive = setInterval(() => {
      res.write(": keep-alive\n\n");
    }, 10000);

    req.on("close", () => {
      clearInterval(keepAlive);
      state.clients.delete(res);
    });
    return true;
  }

  if (resource === "messages" && req.method === "GET") {
    const result = await readMessages(room, "-1");
    sendJson(res, 200, {
      ok: true,
      room,
      stream: `/rooms/${room}/messages`,
      durableStreamsUrl: DURABLE_STREAMS_URL,
      nextOffset: result.nextOffset,
      messages: result.messages,
    });
    return true;
  }

  if (resource === "messages" && req.method === "POST") {
    const body = await readJson(req);
    const result = await appendMessage(room, body);
    sendJson(res, 201, {
      ok: true,
      room,
      message: result.message,
      nextOffset: result.nextOffset,
    });
    return true;
  }

  if (resource === "messages" && req.method === "DELETE") {
    await deleteStream(room);
    await ensureStream(room);
    const state = roomState(room);
    state.nextOffset = null;
    broadcast(state, "reset", { room });
    sendJson(res, 200, { ok: true, room });
    return true;
  }

  return false;
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

async function serveStatic(req, res, url) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.join(publicDir, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ""));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");

    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": contentTypes.get(ext) ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(filePath).pipe(res);
  } catch {
    const fallback = await readFile(path.join(publicDir, "index.html"), "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(fallback);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${PORT}`}`);

  try {
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url);
      if (!handled) sendJson(res, 404, { ok: false, error: "Not found" });
      return;
    }

    await serveStatic(req, res, url);
  } catch (err) {
    sendError(res, err);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`slack-clone listening on http://${HOST}:${PORT}`);
  console.log(`using durable streams at ${DURABLE_STREAMS_URL}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
