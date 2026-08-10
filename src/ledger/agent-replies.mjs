import {
  deriveRunControlId,
  TERMINAL_RUN_STATES_V1,
  validateAgentConfigAgentId,
  validateAgentReplyProvenance,
  validateConversationText,
  validateInvocationRequestedData,
  validatePrincipalId,
  assertSourceReference,
  validateWorkspaceId,
} from "@stream-slack/protocol";

import { canonicalSha256 } from "./canonical-json.mjs";
import { digestEventEnvelope, validateEventEnvelope } from "./envelope.mjs";
import { streamNames } from "./topology.mjs";

export const AGENT_REPLY_ERROR_CODES = Object.freeze({
  ACTOR_MISMATCH: "AGENT_REPLY_ACTOR_MISMATCH",
  AGENT_INACTIVE: "AGENT_REPLY_AGENT_INACTIVE",
  ACK_UNKNOWN: "AGENT_REPLY_ACK_UNKNOWN",
  AUTHORITY_REVOKED: "AGENT_REPLY_AUTHORITY_REVOKED",
  BUDGET_EXCEEDED: "AGENT_REPLY_BUDGET_EXCEEDED",
  CHANNEL_INACTIVE: "AGENT_REPLY_CHANNEL_INACTIVE",
  CONTEXT_MISSING: "AGENT_REPLY_CONTEXT_MISSING",
  DISPATCH_REFUSED: "AGENT_REPLY_DISPATCH_REFUSED",
  INVALID_REQUEST: "AGENT_REPLY_INVALID_REQUEST",
  INVOCATION_MISMATCH: "AGENT_REPLY_INVOCATION_MISMATCH",
  LEASE_INVALID: "AGENT_REPLY_LEASE_INVALID",
  MEMBERSHIP_INACTIVE: "AGENT_REPLY_MEMBERSHIP_INACTIVE",
  OUTPUT_INVALID: "AGENT_REPLY_OUTPUT_INVALID",
  OUTPUT_TOO_LARGE: "AGENT_REPLY_OUTPUT_TOO_LARGE",
  ROOT_INVALID: "AGENT_REPLY_ROOT_INVALID",
  RUN_NOT_ACTIVE: "AGENT_REPLY_RUN_NOT_ACTIVE",
  RUN_TERMINAL: "AGENT_REPLY_RUN_TERMINAL",
  SNAPSHOT_MISMATCH: "AGENT_REPLY_SNAPSHOT_MISMATCH",
  SOURCE_INVALID: "AGENT_REPLY_SOURCE_INVALID",
  SCOPE_MISMATCH: "AGENT_REPLY_SCOPE_MISMATCH",
});

