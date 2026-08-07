import { validateChannelId } from "./channels.mjs";
import { validateAgentConfigAgentId } from "./agent-config-revisions.mjs";
import { assertSourceReference } from "./invocation-run.mjs";
import { validatePrincipalId, validateWorkspaceId } from "./principals.mjs";
import { sha256Digest } from "./sha256.mjs";

export const CONVERSATION_SCHEDULER_SCHEMA_VERSION = 1;

export const CONVERSATION_SCHEDULER_ERROR_CODES = Object.freeze({
  AGENT_REPLY: "CONVERSATION_SCHEDULER_AGENT_REPLY",
  BUDGET_EXCEEDED: "CONVERSATION_SCHEDULER_BUDGET_EXCEEDED",
  CONCURRENCY_LIMIT: "CONVERSATION_SCHEDULER_CONCURRENCY_LIMIT",
  CONVERSATION_ACTIVE: "CONVERSATION_SCHEDULER_CONVERSATION_ACTIVE",
  CYCLE: "CONVERSATION_SCHEDULER_CYCLE",
  DELEGATION_CONCURRENCY: "CONVERSATION_SCHEDULER_DELEGATION_CONCURRENCY",
  DELEGATION_DEPTH: "CONVERSATION_SCHEDULER_DELEGATION_DEPTH",
  DELEGATION_FANOUT: "CONVERSATION_SCHEDULER_DELEGATION_FANOUT",
  DELEGATION_REQUIRED: "CONVERSATION_SCHEDULER_DELEGATION_REQUIRED",
  DELEGATION_SCOPE: "CONVERSATION_SCHEDULER_DELEGATION_SCOPE",
  DELEGATION_REVOKED: "CONVERSATION_SCHEDULER_DELEGATION_REVOKED",
  DUPLICATE_SOURCE: "CONVERSATION_SCHEDULER_DUPLICATE_SOURCE",
  EDIT_TRIGGER: "CONVERSATION_SCHEDULER_EDIT_TRIGGER",
  INVALID_CAUSATION: "CONVERSATION_SCHEDULER_INVALID_CAUSATION",
  INVALID_DATA: "CONVERSATION_SCHEDULER_INVALID_DATA",
  INVALID_POLICY: "CONVERSATION_SCHEDULER_INVALID_POLICY",
  INVALID_SOURCE: "CONVERSATION_SCHEDULER_INVALID_SOURCE",
  NON_CANONICAL_MENTION: "CONVERSATION_SCHEDULER_NON_CANONICAL_MENTION",
  QUOTED_MENTION: "CONVERSATION_SCHEDULER_QUOTED_MENTION",
  REPLAYED_SOURCE: "CONVERSATION_SCHEDULER_REPLAYED_SOURCE",
  RETRY_TRIGGER: "CONVERSATION_SCHEDULER_RETRY_TRIGGER",
  SELF_TRIGGER: "CONVERSATION_SCHEDULER_SELF_TRIGGER",
});

const ID_TOKEN = "[0-9a-hjkmnp-tv-z]{26}";
const INVOCATION_PATTERN = new RegExp(`^iv_${ID_TOKEN}$`, "u");
const BATCH_PATTERN = /^bt_[0-9a-f]{26}$/u;
const CONVERSATION_PATTERN = /^ck_[0-9a-f]{26}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;
const THREAD_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;
const SOURCE_EVENT_TYPES = new Set([
  "channel.message.created",
  "channel.message.replied",
  "channel.message.edited",
  "channel.message.deleted",
]);
const MENTION_KINDS = new Set(["canonical", "quoted", "code", "none"]);
const SCHEDULABLE_STATUSES = new Set([
  "admitted",
  "completed",
  "failed",
  "non-running",
  "queued",
]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "non-running"]);
const USAGE_KEYS = [
  "costUsdCents",
  "inputTokens",
  "outputTokens",
  "totalTokens",
];
const POLICY_KEYS = ["budgets", "concurrency", "delegation"];
const BUDGET_KEYS = [
  "maxCostUsdCents",
  "maxInputTokens",
  "maxOutputTokens",
  "maxTotalTokens",
];
const CONCURRENCY_KEYS = [
  "maxConcurrentPerChannel",
  "maxConcurrentRuns",
  "queueStrategy",
];
const DELEGATION_KEYS = [
  "allowCrossChannel",
  "enabled",
  "maxChildren",
  "maxDepth",
];

export class ConversationSchedulingError extends Error {
  constructor(code, detail, path = "$") {
    super(`${code} at ${path}: ${detail}`);
    this.name = "ConversationSchedulingError";
    this.code = code;
    this.detail = detail;
    this.path = path;
  }

  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      name: this.name,
      path: this.path,
    };
  }
}

export function deriveConversationKey({
  agentId,
  channelId,
  threadId = null,
  workspaceId,
} = {}) {
  validateWorkspaceId(workspaceId);
  validateAgentConfigAgentId(agentId, { expectedWorkspaceId: workspaceId });
  validateChannelId(channelId, { expectedWorkspaceId: workspaceId });
  validateThreadId(threadId, "$.threadId");
  return `ck_${hex(
    sha256Digest(
      canonicalJson({
        agentId,
        channelId,
        threadId,
        workspaceId,
      }),
    ),
  ).slice(0, 26)}`;
}

