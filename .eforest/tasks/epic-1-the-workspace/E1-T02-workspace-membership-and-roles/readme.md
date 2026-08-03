---
id: E1-T02
epic: 1
title: "Workspace membership, roles, and tenant boundary"
priority: 102
status: refuted
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

### Builder — 2026-08-03 — activated after E1-T01 verification

- E1-T01 is verified at `881a620`; E1-T02 is now the sole active queue gate. The
  implementation will keep workspace context derived from trusted authentication and
  routing, add append-only membership and role-capability events, and prove cross-tenant
  refusal before any stream append or subscription registration.

### Builder — 2026-08-03 — implementation complete

- Implementation commit: `09c41946b503da15d73bfd4f4f3283f847e0f483` (`E1-T02: add
  workspace membership tenancy gate`). The implementation adds the versioned workspace and
  membership event schema, pure replay reducers, explicit role capabilities, immutable
  trusted workspace context, and a workspace-scoped authorization fence.
- Cold command: `PROMOTE_EVIDENCE=1 E1_T02_IMPLEMENTATION_COMMIT=09c41946b503da15d73bfd4f4f3283f847e0f483 TEST_RUN_ID=e1-t02-final-20260803 make verify-E1-T02`.
  Frozen install, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
  `pnpm build` all passed. The full test gate passed 82 tests, including five Playwright
  tests; the build emitted 44 files.
- The two-workspace fixture replays 13 offsets twice with stable prefixes and final digest
  `sha256:b89894bc917a4d355b9582cd40cce01cbcf81c519c405bbda83df4a5ae62432d`.
  Workspace A ends at revision 4 with an active admin member; Workspace B ends at revision 5
  with its member removed while its owner remains active.
- Authorization evidence covers owner/admin/member/guest/agent/service capability decisions,
  non-member and sibling-workspace read/mutation/subscription refusals, nested and hinted
  workspace-ID overrides, no-fence refusal, before/after target-head checks, replay-derived
  membership authorization after projection deletion, and a workspace-wide revocation race.
  Lifecycle evidence refuses duplicate membership, invite-subject mismatch, stale workspace
  and membership versions, self-escalation, last-owner suspension, cross-tenant IDs, role-kind
  mismatch, and bootstrap actor mismatch before append.
- Evidence: `evidence/e1-t02-final/verification-summary.json`,
  `evidence/e1-t02-final/workspace-replay-evidence.json`,
  `evidence/e1-t02-final/tenant-refusal-matrix.json`,
  `evidence/e1-t02-final/lifecycle-refusal-matrix.json`,
  `evidence/e1-t02-final/sensitivity.json`, and
  `evidence/e1-t02-final/offline-replay.json`.
- Claim: workspace membership and role state now lives in append-only events with deterministic
  replay; trusted immutable workspace context is established before handler input; capabilities
  are explicit and tenant-bound; invite/accept/role/suspend/remove operations enforce principal
  kind, revision, duplicate, invite-subject, and last-owner constraints; every new read,
  mutation, and subscription rechecks current membership under one workspace fence. `Replay:
  N/A (server tenancy and RBAC contract) + mitigation: two-workspace negative matrix,
  before/after dumps, and deterministic membership replay`.

### Critic — 2026-08-03 — live handler refutation

VERDICT: refuted

- Fresh managed critic `Parfit` audited commit `c6e81f1` and the promoted evidence without
  modifying the checkout. The focused verifier passed, but the live HTTP boundary was not
  wired to the new authorization middleware: `src/server.mjs:225` still authorized only by
  session presence, while `packages/http/src/index.mjs:264-337` called message reads,
  subscriptions, mutations, and resets directly. An independent handler probe observed a
  non-member receiving `200/201/200/200` with `membershipLookupCalls: 0`.
- The same probe found that `bindWorkspaceRequest` only rejected exact `workspaceId` keys;
  sibling principal IDs, `workspace:ws_...` streams, and raw `x-workspace-id` headers could
  pass through. This refutes the live tenant boundary even though the unit and replay-only
  matrices were green.