const REFUSAL_KIND = "agent-reply.refusal";
const CONTEXT_KINDS = new Set(["context", "context-pack", "context.pack"]);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;
const RUN_PATTERN = /^rn_[0-9a-hjkmnp-tv-z]{26}_[0-9a-hjkmnp-tv-z]{26}$/u;
const SECRET_REPLACEMENTS = Object.freeze([
  {
    pattern:
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  {
    pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/giu,
    replacement: "$1 [REDACTED]",
  },
  {
    pattern: /\b(?:sk|rk|pk)-[A-Za-z0-9][A-Za-z0-9_-]{15,}\b/gu,
    replacement: "[REDACTED_API_KEY]",
  },
  {
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/gu,
    replacement: "[REDACTED_TOKEN]",
  },
  {
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/gu,
    replacement: "[REDACTED_TOKEN]",
  },
  {
    pattern: /\bAKIA[0-9A-Z]{16}\b/gu,
    replacement: "[REDACTED_ACCESS_KEY]",
  },
  {
    pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/gu,
    replacement: "[REDACTED_API_KEY]",
  },
  {
    pattern:
      /\b(?:access[_-]?token|api[_-]?key|client[_-]?secret|password|secret|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}["']?/giu,
    replacement: "[REDACTED_SECRET]",
  },
]);

export class AgentReplyError extends Error {
  constructor(code, detail, context = {}) {
    super(`${code}: ${detail}`);
    this.name = "AgentReplyError";
    this.code = code;
    this.detail = detail;
    Object.assign(this, context);
  }

  toJSON() {
    return {
      artifact: this.artifact ?? null,
      code: this.code,
      detail: this.detail,
      name: this.name,
      runId: this.runId ?? null,
    };
  }
}

/**
 * Bind a harness final output to the immutable invocation and the live lease,
 * then send it through the ordinary conversation dispatcher. The request only
 * carries routing hints (run/worker) and output; every message and provenance
 * field is derived from durable sources inside the lease mutation callback.
 */
export function createAgentReplyDispatcher({
  appendRefusal,
  clock = () => new Date(),
  dispatch,
  leaseCoordinator,
  maxOutputBytes = 16_000,
  readAuthority,
  readChannel,
  readInvocation,
  readRun,
  readSource,
  workspaceId,
} = {}) {
  validateWorkspaceId(workspaceId);
  if (typeof dispatch !== "function") {
    throw new TypeError(
      "agent reply dispatcher requires the message dispatch door",
    );
  }
  if (!leaseCoordinator || typeof leaseCoordinator.mutate !== "function") {
    throw new TypeError("agent reply dispatcher requires a lease coordinator");
  }
  for (const [name, callback] of Object.entries({
    appendRefusal,
    readAuthority,
    readChannel,
    readInvocation,
    readRun,
    readSource,
  })) {
    if (typeof callback !== "function") {
      throw new TypeError(`agent reply dispatcher requires ${name}`);
    }
  }
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 1_000_000
  ) {
    throw new TypeError(
      "agent reply maxOutputBytes must be between 1 and 1000000",
    );
  }
  if (typeof clock !== "function") {
    throw new TypeError("agent reply clock must be a function");
  }

  const refusalWrites = new Map();

  async function dispatchReply(request = {}) {
    const normalized = validateRequest(request);
    const output = sanitizeOutput(normalized.output);
    const outputDigest = canonicalSha256({ output: normalized.output });
    const requestContext = {
      output,
      outputDigest,
      runId: normalized.runId,
      workerId: normalized.workerId,
    };

    try {
      const mutation = await leaseCoordinator.mutate({
        capability: normalized.capability,
        endpoint: "run.reply.write",
        now: clock(),
        runId: normalized.runId,
        workerId: normalized.workerId,
        mutate: async ({ scope }) => {
          try {
            return await commitReply({
              output,
              outputDigest,
              scope,
              workerId: normalized.workerId,
            });
          } catch (error) {
            throw withRefusalContext(error, {
              ...requestContext,
              scope,
            });
          }
        },
      });
      return mutation.result;
    } catch (error) {
      if (
        error instanceof AgentReplyError &&
        error.code === AGENT_REPLY_ERROR_CODES.ACK_UNKNOWN
      ) {
        throw error;
      }
      const refusal = normalizeRefusal(error, requestContext);
      if (!refusal.recordRefusal) throw refusal;
      const artifact = await writeRefusal(refusal, requestContext);
      refusal.artifact = artifact;
      throw refusal;
    }
  }

  async function commitReply({ output, outputDigest, scope, workerId }) {
    if (!scope) {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.SCOPE_MISMATCH,
        "lease scope is outside the reply workspace",
      );
    }
    validateAgentConfigAgentId(scope.agentId, {
      expectedWorkspaceId: workspaceId,
    });
    if (!RUN_PATTERN.test(scope.runId)) {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.LEASE_INVALID,
        "lease run scope is invalid",
      );
    }
    const invocation = await resolveInvocation(scope);
    const source = await resolveSource(invocation.data.sourceTrigger);
    const channelId = source.event.data.channelId;
    const agentPrincipalId = agentPrincipalIdFor(scope.agentId);
    assertSourceTargetsAgent(source, agentPrincipalId);
    const authority = await resolveAuthority({
      agentId: scope.agentId,
      agentPrincipalId,
      channelId,
      invocationId: scope.invocationId,
      runId: scope.runId,
      workerId,
    });
    assertAuthority(authority, { agentPrincipalId, channelId });
    const channel = await resolveChannel(channelId);
    const run = await resolveRun(scope);
    assertRunIsCurrent(run, scope);
    assertOutputBudget(
      Math.max(output.rawByteLength, output.byteLength),
      outputDigest,
      invocation.data.policy,
      run,
    );
    const context = resolveContext(run);
    const rootMessageId = deriveThreadRoot(source.event.data);
    assertRoot(channel, channelId, rootMessageId);

    const provenance = {
      agentId: scope.agentId,
      agentPrincipalId,
      attemptId: scope.attemptId,
      channelId,
      contextDigest: context.ref.digest,
      contextRef: context.ref,
      invocationId: scope.invocationId,
      invocationRef: invocation.ref,
      leaseGeneration: scope.leaseGeneration,
      runId: scope.runId,
      schemaVersion: 1,
      snapshotDigest: invocation.data.snapshotDigest,
      snapshotRef: invocation.data.snapshotRef,
      sourceMention: invocation.data.sourceTrigger,
      threadRootMessageId: rootMessageId,
    };
    validateAgentReplyProvenance(provenance, {
      expectedAgentId: scope.agentId,
      expectedAgentPrincipalId: agentPrincipalId,
      expectedChannelId: channelId,
      expectedWorkspaceId: workspaceId,
    });

    const messageId = deriveRunControlId("msg", {
      attemptId: provenance.attemptId,
      invocationId: provenance.invocationId,
      leaseGeneration: provenance.leaseGeneration,
      runId: provenance.runId,
      sourceMention: provenance.sourceMention,
      workspaceId,
    });
    const idempotencyKey = deriveRunControlId("ik", {
      kind: "agent-reply",
      messageId,
      provenance,
    });
    const result = await dispatch({
      actorId: agentPrincipalId,
      idempotencyKey,
      operation: "channel.message.reply",
      payload: {
        agentReplyProvenance: provenance,
        channelId,
        contentType: "text/plain",
        messageId,
        rootMessageId,
        text: output.text,
      },
      workspaceId,
    });
    assertAcceptedReply(result, provenance, agentPrincipalId);
    return {
      messageId,
      output: {
        byteLength: output.byteLength,
        digest: outputDigest,
        redacted: output.redacted,
      },
      provenance,
      receipt: result?.receipt ?? null,
      result: "accepted",
    };
  }

  async function resolveInvocation(scope) {
    const raw = await readInvocation({
      invocationId: scope.invocationId,
      workspaceId,
    });
    const record = normalizeRecord(raw, "invocation", workspaceId);
    const event = record.event;
    if (event.eventType !== "workspace.invocation.requested") {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.INVOCATION_MISMATCH,
        "lease invocation does not cite an invocation request",
      );
    }
    try {
      validateInvocationRequestedData(event.data, {
        expectedWorkspaceId: workspaceId,
      });
    } catch (error) {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.INVOCATION_MISMATCH,
        safeDetail(error, "invocation data is invalid"),
      );
    }
    if (
      event.workspaceId !== workspaceId ||
      event.data.invocationId !== scope.invocationId ||
      event.data.agentId !== scope.agentId
    ) {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.INVOCATION_MISMATCH,
        "invocation binding does not match the active lease",
      );
    }
    return {
      data: event.data,
      event,
      ref: sourceReferenceForRecord(
        record,
        streamNames.workspaceInvocations(workspaceId),
      ),
    };
  }

  async function resolveSource(reference) {
    try {
      assertSourceReference(reference, "$.sourceMention", workspaceId);
    } catch (error) {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.SOURCE_INVALID,
        safeDetail(error, "source mention reference is invalid"),
      );
    }
    const record = normalizeRecord(
      await readSource({ reference, workspaceId }),
      "source",
      workspaceId,
    );
    const actual = sourceReferenceForRecord(record, reference.stream);
    if (!sameReference(reference, actual)) {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.SOURCE_INVALID,
        "source mention reference does not match the durable message event",
      );
    }
    if (
      !["channel.message.created", "channel.message.replied"].includes(
        record.event.eventType,
      )
    ) {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.SOURCE_INVALID,
        "source mention does not cite a message event",
      );
    }
    if (!Array.isArray(record.event.data.mentions)) {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.SOURCE_INVALID,
        "source mention has no canonical structured mention facts",
      );
    }
    if (
      reference.stream !==
      streamNames.channel(workspaceId, record.event.data.channelId)
    ) {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.SOURCE_INVALID,
        "source mention stream does not match its message channel",
      );
    }
    return record;
  }

  async function resolveAuthority(input) {
    try {
      return await readAuthority({ ...input, workspaceId });
    } catch {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.AUTHORITY_REVOKED,
        "current authority could not be resolved",
      );
    }
  }

  async function resolveChannel(channelId) {
    const raw = await readChannel({ channelId, workspaceId });
    const state = raw?.state ?? raw;
    const channel = raw?.channel ?? state?.entities?.channels?.[channelId];
    const messages =
      raw?.messages ?? Object.values(state?.entities?.messages ?? {});
    if (
      !channel ||
      channel.channelId !== channelId ||
      channel.status !== "active"
    ) {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.CHANNEL_INACTIVE,
        "reply channel is not currently active",
      );
    }
    return { channel, messages };
  }

  async function resolveRun(scope) {
    const raw = await readRun({ runId: scope.runId, workspaceId });
    const records = Array.isArray(raw) ? raw : raw?.records;
    if (Array.isArray(records)) {
      return {
        records: records.map((record) =>
          normalizeRecord(record, "run", workspaceId),
        ),
      };
    }
    if (raw?.state && typeof raw.state === "object") return raw;
    throw refusal(
      AGENT_REPLY_ERROR_CODES.RUN_NOT_ACTIVE,
      "run source is not readable",
    );
  }

  function assertRunIsCurrent(run, scope) {
    if (run.state) {
      if (TERMINAL_RUN_STATES_V1.includes(run.state.status)) {
        throw refusal(AGENT_REPLY_ERROR_CODES.RUN_TERMINAL, "run is terminal");
      }
      if (
        run.state.status !== "running" &&
        run.state.status !== "awaiting-approval"
      ) {
        throw refusal(
          AGENT_REPLY_ERROR_CODES.RUN_NOT_ACTIVE,
          "run is not executing",
        );
      }
      if (
        run.state.activeAttempt?.attemptId !== scope.attemptId ||
        run.state.activeAttempt?.leaseGeneration !== scope.leaseGeneration
      ) {
        throw refusal(
          AGENT_REPLY_ERROR_CODES.LEASE_INVALID,
          "run attempt is not the leased attempt",
        );
      }
      return;
    }
    const events = run.records.map((record) => record.event);
    const lifecycles = events.filter(
      (event) => event.eventType === "run.lifecycle.changed",
    );
    const current = lifecycles.at(-1);
    if (!current || current.data.runId !== scope.runId) {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.RUN_NOT_ACTIVE,
        "run has no current lifecycle",
      );
    }
    if (TERMINAL_RUN_STATES_V1.includes(current.data.to)) {
      throw refusal(AGENT_REPLY_ERROR_CODES.RUN_TERMINAL, "run is terminal");
    }
    if (!["running", "awaiting-approval"].includes(current.data.to)) {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.RUN_NOT_ACTIVE,
        "run is not executing",
      );
    }
    if (
      current.data.attemptId !== scope.attemptId ||
      current.data.leaseGeneration !== scope.leaseGeneration
    ) {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.LEASE_INVALID,
        "run lifecycle does not match the active lease",
      );
    }
  }

  function resolveContext(run) {
    if (run.state?.contextRef) {
      try {
        assertSourceReference(
          run.state.contextRef,
          "$.run.contextRef",
          workspaceId,
        );
      } catch (error) {
        throw refusal(
          AGENT_REPLY_ERROR_CODES.CONTEXT_MISSING,
          safeDetail(error, "run context citation is invalid"),
        );
      }
      return { ref: run.state.contextRef };
    }
    const records = run.records ?? [];
    const contexts = records
      .filter(
        (record) =>
          record.event.eventType === "run.activity.recorded" &&
          CONTEXT_KINDS.has(record.event.data?.kind) &&
          record.event.data?.contentRef,
      )
      .at(-1);
    if (!contexts) {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.CONTEXT_MISSING,
        "run has no durable context-pack citation",
      );
    }
    try {
      assertSourceReference(
        contexts.event.data.contentRef,
        "$.run.contextRef",
        workspaceId,
      );
    } catch (error) {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.CONTEXT_MISSING,
        safeDetail(error, "run context citation is invalid"),
      );
    }
    return { ref: contexts.event.data.contentRef };
  }

  function assertOutputBudget(byteLength, outputDigest, policy, run) {
    if (byteLength > maxOutputBytes) {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.OUTPUT_TOO_LARGE,
        "reply output exceeds the dispatcher bound",
      );
    }
    const maxPolicyBytes = policy?.maxOutputBytes;
    const used = usageOutputBytes(run);
    if (
      Number.isSafeInteger(maxPolicyBytes) &&
      (byteLength > maxPolicyBytes || used + byteLength > maxPolicyBytes)
    ) {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.BUDGET_EXCEEDED,
        "reply output exceeds the immutable run output budget",
      );
    }
    if (!DIGEST_PATTERN.test(outputDigest)) {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.OUTPUT_INVALID,
        "reply output digest is invalid",
      );
    }
  }

  function assertRoot(channel, channelId, rootMessageId) {
    const root = channel.messages.find(
      (message) => message.messageId === rootMessageId,
    );
    if (
      !root ||
      root.channelId !== channelId ||
      root.status === "deleted" ||
      (root.rootMessageId !== undefined && root.rootMessageId !== null)
    ) {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.ROOT_INVALID,
        "reply thread root is not a visible root in the source channel",
      );
    }
  }

  function assertAuthority(authority, { agentPrincipalId, channelId }) {
    const value = authority?.authority ?? authority;
    const principal = value?.principal;
    const workspaceMembership = value?.workspaceMembership;
    const channel = value?.channel;
    const channelMembership = value?.channelMembership;
    if (value?.workspaceStatus !== "active") {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.AUTHORITY_REVOKED,
        "workspace authority is not active",
      );
    }
    if (value?.agentStatus !== "active") {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.AGENT_INACTIVE,
        "agent lifecycle is not active",
      );
    }
    if (
      !principal ||
      principal.principalId !== agentPrincipalId ||
      principal.kind !== "agent" ||
      principal.status !== "active"
    ) {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.ACTOR_MISMATCH,
        "active agent actor is not current",
      );
    }
    if (
      !workspaceMembership ||
      workspaceMembership.principalId !== agentPrincipalId ||
      workspaceMembership.status !== "active"
    ) {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.MEMBERSHIP_INACTIVE,
        "agent workspace membership is not active",
      );
    }
    if (
      !channel ||
      channel.channelId !== channelId ||
      channel.status !== "active"
    ) {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.CHANNEL_INACTIVE,
        "reply channel is not active",
      );
    }
    if (
      !channelMembership ||
      channelMembership.channelId !== channelId ||
      channelMembership.principalId !== agentPrincipalId ||
      channelMembership.status !== "active"
    ) {
      throw refusal(
        AGENT_REPLY_ERROR_CODES.MEMBERSHIP_INACTIVE,
        "agent channel membership is not active",
      );
    }
  }

  return Object.freeze({ dispatchReply });

  async function writeRefusal(error, requestContext) {
    const context = error.refusalContext ?? requestContext;
    const artifact = createAgentReplyRefusalArtifact({
      agentId: context.scope?.agentId ?? null,
      agentPrincipalId: context.provenance?.agentPrincipalId ?? null,
      attemptId: context.scope?.attemptId ?? null,
      channelId: context.provenance?.channelId ?? null,
      contextRef: context.provenance?.contextRef ?? null,
      invocationId: context.scope?.invocationId ?? null,
      leaseGeneration: context.scope?.leaseGeneration ?? null,
      output: context.output,
      outputDigest: context.outputDigest,
      provenance: context.provenance ?? null,
      refusalCode: error.code,
      runId: context.scope?.runId ?? context.runId,
      workspaceId,
    });
    const key = artifact.idempotencyKey;
    if (!refusalWrites.has(key)) {
      refusalWrites.set(key, Promise.resolve(appendRefusal(artifact)));
    }
    await refusalWrites.get(key);
    return artifact;
  }
}

