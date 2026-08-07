import {
  deriveInvocationCorrelationId,
  deriveMentionInvocationId,
  deriveMentionInvocationIdempotencyKey,
  policyDigest,
  validateMentionFacts,
  validatePrincipalId,
  validateWorkspaceId,
  validateInvocationRequestedData,
} from "@stream-slack/protocol";

import { canonicalSha256 } from "./canonical-json.mjs";
import {
  digestEventEnvelope,
  issueEventEnvelope,
  validateEventEnvelope,
} from "./envelope.mjs";
import { assertIdentifier } from "./identifiers.mjs";
import { DISPATCH_REFUSAL_CODES, DispatchRefusalError } from "./dispatch.mjs";
import { streamNames } from "./topology.mjs";

const OFFSET_PATTERN = /^\d{16}_[0-9a-f]{16}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const RECONCILED_EVENT_TYPES = Object.freeze([
  "channel.message.created",
  "channel.message.replied",
]);
const CHECKPOINT_EVENT_TYPE = "projection.checkpointed";
const INVOCATION_EVENT_TYPE = "workspace.invocation.requested";
const AUDIT_EVENT_TYPE = "workspace.audit.recorded";
const DEFAULT_MAX_RETRIES = 8;

export const MENTION_RECONCILER_ERROR_CODES = Object.freeze({
  CHECKPOINT_CORRUPT: "MENTION_RECONCILER_CHECKPOINT_CORRUPT",
  CHECKPOINT_SCOPE: "MENTION_RECONCILER_CHECKPOINT_SCOPE",
  CONFIG_INVALID: "MENTION_RECONCILER_CONFIG_INVALID",
  INVOCATION_BINDING: "MENTION_RECONCILER_INVOCATION_BINDING",
  PROVIDER_UNAVAILABLE: "MENTION_RECONCILER_PROVIDER_UNAVAILABLE",
  SNAPSHOT_REFUSED: "MENTION_RECONCILER_SNAPSHOT_REFUSED",
  SOURCE_INVALID: "MENTION_RECONCILER_SOURCE_INVALID",
  SOURCE_SCOPE: "MENTION_RECONCILER_SOURCE_SCOPE",
  TARGET_DISABLED: "MENTION_RECONCILER_TARGET_DISABLED",
  TARGET_KIND: "MENTION_RECONCILER_TARGET_KIND",
  TARGET_NOT_AGENT: "MENTION_RECONCILER_TARGET_NOT_AGENT",
  TARGET_NOT_MEMBER: "MENTION_RECONCILER_TARGET_NOT_MEMBER",
  TARGET_REMOVED: "MENTION_RECONCILER_TARGET_REMOVED",
});

export class MentionReconcilerError extends Error {
  constructor(code, detail, { source = null } = {}) {
    super(`${code}: ${detail}`);
    this.name = "MentionReconcilerError";
    this.code = code;
    this.detail = detail;
    this.source = source;
  }

  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      name: this.name,
      source: this.source,
    };
  }
}

/**
 * Build the source-bound cross-stream saga for canonical channel mentions.
 *
 * `resolveTarget` is the narrow E2 boundary. It must return either
 * `{ status: "eligible", snapshot }` or `{ status: "non-runnable", code }`.
 * The callback owns the directory/config/provider reads and therefore can
 * fence them with the exact source heads it used. The reconciler intentionally
 * persists only snapshot references, digests, policy, and typed refusal codes;
 * it never copies resolved configuration or provider values into an outcome.
 */
