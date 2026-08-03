import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createChatHttpDelivery,
  LIVE_CHAT_ERROR_CODES,
} from "@stream-slack/http";

const EMPTY_DIGEST = "sha256:empty";

test("live chat gives each client an independent resumable follow", async () => {
  const harness = createHarness();
  const first = await harness.open();
  const second = await harness.open();

  assert.deepEqual(harness.followOffsets, ["offset-0", "offset-0"]);
  assert.deepEqual(eventNames(first.response), ["snapshot"]);
  assert.deepEqual(eventNames(second.response), ["snapshot"]);

  await harness.followers[0].onBatch({
    nextOffset: "offset-1",
    records: [{ id: "one", text: "one" }],
    upToDate: false,
    streamClosed: false,
  });
  await harness.followers[1].onBatch({
    nextOffset: "offset-1",
    records: [{ id: "one", text: "one" }],
    upToDate: false,
    streamClosed: false,
  });

  assert.deepEqual(
    eventNames(first.response).filter((name) => name === "message"),
    ["message"],
  );
  assert.equal(lastEventId(first.response), "offset-1");
  assert.equal(lastEventId(second.response), "offset-1");

  first.response.emit("close");
  await eventually(() => harness.cancelCalls === 1);

  const resumed = await harness.open("offset-1");
  assert.equal(harness.followOffsets.at(-1), "offset-1");
  assert.deepEqual(eventNames(resumed.response), ["resume", "status"]);

  await harness.followers.at(-1).onBatch({
    nextOffset: "offset-2",
    records: [{ id: "two", text: "two" }],
    upToDate: false,
    streamClosed: false,
  });
  assert.deepEqual(
    eventNames(resumed.response).filter((name) => name === "message"),
    ["message"],
  );
  assert.equal(lastEventId(resumed.response), "offset-2");
  assert.equal(eventData(resumed.response, "message").at(-1).id, "two");
  harness.delivery.close();
});

test("live chat rejects conflicting and malformed opaque checkpoints", async () => {
  const harness = createHarness();
  for (const [url, expectedCode] of [
    ["?offset=one&offset=two", LIVE_CHAT_ERROR_CODES.CHECKPOINT_CONFLICT],
    ["?offset=one", LIVE_CHAT_ERROR_CODES.CHECKPOINT_CONFLICT],
    ["?offset=%00", LIVE_CHAT_ERROR_CODES.CHECKPOINT_INVALID],
  ]) {
    const request = createRequest({
      headers: url === "?offset=one" ? { "last-event-id": "two" } : {},
      url: `/api/rooms/demo/events${url}`,
    });
    const response = createResponse();
    await harness.delivery.handleApi(
      request,
      response,
      new URL(`http://app.test${request.url}`),
    );
    assert.equal(
      response.status,
      expectedCode === LIVE_CHAT_ERROR_CODES.CHECKPOINT_CONFLICT &&
        url === "?offset=one"
        ? 409
        : 400,
    );
    assert.equal(JSON.parse(response.output.at(-1)).code, expectedCode);
  }
  harness.delivery.close();
});

test("live chat types provider-rejected stale checkpoints without leaking records", async () => {
  const harness = createHarness({
    readMessages: async (room, offset) => {
      if (room === "channel-b" && offset === "channel-a-head") {
        throw new Error(
          "Durable Streams rejected a checkpoint from another channel",
        );
      }
      return {
        messages: [],
        nextOffset: offset === "-1" ? "offset-0" : offset,
        records: [],
        streamDigest: EMPTY_DIGEST,
      };
    },
  });
  const request = createRequest({
    url: "/api/rooms/channel-b/events?offset=channel-a-head",
  });
  const response = createResponse();

  await assert.rejects(
    harness.delivery.handleApi(
      request,
      response,
      new URL(`http://app.test${request.url}`),
    ),
    (error) =>
      error.code === LIVE_CHAT_ERROR_CODES.CHECKPOINT_INVALID &&
      error.statusCode === 409,
  );
  assert.equal(response.writeHeadCalls, 0);
  assert.equal(response.output.length, 0);
  harness.delivery.close();
});

test("live chat revalidates membership before delivery and heartbeat", async () => {
  let allowed = true;
  const timers = createTimers();
  const harness = createHarness({
    revalidateSubscription: async () => allowed,
    timers,
  });
  const client = await harness.open();
  allowed = false;

  await harness.followers[0].onBatch({
    nextOffset: "offset-1",
    records: [{ id: "blocked", text: "must not leak" }],
    upToDate: false,
    streamClosed: false,
  });
  await eventually(() => client.response.writableEnded);
  assert.equal(eventData(client.response, "message").length, 0);
  assert.equal(
    eventData(client.response, "terminal").at(-1).code,
    LIVE_CHAT_ERROR_CODES.AUTHORIZATION_REVOKED,
  );

  allowed = true;
  const second = await harness.open();
  allowed = false;
  timers.runIntervals();
  await eventually(() => second.response.writableEnded);
  assert.equal(
    eventData(second.response, "terminal").at(-1).code,
    LIVE_CHAT_ERROR_CODES.AUTHORIZATION_REVOKED,
  );
  harness.delivery.close();
});