export function createAgentReplyRefusalArtifact({
  agentId = null,
  agentPrincipalId = null,
  attemptId = null,
  channelId = null,
  contextRef = null,
  invocationId = null,
  leaseGeneration = null,
  output,
  outputDigest,
  provenance = null,
  refusalCode,
  runId,
  workspaceId,
}) {
  validateWorkspaceId(workspaceId);
  if (typeof runId !== "string" || !RUN_PATTERN.test(runId)) {
    throw new TypeError("refusal artifact requires a scoped run id");
  }
  if (typeof refusalCode !== "string" || !TOKEN_PATTERN.test(refusalCode)) {
    throw new TypeError("refusal artifact requires a typed refusal code");
  }
  const safeOutput = output ?? { byteLength: 0, redacted: false };
  const artifactId = deriveRunControlId("art", {
    attemptId,
    invocationId,
    leaseGeneration,
    outputDigest,
    refusalCode,
    runId,
    workspaceId,
  });
  const artifact = {
    agentId,
    agentPrincipalId,
    artifactId,
    attemptId,
    byteLength: safeOutput.byteLength,
    channelId,
    contextRef,
    invocationId,
    kind: REFUSAL_KIND,
    leaseGeneration,
    mediaType: "application/json",
    outputDigest,
    outputRedacted: safeOutput.redacted,
    provenance,
    refusalCode,
    runId,
    schemaVersion: 1,
    workspaceId,
  };
  return {
    ...artifact,
    idempotencyKey: deriveRunControlId("ik", artifact),
  };
}