export function createMentionReconciler({
  actorId,
  channelId,
  clock = () => new Date(),
  dispatch,
  maxRetries = DEFAULT_MAX_RETRIES,
  onBoundary = async () => {},
  projectionId = null,
  resolveSnapshot = null,
  resolveTarget = null,
  streamStore,
  workspaceId,
}) {
  validateWorkspaceId(workspaceId);
  validatePrincipalId(actorId, { expectedWorkspaceId: workspaceId });
  assertIdentifier("channel", channelId, {
    expectedWorkspaceId: workspaceId,
    path: "$.channelId",
  });
  if (!streamStore || typeof streamStore.read !== "function") {
    throw new TypeError("mention reconciler requires a stream store with read");
  }
  const dispatchFunction =
    typeof dispatch === "function" ? dispatch : dispatch?.dispatch;
  const recoverFunction =
    typeof dispatch === "object" && dispatch !== null ? dispatch.recover : null;
  if (typeof dispatchFunction !== "function") {
    throw new TypeError("mention reconciler requires fenced dispatch");
  }
  if (typeof clock !== "function" || typeof onBoundary !== "function") {
    throw new TypeError(
      "mention reconciler clock and boundary hook must be functions",
    );
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 1 || maxRetries > 32) {
    throw new TypeError(
      "mention reconciler maxRetries must be between 1 and 32",
    );
  }
  if (resolveTarget !== null && typeof resolveTarget !== "function") {
    throw new TypeError("mention reconciler resolveTarget must be a function");
  }
  if (resolveSnapshot !== null && typeof resolveSnapshot !== "function") {
    throw new TypeError(
      "mention reconciler resolveSnapshot must be a function",
    );
  }
  if (!resolveTarget && !resolveSnapshot) {
    throw new TypeError(
      "mention reconciler requires resolveTarget or resolveSnapshot",
    );
  }

  const sourceStream = streamNames.channel(workspaceId, channelId);
  const invocationStream = streamNames.workspaceInvocations(workspaceId);
  const auditStream = streamNames.workspaceAudit(workspaceId);
  const resolvedProjectionId =
    projectionId ?? `px_${workspaceId.slice(3)}_${channelId.slice(-26)}`;
  assertIdentifier("projection", resolvedProjectionId, {
    expectedWorkspaceId: workspaceId,
    path: "$.projectionId",
  });
  const checkpointStream = streamNames.projection(
    workspaceId,
    resolvedProjectionId,
  );

  async function ensureStreams() {
    if (typeof streamStore.ensure !== "function") return;
    await Promise.all(
      [checkpointStream, invocationStream, auditStream].map((stream) =>
        streamStore.ensure(stream),
      ),
    );
  }

  async function readStream(stream, signal) {
    const snapshot = await streamStore.read(stream, "-1", { signal });
    if (!snapshot || !Array.isArray(snapshot.records)) {
      throw new MentionReconcilerError(
        MENTION_RECONCILER_ERROR_CODES.SOURCE_INVALID,
        `stream store returned no records array for ${stream}`,
      );
    }
    if (typeof snapshot.nextOffset !== "string") {
      throw new MentionReconcilerError(
        MENTION_RECONCILER_ERROR_CODES.SOURCE_INVALID,
        `stream store returned no next offset for ${stream}`,
      );
    }
    return snapshot;
  }

  async function readCheckpoint(signal) {
    const snapshot = await readStream(checkpointStream, signal);
    let previous = null;
    for (const [index, record] of snapshot.records.entries()) {
      const event = extractEnvelope(record);
      try {
        validateEventEnvelope(event);
      } catch {
        throw new MentionReconcilerError(
          MENTION_RECONCILER_ERROR_CODES.CHECKPOINT_CORRUPT,
          `checkpoint record ${index} is not a valid event envelope`,
        );
      }
      if (
        event.workspaceId !== workspaceId ||
        event.eventType !== CHECKPOINT_EVENT_TYPE
      ) {
        throw new MentionReconcilerError(
          MENTION_RECONCILER_ERROR_CODES.CHECKPOINT_SCOPE,
          "checkpoint stream contains an event from another projection or workspace",
        );
      }
      const data = event.data;
      if (
        data?.projectionId !== resolvedProjectionId ||
        data?.sourceStream !== sourceStream
      ) {
        throw new MentionReconcilerError(
          MENTION_RECONCILER_ERROR_CODES.CHECKPOINT_SCOPE,
          "checkpoint is wired to a sibling projection or channel",
        );
      }
      if (
        !Number.isSafeInteger(data?.sequence) ||
        data.sequence < 1 ||
        typeof data.sourceOffset !== "string" ||
        !OFFSET_PATTERN.test(data.sourceOffset) ||
        typeof data.stateDigest !== "string" ||
        !DIGEST_PATTERN.test(data.stateDigest)
      ) {
        throw new MentionReconcilerError(
          MENTION_RECONCILER_ERROR_CODES.CHECKPOINT_CORRUPT,
          "checkpoint is not bound to this channel source",
        );
      }
      if (previous && data.sequence <= previous.sequence) {
        throw new MentionReconcilerError(
          MENTION_RECONCILER_ERROR_CODES.CHECKPOINT_CORRUPT,
          "checkpoint sequence regressed or was duplicated",
        );
      }
      previous = Object.freeze({
        eventId: event.eventId,
        sequence: data.sequence,
        sourceOffset: data.sourceOffset,
        sourceStream: data.sourceStream,
        stateDigest: data.stateDigest,
      });
    }
    return previous;
  }

  async function readNextSource(checkpoint, signal) {
    const snapshot = await readStream(sourceStream, signal);
    const records = snapshot.records.map((record, index) =>
      normalizeSourceRecord(record, {
        index,
        sourceStream,
        workspaceId,
      }),
    );
    let nextIndex = 0;
    if (checkpoint) {
      const checkpointIndex = records.findIndex(
        (record) => record.offset === checkpoint.sourceOffset,
      );
      if (checkpointIndex < 0 || checkpointIndex + 1 !== checkpoint.sequence) {
        throw new MentionReconcilerError(
          MENTION_RECONCILER_ERROR_CODES.CHECKPOINT_CORRUPT,
          "checkpoint offset does not identify the claimed source sequence",
          { source: checkpoint },
        );
      }
      nextIndex = checkpointIndex + 1;
    }
    return Object.freeze({
      next: records[nextIndex] ?? null,
      records,
      sourceHead: snapshot.nextOffset,
      sourceIndex: nextIndex,
    });
  }

  async function resolveMentionTarget({
    agentId,
    mention,
    signal,
    sourceEvent,
    sourceTrigger,
  }) {
    try {
      const result = resolveTarget
        ? await resolveTarget({
            agentId,
            channelId,
            mention,
            signal,
            sourceEvent,
            sourceTrigger,
            workspaceId,
          })
        : {
            status: "eligible",
            snapshot: await resolveSnapshot({
              agentId,
              channelId,
              mention,
              signal,
              sourceEvent,
              sourceTrigger,
              workspaceId,
            }),
          };
      if (
        !result ||
        result.status === "non-runnable" ||
        result.eligible === false ||
        result.status === "retry"
      ) {
        return {
          status: "non-runnable",
          code: normalizeOutcomeCode(
            result?.code ?? MENTION_RECONCILER_ERROR_CODES.SNAPSHOT_REFUSED,
          ),
        };
      }
      const snapshot = result.snapshot ?? result;
      if (!snapshot || typeof snapshot !== "object") {
        return {
          status: "non-runnable",
          code: MENTION_RECONCILER_ERROR_CODES.CONFIG_INVALID,
        };
      }
      return { snapshot, status: "eligible" };
    } catch (error) {
      return {
        status: "non-runnable",
        code: normalizeOutcomeCode(error?.code),
      };
    }
  }

  async function reconcileSourceRecord(record, { signal }) {
    const sourceTrigger = {
      digest: record.digest,
      offset: record.offset,
      stream: sourceStream,
    };
    const { event } = record;
    if (!RECONCILED_EVENT_TYPES.includes(event.eventType)) {
      return {
        effects: [],
        result: {
          source: sourceTrigger,
          status: "ignored",
          triggerType: event.eventType,
        },
      };
    }
    const rawMentions = event.data.mentions ?? [];
    let mentions;
    try {
      mentions = validateMentionFacts(rawMentions, event.data.text, {
        allowSource: rawMentions.some((mention) =>
          Object.hasOwn(mention ?? {}, "source"),
        ),
        expectedWorkspaceId: workspaceId,
      });
    } catch {
      throw new MentionReconcilerError(
        MENTION_RECONCILER_ERROR_CODES.SOURCE_INVALID,
        "channel mention facts failed canonical validation",
        { source: sourceTrigger },
      );
    }

    const effects = [];
    const targets = [];
    for (const mention of mentions) {
      if (mention.kind !== "agent") {
        const outcome = {
          agentId: null,
          code: MENTION_RECONCILER_ERROR_CODES.TARGET_NOT_AGENT,
          principalId: mention.principalId,
          status: "non-runnable",
        };
        effects.push(
          await appendOutcome({
            mention,
            outcome,
            signal,
            sourceEvent: event,
            sourceTrigger,
          }),
        );
        targets.push(outcome);
        continue;
      }

      const agentId = `ag_${mention.principalId.slice(3)}`;
      assertIdentifier("agent", agentId, {
        expectedWorkspaceId: workspaceId,
        path: "$.mentions[].agentId",
      });
      const target = await resolveMentionTarget({
        agentId,
        mention,
        signal,
        sourceEvent: event,
        sourceTrigger,
      });
      if (target.status !== "eligible") {
        const outcome = {
          agentId,
          code: target.code,
          principalId: mention.principalId,
          status: "non-runnable",
        };
        effects.push(
          await appendOutcome({
            mention,
            outcome,
            signal,
            sourceEvent: event,
            sourceTrigger,
          }),
        );
        targets.push(outcome);
        continue;
      }

      await onBoundary("snapshot-resolved", {
        agentId,
        snapshotDigest: target.snapshot.snapshotDigest ?? null,
        source: sourceTrigger,
      });
      const invocation = createInvocationEnvelope({
        actorId,
        agentId,
        clock,
        snapshot: target.snapshot,
        sourceEvent: event,
        sourceTrigger,
        workspaceId,
      });
      const appended = await appendEffect({
        event: invocation.event,
        eventDigest: invocation.eventDigest,
        idempotencyKey: invocation.idempotencyKey,
        operation: INVOCATION_EVENT_TYPE,
        signal,
        stream: invocationStream,
      });
      await onBoundary("invocation-appended", {
        agentId,
        invocationId: invocation.invocationId,
        receipt: safeReceipt(appended.receipt),
        snapshotDigest: invocation.snapshotDigest,
        source: sourceTrigger,
      });
      const result = {
        agentId,
        invocationId: invocation.invocationId,
        receipt: safeReceipt(appended.receipt),
        snapshotDigest: invocation.snapshotDigest,
        snapshotRef: invocation.snapshotRef,
        status: "invoked",
      };
      targets.push(result);
      effects.push({
        kind: "invocation",
        ...result,
      });
    }

    return {
      effects,
      result: {
        source: sourceTrigger,
        status: "reconciled",
        targets,
        triggerType: event.eventType,
      },
    };
  }

  async function appendOutcome({
    mention,
    outcome,
    signal,
    sourceEvent,
    sourceTrigger,
  }) {
    const idempotencyKey = deriveEffectId("ik", {
      kind: "non-runnable",
      outcome,
      sourceTrigger,
      workspaceId,
    });
    const event = issueEventEnvelope(
      {
        actorId,
        causation: sourceTrigger,
        correlationId: deriveEffectId("cr", {
          kind: "non-runnable",
          outcome,
          sourceTrigger,
          workspaceId,
        }),
        data: {
          action: "mention.reconciliation.non-runnable",
          auditId: deriveEffectId("au", {
            kind: "non-runnable",
            outcome,
            sourceTrigger,
            workspaceId,
          }),
          detail: {
            code: outcome.code,
            source: sourceTrigger,
            status: "non-runnable",
          },
          subjectId: mention.principalId,
        },
        eventType: AUDIT_EVENT_TYPE,
        idempotencyKey,
        schemaVersion: 1,
        workspaceId,
      },
      {
        clock: () => new Date(sourceEvent.serverTimestamp),
        eventId: deriveEffectId("ev", {
          kind: "non-runnable",
          outcome,
          sourceTrigger,
          workspaceId,
        }),
      },
    );
    const appended = await appendEffect({
      event,
      eventDigest: digestEventEnvelope(event),
      idempotencyKey,
      operation: AUDIT_EVENT_TYPE,
      signal,
      stream: auditStream,
    });
    return {
      kind: "non-runnable",
      code: outcome.code,
      principalId: mention.principalId,
      receipt: safeReceipt(appended.receipt),
      status: "non-runnable",
    };
  }

  async function appendEffect({
    event,
    eventDigest,
    idempotencyKey,
    operation,
    signal,
    stream,
  }) {
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      const target = await readStream(stream, signal);
      const request = {
        actorId,
        expectedHead: target.nextOffset,
        idempotencyKey,
        operation,
        payload: { digest: eventDigest, event },
        stream,
        workspaceId,
      };
      try {
        const result = await dispatchFunction(request, { signal });
        return assertEffectResult(result, event, eventDigest);
      } catch (error) {
        if (!isStaleFence(error)) throw error;
        if (typeof recoverFunction === "function") {
          const recovered = await recoverFunction(request, { signal });
          if (recovered)
            return assertEffectResult(recovered, event, eventDigest);
        }
      }
    }
    throw new MentionReconcilerError(
      MENTION_RECONCILER_ERROR_CODES.INVOCATION_BINDING,
      "fenced effect did not converge before the retry limit",
    );
  }

  async function appendCheckpoint({ record, result, signal }) {
    const sequence = record.index;
    const stateDigest = canonicalSha256({
      effects: result.effects,
      source: {
        digest: record.digest,
        offset: record.offset,
        stream: sourceStream,
      },
      targets: result.result.targets ?? [],
    });
    const sourceTrigger = {
      digest: record.digest,
      offset: record.offset,
      stream: sourceStream,
    };
    const idempotencyKey = deriveEffectId("ik", {
      kind: "checkpoint",
      projectionId: resolvedProjectionId,
      sequence,
      sourceTrigger,
      stateDigest,
      workspaceId,
    });
    const event = issueEventEnvelope(
      {
        actorId,
        causation: sourceTrigger,
        correlationId: deriveEffectId("cr", {
          kind: "checkpoint",
          projectionId: resolvedProjectionId,
          sequence,
          sourceTrigger,
          workspaceId,
        }),
        data: {
          projectionId: resolvedProjectionId,
          sequence,
          sourceOffset: record.offset,
          sourceStream,
          stateDigest,
        },
        eventType: CHECKPOINT_EVENT_TYPE,
        idempotencyKey,
        schemaVersion: 1,
        workspaceId,
      },
      {
        clock: () => new Date(record.event.serverTimestamp),
        eventId: deriveEffectId("ev", {
          kind: "checkpoint",
          projectionId: resolvedProjectionId,
          sequence,
          sourceTrigger,
          stateDigest,
          workspaceId,
        }),
      },
    );
    const appended = await appendEffect({
      event,
      eventDigest: digestEventEnvelope(event),
      idempotencyKey,
      operation: CHECKPOINT_EVENT_TYPE,
      signal,
      stream: checkpointStream,
    });
    const checkpoint = Object.freeze({
      eventId: event.eventId,
      sequence,
      sourceOffset: record.offset,
      sourceStream,
      stateDigest,
    });
    await onBoundary("before-checkpoint-acknowledgement", {
      checkpoint,
      receipt: safeReceipt(appended.receipt),
    });
    return checkpoint;
  }

  async function reconcile({ limit = 100, signal } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new TypeError(
        "mention reconciler limit must be between 1 and 10000",
      );
    }
    await ensureStreams();
    const processed = [];
    for (let count = 0; count < limit; count += 1) {
      const checkpoint = await readCheckpoint(signal);
      const source = await readNextSource(checkpoint, signal);
      if (!source.next) {
        return Object.freeze({
          checkpoint,
          processed,
          projectionId: resolvedProjectionId,
          sourceHead: source.sourceHead,
          sourceStream,
        });
      }
      await onBoundary("source-read", {
        offset: source.next.offset,
        source: {
          digest: source.next.digest,
          offset: source.next.offset,
          stream: sourceStream,
        },
      });
      const result = await reconcileSourceRecord(source.next, { signal });
      const nextCheckpoint = await appendCheckpoint({
        record: source.next,
        result,
        signal,
      });
      processed.push({
        checkpoint: nextCheckpoint,
        ...result.result,
      });
    }
    const checkpoint = await readCheckpoint(signal);
    const source = await readNextSource(checkpoint, signal);
    return Object.freeze({
      checkpoint,
      processed,
      projectionId: resolvedProjectionId,
      sourceHead: source.sourceHead,
      sourceStream,
    });
  }

  return Object.freeze({
    auditStream,
    checkpointStream,
    invocationStream,
    projectionId: resolvedProjectionId,
    reconcile,
    sourceStream,
  });
}

