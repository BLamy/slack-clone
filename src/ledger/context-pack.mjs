import {
  validateChannelId,
  validateConversationText,
  validateMessageContentType,
  validatePrincipalId,
  validateWorkspaceId,
} from "@stream-slack/protocol";

import { canonicalJson, canonicalSha256 } from "./canonical-json.mjs";
import { digestEventEnvelope, validateEventEnvelope } from "./envelope.mjs";
import { parseStreamName } from "./topology.mjs";

export const CONTEXT_PACK_SCHEMA_VERSION = 1;
export const CONTEXT_PACK_KIND = "context-pack";

export const CONTEXT_PACK_TRUST_LABELS = Object.freeze([
  "trusted-instructions",
  "trusted-metadata",
  "untrusted-content",
  "untrusted-attachment",
]);

export const CONTEXT_PACK_SCOPES = Object.freeze([
  "current-channel",
  "current-thread",
  "none",
  "workspace",
]);

const CONTEXT_PACK_CONTENT_KINDS = Object.freeze([
  "agent-instruction",
  "attachment",
  "conversation-message",
  "workspace-file",
]);

export const CONTEXT_PACK_ERROR_CODES = Object.freeze({
  ACL_SCOPE: "CONTEXT_PACK_ACL_SCOPE",
  ATTACHMENT_LIMIT: "CONTEXT_PACK_ATTACHMENT_LIMIT",
  CHANNEL_INACTIVE: "CONTEXT_PACK_CHANNEL_INACTIVE",
  DIGEST_MISMATCH: "CONTEXT_PACK_DIGEST_MISMATCH",
  HISTORY_INVALID: "CONTEXT_PACK_HISTORY_INVALID",
  INPUT_INVALID: "CONTEXT_PACK_INPUT_INVALID",
  INSTRUCTION_SCOPE: "CONTEXT_PACK_INSTRUCTION_SCOPE",
  LIMIT_INVALID: "CONTEXT_PACK_LIMIT_INVALID",
  MESSAGE_INVALID: "CONTEXT_PACK_MESSAGE_INVALID",
  MEMBERSHIP_INACTIVE: "CONTEXT_PACK_MEMBERSHIP_INACTIVE",
  PACK_INVALID: "CONTEXT_PACK_INVALID",
  PRIVATE_SCOPE: "CONTEXT_PACK_PRIVATE_SCOPE",
  SOURCE_HEAD: "CONTEXT_PACK_SOURCE_HEAD",
  SOURCE_INVALID: "CONTEXT_PACK_SOURCE_INVALID",
  SOURCE_SCOPE: "CONTEXT_PACK_SOURCE_SCOPE",
  TRIGGER_INVALID: "CONTEXT_PACK_TRIGGER_INVALID",
  TRIGGER_LIMIT: "CONTEXT_PACK_TRIGGER_LIMIT",
  UNICODE_INVALID: "CONTEXT_PACK_UNICODE_INVALID",
  WORKSPACE_INPUT_SCOPE: "CONTEXT_PACK_WORKSPACE_INPUT_SCOPE",
});

const OFFSET_PATTERN = /^\d{16}_[0-9a-f]{16}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SAFE_ITEM_ID = /^[A-Za-z0-9:_./-]{1,240}$/u;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,240}$/u;
const MESSAGE_EVENT_TYPES = new Set([
  "channel.message.created",
  "channel.message.replied",
  "channel.message.edited",
  "channel.message.deleted",
]);
const CONFIG_EVENT_TYPES = new Set([
  "agent.config.created",
  "agent.config.revised",
  "agent.config.activated",
  "agent.config.disabled",
  "agent.config.retired",
]);
const CONTENT_EVENT_TYPES = new Set([
  ...MESSAGE_EVENT_TYPES,
  "ledger.fixture-recorded",
  "workspace.directory.updated",
]);
const DEFAULT_POLICY = Object.freeze({
  includePrivate: false,
  includeThreadHistory: true,
  maxAttachmentBytes: 64_000,
  maxBytes: 32_000,
  maxEstimatedTokens: 8_000,
  maxHistoryDepth: 100,
  maxItems: 64,
  maxMessages: 50,
  workspaceInputPaths: [],
});

const PACK_KEYS = Object.freeze([
  "accounting",
  "agentId",
  "context",
  "instructions",
  "items",
  "kind",
  "omitted",
  "packDigest",
  "policy",
  "schemaVersion",
  "sourceHeads",
  "trigger",
  "workspaceId",
]);
const PACK_PAYLOAD_KEYS = PACK_KEYS.filter((key) => key !== "packDigest");

export class ContextPackError extends Error {
  constructor(code, detail, { path = "$", source = null } = {}) {
    super(`${code}: ${detail}`);
    this.name = "ContextPackError";
    this.code = code;
    this.detail = detail;
    this.path = path;
    this.source = source;
  }

  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      name: this.name,
      path: this.path,
      source: this.source,
    };
  }
}

/**
 * Assemble a bounded context pack from already-authorized durable source
 * records. The assembler never reads ambient process state: every emitted
 * item is copied from an explicit input and bound to a source record.
 */
