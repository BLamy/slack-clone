import assert from "node:assert/strict";

import { ZERO_OFFSET } from "@stream-slack/protocol";
import { replayRecords } from "@stream-slack/reducers";

import { createDispatchDoor } from "./dispatch.mjs";
import { canonicalSha256 } from "./canonical-json.mjs";
import { validateEventEnvelope } from "./envelope.mjs";

export const FAULT_HOOKS = Object.freeze([
  "validate",
  "append",
  "receipt",
  "publish",
  "consume",
  "checkpoint",
  "acknowledge",
]);

export const FAULT_ACTIONS = Object.freeze([
  "continue",
  "crash",
  "duplicate",
  "reorder",
  "delay",
  "partition",
  "corrupt",
]);

export const FAULT_ERROR_CODES = Object.freeze({
  CHECKPOINT_INVALID: "HARNESS_CHECKPOINT_INVALID",
  CRASH: "HARNESS_CRASH",
  PARTITIONED: "HARNESS_PARTITIONED",
  SLOW_CONSUMER: "HARNESS_SLOW_CONSUMER",
});

export const SLOW_CONSUMER_POLICIES = Object.freeze({
  CANCEL: "cancel",
  CATCH_UP: "catch-up",
});

export const HARNESS_STREAM = "workspace_ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
export const HARNESS_IDEMPOTENCY_STREAM =
  "__stream_slack_dispatch_idempotency__";
export const HARNESS_CHECKPOINT_STREAM = "__harness_checkpoints__";
export const HARNESS_WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
export const HARNESS_ACTOR_ID =
  "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";

const OFFSET_PATTERN = /^[0-9a-f]{16}_[0-9a-f]{16}$/u;

export const FROZEN_FAULT_SCHEDULES = Object.freeze([
  schedule("baseline", "e0-t06-baseline", []),
  schedule("validate-crash", "e0-t06-validate", [
    fault("validate", "before", "dispatch", 0, "crash"),
  ]),
  schedule("append-before-crash", "e0-t06-append-before", [
    fault("append", "before", "target", 0, "crash"),
  ]),
  schedule("append-after-crash", "e0-t06-append-after", [
    fault("append", "after", "target", 0, "crash"),
  ]),
  schedule("receipt-before-crash", "e0-t06-receipt-before", [
    fault("receipt", "before", "receipt", 0, "crash"),
  ]),
  schedule("receipt-after-crash", "e0-t06-receipt-after", [
    fault("receipt", "after", "receipt", 0, "crash"),
  ]),
  schedule("append-duplicate", "e0-t06-append-duplicate", [
    fault("append", "after", "target", 0, "duplicate"),
  ]),
  schedule("receipt-duplicate", "e0-t06-receipt-duplicate", [
    fault("receipt", "after", "receipt", 0, "duplicate"),
  ]),
  schedule("publish-duplicate-reorder", "e0-t06-publish", [
    fault("publish", "before", "reader", 0, "duplicate"),
    fault("publish", "after", "reader", 0, "reorder"),
  ]),
  schedule("consume-partition", "e0-t06-consume", [
    fault("consume", "before", "reader", 1, "partition"),
  ]),
  schedule("checkpoint-corrupt", "e0-t06-checkpoint", [
    fault("checkpoint", "load", "reader", 0, "corrupt"),
  ]),
  schedule("acknowledge-delay", "e0-t06-ack", [
    fault("acknowledge", "before", "dispatch", 0, "delay"),
  ]),
  schedule("seeded-combination", "e0-t06-combination", [
    fault("validate", "before", "dispatch", 0, "delay"),
    fault("append", "after", "target", 0, "duplicate"),
    fault("receipt", "after", "receipt", 0, "duplicate"),
    fault("publish", "before", "reader", 0, "duplicate"),
    fault("publish", "after", "reader", 0, "reorder"),
    fault("consume", "before", "reader", 1, "partition"),
    fault("checkpoint", "load", "reader", 0, "corrupt"),
    fault("acknowledge", "before", "dispatch", 0, "delay"),
  ]),
]);

export class FaultHarnessError extends Error {
  constructor(code, detail, context = {}) {
    super(`${code}: ${detail}`);
    this.name = "FaultHarnessError";
    this.code = code;
    this.detail = detail;
    Object.assign(this, context);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      detail: this.detail,
      hook: this.hook ?? null,
      phase: this.phase ?? null,
      role: this.role ?? null,
      offset: this.offset ?? null,
    };
  }
}

export class FaultScheduler {
  constructor({ seed, schedule = [] }) {
    if (typeof seed !== "string" || seed.length === 0) {
      throw new TypeError("fault scheduler seed must be a non-empty string");
    }
    if (!Array.isArray(schedule)) {
      throw new TypeError("fault scheduler schedule must be an array");
    }
    this.seed = seed;
    this.schedule = schedule.map(normalizeFault);
    this.hits = [];
    this.counters = new Map();
    this.matched = new Set();
    this.randomState = seedHash(seed);
  }

