import assert from "node:assert/strict";
import test from "node:test";

import {
  completeConversationBatch,
  CONVERSATION_SCHEDULER_ERROR_CODES,
  deriveConversationKey,
  planConversationSchedule,
  replayConversationSchedule,
} from "@stream-slack/protocol";
import { createConversationScheduler } from "../../src/ledger/conversation-scheduler.mjs";
import {
  AGENT_A,
  AGENT_A_PRINCIPAL,
  AGENT_B,
  AGENT_C,
  CHANNEL_A,
  WORKSPACE_ID,
  makeActive,
  makeDelegatedChild,
  makeHistory,
  makeItem,
  makePolicy,
} from "../support/conversation-scheduler-fixture.mjs";

test("conversation keys and serialized batches are deterministic", () => {
  const items = [
    makeItem({ index: 3, invocationLetter: "c" }),
    makeItem({ index: 1, invocationLetter: "a" }),
    makeItem({ index: 2, invocationLetter: "b" }),
  ];
  const first = planConversationSchedule({
    queued: items,
    workspaceId: WORKSPACE_ID,
  });
  const second = planConversationSchedule({
    queued: [...items].reverse(),
    workspaceId: WORKSPACE_ID,
  });

  assert.equal(
    first.concurrencyKeys[items[0].invocationId],
    deriveConversationKey({
      agentId: items[0].agentId,
      channelId: CHANNEL_A,
      threadId: null,
      workspaceId: WORKSPACE_ID,
    }),
  );
  assert.deepEqual(first.queueOrder, [
    items[1].invocationId,
    items[2].invocationId,
    items[0].invocationId,
  ]);
  assert.equal(first.batches.length, 1);
  assert.deepEqual(first.batches[0].memberInvocationIds, first.queueOrder);
  assert.equal(first.scheduleDigest, second.scheduleDigest);
  assert.equal(first.finalScheduleDigest, second.finalScheduleDigest);
});

test("an active conversation queues while an independent key remains fair", () => {
  const activeItem = makeItem({ index: 1, invocationLetter: "a" });
  const blocked = makeItem({ index: 2, invocationLetter: "b" });
  const independent = makeItem({
    agentId: AGENT_B,
    index: 3,
    invocationLetter: "c",
  });
  const schedule = planConversationSchedule({
    active: [makeActive(activeItem)],
    queued: [blocked, independent],
    workspaceId: WORKSPACE_ID,
  });

  assert.equal(
    schedule.decisions.find(
      (item) => item.invocationId === blocked.invocationId,
    ).status,
    "queued",
  );
  assert.equal(
    schedule.decisions.find(
      (item) => item.invocationId === blocked.invocationId,
    ).code,
    CONVERSATION_SCHEDULER_ERROR_CODES.CONVERSATION_ACTIVE,
  );
  assert.equal(
    schedule.decisions.find(
      (item) => item.invocationId === independent.invocationId,
    ).status,
    "admitted",
  );
});

test("one provider call completes every source in a batch", async () => {
  let providerCalls = 0;
  const scheduler = createConversationScheduler();
  const items = [
    makeItem({ index: 1, invocationLetter: "a" }),
    makeItem({ index: 2, invocationLetter: "b" }),
  ];
  const planned = await scheduler.plan({
    queued: items,
    workspaceId: WORKSPACE_ID,
  });
  const result = await scheduler.executeBatch({
    batchId: planned.batches[0].batchId,
    provider: async (batch) => {
      providerCalls += 1;
      assert.deepEqual(batch.memberInvocationIds, [
        items[0].invocationId,
        items[1].invocationId,
      ]);
      return { provider: "scripted", ok: true };
    },
  });

  assert.equal(providerCalls, 1);
  assert.equal(result.schedule.terminalDispositions.length, 2);
  assert.ok(
    result.schedule.terminalDispositions.every(
      (entry) => entry.status === "terminal",
    ),
  );
  assert.equal(scheduler.replay().terminalCount, 2);
});

test("non-canonical, replayed, and self-authored sources are terminal refusals", () => {
  const self = makeItem({
    agentId: AGENT_A,
    authorAgentId: AGENT_A,
    authorId: AGENT_A_PRINCIPAL,
    authorKind: "agent",
    index: 1,
    invocationLetter: "a",
  });
  const quoted = makeItem({
    index: 2,
    invocationLetter: "b",
    mentionKind: "quoted",
  });
  const edited = makeItem({
    eventType: "channel.message.edited",
    index: 3,
    invocationLetter: "c",
    isEdit: true,
  });
  const retried = makeItem({ index: 4, invocationLetter: "d", isRetry: true });
  const agentReply = makeItem({
    authorAgentId: AGENT_A,
    authorId: AGENT_A_PRINCIPAL,
    authorKind: "agent",
    index: 5,
    invocationLetter: "e",
    isAgentReply: true,
  });
  const replay = makeItem({ index: 6, invocationLetter: "f" });
  const schedule = planConversationSchedule({
    history: [makeHistory(replay)],
    queued: [self, quoted, edited, retried, agentReply, replay],
    workspaceId: WORKSPACE_ID,
  });

  const codes = new Map(
    schedule.refusals.map((refusal) => [refusal.invocationId, refusal.code]),
  );
  assert.equal(
    codes.get(self.invocationId),
    CONVERSATION_SCHEDULER_ERROR_CODES.SELF_TRIGGER,
  );
  assert.equal(
    codes.get(quoted.invocationId),
    CONVERSATION_SCHEDULER_ERROR_CODES.QUOTED_MENTION,
  );
  assert.equal(
    codes.get(edited.invocationId),
    CONVERSATION_SCHEDULER_ERROR_CODES.EDIT_TRIGGER,
  );
  assert.equal(
    codes.get(retried.invocationId),
    CONVERSATION_SCHEDULER_ERROR_CODES.RETRY_TRIGGER,
  );
  assert.equal(
    codes.get(agentReply.invocationId),
    CONVERSATION_SCHEDULER_ERROR_CODES.AGENT_REPLY,
  );
  assert.equal(
    codes.get(replay.invocationId),
    CONVERSATION_SCHEDULER_ERROR_CODES.REPLAYED_SOURCE,
  );
  assert.equal(schedule.batches.length, 0);
});