export function conversationPolicyDigest(policy) {
  validateConversationPolicy(policy);
  return digestCanonical(policy);
}

export function validateConversationPolicy(value, path = "$.policy") {
  assertExactKeys(value, POLICY_KEYS, path);
  validateBudget(value.budgets, `${path}.budgets`);
  validateConcurrency(value.concurrency, `${path}.concurrency`);
  validateDelegation(value.delegation, `${path}.delegation`);
  return value;
}

export function validateSchedulingItem(value, { expectedWorkspaceId } = {}) {
  const path = "$.item";
  assertExactKeys(
    value,
    [
      "agentId",
      "causation",
      "conversation",
      "estimatedUsage",
      "invocationId",
      "invocationRef",
      "policy",
      "policyDigest",
      "snapshotDigest",
      "source",
      "sourceTrigger",
      "workspaceId",
    ],
    path,
  );
  validateWorkspaceId(value.workspaceId, `${path}.workspaceId`);
  if (
    expectedWorkspaceId !== undefined &&
    value.workspaceId !== expectedWorkspaceId
  ) {
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
      `${path}.workspaceId`,
      "item belongs to another workspace",
    );
  }
  validateAgentConfigAgentId(value.agentId, {
    expectedWorkspaceId: value.workspaceId,
    path: `${path}.agentId`,
  });
  assertInvocationId(value.invocationId, `${path}.invocationId`);
  assertSource(value.invocationRef, `${path}.invocationRef`, value.workspaceId);
  assertSource(
    value.sourceTrigger,
    `${path}.sourceTrigger`,
    value.workspaceId,
    { channelOnly: true },
  );
  validateDigest(value.snapshotDigest, `${path}.snapshotDigest`);
  validateConversationPolicy(value.policy, `${path}.policy`);
  validateDigest(value.policyDigest, `${path}.policyDigest`);
  if (conversationPolicyDigest(value.policy) !== value.policyDigest) {
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_POLICY,
      `${path}.policyDigest`,
      "policyDigest does not match the canonical scheduler policy",
    );
  }
  validateConversation(value.conversation, value.workspaceId, path);
  validateUsage(value.estimatedUsage, `${path}.estimatedUsage`);
  validateSource(value.source, value.workspaceId, path);
  validateCausation(value.causation, value.workspaceId, value.agentId, path);
  return value;
}

export function validateActiveConversationRun(
  value,
  { expectedWorkspaceId } = {},
) {
  const path = "$.activeRun";
  assertExactKeys(
    value,
    [
      "agentId",
      "batchId",
      "channelId",
      "conversationKey",
      "invocationId",
      "sourceRef",
      "threadId",
      "workspaceId",
    ],
    path,
  );
  validateWorkspaceId(value.workspaceId, `${path}.workspaceId`);
  if (
    expectedWorkspaceId !== undefined &&
    value.workspaceId !== expectedWorkspaceId
  ) {
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
      `${path}.workspaceId`,
      "active run belongs to another workspace",
    );
  }
  validateAgentConfigAgentId(value.agentId, {
    expectedWorkspaceId: value.workspaceId,
    path: `${path}.agentId`,
  });
  assertInvocationId(value.invocationId, `${path}.invocationId`);
  assertToken(value.batchId, `${path}.batchId`);
  validateChannelId(value.channelId, {
    expectedWorkspaceId: value.workspaceId,
    path: `${path}.channelId`,
  });
  validateThreadId(value.threadId, `${path}.threadId`);
  assertConversationKey(value.conversationKey, `${path}.conversationKey`);
  const expectedKey = deriveConversationKey({
    agentId: value.agentId,
    channelId: value.channelId,
    threadId: value.threadId,
    workspaceId: value.workspaceId,
  });
  if (value.conversationKey !== expectedKey) {
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
      `${path}.conversationKey`,
      "conversation key is not derived from the active run scope",
    );
  }
  assertSource(value.sourceRef, `${path}.sourceRef`, value.workspaceId);
  return value;
}

export function validateScheduleHistory(value, { expectedWorkspaceId } = {}) {
  const path = "$.history";
  if (!Array.isArray(value))
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
      path,
      "history must be an array",
    );
  return value.map((record, index) => {
    const recordPath = `${path}[${index}]`;
    assertExactKeys(
      record,
      [
        "agentId",
        "conversationKey",
        "invocationId",
        "parentInvocationId",
        "sourceRef",
        "status",
        "workspaceId",
      ],
      recordPath,
    );
    validateWorkspaceId(record.workspaceId, `${recordPath}.workspaceId`);
    if (
      expectedWorkspaceId !== undefined &&
      record.workspaceId !== expectedWorkspaceId
    ) {
      fail(
        CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
        `${recordPath}.workspaceId`,
        "history record belongs to another workspace",
      );
    }
    validateAgentConfigAgentId(record.agentId, {
      expectedWorkspaceId: record.workspaceId,
      path: `${recordPath}.agentId`,
    });
    assertInvocationId(record.invocationId, `${recordPath}.invocationId`);
    if (record.parentInvocationId !== null) {
      assertInvocationId(
        record.parentInvocationId,
        `${recordPath}.parentInvocationId`,
      );
    }
    assertSource(
      record.sourceRef,
      `${recordPath}.sourceRef`,
      record.workspaceId,
    );
    if (!SCHEDULABLE_STATUSES.has(record.status)) {
      fail(
        CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
        `${recordPath}.status`,
        "history status is not registered",
      );
    }
    return record;
  });
}

