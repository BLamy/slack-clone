import { validatePrincipalId, validateWorkspaceId } from "./principals.mjs";
import { validateConversationText } from "./messages.mjs";

export const MENTION_SCHEMA_VERSION = 1;
export const MENTION_MAX_COUNT = 100;

export const MENTION_PRINCIPAL_KINDS = Object.freeze(["human", "agent"]);

export const MENTION_POLICY = Object.freeze({
  version: MENTION_SCHEMA_VERSION,
  prefix: "@",
  handlePattern: "^[a-z0-9][a-z0-9._-]{0,63}$",
  excludes: Object.freeze([
    "fenced-code",
    "inline-code",
    "escaped-text",
    "block-quote",
    "url",
  ]),
  principalKinds: MENTION_PRINCIPAL_KINDS,
  unresolved: "plain-text",
});

export const MENTION_REFUSAL_CODES = Object.freeze({
  AMBIGUOUS_TARGET: "MENTION_AMBIGUOUS_TARGET",
  INVALID_CHANNEL: "MENTION_INVALID_CHANNEL",
  INVALID_FACT: "MENTION_INVALID_FACT",
  INVALID_SPAN: "MENTION_INVALID_SPAN",
  INVALID_TEXT: "MENTION_INVALID_TEXT",
  KIND_MISMATCH: "MENTION_KIND_MISMATCH",
  TARGET_DISABLED: "MENTION_TARGET_DISABLED",
  TARGET_NOT_MEMBER: "MENTION_TARGET_NOT_MEMBER",
  TARGET_SERVICE: "MENTION_TARGET_SERVICE",
  TARGET_UNKNOWN: "MENTION_TARGET_UNKNOWN",
  TEXT_MISMATCH: "MENTION_TEXT_MISMATCH",
  WORKSPACE_SCOPE: "MENTION_WORKSPACE_SCOPE",
});

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MENTION_CANDIDATE_PATTERN = /@([a-z0-9][a-z0-9._-]{0,63})/gu;
const WORD_OR_AT_PATTERN = /[\p{L}\p{N}_@]/u;
const URL_PATTERN = /\b[a-z][a-z\d+.-]{1,31}:\/\/[^\s<>()]+/giu;
const AUTOLINK_PATTERN = /<(?:https?|ftp|mailto):[^>]+>/giu;
const OFFSET_PATTERN = /^[0-9a-f]{16}_[0-9a-f]{16}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const encoder = new TextEncoder();

export class MentionValidationError extends Error {
  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      name: this.name,
      path: this.path,
    };
  }
}

export function mentionError(code, path, detail) {
  const error = new MentionValidationError(`${code} at ${path}: ${detail}`);
  error.name = "MentionValidationError";
  error.code = code;
  error.path = path;
  error.detail = detail;
  return error;
}

/**
 * Parse only visible, Markdown-aware @handle candidates. Resolution is
 * deliberately separate: the parser never turns display text into authority.
 */
export function parseMentionCandidates(value) {
  validateMentionParseText(value);
  const exclusions = markdownExclusions(value);
  const candidates = [];
  MENTION_CANDIDATE_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(MENTION_CANDIDATE_PATTERN)) {
    const startCodeUnit = match.index ?? 0;
    const endCodeUnit = startCodeUnit + match[0].length;
    if (
      isExcluded(exclusions, startCodeUnit) ||
      isExcluded(
        exclusions,
        startCodeUnit > endCodeUnit - 1 ? startCodeUnit : endCodeUnit - 1,
      ) ||
      !hasMentionBoundary(value, startCodeUnit)
    ) {
      continue;
    }
    const handle = match[1];
    const startByte = utf8ByteLength(value.slice(0, startCodeUnit));
    const endByte = utf8ByteLength(value.slice(0, endCodeUnit));
    candidates.push(
      Object.freeze({
        handle,
        text: match[0],
        span: Object.freeze({ startByte, endByte }),
      }),
    );
  }
  return Object.freeze(candidates);
}

