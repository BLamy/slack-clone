import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { createChatHttpDelivery } from "@stream-slack/http";

import {
  createDeterministicTimers,
  settleMicrotasks,
} from "./deterministic-timers.mjs";

const EMPTY_DIGEST = "sha256:idle-probe-empty";
const ZERO_OFFSET = "opaque-idle-probe-zero";

export async function observeHttpIdleWindow({
  durationMs = 15 * 60 * 1_000,
  pollingMutationMs = null,
} = {}) {
  const timers = createDeterministicTimers();
  let cancelCalls = 0;
  let followCalls = 0;
  let readCalls = 0;
  let pollingTimer = null;
  const followClosed = new Promise(() => {});
  const chatService = {
    normalizeRoomId: (room) => room,
    ensureStream: async () => {},
    readMessages: async () => {
      readCalls += 1;
      return {
        records: [],
        messages: [],
        nextOffset: ZERO_OFFSET,
        streamDigest: EMPTY_DIGEST,
      };
    },
    followMessages: async () => {
      followCalls += 1;
      return {
        cancel() {
          cancelCalls += 1;
        },
        closed: followClosed,
      };
    },
  };
  const delivery = createChatHttpDelivery({
    auth0EmulatorUrl: "http://auth.invalid",
    chatService,
    currentSession: () => ({ user: { sub: "idle-probe" } }),
    durableStreamsUrl: "http://streams.invalid",
    emptyDigest: EMPTY_DIGEST,
    fetchFn: async () => new Response(null, { status: 200 }),
    sessionUser: () => ({ sub: "idle-probe" }),
    timers,
  });
  const request = new EventEmitter();
  request.method = "GET";
  const response = createFakeResponse();

  await delivery.handleApi(
    request,
    response,
    new URL("http://app.invalid/api/rooms/idle-probe/events"),
  );
  await settleMicrotasks();
  assert.equal(response.headersSent, true);
  assert.equal(
    readCalls,
    1,
    "SSE setup must perform one bounded snapshot read",
  );
  assert.equal(followCalls, 1, "SSE setup must establish one upstream follow");

  const callsBeforeAdvance = readCalls + followCalls;
  const readsBeforeAdvance = readCalls;
  const followsBeforeAdvance = followCalls;

  if (pollingMutationMs !== null) {
    const poll = async () => {
      await chatService.readMessages("idle-probe", ZERO_OFFSET);
      pollingTimer = timers.setTimeout(() => void poll(), pollingMutationMs);
    };
    pollingTimer = timers.setTimeout(() => void poll(), pollingMutationMs);
  }

  const advance = await timers.advanceBy(durationMs);
  const callsAfterAdvance = readCalls + followCalls;
  const observation = {
    schemaVersion: 1,
    boundary: "HTTP delivery to Durable Streams adapter",
    logicalIdleDurationMs: advance.durationMs,
    timerFinishedAtMs: advance.finishedAtMs,
    callsBeforeLogicalAdvance: callsBeforeAdvance,
    callsAfterLogicalAdvance: callsAfterAdvance,
    callDeltaWhileIdle: callsAfterAdvance - callsBeforeAdvance,
    readCallsBeforeLogicalAdvance: readsBeforeAdvance,
    readCallsAfterLogicalAdvance: readCalls,
    followCallsBeforeLogicalAdvance: followsBeforeAdvance,
    followCallsAfterLogicalAdvance: followCalls,
    keepAliveTimerExecutions: timers.executionCount(10_000),
    pollingTimerExecutions:
      pollingMutationMs === null ? 0 : timers.executionCount(pollingMutationMs),
    pollingMutationMs,
  };

  if (pollingTimer) timers.clearTimeout(pollingTimer);
  response.emit("close");
  await settleMicrotasks();
  delivery.close();
  timers.dispose();
  assert.equal(cancelCalls, 1);
  return observation;
}

export function assertIdleWindowRequestConstant(observation) {
  assert.equal(
    observation.logicalIdleDurationMs,
    15 * 60 * 1_000,
    "idle detector must advance the system timer boundary by fifteen minutes",
  );
  assert.equal(
    observation.callDeltaWhileIdle,
    0,
    "idle HTTP delivery made additional Durable Streams adapter calls",
  );
  assert.equal(
    observation.readCallsAfterLogicalAdvance,
    observation.readCallsBeforeLogicalAdvance,
    "idle HTTP delivery resumed bounded reads instead of staying on live follow",
  );
  assert.equal(
    observation.followCallsAfterLogicalAdvance,
    observation.followCallsBeforeLogicalAdvance,
    "idle HTTP delivery established a duplicate live follow",
  );
  assert.equal(
    observation.pollingTimerExecutions,
    0,
    "idle HTTP delivery executed a polling timer",
  );
}

function createFakeResponse() {
  const response = new EventEmitter();
  response.destroyed = false;
  response.headersSent = false;
  response.output = [];
  response.writableEnded = false;
  response.writeHead = (status, headers) => {
    response.headersSent = true;
    response.status = status;
    response.headers = headers;
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