test("live chat terminates at the acknowledged checkpoint when a channel is archived", async () => {
  let archived = false;
  const harness = createHarness({
    revalidateSubscription: async ({ room }) =>
      archived
        ? {
            code: LIVE_CHAT_ERROR_CODES.CHANNEL_ARCHIVED,
            detail: `${room} is archived`,
            ok: false,
            statusCode: 409,
          }
        : true,
  });
  const client = await harness.open(null, "archived-channel");
  archived = true;

  await harness.followers[0].onBatch({
    nextOffset: "offset-archived",
    records: [{ id: "archived-leak", text: "must not leak" }],
    upToDate: false,
    streamClosed: false,
  });
  await eventually(() => client.response.writableEnded);
  assert.equal(eventData(client.response, "message").length, 0);
  const terminal = eventData(client.response, "terminal").at(-1);
  assert.equal(terminal.code, LIVE_CHAT_ERROR_CODES.CHANNEL_ARCHIVED);
  assert.equal(terminal.action, "close");
  assert.equal(terminal.nextOffset, "offset-0");
  harness.delivery.close();
});

test("live chat preserves a typed session-revocation terminal on queued delivery", async () => {
  let sessionActive = true;
  const harness = createHarness({
    currentSession: () => (sessionActive ? { user: { sub: "ada" } } : null),
  });
  const client = await harness.open();
  sessionActive = false;

  await harness.followers[0].onBatch({
    nextOffset: "offset-1",
    records: [{ id: "logout-leak", text: "must not leak after logout" }],
    upToDate: false,
    streamClosed: false,
  });
  await eventually(() => client.response.writableEnded);
  assert.equal(eventData(client.response, "message").length, 0);
  assert.equal(
    eventData(client.response, "terminal").at(-1).code,
    LIVE_CHAT_ERROR_CODES.SESSION_REVOKED,
  );
  harness.delivery.close();
});

test("a slow reader on one channel cannot block a live reader on another", async () => {
  const timers = createTimers();
  const harness = createHarness({ timers });
  const slow = await harness.openWithResponse(
    createResponse(),
    null,
    "channel-hot",
  );
  slow.response.writeResult = false;
  const idle = await harness.openWithResponse(
    createResponse(),
    null,
    "channel-idle",
  );

  const slowDelivery = harness.followers[0].onBatch({
    nextOffset: "hot-offset-1",
    records: [{ id: "hot", text: "flooded" }],
    upToDate: false,
    streamClosed: false,
  });
  await harness.followers[1].onBatch({
    nextOffset: "idle-offset-1",
    records: [{ id: "idle", text: "still live" }],
    upToDate: false,
    streamClosed: false,
  });
  assert.deepEqual(eventData(idle.response, "message"), [
    { id: "idle", text: "still live" },
  ]);
  assert.equal(idle.response.writableEnded, false);
  assert.equal(slow.response.writableEnded, false);

  timers.runTimeouts();
  await eventually(() => timers.pendingTimeouts.length > 0);
  timers.runTimeouts();
  await slowDelivery;
  assert.equal(
    eventData(slow.response, "terminal").at(-1).code,
    LIVE_CHAT_ERROR_CODES.BACKPRESSURE_TIMEOUT,
  );
  harness.delivery.close();
});

test("disconnect after message write but before status ack preserves the prior checkpoint", async () => {
  let response;
  response = createResponse({
    onWrite: (value) => {
      if (value.includes("event: message\n")) response.emit("close");
    },
  });
  const harness = createHarness();
  await harness.openWithResponse(response);

  await harness.followers[0].onBatch({
    nextOffset: "offset-1",
    records: [{ id: "mid-event", text: "connection closes before ack" }],
    upToDate: false,
    streamClosed: false,
  });
  await eventually(() => harness.cancelCalls === 1);
  assert.equal(lastEventId(response), "offset-0");
  assert.equal(eventData(response, "status").length, 0);
  harness.delivery.close();
});

test("disconnect during heartbeat cancels the client without a terminal write", async () => {
  const timers = createTimers();
  const harness = createHarness({ timers });
  const client = await harness.open();
  client.response.emit("close");
  timers.runIntervals();
  await eventually(() => harness.cancelCalls === 1);
  assert.equal(eventData(client.response, "terminal").length, 0);
  assert.equal(client.response.output.join("").includes(": keep-alive"), false);
  harness.delivery.close();
});

test("live chat emits a typed terminal event for an undraining reader", async () => {
  const timers = createTimers();
  const harness = createHarness({ timers });
  const response = createResponse({ writeResult: false });
  const handling = harness.openWithResponse(response);
  await eventually(() => timers.pendingTimeouts.length > 0);
  timers.runTimeouts();
  await eventually(() => timers.pendingTimeouts.length > 0);
  timers.runTimeouts();
  await handling;
  await eventually(() => response.writableEnded);
  assert.equal(
    eventData(response, "terminal").at(-1).code,
    LIVE_CHAT_ERROR_CODES.BACKPRESSURE_TIMEOUT,
  );
  assert.equal(eventData(response, "terminal").at(-1).action, "resync");
  harness.delivery.close();
});

