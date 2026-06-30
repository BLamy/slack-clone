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
const AUTH0_EMULATOR_URL = process.env.AUTH0_EMULATOR_URL ?? "http://127.0.0.1:4101";
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID ?? "slack-clone-auth0";
const AUTH0_CLIENT_SECRET = process.env.AUTH0_CLIENT_SECRET ?? "slack-clone-secret";
const AUTH0_REALM = process.env.AUTH0_REALM ?? "Username-Password-Authentication";
const ZERO_OFFSET = "0000000000000000_0000000000000000";

const rooms = new Map();
const sessions = new Map();
const SESSION_COOKIE = "slack_clone_session";

function authHeaders(contentType) {
  return {
    Authorization: `Bearer ${EMULATE_TOKEN}`,
    ...(contentType ? { "Content-Type": contentType } : {}),
  };
}

function parseCookies(req) {
  const header = req.headers.cookie ?? "";
  const cookies = new Map();
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    cookies.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return cookies;
}

function currentSession(req) {
  const sessionId = parseCookies(req).get(SESSION_COOKIE);
  return sessionId ? sessions.get(sessionId) ?? null : null;
}

function sessionUser(req) {
  return currentSession(req)?.user ?? null;
}

function setSessionCookie(res, sessionId) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function redirect(res, location, statusCode = 302) {
  res.writeHead(statusCode, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

function safeReturnTo(value) {
  if (!value || !value.startsWith("/")) return "/";
  if (value.startsWith("//")) return "/";
  return value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderLoginPage({ returnTo = "/", error = "" } = {}) {
  const safePath = safeReturnTo(returnTo);
  const errorHtml = error
    ? `<div class="login__error" data-testid="login-error">${escapeHtml(error)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sign in - Stream Slack</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body class="login-page">
    <main class="login">
      <section class="login__panel">
        <div class="workspace__mark login__mark">S</div>
        <h1>Sign in to Stream Slack</h1>
        <p>Credentials are checked by the local Auth0 emulator at <span data-testid="auth0-emulator-url">${escapeHtml(AUTH0_EMULATOR_URL)}</span>.</p>
        ${errorHtml}
        <form class="login__form" method="post" action="/login" data-testid="login-form">
          <input type="hidden" name="returnTo" value="${escapeHtml(safePath)}" />
          <label>
            <span>Email</span>
            <input data-testid="email-input" name="email" autocomplete="username" value="ada@example.test" />
          </label>
          <label>
            <span>Password</span>
            <input data-testid="password-input" name="password" type="password" autocomplete="current-password" value="DemoPass123" />
          </label>
          <button data-testid="login-button" type="submit">Sign in with Auth0 emulator</button>
        </form>
        <div class="login__users">
          <span>Seeded users</span>
          <code>ada@example.test</code>
          <code>linus@example.test</code>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

async function readForm(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

async function exchangePassword(username, password) {
  const tokenRes = await fetch(`${AUTH0_EMULATOR_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "http://auth0.com/oauth/grant-type/password-realm",
      username,
      password,
      realm: AUTH0_REALM,
      scope: "openid profile email",
      client_id: AUTH0_CLIENT_ID,
      client_secret: AUTH0_CLIENT_SECRET,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.json().catch(async () => ({ error_description: await tokenRes.text() }));
    throw new Error(body.error_description ?? body.error ?? `Auth0 emulator token exchange failed: ${tokenRes.status}`);
  }

  const token = await tokenRes.json();
  const userInfoRes = await fetch(`${AUTH0_EMULATOR_URL}/userinfo`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });

  if (!userInfoRes.ok) {
    throw new Error(`Auth0 emulator userinfo failed: ${userInfoRes.status} ${await userInfoRes.text()}`);
  }

  const profile = await userInfoRes.json();
  return {
    token,
    user: {
      sub: profile.sub,
      name: profile.name ?? profile.email ?? "Authenticated User",
      email: profile.email ?? "",
      preferredUsername: profile.nickname ?? profile.email ?? "",
    },
  };
}

async function handleAuth(req, res, url) {
  if (url.pathname === "/login" && req.method === "GET") {
    sendHtml(res, 200, renderLoginPage({ returnTo: url.searchParams.get("returnTo") ?? "/" }));
    return true;
  }

  if (url.pathname === "/login" && req.method === "POST") {
    const form = await readForm(req);
    const returnTo = safeReturnTo(form.get("returnTo") ?? "/");
    try {
      const { user, token } = await exchangePassword(form.get("email") ?? "", form.get("password") ?? "");
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, {
        user,
        accessToken: token.access_token,
        createdAt: Date.now(),
      });
      setSessionCookie(res, sessionId);
      redirect(res, returnTo);
    } catch (err) {
      sendHtml(
        res,
        401,
        renderLoginPage({
          returnTo,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    return true;
  }

  if (url.pathname === "/logout") {
    const sessionId = parseCookies(req).get(SESSION_COOKIE);
    if (sessionId) sessions.delete(sessionId);
    clearSessionCookie(res);
    redirect(res, "/login");
    return true;
  }

  return false;
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

async function appendMessage(roomId, input, user) {
  await ensureStream(roomId);

  const message = {
    id: crypto.randomUUID(),
    room: normalizeRoomId(roomId),
    user: String(user.name ?? user.email ?? "authenticated user").slice(0, 80),
    email: String(user.email ?? ""),
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
    const authRes = await fetch(`${AUTH0_EMULATOR_URL}/.well-known/openid-configuration`);
    sendJson(res, 200, {
      ok: true,
      app: "slack-clone",
      durableStreamsUrl: DURABLE_STREAMS_URL,
      auth0EmulatorUrl: AUTH0_EMULATOR_URL,
      auth0: authRes.ok,
    });
    return true;
  }

  if (url.pathname === "/api/session") {
    const session = currentSession(req);
    if (!session) {
      sendJson(res, 401, { ok: false, error: "not_authenticated" });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      user: session.user,
      provider: {
        name: "Auth0 emulator",
        url: AUTH0_EMULATOR_URL,
      },
    });
    return true;
  }

  const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(messages|events)$/);
  if (!match) return false;

  const user = sessionUser(req);
  if (!user) {
    sendJson(res, 401, { ok: false, error: "not_authenticated" });
    return true;
  }

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
    const result = await appendMessage(room, body, user);
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
    if (await handleAuth(req, res, url)) return;

    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url);
      if (!handled) sendJson(res, 404, { ok: false, error: "Not found" });
      return;
    }

    const isPublicAsset = url.pathname === "/styles.css" || url.pathname === "/app.js";
    if (!isPublicAsset && !currentSession(req)) {
      redirect(res, `/login?returnTo=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
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