  hit(hook, context = {}) {
    assertHook(hook);
    const phase = context.phase ?? "point";
    const role = context.role ?? "system";
    const counterKey = `${hook}:${phase}:${role}`;
    const occurrence = this.counters.get(counterKey) ?? 0;
    this.counters.set(counterKey, occurrence + 1);

    const hit = {
      hook,
      occurrence,
      phase,
      role,
      stream: context.stream ?? null,
    };
    const matchIndex = this.schedule.findIndex(
      (entry, index) =>
        !this.matched.has(index) &&
        entry.hook === hook &&
        entry.phase === phase &&
        entry.role === role &&
        entry.occurrence === occurrence,
    );
    const entry = matchIndex === -1 ? null : this.schedule.at(matchIndex);
    if (entry) {
      this.matched.add(matchIndex);
      hit.action = entry.action;
    } else {
      hit.action = "continue";
    }
    this.hits.push(hit);

    if (hit.action === "crash") {
      throw new FaultHarnessError(
        FAULT_ERROR_CODES.CRASH,
        `injected crash at ${hook}/${phase}/${role} occurrence ${occurrence}`,
        { hook, phase, role },
      );
    }
    return Object.freeze({
      action: hit.action,
      delayTicks: hit.action === "delay" ? this.nextInt(1, 3) : 0,
      occurrence,
    });
  }

  nextInt(min, max) {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
      throw new TypeError("fault scheduler bounds must be ordered integers");
    }
    this.randomState = xorshift32(this.randomState);
    return min + (this.randomState % (max - min + 1));
  }

  assertComplete() {
    const missing = this.schedule
      .map((entry, index) => ({ entry, index }))
      .filter(({ index }) => !this.matched.has(index));
    if (missing.length > 0) {
      throw new FaultHarnessError(
        FAULT_ERROR_CODES.CHECKPOINT_INVALID,
        `fault schedule entries were not reached: ${missing
          .map(
            ({ entry }) =>
              `${entry.hook}/${entry.phase}/${entry.role}/${entry.occurrence}`,
          )
          .join(", ")}`,
      );
    }
    const coveredHooks = new Set(this.hits.map((hit) => hit.hook));
    const missingHooks = FAULT_HOOKS.filter((hook) => !coveredHooks.has(hook));
    if (missingHooks.length > 0) {
      throw new FaultHarnessError(
        FAULT_ERROR_CODES.CHECKPOINT_INVALID,
        `named fault hooks were not reached: ${missingHooks.join(", ")}`,
      );
    }
  }

  manifest() {
    return {
      seed: this.seed,
      schedule: this.schedule.map((entry) => ({ ...entry })),
      hits: this.hits.map((hit) => ({ ...hit })),
      matchedScheduleEntries: [...this.matched].sort(
        (left, right) => left - right,
      ),
      coveredHooks: FAULT_HOOKS.filter((hook) =>
        this.hits.some((hit) => hit.hook === hook),
      ),
    };
  }
}

export function createFaultScheduler(options) {
  return new FaultScheduler(options);
}