- Required repair: establish trusted workspace context at the live HTTP entrypoint, route all
  chat reads/subscriptions/mutations/resets through the workspace authorization fence, bind
  headers/query/path/body hints before handler input is used, and add handler-level negative
  evidence with unchanged target heads. The implementation is returned to `in-progress` after
  this verdict is recorded.

### Builder — 2026-08-03 — live boundary repair implemented

- Implementation commit: `f047dece639da3a54c509cbcb3140aaeb04a4747` (`E1-T02: wire live
  workspace authorization`). The live server now maps authenticated Auth0 subjects to
  workspace-scoped principals, replays the canonical workspace directory from Durable Streams,
  retries transient directory startup failures, and routes message reads, SSE subscriptions,
  appends, edits, and resets through a workspace-scoped membership fence.
- Cold command: `PROMOTE_EVIDENCE=1 E1_T02_IMPLEMENTATION_COMMIT=f047dece639da3a54c509cbcb3140aaeb04a4747 TEST_RUN_ID=e1-t02-repair-final-20260803 make verify-E1-T02`.
  Frozen install, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
  `pnpm build` all passed; the full test gate passed 86 unit tests and five Playwright tests.
- The replay fixture remains byte-stable across 13 offsets with final digest
  `sha256:b89894bc917a4d355b9582cd40cce01cbcf81c519c405bbda83df4a5ae62432d`. The live handler
  matrix records current-member read/mutation allows plus generic refusals for non-member read,
  subscription, mutation, reset, sibling principal path, sibling workspace header/body, and
  sibling workspace stream probes; all refused service callbacks and target heads remain
  unchanged.
- Evidence: `evidence/e1-t02-final/verification-summary.json`,
  `evidence/e1-t02-final/live-handler-refusal-matrix.json`,
  `evidence/e1-t02-final/workspace-replay-evidence.json`,
  `evidence/e1-t02-final/tenant-refusal-matrix.json`,
  `evidence/e1-t02-final/lifecycle-refusal-matrix.json`,
  `evidence/e1-t02-final/sensitivity.json`, and
  `evidence/e1-t02-final/offline-replay.json`.
- Claim: the live HTTP boundary now establishes trusted tenant context before room/input
  handling, revalidates current membership for every read, mutation, and subscription, rejects
  sibling scoped identifiers and workspace streams in alternate request fields, preserves the
  seeded two-user demo, and remains replay-authoritative after projection deletion. `Replay: N/A
  (server tenancy and RBAC contract) + mitigation: two-workspace negative matrix, live handler
  refusal matrix, before/after heads, and deterministic membership replay`.

### Critic — 2026-08-03 — evidence and subject-binding refutation

VERDICT: refuted

- Fresh managed critic `Feynman` audited implementation commit
  `f047dece639da3a54c509cbcb3140aaeb04a4747` and the promoted evidence without modifying the
  checkout. Functional checks passed, including the live handler matrix, full 86-test and five
  Playwright gates, replay digest, projection deletion, lifecycle refusals, revocation race, and
  verifier sensitivity.
- Blocking finding: `scripts/verify-e1-t02.mjs:43-54` only checked that
  `E1_T02_IMPLEMENTATION_COMMIT` matched a 40-hex shape. The critic supplied an all-zero commit
  value and still obtained `result: PASS`, so the promoted evidence was not cryptographically
  bound to an existing implementation commit or its exact tree.
- Blocking finding: `src/server.mjs:145-151` fell back from the authoritative Auth0 subject to
  mutable `email` and `preferredUsername` values. A different authenticated subject carrying
  Ada's email or nickname could therefore be mapped to Ada's workspace principal.
- Required repair: resolve and validate the implementation commit object as an ancestor with no
  changes to the implementation file set, and map authenticated users only by the exact subject
  binding replayed from the workspace directory. The arbitrary forged-subject emulator attack was
  not available, so the mapping finding is source-level. `Replay: N/A (server tenancy and RBAC
  contract) + mitigation: deterministic replay, live negative matrix, and source-level subject
  binding audit`.

### Builder — 2026-08-03 — exact evidence and subject repair started