export function planConversationSchedule({
  active = [],
  history = [],
  queued = [],
  workspaceId,
} = {}) {
  validateWorkspaceId(workspaceId);
  if (!Array.isArray(active))
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
      "$.active",
      "active must be an array",
    );
  if (!Array.isArray(queued))
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
      "$.queued",
      "queued must be an array",
    );
  const normalizedActive = active.map((value) =>
    validateActiveConversationRun(value, { expectedWorkspaceId: workspaceId }),
  );
  const normalizedHistory = validateScheduleHistory(history, {
    expectedWorkspaceId: workspaceId,
  });
  const normalizedQueued = queued
    .map((value) =>
      validateSchedulingItem(value, { expectedWorkspaceId: workspaceId }),
    )
    .sort(compareItems);

  const seenInvocations = new Set();
  const seenSources = new Set();
  for (const record of normalizedHistory) {
    seenInvocations.add(record.invocationId);
    seenSources.add(sourceIdentity(record.sourceRef));
  }
  for (const run of normalizedActive) seenInvocations.add(run.invocationId);

  const activeKeys = new Set(
    normalizedActive.map((run) => run.conversationKey),
  );
  const activeAgents = countBy(normalizedActive, (run) => run.agentId);
  const activeChannels = countBy(
    normalizedActive,
    (run) => `${run.agentId}\u0000${run.channelId}`,
  );
  const childCounts = countBy(
    normalizedHistory.filter((record) => record.parentInvocationId !== null),
    (record) => record.parentInvocationId,
  );
  const delegatedConcurrency = countBy(normalizedActive, (run) => run.agentId);
  const decisions = [];
  const refusals = [];
  const batches = [];
  const batchesByKey = new Map();
  const queuedOrder = normalizedQueued.map((item) => item.invocationId);
  const causationGraph = normalizedQueued.map((item) => ({
    agentId: item.agentId,
    ancestors: item.causation.ancestors,
    depth: item.causation.ancestors.length,
    invocationId: item.invocationId,
    parentInvocationId: item.causation.parentInvocationId,
    rootInvocationId: item.causation.rootInvocationId,
    sourceTrigger: item.sourceTrigger,
  }));

  for (const item of normalizedQueued) {
    const sourceId = sourceIdentity(item.sourceTrigger);
    const duplicateInvocation = seenInvocations.has(item.invocationId);
    const duplicateSource = seenSources.has(sourceId);
    const refusalCode = duplicateInvocation
      ? CONVERSATION_SCHEDULER_ERROR_CODES.REPLAYED_SOURCE
      : duplicateSource
        ? CONVERSATION_SCHEDULER_ERROR_CODES.DUPLICATE_SOURCE
        : refusalFor(item, { childCounts, delegatedConcurrency });
    seenInvocations.add(item.invocationId);
    seenSources.add(sourceId);

    if (refusalCode) {
      const decision = decisionFor(item, {
        batchId: null,
        code: refusalCode,
        status: "non-running",
        terminal: true,
      });
      decisions.push(decision);
      refusals.push(decision);
      continue;
    }

    const key = itemConversationKey(item);
    const existingBatch = batchesByKey.get(key);
    if (existingBatch && canBatch(existingBatch, item)) {
      existingBatch.members.push(
        batchMember(item, existingBatch.members.length),
      );
      existingBatch.memberInvocationIds.push(item.invocationId);
      incrementCausationCounts(item, childCounts, delegatedConcurrency);
      decisions.push(
        decisionFor(item, {
          batchId: existingBatch.batchId,
          code: null,
          status: "admitted",
          terminal: false,
        }),
      );
      continue;
    }

    const blockedCode = blockedByCapacity(item, {
      activeAgents,
      activeChannels,
      activeKeys,
    });
    if (blockedCode) {
      decisions.push(
        decisionFor(item, {
          batchId: null,
          code: blockedCode,
          status: "queued",
          terminal: false,
        }),
      );
      continue;
    }

    const batch = {
      agentId: item.agentId,
      batchId: deriveBatchId(item, item.invocationId),
      conversationKey: key,
      memberInvocationIds: [item.invocationId],
      members: [batchMember(item, 0)],
      policyDigest: item.policyDigest,
      snapshotDigest: item.snapshotDigest,
      sourceInvocationCount: 1,
      status: "admitted",
      workspaceId,
    };
    batchesByKey.set(key, batch);
    batches.push(batch);
    activeKeys.add(key);
    incrementCount(activeAgents, item.agentId);
    incrementCount(
      activeChannels,
      `${item.agentId}\u0000${item.conversation.channelId}`,
    );
    incrementCausationCounts(item, childCounts, delegatedConcurrency);
    decisions.push(
      decisionFor(item, {
        batchId: batch.batchId,
        code: null,
        status: "admitted",
        terminal: false,
      }),
    );
  }

  const terminalDispositions = refusals.map((decision) => ({
    batchId: null,
    code: decision.code,
    disposition: "non-running",
    invocationId: decision.invocationId,
    sourceTrigger: decision.sourceTrigger,
    status: "terminal",
  }));
  const payload = {
    batches: batches.map((batch) => freezeCopy(batch)),
    causationGraph,
    concurrencyKeys: Object.fromEntries(
      normalizedQueued.map((item) => [
        item.invocationId,
        itemConversationKey(item),
      ]),
    ),
    decisions,
    queueOrder: queuedOrder,
    refusals,
    schemaVersion: CONVERSATION_SCHEDULER_SCHEMA_VERSION,
    workspaceId,
  };
  const schedule = {
    ...payload,
    finalScheduleDigest: digestCanonical({ ...payload, terminalDispositions }),
    scheduleDigest: digestCanonical(payload),
    terminalDispositions,
  };
  return freezeCopy(schedule);
}

