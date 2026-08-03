import { validatePrincipalId, validateWorkspaceId } from "./principals.mjs";
import { sha256Digest } from "./sha256.mjs";

export const CHANNEL_SCHEMA_VERSION = 1;

export const CHANNEL_KINDS = Object.freeze(["public", "private", "direct"]);

export const CHANNEL_STATUSES = Object.freeze(["active", "archived"]);

export const CHANNEL_MEMBERSHIP_STATUSES = Object.freeze([
  "active",
  "left",
  "removed",
]);

export const CHANNEL_CAPABILITIES = Object.freeze([
  "channel.discover",
  "channel.read",
  "channel.message.write",
  "channel.subscribe",
  "channel.manage",
  "channel.membership.invite",
  "channel.membership.remove",
  "channel.membership.join",
  "channel.membership.leave",
]);

export const CHANNEL_EVENT_TYPES_V1 = Object.freeze([
  "channel.created",
  "channel.renamed",
  "channel.archived",
  "channel.unarchived",
  "channel.membership.invited",
  "channel.membership.joined",
  "channel.membership.left",
  "channel.membership.removed",
  "channel.direct.created",
]);

export const CHANNEL_ERROR_CODES = Object.freeze({
  ARCHIVED: "CHANNEL_ARCHIVED",
  DIRECT_DUPLICATE: "CHANNEL_DIRECT_DUPLICATE",
  DIRECT_PARTICIPANTS: "CHANNEL_DIRECT_PARTICIPANTS",
  INVALID_DISPLAY_NAME: "CHANNEL_INVALID_DISPLAY_NAME",
  INVALID_ID: "CHANNEL_INVALID_ID",
  INVALID_KIND: "CHANNEL_INVALID_KIND",
  INVALID_MEMBERSHIP_STATUS: "CHANNEL_INVALID_MEMBERSHIP_STATUS",
  INVALID_STATUS: "CHANNEL_INVALID_STATUS",
  MEMBERSHIP_DUPLICATE: "CHANNEL_MEMBERSHIP_DUPLICATE",
  MEMBERSHIP_INACTIVE: "CHANNEL_MEMBERSHIP_INACTIVE",
  MEMBERSHIP_NOT_FOUND: "CHANNEL_MEMBERSHIP_NOT_FOUND",
  NOT_FOUND: "CHANNEL_NOT_FOUND",
  PARTICIPANT_SERVICE: "CHANNEL_PARTICIPANT_SERVICE",
  REVISION_CONFLICT: "CHANNEL_REVISION_CONFLICT",
  SCOPE_MISMATCH: "CHANNEL_SCOPE_MISMATCH",
});

const CHANNEL_ID_PATTERN =
  /^ch_([0-9a-hjkmnp-tv-z]{26})_([0-9a-hjkmnp-tv-z]{26})$/u;
const CHANNEL_TOKEN_PATTERN = /^[0-9a-hjkmnp-tv-z]{26}$/u;
const DIRECT_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export class ChannelValidationError extends Error {
  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      name: this.name,
      path: this.path,
    };
  }
}

export function channelError(code, path, detail) {
  const error = new ChannelValidationError(`${code} at ${path}: ${detail}`);
  error.name = "ChannelValidationError";
  error.code = code;
  error.path = path;
  error.detail = detail;
  return error;
}

export function validateChannelId(
  value,
  { expectedWorkspaceId, path = "$.channelId" } = {},
) {
  const match =
    typeof value === "string" ? value.match(CHANNEL_ID_PATTERN) : null;
  if (!match) {
    throw channelError(
      CHANNEL_ERROR_CODES.INVALID_ID,
      path,
      "channel id must be a workspace-scoped identifier",
    );
  }
  if (expectedWorkspaceId !== undefined) {
    validateWorkspaceId(expectedWorkspaceId);
    if (`ws_${match[1]}` !== expectedWorkspaceId) {
      throw channelError(
        CHANNEL_ERROR_CODES.SCOPE_MISMATCH,
        path,
        "channel id belongs to a different workspace",
      );
    }
  }
  return value;
}