test("live chat close terminates every client without a second response", async () => {
  const harness = createHarness();
  const first = await harness.open();
  const second = await harness.open();
  harness.delivery.close();
  await eventually(
    () => first.response.writableEnded && second.response.writableEnded,
  );
  assert.deepEqual(
    [first.response, second.response].map(
      (response) => eventData(response, "terminal").at(-1).code,
    ),
    [
      LIVE_CHAT_ERROR_CODES.SERVER_SHUTDOWN,
      LIVE_CHAT_ERROR_CODES.SERVER_SHUTDOWN,
    ],
  );
  assert.equal(first.response.writeHeadCalls, 1);
  assert.equal(second.response.writeHeadCalls, 1);
});

function createHarness({
  currentSession = () => ({ user: { sub: "ada" } }),
  readMessages = async (_room, offset) => ({
    records: offset === "offset-1" ? [] : [],
    messages: [],
    nextOffset: offset === "-1" ? "offset-0" : offset,
    streamDigest: EMPTY_DIGEST,
  }),
  revalidateSubscription = null,
  timers = createTimers(),
} = {}) {
  const followers = [];
  const followOffsets = [];
  let cancelCalls = 0;
  const delivery = createChatHttpDelivery({
    auth0Health: async () => true,
    auth0EmulatorUrl: "http://auth.test",
    chatService: {
      normalizeRoomId: (room) => room,
      readMessages,
      followMessages: async (_room, offset, options) => {
        followOffsets.push(offset);
        const follower = {
          cancel() {
            cancelCalls += 1;
          },
          closed: new Promise(() => {}),
          onBatch: options.onBatch,
        };
        followers.push(follower);
        return follower;
      },
    },
    currentSession,
    durableStreamsUrl: "http://streams.test",
    emptyDigest: EMPTY_DIGEST,
    revalidateSubscription: revalidateSubscription ?? undefined,
    sessionUser: () => ({ sub: "ada" }),
    timers,
  });
  return {
    get cancelCalls() {
      return cancelCalls;
    },
    delivery,
    followOffsets,
    followers,
    async open(offset = null, room = "demo") {
      return this.openWithResponse(createResponse(), offset, room);
    },
    async openWithResponse(response, offset = null, room = "demo") {
      const suffix =
        offset === null ? "" : `?offset=${encodeURIComponent(offset)}`;
      const request = createRequest({
        url: `/api/rooms/${encodeURIComponent(room)}/events${suffix}`,
      });
      await delivery.handleApi(
        request,
        response,
        new URL(`http://app.test${request.url}`),
      );
      await settleMicrotasks();
      return { request, response };
    },
  };
}

function createRequest({ headers = {}, url }) {
  const request = new EventEmitter();
  request.headers = { host: "app.test", ...headers };
  request.method = "GET";
  request.url = url;
  return request;
}

function createResponse({ onWrite = null, writeResult = true } = {}) {
  const response = new EventEmitter();
  response.destroyed = false;
  response.headersSent = false;
  response.output = [];
  response.status = null;
  response.writeResult = writeResult;
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
    onWrite?.(String(value));
    return response.writeResult;
  };
  response.end = (value) => {
    if (value !== undefined) response.output.push(String(value));
    response.writableEnded = true;
  };
  return response;
}

function createTimers() {
  const intervals = new Set();
  const pendingTimeouts = [];
  return {
    pendingTimeouts,
    setInterval(callback) {
      const handle = { callback };
      intervals.add(handle);
      return handle;
    },
    clearInterval(handle) {
      intervals.delete(handle);
    },
    setTimeout(callback) {
      const handle = { callback };
      pendingTimeouts.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      const index = pendingTimeouts.indexOf(handle);
      if (index !== -1) pendingTimeouts.splice(index, 1);
    },
    runIntervals() {
      for (const { callback } of [...intervals]) callback();
    },
    runTimeouts() {
      for (const { callback } of [...pendingTimeouts]) callback();
      pendingTimeouts.length = 0;
    },
  };
}

function eventNames(response) {
  return response.output
    .join("")
    .split("event: ")
    .slice(1)
    .map((entry) => entry.split("\n", 1)[0]);
}

function eventData(response, name) {
  return response.output
    .join("")
    .split("\n\n")
    .filter((frame) => frame.includes(`event: ${name}\n`))
    .map((frame) => JSON.parse(frame.split("data: ", 2)[1]));
}

function lastEventId(response) {
  const frames = response.output.join("").split("\n\n");
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const match = frames[index].match(/^id: ([^\n]+)/mu);
    if (match) return match[1];
  }
  return null;
}

async function eventually(predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  assert.fail("condition did not become true");
}

async function settleMicrotasks() {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}