export function sanitizeAgentReplyOutput(value) {
  return sanitizeOutput(value);
}

function validateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentReplyError(
      AGENT_REPLY_ERROR_CODES.INVALID_REQUEST,
      "reply request must be an object",
    );
  }
  const keys = ["capability", "output", "runId", "workerId"];
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new AgentReplyError(
        AGENT_REPLY_ERROR_CODES.INVALID_REQUEST,
        `${key} is a routing or provenance override`,
      );
    }
  }
  if (typeof value.capability !== "string" || value.capability.length < 16) {
    throw new AgentReplyError(
      AGENT_REPLY_ERROR_CODES.INVALID_REQUEST,
      "reply capability is required",
    );
  }
  if (typeof value.runId !== "string" || !RUN_PATTERN.test(value.runId)) {
    throw new AgentReplyError(
      AGENT_REPLY_ERROR_CODES.INVALID_REQUEST,
      "reply runId is required",
    );
  }
  if (
    typeof value.workerId !== "string" ||
    !TOKEN_PATTERN.test(value.workerId)
  ) {
    throw new AgentReplyError(
      AGENT_REPLY_ERROR_CODES.INVALID_REQUEST,
      "reply workerId is required",
    );
  }
  if (typeof value.output !== "string") {
    throw new AgentReplyError(
      AGENT_REPLY_ERROR_CODES.OUTPUT_INVALID,
      "reply output must be text",
    );
  }
  return value;
}