function createInvocationEnvelope({
  actorId,
  agentId,
  clock,
  snapshot,
  sourceEvent,
  sourceTrigger,
  workspaceId,
}) {
  const invocationId = deriveMentionInvocationId({
    agentId,
    sourceTrigger,
    workspaceId,
  });
  const idempotencyKey = deriveMentionInvocationIdempotencyKey({
    agentId,
    sourceTrigger,
    workspaceId,
  });
  const correlationId = deriveInvocationCorrelationId({
    agentId,
    invocationId,
    sourceTrigger,
    workspaceId,
  });
  const snapshotRef = normalizeSnapshotRef(
    snapshot.snapshotRef ?? snapshot.sourceManifest?.config,
  );
  const snapshotDigest = snapshot.snapshotDigest;
  const policy = invocationPolicy(snapshot);
  const data = {
    agentId,
    correlationId,
    invocationId,
    policy,
    policyDigest: policyDigest(policy),
    promptRef: sourceTrigger,
    schemaVersion: 1,
    snapshotDigest,
    snapshotRef,
    sourceTrigger,
    triggerType: "channel.mention",
  };
  try {
    validateInvocationRequestedData(data, {
      expectedCorrelationId: correlationId,
      expectedWorkspaceId: workspaceId,
    });
  } catch {
    throw new MentionReconcilerError(
      MENTION_RECONCILER_ERROR_CODES.CONFIG_INVALID,
      "resolved snapshot cannot be bound to an invocation",
      { source: sourceTrigger },
    );
  }
  const event = issueEventEnvelope(
    {
      actorId,
      causation: sourceTrigger,
      correlationId,
      data,
      eventType: INVOCATION_EVENT_TYPE,
      idempotencyKey,
      schemaVersion: 1,
      workspaceId,
    },
    {
      clock: () =>
        new Date(sourceEvent.serverTimestamp ?? clock().toISOString()),
      eventId: deriveEffectId("ev", {
        agentId,
        invocationId,
        sourceTrigger,
        workspaceId,
      }),
    },
  );
  return {
    correlationId,
    event,
    eventDigest: digestEventEnvelope(event),
    invocationId,
    idempotencyKey,
    snapshotDigest,
    snapshotRef,
  };
}

