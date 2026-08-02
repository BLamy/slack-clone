import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createDurableStreamsStore,
  DurableStreamsAdapterError,
} from "@stream-slack/durable-streams";
import { createChatHttpDelivery, sendError } from "@stream-slack/http";

import { analyzeDurableStreamsAccess } from "../../tools/audit-durable-streams-access.mjs";
import {
  assertIdleWindowRequestConstant,
  observeHttpIdleWindow,
} from "../support/http-idle-probe.mjs";

const ZERO = "opaque-checkpoint-zero";

test("official adapter creates once and preserves opaque checkpoints across bounded resume", async () => {
  const protocol = createProtocolDouble();
  const store = createStore(protocol.fetch);

  await Promise.all([store.ensure("Room One"), store.ensure("Room One")]);
  await store.ensure("Room One");
  assert.equal(
    protocol.requests.filter((request) => request.method === "PUT").length,
    1,
  );

  const first = await store.append("Room One", { id: "one", text: "first" });
  const second = await store.append("Room One", {
    id: "two",
    text: "second",
  });
  assert.equal(first.nextOffset, "opaque-checkpoint-1");
  assert.equal(second.nextOffset, "opaque-checkpoint-2");

  const all = await store.read("Room One", "-1");
  const afterFirst = await store.read("Room One", first.nextOffset);
  const afterSecond = await store.read("Room One", second.nextOffset);
  assert.deepEqual(
    all.records.map((record) => record.id),
    ["one", "two"],
  );
  assert.deepEqual(
    afterFirst.records.map((record) => record.id),
    ["two"],
  );
  assert.deepEqual(afterSecond.records, []);
  assert.equal(all.nextOffset, second.nextOffset);
  assert.equal(afterFirst.nextOffset, second.nextOffset);
  assert.equal(afterSecond.nextOffset, second.nextOffset);
  assert.equal(all.streamDigest, "digest:one,two");
  assert.equal(store.diagnostics().requestsByMethod.HEAD, 1);
  store.close();
});

test("official SSE follow stays request-constant while idle, wakes on append, and cancels cleanly", async () => {
  const protocol = createProtocolDouble();
  const store = createStore(protocol.fetch);
  await store.ensure("live-room");
  const batches = [];
  const follow = await store.follow("live-room", ZERO, {
    live: "sse",
    onBatch(batch) {
      batches.push(batch);
    },
  });

  await eventually(() => store.diagnostics().pendingIdleWaiters === 1);
  const idleRequestCount = protocol.requests.length;
  await settleMicrotasks();
  assert.equal(protocol.requests.length, idleRequestCount);
  assert.ok(store.diagnostics().sseRequests <= 2);
  assert.equal(store.diagnostics().longPollRequests, 0);

  const appended = await store.append("live-room", {
    id: "wake",
    text: "wakes the official reader",
  });
  await eventually(() =>
    batches.some((batch) =>
      batch.records.some((record) => record.id === "wake"),
    ),
  );
  const delivered = batches.flatMap((batch) => batch.records);
  assert.deepEqual(
    delivered.filter((record) => record.id === "wake"),
    [{ id: "wake", text: "wakes the official reader" }],
  );
  assert.equal(follow.currentOffset, appended.nextOffset);

  const secondAppend = await store.append("live-room", {
    id: "wake-again",
    text: "proves the same follow survives another finite SSE response",
  });
  await eventually(() =>
    batches.some((batch) =>
      batch.records.some((record) => record.id === "wake-again"),
    ),
  );
  assert.deepEqual(
    delivered
      .concat(batches.flatMap((batch) => batch.records))
      .filter((record) => record.id === "wake-again"),
    [
      {
        id: "wake-again",
        text: "proves the same follow survives another finite SSE response",
      },
    ],
  );
  assert.equal(follow.currentOffset, secondAppend.nextOffset);

  follow.cancel("test complete");
  await follow.closed;
  await eventually(() => store.diagnostics().activeFollowers === 0);
  assert.equal(store.diagnostics().pendingIdleWaiters, 0);
  const requestsAfterCancel = protocol.requests.length;
  await settleMicrotasks();
  assert.equal(protocol.requests.length, requestsAfterCancel);
  store.close();
});

test("HTTP delivery stays adapter-request constant across fifteen virtual idle minutes", async () => {
  const observation = await observeHttpIdleWindow();
  assertIdleWindowRequestConstant(observation);
  assert.equal(observation.callsBeforeLogicalAdvance, 2);
  assert.equal(observation.callsAfterLogicalAdvance, 2);
  assert.equal(observation.keepAliveTimerExecutions, 90);
});