export function validateMentionFacts(
  value,
  text,
  { expectedWorkspaceId, allowSource = false, path = "$.mentions" } = {},
) {
  validateConversationText(text, "$.text");
  if (!Array.isArray(value) || value.length > MENTION_MAX_COUNT) {
    throw mentionError(
      MENTION_REFUSAL_CODES.INVALID_FACT,
      path,
      `mentions must be an array with at most ${MENTION_MAX_COUNT} entries`,
    );
  }
  if (expectedWorkspaceId !== undefined)
    validateWorkspaceId(expectedWorkspaceId);

  const bytes = encoder.encode(text);
  const normalized = value.map((fact, index) =>
    validateMentionFact(fact, text, bytes, {
      expectedWorkspaceId,
      allowSource,
      path: `${path}[${index}]`,
    }),
  );
  let previousEnd = -1;
  for (let index = 0; index < normalized.length; index += 1) {
    const span = normalized.at(index).span;
    if (span.startByte < previousEnd) {
      throw mentionError(
        MENTION_REFUSAL_CODES.INVALID_SPAN,
        `${path}[${index}].span`,
        "mention spans must be sorted and non-overlapping",
      );
    }
    previousEnd = span.endByte;
  }
  return normalized;
}

export function validateMentionSource(value, path = "$.source") {
  if (!isRecord(value)) {
    throw mentionError(
      MENTION_REFUSAL_CODES.INVALID_FACT,
      path,
      "mention source must be an object",
    );
  }
  assertExactKeys(value, ["digest", "offset", "stream"], path);
  if (
    typeof value.stream !== "string" ||
    !/^[-A-Za-z0-9:_/.]{1,400}$/u.test(value.stream)
  ) {
    throw mentionError(
      MENTION_REFUSAL_CODES.INVALID_FACT,
      `${path}.stream`,
      "mention source stream must be a bounded canonical string",
    );
  }
  if (typeof value.offset !== "string" || !OFFSET_PATTERN.test(value.offset)) {
    throw mentionError(
      MENTION_REFUSAL_CODES.INVALID_FACT,
      `${path}.offset`,
      "mention source offset must be a Durable Streams checkpoint",
    );
  }
  if (typeof value.digest !== "string" || !DIGEST_PATTERN.test(value.digest)) {
    throw mentionError(
      MENTION_REFUSAL_CODES.INVALID_FACT,
      `${path}.digest`,
      "mention source digest must be a canonical SHA-256 digest",
    );
  }
  return value;
}

export function bindMentionSources(
  mentions,
  source,
  { expectedWorkspaceId, text } = {},
) {
  validateMentionSource(source);
  if (!Array.isArray(mentions)) {
    throw mentionError(
      MENTION_REFUSAL_CODES.INVALID_FACT,
      "$.mentions",
      "mentions must be an array",
    );
  }
  const bytes = text === undefined ? null : encoder.encode(text);
  const validatedMentions =
    text === undefined
      ? mentions.map((fact, index) =>
          validateMentionFact(fact, text, bytes, {
            allowSource: false,
            expectedWorkspaceId,
            path: `$.mentions[${index}]`,
          }),
        )
      : validateMentionFacts(mentions, text, {
          expectedWorkspaceId,
          path: "$.mentions",
        });
  return validatedMentions.map((validated) => {
    return Object.freeze({
      ...validated,
      source: Object.freeze({ ...source }),
    });
  });
}

