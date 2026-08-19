import assert from "node:assert/strict";
import test from "node:test";

import { canonicalSha256 } from "../../src/ledger/canonical-json.mjs";
import {
  createDispatchDoor,
  dispatchRequestDigest,
  DISPATCH_REFUSAL_CODES,
} from "../../src/ledger/dispatch.mjs";

const WORKSPACE_A = `ws_${"0".repeat(26)}`;
const WORKSPACE_B = `ws_${"0".repeat(25)}1`;
const ACTOR_A = "pr_ada";
const ACTOR_B = "pr_linus";

test("dispatch canonicalizes logical identity separately from its fence", () => {
  const base = request({
    payload: { b: 2, a: ["same", true] },
  });
  const reordered = { ...base, payload: { a: ["same", true], b: 2 } };
  assert.equal(dispatchRequestDigest(base), dispatchRequestDigest(reordered));
  assert.equal(
    dispatchRequestDigest(base),
    dispatchRequestDigest({ ...base, expectedHead: "offset-advanced" }),
  );
  assert.notEqual(
    dispatchRequestDigest(base),
    dispatchRequestDigest({ ...base, payload: { a: ["same", false], b: 2 } }),
  );
});

test("one hundred concurrent same-scope requests append one logical event", async () => {
  const store = createMemoryStore({ appendDelayMs: 1 });
  const door = createDispatchDoor({
    producerEpoch: 0,
    producerId: "unit-dispatch-door",
    streamStore: store,
  });
  const input = request({ payload: { logical: "one-event", value: 7 } });

  const results = await Promise.all(
    Array.from({ length: 100 }, () => door.dispatch(input)),
  );
  const target = await store.read(input.stream);
  const index = await store.read("__stream_slack_dispatch_idempotency__");

  assert.equal(target.records.length, 1);
  assert.equal(index.records.length, 1);
  assert.equal(
    new Set(results.map((result) => result.receipt.nextOffset)).size,
    1,
  );
  assert.equal(
    new Set(results.map((result) => result.receipt.eventDigest)).size,
    1,
  );
  assert.deepEqual(results[0].receipt, results.at(-1).receipt);
  door.close();
});

test("independent doors converge same-key races to one receipt", async () => {
  const store = createMemoryStore({ appendDelayMs: 5 });
  const doorA = createDispatchDoor({
    producerEpoch: 0,
    producerId: "unit-same-key-door-a",
    streamStore: store,
  });
  const doorB = createDispatchDoor({
    producerEpoch: 0,
    producerId: "unit-same-key-door-b",
    streamStore: store,
  });
  const input = request({
    idempotencyKey: idempotencyKey(12),
    payload: { logical: "one-cross-door-event" },
    stream: "cross-door-same-key",
  });
  const results = await Promise.all([
    doorA.dispatch(input),
    doorB.dispatch(input),
  ]);
  assert.deepEqual(results[0].receipt, results[1].receipt);
  assert.equal((await store.read(input.stream)).records.length, 1);
  assert.equal(
    (await store.read("__stream_slack_dispatch_idempotency__")).records.length,
    1,
  );
  doorA.close();
  doorB.close();
});

test("reusing a key across payload, actor, workspace, operation, or stream is refused", async () => {
  const store = createMemoryStore();
  const door = createDispatchDoor({
    producerEpoch: 0,
    producerId: "unit-conflict-door",
    streamStore: store,
  });
  const accepted = request({ payload: { value: "original" } });
  await door.dispatch(accepted);
  const before = await dumpStreams(store, [accepted.stream, "candidate-b"]);
  const variants = [
    { payload: { value: "changed" } },
    { actorId: ACTOR_B },
    { workspaceId: WORKSPACE_B },
    { operation: "chat.message.edit" },
    { stream: "candidate-b" },
  ];

  for (const variant of variants) {
    await assert.rejects(
      door.dispatch({ ...accepted, ...variant }),
      (error) => error.code === DISPATCH_REFUSAL_CODES.IDEMPOTENCY_CONFLICT,
    );
  }
  assert.deepEqual(
    await dumpStreams(store, [accepted.stream, "candidate-b"]),
    before,
  );
  door.close();
});

test("two independent writers sharing an expected head have one provider-enforced winner", async () => {
  const store = createMemoryStore({ appendDelayMs: 5 });
  const doorA = createDispatchDoor({
    producerEpoch: 0,
    producerId: "unit-race-door-a",
    streamStore: store,
  });
  const doorB = createDispatchDoor({
    producerEpoch: 0,
    producerId: "unit-race-door-b",
    streamStore: store,
  });
  const first = request({
    idempotencyKey: idempotencyKey(10),
    payload: { winner: "a" },
  });
  const second = request({
    idempotencyKey: idempotencyKey(11),
    payload: { winner: "b" },
  });
  const settled = await Promise.allSettled([
    doorA.dispatch(first),
    doorB.dispatch(second),
  ]);
  assert.equal(
    settled.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    settled.filter((result) => result.status === "rejected").length,
    1,
  );
  const refusal = settled.find((result) => result.status === "rejected").reason;
  assert.equal(refusal.code, DISPATCH_REFUSAL_CODES.STALE_FENCE);
  const target = await store.read(first.stream);
  assert.equal(target.records.length, 1);

  await assert.rejects(
    doorB.dispatch(second),
    (error) => error.code === DISPATCH_REFUSAL_CODES.STALE_FENCE,
  );
  assert.equal((await store.read(first.stream)).records.length, 1);
  doorA.close();
  doorB.close();
});

