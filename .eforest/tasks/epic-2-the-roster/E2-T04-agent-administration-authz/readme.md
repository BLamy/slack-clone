---
id: E2-T04
epic: 2
title: "Agent administration authorization and separation of duties"
priority: 204
status: verified
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

### Builder — 2026-08-06

- Commit: `51521cc2a3c73b349a00ad007e3b157456b0adc2`.
- Cold proof: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e2-t04-cold-final-v3 make verify-E2-T04` passed from a clean detached worktree; `git worktree add`, submodule initialization, `pnpm install --frozen-lockfile`, `pnpm setup:emulate`, and `node scripts/verify-e2-t04.mjs` all exited 0.
- Gates: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all exited 0 in the cold verifier.
- Evidence: `evidence/e2-t04-final/verification-summary.json`, `matrix.json`, `http-transcript.json`, `source-heads.json`, `revocation-races.json`, `sensitivity.json`, and `cold-clone-transcript.json`.
- Matrix: 195 rows across all eight frozen actor classes and 17 capabilities, 100 refusals, 42 negative API rows with before/after source-head checks, real canary refusal/redaction, and three sensitivity mutants detected.
- Replay: N/A (server authorization matrix) + mitigation: exhaustive negative matrix, revocation races, before/after heads, and replayed capability state.
- Final heads/digests: directory `0000000000000000_0000000000000033`, state `sha256:c7c084217e335823674a12c85a6fbf70489e5a44e7e78f241715cc41d1eb279e`, stream `sha256:2ba894f82d19523385ea4326ec582b3750fc2cc7790a409833b242287dd14915`; config `0000000000000000_0000000000000002`, state `sha256:6278316567cf8f1cbd10cf03b9557b58bb8f570c750c4a9da00a1382fc135079`, stream `sha256:225e7011f569b35380589561f6986317fb1f90d8f6c16107c033e9f999125c51`; audit head `0000000000000000_0000000000000000`; dispatch head `0000000000000000_0000000000000008`.
- Claim: current durable membership, ownership, and grant state fences every agent-management operation and generic administration capability; cross-scope references, stale revocation decisions, hidden-resource probes, and capability mutants fail closed without source or audit append.

### Critic — 2026-08-06

- Fresh independent `claude-code-subagent` read-only review: `VERDICT: verified`.
- The critic replayed the exact-commit cold proof and confirmed both workspace-admin contexts, the service-principal policy, active agent membership, effective matrix assertions, real canary refusal/redaction, direct read/mutation checks for every capability cell, three failing sensitivity mutants, negative API head preservation, cross-scope/privacy checks, and revocation races.
- No finding refuted the task or its evidence. The critic noted only non-blocking harness boundaries: dispatch authorization is stubbed outside this administration layer, and the effective expectation is derived from the resolver’s actor classes; neither weakens the task’s direct authorization coverage.
- Status: `verified`.
