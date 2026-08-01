---
id: E1-T02
epic: 1
title: "Workspace membership, roles, and tenant boundary"
priority: 102
status: pending
depends_on: [E1-T01]
estimate: L
capstone: false
---

## Goal

Model workspaces, memberships, and explicit role capabilities on authoritative streams and
enforce the authenticated workspace boundary before any directory, channel, message, or
live-subscription access.

## Context

The current server treats any authenticated user as authorized for every normalized room.
The workspace is the primary tenant boundary. It is resolved from trusted routing and
authentication context, not an event field, query parameter, or guessed default. Roles are
reduced to concrete capabilities so later agent and connection administration can extend
the matrix without treating a role name as ambient authority.

## Deliverables

- Workspace and membership events, reducers, role-capability table, and bootstrap rules.
- Authorization middleware that establishes immutable workspace context before dispatch or
  live-read registration.
- Membership invite, accept, role-change, suspend, remove, and last-owner protections.
- Cross-tenant conformance matrix and `make verify-E1-T02` cold-clone target.

## Acceptance criteria

- [ ] `make verify-E1-T02` exits 0 from a cold clone and records replay digests plus the
      complete
      allow/refuse capability matrix for two isolated workspaces.
- [ ] Workspace context is derived before handler input is interpreted; changing any
      client-supplied workspace ID, host hint, or event field cannot override it.
- [ ] Membership lifecycle and role changes are append-only events whose replay produces
      the same effective capability set in a fresh process.
- [ ] A non-member and a member of a sibling workspace receive generic refusals for
      directory reads, mutations, subscriptions, and ID probes without metadata leakage.
- [ ] Last-owner removal, self-escalation, accepting another principal's invite, duplicate
      membership, and stale expected-version writes are refused before append.
- [ ] Revocation is checked at every new mutation and subscription, not cached for the
      session lifetime; all refused stream heads remain unchanged.
- [ ] Replay is declared `Replay: N/A (server tenancy and RBAC contract) + mitigation:
      two-workspace negative matrix, before/after dumps, and deterministic membership replay`.

## Adversarial verification

1. Replay every endpoint with valid IDs from a sibling workspace in path, query, body, and
   headers. One leaked name, count, timing-specific existence signal, or event refutes the
   tenant boundary.
2. Race role change, suspension, removal, and a protected mutation. A post-revocation
   acceptance under a stale capability refutes revalidation.
3. Forge invites, acceptance subjects, and owner counts; any orphaned workspace or privilege
   escalation refutes lifecycle validation.
4. Delete all membership projections and authorize from replayed state. A required process
   cache or hand-maintained ACL table refutes stream authority.
5. Disable workspace-context comparison in a scratch worktree and prove the conformance
   matrix goes red.

## Verification log
