import {
  roleHasCapability,
  validatePrincipalId,
  validateWorkspaceId,
} from "@stream-slack/protocol";

export const WORKSPACE_AUTH_ERROR_CODES = Object.freeze({
  ACCESS_DENIED: "WORKSPACE_ACCESS_DENIED",
  CONTEXT_REQUIRED: "WORKSPACE_CONTEXT_REQUIRED",
  FENCE_REQUIRED: "WORKSPACE_FENCE_REQUIRED",
  INVALID_REQUEST: "WORKSPACE_INVALID_REQUEST",
});

const CONTEXT_KEYS = ["principalId", "source", "workspaceId"];
const CONTEXT_INPUT_KEYS = [
  "authenticatedPrincipalId",
  "bodyWorkspaceId",
  "clientHost",
  "clientWorkspaceId",
  "eventWorkspaceId",
  "pathWorkspaceId",
  "queryWorkspaceId",
  "trustedHost",
  "trustedWorkspaceId",
];
const WORKSPACE_TOKEN = "[0-9a-hjkmnp-tv-z]{26}";
const SCOPED_ID_PATTERN = new RegExp(
  `^(?:pr|ch|ag|rn|cn|px|mb|iv)_(${WORKSPACE_TOKEN})_${WORKSPACE_TOKEN}$`,
  "u",
);
const WORKSPACE_ID_PATTERN = new RegExp(`^ws_(${WORKSPACE_TOKEN})$`, "u");
const WORKSPACE_STREAM_PATTERN = new RegExp(
  `workspace:(ws_${WORKSPACE_TOKEN})(?:[/\\?#]|$)`,
  "u",
);
const EMBEDDED_WORKSPACE_ID_PATTERN = new RegExp(`ws_${WORKSPACE_TOKEN}`, "gu");
const EMBEDDED_SCOPED_ID_PATTERN = new RegExp(
  `(?:pr|ch|ag|rn|cn|px|mb|iv)_${WORKSPACE_TOKEN}_${WORKSPACE_TOKEN}`,
  "gu",
);

export class WorkspaceAuthorizationError extends Error {
  constructor(code, detail, { statusCode = 404 } = {}) {
    super(`${code}: ${detail}`);
    this.name = "WorkspaceAuthorizationError";
    this.code = code;
    this.detail = detail;
    this.statusCode = statusCode;
  }

  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      statusCode: this.statusCode,
    };
  }
}

export function establishWorkspaceContext(input) {
  try {
    assertAllowedKeys(input, CONTEXT_INPUT_KEYS);
    assertRequiredKeys(input, [
      "authenticatedPrincipalId",
      "trustedWorkspaceId",
    ]);
    validateWorkspaceId(input.trustedWorkspaceId);
    validatePrincipalId(input.authenticatedPrincipalId, {
      expectedWorkspaceId: input.trustedWorkspaceId,
    });
    if (
      input.trustedHost !== undefined &&
      input.clientHost !== undefined &&
      input.clientHost !== input.trustedHost
    ) {
      throw accessDenied();
    }
    for (const key of [
      "clientWorkspaceId",
      "pathWorkspaceId",
      "queryWorkspaceId",
      "bodyWorkspaceId",
      "eventWorkspaceId",
    ]) {
      if (input[key] !== undefined && input[key] !== input.trustedWorkspaceId) {
        throw accessDenied();
      }
    }
    return Object.freeze({
      principalId: input.authenticatedPrincipalId,
      source: "trusted",
      workspaceId: input.trustedWorkspaceId,
    });
  } catch (error) {
    if (error instanceof WorkspaceAuthorizationError) throw error;
    throw accessDenied();
  }
}

export const createWorkspaceContext = establishWorkspaceContext;

