import {
  conversationPolicyDigest,
  deriveConversationKey,
} from "@stream-slack/protocol";

export const WORKSPACE_ID = `ws_${"a".repeat(26)}`;
export const CHANNEL_A = `ch_${"a".repeat(26)}_${"b".repeat(26)}`;
export const CHANNEL_B = `ch_${"a".repeat(26)}_${"c".repeat(26)}`;
export const AGENT_A = `ag_${"a".repeat(26)}_${"d".repeat(26)}`;
export const AGENT_B = `ag_${"a".repeat(26)}_${"e".repeat(26)}`;
export const AGENT_C = `ag_${"a".repeat(26)}_${"f".repeat(26)}`;
export const HUMAN = `pr_${"a".repeat(26)}_${"b".repeat(26)}`;
export const AGENT_A_PRINCIPAL = `pr_${"a".repeat(26)}_${"d".repeat(26)}`;
export const AGENT_B_PRINCIPAL = `pr_${"a".repeat(26)}_${"e".repeat(26)}`;
export const AGENT_C_PRINCIPAL = `pr_${"a".repeat(26)}_${"f".repeat(26)}`;

const DIGESTS = Object.freeze({
  a: `sha256:${"a".repeat(64)}`,
  b: `sha256:${"b".repeat(64)}`,
  c: `sha256:${"c".repeat(64)}`,
  d: `sha256:${"d".repeat(64)}`,
  e: `sha256:${"e".repeat(64)}`,
  f: `sha256:${"f".repeat(64)}`,
});

export function makePolicy({
  delegation = {
    allowCrossChannel: false,
    enabled: false,
    maxChildren: 0,
    maxDepth: 0,
  },
  maxConcurrentPerChannel = 1,
  maxConcurrentRuns = 2,
  queueStrategy = "serialize",
} = {}) {
  const policy = {
    budgets: {
      maxCostUsdCents: 100,
      maxInputTokens: 100,
      maxOutputTokens: 100,
      maxTotalTokens: 200,
    },
    concurrency: {
      maxConcurrentPerChannel,
      maxConcurrentRuns,
      queueStrategy,
    },
    delegation: { ...delegation },
  };
  conversationPolicyDigest(policy);
  return Object.freeze(policy);
}

export function ref(kind, index, stream = `channel:${CHANNEL_A}`) {
  const offset = `${String(index).padStart(16, "0")}_0000000000000000`;
  return {
    digest: DIGESTS[kind] ?? DIGESTS.a,
    offset,
    stream,
  };
}

export function makeItem({
  agentId = AGENT_A,
  authorAgentId = null,
  authorId = HUMAN,
  authorKind = "human",
  channelId = CHANNEL_A,
  causation = null,
  eventType = "channel.message.created",
  index = 1,
  invocationLetter = "a",
  invocationRef = null,
  isAgentReply = false,
  isEdit = false,
  isReplay = false,
  isRetry = false,
  mentionKind = "canonical",
  policy = makePolicy(),
  snapshotKind = "a",
  threadId = null,
  triggerKind = "b",
} = {}) {
  const invocationId = `iv_${invocationLetter.repeat(26)}`;
  const sourceTrigger = ref(triggerKind, index, `channel:${channelId}`);
  const resolvedInvocationRef =
    invocationRef ??
    ref(snapshotKind, index, `workspace:${WORKSPACE_ID}/invocations`);
  const resolvedCausation = causation ?? {
    aggregateBudget: {
      costUsdCents: policy.budgets.maxCostUsdCents,
      inputTokens: policy.budgets.maxInputTokens,
      outputTokens: policy.budgets.maxOutputTokens,
      totalTokens: policy.budgets.maxTotalTokens,
    },
    aggregateUsage: {
      costUsdCents: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    ancestors: [],
    delegationGrant: null,
    parentInvocationId: null,
    rootInvocationId: invocationId,
  };
  return {
    agentId,
    causation: resolvedCausation,
    conversation: { channelId, threadId },
    estimatedUsage: {
      costUsdCents: 1,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    },
    invocationId,
    invocationRef: resolvedInvocationRef,
    policy,
    policyDigest: conversationPolicyDigest(policy),
    snapshotDigest: DIGESTS[snapshotKind] ?? DIGESTS.a,
    source: {
      authorAgentId,
      authorId,
      authorKind,
      eventType,
      isAgentReply,
      isEdit,
      isReplay,
      isRetry,
      mentionKind,
    },
    sourceTrigger,
    workspaceId: WORKSPACE_ID,
  };
}

export function makeDelegatedChild({
  agentId = AGENT_B,
  channelId = CHANNEL_A,
  index = 10,
  invocationLetter = "k",
  maxConcurrent = 1,
  parent = `iv_${"a".repeat(26)}`,
  policy = makePolicy({
    delegation: {
      allowCrossChannel: false,
      enabled: true,
      maxChildren: 2,
      maxDepth: 2,
    },
  }),
  sourceAgentId = AGENT_A,
  sourceAgentPrincipal = AGENT_A_PRINCIPAL,
  threadId = null,
} = {}) {
  const item = makeItem({
    agentId,
    authorAgentId: sourceAgentId,
    authorId: sourceAgentPrincipal,
    authorKind: "agent",
    channelId,
    index,
    invocationLetter,
    policy,
    snapshotKind: "b",
    threadId,
    triggerKind: "c",
  });
  const ancestor = {
    agentId: sourceAgentId,
    invocationId: parent,
    sourceRef: ref("a", index - 1),
  };
  item.causation = {
    ...item.causation,
    ancestors: [ancestor],
    delegationGrant: {
      grantId: `grant_${"a".repeat(20)}`,
      maxConcurrent,
      revision: 1,
      sourceAgentId,
      sourceChannelId: CHANNEL_A,
      sourceRef: ref("d", index, `agent:${sourceAgentId}/config`),
      status: "active",
      targetAgentId: agentId,
    },
    parentInvocationId: parent,
    rootInvocationId: parent,
  };
  return item;
}

export function makeActive(item, batchId = `bt_${"a".repeat(26)}`) {
  return {
    agentId: item.agentId,
    batchId,
    channelId: item.conversation.channelId,
    conversationKey: deriveConversationKey({
      agentId: item.agentId,
      channelId: item.conversation.channelId,
      threadId: item.conversation.threadId,
      workspaceId: item.workspaceId,
    }),
    invocationId: item.invocationId,
    sourceRef: item.invocationRef,
    threadId: item.conversation.threadId,
    workspaceId: item.workspaceId,
  };
}

export function makeHistory(item, status = "completed") {
  return {
    agentId: item.agentId,
    conversationKey: deriveConversationKey({
      agentId: item.agentId,
      channelId: item.conversation.channelId,
      threadId: item.conversation.threadId,
      workspaceId: item.workspaceId,
    }),
    invocationId: item.invocationId,
    parentInvocationId: item.causation.parentInvocationId,
    sourceRef: item.sourceTrigger,
    status,
    workspaceId: item.workspaceId,
  };
}