function validateMentionFact(
  value,
  text,
  bytes,
  { expectedWorkspaceId, allowSource, path },
) {
  if (!isRecord(value)) {
    throw mentionError(
      MENTION_REFUSAL_CODES.INVALID_FACT,
      path,
      "mention fact must be an object",
    );
  }
  const allowedKeys = ["handle", "kind", "principalId", "span", "text"];
  if (allowSource) allowedKeys.push("source");
  assertExactKeys(value, allowedKeys, path);
  if (typeof value.handle !== "string" || !HANDLE_PATTERN.test(value.handle)) {
    throw mentionError(
      MENTION_REFUSAL_CODES.INVALID_FACT,
      `${path}.handle`,
      "mention handle must be lowercase and bounded",
    );
  }
  if (!MENTION_PRINCIPAL_KINDS.includes(value.kind)) {
    throw mentionError(
      MENTION_REFUSAL_CODES.INVALID_FACT,
      `${path}.kind`,
      "mention kind must be human or agent",
    );
  }
  validatePrincipalId(value.principalId, {
    expectedWorkspaceId,
    path: `${path}.principalId`,
  });
  if (value.text !== `@${value.handle}`) {
    throw mentionError(
      MENTION_REFUSAL_CODES.TEXT_MISMATCH,
      `${path}.text`,
      "mention text must exactly match its canonical handle",
    );
  }
  if (!isRecord(value.span)) {
    throw mentionError(
      MENTION_REFUSAL_CODES.INVALID_SPAN,
      `${path}.span`,
      "mention span must be an object",
    );
  }
  assertExactKeys(value.span, ["endByte", "startByte"], `${path}.span`);
  if (
    !Number.isSafeInteger(value.span.startByte) ||
    !Number.isSafeInteger(value.span.endByte) ||
    value.span.startByte < 0 ||
    value.span.endByte <= value.span.startByte ||
    (bytes !== null && value.span.endByte > bytes.byteLength)
  ) {
    throw mentionError(
      MENTION_REFUSAL_CODES.INVALID_SPAN,
      `${path}.span`,
      "mention span must be a non-empty UTF-8 byte range within the message",
    );
  }
  if (bytes !== null) {
    const observed = bytes.slice(value.span.startByte, value.span.endByte);
    const expected = encoder.encode(value.text);
    if (!sameBytes(observed, expected)) {
      throw mentionError(
        MENTION_REFUSAL_CODES.TEXT_MISMATCH,
        `${path}.span`,
        "mention span does not identify the exact visible message bytes",
      );
    }
  }
  if (allowSource && Object.hasOwn(value, "source")) {
    validateMentionSource(value.source, `${path}.source`);
  }
  return {
    handle: value.handle,
    kind: value.kind,
    principalId: value.principalId,
    span: {
      endByte: value.span.endByte,
      startByte: value.span.startByte,
    },
    text: value.text,
    ...(allowSource && Object.hasOwn(value, "source")
      ? { source: { ...value.source } }
      : {}),
  };
}

function markdownExclusions(text) {
  const ranges = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    ranges.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  }
  for (const match of text.matchAll(AUTOLINK_PATTERN)) {
    ranges.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  }
  ranges.push(...blockQuoteRanges(text));
  ranges.push(...fencedCodeRanges(text));
  ranges.push(...inlineCodeRanges(text, ranges));
  ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const [start, end] of ranges) {
    if (end <= start) continue;
    const previous = merged.at(-1);
    if (previous && start <= previous[1])
      previous[1] = previous[1] > end ? previous[1] : end;
    else merged.push([start, end]);
  }
  return merged;
}

function blockQuoteRanges(text) {
  return lineRanges(text)
    .filter(({ value }) => /^ {0,3}>/.test(value))
    .map(({ start, end }) => [start, end]);
}