function sanitizeOutput(value) {
  const raw = value.normalize("NFC");
  const rawBytes = Buffer.byteLength(raw, "utf8");
  let text = raw;
  let redacted = false;
  for (const { pattern, replacement } of SECRET_REPLACEMENTS) {
    const next = text.replace(pattern, replacement);
    redacted ||= next !== text;
    text = next;
  }
  // The message contract is text/plain, but escape markup before it reaches a
  // renderer so a reply can never turn a canary into executable HTML.
  text = text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  try {
    validateConversationText(text);
  } catch (error) {
    throw new AgentReplyError(
      AGENT_REPLY_ERROR_CODES.OUTPUT_INVALID,
      safeDetail(error, "reply output is not valid conversation text"),
    );
  }
  return {
    byteLength: Buffer.byteLength(text, "utf8"),
    rawByteLength: rawBytes,
    redacted,
    text,
  };
}

function resolveOutputBytes(records) {
  return records.reduce((total, record) => {
    if (record.event.eventType !== "run.usage.recorded") return total;
    const outputBytes = record.event.data.outputBytes;
    return total + (Number.isSafeInteger(outputBytes) ? outputBytes : 0);
  }, 0);
}

function usageOutputBytes(run) {
  if (run.state?.totalUsage?.outputBytes !== undefined) {
    return run.state.totalUsage.outputBytes;
  }
  return resolveOutputBytes(run.records ?? []);
}