test("idle request detector rejects a 350-millisecond polling positive control", async () => {
  const observation = await observeHttpIdleWindow({
    pollingMutationMs: 350,
  });
  assert.throws(
    () => assertIdleWindowRequestConstant(observation),
    /additional Durable Streams adapter calls/u,
  );
  assert.equal(observation.pollingTimerExecutions, 2_571);
  assert.equal(observation.callDeltaWhileIdle, 2_571);
});

test("adapter rejects malformed offsets, bodies, content types, and committed-stream appends", async (t) => {
  await t.test("missing checkpoint during create-once probe", async () => {
    const store = createStore(
      sequenceFetch([
        new Response(null, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ]),
    );
    await assert.rejects(
      store.ensure("bad-head-offset"),
      adapterError("INVALID_CHECKPOINT"),
    );
    store.close();
  });

  await t.test("missing checkpoint", async () => {
    const fetchFn = sequenceFetch([
      existsHead(),
      new Response("[]", {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Stream-Up-To-Date": "true",
        },
      }),
    ]);
    const store = createStore(fetchFn);
    await assert.rejects(
      store.read("bad-offset", "-1"),
      adapterError("INVALID_CHECKPOINT"),
    );
    store.close();
  });

  await t.test("wrong content type", async () => {
    const fetchFn = sequenceFetch([
      existsHead(),
      new Response("[]", {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
          "Stream-Next-Offset": ZERO,
          "Stream-Up-To-Date": "true",
        },
      }),
    ]);
    const store = createStore(fetchFn);
    await assert.rejects(
      store.read("bad-content-type", "-1"),
      adapterError("CONTENT_TYPE_MISMATCH"),
    );
    store.close();
  });

  await t.test("malformed JSON body", async () => {
    const fetchFn = sequenceFetch([
      existsHead(),
      jsonResponse("not-json", ZERO),
    ]);
    const store = createStore(fetchFn);
    await assert.rejects(
      store.read("bad-body", "-1"),
      adapterError("PARSE_ERROR"),
    );
    store.close();
  });

  await t.test("partial SSE frame", async () => {
    let liveRequests = 0;
    const fetchFn = async (input, init = {}) => {
      if (init.method === "HEAD") return existsHead();
      const url = new URL(String(input));
      if (url.searchParams.get("live") !== "sse") {
        return jsonResponse("[]", ZERO);
      }
      liveRequests += 1;
      return new Response('event: data\ndata: [{"id":"partial"}', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };
    const store = createStore(fetchFn, {
      initialDelay: 0,
      maxDelay: 0,
      multiplier: 1,
      maxRetries: 0,
    });
    const delivered = [];
    const follow = await store.follow("partial-frame", ZERO, {
      onBatch(batch) {
        delivered.push(...batch.records);
      },
    });
    await assert.rejects(follow.closed, adapterError("MALFORMED_SSE_FRAME"));
    assert.deepEqual(delivered, []);
    assert.ok(liveRequests <= 4);
    store.close();
  });

  await t.test("closed stream", async () => {
    const fetchFn = sequenceFetch([
      existsHead(),
      new Response("Stream is closed", {
        status: 409,
        headers: {
          "Stream-Closed": "true",
          "Stream-Next-Offset": "opaque-final",
        },
      }),
    ]);
    const store = createStore(fetchFn);
    await assert.rejects(
      store.append("closed-room", { id: "late" }),
      (error) =>
        error instanceof DurableStreamsAdapterError &&
        error.code === "STREAM_CLOSED" &&
        error.status === 409 &&
        error.finalOffset === "opaque-final",
    );
    store.close();
  });
});

test("official client honors bounded Retry-After recovery without hiding terminal failures", async () => {
  let getAttempts = 0;
  const fetchFn = async (_input, init = {}) => {
    if (init.method === "HEAD") return existsHead();
    getAttempts += 1;
    if (getAttempts === 1) {
      return new Response("busy", {
        status: 503,
        headers: { "Retry-After": "0" },
      });
    }
    return jsonResponse("[]", ZERO);
  };
  const store = createStore(fetchFn, {
    initialDelay: 0,
    maxDelay: 0,
    multiplier: 1,
    maxRetries: 1,
  });
  const result = await store.read("retry-room", "-1");
  assert.deepEqual(result.records, []);
  assert.equal(getAttempts, 2);
  assert.equal(store.diagnostics().responsesByStatus["503"], 1);
  store.close();
});

