import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createNodeDurableStreamsStore } from "@stream-slack/durable-streams";
import {
  createChatHttpDelivery,
  LIVE_CHAT_ERROR_CODES,
  sendError,
  sendJson,
} from "@stream-slack/http";
import { DEFAULT_CHAT_PATH } from "@stream-slack/protocol";
import { createChatService } from "@stream-slack/services";

import { createAuth0Client } from "./auth0-client.mjs";
import { createInboundHttpServer } from "./http-server.mjs";
import { canonicalSha256 } from "./ledger/canonical-json.mjs";
import { createDispatchDoor } from "./ledger/dispatch.mjs";
import {
  bindWorkspaceRequest,
  createWorkspaceAuthorization,
  createWorkspaceFence,
  establishWorkspaceContext,
} from "./ledger/workspace-auth.mjs";
import { createWorkspaceDirectoryAuthority } from "./ledger/workspace-directory.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");

const PORT = Number(process.env.PORT ?? 5175);
const HOST = process.env.HOST ?? "127.0.0.1";
const DURABLE_STREAMS_URL =
  process.env.DURABLE_STREAMS_URL ?? "http://127.0.0.1:4100";
const DURABLE_STREAMS_ADMIN_TOKEN =
  process.env.DURABLE_STREAMS_ADMIN_TOKEN ??
  process.env.EMULATE_TOKEN ??
  "test_token_admin";
const AUTH0_EMULATOR_URL =
  process.env.AUTH0_EMULATOR_URL ?? "http://127.0.0.1:4101";
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID ?? "slack-clone-auth0";
const AUTH0_CLIENT_SECRET =
  process.env.AUTH0_CLIENT_SECRET ?? "slack-clone-secret";
const AUTH0_REALM =
  process.env.AUTH0_REALM ?? "Username-Password-Authentication";
const SESSION_COOKIE = "slack_clone_session";
const CHAT_WORKSPACE_ID = "ws_00000000000000000000000000";
const CHAT_WORKSPACE_TOKEN = CHAT_WORKSPACE_ID.slice(3);
const CHAT_ADA_ID = `pr_${CHAT_WORKSPACE_TOKEN}_${"a".repeat(26)}`;
const CHAT_LINUS_ID = `pr_${CHAT_WORKSPACE_TOKEN}_${"b".repeat(26)}`;
const CHAT_DIRECTORY_INVITE_ID = `iv_${CHAT_WORKSPACE_TOKEN}_${"c".repeat(26)}`;
const CHAT_SUBJECT_AUDIENCE = "stream-slack";
const CHAT_SUBJECT_ISSUER = "auth0";
const TRUSTED_HOST = process.env.TRUSTED_HOST ?? `${HOST}:${PORT}`;

const CHAT_DIRECTORY_BOOTSTRAP = Object.freeze([
  workspaceBootstrapEvent("a", "principal.created", CHAT_ADA_ID, {
    kind: "human",
    ownedBy: null,
    principalId: CHAT_ADA_ID,
    profile: {
      displayName: "Ada Lovelace",
      email: "ada@example.test",
      handle: "ada",
    },
    subjectBinding: {
      audience: "stream-slack",
      issuer: "auth0",
      subject: "auth0|ada",
    },
  }),
  workspaceBootstrapEvent("b", "principal.created", CHAT_ADA_ID, {
    kind: "human",
    ownedBy: null,
    principalId: CHAT_LINUS_ID,
    profile: {
      displayName: "Linus Torvalds",
      email: "linus@example.test",
      handle: "linus",
    },
    subjectBinding: {
      audience: "stream-slack",
      issuer: "auth0",
      subject: "auth0|linus",
    },
  }),
  workspaceBootstrapEvent("c", "workspace.created", CHAT_ADA_ID, {
    displayName: "Stream Slack",
    ownerPrincipalId: CHAT_ADA_ID,
    workspaceId: CHAT_WORKSPACE_ID,
  }),
  workspaceBootstrapEvent("d", "workspace.membership.invited", CHAT_ADA_ID, {
    expectedWorkspaceRevision: 1,
    inviteId: CHAT_DIRECTORY_INVITE_ID,
    principalId: CHAT_LINUS_ID,
    role: "member",
  }),
  workspaceBootstrapEvent("e", "workspace.membership.accepted", CHAT_LINUS_ID, {
    expectedWorkspaceRevision: 2,
    inviteId: CHAT_DIRECTORY_INVITE_ID,
    principalId: CHAT_LINUS_ID,
  }),
]);