export function createHarnessStore({
  scheduler,
  idempotencyStream = HARNESS_IDEMPOTENCY_STREAM,
} = {}) {
  if (!(scheduler instanceof FaultScheduler)) {
    throw new TypeError("harness store requires a FaultScheduler");
  }
  const streams = new Map();
  const producerSequences = new Map();

  function entriesFor(stream) {
    let entries = streams.get(stream);
    if (!entries) {
      entries = [];
      streams.set(stream, entries);
    }
    return entries;
  }

  async function read(stream, offset = "-1") {
    const entries = entriesFor(stream);
    const start =
      offset === "-1" || offset === ZERO_OFFSET
        ? 0
        : offsetIndex(entries, offset) + 1;
    const records = entries
      .slice(start)
      .map(({ record }) => structuredClone(record));
    return {
      records,
      messages: structuredClone(records),
      nextOffset: entries.length === 0 ? ZERO_OFFSET : entries.at(-1).offset,
      streamDigest: canonicalSha256(records),
    };
  }

  async function append(stream, record, options = {}) {
    const entries = entriesFor(stream);
    const coordinationHook =
      options.hook ?? (stream === idempotencyStream ? "receipt" : "append");
    const role =
      options.role ?? (stream === idempotencyStream ? "receipt" : "target");
    const currentOffset =
      entries.length === 0 ? ZERO_OFFSET : entries.at(-1).offset;
    if (
      options.streamSeq !== undefined &&
      options.streamSeq !== currentOffset
    ) {
      const error = new Error("expected stream head is stale");
      error.code = "APPEND_CONFLICT";
      error.status = 409;
      throw error;
    }

    if (options.producer) {
      const producerKey = `${options.producer.id}:${options.producer.epoch}:${stream}`;
      const priorSequence = producerSequences.get(producerKey);
      if (
        priorSequence !== undefined &&
        options.producer.seq <= priorSequence
      ) {
        return {
          message: structuredClone(record),
          nextOffset: currentOffset,
          duplicate: true,
        };
      }
      producerSequences.set(producerKey, options.producer.seq);
    }

    scheduler.hit(coordinationHook, {
      phase: "before",
      role,
      stream,
    });
    const entry = {
      offset: nextOffset(entries.length),
      record: structuredClone(record),
    };
    entries.push(entry);

    const after = scheduler.hit(coordinationHook, {
      phase: "after",
      role,
      stream,
    });
    return {
      message: structuredClone(record),
      nextOffset: entry.offset,
      duplicate: after.action === "duplicate",
    };
  }

  function dump(stream) {
    return entriesFor(stream).map(({ offset, record }) => ({
      offset,
      record: structuredClone(record),
    }));
  }

  function seed(stream, offset, record) {
    const entries = entriesFor(stream);
    if (entries.length !== 0 || offsetIndex([], offset) !== -1) {
      throw new TypeError(
        "harness seed only supports an empty stream at offset zero",
      );
    }
    entries.push({ offset, record: structuredClone(record) });
  }

  function replace(stream, records) {
    if (!Array.isArray(records))
      throw new TypeError("harness replacement requires records");
    streams.set(
      stream,
      records.map(({ offset, record }) => ({
        offset,
        record: structuredClone(record),
      })),
    );
  }

  function exportState() {
    return structuredClone({
      producerSequences: [...producerSequences.entries()],
      streams: [...streams.entries()].map(([stream, entries]) => ({
        entries,
        stream,
      })),
    });
  }

  function importState(snapshot) {
    if (
      !snapshot ||
      !Array.isArray(snapshot.producerSequences) ||
      !Array.isArray(snapshot.streams)
    ) {
      throw new FaultHarnessError(
        FAULT_ERROR_CODES.CHECKPOINT_INVALID,
        "durable authority snapshot is malformed",
      );
    }
    streams.clear();
    producerSequences.clear();
    for (const [key, sequence] of snapshot.producerSequences) {
      if (typeof key !== "string" || !Number.isSafeInteger(sequence)) {
        throw new FaultHarnessError(
          FAULT_ERROR_CODES.CHECKPOINT_INVALID,
          "durable authority producer state is malformed",
        );
      }
      producerSequences.set(key, sequence);
    }
    for (const { entries, stream } of snapshot.streams) {
      if (typeof stream !== "string" || !Array.isArray(entries)) {
        throw new FaultHarnessError(
          FAULT_ERROR_CODES.CHECKPOINT_INVALID,
          "durable authority stream state is malformed",
        );
      }
      streams.set(
        stream,
        entries.map(({ offset, record }) => ({
          offset,
          record: structuredClone(record),
        })),
      );
    }
  }

  return Object.freeze({
    append,
    dump,
    exportState,
    importState,
    read,
    replace,
    seed,
  });
}

