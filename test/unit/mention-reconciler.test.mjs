import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveMentionInvocationId,
  validateMentionFacts,
} from "@stream-slack/protocol";
import { canonicalSha256 } from "../../src/ledger/canonical-json.mjs";
import {
  digestEventEnvelope,
  issueEventEnvelope,
} from "../../src/ledger/envelope.mjs";
import { createDispatchDoor } from "../../src/ledger/dispatch.mjs";
import {
  createMentionReconciler,
  MENTION_RECONCILER_ERROR_CODES,
} from "../../src/ledger/mention-reconciler.mjs";
import { streamNames } from "../../src/ledger/topology.mjs";

const WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHANNEL_ID = "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const ACTOR_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const AGENT_PRINCIPAL_ID =
  "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";
const AGENT_ID = "ag_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";
const HUMAN_PRINCIPAL_ID =
  "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_eeeeeeeeeeeeeeeeeeeeeeeeee";
const CONFIG_STREAM = `agent:${AGENT_ID}/config`;

test("mention reconciler binds one deterministic invocation and checkpoint", async () => {
  const store = createMemoryStore({ appendDelayMs: 1 });
  const source = seedMention(store, {
    mentions: [agentMention()],
    text: "@helper",
  });
  const snapshot = snapshotFor(source);
  const reconcilers = Array.from({ length: 100 }, (_, index) => {
    const door = createDispatchDoor({
      producerId: `mention-unit-door-${index}`,
      streamStore: store,
    });
    return createReconciler({
      door,
      resolveTarget: async () => ({ snapshot, status: "eligible" }),
      store,
    });
  });

  const runs = await Promise.all(
    reconcilers.map((reconciler) => reconciler.reconcile()),
  );

  const invocationStream = streamNames.workspaceInvocations(WORKSPACE_ID);
  const checkpointStream = reconcilers[0].checkpointStream;
  const invocations = await store.read(invocationStream);
  const checkpoints = await store.read(checkpointStream);
  assert.equal(invocations.records.length, 1);
  assert.equal(checkpoints.records.length, 1);
  assert.equal(new Set(runs.map((run) => run.processed.length)).size, 1);
  const invocationEvent = invocations.records[0].event;
  const invocation = invocationEvent.data;
  assert.equal(
    invocation.invocationId,
    deriveMentionInvocationId({
      agentId: AGENT_ID,
      sourceTrigger: source.reference,
      workspaceId: WORKSPACE_ID,
    }),
  );
  assert.deepEqual(invocation.sourceTrigger, source.reference);
  assert.equal(invocation.snapshotDigest, snapshot.snapshotDigest);
  const receipts = runs.flatMap((run) =>
    run.processed.flatMap((record) =>
      record.targets.map((target) => target.receipt?.nextOffset),
    ),
  );
  assert.equal(new Set(receipts).size, 1);
  assert.equal(checkpoints.records[0].event.data.sequence, 1);
  assert.equal(
    checkpoints.records[0].event.data.sourceOffset,
    source.reference.offset,
  );
  for (const reconciler of reconcilers) {
    reconciler.close?.();
  }
});

test("replaying after every crash boundary does not duplicate the logical effect", async () => {
  for (const boundary of [
    "source-read",
    "snapshot-resolved",
    "invocation-appended",
    "before-checkpoint-acknowledgement",
  ]) {
    const store = createMemoryStore();
    const source = seedMention(store, {
      mentions: [agentMention()],
      text: "@helper",
    });
    const snapshot = snapshotFor(source);
    const firstDoor = createDispatchDoor({
      producerId: `crash-${boundary}`,
      streamStore: store,
    });
    const first = createReconciler({
      door: firstDoor,
      resolveTarget: async () => ({ snapshot, status: "eligible" }),
      store,
      throwAt: boundary,
    });
    await assert.rejects(first.reconcile(), /simulated crash/);
    firstDoor.close();

    const retryDoor = createDispatchDoor({
      producerId: `retry-${boundary}`,
      streamStore: store,
    });
    const retry = createReconciler({
      door: retryDoor,
      resolveTarget: async () => ({ snapshot, status: "eligible" }),
      store,
    });
    await retry.reconcile();
    retryDoor.close();

    const invocations = await store.read(
      streamNames.workspaceInvocations(WORKSPACE_ID),
    );
    const checkpoints = await store.read(retry.checkpointStream);
    assert.equal(invocations.records.length, 1, boundary);
    assert.equal(checkpoints.records.length, 1, boundary);
  }
});

