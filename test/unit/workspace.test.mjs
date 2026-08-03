import assert from "node:assert/strict";
import test from "node:test";

import {
  ROLE_CAPABILITIES,
  WORKSPACE_CAPABILITIES,
  roleHasCapability,
} from "@stream-slack/protocol";

import {
  assertWorkspaceContext,
  bindWorkspaceRequest,
  createWorkspaceAuthorization,
  createWorkspaceFence,
  establishWorkspaceContext,
  WORKSPACE_AUTH_ERROR_CODES,
  WorkspaceAuthorizationError,
} from "../../src/ledger/workspace-auth.mjs";

const WORKSPACE_A = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const WORKSPACE_B = "ws_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const OWNER_A = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const MEMBER_A = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const OWNER_B = "pr_bbbbbbbbbbbbbbbbbbbbbbbbbb_cccccccccccccccccccccccccc";
const NON_MEMBER_A = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_ffffffffffffffffffffffffff";
const OWNER_MEMBERSHIP_A = {
  membershipId: "mb_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb",
  principalId: OWNER_A,
  role: "owner",
  status: "active",
  workspaceId: WORKSPACE_A,
};
const MEMBER_MEMBERSHIP_A = {
  membershipId: "mb_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc",
  principalId: MEMBER_A,
  role: "member",
  status: "active",
  workspaceId: WORKSPACE_A,
};

test("workspace context is optional-hint tolerant but immutable and tenant-bound", () => {
  const context = establishWorkspaceContext({
    authenticatedPrincipalId: OWNER_A,
    trustedWorkspaceId: WORKSPACE_A,
  });
  assert.equal(Object.isFrozen(context), true);
  assert.deepEqual(context, {
    principalId: OWNER_A,
    source: "trusted",
    workspaceId: WORKSPACE_A,
  });
  assert.equal(assertWorkspaceContext(context), context);

  for (const field of [
    "clientWorkspaceId",
    "pathWorkspaceId",
    "queryWorkspaceId",
    "bodyWorkspaceId",
    "eventWorkspaceId",
  ]) {
    assert.throws(
      () =>
        establishWorkspaceContext({
          authenticatedPrincipalId: OWNER_A,
          trustedWorkspaceId: WORKSPACE_A,
          [field]: WORKSPACE_B,
        }),
      (error) => genericAccessRefusal(error, [WORKSPACE_A, WORKSPACE_B]),
    );
  }
  assert.throws(
    () =>
      establishWorkspaceContext({
        authenticatedPrincipalId: OWNER_A,
        trustedWorkspaceId: WORKSPACE_A,
        trustedHost: "a.example",
        clientHost: "b.example",
      }),
    (error) => genericAccessRefusal(error, [WORKSPACE_A, WORKSPACE_B]),
  );
  assert.throws(
    () =>
      establishWorkspaceContext({
        authenticatedPrincipalId: OWNER_B,
        trustedWorkspaceId: WORKSPACE_A,
      }),
    (error) => genericAccessRefusal(error, [OWNER_A, OWNER_B, WORKSPACE_A]),
  );
  assert.throws(
    () => assertWorkspaceContext({ ...context }),
    (error) => error.code === WORKSPACE_AUTH_ERROR_CODES.CONTEXT_REQUIRED,
  );
});

test("workspace request binding rejects nested tenant overrides and binds trusted scope", () => {
  const bound = bindWorkspaceRequest(
    { body: { text: "hello" }, query: { probeId: "opaque" } },
    WORKSPACE_A,
  );
  assert.equal(bound.workspaceId, WORKSPACE_A);
  assert.throws(
    () =>
      bindWorkspaceRequest({ body: { workspaceId: WORKSPACE_B } }, WORKSPACE_A),
    (error) => genericAccessRefusal(error, [WORKSPACE_A, WORKSPACE_B]),
  );
  assert.throws(
    () =>
      bindWorkspaceRequest(
        { body: [{ nested: { workspaceId: WORKSPACE_B } }] },
        WORKSPACE_A,
      ),
    (error) => genericAccessRefusal(error, [WORKSPACE_A, WORKSPACE_B]),
  );
});

test("role capabilities are explicit and deny unlisted actions", () => {
  for (const role of ["owner", "admin"]) {
    for (const capability of WORKSPACE_CAPABILITIES) {
      assert.equal(roleHasCapability(role, capability), true);
    }
  }
  for (const [role, capabilities] of Object.entries(ROLE_CAPABILITIES)) {
    for (const capability of WORKSPACE_CAPABILITIES) {
      assert.equal(
        roleHasCapability(role, capability),
        capabilities.includes(capability),
        `${role} capability table drifted for ${capability}`,
      );
    }
  }
  assert.equal(
    roleHasCapability("member", "workspace.membership.remove"),
    false,
  );
  assert.equal(roleHasCapability("member", "workspace.channel.manage"), false);
  assert.equal(roleHasCapability("agent", "workspace.channel.manage"), false);
  assert.equal(roleHasCapability("guest", "workspace.message.mutate"), false);
  assert.equal(roleHasCapability("service", "workspace.subscribe"), false);
});