test("application expected-head refusal is sensitive without provider fencing", async () => {
  const store = createMemoryStore({ enforceStreamSeq: false });
  const door = createDispatchDoor({
    producerEpoch: 0,
    producerId: "unit-application-fence-door",
    streamStore: store,
  });
  const stream = "application-fence-room";
  await store.append(stream, { seed: true });
  const stale = request({
    expectedHead: "offset-0",
    idempotencyKey: idempotencyKey(13),
    stream,
  });

  await assert.rejects(
    door.dispatch(stale),
    (error) => error.code === DISPATCH_REFUSAL_CODES.STALE_FENCE,
  );
  assert.equal((await store.read(stream)).records.length, 1);
  door.close();
});

test("a lost acknowledgement recovers from the durable event without a second target append", async () => {
  const store = createMemoryStore({
    failAfterAppendFor: "lost-ack-room",
  });
  const door = createDispatchDoor({
    producerEpoch: 0,
    producerId: "unit-lost-ack-door",
    streamStore: store,
  });
  const input = request({
    stream: "lost-ack-room",
    payload: { value: "durable" },
  });

  await assert.rejects(door.dispatch(input), /lost acknowledgement/u);
  const recovered = await door.dispatch(input);
  assert.equal(recovered.receipt.status, "accepted");
  assert.equal(
    recovered.event.payload?.value ?? recovered.event.value,
    "durable",
  );
  assert.equal(
    store.appendCalls.filter((call) => call.stream === input.stream).length,
    1,
  );
  assert.equal((await store.read(input.stream)).records.length, 1);
  door.close();
});

test("a provider duplicate without the requested target event fails closed", async () => {
  const store = createMemoryStore({ providerDuplicateBeforeStreamSeq: true });
  const firstDoor = createDispatchDoor({
    producerEpoch: 0,
    producerId: "unit-reused-producer-door",
    streamStore: store,
  });
  const original = request({
    idempotencyKey: idempotencyKey(14),
    payload: { value: "original" },
    stream: "producer-reuse-room",
  });
  await firstDoor.dispatch(original);
  firstDoor.close();

  const restartedDoor = createDispatchDoor({
    producerEpoch: 0,
    producerId: "unit-reused-producer-door",
    streamStore: store,
  });
  const different = request({
    expectedHead: "offset-1",
    idempotencyKey: idempotencyKey(15),
    payload: { value: "different" },
    stream: original.stream,
  });
  await assert.rejects(
    restartedDoor.dispatch(different),
    (error) => error.code === DISPATCH_REFUSAL_CODES.DURABILITY_GAP,
  );
  const target = await store.read(original.stream);
  const index = await store.read("__stream_slack_dispatch_idempotency__");
  assert.equal(
    target.records.filter(
      (record) => record.dispatch?.idempotencyKey === different.idempotencyKey,
    ).length,
    0,
  );
  assert.equal(
    index.records.some(
      (record) => record.receipt?.idempotencyKey === different.idempotencyKey,
    ),
    false,
  );
  restartedDoor.close();
});

test("a forged tail receipt checkpoint fails closed", async () => {
  const store = createMemoryStore();
  const door = createDispatchDoor({
    producerEpoch: 0,
    producerId: "unit-forged-receipt-door",
    streamStore: store,
  });
  const input = request({ stream: "forged-receipt-room" });
  await door.dispatch(input);
  const index = await store.read("__stream_slack_dispatch_idempotency__");
  index.records[0].receipt.nextOffset = "offset-999";
  door.close();

  const restartedDoor = createDispatchDoor({
    producerEpoch: 0,
    producerId: "unit-forged-receipt-restart-door",
    streamStore: store,
  });
  await assert.rejects(
    restartedDoor.dispatch(input),
    (error) => error.code === DISPATCH_REFUSAL_CODES.DURABILITY_GAP,
  );
  restartedDoor.close();
});