function fencedCodeRanges(text) {
  const ranges = [];
  const lines = lineRanges(text);
  let fence = null;
  for (const line of lines) {
    const opener = line.value.match(/^ {0,3}(`{3,}|~{3,})/u);
    if (!fence) {
      if (opener) {
        fence = {
          char: opener[1][0],
          length: opener[1].length,
          start: line.start,
        };
      }
      continue;
    }
    const closePattern = new RegExp(
      `^ {0,3}${escapeRegExp(fence.char)}{${fence.length},}[ \\t]*$`,
      "u",
    );
    if (closePattern.test(line.value)) {
      ranges.push([fence.start, line.end]);
      fence = null;
    }
  }
  if (fence) ranges.push([fence.start, text.length]);
  return ranges;
}

function inlineCodeRanges(text, existingRanges) {
  const ranges = [];
  for (let index = 0; index < text.length;) {
    if (isExcluded(existingRanges, index) || text.at(index) !== "`") {
      index += 1;
      continue;
    }
    if (index > 0 && text.at(index - 1) === "\\") {
      index += 1;
      continue;
    }
    let runLength = 1;
    while (text.at(index + runLength) === "`") runLength += 1;
    let closing = -1;
    for (let cursor = index + runLength; cursor < text.length; cursor += 1) {
      if (isExcluded(existingRanges, cursor) || text.at(cursor) !== "`")
        continue;
      if (text.at(cursor - 1) === "\\") continue;
      let closingLength = 1;
      while (text.at(cursor + closingLength) === "`") closingLength += 1;
      if (closingLength === runLength) {
        closing = cursor + closingLength;
        break;
      }
      cursor += closingLength - 1;
    }
    ranges.push([index, closing === -1 ? text.length : closing]);
    index = closing === -1 ? text.length : closing;
  }
  return ranges;
}

function lineRanges(text) {
  const ranges = [];
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index !== text.length && text.at(index) !== "\n") continue;
    ranges.push({
      start,
      end: index === text.length ? index : index + 1,
      value: text.slice(start, index),
    });
    start = index + 1;
  }
  return ranges;
}

function hasMentionBoundary(text, start) {
  if (start === 0 || text.at(start - 1) === "\\") return start === 0;
  return !WORD_OR_AT_PATTERN.test(text.at(start - 1));
}

function isExcluded(ranges, index) {
  for (const [start, end] of ranges) {
    if (index < start) return false;
    if (index < end) return true;
  }
  return false;
}

function utf8ByteLength(value) {
  return encoder.encode(value).byteLength;
}

function validateMentionParseText(value) {
  if (typeof value !== "string") {
    throw mentionError(
      MENTION_REFUSAL_CODES.INVALID_TEXT,
      "$.text",
      "mention text must be a string",
    );
  }
  const normalized = value.normalize("NFC");
  if (normalized.length === 0 || normalized.length > 4_000) {
    throw mentionError(
      MENTION_REFUSAL_CODES.INVALID_TEXT,
      "$.text",
      "mention text must be 1-4000 code units",
    );
  }
  if (normalized !== value) {
    throw mentionError(
      MENTION_REFUSAL_CODES.INVALID_TEXT,
      "$.text",
      "mention text must be NFC-normalized",
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        throw mentionError(
          MENTION_REFUSAL_CODES.INVALID_TEXT,
          "$.text",
          "mention text contains an unpaired UTF-16 surrogate",
        );
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw mentionError(
        MENTION_REFUSAL_CODES.INVALID_TEXT,
        "$.text",
        "mention text contains an unpaired UTF-16 surrogate",
      );
    }
    if (
      (codeUnit <= 31 && codeUnit !== 10) ||
      (codeUnit >= 128 && codeUnit <= 159) ||
      codeUnit === 127 ||
      /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value.at(index))
    ) {
      throw mentionError(
        MENTION_REFUSAL_CODES.INVALID_TEXT,
        "$.text",
        "mention text contains a forbidden control or bidi character",
      );
    }
  }
  return value;
}

function sameBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left.at(index) !== right.at(index)) return false;
  }
  return true;
}

function assertExactKeys(value, expectedKeys, path) {
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw mentionError(
        MENTION_REFUSAL_CODES.INVALID_FACT,
        `${path}.${key}`,
        "field is not allowed",
      );
    }
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) {
      throw mentionError(
        MENTION_REFUSAL_CODES.INVALID_FACT,
        `${path}.${key}`,
        "field is required",
      );
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