test("authorization rechecks membership for reads, mutations, and subscriptions", async () => {
  const current = new Map([
    [key(WORKSPACE_A, OWNER_A), OWNER_MEMBERSHIP_A],
    [key(WORKSPACE_A, MEMBER_A), MEMBER_MEMBERSHIP_A],
  ]);
  let dispatchCalls = 0;
  let registerCalls = 0;
  const authorization = createWorkspaceAuthorization({
    lookupMembership: async (workspaceId, principalId) =>
      current.get(key(workspaceId, principalId)) ?? null,
    withWorkspaceFence: createWorkspaceFence(),
  });
  const ownerContext = establishWorkspaceContext({
    authenticatedPrincipalId: OWNER_A,
    trustedWorkspaceId: WORKSPACE_A,
  });
  const memberContext = establishWorkspaceContext({
    authenticatedPrincipalId: MEMBER_A,
    trustedWorkspaceId: WORKSPACE_A,
  });
  const nonMemberContext = establishWorkspaceContext({
    authenticatedPrincipalId: NON_MEMBER_A,
    trustedWorkspaceId: WORKSPACE_A,
  });
  const siblingContext = establishWorkspaceContext({
    authenticatedPrincipalId: OWNER_B,
    trustedWorkspaceId: WORKSPACE_B,
  });

  assert.equal(
    (await authorization.authorizeRead(ownerContext)).membershipId,
    OWNER_MEMBERSHIP_A.membershipId,
  );
  const dispatched = await authorization.authorizeDispatch(
    { operation: "directory.mutate", payload: { value: "safe" } },
    memberContext,
    {
      dispatch: async (request) => {
        dispatchCalls += 1;
        return request;
      },
    },
  );
  assert.equal(dispatched.workspaceId, WORKSPACE_A);
  assert.equal(dispatchCalls, 1);
  const registered = await authorization.authorizeSubscription(
    { stream: "workspace:directory" },
    ownerContext,
    {
      register: async (request, context) => {
        registerCalls += 1;
        return { request, context };
      },
    },
  );
  assert.equal(registered.request.workspaceId, WORKSPACE_A);
  assert.equal(registered.context.workspaceId, WORKSPACE_A);
  assert.equal(registerCalls, 1);

  for (const context of [nonMemberContext, siblingContext]) {
    await assert.rejects(authorization.authorizeRead(context), (error) =>
      genericAccessRefusal(error, [context.principalId]),
    );
    await assert.rejects(
      authorization.authorizeSubscription(
        { stream: "workspace:directory" },
        context,
        { register: async () => assert.fail("unauthorized subscription") },
      ),
      (error) => genericAccessRefusal(error, [context.principalId]),
    );
  }

  current.set(key(WORKSPACE_A, MEMBER_A), {
    ...MEMBER_MEMBERSHIP_A,
    status: "suspended",
  });
  const beforeRefusedCalls = dispatchCalls;
  await assert.rejects(
    authorization.authorizeDispatch(
      { operation: "directory.mutate" },
      memberContext,
      { dispatch: async () => void (dispatchCalls += 1) },
    ),
    (error) => genericAccessRefusal(error, [MEMBER_A, WORKSPACE_A]),
  );
  assert.equal(dispatchCalls, beforeRefusedCalls);

  const unfenced = createWorkspaceAuthorization({
    lookupMembership: async () => OWNER_MEMBERSHIP_A,
  });
  await assert.rejects(
    unfenced.authorizeSubscription(
      { stream: "workspace:directory" },
      ownerContext,
      { register: async () => void (registerCalls += 1) },
    ),
    (error) => error.code === WORKSPACE_AUTH_ERROR_CODES.FENCE_REQUIRED,
  );
});

test("workspace fence serializes different principals during revocation", async () => {
  const current = new Map([
    [key(WORKSPACE_A, OWNER_A), OWNER_MEMBERSHIP_A],
    [key(WORKSPACE_A, MEMBER_A), MEMBER_MEMBERSHIP_A],
  ]);
  const fence = createWorkspaceFence();
  const authorization = createWorkspaceAuthorization({
    lookupMembership: async (workspaceId, principalId) =>
      current.get(key(workspaceId, principalId)) ?? null,
    withWorkspaceFence: fence,
  });
  const ownerContext = establishWorkspaceContext({
    authenticatedPrincipalId: OWNER_A,
    trustedWorkspaceId: WORKSPACE_A,
  });
  const memberContext = establishWorkspaceContext({
    authenticatedPrincipalId: MEMBER_A,
    trustedWorkspaceId: WORKSPACE_A,
  });
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  let release;
  const releasePromise = new Promise((resolve) => {
    release = resolve;
  });
  const first = authorization.authorizeDispatch(
    { operation: "message.mutate" },
    memberContext,
    {
      capability: "workspace.message.mutate",
      dispatch: async () => {
        started();
        await releasePromise;
      },
    },
  );
  await startedPromise;
  let revocationFinished = false;
  const revocation = fence(ownerContext, async () => {
    current.set(key(WORKSPACE_A, MEMBER_A), {
      ...MEMBER_MEMBERSHIP_A,
      status: "removed",
    });
    revocationFinished = true;
  });
  await Promise.resolve();
  assert.equal(revocationFinished, false);
  release();
  await first;
  await revocation;
  assert.equal(revocationFinished, true);
  await assert.rejects(
    authorization.authorizeDispatch(
      { operation: "message.mutate" },
      memberContext,
      {
        capability: "workspace.message.mutate",
        dispatch: async () => assert.fail("revoked member was dispatched"),
      },
    ),
    (error) => genericAccessRefusal(error, [MEMBER_A, WORKSPACE_A]),
  );
});

function key(workspaceId, principalId) {
  return `${workspaceId}\u0000${principalId}`;
}

function genericAccessRefusal(error, forbiddenValues) {
  assert.ok(error instanceof WorkspaceAuthorizationError);
  assert.equal(error.code, WORKSPACE_AUTH_ERROR_CODES.ACCESS_DENIED);
  const serialized = JSON.stringify(error.toJSON());
  for (const value of forbiddenValues)
    assert.equal(serialized.includes(value), false);
  return true;
}
