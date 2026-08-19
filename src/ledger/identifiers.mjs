import { LEDGER_ERROR_CODES, fail } from "./errors.mjs";

export const ID_TOKEN_PATTERN = "[0-9a-hjkmnp-tv-z]{26}";

const GLOBAL_ID_PATTERNS = Object.freeze({
  workspace: new RegExp(`^ws_${ID_TOKEN_PATTERN}$`),
  event: new RegExp(`^ev_${ID_TOKEN_PATTERN}$`),
  correlation: new RegExp(`^cr_${ID_TOKEN_PATTERN}$`),
  idempotency: new RegExp(`^ik_${ID_TOKEN_PATTERN}$`),
});

const SCOPED_ID_PREFIXES = Object.freeze({
  principal: "pr",
  channel: "ch",
  agent: "ag",
  run: "rn",
  connection: "cn",
  projection: "px",
});

const SCOPED_ID_PATTERNS = Object.fromEntries(
  Object.entries(SCOPED_ID_PREFIXES).map(([kind, prefix]) => [
    kind,
    new RegExp(`^${prefix}_(${ID_TOKEN_PATTERN})_(${ID_TOKEN_PATTERN})$`),
  ]),
);

export function assertIdentifier(kind, value, { path = `$.${kind}Id`, workspaceId } = {}) {
  if (typeof value !== "string") {
    fail(LEDGER_ERROR_CODES.INVALID_ID, path, `${kind} id must be a string`);
  }

  const globalPattern = GLOBAL_ID_PATTERNS[kind];
  if (globalPattern) {
    if (!globalPattern.test(value)) {
      fail(LEDGER_ERROR_CODES.INVALID_ID, path, `invalid ${kind} id`);
    }
    return value;
  }

  const scopedPattern = SCOPED_ID_PATTERNS[kind];
  if (!scopedPattern) {
    fail(LEDGER_ERROR_CODES.INVALID_ID, path, `unknown identifier kind ${kind}`);
  }

  const match = value.match(scopedPattern);
  if (!match) {
    fail(LEDGER_ERROR_CODES.INVALID_ID, path, `invalid ${kind} id`);
  }

  if (workspaceId !== undefined) {
    assertIdentifier("workspace", workspaceId, { path: "$.workspaceId" });
    const expectedWorkspaceToken = workspaceId.slice(3);
    if (match[1] !== expectedWorkspaceToken) {
      fail(
        LEDGER_ERROR_CODES.WORKSPACE_SCOPE_MISMATCH,
        path,
        `${kind} id belongs to a different workspace`,
      );
    }
  }

  return value;
}

export function workspaceIdFromScopedIdentifier(kind, value, path = `$.${kind}Id`) {
  assertIdentifier(kind, value, { path });
  const match = value.match(SCOPED_ID_PATTERNS[kind]);
  return `ws_${match[1]}`;
}

export const IDENTIFIER_PATTERNS = Object.freeze({
  global: GLOBAL_ID_PATTERNS,
  scoped: SCOPED_ID_PATTERNS,
});
