import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_ADMINISTRATION_CAPABILITIES,
  AGENT_ADMINISTRATION_MATRIX,
  administrationGrantDirectoryUpdate,
  createAdministrationGrant,
} from "@stream-slack/protocol";

import { createAgentAdministrationAuthorization } from "../../src/ledger/agent-administration-auth.mjs";
import { establishWorkspaceContext } from "../../src/ledger/workspace-auth.mjs";

const WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER_ID = `pr_${WORKSPACE_ID.slice(3)}_${"b".repeat(26)}`;
const MANAGER_ID = `pr_${WORKSPACE_ID.slice(3)}_${"e".repeat(26)}`;
const MEMBER_ID = `pr_${WORKSPACE_ID.slice(3)}_${"d".repeat(26)}`;
const AGENT_ID = `ag_${WORKSPACE_ID.slice(3)}_${"h".repeat(26)}`;
const AGENT_PRINCIPAL_ID = `pr_${AGENT_ID.slice(3)}`;

test("E2-T04 vocabulary is frozen and raw credential/impersonation stay denied", () => {
  assert.equal(Object.isFrozen(AGENT_ADMINISTRATION_CAPABILITIES), true);
  assert.equal(Object.isFrozen(AGENT_ADMINISTRATION_MATRIX), true);
  for (const actorClass of Object.keys(AGENT_ADMINISTRATION_MATRIX)) {
    assert.equal(
      AGENT_ADMINISTRATION_MATRIX[actorClass].includes(
        "connection.credential.read",
      ),
      false,
    );
    assert.equal(
      AGENT_ADMINISTRATION_MATRIX[actorClass].includes("principal.impersonate"),
      false,
    );
  }
});

test("agent manager grant is current-state authority and owner stays profile-only", async () => {
  const grant = createAdministrationGrant({
    capability: "agent.manager",
    principalId: MANAGER_ID,
    resourceId: WORKSPACE_ID,
    resourceType: "workspace",
    workspaceId: WORKSPACE_ID,
  });
  let state = directoryState(grant);
  const authorization = createAgentAdministrationAuthorization({
    readDirectory: async () => ({
      nextOffset: "0000000000000000_0000000000000001",
      state,
      stateDigest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
    workspaceId: WORKSPACE_ID,
  });
  const managerContext = contextFor(MANAGER_ID);
  const ownerContext = contextFor(OWNER_ID);

  const managerDecision = await authorization.explain({
    agentId: AGENT_ID,
    context: managerContext,
    operations: ["agent.config.revise"],
  });
  assert.equal(managerDecision.allowed, true);

  const ownerProfile = await authorization.explain({
    agentId: AGENT_ID,
    context: ownerContext,
    operations: ["agent.profile.read"],
  });
  const ownerConfig = await authorization.explain({
    agentId: AGENT_ID,
    context: ownerContext,
    operations: ["agent.config.revise"],
  });
  assert.equal(ownerProfile.allowed, true);
  assert.equal(ownerConfig.allowed, false);

  state = directoryState({
    ...grant,
    revision: 2,
    status: "revoked",
  });
  const revokedDecision = await authorization.explain({
    agentId: AGENT_ID,
    context: managerContext,
    operations: ["agent.config.revise"],
  });
  assert.equal(revokedDecision.allowed, false);
});

function contextFor(principalId) {
  return establishWorkspaceContext({
    authenticatedPrincipalId: principalId,
    clientHost: "test",
    trustedHost: "test",
    trustedWorkspaceId: WORKSPACE_ID,
  });
}

function directoryState(grant) {
  return {
    entities: {
      directory: {
        [grant.grantId]: {
          entityType: "administration.grant",
          id: grant.grantId,
          revision: grant.revision,
          value: administrationGrantDirectoryUpdate(grant).value,
        },
      },
      memberships: {
        [`mb_${WORKSPACE_ID.slice(3)}_${OWNER_ID.slice(30)}`]: membership(
          OWNER_ID,
          "member",
        ),
        [`mb_${WORKSPACE_ID.slice(3)}_${MANAGER_ID.slice(30)}`]: membership(
          MANAGER_ID,
          "member",
        ),
        [`mb_${WORKSPACE_ID.slice(3)}_${MEMBER_ID.slice(30)}`]: membership(
          MEMBER_ID,
          "member",
        ),
      },
      principals: {
        [OWNER_ID]: principal(OWNER_ID, "human", null),
        [MANAGER_ID]: principal(MANAGER_ID, "human", null),
        [MEMBER_ID]: principal(MEMBER_ID, "human", null),
        [AGENT_PRINCIPAL_ID]: principal(AGENT_PRINCIPAL_ID, "agent", OWNER_ID),
      },
    },
  };
}

function membership(principalId, role) {
  return {
    membershipId: `mb_${WORKSPACE_ID.slice(3)}_${principalId.slice(30)}`,
    principalId,
    revision: 1,
    role,
    status: "active",
    workspaceId: WORKSPACE_ID,
  };
}

function principal(principalId, kind, ownedBy) {
  return { kind, ownedBy, principalId, status: "active" };
}