export function assembleContextPack(input = {}) {
  const normalized = normalizeAssemblyInput(input);
  const records = normalizeSourceRecords(
    normalized.sourceRecords,
    normalized.workspaceId,
  );
  const allowedStreams = allowedSourceStreams(normalized);
  const usableRecords = records.filter((record) =>
    allowedStreams.has(record.stream),
  );
  const byCitation = indexRecords(usableRecords);
  const sourceHeads = normalizeSourceHeads(
    normalized.sourceHeads,
    usableRecords,
    allowedStreams,
    normalized.workspaceId,
  );
  assertHeadCoverage(sourceHeads, usableRecords);
  assertAuthorization(normalized);

  const channelStream = `channel:${normalized.context.channelId}`;
  const channelRecords = usableRecords
    .filter((record) => record.stream === channelStream)
    .sort(compareRecords);
  const triggerRecord = requireTriggerRecord(
    normalized.trigger.source,
    byCitation,
    normalized.workspaceId,
    normalized.context.channelId,
  );
  const messages = replayMessageHistory(
    channelRecords,
    normalized.workspaceId,
    normalized.context.channelId,
  );
  const triggerMessage = messages.get(normalized.trigger.messageId);
  if (!triggerMessage || triggerMessage.status !== "active") {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.TRIGGER_INVALID,
      "trigger message is not an active message in the cited channel history",
      "$.trigger.messageId",
    );
  }
  if (triggerRecord.event.data.messageId !== normalized.trigger.messageId) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.TRIGGER_INVALID,
      "trigger citation does not identify the requested message",
      "$.trigger.source",
    );
  }

  const triggerRootId =
    triggerMessage.rootMessageId ?? triggerMessage.messageId;
  if (
    normalized.context.scope === "current-thread" &&
    normalized.context.threadId !== triggerRootId
  ) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.TRIGGER_INVALID,
      "thread context is not bound to the triggering message root",
      "$.context.threadId",
    );
  }
  if (
    normalized.context.scope === "current-thread" &&
    normalized.trigger.threadId !== normalized.context.threadId
  ) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.TRIGGER_INVALID,
      "trigger thread is not bound to the requested context thread",
      "$.input.trigger.threadId",
    );
  }

  const candidates = selectMessageCandidates({
    context: normalized.context,
    messages,
    triggerIndex: messageOrderIndex(messages, triggerMessage.messageId),
    triggerRootId,
    policy: normalized.policy,
  });
  const omitted = [...candidates.omitted];
  const items = [];
  let accounting = emptyAccounting();

  const instructionItems = normalized.instructions.map((instruction) =>
    normalizeInstructionItem(instruction, byCitation, normalized),
  );
  const instructionAccounting = accountItems(instructionItems, accounting);
  accounting = instructionAccounting.accounting;
  if (
    accounting.bytes > normalized.policy.maxBytes ||
    accounting.estimatedTokens > normalized.policy.maxEstimatedTokens ||
    accounting.items > normalized.policy.maxItems
  ) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.LIMIT_INVALID,
      "trusted instructions exceed the context pack budget",
      "$.instructions",
    );
  }

  for (const candidate of candidates.selected) {
    const item = messageItem(candidate);
    const next = accountItem(item, accounting);
    if (!fitsLimits(next.accounting, normalized.policy)) {
      if (candidate.messageId === normalized.trigger.messageId) {
        throw contextPackError(
          CONTEXT_PACK_ERROR_CODES.TRIGGER_LIMIT,
          "trigger message cannot fit inside the context pack limits",
          "$.policy",
        );
      }
      omitted.push(omittedItem(candidate.lastRecord, candidate, "budget"));
      continue;
    }
    items.push(item);
    accounting = next.accounting;
  }

  for (const workspaceInput of normalized.workspaceInputs) {
    const item = normalizeWorkspaceInputItem(
      workspaceInput,
      byCitation,
      normalized,
    );
    const next = accountItem(item, accounting);
    if (item.content.bytes > normalized.policy.maxAttachmentBytes) {
      omitted.push(omittedItem(item.citation, item, "attachment-limit"));
      continue;
    }
    if (!fitsLimits(next.accounting, normalized.policy)) {
      omitted.push(omittedItem(item.citation, item, "budget"));
      continue;
    }
    items.push(item);
    accounting = next.accounting;
  }

  for (const attachment of normalized.attachments) {
    const item = normalizeAttachmentItem(attachment, byCitation, normalized);
    const next = accountItem(item, accounting);
    if (item.content.bytes > normalized.policy.maxAttachmentBytes) {
      omitted.push(omittedItem(item.citation, item, "attachment-limit"));
      continue;
    }
    if (!fitsLimits(next.accounting, normalized.policy)) {
      omitted.push(omittedItem(item.citation, item, "budget"));
      continue;
    }
    items.push(item);
    accounting = next.accounting;
  }

  const pack = createContextPack({
    accounting,
    agentId: normalized.agentId,
    context: normalized.context,
    instructions: instructionItems,
    items: items.map((item, index) => ({ ...item, ordinal: index + 1 })),
    kind: CONTEXT_PACK_KIND,
    omitted: omitted.sort(compareOmitted),
    policy: normalized.policy,
    schemaVersion: CONTEXT_PACK_SCHEMA_VERSION,
    sourceHeads,
    trigger: {
      channelId: normalized.trigger.channelId,
      messageId: normalized.trigger.messageId,
      threadId: normalized.trigger.threadId,
      citation: citationFor(
        triggerRecord,
        triggerMessage.authorId,
        "conversation-trigger",
      ),
    },
    workspaceId: normalized.workspaceId,
  });
  return pack;
}

export const createContextPack = createContextPackValue;

export function createContextPackValue(value) {
  const payload = normalizePackPayload(value, { requireDigest: false });
  const pack = {
    ...payload,
    packDigest: contextPackDigest(payload),
  };
  return freezeDeep(pack);
}

export function replayContextPack(value) {
  let expected;
  try {
    expected = contextPackDigest(value);
  } catch {
    return normalizePackPayload(value, { requireDigest: true });
  }
  if (value.packDigest !== expected) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.DIGEST_MISMATCH,
      "context pack digest does not match canonical bytes",
      "$.packDigest",
    );
  }
  normalizePackPayload(value, { requireDigest: true });
  return freezeDeep(structuredClone(value));
}

export function canonicalContextPack(value) {
  return canonicalJson(packPayload(value));
}

export function encodeContextPack(value) {
  return new TextEncoder().encode(canonicalContextPack(value));
}

export function contextPackDigest(value) {
  return canonicalSha256(packPayload(value));
}

function normalizeAssemblyInput(value) {
  assertPlain(value, "$.input");
  assertExactKeys(
    value,
    [
      "agentId",
      "authorization",
      "context",
      "sourceHeads",
      "sourceRecords",
      "trigger",
      "workspaceId",
    ],
    "$.input",
    { optional: ["attachments", "instructions", "policy", "workspaceInputs"] },
  );
  const workspaceId = validateWorkspaceId(
    value.workspaceId,
    "$.input.workspaceId",
  );
  validateAgentId(value.agentId, workspaceId, "$.input.agentId");
  const principalId = `pr_${value.agentId.slice(3)}`;
  const context = normalizeContext(value.context, workspaceId);
  const policy = normalizePolicy(value.policy);
  const trigger = normalizeTrigger(value.trigger, context, workspaceId);
  const instructions = Array.isArray(value.instructions)
    ? value.instructions
    : [];
  const workspaceInputs = Array.isArray(value.workspaceInputs)
    ? value.workspaceInputs
    : [];
  const attachments = Array.isArray(value.attachments) ? value.attachments : [];
  if (!Array.isArray(value.sourceRecords) || value.sourceRecords.length === 0) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.SOURCE_INVALID,
      "sourceRecords must be a non-empty array",
      "$.input.sourceRecords",
    );
  }
  if (!Array.isArray(value.sourceHeads) || value.sourceHeads.length === 0) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.SOURCE_HEAD,
      "sourceHeads must be a non-empty array",
      "$.input.sourceHeads",
    );
  }
  return {
    agentId: value.agentId,
    attachments,
    authorization: value.authorization,
    context,
    instructions,
    policy,
    principalId,
    sourceHeads: value.sourceHeads,
    sourceRecords: value.sourceRecords,
    trigger,
    workspaceId,
    workspaceInputs,
  };
}