export function completeConversationBatch(
  schedule,
  batchId,
  { disposition = "completed", resultDigest = null } = {},
) {
  validateSchedule(schedule);
  assertBatchId(batchId, "$.batchId");
  if (!TERMINAL_STATUSES.has(disposition) || disposition === "non-running") {
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
      "$.disposition",
      "batch disposition must be completed or failed",
    );
  }
  if (resultDigest !== null) validateDigest(resultDigest, "$.resultDigest");
  const batch = schedule.batches.find(
    (candidate) => candidate.batchId === batchId,
  );
  if (!batch) {
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
      "$.batchId",
      "batch does not exist in this schedule",
    );
  }
  if (
    schedule.terminalDispositions.some((entry) => entry.batchId === batchId)
  ) {
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.DUPLICATE_SOURCE,
      "$.batchId",
      "batch already has a terminal disposition",
    );
  }
  const completions = batch.members.map((member) => ({
    batchId,
    disposition,
    invocationId: member.invocationId,
    resultDigest,
    sourceTrigger: member.sourceTrigger,
    status: "terminal",
  }));
  const terminalDispositions = [
    ...schedule.terminalDispositions,
    ...completions,
  ];
  const withoutFinal = { ...schedule };
  delete withoutFinal.finalScheduleDigest;
  delete withoutFinal.scheduleDigest;
  const next = {
    ...withoutFinal,
    finalScheduleDigest: digestCanonical({
      ...withoutFinal,
      terminalDispositions,
    }),
    scheduleDigest: schedule.scheduleDigest,
    terminalDispositions,
  };
  return freezeCopy(next);
}

export function replayConversationSchedule(value) {
  validateSchedule(value);
  const payload = {
    batches: value.batches,
    causationGraph: value.causationGraph,
    concurrencyKeys: value.concurrencyKeys,
    decisions: value.decisions,
    queueOrder: value.queueOrder,
    refusals: value.refusals,
    schemaVersion: value.schemaVersion,
    workspaceId: value.workspaceId,
  };
  if (digestCanonical(payload) !== value.scheduleDigest) {
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
      "$.scheduleDigest",
      "schedule digest does not match the canonical schedule",
    );
  }
  const finalPayload = {
    ...payload,
    terminalDispositions: value.terminalDispositions,
  };
  if (digestCanonical(finalPayload) !== value.finalScheduleDigest) {
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
      "$.finalScheduleDigest",
      "final schedule digest does not match terminal dispositions",
    );
  }
  const decisionIds = new Set(
    value.decisions.map((decision) => decision.invocationId),
  );
  if (decisionIds.size !== value.decisions.length) {
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.DUPLICATE_SOURCE,
      "$.decisions",
      "an invocation has more than one scheduling decision",
    );
  }
  const terminalIds = new Set();
  for (const disposition of value.terminalDispositions) {
    if (terminalIds.has(disposition.invocationId)) {
      fail(
        CONVERSATION_SCHEDULER_ERROR_CODES.DUPLICATE_SOURCE,
        "$.terminalDispositions",
        "an invocation has more than one terminal disposition",
      );
    }
    terminalIds.add(disposition.invocationId);
  }
  for (const batch of value.batches) {
    for (const member of batch.members) {
      const decision = value.decisions.find(
        (candidate) => candidate.invocationId === member.invocationId,
      );
      if (
        !decision ||
        decision.batchId !== batch.batchId ||
        decision.status !== "admitted"
      ) {
        fail(
          CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
          "$.batches",
          "batch member does not have its matching admitted decision",
        );
      }
    }
  }
  return Object.freeze({
    finalScheduleDigest: value.finalScheduleDigest,
    scheduleDigest: value.scheduleDigest,
    terminalCount: value.terminalDispositions.length,
    workspaceId: value.workspaceId,
  });
}

