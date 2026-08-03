import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createChatHttpDelivery } from "@stream-slack/http";

import {
  bindWorkspaceRequest,
  createWorkspaceAuthorization,
  createWorkspaceFence,
  establishWorkspaceContext,
  WorkspaceAuthorizationError,
} from "../../src/ledger/workspace-auth.mjs";

const WORKSPACE_A = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const WORKSPACE_B = "ws_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const OWNER_A = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const NON_MEMBER_A = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_ffffffffffffffffffffffffff";
const SIBLING_PRINCIPAL =
  "pr_bbbbbbbbbbbbbbbbbbbbbbbbbb_cccccccccccccccccccccccccc";
const OWNER_MEMBERSHIP_A = {
  membershipId: "mb_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb",
  principalId: OWNER_A,
  role: "owner",
  status: "active",
  workspaceId: WORKSPACE_A,
};

test("live HTTP handlers recheck membership before every chat capability", async () => {
  const { delivery, calls } = createDelivery({ principalId: NON_MEMBER_A });

  for (const requestSpec of [
    { method: "GET", path: "/api/rooms/demo/messages" },
    {
      body: { text: "unauthorized" },
      method: "POST",
      path: "/api/rooms/demo/messages",
    },
    { method: "GET", path: "/api/rooms/demo/events" },
    { method: "DELETE", path: "/api/rooms/demo/messages" },
  ]) {
    const response = createFakeResponse();
    await assert.rejects(
      delivery.handleApi(
        createRequest(requestSpec),
        response,
        new URL(`http://app.test${requestSpec.path}`),
      ),
      genericWorkspaceRefusal,
    );
    assert.equal(response.writeHeadCalls, 0);
  }

  assert.deepEqual(calls, {
    append: 0,
    follow: 0,
    normalize: 4,
    read: 0,
    reset: 0,
    update: 0,
  });
  delivery.close();
});

test("live HTTP binding refuses sibling IDs, headers, streams, and body fields", async () => {
  const { delivery, calls } = createDelivery({ principalId: OWNER_A });
  const cases = [
    {
      label: "sibling principal in path",
      path: `/api/rooms/${SIBLING_PRINCIPAL}/messages`,
    },
    {
      headers: { "x-workspace-id": WORKSPACE_B },
      label: "sibling workspace header",
      path: "/api/rooms/demo/messages",
    },
    {
      body: { text: "no cross-tenant append", workspaceId: WORKSPACE_B },
      label: "sibling workspace body",
      method: "POST",
      path: "/api/rooms/demo/messages",
    },
    {
      body: {
        stream: `workspace:${WORKSPACE_B}/directory`,
        text: "no cross-tenant stream probe",
      },
      label: "sibling workspace stream",
      method: "POST",
      path: "/api/rooms/demo/messages",
    },
  ];

  for (const requestSpec of cases) {
    const response = createFakeResponse();
    await assert.rejects(
      delivery.handleApi(
        createRequest(requestSpec),
        response,
        new URL(`http://app.test${requestSpec.path}`),
      ),
      (error) =>
        genericWorkspaceRefusal(error) && !error.message.includes(WORKSPACE_B),
      requestSpec.label,
    );
  }

  assert.deepEqual(calls, {
    append: 0,
    follow: 0,
    normalize: 2,
    read: 0,
    reset: 0,
    update: 0,
  });
  delivery.close();
});

test("a current member reaches the read and mutation handlers after the fence", async () => {
  const { delivery, calls } = createDelivery({ principalId: OWNER_A });
  const readResponse = createFakeResponse();
  await delivery.handleApi(
    createRequest({ method: "GET", path: "/api/rooms/demo/messages" }),
    readResponse,
    new URL("http://app.test/api/rooms/demo/messages"),
  );
  assert.equal(readResponse.status, 200);

  const appendResponse = createFakeResponse();
  await delivery.handleApi(
    createRequest({
      body: { text: "authorized" },
      method: "POST",
      path: "/api/rooms/demo/messages",
    }),
    appendResponse,
    new URL("http://app.test/api/rooms/demo/messages"),
  );
  assert.equal(appendResponse.status, 201);
  assert.equal(calls.read, 1);
  assert.equal(calls.append, 1);
  delivery.close();
});