function normalizePackPayload(value, { requireDigest }) {
  assertPlain(value, "$.pack");
  assertExactKeys(value, PACK_PAYLOAD_KEYS, "$.pack", {
    optional: ["packDigest"],
  });
  if (requireDigest && !Object.hasOwn(value, "packDigest")) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.PACK_INVALID,
      "packDigest is required for replay",
      "$.packDigest",
    );
  }
  if (value.schemaVersion !== CONTEXT_PACK_SCHEMA_VERSION) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.PACK_INVALID,
      "unsupported context pack schema version",
      "$.schemaVersion",
    );
  }
  if (value.kind !== CONTEXT_PACK_KIND) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.PACK_INVALID,
      "context pack kind is not registered",
      "$.kind",
    );
  }
  const workspaceId = validateWorkspaceId(value.workspaceId, "$.workspaceId");
  validateAgentId(value.agentId, workspaceId, "$.agentId");
  const context = normalizeContext(value.context, workspaceId);
  const policy = normalizePolicy(value.policy);
  const sourceHeads = normalizePackSourceHeads(value.sourceHeads, workspaceId);
  const trigger = normalizePackTrigger(value.trigger, context, workspaceId);
  if (
    !Array.isArray(value.instructions) ||
    !Array.isArray(value.items) ||
    !Array.isArray(value.omitted)
  ) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.PACK_INVALID,
      "instructions, items, and omitted must be arrays",
      "$.pack",
    );
  }
  const instructions = value.instructions.map((item, index) =>
    normalizeInstructionOutput(item, `$.instructions[${index}]`, workspaceId),
  );
  const items = value.items.map((item, index) =>
    normalizeItemOutput(item, `$.items[${index}]`, workspaceId),
  );
  const omitted = value.omitted.map((item, index) =>
    normalizeOmittedOutput(item, `$.omitted[${index}]`, workspaceId),
  );
  const accounting = normalizeAccounting(value.accounting);
  const recomputedAccounting = accountItems(
    [...instructions, ...items],
    emptyAccounting(),
  ).accounting;
  if (canonicalJson(accounting) !== canonicalJson(recomputedAccounting)) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.PACK_INVALID,
      "accounting does not match canonical pack items",
      "$.accounting",
    );
  }
  for (const [index, item] of items.entries()) {
    if (item.ordinal !== index + 1) {
      throw contextPackError(
        CONTEXT_PACK_ERROR_CODES.PACK_INVALID,
        "item ordinals are not contiguous",
        `$.items[${index}].ordinal`,
      );
    }
  }
  const payload = {
    accounting,
    agentId: value.agentId,
    context,
    instructions,
    items,
    kind: CONTEXT_PACK_KIND,
    omitted,
    policy,
    schemaVersion: CONTEXT_PACK_SCHEMA_VERSION,
    sourceHeads,
    trigger,
    workspaceId,
  };
  scanSecrets(payload);
  return payload;
}

function normalizePackSourceHeads(value, workspaceId) {
  if (!Array.isArray(value) || value.length === 0) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.SOURCE_HEAD,
      "pack sourceHeads must be a non-empty array",
      "$.sourceHeads",
    );
  }
  const heads = value.map((head, index) =>
    normalizeCitationSource(head, `$.sourceHeads[${index}]`, workspaceId),
  );
  assertUnique(
    heads.map((head) => head.stream),
    "sourceHeads",
    "$.sourceHeads",
  );
  return heads.sort(compareSourceRefs);
}

function normalizePackTrigger(value, context, workspaceId) {
  assertPlain(value, "$.trigger");
  assertExactKeys(
    value,
    ["channelId", "citation", "messageId", "threadId"],
    "$.trigger",
    { optional: [] },
  );
  validateChannelId(value.channelId, {
    expectedWorkspaceId: workspaceId,
    path: "$.trigger.channelId",
  });
  if (value.channelId !== context.channelId) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.ACL_SCOPE,
      "trigger channel is outside the context scope",
      "$.trigger.channelId",
    );
  }
  assertSafeId(value.messageId, "$.trigger.messageId");
  if (value.threadId !== null)
    assertSafeId(value.threadId, "$.trigger.threadId");
  return {
    channelId: value.channelId,
    messageId: value.messageId,
    threadId: value.threadId,
    citation: normalizeCitation(
      value.citation,
      "$.trigger.citation",
      workspaceId,
    ),
  };
}

function normalizeInstructionOutput(value, path, workspaceId) {
  assertPlain(value, path);
  assertExactKeys(
    value,
    ["citation", "id", "revision", "text", "trust"],
    path,
    { optional: [] },
  );
  assertSafeId(value.id, `${path}.id`);
  assertPositiveInteger(value.revision, `${path}.revision`);
  assertText(value.text, `${path}.text`, 1, 16_000);
  if (value.trust !== "trusted-instructions") {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.PACK_INVALID,
      "instruction trust label is invalid",
      `${path}.trust`,
    );
  }
  const citation = normalizeCitation(
    value.citation,
    `${path}.citation`,
    workspaceId,
  );
  if (citation.contentKind !== "agent-instruction") {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.PACK_INVALID,
      "instruction citation content kind is invalid",
      `${path}.citation.contentKind`,
    );
  }
  return {
    citation,
    id: value.id,
    revision: value.revision,
    text: value.text,
    trust: value.trust,
  };
}

function normalizeItemOutput(value, path, workspaceId) {
  assertPlain(value, path);
  assertExactKeys(
    value,
    ["citation", "content", "contentKind", "id", "ordinal", "trust"],
    path,
    { optional: [] },
  );
  assertSafeId(value.id, `${path}.id`);
  assertPositiveInteger(value.ordinal, `${path}.ordinal`);
  if (!CONTEXT_PACK_TRUST_LABELS.includes(value.trust)) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.PACK_INVALID,
      "item trust label is invalid",
      `${path}.trust`,
    );
  }
  if (!CONTEXT_PACK_CONTENT_KINDS.includes(value.contentKind)) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.PACK_INVALID,
      "item content kind is not registered",
      `${path}.contentKind`,
    );
  }
  if (
    value.contentKind === "attachment" &&
    value.trust !== "untrusted-attachment"
  ) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.PACK_INVALID,
      "attachments must be marked untrusted-attachment",
      `${path}.trust`,
    );
  }
  const citation = normalizeCitation(
    value.citation,
    `${path}.citation`,
    workspaceId,
  );
  if (citation.contentKind !== value.contentKind) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.PACK_INVALID,
      "item citation content kind does not match the item",
      `${path}.citation.contentKind`,
    );
  }
  normalizeContent(value.content, `${path}.content`);
  return {
    citation,
    content: structuredClone(value.content),
    contentKind: value.contentKind,
    id: value.id,
    ordinal: value.ordinal,
    trust: value.trust,
  };
}