export function validateSchedule(value) {
  assertExactKeys(
    value,
    [
      "batches",
      "causationGraph",
      "concurrencyKeys",
      "decisions",
      "finalScheduleDigest",
      "queueOrder",
      "refusals",
      "schemaVersion",
      "scheduleDigest",
      "terminalDispositions",
      "workspaceId",
    ],
    "$.schedule",
  );
  validateWorkspaceId(value.workspaceId, "$.schedule.workspaceId");
  if (value.schemaVersion !== CONVERSATION_SCHEDULER_SCHEMA_VERSION) {
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
      "$.schedule.schemaVersion",
      "unsupported conversation scheduler schema version",
    );
  }
  if (!Array.isArray(value.queueOrder))
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
      "$.schedule.queueOrder",
      "queueOrder must be an array",
    );
  if (!Array.isArray(value.batches))
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
      "$.schedule.batches",
      "batches must be an array",
    );
  if (!Array.isArray(value.decisions))
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
      "$.schedule.decisions",
      "decisions must be an array",
    );
  if (!Array.isArray(value.refusals))
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
      "$.schedule.refusals",
      "refusals must be an array",
    );
  if (!Array.isArray(value.terminalDispositions))
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
      "$.schedule.terminalDispositions",
      "terminal dispositions must be an array",
    );
  validateDigest(value.scheduleDigest, "$.schedule.scheduleDigest");
  validateDigest(value.finalScheduleDigest, "$.schedule.finalScheduleDigest");
  return value;
}

function refusalFor(item, { childCounts, delegatedConcurrency }) {
  const source = item.source;
  if (source.isReplay)
    return CONVERSATION_SCHEDULER_ERROR_CODES.REPLAYED_SOURCE;
  if (source.isRetry) return CONVERSATION_SCHEDULER_ERROR_CODES.RETRY_TRIGGER;
  if (source.isEdit || source.eventType === "channel.message.edited") {
    return CONVERSATION_SCHEDULER_ERROR_CODES.EDIT_TRIGGER;
  }
  if (source.isAgentReply)
    return CONVERSATION_SCHEDULER_ERROR_CODES.AGENT_REPLY;
  if (source.mentionKind === "quoted" || source.mentionKind === "code") {
    return CONVERSATION_SCHEDULER_ERROR_CODES.QUOTED_MENTION;
  }
  if (source.mentionKind !== "canonical") {
    return CONVERSATION_SCHEDULER_ERROR_CODES.NON_CANONICAL_MENTION;
  }
  if (
    source.eventType !== "channel.message.created" &&
    source.eventType !== "channel.message.replied"
  ) {
    return CONVERSATION_SCHEDULER_ERROR_CODES.NON_CANONICAL_MENTION;
  }
  if (source.authorKind === "agent" && source.authorAgentId === item.agentId) {
    return CONVERSATION_SCHEDULER_ERROR_CODES.SELF_TRIGGER;
  }
  const ancestors = item.causation.ancestors;
  if (ancestors.some((ancestor) => ancestor.agentId === item.agentId)) {
    return CONVERSATION_SCHEDULER_ERROR_CODES.CYCLE;
  }
  const nextUsage = addUsage(
    item.causation.aggregateUsage,
    item.estimatedUsage,
  );
  if (!withinUsage(nextUsage, item.causation.aggregateBudget)) {
    return CONVERSATION_SCHEDULER_ERROR_CODES.BUDGET_EXCEEDED;
  }
  if (source.authorKind !== "agent") return null;
  const grant = item.causation.delegationGrant;
  if (!item.policy.delegation.enabled || !grant) {
    return CONVERSATION_SCHEDULER_ERROR_CODES.DELEGATION_REQUIRED;
  }
  if (grant.status !== "active") {
    return CONVERSATION_SCHEDULER_ERROR_CODES.DELEGATION_REVOKED;
  }
  if (
    grant.sourceAgentId !== source.authorAgentId ||
    grant.targetAgentId !== item.agentId
  ) {
    return CONVERSATION_SCHEDULER_ERROR_CODES.DELEGATION_SCOPE;
  }
  if (
    !item.policy.delegation.allowCrossChannel &&
    grant.sourceChannelId !== item.conversation.channelId
  ) {
    return CONVERSATION_SCHEDULER_ERROR_CODES.DELEGATION_SCOPE;
  }
  if (ancestors.length > item.policy.delegation.maxDepth) {
    return CONVERSATION_SCHEDULER_ERROR_CODES.DELEGATION_DEPTH;
  }
  const parent = item.causation.parentInvocationId;
  if (!parent) return CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_CAUSATION;
  if ((childCounts.get(parent) ?? 0) >= item.policy.delegation.maxChildren) {
    return CONVERSATION_SCHEDULER_ERROR_CODES.DELEGATION_FANOUT;
  }
  if ((delegatedConcurrency.get(item.agentId) ?? 0) >= grant.maxConcurrent) {
    return CONVERSATION_SCHEDULER_ERROR_CODES.DELEGATION_CONCURRENCY;
  }
  return null;
}