export function assertWorkspaceContext(context) {
  if (
    !context ||
    !Object.isFrozen(context) ||
    !hasExactKeys(context, CONTEXT_KEYS) ||
    context.source !== "trusted"
  ) {
    throw new WorkspaceAuthorizationError(
      WORKSPACE_AUTH_ERROR_CODES.CONTEXT_REQUIRED,
      "trusted workspace context is required",
      { statusCode: 401 },
    );
  }
  try {
    validateWorkspaceId(context.workspaceId);
    validatePrincipalId(context.principalId, {
      expectedWorkspaceId: context.workspaceId,
    });
  } catch {
    throw accessDenied();
  }
  return context;
}

export function assertWorkspaceCapability({ context, membership, capability }) {
  assertWorkspaceContext(context);
  if (
    !membership ||
    membership.workspaceId !== context.workspaceId ||
    membership.principalId !== context.principalId ||
    membership.status !== "active"
  ) {
    throw accessDenied();
  }
  try {
    if (!roleHasCapability(membership.role, capability)) throw accessDenied();
  } catch (error) {
    if (error instanceof WorkspaceAuthorizationError) throw error;
    throw accessDenied();
  }
  return membership;
}

export function createWorkspaceAuthorization({
  lookupMembership,
  withWorkspaceFence,
} = {}) {
  if (typeof lookupMembership !== "function") {
    throw new TypeError("workspace authorization requires lookupMembership");
  }
  if (
    withWorkspaceFence !== undefined &&
    typeof withWorkspaceFence !== "function"
  ) {
    throw new TypeError(
      "workspace authorization withWorkspaceFence must be a function",
    );
  }

  const fence =
    withWorkspaceFence ??
    (async () => {
      throw new WorkspaceAuthorizationError(
        WORKSPACE_AUTH_ERROR_CODES.FENCE_REQUIRED,
        "workspace authorization requires a linearizable membership fence",
        { statusCode: 503 },
      );
    });

  async function currentMembership(context, capability) {
    const trusted = assertWorkspaceContext(context);
    const membership = await lookupMembership(
      trusted.workspaceId,
      trusted.principalId,
    );
    return assertWorkspaceCapability({
      capability,
      context: trusted,
      membership,
    });
  }

  async function authorizeRead(
    context,
    { capability = "workspace.directory.read" } = {},
  ) {
    const trusted = assertWorkspaceContext(context);
    return fence(trusted, () => currentMembership(trusted, capability));
  }

  async function authorizeDispatch(
    request,
    context,
    { capability = "workspace.directory.mutate", dispatch, options } = {},
  ) {
    if (typeof dispatch !== "function") {
      throw new TypeError(
        "workspace authorization requires a dispatch function",
      );
    }
    const trusted = assertWorkspaceContext(context);
    const boundRequest = bindWorkspaceRequest(request, trusted.workspaceId);
    return fence(trusted, async () => {
      await currentMembership(trusted, capability);
      return dispatch(boundRequest, options);
    });
  }

  async function authorizeSubscription(
    request,
    context,
    { capability = "workspace.subscribe", register } = {},
  ) {
    if (typeof register !== "function") {
      throw new TypeError(
        "workspace authorization requires a subscription register function",
      );
    }
    const trusted = assertWorkspaceContext(context);
    const boundRequest = bindWorkspaceRequest(request, trusted.workspaceId);
    return fence(trusted, async () => {
      await currentMembership(trusted, capability);
      return register(boundRequest, trusted);
    });
  }

  return Object.freeze({
    assertWorkspaceCapability,
    authorizeDispatch,
    authorizeRead,
    authorizeSubscription,
  });
}

export const createWorkspaceAuthorizationMiddleware =
  createWorkspaceAuthorization;

export function createWorkspaceFence() {
  const tails = new Map();
  return Object.freeze((context, operation) => {
    const trusted = assertWorkspaceContext(context);
    if (typeof operation !== "function") {
      throw new TypeError("workspace fence requires an operation");
    }
    return serialize(tails, trusted.workspaceId, operation);
  });
}