function normalizeOmittedOutput(value, path, workspaceId) {
  assertPlain(value, path);
  assertExactKeys(
    value,
    [
      "bytes",
      "citation",
      "contentKind",
      "estimatedTokens",
      "id",
      "reason",
      "sourceRange",
      "trust",
    ],
    path,
    { optional: [] },
  );
  assertSafeId(value.id, `${path}.id`);
  assertNonNegativeInteger(value.bytes, `${path}.bytes`);
  assertNonNegativeInteger(value.estimatedTokens, `${path}.estimatedTokens`);
  assertText(value.reason, `${path}.reason`, 1, 80);
  if (!CONTEXT_PACK_TRUST_LABELS.includes(value.trust)) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.PACK_INVALID,
      "omitted trust label is invalid",
      `${path}.trust`,
    );
  }
  if (!CONTEXT_PACK_CONTENT_KINDS.includes(value.contentKind)) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.PACK_INVALID,
      "omitted content kind is not registered",
      `${path}.contentKind`,
    );
  }
  if (
    (value.contentKind === "attachment" &&
      value.trust !== "untrusted-attachment") ||
    (value.contentKind !== "attachment" &&
      value.trust === "untrusted-attachment")
  ) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.PACK_INVALID,
      "omitted trust label does not match the content kind",
      `${path}.trust`,
    );
  }
  const citation = normalizeCitation(
    value.citation,
    `${path}.citation`,
    workspaceId,
  );
  if (citation.contentKind !== value.contentKind) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.PACK_INVALID,
      "omitted citation content kind does not match the omission",
      `${path}.citation.contentKind`,
    );
  }
  const sourceRange = normalizeSourceRange(
    value.sourceRange,
    `${path}.sourceRange`,
    workspaceId,
  );
  return {
    bytes: value.bytes,
    citation,
    contentKind: value.contentKind,
    estimatedTokens: value.estimatedTokens,
    id: value.id,
    reason: value.reason,
    sourceRange,
    trust: value.trust,
  };
}

function normalizeCitation(value, path, workspaceId) {
  assertPlain(value, path);
  assertExactKeys(
    value,
    ["contentKind", "eventDigest", "offset", "principalId", "stream"],
    path,
    { optional: [] },
  );
  validatePrincipalId(value.principalId, {
    expectedWorkspaceId: workspaceId,
    path: `${path}.principalId`,
  });
  if (!DIGEST_PATTERN.test(value.eventDigest)) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.PACK_INVALID,
      "citation event digest is invalid",
      `${path}.eventDigest`,
    );
  }
  if (!OFFSET_PATTERN.test(value.offset)) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.PACK_INVALID,
      "citation offset is invalid",
      `${path}.offset`,
    );
  }
  try {
    parseStreamName(value.stream, {
      expectedWorkspaceId: workspaceId,
      path: `${path}.stream`,
    });
  } catch {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.PACK_INVALID,
      "citation stream is outside the workspace topology",
      `${path}.stream`,
    );
  }
  assertText(value.contentKind, `${path}.contentKind`, 1, 80);
  return {
    contentKind: value.contentKind,
    eventDigest: value.eventDigest,
    offset: value.offset,
    principalId: value.principalId,
    stream: value.stream,
  };
}

function normalizeCitationSource(value, path, workspaceId) {
  assertPlain(value, path);
  assertExactKeys(value, ["digest", "offset", "stream"], path, {
    optional: [],
  });
  if (
    !DIGEST_PATTERN.test(value.digest) ||
    !OFFSET_PATTERN.test(value.offset)
  ) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.SOURCE_HEAD,
      "source head reference is invalid",
      path,
    );
  }
  try {
    parseStreamName(value.stream, {
      expectedWorkspaceId: workspaceId,
      path: `${path}.stream`,
    });
  } catch {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.SOURCE_HEAD,
      "source head stream is outside the workspace",
      `${path}.stream`,
    );
  }
  return { digest: value.digest, offset: value.offset, stream: value.stream };
}

function normalizeSourceRange(value, path, workspaceId) {
  assertPlain(value, path);
  assertExactKeys(value, ["endOffset", "startOffset", "stream"], path, {
    optional: [],
  });
  if (
    !OFFSET_PATTERN.test(value.startOffset) ||
    !OFFSET_PATTERN.test(value.endOffset)
  ) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.PACK_INVALID,
      "omitted source range offsets are invalid",
      path,
    );
  }
  try {
    parseStreamName(value.stream, {
      expectedWorkspaceId: workspaceId,
      path: `${path}.stream`,
    });
  } catch {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.PACK_INVALID,
      "omitted source range stream is invalid",
      `${path}.stream`,
    );
  }
  if (value.startOffset > value.endOffset) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.PACK_INVALID,
      "omitted source range is reversed",
      path,
    );
  }
  return {
    endOffset: value.endOffset,
    startOffset: value.startOffset,
    stream: value.stream,
  };
}

function normalizeAccounting(value) {
  assertPlain(value, "$.accounting");
  assertExactKeys(
    value,
    ["attachmentBytes", "bytes", "estimatedTokens", "historyItems", "items"],
    "$.accounting",
    { optional: [] },
  );
  for (const key of [
    "attachmentBytes",
    "bytes",
    "estimatedTokens",
    "historyItems",
    "items",
  ])
    assertNonNegativeInteger(value[key], `$.accounting.${key}`);
  return {
    attachmentBytes: value.attachmentBytes,
    bytes: value.bytes,
    estimatedTokens: value.estimatedTokens,
    historyItems: value.historyItems,
    items: value.items,
  };
}

function normalizeContext(value, workspaceId) {
  assertPlain(value, "$.context");
  assertExactKeys(value, ["channelId", "scope", "threadId"], "$.context", {
    optional: [],
  });
  if (!CONTEXT_PACK_SCOPES.includes(value.scope)) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.INPUT_INVALID,
      "context scope is not registered",
      "$.context.scope",
    );
  }
  validateChannelId(value.channelId, {
    expectedWorkspaceId: workspaceId,
    path: "$.context.channelId",
  });
  if (value.scope === "current-thread") {
    assertSafeId(value.threadId, "$.context.threadId");
  } else if (value.threadId !== null) {
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.INPUT_INVALID,
      "threadId is only valid for current-thread scope",
      "$.context.threadId",
    );
  }
  return {
    channelId: value.channelId,
    scope: value.scope,
    threadId: value.scope === "current-thread" ? value.threadId : null,
  };
}

function normalizeTrigger(value, context, workspaceId) {
  assertPlain(value, "$.input.trigger");
  assertExactKeys(
    value,
    ["channelId", "messageId", "source", "threadId"],
    "$.input.trigger",
    { optional: [] },
  );
  validateChannelId(value.channelId, {
    expectedWorkspaceId: workspaceId,
    path: "$.input.trigger.channelId",
  });
  if (value.channelId !== context.channelId)
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.TRIGGER_INVALID,
      "trigger channel does not match context channel",
      "$.input.trigger.channelId",
    );
  assertSafeId(value.messageId, "$.input.trigger.messageId");
  if (value.threadId !== null)
    assertSafeId(value.threadId, "$.input.trigger.threadId");
  return {
    channelId: value.channelId,
    messageId: value.messageId,
    source: normalizeCitationSource(
      value.source,
      "$.input.trigger.source",
      workspaceId,
    ),
    threadId: value.threadId,
  };
}