test("follow cancellation aborts an in-flight upstream body and releases every waiter", async () => {
  let upstreamAborted = false;
  let reads = 0;
  const fetchFn = async (_input, init = {}) => {
    if (init.method === "HEAD") return existsHead();
    reads += 1;
    if (reads === 1) return jsonResponse("[]", ZERO);
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        "abort",
        () => {
          upstreamAborted = true;
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
    });
  };
  const store = createStore(fetchFn);
  const follow = await store.follow("cancel-room", ZERO, {
    onBatch() {},
  });
  await eventually(() => reads === 2);
  follow.cancel("disconnect");
  await follow.closed;
  assert.equal(upstreamAborted, true);
  await eventually(() => store.diagnostics().activeFollowers === 0);
  assert.equal(store.diagnostics().pendingIdleWaiters, 0);
  store.close();
});

test("HTTP delivery never attempts a second JSON response after SSE headers commit", async () => {
  const timers = createFakeTimers();
  let cancelCalls = 0;
  const followClosed = new Promise(() => {});
  const chatService = {
    normalizeRoomId: (room) => room,
    ensureStream: async () => {},
    readMessages: async () => ({
      records: [],
      messages: [],
      nextOffset: ZERO,
      streamDigest: "digest:empty",
    }),
    followMessages: async () => ({
      cancel() {
        cancelCalls += 1;
      },
      closed: followClosed,
    }),
  };
  const delivery = createChatHttpDelivery({
    auth0EmulatorUrl: "http://auth.invalid",
    chatService,
    currentSession: () => ({ user: { sub: "ada" } }),
    durableStreamsUrl: "http://streams.invalid",
    emptyDigest: "digest:empty",
    fetchFn: async () => new Response(null, { status: 200 }),
    sessionUser: () => ({ sub: "ada" }),
    timers,
  });
  const request = new EventEmitter();
  request.method = "GET";
  const response = createFakeResponse();

  await delivery.handleApi(
    request,
    response,
    new URL("http://app.invalid/api/rooms/demo/events"),
  );
  await eventually(() => response.headersSent);
  const writesBeforeError = response.writeHeadCalls;
  assert.equal(sendError(response, new Error("late failure")), false);
  assert.equal(response.writeHeadCalls, writesBeforeError);
  assert.doesNotMatch(response.output.join(""), /late failure/u);

  response.emit("close");
  await eventually(() => cancelCalls === 1);
  assert.equal(timers.activeIntervals, 0);
  delivery.close();
});

test("a downstream disconnect before snapshot completion never commits SSE headers", async () => {
  let resolveSnapshot;
  let followCalls = 0;
  const snapshot = new Promise((resolve) => {
    resolveSnapshot = resolve;
  });
  const delivery = createChatHttpDelivery({
    auth0EmulatorUrl: "http://auth.invalid",
    chatService: {
      normalizeRoomId: (room) => room,
      readMessages: () => snapshot,
      followMessages: async () => {
        followCalls += 1;
        return { cancel() {}, closed: new Promise(() => {}) };
      },
    },
    currentSession: () => ({ user: { sub: "ada" } }),
    durableStreamsUrl: "http://streams.invalid",
    emptyDigest: "digest:empty",
    fetchFn: async () => new Response(null, { status: 200 }),
    sessionUser: () => ({ sub: "ada" }),
    timers: createFakeTimers(),
  });
  const request = new EventEmitter();
  request.method = "GET";
  const response = createFakeResponse();
  const handling = delivery.handleApi(
    request,
    response,
    new URL("http://app.invalid/api/rooms/demo/events"),
  );

  request.emit("aborted");
  resolveSnapshot({
    records: [],
    messages: [],
    nextOffset: ZERO,
    streamDigest: "digest:empty",
  });
  assert.equal(await handling, true);
  assert.equal(response.headersSent, false);
  assert.equal(response.writeHeadCalls, 0);
  assert.equal(followCalls, 0);
  delivery.close();
});

