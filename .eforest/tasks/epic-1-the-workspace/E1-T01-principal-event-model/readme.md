---
id: E1-T01
epic: 1
title: "First-class human, agent, and service principal event model"
priority: 101
status: implemented
depends_on: [E0]
estimate: M
capstone: false
---

## Goal

Define the durable identity contract for humans, agents, and internal services so all three
can be addressed consistently while retaining distinct authentication, ownership, and
authorization boundaries.

## Context

Current messages persist a display name and email but no stable actor ID. An agent must look
and participate like a normal workspace member without becoming a human impersonation
mechanism. `ownedBy` records who manages an agent; it does not inherit the owner's roles or
let the agent present the owner's subject. Service principals exist for narrowly scoped
workers and never appear as chat authors.

Authentication subjects and profile fields are separate. The server derives the principal
from verified authentication and stamps it on dispatch; clients cannot select an actor in
an event body.

## Deliverables

- Versioned principal events and pure reducer for create, profile update, suspend, and
  deactivate transitions across `human`, `agent`, and `service` kinds.
- Stable subject-binding and agent-owner reference schemas with typed refusal reasons.
- Golden identity logs, authorization fixtures, and canonical state digests.
- `make verify-E1-T01` cold-clone target and evidence.

## Acceptance criteria

- [ ] `make verify-E1-T01` exits 0 from a cold clone and replays every identity fixture twice
      to the same
      pinned per-prefix and final digests.
- [ ] Human, agent, and service principals have globally unambiguous immutable IDs and
      explicit kinds; profile names, handles, and emails are mutable non-authority fields.
- [ ] The dispatch door ignores or rejects a client-supplied actor ID and stamps the
      authenticated principal; an agent credential can never produce a human-authored event.
- [ ] An agent's `ownedBy` reference grants no implicit workspace, channel, connection, or
      secret permission and cannot cross a workspace boundary.
- [ ] Suspended or deactivated principals cannot create new mutations while historical
      events retain their original actor attribution.
- [ ] Principal fixtures and evidence contain no access token, password, session cookie, or
      provider credential, verified by canary scanning.
- [ ] Replay is declared `Replay: N/A (server identity event model) + mitigation: golden
      logs, impersonation refusal matrix, canary scan, and deterministic reducer digests`.

## Adversarial verification

1. Submit events with another human, owned agent, service, and sibling-workspace actor ID.
   Any accepted spoof refutes server-derived identity.
2. Change profile handle and email, then replay old messages. Attribution drift or ID reuse
   refutes stable identity.
3. Reuse an agent credential after owner role escalation, suspension, transfer, and
   deactivation. Any inherited or stale privilege refutes separation.
4. Mutate principal kind and owner references in golden logs. Silent transition or unchanged
   digest refutes schema sensitivity.
5. Remove the authenticated-subject match in a scratch worktree; the negative matrix must
   fail.

## Verification log

### Builder — 2026-08-03 — activated after E0-T07 verification

- E0-T07 is verified at `7cf528d`; E1-T01 is now the sole active queue gate. The
implementation will add the versioned principal event model, subject/owner binding
contracts, server-derived actor stamping, pure replay fixtures, and canary evidence
without introducing workspace membership semantics ahead of E1-T02.

### Builder — 2026-08-02 — implementation complete

- Implementation commits: `5836397` (`E1-T01: add principal event model and auth stamping`),
  `fbb0ba9` (`E1-T01: keep principal protocol pure`), and `39095c6`
  (`E1-T01: fence principal authorization through append`). The final implementation
  commit is `39095c6dc3a7e04bab7b1bf13068826fdaf0e7a0`.
- Cold command: `PROMOTE_EVIDENCE=1 E1_T01_IMPLEMENTATION_COMMIT=39095c6dc3a7e04bab7b1bf13068826fdaf0e7a0 TEST_RUN_ID=e1-t01-final-39095 make verify-E1-T01`.
  `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`
  all passed; the build emitted 41 files. The full test gate passed 77 unit tests and
  five Playwright tests.
- Principal directory evidence contains 9 offsets through
  `0000000000000000_0000000000000009` and final digest
  `sha256:1069cdf0c97b7f1456a5b2cbcd2846d790723610f8832cb250e99fe6323181e8`.
  Lifecycle evidence contains 4 offsets through
  `0000000000000001_0000000000000004` and final digest
  `sha256:a83a8deaa47c05b59da9087e63326059d21b7457ad7b71a04caf5772303447bb`.
  Pinned per-prefix digests are in `fixtures/manifest.json` and the promoted replay
  manifest is in `evidence/e1-t01-final/principal-replay-evidence.json`.
- Dispatch evidence proves authenticated human and agent stamping, client actor and
  payload spoof refusal, sibling-workspace refusal, subject mismatch, suspended and
  deactivated refusal, and fail-closed `PRINCIPAL_FENCE_REQUIRED` when no linearizable
  lifecycle fence is supplied. All refused target heads remained unchanged. Principal
  tamper cases were rejected at their cited offsets; offline replay ran with network and
  query-store paths disabled; canary scan found zero credential-shaped values.
- Evidence: `evidence/e1-t01-final/verification-summary.json`,
  `evidence/e1-t01-final/dispatch-refusal-matrix.json`,
  `evidence/e1-t01-final/sensitivity.json`, and
  `evidence/e1-t01-final/offline-replay.json`.
- Claim: versioned human, agent, and service principal events now reduce deterministically;
  immutable workspace-scoped IDs remain separate from mutable profiles; owner references
  grant no implicit permissions; authenticated dispatch is server-stamped and fenced
  through append; suspended or deactivated principals cannot create mutations.
  `Replay: N/A (server identity event model) + mitigation: golden logs, impersonation refusal matrix, canary scan, and deterministic reducer digests`.