test("delegation requires a current grant and rejects cycles, limits, and budget", () => {
  const missingGrant = makeItem({
    agentId: AGENT_B,
    authorAgentId: AGENT_A,
    authorId: AGENT_A_PRINCIPAL,
    authorKind: "agent",
    index: 1,
    invocationLetter: "a",
  });
  const revoked = makeDelegatedChild({ index: 2, invocationLetter: "b" });
  revoked.causation.delegationGrant.status = "revoked";
  const cycle = makeDelegatedChild({ index: 3, invocationLetter: "c" });
  cycle.causation.ancestors = [
    {
      agentId: AGENT_B,
      invocationId: `iv_${"c".repeat(26)}`,
      sourceRef: cycle.sourceTrigger,
    },
  ];
  cycle.causation.parentInvocationId = `iv_${"c".repeat(26)}`;
  cycle.causation.rootInvocationId = `iv_${"c".repeat(26)}`;
  const depth = makeDelegatedChild({
    index: 4,
    invocationLetter: "d",
    policy: makePolicy({
      delegation: {
        allowCrossChannel: false,
        enabled: true,
        maxChildren: 2,
        maxDepth: 1,
      },
    }),
  });
  depth.causation.ancestors = [
    {
      agentId: AGENT_A,
      invocationId: `iv_${"a".repeat(26)}`,
      sourceRef: depth.sourceTrigger,
    },
    {
      agentId: AGENT_C,
      invocationId: `iv_${"b".repeat(26)}`,
      sourceRef: depth.sourceTrigger,
    },
  ];
  depth.causation.parentInvocationId = `iv_${"b".repeat(26)}`;
  depth.causation.rootInvocationId = `iv_${"a".repeat(26)}`;
  const fanout = makeDelegatedChild({ index: 5, invocationLetter: "e" });
  const fanoutA = makeDelegatedChild({ index: 6, invocationLetter: "f" });
  const fanoutB = makeDelegatedChild({ index: 7, invocationLetter: "g" });
  const activeDelegation = makeDelegatedChild({
    index: 18,
    invocationLetter: "j",
  });
  const concurrency = makeDelegatedChild({
    index: 8,
    invocationLetter: "h",
    parent: `iv_${"z".repeat(26)}`,
  });
  const budget = makeDelegatedChild({
    index: 9,
    invocationLetter: "q",
    parent: `iv_${"y".repeat(26)}`,
  });
  budget.causation.aggregateBudget = {
    costUsdCents: 0,
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
  };

  const schedule = planConversationSchedule({
    active: [makeActive(activeDelegation)],
    history: [makeHistory(fanoutA), makeHistory(fanoutB)],
    queued: [missingGrant, revoked, cycle, depth, fanout, concurrency, budget],
    workspaceId: WORKSPACE_ID,
  });
  const codes = new Map(
    schedule.refusals.map((refusal) => [refusal.invocationId, refusal.code]),
  );
  assert.equal(
    codes.get(missingGrant.invocationId),
    CONVERSATION_SCHEDULER_ERROR_CODES.DELEGATION_REQUIRED,
  );
  assert.equal(
    codes.get(revoked.invocationId),
    CONVERSATION_SCHEDULER_ERROR_CODES.DELEGATION_REVOKED,
  );
  assert.equal(
    codes.get(cycle.invocationId),
    CONVERSATION_SCHEDULER_ERROR_CODES.CYCLE,
  );
  assert.equal(
    codes.get(depth.invocationId),
    CONVERSATION_SCHEDULER_ERROR_CODES.DELEGATION_DEPTH,
  );
  assert.equal(
    codes.get(fanout.invocationId),
    CONVERSATION_SCHEDULER_ERROR_CODES.DELEGATION_FANOUT,
  );
  assert.equal(
    codes.get(concurrency.invocationId),
    CONVERSATION_SCHEDULER_ERROR_CODES.DELEGATION_CONCURRENCY,
  );
  assert.equal(
    codes.get(budget.invocationId),
    CONVERSATION_SCHEDULER_ERROR_CODES.BUDGET_EXCEEDED,
  );
});

test("completed schedules remain replayable and mutation is detected", () => {
  const item = makeItem({ index: 1, invocationLetter: "a" });
  const schedule = planConversationSchedule({
    queued: [item],
    workspaceId: WORKSPACE_ID,
  });
  const completed = completeConversationBatch(
    schedule,
    schedule.batches[0].batchId,
    {
      disposition: "completed",
    },
  );
  assert.equal(replayConversationSchedule(completed).terminalCount, 1);
  const tampered = structuredClone(completed);
  tampered.decisions[0].status = "queued";
  assert.throws(
    () => replayConversationSchedule(tampered),
    (error) => error.code === CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
  );
});