test("source guard rejects an adapter bypass while allowing the application API", () => {
  const bypass = analyzeDurableStreamsAccess(
    `
      const durableStreamsUrl = "http://streams.invalid";
      await fetch(\`${"${durableStreamsUrl}"}/rooms/demo/messages\`);
    `,
    "scratch-bypass.mjs",
  );
  assert.deepEqual(
    bypass.map((violation) => violation.kind),
    ["direct-provider-network"],
  );

  const aliasedBypass = analyzeDurableStreamsAccess(
    `
      export { DurableStream } from "@durable-streams/client";
      const send = globalThis.fetch;
      const streamOrigin = "http://streams.invalid";
      await send(\`${"${streamOrigin}"}/rooms/demo/messages\`);
    `,
    "scratch-aliased-bypass.mjs",
  );
  assert.deepEqual(
    aliasedBypass.map((violation) => violation.kind),
    ["official-client-import", "direct-provider-network"],
  );

  const applicationApi = analyzeDurableStreamsAccess(
    'await fetch("/api/rooms/demo/messages");',
    "browser-client.mjs",
  );
  assert.deepEqual(applicationApi, []);
});

function createStore(fetchFn, backoffOptions) {
  return createDurableStreamsStore({
    baseUrl: "http://streams.invalid",
    token: "server-only-canary",
    fetchFn,
    digestRecords: (records) =>
      `digest:${records.map((record) => record.id).join(",")}`,
    ...(backoffOptions ? { backoffOptions } : {}),
  });
}

function createProtocolDouble() {
  const requests = [];
  const records = [];
  let exists = false;
  let closed = false;
  const checkpoint = () =>
    records.length === 0 ? ZERO : `opaque-checkpoint-${records.length}`;
  const indexForOffset = (offset) => {
    if (offset === "-1") return 0;
    if (offset === ZERO) return 0;
    const match = /^opaque-checkpoint-(\d+)$/u.exec(offset);
    return match ? Number(match[1]) : records.length;
  };

  async function fetch(input, init = {}) {
    const url = new URL(String(input));
    const method = String(init.method ?? "GET").toUpperCase();
    requests.push({ method, url: url.toString(), headers: init.headers });
    if (method === "HEAD") {
      return exists
        ? existsHead(checkpoint())
        : new Response("not found", { status: 404 });
    }
    if (method === "PUT") {
      exists = true;
      return new Response(null, {
        status: 201,
        headers: streamHeaders(checkpoint()),
      });
    }
    if (method === "DELETE") {
      exists = false;
      records.length = 0;
      return new Response(null, { status: 204 });
    }
    if (method === "POST") {
      if (closed) {
        return new Response("closed", {
          status: 409,
          headers: {
            "Stream-Closed": "true",
            "Stream-Next-Offset": checkpoint(),
          },
        });
      }
      const items = JSON.parse(String(init.body));
      records.push(...items);
      return new Response(null, {
        status: 204,
        headers: { "Stream-Next-Offset": checkpoint() },
      });
    }
    const offset = url.searchParams.get("offset") ?? "-1";
    const items = records.slice(indexForOffset(offset));
    if (url.searchParams.get("live") === "sse") {
      return sseResponse(items, checkpoint());
    }
    return jsonResponse(JSON.stringify(items), checkpoint());
  }

  return { fetch, requests, records, close: () => (closed = true) };
}

function existsHead(offset = ZERO) {
  return new Response(null, {
    status: 200,
    headers: streamHeaders(offset),
  });
}

function jsonResponse(body, offset) {
  return new Response(body, {
    status: 200,
    headers: {
      ...streamHeaders(offset),
      "Stream-Up-To-Date": "true",
    },
  });
}

function sseResponse(items, offset) {
  const events = items.map(
    (item) => `event: data\ndata: ${JSON.stringify([item])}\n\n`,
  );
  events.push(
    `event: control\ndata: ${JSON.stringify({
      streamNextOffset: offset,
      streamCursor: `cursor-${offset}`,
      upToDate: true,
    })}\n\n`,
  );
  return new Response(events.join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function streamHeaders(offset) {
  return {
    "Content-Type": "application/json",
    "Stream-Next-Offset": offset,
  };
}

function sequenceFetch(responses) {
  return async () => {
    assert.ok(responses.length > 0, "protocol double ran out of responses");
    return responses.shift();
  };
}

function adapterError(code) {
  return (error) =>
    error instanceof DurableStreamsAdapterError && error.code === code;
}

async function eventually(predicate, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  assert.fail("condition did not become true");
}

async function settleMicrotasks() {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

function createFakeTimers() {
  const intervals = new Set();
  return {
    setInterval(callback) {
      const handle = { callback };
      intervals.add(handle);
      return handle;
    },
    clearInterval(handle) {
      intervals.delete(handle);
    },
    get activeIntervals() {
      return intervals.size;
    },
  };
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