export async function runFaultSchedule(frozenSchedule, options = {}) {
  const normalizedSchedule = normalizeSchedule(frozenSchedule);
  const scheduler = createFaultScheduler(normalizedSchedule);
  const store = createHarnessStore({ scheduler });
  const operations = [];
  const checkpoints = [];
  const processRestarts = [];
  const acceptedEvents = [];
  const delayedAcknowledgements = [];
  const sourceStream = HARNESS_STREAM;
  const initialCheckpoint = options.seedCheckpoint === true;

  if (initialCheckpoint) {
    seedValidCheckpoint(store);
  }

  let nextDispatchHead = ZERO_OFFSET;
  for (let requestIndex = 0; requestIndex < 3; requestIndex += 1) {
    const request = makeRequest(requestIndex, nextDispatchHead);
    let dispatchResult = null;
    let attempts = 0;
    while (!dispatchResult && attempts < 5) {
      const processId = `dispatch-process-${requestIndex}-${attempts}`;
      try {
        scheduler.hit("validate", {
          phase: "before",
          role: "dispatch",
          stream: sourceStream,
        });
        const door = createDispatchDoor({
          idempotencyStream: HARNESS_IDEMPOTENCY_STREAM,
          producerEpoch: 0,
          producerId: processId,
          streamStore: {
            append: (stream, record, appendOptions) =>
              store.append(stream, record, {
                ...appendOptions,
                role:
                  stream === HARNESS_IDEMPOTENCY_STREAM ? "receipt" : "target",
              }),
            read: (stream, offset, readOptions) =>
              store.read(stream, offset, readOptions),
          },
        });
        dispatchResult = await door.dispatch(request);
        const acknowledgement = scheduler.hit("acknowledge", {
          phase: "before",
          role: "dispatch",
          stream: sourceStream,
        });
        const acknowledgementResult = await settleAcknowledgement(
          acknowledgement.delayTicks,
        );
        if (acknowledgementResult.delayed) {
          delayedAcknowledgements.push({
            processId,
            ...acknowledgementResult,
          });
        }
        door.close();
        operations.push({
          attempt: attempts + 1,
          operation: "dispatch",
          processId,
          requestIndex,
          result: "accepted",
          acknowledgement: acknowledgementResult,
        });
        acceptedEvents.push(dispatchResult.event);
      } catch (error) {
        attempts += 1;
        operations.push({
          attempt: attempts,
          code: error.code ?? "ERROR",
          operation: "dispatch",
          processId,
          requestIndex,
          result: "refused",
          receiptCount: store.dump(HARNESS_IDEMPOTENCY_STREAM).length,
          targetCount: store.dump(sourceStream).length,
        });
        processRestarts.push({
          component: "dispatch",
          from: processId,
          reason: error.code ?? "ERROR",
          stateDeleted: true,
          to: `dispatch-process-${requestIndex}-${attempts}`,
        });
      }
    }
    assert.ok(
      dispatchResult,
      `fault schedule did not recover request ${requestIndex}`,
    );
    nextDispatchHead = store.dump(sourceStream).at(-1)?.offset ?? ZERO_OFFSET;
  }

  const targetDump = store.dump(sourceStream);
  const targetRecords = targetDump.map(({ offset, record }) => ({
    event: record.event,
    offset,
  }));
  const authoritativeReplay = replayRecords(targetRecords);
  const delivery = publishDeliveries(targetDump, scheduler);
  const readerSession = await consumeWithRestart({
    delivery,
    scheduler,
    store,
    sourceStream,
    checkpoints,
    processRestarts,
    seedCheckpoint: initialCheckpoint,
    disableDedup: options.disableDedup === true,
    disableResume: options.disableResume === true,
    disableOrdering: options.disableOrdering === true,
    onPartition: ({ store: partitionStore }) =>
      runSlowConsumerProbe({
        partitioned: true,
        scheduler,
        sourceStream,
        store: partitionStore,
      }),
  });
  const readerRun = readerSession.reader;
  const activeStore = readerSession.store;
  if (
    options.disableResume &&
    processRestarts.some(({ component }) => component === "reader")
  ) {
    throw new FaultHarnessError(
      FAULT_ERROR_CODES.CHECKPOINT_INVALID,
      "reader restarted without resuming from its durable checkpoint",
    );
  }

  const invalidCausalOrder = buildInvalidCausalDump(targetRecords);
  let invalidCausalFailure = null;
  try {
    replayRecords(invalidCausalOrder);
  } catch (error) {
    invalidCausalFailure = {
      code: error.code ?? "ERROR",
      offset: error.offset ?? null,
    };
  }
  assert.deepEqual(invalidCausalFailure, {
    code: "REDUCER_ILLEGAL_TRANSITION",
    offset: invalidCausalOrder.at(0).offset,
  });

  const slowConsumer =
    readerSession.partitionProbe ??
    (await runSlowConsumerProbe({
      sourceStream,
      store: activeStore,
      scheduler,
    }));
  scheduler.assertComplete();
  const finalDigest = authoritativeReplay.finalStateDigest;
  const readerDigest = readerRun.finalDigest;
  if (!options.disableDedup && !options.disableResume) {
    assert.equal(
      readerDigest,
      finalDigest,
      "reader did not converge to authoritative replay",
    );
    assert.equal(
      targetDump.length,
      3,
      "a logical dispatch mutation was duplicated",
    );
    assert.equal(
      activeStore.dump(HARNESS_IDEMPOTENCY_STREAM).length,
      3,
      "receipt was duplicated",
    );
  }

  return {
    schemaVersion: 1,
    schedule: scheduler.manifest(),
    result: "PASS",
    sourceStream,
    acceptedEvents: acceptedEvents.map((event) => structuredClone(event)),
    operations,
    processRestarts,
    checkpoints,
    targetDump,
    receiptDump: activeStore.dump(HARNESS_IDEMPOTENCY_STREAM),
    authoritativeReplay: {
      finalStateDigest: finalDigest,
      recordCount: targetRecords.length,
    },
    reader: readerRun,
    invalidCausalOrder: {
      rejected: invalidCausalFailure,
      citedOffset: invalidCausalFailure.offset,
    },
    slowConsumer,
    delayedAcknowledgements,
    finalDigest,
  };
}

async function settleAcknowledgement(delayTicks) {
  const trace = ["pending"];
  for (let tick = delayTicks; tick > 0; tick -= 1) {
    await Promise.resolve();
    trace.push(`deferred:${tick}`);
  }
  trace.push("acknowledged");
  return {
    delayed: delayTicks > 0,
    released: true,
    stateTrace: trace,
    ticks: delayTicks,
  };
}

export async function runFaultSchedules(schedules = FROZEN_FAULT_SCHEDULES) {
  const results = [];
  for (const schedule of schedules) {
    results.push(
      await runFaultSchedule(schedule, {
        seedCheckpoint:
          schedule.name === "checkpoint-corrupt" ||
          schedule.name === "seeded-combination",
      }),
    );
  }
  return results;
}