function blockedByCapacity(item, { activeAgents, activeChannels, activeKeys }) {
  const key = itemConversationKey(item);
  if (activeKeys.has(key)) {
    return CONVERSATION_SCHEDULER_ERROR_CODES.CONVERSATION_ACTIVE;
  }
  if (
    (activeAgents.get(item.agentId) ?? 0) >=
    item.policy.concurrency.maxConcurrentRuns
  ) {
    return CONVERSATION_SCHEDULER_ERROR_CODES.CONCURRENCY_LIMIT;
  }
  const channelKey = `${item.agentId}\u0000${item.conversation.channelId}`;
  if (
    (activeChannels.get(channelKey) ?? 0) >=
    item.policy.concurrency.maxConcurrentPerChannel
  ) {
    return CONVERSATION_SCHEDULER_ERROR_CODES.CONCURRENCY_LIMIT;
  }
  return null;
}

function canBatch(batch, item) {
  return (
    item.policy.concurrency.queueStrategy === "serialize" &&
    batch.policyDigest === item.policyDigest &&
    batch.snapshotDigest === item.snapshotDigest
  );
}

function decisionFor(item, { batchId, code, status, terminal }) {
  return {
    batchId,
    code,
    conversationKey: itemConversationKey(item),
    invocationId: item.invocationId,
    invocationRef: item.invocationRef,
    sourceTrigger: item.sourceTrigger,
    status,
    terminal,
  };
}

function batchMember(item, order) {
  return {
    invocationId: item.invocationId,
    invocationRef: item.invocationRef,
    order,
    sourceTrigger: item.sourceTrigger,
  };
}

function incrementCausationCounts(item, childCounts, delegatedConcurrency) {
  if (item.causation.parentInvocationId) {
    incrementCount(childCounts, item.causation.parentInvocationId);
  }
  if (item.source.authorKind === "agent") {
    incrementCount(delegatedConcurrency, item.agentId);
  }
}

function itemConversationKey(item) {
  return deriveConversationKey({
    agentId: item.agentId,
    channelId: item.conversation.channelId,
    threadId: item.conversation.threadId,
    workspaceId: item.workspaceId,
  });
}

function deriveBatchId(item, firstInvocationId) {
  return `bt_${hex(
    sha256Digest(
      canonicalJson({
        conversationKey: itemConversationKey(item),
        firstInvocationId,
        policyDigest: item.policyDigest,
        snapshotDigest: item.snapshotDigest,
        workspaceId: item.workspaceId,
      }),
    ),
  ).slice(0, 26)}`;
}

function validateConversation(value, workspaceId, path) {
  assertExactKeys(value, ["channelId", "threadId"], `${path}.conversation`);
  validateChannelId(value.channelId, {
    expectedWorkspaceId: workspaceId,
    path: `${path}.conversation.channelId`,
  });
  validateThreadId(value.threadId, `${path}.conversation.threadId`);
}

function validateSource(value, workspaceId, path) {
  const sourcePath = `${path}.source`;
  assertExactKeys(
    value,
    [
      "authorAgentId",
      "authorId",
      "authorKind",
      "eventType",
      "isAgentReply",
      "isEdit",
      "isReplay",
      "isRetry",
      "mentionKind",
    ],
    sourcePath,
  );
  if (!["agent", "human"].includes(value.authorKind)) {
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_SOURCE,
      `${sourcePath}.authorKind`,
      "author kind must be human or agent",
    );
  }
  validatePrincipalId(value.authorId, {
    expectedWorkspaceId: workspaceId,
    path: `${sourcePath}.authorId`,
  });
  if (value.authorAgentId === null) {
    if (value.authorKind === "agent")
      fail(
        CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_SOURCE,
        `${sourcePath}.authorAgentId`,
        "agent authors require their agent id",
      );
  } else {
    validateAgentConfigAgentId(value.authorAgentId, {
      expectedWorkspaceId: workspaceId,
      path: `${sourcePath}.authorAgentId`,
    });
    if (value.authorKind !== "agent")
      fail(
        CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_SOURCE,
        `${sourcePath}.authorAgentId`,
        "human authors cannot carry an agent id",
      );
  }
  if (!SOURCE_EVENT_TYPES.has(value.eventType))
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_SOURCE,
      `${sourcePath}.eventType`,
      "event type is not a channel message source",
    );
  if (!MENTION_KINDS.has(value.mentionKind))
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_SOURCE,
      `${sourcePath}.mentionKind`,
      "mention kind is not registered",
    );
  for (const key of ["isAgentReply", "isEdit", "isReplay", "isRetry"]) {
    if (typeof value[key] !== "boolean")
      fail(
        CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_SOURCE,
        `${sourcePath}.${key}`,
        "source flag must be boolean",
      );
  }
  if (value.isAgentReply && value.authorKind !== "agent")
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_SOURCE,
      `${sourcePath}.isAgentReply`,
      "agent reply flag requires an agent author",
    );
  return value;
}