function normalizePolicy(value) {
  const policy = { ...DEFAULT_POLICY, ...(value ?? {}) };
  assertPlain(policy, "$.policy");
  assertExactKeys(policy, Object.keys(DEFAULT_POLICY), "$.policy", {
    optional: [],
  });
  for (const key of [
    "maxAttachmentBytes",
    "maxBytes",
    "maxEstimatedTokens",
    "maxHistoryDepth",
    "maxItems",
    "maxMessages",
  ]) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 1)
      throw contextPackError(
        CONTEXT_PACK_ERROR_CODES.LIMIT_INVALID,
        `${key} must be a positive safe integer`,
        `$.policy.${key}`,
      );
  }
  for (const key of ["includePrivate", "includeThreadHistory"])
    if (typeof policy[key] !== "boolean")
      throw contextPackError(
        CONTEXT_PACK_ERROR_CODES.LIMIT_INVALID,
        `${key} must be boolean`,
        `$.policy.${key}`,
      );
  if (!Array.isArray(policy.workspaceInputPaths))
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.LIMIT_INVALID,
      "workspaceInputPaths must be an array",
      "$.policy.workspaceInputPaths",
    );
  const paths = policy.workspaceInputPaths.map((path, index) => {
    assertText(path, `$.policy.workspaceInputPaths[${index}]`, 1, 240);
    if (!SAFE_PATH.test(path))
      throw contextPackError(
        CONTEXT_PACK_ERROR_CODES.LIMIT_INVALID,
        "workspace input path is not canonical",
        `$.policy.workspaceInputPaths[${index}]`,
      );
    return path;
  });
  return {
    ...policy,
    workspaceInputPaths: [...new Set(paths)].sort(compareStrings),
  };
}

function normalizeSourceRecords(value, workspaceId) {
  if (!Array.isArray(value))
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.SOURCE_INVALID,
      "source records must be an array",
      "$.sourceRecords",
    );
  const records = [];
  const seen = new Set();
  for (const [index, record] of value.entries()) {
    const path = `$.sourceRecords[${index}]`;
    assertPlain(record, path);
    assertExactKeys(record, ["event", "offset", "stream"], path, {
      optional: ["digest"],
    });
    if (
      typeof record.stream !== "string" ||
      !OFFSET_PATTERN.test(record.offset)
    )
      throw contextPackError(
        CONTEXT_PACK_ERROR_CODES.SOURCE_INVALID,
        "source record stream or offset is invalid",
        path,
      );
    try {
      parseStreamName(record.stream, {
        expectedWorkspaceId: workspaceId,
        path: `${path}.stream`,
      });
      validateEventEnvelope(record.event);
    } catch {
      throw contextPackError(
        CONTEXT_PACK_ERROR_CODES.SOURCE_INVALID,
        "source record is not a valid workspace event",
        path,
      );
    }
    if (record.event.workspaceId !== workspaceId)
      throw contextPackError(
        CONTEXT_PACK_ERROR_CODES.SOURCE_SCOPE,
        "source event belongs to another workspace",
        path,
      );
    if (
      !CONTENT_EVENT_TYPES.has(record.event.eventType) &&
      !CONFIG_EVENT_TYPES.has(record.event.eventType)
    )
      continue;
    const digest = digestEventEnvelope(record.event);
    if (record.digest !== undefined && record.digest !== digest)
      throw contextPackError(
        CONTEXT_PACK_ERROR_CODES.SOURCE_INVALID,
        "source record digest does not match event bytes",
        path,
      );
    const key = `${record.stream}\u0000${record.offset}`;
    if (seen.has(key))
      throw contextPackError(
        CONTEXT_PACK_ERROR_CODES.SOURCE_INVALID,
        "source record offset is duplicated",
        path,
      );
    seen.add(key);
    records.push({
      digest,
      event: structuredClone(record.event),
      offset: record.offset,
      stream: record.stream,
    });
  }
  return records.sort(compareRecords);
}

function normalizeSourceHeads(value, records, allowedStreams, workspaceId) {
  const heads = normalizePackSourceHeads(value, workspaceId);
  if (heads.some((head) => !allowedStreams.has(head.stream)))
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.SOURCE_SCOPE,
      "source heads include a stream outside the authorized context",
      "$.sourceHeads",
    );
  if (
    heads.length !== allowedStreams.size ||
    [...allowedStreams].some(
      (stream) => !heads.some((head) => head.stream === stream),
    )
  )
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.SOURCE_HEAD,
      "every authorized context stream requires exactly one source head",
      "$.sourceHeads",
    );
  return heads;
}

function assertHeadCoverage(heads, records) {
  for (const head of heads) {
    const streamRecords = records
      .filter((record) => record.stream === head.stream)
      .sort(compareRecords);
    const last = streamRecords.at(-1);
    if (!last || last.offset !== head.offset || last.digest !== head.digest)
      throw contextPackError(
        CONTEXT_PACK_ERROR_CODES.SOURCE_HEAD,
        "source head does not match the cited durable records",
        "$.sourceHeads",
      );
  }
}

function allowedSourceStreams(input) {
  const streams = new Set([`channel:${input.context.channelId}`]);
  if (input.instructions.length > 0)
    streams.add(`agent:${input.agentId}/config`);
  if (input.workspaceInputs.length > 0)
    streams.add(`workspace:${input.workspaceId}/directory`);
  if (input.attachments.length > 0)
    streams.add(`channel:${input.context.channelId}`);
  return streams;
}

function indexRecords(records) {
  return new Map(
    records.map((record) => [
      `${record.stream}\u0000${record.offset}\u0000${record.digest}`,
      record,
    ]),
  );
}

function requireTriggerRecord(source, byCitation, workspaceId, channelId) {
  const record = byCitation.get(
    `${source.stream}\u0000${source.offset}\u0000${source.digest}`,
  );
  if (
    !record ||
    record.stream !== `channel:${channelId}` ||
    !MESSAGE_EVENT_TYPES.has(record.event.eventType)
  )
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.TRIGGER_INVALID,
      "trigger source is not a cited message event",
      "$.input.trigger.source",
    );
  return record;
}