function invocationPolicy(snapshot) {
  const explicit = snapshot.policy ?? snapshot.invocationPolicy;
  if (explicit) return explicit;
  const budget = snapshot.config?.agentConfig?.budgets ?? snapshot.budget;
  if (!budget || typeof budget !== "object") {
    throw new MentionReconcilerError(
      MENTION_RECONCILER_ERROR_CODES.CONFIG_INVALID,
      "snapshot has no invocation policy or immutable budget",
    );
  }
  return {
    allowApprovals: false,
    maxAttempts: 3,
    maxCostUsdCents: budget.maxCostUsdCents,
    maxInputTokens: budget.maxInputTokens,
    maxOutputTokens: budget.maxOutputTokens,
    maxWallTimeMs: budget.timeoutSeconds * 1000,
    version: 1,
  };
}

function normalizeSnapshotRef(value) {
  if (!value || typeof value !== "object") return value;
  if (Object.hasOwn(value, "digest")) {
    return {
      digest: value.digest,
      offset: value.offset,
      stream: value.stream,
    };
  }
  if (Object.hasOwn(value, "stateDigest")) {
    return {
      digest: value.stateDigest,
      offset: value.offset,
      stream: value.stream,
    };
  }
  return value;
}

function normalizeSourceRecord(record, { index, sourceStream, workspaceId }) {
  const event = extractEnvelope(record);
  const offset = record?.offset;
  if (typeof offset !== "string" || !OFFSET_PATTERN.test(offset)) {
    throw new MentionReconcilerError(
      MENTION_RECONCILER_ERROR_CODES.SOURCE_INVALID,
      `source record ${index} does not expose its canonical Durable Streams offset`,
    );
  }
  try {
    validateEventEnvelope(event);
  } catch {
    throw new MentionReconcilerError(
      MENTION_RECONCILER_ERROR_CODES.SOURCE_INVALID,
      `source record ${index} is not a valid event envelope`,
    );
  }
  if (
    event.workspaceId !== workspaceId ||
    event.data?.channelId === undefined
  ) {
    throw new MentionReconcilerError(
      MENTION_RECONCILER_ERROR_CODES.SOURCE_SCOPE,
      "source event is not bound to the reconciler workspace and channel",
    );
  }
  const expectedChannelStream = streamNames.channel(
    workspaceId,
    event.data.channelId,
  );
  if (expectedChannelStream !== sourceStream) {
    throw new MentionReconcilerError(
      MENTION_RECONCILER_ERROR_CODES.SOURCE_SCOPE,
      "source event channel does not match the reconciler channel",
    );
  }
  const digest = digestEventEnvelope(event);
  if (record?.digest !== undefined && record.digest !== digest) {
    throw new MentionReconcilerError(
      MENTION_RECONCILER_ERROR_CODES.SOURCE_INVALID,
      `source record ${index} digest does not match its event envelope`,
    );
  }
  return Object.freeze({
    digest,
    event,
    index: index + 1,
    offset,
  });
}