test("non-runnable targets become typed audit outcomes without invocation or config leakage", async () => {
  const store = createMemoryStore();
  seedMention(store, {
    mentions: [humanMention(), agentMention(5)],
    text: "@ada @helper",
  });
  const door = createDispatchDoor({
    producerId: "non-runnable-unit-door",
    streamStore: store,
  });
  await createReconciler({
    door,
    resolveTarget: async () => ({
      code: MENTION_RECONCILER_ERROR_CODES.TARGET_NOT_MEMBER,
      status: "non-runnable",
      hiddenConfig: "must-not-persist",
    }),
    store,
  }).reconcile();
  door.close();

  const invocations = await store.read(
    streamNames.workspaceInvocations(WORKSPACE_ID),
  );
  const audits = await store.read(streamNames.workspaceAudit(WORKSPACE_ID));
  assert.equal(invocations.records.length, 0);
  assert.equal(audits.records.length, 2);
  const serialized = JSON.stringify(audits.records);
  assert.equal(serialized.includes("must-not-persist"), false);
  assert.deepEqual(
    audits.records.map((record) => record.event.data.detail.code).sort(),
    [
      MENTION_RECONCILER_ERROR_CODES.TARGET_NOT_AGENT,
      MENTION_RECONCILER_ERROR_CODES.TARGET_NOT_MEMBER,
    ].sort(),
  );
});

test("cross-wired checkpoint and forged source digest are refused", async () => {
  const store = createMemoryStore();
  const source = seedMention(store, {
    mentions: [agentMention()],
    text: "@helper",
  });
  const door = createDispatchDoor({
    producerId: "corruption-unit-door",
    streamStore: store,
  });
  const reconciler = createReconciler({
    door,
    resolveTarget: async () => ({
      snapshot: snapshotFor(source),
      status: "eligible",
    }),
    store,
  });
  const checkpoint = issueEventEnvelope(
    {
      actorId: ACTOR_ID,
      causation: source.reference,
      correlationId: `cr_${"f".repeat(26)}`,
      data: {
        projectionId: reconciler.projectionId,
        sequence: 1,
        sourceOffset: source.reference.offset,
        sourceStream: `channel:ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_ffffffffffffffffffffffffff`,
        stateDigest: digest("f"),
      },
      eventType: "projection.checkpointed",
      idempotencyKey: `ik_${"f".repeat(26)}`,
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
    },
    { clock: fixedClock, eventId: `ev_${"f".repeat(26)}` },
  );
  store.seed(reconciler.checkpointStream, {
    event: checkpoint,
    offset: offset(1),
  });
  await assert.rejects(
    reconciler.reconcile(),
    (error) => error.code === MENTION_RECONCILER_ERROR_CODES.CHECKPOINT_SCOPE,
  );
  door.close();

  const forgedStore = createMemoryStore();
  const forged = seedMention(forgedStore, {
    digestOverride: digest("e"),
    mentions: [agentMention()],
    text: "@helper",
  });
  const forgedDoor = createDispatchDoor({
    producerId: "forged-unit-door",
    streamStore: forgedStore,
  });
  await assert.rejects(
    createReconciler({
      door: forgedDoor,
      resolveTarget: async () => ({
        snapshot: snapshotFor(forged),
        status: "eligible",
      }),
      store: forgedStore,
    }).reconcile(),
    (error) => error.code === MENTION_RECONCILER_ERROR_CODES.SOURCE_INVALID,
  );
  forgedDoor.close();
});

function createReconciler({ door, resolveTarget, store, throwAt = null }) {
  return createMentionReconciler({
    actorId: ACTOR_ID,
    channelId: CHANNEL_ID,
    dispatch: door,
    onBoundary: async (boundary) => {
      if (boundary === throwAt) throw new Error("simulated crash");
    },
    resolveTarget,
    streamStore: store,
    workspaceId: WORKSPACE_ID,
  });
}