function assertAuthorization(input) {
  const authorization = input.authorization;
  assertPlain(authorization, "$.input.authorization");
  assertExactKeys(
    authorization,
    ["channel", "channelMembership", "workspaceMembership"],
    "$.input.authorization",
    { optional: [] },
  );
  const workspaceMembership = authorization.workspaceMembership;
  const channel = authorization.channel;
  const channelMembership = authorization.channelMembership;
  for (const [value, path] of [
    [workspaceMembership, "$.input.authorization.workspaceMembership"],
    [channel, "$.input.authorization.channel"],
    [channelMembership, "$.input.authorization.channelMembership"],
  ]) {
    assertPlain(value, path);
    assertPositiveInteger(value.revision, `${path}.revision`);
  }
  if (
    !workspaceMembership ||
    workspaceMembership.workspaceId !== input.workspaceId ||
    workspaceMembership.principalId !== input.principalId ||
    workspaceMembership.role !== "agent" ||
    workspaceMembership.status !== "active"
  )
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.MEMBERSHIP_INACTIVE,
      "agent workspace membership is not active",
      "$.input.authorization.workspaceMembership",
    );
  if (
    !channel ||
    channel.workspaceId !== input.workspaceId ||
    channel.channelId !== input.context.channelId ||
    channel.status !== "active"
  )
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.CHANNEL_INACTIVE,
      "context channel is not active in the authorized workspace",
      "$.input.authorization.channel",
    );
  if (
    !channelMembership ||
    channelMembership.workspaceId !== input.workspaceId ||
    channelMembership.channelId !== input.context.channelId ||
    channelMembership.principalId !== input.principalId ||
    channelMembership.status !== "active"
  )
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.MEMBERSHIP_INACTIVE,
      "agent channel membership is not active",
      "$.input.authorization.channelMembership",
    );
  if (
    ["private", "direct"].includes(channel.kind) &&
    input.policy.includePrivate !== true
  )
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.PRIVATE_SCOPE,
      "private or direct context is disabled by policy",
      "$.policy.includePrivate",
    );
}

function replayMessageHistory(records, workspaceId, channelId) {
  const messages = new Map();
  for (const record of records) {
    const event = record.event;
    if (!MESSAGE_EVENT_TYPES.has(event.eventType)) continue;
    const data = event.data;
    if (!data || data.channelId === undefined) continue;
    if (
      data.channelId !== channelId ||
      record.stream !== `channel:${channelId}`
    )
      throw contextPackError(
        CONTEXT_PACK_ERROR_CODES.MESSAGE_INVALID,
        "message event channel binding is invalid",
        "$.sourceRecords",
      );
    if (
      event.eventType === "channel.message.created" ||
      event.eventType === "channel.message.replied"
    ) {
      validateConversationMessage(
        data,
        workspaceId,
        event.actorId,
        event.eventType,
      );
      if (messages.has(data.messageId))
        throw contextPackError(
          CONTEXT_PACK_ERROR_CODES.HISTORY_INVALID,
          "message id is created more than once",
          "$.sourceRecords",
        );
      messages.set(data.messageId, {
        authorId: data.authorId,
        channelId: data.channelId,
        contentType: data.contentType,
        lastRecord: record,
        messageId: data.messageId,
        revision: 1,
        rootMessageId: data.rootMessageId,
        status: "active",
        text: data.text,
      });
      continue;
    }
    const current = messages.get(data.messageId);
    if (!current || current.channelId !== data.channelId)
      throw contextPackError(
        CONTEXT_PACK_ERROR_CODES.HISTORY_INVALID,
        "message mutation references an unknown or foreign message",
        "$.sourceRecords",
      );
    assertSafeId(data.messageId, "$.sourceRecords[].event.data.messageId");
    assertPositiveInteger(
      data.expectedRevision,
      "$.sourceRecords[].event.data.expectedRevision",
    );
    if (data.expectedRevision !== current.revision)
      throw contextPackError(
        CONTEXT_PACK_ERROR_CODES.HISTORY_INVALID,
        "message mutation revision is not current",
        "$.sourceRecords",
      );
    if (event.eventType === "channel.message.edited") {
      validateConversationText(data.text, "$.sourceRecords[].event.data.text");
      validateMessageContentType(
        data.contentType,
        "$.sourceRecords[].event.data.contentType",
      );
      current.contentType = data.contentType;
      current.lastRecord = record;
      current.revision += 1;
      current.status = "active";
      current.text = data.text;
    } else {
      current.lastRecord = record;
      current.revision += 1;
      current.status = "deleted";
      current.text = null;
    }
  }
  return messages;
}

function validateConversationMessage(data, workspaceId, actorId, eventType) {
  if (!data || typeof data !== "object")
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.MESSAGE_INVALID,
      "message data is missing",
      "$.sourceRecords",
    );
  validateChannelId(data.channelId, { expectedWorkspaceId: workspaceId });
  validatePrincipalId(data.authorId, { expectedWorkspaceId: workspaceId });
  validateMessageContentType(data.contentType);
  validateConversationText(data.text);
  assertSafeId(data.messageId, "$.sourceRecords[].event.data.messageId");
  if (data.rootMessageId !== null)
    assertSafeId(
      data.rootMessageId,
      "$.sourceRecords[].event.data.rootMessageId",
    );
  if (data.authorId !== actorId)
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.MESSAGE_INVALID,
      "message author is not the durable event actor",
      "$.sourceRecords",
    );
  if (eventType === "channel.message.created" && data.rootMessageId !== null)
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.MESSAGE_INVALID,
      "root message must have a null rootMessageId",
      "$.sourceRecords",
    );
  if (eventType === "channel.message.replied" && !data.rootMessageId)
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.MESSAGE_INVALID,
      "reply must carry a rootMessageId",
      "$.sourceRecords",
    );
}

function selectMessageCandidates({
  context,
  messages,
  triggerIndex,
  triggerRootId,
  policy,
}) {
  const ordered = [...messages.values()]
    .filter((message) => message.status === "active")
    .sort(compareMessages);
  const indexById = new Map(
    ordered.map((message, index) => [message.messageId, index]),
  );
  const candidates = ordered.filter((message) => {
    if (context.scope === "none" || context.scope === "workspace")
      return message.messageId === ordered[triggerIndex]?.messageId;
    if (context.scope === "current-thread")
      return (message.rootMessageId ?? message.messageId) === triggerRootId;
    return true;
  });
  const omitted = [];
  const depthAllowed = candidates.filter((message) => {
    const distance = Math.abs(
      (indexById.get(message.messageId) ?? 0) - triggerIndex,
    );
    if (distance <= policy.maxHistoryDepth) return true;
    omitted.push(omittedItem(message.lastRecord, message, "history-depth"));
    return false;
  });
  let selected = depthAllowed;
  if (!policy.includeThreadHistory && context.scope === "current-channel") {
    selected = selected.filter(
      (message) => message.messageId === ordered[triggerIndex]?.messageId,
    );
    for (const message of depthAllowed)
      if (message.messageId !== ordered[triggerIndex]?.messageId)
        omitted.push(
          omittedItem(message.lastRecord, message, "thread-history-disabled"),
        );
  }
  if (selected.length > policy.maxMessages) {
    const nearest = [...selected].sort((left, right) => {
      const leftDistance = Math.abs(
        (indexById.get(left.messageId) ?? 0) - triggerIndex,
      );
      const rightDistance = Math.abs(
        (indexById.get(right.messageId) ?? 0) - triggerIndex,
      );
      return leftDistance - rightDistance || compareMessages(right, left);
    });
    const keep = new Set(
      nearest.slice(0, policy.maxMessages).map((message) => message.messageId),
    );
    for (const message of selected)
      if (!keep.has(message.messageId))
        omitted.push(omittedItem(message.lastRecord, message, "message-limit"));
    selected = selected.filter((message) => keep.has(message.messageId));
  }
  selected.sort(compareMessages);
  return { omitted, selected };
}

