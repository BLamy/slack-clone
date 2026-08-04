import {
  bindMentionSources,
  MENTION_POLICY,
  MENTION_PRINCIPAL_KINDS,
  MENTION_REFUSAL_CODES,
  parseMentionCandidates,
  validateChannelId,
  validateConversationText,
  validatePrincipalId,
  validateWorkspaceId,
  membershipIdFor,
  channelMembershipKey,
} from "@stream-slack/protocol";
import { canonicalStateDigest } from "@stream-slack/reducers";

export const MENTION_RESOLUTION_MODES = Object.freeze(["plain-text", "refuse"]);

export class MentionResolutionError extends Error {
  constructor(code, detail, { statusCode = 422, span = null } = {}) {
    super(`${code}: ${detail}`);
    this.name = "MentionResolutionError";
    this.code = code;
    this.detail = detail;
    this.statusCode = statusCode;
    this.span = span;
  }

  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      span: this.span,
      statusCode: this.statusCode,
    };
  }
}

/**
 * Resolve parser candidates against the replayed workspace state. A refusal
 * never contains the matching principal ID or profile, so a failed lookup
 * cannot become a directory oracle. The default policy preserves unresolved
 * text as ordinary message text and records typed refusal metadata for the
 * caller's audit path.
 */
export function resolveConversationMentions({
  channelId,
  mode = MENTION_POLICY.unresolved,
  state,
  text,
  workspaceId,
}) {
  validateWorkspaceId(workspaceId);
  validateChannelId(channelId, { expectedWorkspaceId: workspaceId });
  validateConversationText(text, "$.text");
  if (!MENTION_RESOLUTION_MODES.includes(mode)) {
    throw new MentionResolutionError(
      MENTION_REFUSAL_CODES.INVALID_FACT,
      "mention resolution mode is not registered",
      { statusCode: 400 },
    );
  }
  if (!state || typeof state !== "object") {
    throw new MentionResolutionError(
      MENTION_REFUSAL_CODES.INVALID_FACT,
      "mention resolution requires replayed workspace state",
      { statusCode: 500 },
    );
  }

  const candidates = parseMentionCandidates(text);
  const mentions = [];
  const refusals = [];
  for (const candidate of candidates) {
    const refusalCode = resolveRefusalCode({
      candidate,
      channelId,
      state,
      workspaceId,
    });
    if (refusalCode) {
      const refusal = Object.freeze({
        code: refusalCode,
        span: candidate.span,
        status: "plain-text",
      });
      if (mode === "refuse") {
        throw new MentionResolutionError(
          refusalCode,
          refusalDetail(refusalCode),
          { span: candidate.span },
        );
      }
      refusals.push(refusal);
      continue;
    }

    const principal = findPrincipal(state, workspaceId, candidate.handle);
    mentions.push(
      Object.freeze({
        handle: candidate.handle,
        kind: principal.kind,
        principalId: principal.principalId,
        span: candidate.span,
        text: candidate.text,
      }),
    );
  }

  return Object.freeze({
    candidates,
    mentions: Object.freeze(mentions),
    policy: MENTION_POLICY,
    refusals: Object.freeze(refusals),
  });
}

export function resolveConversationMentionsStrict(input) {
  return resolveConversationMentions({ ...input, mode: "refuse" });
}

/**
 * Add the accepted Durable Streams source reference to the result handed to
 * the next dispatcher. The event already contains canonical target IDs and
 * spans; this binds the immutable source evidence only after append assigns
 * the accepted checkpoint.
 */
export function bindAcceptedMentionSource(result, { channelId, text } = {}) {
  if (!result || typeof result !== "object") return result;
  const event = result.event;
  const mentions = event?.mentions;
  if (!Array.isArray(mentions) || mentions.length === 0) return result;
  const receipt = result.receipt;
  if (!receipt || typeof receipt !== "object") {
    throw new MentionResolutionError(
      MENTION_REFUSAL_CODES.INVALID_FACT,
      "accepted mention source requires a dispatch receipt",
      { statusCode: 500 },
    );
  }
  const resolvedChannelId = channelId ?? event.channelId;
  validateChannelId(resolvedChannelId, {
    expectedWorkspaceId: receipt.workspaceId,
  });
  const source = {
    digest: canonicalStateDigest(withoutDispatch(event)),
    offset: receipt.nextOffset,
    stream: `channel:${resolvedChannelId}`,
  };
  const bound = bindMentionSources(mentions, source, {
    expectedWorkspaceId: receipt.workspaceId,
    text,
  });
  return Object.freeze({
    ...result,
    event: Object.freeze({ ...event, mentions: Object.freeze(bound) }),
  });
}

function withoutDispatch(event) {
  if (!event || typeof event !== "object") return event;
  const sourceEvent = { ...event };
  delete sourceEvent.dispatch;
  return sourceEvent;
}

function resolveRefusalCode({ candidate, channelId, state, workspaceId }) {
  const matches = principalMatches(state, workspaceId, candidate.handle);
  if (matches.length === 0) return MENTION_REFUSAL_CODES.TARGET_UNKNOWN;
  if (matches.length !== 1) return MENTION_REFUSAL_CODES.AMBIGUOUS_TARGET;
  const principal = matches[0];
  if (!MENTION_PRINCIPAL_KINDS.includes(principal.kind)) {
    return MENTION_REFUSAL_CODES.TARGET_SERVICE;
  }
  if (principal.status !== "active") {
    return MENTION_REFUSAL_CODES.TARGET_DISABLED;
  }
  if (
    !hasActiveMembership(state, workspaceId, channelId, principal.principalId)
  ) {
    return MENTION_REFUSAL_CODES.TARGET_NOT_MEMBER;
  }
  return null;
}

function findPrincipal(state, workspaceId, handle) {
  return principalMatches(state, workspaceId, handle)[0];
}

function principalMatches(state, workspaceId, handle) {
  return Object.values(state.entities?.principals ?? {}).filter((principal) => {
    try {
      validatePrincipalId(principal?.principalId, {
        expectedWorkspaceId: workspaceId,
      });
    } catch {
      return false;
    }
    return principal?.profile?.handle === handle;
  });
}

function hasActiveMembership(state, workspaceId, channelId, principalId) {
  const workspaceMembership =
    state.entities?.memberships?.[membershipIdFor(workspaceId, principalId)];
  const channelMembership =
    state.entities?.channelMemberships?.[
      channelMembershipKey(channelId, principalId)
    ];
  return (
    workspaceMembership?.status === "active" &&
    channelMembership?.status === "active"
  );
}

function refusalDetail(code) {
  switch (code) {
    case MENTION_REFUSAL_CODES.AMBIGUOUS_TARGET:
      return "mention target is ambiguous";
    case MENTION_REFUSAL_CODES.TARGET_DISABLED:
      return "mention target is not active";
    case MENTION_REFUSAL_CODES.TARGET_NOT_MEMBER:
      return "mention target is not a channel member";
    case MENTION_REFUSAL_CODES.TARGET_SERVICE:
      return "service principals cannot be mentioned as conversation targets";
    default:
      return "mention target was not resolved";
  }
}