function deriveThreadRoot(data) {
  const root = data.rootMessageId ?? data.messageId;
  if (typeof root !== "string" || !MESSAGE_ID_PATTERN.test(root)) {
    throw refusal(
      AGENT_REPLY_ERROR_CODES.ROOT_INVALID,
      "source message has no bounded thread root",
    );
  }
  return root;
}

function agentPrincipalIdFor(agentId) {
  validateAgentConfigAgentId(agentId);
  const principalId = `pr_${agentId.slice(3)}`;
  validatePrincipalId(principalId);
  return principalId;
}

function assertSourceTargetsAgent(source, agentPrincipalId) {
  if (
    !source.event.data.mentions.some(
      (mention) =>
        mention.kind === "agent" && mention.principalId === agentPrincipalId,
    )
  ) {
    throw refusal(
      AGENT_REPLY_ERROR_CODES.SOURCE_INVALID,
      "source mention does not target the leased agent",
    );
  }
}

function normalizeRecord(value, label, expectedWorkspaceId) {
  const record = value?.event ? value : { event: value };
  try {
    validateEventEnvelope(record.event);
  } catch (error) {
    throw refusal(
      AGENT_REPLY_ERROR_CODES.SOURCE_INVALID,
      safeDetail(error, `${label} event is invalid`),
    );
  }
  if (record.event.workspaceId !== expectedWorkspaceId) {
    throw refusal(
      AGENT_REPLY_ERROR_CODES.SCOPE_MISMATCH,
      `${label} event has no workspace scope`,
    );
  }
  return record;
}