const sessions = new Map();
const auth0Client = createAuth0Client({
  baseUrl: AUTH0_EMULATOR_URL,
  clientId: AUTH0_CLIENT_ID,
  clientSecret: AUTH0_CLIENT_SECRET,
  realm: AUTH0_REALM,
  reservedOrigin: DURABLE_STREAMS_URL,
});

function parseCookies(request) {
  const header = request.headers.cookie ?? "";
  const cookies = new Map();
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    cookies.set(
      part.slice(0, index).trim(),
      decodeURIComponent(part.slice(index + 1).trim()),
    );
  }
  return cookies;
}

function currentSession(request) {
  const sessionId = parseCookies(request).get(SESSION_COOKIE);
  return sessionId ? (sessions.get(sessionId) ?? null) : null;
}

function sessionUser(request) {
  return currentSession(request)?.user ?? null;
}

function setSessionCookie(response, sessionId) {
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/`,
  );
}

function clearSessionCookie(response) {
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
  );
}

function redirect(response, location, statusCode = 302) {
  response.writeHead(statusCode, {
    Location: location,
    "Cache-Control": "no-store",
  });
  response.end();
}

function safeReturnTo(value) {
  if (!value || !value.startsWith("/")) return DEFAULT_CHAT_PATH;
  if (value.startsWith("//")) return DEFAULT_CHAT_PATH;
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

function renderLoginPage({ returnTo = DEFAULT_CHAT_PATH, error = "" } = {}) {
  const safePath = safeReturnTo(returnTo);
  const errorHtml = error
    ? `<div class="login__error" data-testid="login-error" role="alert">${escapeHtml(error)}</div>`
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
        <div class="login__error-slot" aria-live="polite">${errorHtml}</div>
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

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(html);
}

async function readForm(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

async function handleAuth(request, response, url) {
  if (url.pathname === "/login" && request.method === "GET") {
    sendHtml(
      response,
      200,
      renderLoginPage({ returnTo: url.searchParams.get("returnTo") ?? "/" }),
    );
    return true;
  }

  if (url.pathname === "/login" && request.method === "POST") {
    const form = await readForm(request);
    const returnTo = safeReturnTo(form.get("returnTo") ?? "/");
    try {
      const { user, token } = await auth0Client.exchangePassword(
        form.get("email") ?? "",
        form.get("password") ?? "",
      );
      const principal = await workspaceDirectory.lookupPrincipalBySubject(
        CHAT_WORKSPACE_ID,
        {
          audience: CHAT_SUBJECT_AUDIENCE,
          issuer: CHAT_SUBJECT_ISSUER,
          subject: user.sub,
        },
      );
      const principalId = principal?.principalId ?? null;
      if (!principalId) {
        throw new Error("authenticated user is not a workspace member");
      }
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, {
        authenticatedSubject: user.sub,
        user: { ...user, sub: principalId },
        accessToken: token.access_token,
        createdAt: Date.now(),
      });
      setSessionCookie(response, sessionId);
      redirect(response, returnTo);
    } catch (error) {
      sendHtml(
        response,
        200,
        renderLoginPage({
          returnTo,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return true;
  }

  if (url.pathname === "/logout") {
    const sessionId = parseCookies(request).get(SESSION_COOKIE);
    if (sessionId) sessions.delete(sessionId);
    clearSessionCookie(response);
    redirect(response, "/login");
    return true;
  }
  return false;
}

const streamStore = createNodeDurableStreamsStore({
  baseUrl: DURABLE_STREAMS_URL,
  token: DURABLE_STREAMS_ADMIN_TOKEN,
  digestRecords: canonicalSha256,
});
const workspaceDirectory = createWorkspaceDirectoryAuthority({
  bootstrapEvents: CHAT_DIRECTORY_BOOTSTRAP,
  streamStore,
  workspaceId: CHAT_WORKSPACE_ID,
});
const workspaceAuthorizationCore = createWorkspaceAuthorization({
  lookupMembership: workspaceDirectory.lookupMembership,
  withWorkspaceFence: createWorkspaceFence(),
});
const workspaceAuthorization = Object.freeze({
  async contextForRequest({ request, url, user }) {
    const context = establishWorkspaceContext({
      authenticatedPrincipalId: user?.sub,
      clientHost: request.headers.host,
      trustedHost: TRUSTED_HOST,
      trustedWorkspaceId: CHAT_WORKSPACE_ID,
    });
    bindWorkspaceRequest(
      {
        headers: request.headers,
        path: request.url ?? url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
      },
      context.workspaceId,
    );
    return context;
  },
  authorizeDispatch: workspaceAuthorizationCore.authorizeDispatch,
  authorizeRead: workspaceAuthorizationCore.authorizeRead,
  authorizeSubscription: workspaceAuthorizationCore.authorizeSubscription,
});
const dispatchDoor = createDispatchDoor({
  authorize: ({ actorId }) =>
    [...sessions.values()].some((session) => session.user.sub === actorId),
  producerEpoch: 0,
  producerId: `slack-clone-${crypto.randomUUID()}`,
  streamStore,
});
const chatService = createChatService({
  dispatch: dispatchDoor.dispatch,
  streamStore,
  randomId: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
  workspaceId: CHAT_WORKSPACE_ID,
});
const chatHttp = createChatHttpDelivery({
  auth0Health: auth0Client.health,
  auth0EmulatorUrl: AUTH0_EMULATOR_URL,
  chatService,
  currentSession,
  durableStreamsUrl: DURABLE_STREAMS_URL,
  emptyDigest: canonicalSha256([]),
  revalidateSubscription: async ({ context, room }) => {
    await workspaceAuthorization.authorizeRead(context, {
      capability: "workspace.subscribe",
    });
    const status = await chatService.readRoomStatus(room);
    if (status.archived) {
      return {
        code: LIVE_CHAT_ERROR_CODES.CHANNEL_ARCHIVED,
        detail: "live chat channel is archived",
        ok: false,
        statusCode: 409,
      };
    }
    return true;
  },
  sessionUser,
  workspaceAuthorization,
});

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function hasChatQuery(url) {
  return (
    url.searchParams.has("room") ||
    url.searchParams.has("autopilot") ||
    url.searchParams.has("persona")
  );
}

function isChatRequest(url) {
  return (
    url.pathname === "/app" ||
    url.pathname === "/app/" ||
    url.pathname === "/app.html" ||
    (url.pathname === "/" && hasChatQuery(url))
  );
}

function isPublicPage(url) {
  return url.pathname === "/" && !isChatRequest(url);
}

function routeToStaticPath(url) {
  if (isChatRequest(url)) return "/app.html";
  if (url.pathname === "/") return "/index.html";
  return url.pathname;
}

async function serveStatic(request, response, url) {
  const pathname = routeToStaticPath(url);
  const filePath = path.join(
    publicDir,
    path.normalize(pathname).replace(/^(\.\.[/\\])+/, ""),
  );
  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    const extension = path.extname(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypes.get(extension) ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    const fallback = await readFile(
      path.join(publicDir, isChatRequest(url) ? "app.html" : "index.html"),
      "utf8",
    );
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(fallback);
  }
}

const server = createInboundHttpServer(async (request, response) => {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? `${HOST}:${PORT}`}`,
  );
  try {
    if (await handleAuth(request, response, url)) return;
    if (url.pathname.startsWith("/api/")) {
      const handled = await chatHttp.handleApi(request, response, url);
      if (!handled) sendJson(response, 404, { ok: false, error: "Not found" });
      return;
    }

    const isPublicAsset =
      url.pathname === "/styles.css" || url.pathname === "/app.js";
    if (!isPublicAsset && !isPublicPage(url) && !currentSession(request)) {
      redirect(
        response,
        `/login?returnTo=${encodeURIComponent(`${url.pathname}${url.search}`)}`,
      );
      return;
    }
    await serveStatic(request, response, url);
  } catch (error) {
    sendError(response, error);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`slack-clone listening on http://${HOST}:${PORT}`);
  console.log(`using durable streams at ${DURABLE_STREAMS_URL}`);
});

function shutdown() {
  chatHttp.close();
  dispatchDoor.close();
  chatService.closeStreams();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function workspaceBootstrapEvent(token, eventType, actorId, data) {
  return {
    actorId,
    causation: null,
    correlationId: `cr_${CHAT_WORKSPACE_TOKEN}`,
    data,
    eventId: `ev_${token.repeat(26)}`,
    eventType,
    idempotencyKey: `ik_${token.repeat(26)}`,
    schemaVersion: 1,
    serverTimestamp: "2026-08-02T00:00:00.000Z",
    workspaceId: CHAT_WORKSPACE_ID,
  };
}
