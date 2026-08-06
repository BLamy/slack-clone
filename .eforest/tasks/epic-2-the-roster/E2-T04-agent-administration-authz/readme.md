---
id: E2-T04
epic: 2
title: "Agent administration authorization and separation of duties"
priority: 204
status: in-progress
depends_on: [E2-T03]
estimate: L
capstone: false
---

## Goal

Enforce a complete agent-administration capability matrix that separates identity ownership,
workspace administration, agent configuration, channel membership, provider operation, and
connection/credential grants.

## Context

An agent's human owner is an attribution and management relationship, not ambient authority.
Likewise, an agent manager should not gain secret-management access, and a secret manager
should not be able to change an agent's instructions or impersonate it. Authorization is
evaluated from current durable membership and grant state at each operation; cached sessions
and stale revisions do not preserve revoked power.

## Deliverables

- Frozen capability vocabulary and allow/refuse matrix for workspace admins, agent managers,
  agent owners, channel managers, connection managers, and ordinary members.
- Authorization checks for every E2 API/CLI operation and cross-resource reference.
- Race tests for role/grant revocation against configuration mutations.
- `make verify-E2-T04` cold-clone target and negative-matrix evidence.

## Acceptance criteria

- [ ] `make verify-E2-T04` exits 0 from a cold clone and records every
      actor/operation/resource combination
      in the frozen matrix with source heads before and after refusals.
- [ ] Agent ownership alone grants no workspace role escalation, private-channel access,
      provider registration, connection grant, credential read, or human impersonation.
- [ ] Agent managers can perform only their enumerated lifecycle/config operations;
      connection managers can bind references without reading values; ordinary members can
      only view visible roster/profile data.
- [ ] Cross-workspace, sibling-agent, sibling-channel, and sibling-connection references fail
      closed even when the caller holds the corresponding capability in another scope.
- [ ] Role, ownership, membership, and grant revocation are revalidated on mutation; a stale
      session or expected revision cannot authorize a post-revocation append.
- [ ] Every denied operation leaves all source and audit stream heads unchanged except for a
      permitted redacted refusal audit event under the frozen policy.
- [ ] Replay is declared `Replay: N/A (server authorization matrix) + mitigation: exhaustive
      negative matrix, revocation races, before/after heads, and replayed capability state`.

## Adversarial verification

1. Attempt every operation as each role, the agent itself, its owner, an unrelated owner,
   and a sibling-workspace administrator. One matrix mismatch refutes the boundary.
2. Race capability revocation with revise, activate, disable, membership, and connection
   binding. Any post-revocation success refutes current-state authorization.
3. Substitute valid IDs from another scope at every nested reference. Acceptance refutes
   confused-deputy protection.
4. Try to infer hidden agent/connection existence through status, pagination, error text,
   and timing. Distinguishable unauthorized results refute privacy.
5. Remove one capability check in a scratch worktree; the exhaustive matrix must go red.

## Verification log