function assertAcceptedReply(result, provenance, actorId) {
  const event = result?.event;
  if (!event) {
    throw refusal(
      AGENT_REPLY_ERROR_CODES.DISPATCH_REFUSED,
      "message dispatch returned no accepted event",
    );
  }
  if (event.actorId !== actorId) {
    throw refusal(
      AGENT_REPLY_ERROR_CODES.ACTOR_MISMATCH,
      "message dispatch returned a different actor",
    );
  }
  const returned = event.data?.agentReplyProvenance;
  if (!returned || canonicalSha256(returned) !== canonicalSha256(provenance)) {
    throw refusal(
      AGENT_REPLY_ERROR_CODES.SCOPE_MISMATCH,
      "message dispatch returned different reply provenance",
    );
  }
}

function sourceReferenceForRecord(record, fallbackStream) {
  const stream = record.stream ?? fallbackStream;
  const offset = record.offset;
  const digest = record.digest ?? digestEventEnvelope(record.event);
  if (
    typeof stream !== "string" ||
    typeof offset !== "string" ||
    !DIGEST_PATTERN.test(digest)
  ) {
    throw refusal(
      AGENT_REPLY_ERROR_CODES.SOURCE_INVALID,
      "durable source record has no canonical reference",
    );
  }
  return { digest, offset, stream };
}

function sameReference(left, right) {
  return (
    left?.digest === right?.digest &&
    left?.offset === right?.offset &&
    left?.stream === right?.stream
  );
}

function withRefusalContext(error, context) {
  if (error instanceof AgentReplyError) {
    error.refusalContext = {
      ...context,
      ...(error.refusalContext ?? {}),
    };
    return error;
  }
  if (error?.ambiguousAck === true || error?.code === "DISPATCH_ACK_UNKNOWN") {
    return new AgentReplyError(
      AGENT_REPLY_ERROR_CODES.ACK_UNKNOWN,
      "reply append acknowledgement was not confirmed; retry with the same request",
      { refusalContext: context },
    );
  }
  return new AgentReplyError(
    AGENT_REPLY_ERROR_CODES.DISPATCH_REFUSED,
    "normal message dispatch refused the reply",
    { refusalContext: context, recordRefusal: true },
  );
}

function normalizeRefusal(error, context) {
  if (error instanceof AgentReplyError) return error;
  const code = String(error?.code ?? "");
  if (code === "DISPATCH_ACK_UNKNOWN" || error?.ambiguousAck === true) {
    return new AgentReplyError(
      AGENT_REPLY_ERROR_CODES.ACK_UNKNOWN,
      "reply append acknowledgement was not confirmed; retry with the same request",
      { refusalContext: context },
    );
  }
  const leaseFailure =
    code.startsWith("RUN_QUEUE_") ||
    code.includes("CAPABILITY") ||
    code.includes("LEASE");
  return new AgentReplyError(
    leaseFailure
      ? AGENT_REPLY_ERROR_CODES.LEASE_INVALID
      : AGENT_REPLY_ERROR_CODES.DISPATCH_REFUSED,
    leaseFailure
      ? "the run capability is no longer valid for this reply"
      : "reply dispatch was refused",
    {
      refusalContext: context,
      recordRefusal: true,
      runId: context.runId,
    },
  );
}

function refusal(code, detail) {
  return new AgentReplyError(code, detail, { recordRefusal: true });
}

function safeDetail(error, fallback) {
  const detail = error?.detail ?? error?.message ?? fallback;
  return String(detail)
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu,
      "[redacted]",
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/giu, "[redacted]")
    .slice(0, 240);
}