function validateCausation(value, workspaceId, agentId, path) {
  const causationPath = `${path}.causation`;
  assertExactKeys(
    value,
    [
      "aggregateBudget",
      "aggregateUsage",
      "ancestors",
      "delegationGrant",
      "parentInvocationId",
      "rootInvocationId",
    ],
    causationPath,
  );
  assertInvocationId(
    value.rootInvocationId,
    `${causationPath}.rootInvocationId`,
  );
  if (value.parentInvocationId !== null)
    assertInvocationId(
      value.parentInvocationId,
      `${causationPath}.parentInvocationId`,
    );
  if (!Array.isArray(value.ancestors) || value.ancestors.length > 8)
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_CAUSATION,
      `${causationPath}.ancestors`,
      "causation ancestors must contain at most eight entries",
    );
  const ancestorIds = new Set();
  value.ancestors.forEach((ancestor, index) => {
    const ancestorPath = `${causationPath}.ancestors[${index}]`;
    assertExactKeys(
      ancestor,
      ["agentId", "invocationId", "sourceRef"],
      ancestorPath,
    );
    validateAgentConfigAgentId(ancestor.agentId, {
      expectedWorkspaceId: workspaceId,
      path: `${ancestorPath}.agentId`,
    });
    assertInvocationId(ancestor.invocationId, `${ancestorPath}.invocationId`);
    assertSource(ancestor.sourceRef, `${ancestorPath}.sourceRef`, workspaceId);
    if (ancestorIds.has(ancestor.invocationId))
      fail(
        CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_CAUSATION,
        `${ancestorPath}.invocationId`,
        "causation chain repeats an invocation",
      );
    ancestorIds.add(ancestor.invocationId);
  });
  if (value.ancestors.length === 0) {
    if (
      value.parentInvocationId !== null ||
      (value.rootInvocationId !== undefined && value.rootInvocationId === "")
    )
      fail(
        CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_CAUSATION,
        causationPath,
        "root causation cannot have a parent",
      );
  } else {
    const last = value.ancestors.at(-1);
    const first = value.ancestors[0];
    if (
      value.parentInvocationId !== last.invocationId ||
      value.rootInvocationId !== first.invocationId
    )
      fail(
        CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_CAUSATION,
        causationPath,
        "parent and root do not match the durable ancestor chain",
      );
  }
  validateUsage(value.aggregateUsage, `${causationPath}.aggregateUsage`);
  validateUsage(value.aggregateBudget, `${causationPath}.aggregateBudget`);
  if (!withinUsage(value.aggregateUsage, value.aggregateBudget))
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_CAUSATION,
      causationPath,
      "aggregate usage already exceeds its budget",
    );
  if (value.delegationGrant === null) return value;
  const grantPath = `${causationPath}.delegationGrant`;
  assertExactKeys(
    value.delegationGrant,
    [
      "grantId",
      "maxConcurrent",
      "revision",
      "sourceAgentId",
      "sourceChannelId",
      "sourceRef",
      "status",
      "targetAgentId",
    ],
    grantPath,
  );
  assertToken(value.delegationGrant.grantId, `${grantPath}.grantId`);
  if (
    !Number.isSafeInteger(value.delegationGrant.maxConcurrent) ||
    value.delegationGrant.maxConcurrent < 1 ||
    value.delegationGrant.maxConcurrent > 32
  )
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_CAUSATION,
      `${grantPath}.maxConcurrent`,
      "grant concurrency must be between one and 32",
    );
  if (
    !Number.isSafeInteger(value.delegationGrant.revision) ||
    value.delegationGrant.revision < 1
  )
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_CAUSATION,
      `${grantPath}.revision`,
      "grant revision must be positive",
    );
  validateAgentConfigAgentId(value.delegationGrant.sourceAgentId, {
    expectedWorkspaceId: workspaceId,
    path: `${grantPath}.sourceAgentId`,
  });
  validateChannelId(value.delegationGrant.sourceChannelId, {
    expectedWorkspaceId: workspaceId,
    path: `${grantPath}.sourceChannelId`,
  });
  validateAgentConfigAgentId(value.delegationGrant.targetAgentId, {
    expectedWorkspaceId: workspaceId,
    path: `${grantPath}.targetAgentId`,
  });
  assertSource(
    value.delegationGrant.sourceRef,
    `${grantPath}.sourceRef`,
    workspaceId,
  );
  if (!["active", "revoked"].includes(value.delegationGrant.status))
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_CAUSATION,
      `${grantPath}.status`,
      "grant status must be active or revoked",
    );
  if (value.delegationGrant.targetAgentId !== agentId)
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_CAUSATION,
      `${grantPath}.targetAgentId`,
      "grant target must equal the scheduled agent",
    );
  return value;
}

function validateBudget(value, path) {
  assertExactKeys(value, BUDGET_KEYS, path);
  for (const key of BUDGET_KEYS) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0)
      fail(
        CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_POLICY,
        `${path}.${key}`,
        "budget values must be non-negative safe integers",
      );
  }
  if (
    value.maxTotalTokens < value.maxInputTokens ||
    value.maxTotalTokens < value.maxOutputTokens
  )
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_POLICY,
      `${path}.maxTotalTokens`,
      "total token budget must cover input and output ceilings",
    );
}

function validateConcurrency(value, path) {
  assertExactKeys(value, CONCURRENCY_KEYS, path);
  for (const key of ["maxConcurrentPerChannel", "maxConcurrentRuns"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > 32)
      fail(
        CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_POLICY,
        `${path}.${key}`,
        "concurrency must be between one and 32",
      );
  }
  if (!["parallel", "serialize"].includes(value.queueStrategy))
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_POLICY,
      `${path}.queueStrategy`,
      "queue strategy must be parallel or serialize",
    );
  if (value.maxConcurrentPerChannel > value.maxConcurrentRuns)
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_POLICY,
      `${path}.maxConcurrentPerChannel`,
      "per-channel concurrency cannot exceed total concurrency",
    );
  if (
    value.queueStrategy === "serialize" &&
    value.maxConcurrentPerChannel !== 1
  )
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_POLICY,
      `${path}.queueStrategy`,
      "serialize requires one concurrent run per channel",
    );
}