function messageItem(message) {
  return {
    citation: citationFor(
      message.lastRecord,
      message.authorId,
      "conversation-message",
    ),
    content: {
      channelId: message.channelId,
      contentType: message.contentType,
      messageId: message.messageId,
      revision: message.revision,
      rootMessageId: message.rootMessageId,
      text: message.text,
    },
    contentKind: "conversation-message",
    id: `message:${message.messageId}`,
    ordinal: 0,
    trust: "untrusted-content",
  };
}

function normalizeInstructionItem(input, byCitation, normalized) {
  assertPlain(input, "$.instructions[]");
  assertExactKeys(
    input,
    ["id", "revision", "source", "text"],
    "$.instructions[]",
    { optional: [] },
  );
  assertSafeId(input.id, "$.instructions[].id");
  assertPositiveInteger(input.revision, "$.instructions[].revision");
  assertText(input.text, "$.instructions[].text", 1, 16_000);
  const record = findCitedRecord(
    input.source,
    byCitation,
    normalized.workspaceId,
  );
  if (
    !CONFIG_EVENT_TYPES.has(record.event.eventType) ||
    record.stream !== `agent:${normalized.agentId}/config` ||
    record.event.data?.agentId !== normalized.agentId
  )
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.INSTRUCTION_SCOPE,
      "instruction source is not the active agent configuration stream",
      "$.instructions[].source",
    );
  return {
    citation: citationFor(record, record.event.actorId, "agent-instruction"),
    id: input.id,
    revision: input.revision,
    text: input.text,
    trust: "trusted-instructions",
  };
}

function normalizeWorkspaceInputItem(input, byCitation, normalized) {
  assertPlain(input, "$.workspaceInputs[]");
  assertExactKeys(
    input,
    ["bytes", "digest", "path", "source"],
    "$.workspaceInputs[]",
    { optional: ["text"] },
  );
  assertNonNegativeInteger(input.bytes, "$.workspaceInputs[].bytes");
  if (!DIGEST_PATTERN.test(input.digest))
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.WORKSPACE_INPUT_SCOPE,
      "workspace input digest is invalid",
      "$.workspaceInputs[].digest",
    );
  if (
    !SAFE_PATH.test(input.path) ||
    !normalized.policy.workspaceInputPaths.some(
      (allowed) =>
        input.path === allowed || input.path.startsWith(`${allowed}/`),
    )
  )
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.WORKSPACE_INPUT_SCOPE,
      "workspace input path is not explicitly permitted",
      "$.workspaceInputs[].path",
    );
  if (input.text !== undefined)
    assertText(
      input.text,
      "$.workspaceInputs[].text",
      0,
      normalized.policy.maxAttachmentBytes * 4,
    );
  const record = findCitedRecord(
    input.source,
    byCitation,
    normalized.workspaceId,
  );
  if (record.stream !== `workspace:${normalized.workspaceId}/directory`)
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.WORKSPACE_INPUT_SCOPE,
      "workspace input is not cited to the directory stream",
      "$.workspaceInputs[].source",
    );
  return {
    citation: citationFor(record, record.event.actorId, "workspace-file"),
    content: {
      ...(input.text === undefined ? {} : { text: input.text }),
      bytes: input.bytes,
      digest: input.digest,
      path: input.path,
    },
    contentKind: "workspace-file",
    id: `workspace-file:${input.path}`,
    ordinal: 0,
    trust: "untrusted-content",
  };
}

function normalizeAttachmentItem(input, byCitation, normalized) {
  assertPlain(input, "$.attachments[]");
  assertExactKeys(
    input,
    ["attachmentId", "bytes", "digest", "mediaType", "source"],
    "$.attachments[]",
    { optional: ["text"] },
  );
  assertSafeId(input.attachmentId, "$.attachments[].attachmentId");
  assertNonNegativeInteger(input.bytes, "$.attachments[].bytes");
  if (!DIGEST_PATTERN.test(input.digest))
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.ATTACHMENT_LIMIT,
      "attachment digest is invalid",
      "$.attachments[].digest",
    );
  assertText(input.mediaType, "$.attachments[].mediaType", 1, 120);
  if (input.text !== undefined)
    assertText(
      input.text,
      "$.attachments[].text",
      0,
      normalized.policy.maxAttachmentBytes * 4,
    );
  const record = findCitedRecord(
    input.source,
    byCitation,
    normalized.workspaceId,
  );
  if (record.stream !== `channel:${normalized.context.channelId}`)
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.ATTACHMENT_LIMIT,
      "attachment is not cited to the triggering channel",
      "$.attachments[].source",
    );
  return {
    citation: citationFor(record, record.event.actorId, "attachment"),
    content: {
      ...(input.text === undefined ? {} : { text: input.text }),
      attachmentId: input.attachmentId,
      bytes: input.bytes,
      digest: input.digest,
      mediaType: input.mediaType,
    },
    contentKind: "attachment",
    id: `attachment:${input.attachmentId}`,
    ordinal: 0,
    trust: "untrusted-attachment",
  };
}

function findCitedRecord(source, byCitation, workspaceId) {
  const normalized = normalizeCitationSource(source, "$.source", workspaceId);
  const record = byCitation.get(
    `${normalized.stream}\u0000${normalized.offset}\u0000${normalized.digest}`,
  );
  if (!record)
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.SOURCE_INVALID,
      "cited source record is not present in the supplied durable history",
      "$.source",
    );
  return record;
}

function citationFor(record, principalId, contentKind) {
  return {
    contentKind,
    eventDigest: record.digest,
    offset: record.offset,
    principalId,
    stream: record.stream,
  };
}

function omittedItem(recordOrCitation, item, reason) {
  const citation = recordOrCitation?.event
    ? citationFor(
        recordOrCitation,
        item.authorId ?? recordOrCitation.event.actorId,
        "conversation-message",
      )
    : recordOrCitation;
  const startOffset = citation.offset;
  return {
    bytes: item.text
      ? new TextEncoder().encode(item.text).length
      : (item.content?.bytes ?? 0),
    citation,
    contentKind: item.contentKind ?? "conversation-message",
    estimatedTokens: estimateTokens(item.text ?? item.content?.text ?? ""),
    id: item.messageId ? `message:${item.messageId}` : item.id,
    reason,
    sourceRange: {
      endOffset: startOffset,
      startOffset,
      stream: citation.stream,
    },
    trust: item.trust ?? "untrusted-content",
  };
}