function extractEnvelope(record) {
  return record?.event ?? record?.envelope ?? record;
}

function assertEffectResult(result, expectedEvent, expectedDigest) {
  const outer = result?.event;
  const event = extractEnvelope(outer);
  if (!event || event.eventId !== expectedEvent.eventId) {
    throw new MentionReconcilerError(
      MENTION_RECONCILER_ERROR_CODES.INVOCATION_BINDING,
      "dispatch returned an event with a different deterministic effect ID",
    );
  }
  if (digestEventEnvelope(event) !== expectedDigest) {
    throw new MentionReconcilerError(
      MENTION_RECONCILER_ERROR_CODES.INVOCATION_BINDING,
      "dispatch returned an event with a different effect digest",
    );
  }
  return {
    event,
    receipt: result?.receipt ?? null,
  };
}

function safeReceipt(receipt) {
  if (!receipt || typeof receipt !== "object") return null;
  return {
    eventDigest: receipt.eventDigest ?? null,
    idempotencyKey: receipt.idempotencyKey ?? null,
    nextOffset: receipt.nextOffset ?? null,
    status: receipt.status ?? null,
    stream: receipt.stream ?? null,
  };
}

function isStaleFence(error) {
  return (
    error instanceof DispatchRefusalError &&
    error.code === DISPATCH_REFUSAL_CODES.STALE_FENCE
  );
}

function normalizeOutcomeCode(code) {
  if (typeof code !== "string" || !/^[A-Z][A-Z0-9_:-]{2,127}$/u.test(code)) {
    return MENTION_RECONCILER_ERROR_CODES.SNAPSHOT_REFUSED;
  }
  if (code.includes("SECRET") || code.includes("TOKEN")) {
    return MENTION_RECONCILER_ERROR_CODES.SNAPSHOT_REFUSED;
  }
  return code;
}

function deriveEffectId(prefix, value) {
  return `${prefix}_${canonicalSha256(value).slice("sha256:".length, "sha256:".length + 26)}`;
}
