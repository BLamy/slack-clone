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
      readMessages: async (_room, offset) => ({
        records: offset === "offset-1" ? [] : [],
        messages: [],
        nextOffset: offset === "-1" ? "offset-0" : offset,
        streamDigest: EMPTY_DIGEST,
      }),
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
    currentSession: () => ({ user: { sub: "ada" } }),
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
    async open(offset = null) {
      return this.openWithResponse(createResponse(), offset);
    },
    async openWithResponse(response, offset = null) {
      const suffix =
        offset === null ? "" : `?offset=${encodeURIComponent(offset)}`;
      const request = createRequest({ url: `/api/rooms/demo/events${suffix}` });
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

function createResponse({ writeResult = true } = {}) {
  const response = new EventEmitter();
  response.destroyed = false;
  response.headersSent = false;
  response.output = [];
  response.status = null;
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
    return writeResult;
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
