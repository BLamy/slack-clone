import { canonicalSha256 } from "../../src/ledger/canonical-json.mjs";

export function deterministicOffset(sequence) {
  const word = sequence.toString(16).padStart(16, "0");
  return `${String(sequence).padStart(16, "0")}_${word}`;
}

export function createDurableStreamHarness({ appendDelayMs = 0 } = {}) {
  const streams = new Map();
  const producers = new Map();
  const failAfterAppend = new Set();
  const boundaries = [];

  return Object.freeze({
    async append(stream, record, options = {}) {
      if (appendDelayMs > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, appendDelayMs);
        });
      }
      const records = streams.get(stream) ?? [];
      const expectedHead = deterministicOffset(records.length);
      if (
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
        const previous = producers.get(producerKey);
        if (
          previous &&
          options.producer.epoch === previous.epoch &&
          options.producer.seq <= previous.seq
        ) {
          return {
            duplicate: true,
            message: structuredClone(record),
            nextOffset: expectedHead,
          };
        }
        producers.set(producerKey, {
          epoch: options.producer.epoch,
          seq: options.producer.seq,
        });
      }
      records.push(structuredClone(record));
      streams.set(stream, records);
      boundaries.push({
        boundary: "after-append",
        index: records.length - 1,
        stream,
      });
      if (failAfterAppend.delete(stream)) {
        throw Object.assign(new Error("lost acknowledgement"), {
          ambiguousAck: true,
        });
      }
      return {
        message: structuredClone(record),
        nextOffset: deterministicOffset(records.length),
      };
    },

    async ensure(stream) {
      if (!streams.has(stream)) streams.set(stream, []);
    },

    async read(stream) {
      const records = structuredClone(streams.get(stream) ?? []);
      return {
        nextOffset: deterministicOffset(records.length),
        records,
        streamDigest: canonicalSha256(records),
      };
    },

    clearProjection(stream) {
      streams.delete(stream);
      for (const key of producers.keys()) {
        if (key.startsWith(`${stream}:`)) producers.delete(key);
      }
    },

    count(stream) {
      return (streams.get(stream) ?? []).length;
    },

    dump() {
      return Object.fromEntries(
        [...streams.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([stream, records]) => [
            stream,
            {
              head: deterministicOffset(records.length),
              records: structuredClone(records),
              streamDigest: canonicalSha256(records),
            },
          ]),
      );
    },

    failAfterAppendOnce(stream) {
      failAfterAppend.add(stream);
    },

    faultSchedule() {
      return structuredClone(boundaries);
    },

    records(stream) {
      return structuredClone(streams.get(stream) ?? []);
    },

    replace(stream, records) {
      streams.set(stream, structuredClone(records));
    },

    seed(stream, record) {
      const records = streams.get(stream) ?? [];
      records.push(structuredClone(record));
      streams.set(stream, records);
    },
  });
}