export function channelIdFor(workspaceId, token) {
  validateWorkspaceId(workspaceId);
  if (typeof token !== "string" || !CHANNEL_TOKEN_PATTERN.test(token)) {
    throw channelError(
      CHANNEL_ERROR_CODES.INVALID_ID,
      "$.token",
      "channel token must be a lowercase 26-character identifier",
    );
  }
  return `ch_${workspaceId.slice(3)}_${token}`;
}

export function validateChannelKind(value, path = "$.kind") {
  if (typeof value !== "string" || !CHANNEL_KINDS.includes(value)) {
    throw channelError(
      CHANNEL_ERROR_CODES.INVALID_KIND,
      path,
      "channel kind must be public, private, or direct",
    );
  }
  return value;
}

export function validateChannelStatus(value, path = "$.status") {
  if (typeof value !== "string" || !CHANNEL_STATUSES.includes(value)) {
    throw channelError(
      CHANNEL_ERROR_CODES.INVALID_STATUS,
      path,
      "channel status must be active or archived",
    );
  }
  return value;
}

export function validateChannelMembershipStatus(value, path = "$.status") {
  if (
    typeof value !== "string" ||
    !CHANNEL_MEMBERSHIP_STATUSES.includes(value)
  ) {
    throw channelError(
      CHANNEL_ERROR_CODES.INVALID_MEMBERSHIP_STATUS,
      path,
      "channel membership status is not registered",
    );
  }
  return value;
}

export function normalizeChannelDisplayName(value) {
  const displayName = String(value ?? "").trim();
  if (
    displayName.length === 0 ||
    displayName.length > 80 ||
    hasControlCharacter(displayName)
  ) {
    throw channelError(
      CHANNEL_ERROR_CODES.INVALID_DISPLAY_NAME,
      "$.displayName",
      "display name must be 1-80 characters without control characters",
    );
  }
  return displayName;
}

function hasControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

export function canonicalParticipantIds(
  participantIds,
  { expectedWorkspaceId, path = "$.participantIds" } = {},
) {
  if (!Array.isArray(participantIds) || participantIds.length < 2) {
    throw channelError(
      CHANNEL_ERROR_CODES.DIRECT_PARTICIPANTS,
      path,
      "a direct channel requires at least two participants",
    );
  }
  const canonical = [...participantIds].sort();
  for (let index = 0; index < canonical.length; index += 1) {
    validatePrincipalId(canonical.at(index), {
      expectedWorkspaceId,
      path: `${path}[${index}]`,
    });
    if (index > 0 && canonical.at(index) === canonical.at(index - 1)) {
      throw channelError(
        CHANNEL_ERROR_CODES.DIRECT_PARTICIPANTS,
        path,
        "direct channel participants must be unique",
      );
    }
  }
  return canonical;
}

export function participantSetKey(participantIds, options) {
  return canonicalParticipantIds(participantIds, options).join("\u0000");
}

export function directChannelIdFor(workspaceId, participantIds) {
  validateWorkspaceId(workspaceId);
  const canonical = canonicalParticipantIds(participantIds, {
    expectedWorkspaceId: workspaceId,
  });
  const key = canonical.join("\u0000");
  return channelIdFor(workspaceId, digestToken(key));
}

export function channelMembershipKey(channelId, principalId) {
  validateChannelId(channelId);
  validatePrincipalId(principalId, {
    expectedWorkspaceId: `ws_${channelId.slice(3, 29)}`,
  });
  return `${channelId}\u0000${principalId}`;
}

function digestToken(value) {
  const digest = sha256Digest(value);
  let output = "";
  for (let index = 0; index < 26; index += 1) {
    const bitOffset = index * 5;
    const byteOffset = bitOffset >> 3;
    const shift = bitOffset % 8;
    const bitWindow =
      (digest.at(byteOffset) << 16) |
      (digest.at(byteOffset + 1) << 8) |
      digest.at(byteOffset + 2);
    output += DIRECT_ID_ALPHABET.at((bitWindow >>> (19 - shift)) & 31);
  }
  return output;
}
