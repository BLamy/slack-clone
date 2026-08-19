import {
  completeConversationBatch,
  planConversationSchedule,
  replayConversationSchedule,
  validateSchedule,
} from "@stream-slack/protocol";

export const CONVERSATION_SCHEDULER_EVENT_KINDS = Object.freeze([
  "conversation.schedule.planned",
  "conversation.batch.completed",
]);

/**
 * Keep scheduling decisions pure and make provider execution an explicit,
 * one-call boundary. The caller can persist the returned journal records to a
 * Durable Streams audit/run stream; no provider callback is reachable while a
 * source has a non-running disposition.
 */
export function createConversationScheduler({ record = async () => {} } = {}) {
  if (typeof record !== "function") {
    throw new TypeError("conversation scheduler record must be a function");
  }

  let schedule = null;
  const journal = [];

  async function plan(input) {
    const next = planConversationSchedule(input);
    schedule = next;
    const entry = Object.freeze({
      batchCount: next.batches.length,
      finalScheduleDigest: next.finalScheduleDigest,
      kind: "conversation.schedule.planned",
      refusalCount: next.refusals.length,
      scheduleDigest: next.scheduleDigest,
      sourceCount: next.queueOrder.length,
      workspaceId: next.workspaceId,
    });
    journal.push(entry);
    await record(structuredClone(entry));
    return structuredClone(next);
  }

  async function executeBatch({ batchId, provider, resultDigest = null } = {}) {
    if (!schedule)
      throw new Error("conversation scheduler has no planned schedule");
    if (typeof provider !== "function") {
      throw new TypeError("conversation scheduler provider must be a function");
    }
    const batch = schedule.batches.find(
      (candidate) => candidate.batchId === batchId,
    );
    if (!batch) throw new Error("conversation scheduler batch is not planned");
    if (
      schedule.terminalDispositions.some((entry) => entry.batchId === batchId)
    ) {
      throw new Error("conversation scheduler batch is already terminal");
    }
    const providerResult = await provider(structuredClone(batch));
    schedule = completeConversationBatch(schedule, batchId, {
      disposition: "completed",
      resultDigest,
    });
    const entry = Object.freeze({
      batchId,
      finalScheduleDigest: schedule.finalScheduleDigest,
      invocationIds: [...batch.memberInvocationIds],
      kind: "conversation.batch.completed",
      resultDigest,
      scheduleDigest: schedule.scheduleDigest,
      workspaceId: schedule.workspaceId,
    });
    journal.push(entry);
    await record(structuredClone(entry));
    return {
      batch: structuredClone(batch),
      providerResult,
      schedule: structuredClone(schedule),
    };
  }

  function complete(batchId, options) {
    if (!schedule)
      throw new Error("conversation scheduler has no planned schedule");
    schedule = completeConversationBatch(schedule, batchId, options);
    return structuredClone(schedule);
  }

  function getSchedule() {
    return schedule ? structuredClone(schedule) : null;
  }

  function getJournal() {
    return structuredClone(journal);
  }

  function replay() {
    if (!schedule)
      throw new Error("conversation scheduler has no planned schedule");
    return replayConversationSchedule(schedule);
  }

  return Object.freeze({
    complete,
    executeBatch,
    getJournal,
    getSchedule,
    plan,
    replay,
  });
}

export { replayConversationSchedule, validateSchedule };
