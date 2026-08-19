import assert from "node:assert/strict";
import test from "node:test";

import {
  createDurableStreamHarness,
  deterministicOffset,
} from "../support/durable-stream-harness.mjs";

test("durable stream harness survives lost acknowledgements and projection deletion", async () => {
  const store = createDurableStreamHarness();
  const source = "channel:source";
  const projection = "projection:test";
  store.failAfterAppendOnce(source);
  await assert.rejects(store.append(source, { eventId: "one" }), {
    ambiguousAck: true,
  });
  assert.equal(store.count(source), 1);
  await store.ensure(projection);
  await store.append(projection, { sourceOffset: deterministicOffset(1) });
  const before = store.dump()[source].streamDigest;
  store.clearProjection(projection);
  assert.equal(store.count(projection), 0);
  assert.equal(store.dump()[source].streamDigest, before);
});

test("durable stream harness enforces heads and producer fencing", async () => {
  const store = createDurableStreamHarness();
  const stream = "run:test";
  await store.append(
    stream,
    { eventId: "one" },
    {
      producer: { epoch: 1, id: "worker", seq: 1 },
      streamSeq: deterministicOffset(0),
    },
  );
  const duplicate = await store.append(
    stream,
    { eventId: "one" },
    {
      producer: { epoch: 1, id: "worker", seq: 1 },
      streamSeq: deterministicOffset(1),
    },
  );
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.count(stream), 1);
  await assert.rejects(
    store.append(
      stream,
      { eventId: "stale" },
      {
        streamSeq: deterministicOffset(0),
      },
    ),
    { code: "APPEND_CONFLICT" },
  );
});