test("an indexed receipt without its target event fails closed", async () => {
  const store = createMemoryStore();
  const input = request({ stream: "orphan-receipt-room" });
  const requestDigest = dispatchRequestDigest(input);
  await store.append(
    "__stream_slack_dispatch_idempotency__",
    {
      kind: "dispatch.accepted",
      receipt: {
        actorId: input.actorId,
        eventDigest: canonicalSha256({ missing: true }),
        idempotencyKey: input.idempotencyKey,
        nextOffset: "offset-1",
        operation: input.operation,
        requestDigest,
        status: "accepted",
        stream: input.stream,
        workspaceId: input.workspaceId,
      },
    },
    { streamSeq: "offset-0" },
  );
  const door = createDispatchDoor({
    producerEpoch: 0,
    producerId: "unit-orphan-receipt-door",
    streamStore: store,
  });

  await assert.rejects(
    door.dispatch(input),
    (error) => error.code === DISPATCH_REFUSAL_CODES.DURABILITY_GAP,
  );
  assert.equal((await store.read(input.stream)).records.length, 0);
  door.close();
});

test("validation and authorization refuse before append or durable success record", async () => {
  const store = createMemoryStore();
  const denied = createDispatchDoor({
    authorize: () => ({ ok: false, detail: "revoked actor" }),
    producerEpoch: 0,
    producerId: "unit-denied-door",
    streamStore: store,
  });
  const valid = request({});
  const before = await dumpStreams(store, [
    valid.stream,
    "__stream_slack_dispatch_idempotency__",
  ]);

  await assert.rejects(
    denied.dispatch({ ...valid, workspaceId: "not-a-workspace" }),
    (error) => error.code === DISPATCH_REFUSAL_CODES.INVALID_REQUEST,
  );
  await assert.rejects(
    denied.dispatch(valid),
    (error) => error.code === DISPATCH_REFUSAL_CODES.UNAUTHORIZED,
  );
  assert.equal(store.appendCalls.length, 0);
  assert.deepEqual(
    await dumpStreams(store, [
      valid.stream,
      "__stream_slack_dispatch_idempotency__",
    ]),
    before,
  );
  denied.close();
});

function request(overrides = {}) {
  return {
    actorId: ACTOR_A,
    expectedHead: "offset-0",
    idempotencyKey: idempotencyKey(1),
    operation: "chat.message.create",
    payload: { value: "default" },
    stream: "candidate-a",
    workspaceId: WORKSPACE_A,
    ...overrides,
  };
}

function idempotencyKey(number) {
  return `ik_${String(number).padStart(26, "0")}`;
}

async function dumpStreams(store, streams) {
  const dump = {};
  for (const stream of streams) {
    const result = await store.read(stream);
    dump[stream] = {
      records: result.records,
      nextOffset: result.nextOffset,
      streamDigest: result.streamDigest,
    };
  }
  return dump;
}

function createMemoryStore({
  appendDelayMs = 0,
  enforceStreamSeq = true,
  failAfterAppendFor = null,
  providerDuplicateBeforeStreamSeq = false,
} = {}) {
  const streams = new Map();
  const producers = new Map();
  let failurePending = failAfterAppendFor;
  const appendCalls = [];

  return {
    appendCalls,
    async append(stream, record, options = {}) {
      appendCalls.push({ stream, record, options });
      if (appendDelayMs > 0) await delay(appendDelayMs);
      const records = streams.get(stream) ?? [];
      const expectedHead = `offset-${records.length}`;
      if (
        providerDuplicateBeforeStreamSeq &&
        options.producer &&
        producers.has(`${stream}:${options.producer.id}`)
      ) {
        const last = producers.get(`${stream}:${options.producer.id}`);
        if (
          options.producer.epoch === last.epoch &&
          options.producer.seq <= last.seq
        ) {
          return {
            duplicate: true,
            message: record,
            nextOffset: expectedHead,
          };
        }
      }
      if (
        enforceStreamSeq &&
        options.streamSeq !== undefined &&
        options.streamSeq !== expectedHead
      ) {
        throw Object.assign(new Error("stale expected head"), {
          code: "APPEND_CONFLICT",
          status: 409,
        });
      }
      if (options.producer) {
        const producerKey = `${stream}:${options.producer.id}`;
        const last = producers.get(producerKey);
        if (last !== undefined && options.producer.epoch === last.epoch) {
          if (options.producer.seq <= last.seq) {
            return {
              duplicate: true,
              message: record,
              nextOffset: expectedHead,
            };
          }
          if (options.producer.seq !== last.seq + 1) {
            throw Object.assign(new Error("producer sequence gap"), {
              code: "APPEND_CONFLICT",
              status: 409,
            });
          }
        }
        producers.set(producerKey, {
          epoch: options.producer.epoch,
          seq: options.producer.seq,
        });
      }
      records.push(record);
      streams.set(stream, records);
      const nextOffset = `offset-${records.length}`;
      if (failurePending === stream) {
        failurePending = null;
        throw new Error("lost acknowledgement");
      }
      return { message: record, nextOffset };
    },
    async read(stream) {
      const records = [...(streams.get(stream) ?? [])];
      return {
        records,
        messages: records,
        nextOffset: `offset-${records.length}`,
        streamDigest: canonicalSha256(records),
      };
    },
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
