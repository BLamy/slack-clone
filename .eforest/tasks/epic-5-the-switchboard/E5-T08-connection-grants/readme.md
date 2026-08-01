---
id: E5-T08
epic: 5
title: "Connection grants: administrators assign least-privilege service purposes to agent revisions"
priority: 508
status: pending
depends_on: [E5-T03, E5-T07]
estimate: M
capstone: false
---

## Goal

Workspace administrators can grant an immutable agent configuration revision selected
connections, catalog operations or purposes, risk ceilings, and approval requirements.
Invocation capture resolves grants deterministically; later edits or revocation affect new
runs and immediately fence active proxy identities according to explicit policy.

## Context

Owning a connection does not imply every agent can use it. Grants bridge Slack-like agent
administration and the broker/tool gateway while preserving least privilege and revision
history that can be reconstructed from streams.

## Deliverables

- Grant events/reducer, admin API/CLI schemas, and invocation-resolution logic.
- Connection/catalog/purpose scope intersection with E5-T03 identities and E5-T07 policy.
- `make verify-E5-T08` with revision, revoke, tenant, and race fixtures.

## Acceptance criteria

- [ ] `make verify-E5-T08` passes cold and resolves the same grant history twice to an
      identical effective-scope manifest and digest.
- [ ] A grant binds workspace, agent config revision, connection revision selector,
      allowed operation/purpose set, risk ceiling, approval mode, issuer, and lifecycle.
- [ ] Invocation scope is the strict intersection of agent grant, connection ownership,
      catalog operation requirements, and current tenant policy; an empty intersection
      prevents proxy identity issuance.
- [ ] Editing a grant creates a new revision. New runs capture it atomically; active runs
      retain or lose access only according to the documented immediate-revocation flag.
- [ ] Disable/delete/tenant removal revokes affected identities once, and foreign users,
      agents, or connections cannot infer grant existence through API differences.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (server-side connection
      grants) + mitigation: cold-clone reducer replay, scope-intersection matrix,
      revocation races, and exact effective-manifest digests`.

## Adversarial verification

1. Combine broad agent, narrow connection, conflicting policy, stale catalog, and wildcard
   purposes. Effective scope must never exceed the narrowest input.
2. Race invocation capture with grant edit/revoke. Each run must reference one committed
   grant revision and no impossible hybrid.
3. Attempt cross-workspace grant creation, listing, and use with guessed ids. Responses
   and stream heads must reveal nothing.
4. Widen union to replace intersection in a scratch worktree. The scope matrix must fail.

## Verification log