export function runSensitivityChecks() {
  const checks = [];
  const reorderSchedule = FROZEN_FAULT_SCHEDULES.find(
    ({ name }) => name === "publish-duplicate-reorder",
  );
  assert.ok(reorderSchedule);

  return (async () => {
    const dedupDisabled = await runFaultSchedule(reorderSchedule, {
      disableDedup: true,
    }).then(
      () => ({ outcome: "accepted" }),
      (error) => ({
        code: error.code ?? "ERROR",
        offset: error.offset ?? null,
        outcome: "rejected",
      }),
    );
    assert.equal(dedupDisabled.outcome, "rejected");
    checks.push({
      detector: "duplicate-delivery-deduplication",
      mutated: "disabled",
      ...dedupDisabled,
    });

    const resumeSchedule = FROZEN_FAULT_SCHEDULES.find(
      ({ name }) => name === "consume-partition",
    );
    assert.ok(resumeSchedule);
    const resumeDisabled = await runFaultSchedule(resumeSchedule, {
      disableResume: true,
    }).then(
      () => ({ outcome: "accepted" }),
      (error) => ({
        code: error.code ?? "ERROR",
        offset: error.offset ?? null,
        outcome: "rejected",
      }),
    );
    assert.equal(resumeDisabled.outcome, "rejected");
    checks.push({
      detector: "checkpoint-resume",
      mutated: "disabled",
      ...resumeDisabled,
    });

    const orderingDisabled = await runFaultSchedule(reorderSchedule, {
      disableOrdering: true,
    }).then(
      () => ({ outcome: "accepted" }),
      (error) => ({
        code: error.code ?? "ERROR",
        offset: error.offset ?? null,
        outcome: "rejected",
      }),
    );
    assert.equal(orderingDisabled.outcome, "rejected");
    checks.push({
      detector: "authoritative-offset-ordering",
      mutated: "disabled",
      ...orderingDisabled,
    });
    return checks;
  })();
}

function publishDeliveries(targetDump, scheduler) {
  const initial = targetDump.map(({ offset, record }) => ({
    event: record.event,
    offset,
  }));
  const before = scheduler.hit("publish", { phase: "before", role: "reader" });
  let deliveries = initial;
  if (before.action === "duplicate") {
    deliveries = [
      ...initial,
      ...initial.map((record) => structuredClone(record)),
    ];
  }
  const after = scheduler.hit("publish", { phase: "after", role: "reader" });
  if (after.action === "reorder") deliveries.reverse();
  return deliveries;
}

async function consumeWithRestart({
  delivery,
  scheduler,
  store,
  sourceStream,
  checkpoints,
  processRestarts,
  seedCheckpoint,
  disableDedup,
  disableResume,
  disableOrdering,
  onPartition,
}) {
  let processIndex = 0;
  let reader = createReaderProcess({
    processId: `reader-process-${processIndex}`,
    scheduler,
    store,
    sourceStream,
    checkpoints,
    disableDedup,
    disableResume,
    disableOrdering,
    seedCheckpoint,
  });
  await reader.start();
  const checkpointRecoveries = [];
  if (reader.result().checkpointRecovery) {
    checkpointRecoveries.push(reader.result().checkpointRecovery);
  }
  let pending = delivery;
  let restartCount = 0;
  let partitionProbe = null;
  const durableAuthorityRestarts = [];
  while (pending.length > 0 && restartCount < 4) {
    try {
      await reader.consume(pending);
      pending = [];
    } catch (error) {
      if (error.code !== FAULT_ERROR_CODES.PARTITIONED) throw error;
      const previous = reader.processId;
      if (onPartition) {
        partitionProbe = await onPartition({ store });
      }
      const durableSnapshot = store.exportState();
      const durableSnapshotDigest = canonicalSha256(durableSnapshot);
      const restartedStore = createHarnessStore({ scheduler });
      restartedStore.importState(durableSnapshot);
      const importedSnapshot = restartedStore.exportState();
      assert.deepEqual(importedSnapshot, durableSnapshot);
      store = restartedStore;
      processIndex += 1;
      restartCount += 1;
      durableAuthorityRestarts.push({
        exportedStreamCount: durableSnapshot.streams.length,
        importedStreamCount: importedSnapshot.streams.length,
        snapshotDigest: durableSnapshotDigest,
      });
      processRestarts.push({
        component: "reader",
        durableAuthorityRestart: durableAuthorityRestarts.at(-1),
        from: previous,
        reason: error.code,
        stateDeleted: true,
        to: `reader-process-${processIndex}`,
      });
      reader = createReaderProcess({
        processId: `reader-process-${processIndex}`,
        scheduler,
        store,
        sourceStream,
        checkpoints,
        disableDedup,
        disableResume,
        disableOrdering,
        seedCheckpoint: false,
      });
      await reader.start();
      if (reader.result().checkpointRecovery) {
        checkpointRecoveries.push(reader.result().checkpointRecovery);
      }
      pending = delivery;
    }
  }
  assert.equal(pending.length, 0, "reader did not catch up after partition");
  const readerResult = {
    ...reader.result(),
    checkpointRecovery: checkpointRecoveries.at(0) ?? null,
    durableAuthorityRestarts,
    partitionProbe,
  };
  return {
    reader: readerResult,
    partitionProbe,
    store,
  };
}