function validateDelegation(value, path) {
  assertExactKeys(value, DELEGATION_KEYS, path);
  if (
    typeof value.enabled !== "boolean" ||
    typeof value.allowCrossChannel !== "boolean"
  )
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_POLICY,
      path,
      "delegation booleans are required",
    );
  for (const key of ["maxChildren", "maxDepth"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 32)
      fail(
        CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_POLICY,
        `${path}.${key}`,
        "delegation limits must be bounded integers",
      );
  }
  if (
    !value.enabled &&
    (value.maxChildren !== 0 || value.maxDepth !== 0 || value.allowCrossChannel)
  )
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_POLICY,
      path,
      "disabled delegation cannot carry limits",
    );
  if (value.enabled && (value.maxChildren < 1 || value.maxDepth < 1))
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_POLICY,
      path,
      "enabled delegation requires positive limits",
    );
}

function validateUsage(value, path) {
  assertExactKeys(value, USAGE_KEYS, path);
  for (const key of USAGE_KEYS) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0)
      fail(
        CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
        `${path}.${key}`,
        "usage values must be non-negative safe integers",
      );
  }
  if (value.totalTokens !== value.inputTokens + value.outputTokens)
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
      `${path}.totalTokens`,
      "total tokens must equal input plus output",
    );
}

function validateThreadId(value, path) {
  if (
    value !== null &&
    (typeof value !== "string" || !THREAD_PATTERN.test(value))
  )
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
      path,
      "thread id must be null or a bounded token",
    );
}

function validateDigest(value, path) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value))
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
      path,
      "value must be a sha256 digest",
    );
}

function assertSource(value, path, workspaceId, { channelOnly = false } = {}) {
  try {
    assertSourceReference(value, path, workspaceId, { channelOnly });
  } catch (error) {
    fail(
      error.code ?? CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_SOURCE,
      path,
      error.detail ?? "source reference is invalid",
    );
  }
}

function assertInvocationId(value, path) {
  if (typeof value !== "string" || !INVOCATION_PATTERN.test(value))
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
      path,
      "invocation id is not canonical",
    );
}

function assertBatchId(value, path) {
  if (typeof value !== "string" || !BATCH_PATTERN.test(value))
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
      path,
      "batch id is not canonical",
    );
}

function assertConversationKey(value, path) {
  if (typeof value !== "string" || !CONVERSATION_PATTERN.test(value))
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
      path,
      "conversation key is not canonical",
    );
}

function assertToken(value, path) {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value))
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
      path,
      "value must be a bounded token",
    );
}

function sourceIdentity(source) {
  return `${source.stream}\u0000${source.offset}\u0000${source.digest}`;
}

function compareItems(left, right) {
  const source = compareOffsets(
    left.sourceTrigger.offset,
    right.sourceTrigger.offset,
  );
  if (source !== 0) return source;
  const invocation =
    left.invocationId < right.invocationId
      ? -1
      : left.invocationId > right.invocationId
        ? 1
        : 0;
  if (invocation !== 0) return invocation;
  return left.agentId < right.agentId
    ? -1
    : left.agentId > right.agentId
      ? 1
      : 0;
}

function compareOffsets(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function countBy(values, keyFor) {
  const result = new Map();
  for (const value of values) incrementCount(result, keyFor(value));
  return result;
}

function incrementCount(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function addUsage(left, right) {
  return Object.fromEntries(
    USAGE_KEYS.map((key) => [key, left[key] + right[key]]),
  );
}

function withinUsage(usage, budget) {
  return (
    usage.costUsdCents <= (budget.maxCostUsdCents ?? budget.costUsdCents) &&
    usage.inputTokens <= (budget.maxInputTokens ?? budget.inputTokens) &&
    usage.outputTokens <= (budget.maxOutputTokens ?? budget.outputTokens) &&
    usage.totalTokens <= (budget.maxTotalTokens ?? budget.totalTokens)
  );
}

function freezeCopy(value) {
  return deepFreeze(structuredClone(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function digestCanonical(value) {
  return `sha256:${hex(sha256Digest(canonicalJson(value)))}`;
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    )
      throw new TypeError(
        "scheduler canonical values require finite safe numbers",
      );
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object")
    throw new TypeError("scheduler canonical values must be JSON values");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fail(code, path, detail) {
  throw new ConversationSchedulingError(code, detail, path);
}

function assertExactKeys(value, keys, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(
      CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
      path,
      "value must be an object",
    );
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(
        CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
        `${path}.${key}`,
        "field is not allowed",
      );
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      fail(
        CONVERSATION_SCHEDULER_ERROR_CODES.INVALID_DATA,
        `${path}.${key}`,
        "field is required",
      );
    }
  }
}
