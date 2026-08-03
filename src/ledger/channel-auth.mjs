import {
  CHANNEL_CAPABILITIES,
  validateChannelId,
} from "@stream-slack/protocol";

import {
  assertWorkspaceContext,
  WorkspaceAuthorizationError,
} from "./workspace-auth.mjs";

export const CHANNEL_AUTH_ERROR_CODES = Object.freeze({
  ACCESS_DENIED: "CHANNEL_ACCESS_DENIED",
  CONTEXT_REQUIRED: "CHANNEL_CONTEXT_REQUIRED",
  FENCE_REQUIRED: "CHANNEL_FENCE_REQUIRED",
  INVALID_REQUEST: "CHANNEL_INVALID_REQUEST",
});

const CHANNEL_STREAM_PATTERN = /^channel:(ch_[^/]+)(?:[/?#]|$)/u;
const CHANNEL_ID_PATTERN = /ch_[0-9a-hjkmnp-tv-z]{26}_[0-9a-hjkmnp-tv-z]{26}/gu;

export class ChannelAuthorizationError extends Error {
  constructor(code, detail, { statusCode = 404 } = {}) {
    super(`${code}: ${detail}`);
    this.name = "ChannelAuthorizationError";
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

export function createChannelAuthorization({
  lookupChannel,
  lookupChannelMembership,
  lookupChannelInvite,
  lookupWorkspaceMembership,
  withChannelFence,
} = {}) {
  for (const [name, value] of Object.entries({
    lookupChannel,
    lookupChannelMembership,
    lookupWorkspaceMembership,
  })) {
    if (typeof value !== "function") {
      throw new TypeError(`channel authorization requires ${name}`);
    }
  }
  if (
    lookupChannelInvite !== undefined &&
    typeof lookupChannelInvite !== "function"
  ) {
    throw new TypeError(
      "channel authorization lookupChannelInvite must be a function",
    );
  }
  if (
    withChannelFence !== undefined &&
    typeof withChannelFence !== "function"
  ) {
    throw new TypeError(
      "channel authorization withChannelFence must be a function",
    );
  }
  const fence =
    withChannelFence ??
    (async () => {
      throw new ChannelAuthorizationError(
        CHANNEL_AUTH_ERROR_CODES.FENCE_REQUIRED,
        "channel authorization requires a linearizable channel fence",
        { statusCode: 503 },
      );
    });

  async function authorizeDiscovery(
    context,
    { channelId, auditedAdminOperation = false, audit } = {},
  ) {
    const trusted = trustedContext(context);
    return fence(
      {
        channelId: validateChannel(channelId, trusted.workspaceId),
        ...trusted,
      },
      () =>
        resolveCapability(trusted, channelId, "channel.discover", {
          audit,
          auditedAdminOperation,
        }),
    );
  }

  async function authorizeRead(
    context,
    { adminOperation = false, audit, channelId, path = "snapshot" } = {},
  ) {
    const trusted = trustedContext(context);
    return fence(
      {
        channelId: validateChannel(channelId, trusted.workspaceId),
        ...trusted,
      },
      () =>
        resolveCapability(trusted, channelId, "channel.read", {
          audit,
          auditedAdminOperation: adminOperation,
          path,
        }),
    );
  }

  async function authorizeDispatch(
    request,
    context,
    { channelId, capability = "channel.message.write", dispatch, options } = {},
  ) {
    if (typeof dispatch !== "function") {
      throw new TypeError("channel authorization requires a dispatch function");
    }
    const trusted = trustedContext(context);
    const boundChannelId = validateChannel(channelId, trusted.workspaceId);
    const boundRequest = bindChannelRequest(request, boundChannelId);
    return fence({ channelId: boundChannelId, ...trusted }, async () => {
      await resolveCapability(trusted, boundChannelId, capability, {
        request: boundRequest,
      });
      return dispatch(boundRequest, options);
    });
  }

  async function authorizeSubscription(
    request,
    context,
    { channelId, register, options } = {},
  ) {
    if (typeof register !== "function") {
      throw new TypeError(
        "channel authorization requires a subscription register function",
      );
    }
    const trusted = trustedContext(context);
    const boundChannelId = validateChannel(channelId, trusted.workspaceId);
    const boundRequest = bindChannelRequest(request, boundChannelId);
    return fence({ channelId: boundChannelId, ...trusted }, async () => {
      const authorization = await resolveCapability(
        trusted,
        boundChannelId,
        "channel.subscribe",
      );
      return register(boundRequest, authorization, options);
    });
  }

  async function authorizeProjection(context, options) {
    return authorizeRead(context, { ...options, path: "projection" });
  }

  async function authorizeSearch(context, options) {
    return authorizeRead(context, { ...options, path: "search" });
  }

  async function resolveCapability(
    trusted,
    channelId,
    capability,
    {
      audit,
      auditedAdminOperation = false,
      path = "read",
      request = null,
    } = {},
  ) {
    if (!CHANNEL_CAPABILITIES.includes(capability)) throw accessDenied();
    const channel = await lookupChannel(trusted.workspaceId, channelId);
    const workspaceMembership = await lookupWorkspaceMembership(
      trusted.workspaceId,
      trusted.principalId,
    );
    const channelMembership = await lookupChannelMembership(
      trusted.workspaceId,
      channelId,
      trusted.principalId,
    );
    if (
      !channel ||
      channel.workspaceId !== trusted.workspaceId ||
      !workspaceMembership ||
      workspaceMembership.workspaceId !== trusted.workspaceId ||
      workspaceMembership.principalId !== trusted.principalId ||
      workspaceMembership.status !== "active"
    ) {
      throw accessDenied();
    }

    const isMember =
      channelMembership?.channelId === channelId &&
      channelMembership.principalId === trusted.principalId &&
      channelMembership.status === "active";
    const isWorkspaceAdmin = ["owner", "admin"].includes(
      workspaceMembership.role,
    );
    const isManager =
      channel.creatorId === trusted.principalId ||
      (isWorkspaceAdmin && isMember);
    const isActive = channel.status === "active";
    const grant = () =>
      authorizationResult(channel, channelMembership, workspaceMembership, {
        revalidate: () =>
          fence({ channelId, ...trusted }, () =>
            resolveCapability(trusted, channelId, capability, {
              audit,
              auditedAdminOperation,
              path,
              request,
            }),
          ),
      });

    if (capability === "channel.discover" && channel.kind === "public") {
      return grant();
    }
    if (capability === "channel.manage" && isManager) {
      return grant();
    }
    if (
      (capability === "channel.membership.invite" ||
        capability === "channel.membership.remove") &&
      isManager &&
      isActive
    ) {
      return grant();
    }
    if (capability === "channel.membership.join" && isActive) {
      assertTargetPrincipal(request, trusted.principalId);
      if (channel.kind === "public") {
        return grant();
      }
      if (
        channel.kind === "private" &&
        (await hasPendingInvite(
          trusted.workspaceId,
          channelId,
          trusted.principalId,
          request,
        ))
      ) {
        return grant();
      }
    }
    if (capability === "channel.membership.leave" && isMember && isActive) {
      assertTargetPrincipal(request, trusted.principalId);
      if (channel.kind !== "direct") {
        return grant();
      }
    }
    if (
      (capability === "channel.read" || capability === "channel.subscribe") &&
      isMember
    ) {
      return grant();
    }
    if (capability === "channel.message.write" && isMember) {
      if (channel.status !== "active") throw accessDenied();
      return grant();
    }
    if (
      auditedAdminOperation &&
      isWorkspaceAdmin &&
      (capability === "channel.discover" || capability === "channel.read") &&
      typeof audit === "function"
    ) {
      const audited = await audit({
        channelId,
        operation: `channel.${path}.admin.read`,
        principalId: trusted.principalId,
        workspaceId: trusted.workspaceId,
      });
      if (audited === true || audited?.ok === true) {
        return grant();
      }
    }
    throw accessDenied();
  }

  async function hasPendingInvite(
    workspaceId,
    channelId,
    principalId,
    request,
  ) {
    if (typeof lookupChannelInvite !== "function") return false;
    const inviteIds = collectRequestValues(request, "inviteId");
    if (inviteIds.length !== 1) return false;
    const invite = await lookupChannelInvite(
      workspaceId,
      channelId,
      inviteIds[0],
    );
    return Boolean(
      invite &&
      invite.workspaceId === workspaceId &&
      invite.channelId === channelId &&
      invite.inviteId === inviteIds[0] &&
      invite.principalId === principalId &&
      invite.status === "pending",
    );
  }

  return Object.freeze({
    authorizeDiscovery,
    authorizeDispatch,
    authorizeProjection,
    authorizeRead,
    authorizeSearch,
    authorizeSubscription,
  });
}

export function bindChannelRequest(request, trustedChannelId) {
  try {
    validateChannelId(trustedChannelId);
    assertNoChannelOverride(request, trustedChannelId, new Set());
  } catch (error) {
    if (error instanceof ChannelAuthorizationError) throw error;
    throw accessDenied();
  }
  return { ...request, channelId: trustedChannelId };
}

export function createChannelFence() {
  const tails = new Map();
  return (context, operation) => {
    if (
      !context ||
      typeof context.workspaceId !== "string" ||
      typeof context.channelId !== "string" ||
      typeof operation !== "function"
    ) {
      throw new ChannelAuthorizationError(
        CHANNEL_AUTH_ERROR_CODES.CONTEXT_REQUIRED,
        "channel context and operation are required",
        { statusCode: 401 },
      );
    }
    const key = `${context.workspaceId}\u0000${context.channelId}`;
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
  };
}

function trustedContext(context) {
  try {
    const workspace = assertWorkspaceContext(context);
    if (
      !Object.isFrozen(context) ||
      !Object.hasOwn(context, "principalId") ||
      !Object.hasOwn(context, "workspaceId")
    ) {
      throw accessDenied();
    }
    return workspace;
  } catch (error) {
    if (error instanceof ChannelAuthorizationError) throw error;
    if (error instanceof WorkspaceAuthorizationError) throw accessDenied();
    throw accessDenied();
  }
}

function validateChannel(channelId, workspaceId) {
  try {
    return validateChannelId(channelId, { expectedWorkspaceId: workspaceId });
  } catch {
    throw accessDenied();
  }
}

function authorizationResult(
  channel,
  channelMembership,
  workspaceMembership,
  { revalidate } = {},
) {
  return Object.freeze({
    channel,
    channelMembership: channelMembership ?? null,
    revalidate,
    workspaceMembership,
  });
}

function assertNoChannelOverride(value, expectedChannelId, seen) {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoChannelOverride(item, expectedChannelId, seen);
    }
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    const compact = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
    if (compact === "channelid" || compact.endsWith("channelid")) {
      if (nested !== expectedChannelId) throw accessDenied();
    }
    if (typeof nested === "string") {
      const candidates = [nested];
      try {
        const decoded = decodeURIComponent(nested);
        if (decoded !== nested) candidates.push(decoded);
      } catch {
        throw accessDenied();
      }
      for (const candidate of candidates) {
        const stream = candidate.match(CHANNEL_STREAM_PATTERN);
        if (stream && stream[1] !== expectedChannelId) throw accessDenied();
        for (const embedded of candidate.matchAll(CHANNEL_ID_PATTERN)) {
          if (embedded[0] !== expectedChannelId) throw accessDenied();
        }
      }
    }
    assertNoChannelOverride(nested, expectedChannelId, seen);
  }
}

function assertTargetPrincipal(request, expectedPrincipalId) {
  const principalIds = collectRequestValues(request, "principalId");
  if (principalIds.length !== 1 || principalIds[0] !== expectedPrincipalId) {
    throw accessDenied();
  }
}

function collectRequestValues(
  value,
  expectedKey,
  values = [],
  seen = new Set(),
) {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return values;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRequestValues(item, expectedKey, values, seen);
    }
    return values;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key === expectedKey && typeof nested === "string") values.push(nested);
    collectRequestValues(nested, expectedKey, values, seen);
  }
  return values;
}

function accessDenied() {
  return new ChannelAuthorizationError(
    CHANNEL_AUTH_ERROR_CODES.ACCESS_DENIED,
    "channel access denied",
    { statusCode: 404 },
  );
}