function createReaderProcess({
  processId,
  scheduler,
  store,
  sourceStream,
  checkpoints,
  disableDedup,
  disableResume,
  disableOrdering,
  seedCheckpoint,
}) {
  let applied = [];
  let checkpoint = null;
  let checkpointRecovery = null;
  let resumeFrom = ZERO_OFFSET;
  let started = false;

  async function start() {
    const loadDecision = scheduler.hit("checkpoint", {
      phase: "load",
      role: "reader",
      stream: sourceStream,
    });
    let stored = store.dump(HARNESS_CHECKPOINT_STREAM).at(-1)?.record ?? null;
    if (loadDecision.action === "corrupt" && stored) {
      stored = { ...stored, stateDigest: "sha256:" + "0".repeat(64) };
    }
    if (stored) {
      try {
        checkpoint = validateCheckpoint(stored);
      } catch (error) {
        if (error.code !== FAULT_ERROR_CODES.CHECKPOINT_INVALID) throw error;
        checkpoint = null;
        checkpointRecovery = {
          code: error.code,
          result: "recovered-from-zero",
        };
      }
    } else if (seedCheckpoint) {
      checkpoint = validateCheckpoint(seedCheckpointRecord());
    }
    if (checkpoint && !disableResume) {
      resumeFrom = checkpoint.offset;
      const source = sourceRecords(store, sourceStream);
      const prefix = source.filter(
        ({ offset }) => compareOffsets(offset, checkpoint.offset) <= 0,
      );
      applied = prefix;
      const prefixReplay = replayRecords(prefix);
      assert.equal(prefixReplay.finalStateDigest, checkpoint.stateDigest);
    } else {
      checkpoint = null;
      applied = [];
      resumeFrom = ZERO_OFFSET;
    }
    started = true;
  }

  async function consume(delivery) {
    if (!started) throw new Error("reader must start before consuming");
    let pending = delivery.map((record) => structuredClone(record));
    const unique = new Map();
    for (const record of pending) {
      const key = record.offset;
      if (!disableDedup && unique.has(key)) continue;
      unique.set(key, record);
    }
    if (!disableDedup) pending = [...unique.values()];
    if (!disableOrdering) {
      pending.sort((left, right) => compareOffsets(left.offset, right.offset));
    }
    const resumeOffset = checkpoint?.offset ?? ZERO_OFFSET;
    const seenDeliveryOffsets = new Set();
    for (const record of pending) {
      const duplicateDelivery = seenDeliveryOffsets.has(record.offset);
      seenDeliveryOffsets.add(record.offset);
      if (
        !disableResume &&
        compareOffsets(record.offset, resumeOffset) <= 0 &&
        !(disableDedup && duplicateDelivery)
      ) {
        continue;
      }
      const consumeDecision = scheduler.hit("consume", {
        phase: "before",
        role: "reader",
        stream: sourceStream,
      });
      if (consumeDecision.action === "partition") {
        throw new FaultHarnessError(
          FAULT_ERROR_CODES.PARTITIONED,
          `reader partitioned before ${record.offset}`,
          {
            hook: "consume",
            phase: "before",
            role: "reader",
            offset: record.offset,
          },
        );
      }
      applied.push(record);
      const reduced = replayRecords(applied);
      const nextCheckpoint = {
        kind: "reader.checkpoint",
        offset: record.offset,
        sourceStream,
        stateDigest: reduced.finalStateDigest,
      };
      await persistCheckpoint(store, scheduler, nextCheckpoint, checkpoints);
      checkpoint = nextCheckpoint;
    }
  }

  function result() {
    const reduced = replayRecords(applied);
    return {
      processId,
      finalDigest: reduced.finalStateDigest,
      appliedOffsets: applied.map(({ offset }) => offset),
      checkpoint: checkpoint ? structuredClone(checkpoint) : null,
      checkpointRecovery,
      resumeFrom,
      sourceReplayCount: applied.length,
    };
  }

  return Object.freeze({ consume, result, start });
}

async function persistCheckpoint(store, scheduler, record, checkpoints) {
  scheduler.hit("checkpoint", {
    phase: "before",
    role: "reader",
    stream: record.sourceStream,
  });
  const entries = store.dump(HARNESS_CHECKPOINT_STREAM);
  const expectedHead =
    entries.length === 0 ? ZERO_OFFSET : entries.at(-1).offset;
  const appendResult = await store.append(
    HARNESS_CHECKPOINT_STREAM,
    {
      ...record,
      checkpointDigest: checkpointDigest(record),
    },
    {
      hook: "checkpoint",
      role: "reader",
      streamSeq: expectedHead,
    },
  );
  scheduler.hit("checkpoint", {
    phase: "after",
    role: "reader",
    stream: record.sourceStream,
  });
  checkpoints.push({
    offset: record.offset,
    checkpointDigest: checkpointDigest(record),
    durableOffset: appendResult.nextOffset,
  });
}