function createDelivery({ principalId }) {
  const calls = {
    append: 0,
    follow: 0,
    normalize: 0,
    read: 0,
    reset: 0,
    update: 0,
  };
  const memberships = new Map([
    [`${WORKSPACE_A}:${OWNER_A}`, OWNER_MEMBERSHIP_A],
  ]);
  const authorizationCore = createWorkspaceAuthorization({
    lookupMembership: async (workspaceId, lookupPrincipalId) =>
      memberships.get(`${workspaceId}:${lookupPrincipalId}`) ?? null,
    withWorkspaceFence: createWorkspaceFence(),
  });
  const workspaceAuthorization = {
    async contextForRequest({ request, url, user }) {
      const context = establishWorkspaceContext({
        authenticatedPrincipalId: user.sub,
        clientHost: request.headers.host,
        trustedHost: "app.test",
        trustedWorkspaceId: WORKSPACE_A,
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
    authorizeDispatch: authorizationCore.authorizeDispatch,
    authorizeRead: authorizationCore.authorizeRead,
    authorizeSubscription: authorizationCore.authorizeSubscription,
  };
  const delivery = createChatHttpDelivery({
    auth0Health: async () => true,
    auth0EmulatorUrl: "http://auth.test",
    chatService: {
      appendMessage: async () => {
        calls.append += 1;
        return {
          message: { id: "message-1", text: "authorized" },
          nextOffset: "offset-1",
        };
      },
      followMessages: async () => {
        calls.follow += 1;
        return { cancel() {}, closed: Promise.resolve() };
      },
      normalizeRoomId: (room) => {
        calls.normalize += 1;
        return room;
      },
      readMessages: async () => {
        calls.read += 1;
        return {
          messages: [],
          nextOffset: "offset-0",
          records: [],
          streamDigest:
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        };
      },
      resetRoom: async () => {
        calls.reset += 1;
        return { nextOffset: "offset-reset", streamDigest: "sha256:reset" };
      },
      updateMessage: async () => {
        calls.update += 1;
        return { message: { id: "message-1" }, nextOffset: "offset-1" };
      },
    },
    currentSession: () => ({ user: { sub: principalId } }),
    durableStreamsUrl: "http://streams.test",
    emptyDigest: "sha256:empty",
    sessionUser: () => ({ sub: principalId }),
    workspaceAuthorization,
  });
  return { calls, delivery };
}

function createRequest({ body = null, headers = {}, method = "GET", path }) {
  const request = new EventEmitter();
  request.headers = { host: "app.test", ...headers };
  request.method = method;
  request.url = path;
  request[Symbol.asyncIterator] = async function* () {
    if (body !== null) yield Buffer.from(JSON.stringify(body));
  };
  return request;
}

function createFakeResponse() {
  const response = new EventEmitter();
  response.destroyed = false;
  response.headersSent = false;
  response.output = [];
  response.writableEnded = false;
  response.writeHeadCalls = 0;
  response.writeHead = (status, headers) => {
    response.headersSent = true;
    response.status = status;
    response.headers = headers;
    response.writeHeadCalls += 1;
  };
  response.write = (value) => {
    response.output.push(String(value));
    return true;
  };
  response.end = (value) => {
    if (value !== undefined) response.output.push(String(value));
    response.writableEnded = true;
  };
  return response;
}

function genericWorkspaceRefusal(error) {
  return (
    error instanceof WorkspaceAuthorizationError &&
    error.code === "WORKSPACE_ACCESS_DENIED" &&
    error.statusCode === 404
  );
}
