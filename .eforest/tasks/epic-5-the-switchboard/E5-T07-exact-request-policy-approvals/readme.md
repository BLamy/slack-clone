---
id: E5-T07
epic: 5
title: "Exact-request policy and approvals: risk decisions bind one canonical tool call"
priority: 507
status: pending
depends_on: [E5-T06]
estimate: L
capstone: false
---

## Goal

Every tool execution is evaluated against versioned tenant/connection/agent policy. Calls
may be allowed, denied, or paused for human approval; an approval binds the canonical
request digest, catalog and connection revisions, run lease, approver, and expiry so any
parameter or policy change requires a new decision.

## Context

Risk labels alone are not authorization. A prompt-injected agent must not obtain approval
for one request and execute another, batch extra side effects, or reuse an approval across
runs. Policy decisions and approval transitions are append-only evidence.

## Deliverables

- Policy/approval events and reducer, deterministic evaluator, and request-digest binding.
- Pending/approve/deny/expire APIs with role checks and idempotent execution handoff.
- `make verify-E5-T07` with race, mutation, expiry, and privilege matrices.

## Acceptance criteria

- [ ] `make verify-E5-T07` passes cold and replays policy/approval races twice to an
      identical decision timeline and digest with exactly one permitted execution.
- [ ] Evaluation inputs include tenant, agent/config revision, run/lease, catalog/
      operation version, connection revision, normalized input hash, risk/effect, and
      current policy version.
- [ ] Approval authorizes exactly that digest once before expiry; changing any input,
      policy, connection, catalog, lease, or run field invalidates it before execution.
- [ ] Only authorized human roles may approve, self-approval by the invoking agent or
      harness is impossible, and cross-tenant approval ids reveal no existence.
- [ ] Duplicate approve/deny/execute requests settle idempotently; cancel, revoke, or
      expiry wins before any later broker request and records a terminal reason.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (server policy/approval
      engine; approval UI is later) + mitigation: cold-clone state replay, exact-digest
      mutation matrix, role authz tests, and single-execution proof`.

## Adversarial verification

1. Approve a read then mutate it into a write, change one nested parameter, catalog,
   connection, policy, or lease. Every altered request must require a new approval.
2. Race approve, deny, cancel, expire, and duplicate execute. More than one broker call or
   a call after a terminal transition refutes atomicity.
3. Forge agent/harness approvals and enumerate foreign ids. Any accepted non-human role or
   distinguishable cross-tenant response is a finding.
4. Remove one digest field in a scratch worktree. Its one-field mutation fixture must turn
   the verifier red.

## Verification log