async function runSlowConsumerProbe({
  partitioned = false,
  sourceStream,
  store,
  scheduler,
}) {
  const boundedRecords = sourceRecords(store, sourceStream);
  const maxRecords = 2;
  const maxBytes = 1024;
  const queueBytes = boundedRecords.reduce(
    (total, record) => total + Buffer.byteLength(JSON.stringify(record)),
    0,
  );
  const cancelQueue = createBoundedQueue({
    maxBytes,
    maxRecords,
    policy: SLOW_CONSUMER_POLICIES.CANCEL,
  });
  let cancelFailure = null;
  for (const record of boundedRecords) {
    try {
      cancelQueue.enqueue(record);
    } catch (error) {
      if (error.code !== FAULT_ERROR_CODES.SLOW_CONSUMER) throw error;
      cancelFailure = error;
      break;
    }
  }
  assert.ok(cancelFailure, "cancel policy did not enforce its queue bound");
  const catchUpQueue = createBoundedQueue({
    maxBytes,
    maxRecords,
    policy: SLOW_CONSUMER_POLICIES.CATCH_UP,
  });
  let catchUpOverflow = null;
  for (const record of boundedRecords) {
    const result = catchUpQueue.enqueue(record);
    if (result.overflow) {
      catchUpOverflow = result;
      break;
    }
  }
  assert.ok(catchUpOverflow, "catch-up policy did not observe a full queue");

  scheduler.hit("publish", { phase: "slow-consumer", role: "unrelated" });
  const unrelatedStream = "workspace_ws_bbbbbbbbbbbbbbbbbbbbbb";
  for (let index = 0; index < 5; index += 1) {
    await store.append(
      unrelatedStream,
      { index, kind: "unrelated.flood" },
      { role: "unrelated" },
    );
  }
  const unrelatedRead = await store.read(unrelatedStream, ZERO_OFFSET);
  return {
    bounds: {
      maxBytes,
      maxRecords,
      inputBytes: queueBytes,
      inputRecords: boundedRecords.length,
      cancelPeakBytes: cancelQueue.peakBytes,
      cancelPeakRecords: cancelQueue.peakRecords,
      catchUpPeakBytes: catchUpQueue.peakBytes,
      catchUpPeakRecords: catchUpQueue.peakRecords,
    },
    cancel: {
      code: cancelFailure.code,
      offset: cancelFailure.offset ?? null,
      policy: SLOW_CONSUMER_POLICIES.CANCEL,
      result: "cancelled",
    },
    catchUp: {
      overflowAt: catchUpOverflow.offset,
      policy: SLOW_CONSUMER_POLICIES.CATCH_UP,
      result: "caught-up",
      resumedFrom: ZERO_OFFSET,
      replayedRecords: boundedRecords.length,
    },
    unrelatedStreamProgress: {
      stream: unrelatedStream,
      partitionedStream: sourceStream,
      independent: unrelatedStream !== sourceStream,
      headOfLineBlocked: unrelatedRead.records.length === 0,
      partitionedDuringProbe: partitioned,
      progressRecords: unrelatedRead.records.length,
    },
  };
}

function createBoundedQueue({ maxBytes, maxRecords, policy }) {
  const records = [];
  let bytes = 0;
  let peakBytes = 0;
  let peakRecords = 0;

  function enqueue(record) {
    const offset = record.offset ?? null;
    const recordBytes = Buffer.byteLength(JSON.stringify(record));
    if (records.length + 1 > maxRecords || bytes + recordBytes > maxBytes) {
      if (policy === SLOW_CONSUMER_POLICIES.CANCEL) {
        throw new FaultHarnessError(
          FAULT_ERROR_CODES.SLOW_CONSUMER,
          `slow consumer exceeded ${maxRecords} records or ${maxBytes} bytes`,
          { offset },
        );
      }
      records.length = 0;
      bytes = 0;
      return { offset, overflow: true };
    }
    records.push(structuredClone(record));
    bytes += recordBytes;
    peakBytes = Math.max(peakBytes, bytes);
    peakRecords = Math.max(peakRecords, records.length);
    return { offset, overflow: false };
  }

  return Object.freeze({
    enqueue,
    get peakBytes() {
      return peakBytes;
    },
    get peakRecords() {
      return peakRecords;
    },
  });
}

function buildInvalidCausalDump(records) {
  const first = records.at(0);
  const invalid = structuredClone(first);
  invalid.event = {
    ...invalid.event,
    data: {
      from: "queued",
      runId: "run-invalid",
      to: "running",
    },
    eventId: "ev_bbbbbbbbbbbbbbbbbbbbbbbbbb",
    eventType: "run.lifecycle.changed",
  };
  const terminal = structuredClone(invalid);
  terminal.offset = nextOffset(1);
  terminal.event = {
    ...terminal.event,
    data: {
      from: null,
      runId: "run-invalid",
      to: "queued",
    },
    eventId: "ev_cccccccccccccccccccccccccc",
  };
  return [invalid, terminal];
}

function makeRequest(index, expectedHead) {
  const event = makeFixtureEnvelope(index);
  return {
    actorId: HARNESS_ACTOR_ID,
    expectedHead,
    idempotencyKey: `ik_${["cccccccccccccccccccccccccc", "dddddddddddddddddddddddddd", "eeeeeeeeeeeeeeeeeeeeeeeeee"].at(index)}`,
    operation: "ledger.event.append",
    payload: { event },
    stream: HARNESS_STREAM,
    workspaceId: HARNESS_WORKSPACE_ID,
  };
}