function seedMention(store, { digestOverride = null, mentions, text }) {
  const event = issueEventEnvelope(
    {
      actorId: ACTOR_ID,
      causation: null,
      correlationId: "cr_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      data: {
        authorId: ACTOR_ID,
        channelId: CHANNEL_ID,
        contentType: "text/plain",
        mentions,
        messageId: `msg_${text === "@helper" ? "a" : "b"}`,
        rootMessageId: null,
        text,
      },
      eventType: "channel.message.created",
      idempotencyKey: `ik_${text === "@helper" ? "aaaaaaaaaaaaaaaaaaaaaaaaaa" : "bbbbbbbbbbbbbbbbbbbbbbbbbb"}`,
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
    },
    {
      clock: fixedClock,
      eventId: `ev_${text === "@helper" ? "aaaaaaaaaaaaaaaaaaaaaaaaaa" : "bbbbbbbbbbbbbbbbbbbbbbbbbb"}`,
    },
  );
  validateMentionFacts(mentions, text, { expectedWorkspaceId: WORKSPACE_ID });
  const reference = {
    digest: digestOverride ?? digestEventEnvelope(event),
    offset: offset(1),
    stream: streamNames.channel(WORKSPACE_ID, CHANNEL_ID),
  };
  store.seed(reference.stream, {
    digest: digestOverride ?? digestEventEnvelope(event),
    event,
    offset: reference.offset,
  });
  return { event, reference };
}

function snapshotFor(source) {
  return {
    config: {
      agentConfig: {
        budgets: {
          maxCostUsdCents: 100,
          maxInputTokens: 1000,
          maxOutputTokens: 1000,
          maxTotalTokens: 2000,
          timeoutSeconds: 60,
        },
      },
    },
    snapshotDigest: digest("c"),
    sourceManifest: {
      config: {
        offset: offset(2),
        stateDigest: digest("b"),
        stream: CONFIG_STREAM,
      },
    },
    source,
  };
}

function agentMention(startByte = 0) {
  return {
    handle: "helper",
    kind: "agent",
    principalId: AGENT_PRINCIPAL_ID,
    span: { endByte: startByte + 7, startByte },
    text: "@helper",
  };
}

function humanMention() {
  return {
    handle: "ada",
    kind: "human",
    principalId: HUMAN_PRINCIPAL_ID,
    span: { endByte: 4, startByte: 0 },
    text: "@ada",
  };
}

function createMemoryStore({ appendDelayMs = 0 } = {}) {
  const streams = new Map();
  const producers = new Map();
  return {
    async append(stream, record, options = {}) {
      if (appendDelayMs) {
        await new Promise((resolve) => {
          setTimeout(resolve, appendDelayMs);
        });
      }
      const records = streams.get(stream) ?? [];
      const expectedHead = offset(records.length);
      if (
        options.streamSeq !== undefined &&
        options.streamSeq !== expectedHead
      ) {
        throw Object.assign(new Error("stale expected head"), {
          code: "APPEND_CONFLICT",
          status: 409,
        });
      }
      const producer = options.producer;
      if (producer) {
        const key = `${stream}:${producer.id}`;
        const previous = producers.get(key);
        if (
          previous &&
          producer.epoch === previous.epoch &&
          producer.seq <= previous.seq
        ) {
          return { duplicate: true, message: record, nextOffset: expectedHead };
        }
        producers.set(key, { epoch: producer.epoch, seq: producer.seq });
      }
      records.push(record);
      streams.set(stream, records);
      return { message: record, nextOffset: offset(records.length) };
    },
    async ensure(stream) {
      if (!streams.has(stream)) streams.set(stream, []);
    },
    async read(stream) {
      const records = [...(streams.get(stream) ?? [])];
      return {
        nextOffset: offset(records.length),
        records,
        streamDigest: canonicalSha256(records),
      };
    },
    seed(stream, record) {
      const records = streams.get(stream) ?? [];
      records.push(record);
      streams.set(stream, records);
    },
  };
}

function fixedClock() {
  return new Date("2026-08-07T00:00:00.000Z");
}

function offset(sequence) {
  const word = sequence.toString(16).padStart(16, "0");
  return `${String(sequence).padStart(16, "0")}_${word}`;
}

function digest(letter) {
  return `sha256:${letter.repeat(64)}`;
}