- The critic's two findings are accepted. This repair will make promoted evidence fail closed for
  nonexistent or non-ancestor implementation commits and remove email/nickname authorization
  fallbacks so only the exact replayed Auth0 subject binding can establish workspace identity.

### Builder — 2026-08-03 — repair started after live handler refutation

- The fresh critic's live-path finding is accepted. This repair wires the existing HTTP delivery
  to a trusted workspace context and linearizable membership authorization, preserves the
  working demo's seeded users, and expands scoped-value binding so sibling identifiers and
  workspace streams cannot cross the boundary through alternate field or header names.

### Builder — 2026-08-03 — subject authority and evidence binding repaired

- Implementation commit: `579a97f313b3d6cd99c1e759cbe26b6c4f39a3a5` (`E1-T02: bind login to
  replayed subject authority`). Login now resolves the authenticated principal only by the exact
  issuer/audience/subject binding replayed from the Durable Streams workspace directory; profile
  email and nickname values are not authorization inputs. The evidence verifier now requires the
  claimed implementation commit to resolve exactly, be an ancestor of the checkout, and have no
  later changes to the implementation file set.
- Cold command:
  `PROMOTE_EVIDENCE=1 E1_T02_IMPLEMENTATION_COMMIT=579a97f313b3d6cd99c1e759cbe26b6c4f39a3a5 TEST_RUN_ID=e1-t02-subject-authority-final-20260803 make verify-E1-T02`.
  Frozen install, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
  `pnpm build` all passed; the full test gate passed 86 unit tests and five Playwright tests.
- The replay fixture remains byte-stable across 13 offsets with final digest
  `sha256:b89894bc917a4d355b9582cd40cce01cbcf81c519c405bbda83df4a5ae62432d`. The promoted
  summary records 14 deterministic authorization refusals, eight live-handler refusals, unchanged
  refused heads, projection deletion with replay-derived authorization, and a sensitivity run that
  goes red when trusted workspace comparison is disabled.
- Evidence: `evidence/e1-t02-final/verification-summary.json`,
  `evidence/e1-t02-final/live-handler-refusal-matrix.json`,
  `evidence/e1-t02-final/workspace-replay-evidence.json`,
  `evidence/e1-t02-final/tenant-refusal-matrix.json`,
  `evidence/e1-t02-final/lifecycle-refusal-matrix.json`,
  `evidence/e1-t02-final/sensitivity.json`, and
  `evidence/e1-t02-final/offline-replay.json`.
- Claim: the live boundary establishes trusted tenant context before handler input, rechecks
  replayed membership for every chat capability, rejects sibling identifiers and streams across
  request fields, resolves login identity from authoritative subject bindings only, binds evidence
  to the exact implementation tree, and preserves the seeded two-user demo. `Replay: N/A (server
  tenancy and RBAC contract) + mitigation: two-workspace negative matrix, live handler refusal
  matrix, before/after heads, and deterministic membership replay`.

### Critic — 2026-08-03 — incomplete exact-tree binding refutation

VERDICT: refuted

- Fresh managed critic `Ramanujan` audited implementation commit
  `579a97f313b3d6cd99c1e759cbe26b6c4f39a3a5` and promoted metadata commit `a4a716d`. The cold
  verifier exited 0, the 86 unit and five Playwright gates passed, and all-zero and non-ancestor
  commit controls exited 1.
- Blocking finding: `scripts/verify-e1-t02.mjs:55-64` binds only eight named implementation paths.
  Identity and replay behavior also depends on omitted files such as `src/auth0-client.mjs`,
  `packages/protocol/src/principals.mjs`, reducer modules, and replay code. The comparison at
  `scripts/verify-e1-t02.mjs:1218-1228` would therefore allow a later change to one of those files
  while still accepting evidence for the older implementation commit.
- The current `579a97f..a4a716d` range contains only task metadata and evidence, so the finding is a
  detector-coverage defect rather than evidence of a current product regression. The ticket is
  returned to `in-progress` after this verdict is recorded. `Replay: N/A (server tenancy and RBAC
  contract) + mitigation: deterministic replay, live negative matrix, and exact-tree binding audit`.