function accountItems(items, accounting) {
  let next = accounting;
  for (const item of items) next = accountItem(item, next).accounting;
  return { accounting: next };
}

function accountItem(item, accounting) {
  const serialized = canonicalJson(item.content ?? item);
  const bytes = new TextEncoder().encode(serialized).length;
  const text = item.content?.text ?? item.text ?? "";
  const estimatedTokens = estimateTokens(text);
  const historyItems = item.contentKind === "conversation-message" ? 1 : 0;
  const attachmentBytes =
    item.contentKind === "workspace-file" || item.contentKind === "attachment"
      ? (item.content?.bytes ?? 0)
      : 0;
  return {
    accounting: {
      attachmentBytes: accounting.attachmentBytes + attachmentBytes,
      bytes: accounting.bytes + bytes,
      estimatedTokens: accounting.estimatedTokens + estimatedTokens,
      historyItems: accounting.historyItems + historyItems,
      items: accounting.items + 1,
    },
    bytes,
    estimatedTokens,
  };
}

function emptyAccounting() {
  return {
    attachmentBytes: 0,
    bytes: 0,
    estimatedTokens: 0,
    historyItems: 0,
    items: 0,
  };
}

function fitsLimits(accounting, policy) {
  return (
    accounting.bytes <= policy.maxBytes &&
    accounting.estimatedTokens <= policy.maxEstimatedTokens &&
    accounting.attachmentBytes <= policy.maxAttachmentBytes &&
    accounting.items <= policy.maxItems
  );
}

function normalizeContent(value, path) {
  assertPlain(value, path);
  for (const [key, item] of Object.entries(value)) {
    if (key === "text") assertText(item, `${path}.text`, 0, 16_000_000);
    else if (key === "path") {
      assertText(item, `${path}.path`, 1, 240);
      if (!SAFE_PATH.test(item))
        throw contextPackError(
          CONTEXT_PACK_ERROR_CODES.PACK_INVALID,
          "content path is not canonical",
          `${path}.path`,
        );
    } else if (typeof item === "object" && item !== null)
      normalizeContent(item, `${path}.${key}`);
  }
  canonicalJson(value, path);
  return value;
}

function packPayload(value) {
  const payload = structuredClone(value);
  delete payload.packDigest;
  return payload;
}

function scanSecrets(value) {
  const text = canonicalJson(value);
  if (
    /PRIVATE KEY|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|(?:api[_-]?key|password|secret|token)\s*[:=]\s*[A-Za-z0-9._~+/=-]{8,}|\brcap_[A-Za-z0-9_-]{20,}\b/iu.test(
      text,
    )
  )
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.PACK_INVALID,
      "context pack contains credential-shaped material",
      "$.pack",
    );
}

function validateAgentId(value, workspaceId, path) {
  if (
    typeof value !== "string" ||
    !/^ag_[0-9a-hjkmnp-tv-z]{26}_[0-9a-hjkmnp-tv-z]{26}$/u.test(value) ||
    `ws_${value.slice(3, 29)}` !== workspaceId
  )
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.INPUT_INVALID,
      "agentId is outside the workspace",
      path,
    );
}

function compareRecords(left, right) {
  return (
    compareStrings(left.stream, right.stream) ||
    compareStrings(left.offset, right.offset)
  );
}

function compareSourceRefs(left, right) {
  return (
    compareStrings(left.stream, right.stream) ||
    compareStrings(left.offset, right.offset)
  );
}

function compareMessages(left, right) {
  return (
    compareStrings(left.lastRecord.offset, right.lastRecord.offset) ||
    compareStrings(left.messageId, right.messageId)
  );
}

function compareOmitted(left, right) {
  return (
    compareStrings(left.citation.stream, right.citation.stream) ||
    compareStrings(left.citation.offset, right.citation.offset) ||
    compareStrings(left.id, right.id)
  );
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function messageOrderIndex(messages, messageId) {
  return [...messages.values()]
    .filter((message) => message.status === "active")
    .sort(compareMessages)
    .findIndex((message) => message.messageId === messageId);
}

function estimateTokens(text) {
  return Math.ceil([...String(text)].length / 4);
}

function assertExactKeys(value, keys, path, { optional = [] } = {}) {
  const allowed = new Set([...keys, ...optional]);
  for (const key of Object.keys(value))
    if (!allowed.has(key))
      throw contextPackError(
        CONTEXT_PACK_ERROR_CODES.INPUT_INVALID,
        `${key} is not allowed`,
        `${path}.${key}`,
      );
  for (const key of keys)
    if (!Object.hasOwn(value, key) && !optional.includes(key))
      throw contextPackError(
        CONTEXT_PACK_ERROR_CODES.INPUT_INVALID,
        `${key} is required`,
        `${path}.${key}`,
      );
}

function assertPlain(value, path) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.INPUT_INVALID,
      "value must be a plain object",
      path,
    );
}

function assertText(value, path, min, max) {
  if (typeof value !== "string" || value.length < min || value.length > max)
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.UNICODE_INVALID,
      "text is outside its bounded range",
      path,
    );
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      (code >= 0xd800 &&
        code <= 0xdbff &&
        !(
          value.charCodeAt(index + 1) >= 0xdc00 &&
          value.charCodeAt(index + 1) <= 0xdfff
        )) ||
      (code >= 0xdc00 &&
        code <= 0xdfff &&
        !(
          value.charCodeAt(index - 1) >= 0xd800 &&
          value.charCodeAt(index - 1) <= 0xdbff
        ))
    )
      throw contextPackError(
        CONTEXT_PACK_ERROR_CODES.UNICODE_INVALID,
        "text contains an unpaired surrogate",
        path,
      );
  }
}

function assertSafeId(value, path) {
  if (typeof value !== "string" || !SAFE_ITEM_ID.test(value))
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.INPUT_INVALID,
      "bounded identifier is invalid",
      path,
    );
}

function assertPositiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.INPUT_INVALID,
      "value must be a positive safe integer",
      path,
    );
}

function assertNonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.INPUT_INVALID,
      "value must be a non-negative safe integer",
      path,
    );
}

function assertUnique(values, label, path) {
  if (new Set(values).size !== values.length)
    throw contextPackError(
      CONTEXT_PACK_ERROR_CODES.SOURCE_INVALID,
      `${label} contains duplicates`,
      path,
    );
}

function contextPackError(code, detail, path) {
  return new ContextPackError(code, detail, { path });
}

function freezeDeep(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  return Object.freeze(value);
}