function makeFixtureEnvelope(index) {
  const letter = ["c", "d", "e"].at(index);
  return validateEventEnvelope({
    actorId: HARNESS_ACTOR_ID,
    causation: null,
    correlationId: "cr_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    data: {
      fixtureId: `fault-${letter}`,
      value: `seeded-${letter}`,
    },
    eventId: `ev_${letter.repeat(26)}`,
    eventType: "ledger.fixture-recorded",
    idempotencyKey: `ik_${letter.repeat(26)}`,
    schemaVersion: 1,
    serverTimestamp: `2026-08-02T00:00:0${index}.000Z`,
    workspaceId: HARNESS_WORKSPACE_ID,
  });
}

function seedValidCheckpoint(store) {
  const event = makeFixtureEnvelope(0);
  const record = {
    event,
    offset: nextOffset(0),
  };
  const replay = replayRecords([record]);
  store.seed(HARNESS_CHECKPOINT_STREAM, nextOffset(0), {
    kind: "reader.checkpoint",
    offset: record.offset,
    sourceStream: HARNESS_STREAM,
    stateDigest: replay.finalStateDigest,
    checkpointDigest: checkpointDigest({
      kind: "reader.checkpoint",
      offset: record.offset,
      sourceStream: HARNESS_STREAM,
      stateDigest: replay.finalStateDigest,
    }),
  });
}

function seedCheckpointRecord() {
  const event = makeFixtureEnvelope(0);
  const replay = replayRecords([{ event, offset: nextOffset(0) }]);
  return {
    kind: "reader.checkpoint",
    offset: nextOffset(0),
    sourceStream: HARNESS_STREAM,
    stateDigest: replay.finalStateDigest,
  };
}

function validateCheckpoint(record) {
  if (
    !record ||
    record.kind !== "reader.checkpoint" ||
    typeof record.offset !== "string" ||
    !OFFSET_PATTERN.test(record.offset) ||
    typeof record.sourceStream !== "string" ||
    typeof record.stateDigest !== "string" ||
    record.checkpointDigest !== checkpointDigest(record)
  ) {
    throw new FaultHarnessError(
      FAULT_ERROR_CODES.CHECKPOINT_INVALID,
      "durable reader checkpoint failed its integrity check",
    );
  }
  return structuredClone(record);
}

function checkpointDigest(record) {
  return canonicalSha256({
    kind: record.kind,
    offset: record.offset,
    sourceStream: record.sourceStream,
    stateDigest: record.stateDigest,
  });
}

function sourceRecords(store, stream) {
  return store.dump(stream).map(({ offset, record }) => ({
    event: structuredClone(record.event),
    offset,
  }));
}

function offsetIndex(entries, offset) {
  if (!OFFSET_PATTERN.test(offset)) {
    throw new FaultHarnessError(
      FAULT_ERROR_CODES.CHECKPOINT_INVALID,
      `invalid Durable Streams checkpoint ${String(offset)}`,
    );
  }
  return entries.findIndex((entry) => entry.offset === offset);
}

function compareOffsets(left, right) {
  const [leftPartition, leftSequence] = left
    .split("_")
    .map((value) => BigInt(`0x${value}`));
  const [rightPartition, rightSequence] = right
    .split("_")
    .map((value) => BigInt(`0x${value}`));
  if (leftPartition < rightPartition) return -1;
  if (leftPartition > rightPartition) return 1;
  return leftSequence < rightSequence
    ? -1
    : leftSequence > rightSequence
      ? 1
      : 0;
}

function nextOffset(index) {
  return `0000000000000000_${(index + 1).toString(16).padStart(16, "0")}`;
}

function normalizeSchedule(scheduleValue) {
  if (!scheduleValue || typeof scheduleValue !== "object") {
    throw new TypeError("fault schedule must be an object");
  }
  return {
    seed: scheduleValue.seed,
    schedule: (scheduleValue.schedule ?? []).map(normalizeFault),
  };
}

function schedule(name, seed, entries) {
  return Object.freeze({
    name,
    schedule: Object.freeze(entries),
    seed,
  });
}

function fault(hook, phase, role, occurrence, action) {
  return Object.freeze({ action, hook, occurrence, phase, role });
}

function normalizeFault(entry) {
  if (!entry || typeof entry !== "object") {
    throw new TypeError("fault schedule entries must be objects");
  }
  assertHook(entry.hook);
  if (typeof entry.phase !== "string" || typeof entry.role !== "string") {
    throw new TypeError("fault schedule phase and role must be strings");
  }
  if (!Number.isSafeInteger(entry.occurrence) || entry.occurrence < 0) {
    throw new TypeError(
      "fault schedule occurrence must be a non-negative integer",
    );
  }
  if (!FAULT_ACTIONS.includes(entry.action)) {
    throw new TypeError(`unknown fault action ${String(entry.action)}`);
  }
  return {
    action: entry.action,
    hook: entry.hook,
    occurrence: entry.occurrence,
    phase: entry.phase,
    role: entry.role,
  };
}

function assertHook(hook) {
  if (!FAULT_HOOKS.includes(hook)) {
    throw new TypeError(`unknown fault hook ${String(hook)}`);
  }
}

function seedHash(seed) {
  let value = 2166136261;
  for (const character of seed) {
    value ^= character.codePointAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function xorshift32(value) {
  let next = value || 0x6d2b79f5;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}