export function bindWorkspaceRequest(request, trustedWorkspaceId) {
  if (!isRecord(request)) throw accessDenied();
  try {
    validateWorkspaceId(trustedWorkspaceId);
    assertNoWorkspaceOverride(request, trustedWorkspaceId, new Set());
  } catch (error) {
    if (error instanceof WorkspaceAuthorizationError) throw error;
    throw accessDenied();
  }
  return { ...request, workspaceId: trustedWorkspaceId };
}

function assertNoWorkspaceOverride(value, expectedWorkspaceId, seen) {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoWorkspaceOverride(item, expectedWorkspaceId, seen);
    }
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (isWorkspaceHintKey(key) && nested !== expectedWorkspaceId) {
      throw accessDenied();
    }
    const allowEmbeddedIds =
      key === "path" || key === "url" || key === "location";
    if (typeof nested === "string") {
      assertScopedValue(nested, expectedWorkspaceId, { allowEmbeddedIds });
    }
    assertNoWorkspaceOverride(nested, expectedWorkspaceId, seen);
  }
}

function assertScopedValue(
  value,
  expectedWorkspaceId,
  { allowEmbeddedIds = false } = {},
) {
  const candidates = [value];
  try {
    const decoded = decodeURIComponent(value);
    if (decoded !== value) candidates.push(decoded);
  } catch {
    throw accessDenied();
  }
  for (const candidate of candidates) {
    const workspaceMatch = candidate.match(WORKSPACE_ID_PATTERN);
    if (workspaceMatch && `ws_${workspaceMatch[1]}` !== expectedWorkspaceId) {
      throw accessDenied();
    }
    const scopedMatch = candidate.match(SCOPED_ID_PATTERN);
    if (scopedMatch && `ws_${scopedMatch[1]}` !== expectedWorkspaceId) {
      throw accessDenied();
    }
    const streamMatch = candidate.match(WORKSPACE_STREAM_PATTERN);
    if (streamMatch && streamMatch[1] !== expectedWorkspaceId) {
      throw accessDenied();
    }
    if (allowEmbeddedIds) {
      for (const embedded of candidate.matchAll(
        EMBEDDED_WORKSPACE_ID_PATTERN,
      )) {
        if (`ws_${embedded[0].slice(3)}` !== expectedWorkspaceId) {
          throw accessDenied();
        }
      }
      for (const embedded of candidate.matchAll(EMBEDDED_SCOPED_ID_PATTERN)) {
        const workspaceToken = embedded[0].split("_", 3)[1];
        if (`ws_${workspaceToken}` !== expectedWorkspaceId) {
          throw accessDenied();
        }
      }
    }
  }
}

function isWorkspaceHintKey(key) {
  const compact = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return compact === "workspaceid" || compact.endsWith("workspaceid");
}

function assertAllowedKeys(value, expectedKeys) {
  if (!isRecord(value)) throw new Error("request must be an object");
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key))
      throw new Error("request contains an unknown field");
  }
}

function assertRequiredKeys(value, requiredKeys) {
  if (!isRecord(value)) throw new Error("request must be an object");
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new Error("request is missing a required field");
    }
  }
}

function hasExactKeys(value, expectedKeys) {
  if (!isRecord(value)) return false;
  const expected = new Set(expectedKeys);
  const actual = Object.keys(value);
  return (
    actual.length === expectedKeys.length &&
    actual.every((key) => expected.has(key)) &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function accessDenied() {
  return new WorkspaceAuthorizationError(
    WORKSPACE_AUTH_ERROR_CODES.ACCESS_DENIED,
    "workspace access denied",
    { statusCode: 404 },
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function serialize(tails, key, operation) {
  const prior = tails.get(key) ?? Promise.resolve();
  const result = prior.then(operation, operation);
  const settled = result.then(
    (value) => {
      if (tails.get(key) === settled) tails.delete(key);
      return value;
    },
    (_error) => {
      if (tails.get(key) === settled) tails.delete(key);
      return undefined;
    },
  );
  tails.set(key, settled);
  return result;
}
