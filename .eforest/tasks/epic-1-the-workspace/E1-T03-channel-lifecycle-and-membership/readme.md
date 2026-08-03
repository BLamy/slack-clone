---
id: E1-T03
epic: 1
title: "Channel lifecycle, membership, and private-read isolation"
priority: 103
status: implemented
depends_on: [E1-T02]
estimate: L
capstone: false
---

## Goal

Define public, private, and direct-message channels as workspace-scoped event streams with
explicit membership and complete read, write, discovery, and subscription authorization.

## Context

A channel is more than a room name. Its stable ID, kind, display name, archived state, and
membership determine who may learn it exists and who may append or follow its timeline.
Agents use the same membership model as humans. Direct messages have a frozen participant
set contract; service principals do not join conversations.

## Deliverables

- Channel and channel-membership events and reducers for create, rename, archive, unarchive,
  join, invite, leave, remove, and direct-message creation.
- Dispatch and read authorization shared by snapshot, live, projection, and future search
  paths.
- Two-workspace public/private/DM fixtures and per-prefix digests.
- `make verify-E1-T03` cold-clone target and authorization evidence.

## Acceptance criteria

- [ ] `make verify-E1-T03` exits 0 from a cold clone with zero skips and records the complete
      channel
      lifecycle and read/write/subscription matrix.
- [ ] Public, private, and direct-message channels have immutable workspace-scoped IDs and
      deterministic state when replayed from their source events.
- [ ] A private-channel non-member cannot discover its name, membership, history, head,
      event count, live activity, or projection rows through any API.
- [ ] Channel membership is required for message writes and live reads; workspace role alone
      does not bypass a private channel except through an explicit audited admin operation.
- [ ] Archived channels reject new conversation mutations while remaining readable to
      authorized members; unarchive is capability-gated and event-recorded.
- [ ] Direct-message creation canonicalizes the participant set, refuses service principals
      and duplicate equivalent DMs, and prevents participant replacement by rename/update.
- [ ] Replay is declared `Replay: N/A (server channel authorization model) + mitigation:
      cross-channel negative matrix, lifecycle logs, and canonical replay digests`.

## Adversarial verification

1. Probe a known private channel ID as non-member through snapshot, SSE, long-poll, error,
   projection, and timing paths. Any distinguishable metadata refutes private isolation.
2. Remove a member while a live reader and writer are active. Any accepted post-removal
   event or continued delivery after the revocation checkpoint refutes enforcement.
3. Race join/invite/leave/archive operations at the same head. Invalid combined state or two
   accepted conflicting transitions refutes fencing.
4. Construct equivalent DM participant sets in different order and with duplicate IDs. More
   than one logical channel refutes canonicalization.
5. Disable the live-read membership check in a scratch worktree; the verifier must fail.

## Verification log

### Builder — 2026-08-03 — activated after E1-T02 verification

- E1-T02 is verified at `2b8373e222e846bee3c46d1343e4467e473ca67a`; E1-T03 is now the sole
  active queue gate. The implementation will add workspace-scoped public, private, and direct
  message channel events, replayable membership state, and authorization shared by snapshot,
  live, projection, and future search paths, with private-channel metadata refused before any
  source or projection access.

### Builder — 2026-08-03 — implementation complete

- Implementation commit: `12853e5ede77283dd21da04fe1d2e130650e183e` (`E1-T03: implement
  channel lifecycle and private-read authorization`). The implementation adds the versioned
  channel contract and schema, pure lifecycle and membership reducers, deterministic direct
  participant identity, channel-scoped authorization for discovery/read/dispatch/subscription,
  revalidation leases for live delivery, and a per-channel linearizable fence.
- Cold command: `make verify-E1-T03`. The frozen install, `pnpm format:check`, `pnpm lint`,
  `pnpm typecheck`, `pnpm test`, and `pnpm build` all passed with zero skips. The promoted run
  was `PROMOTE_EVIDENCE=1 E1_T03_IMPLEMENTATION_COMMIT=12853e5ede77283dd21da04fe1d2e130650e183e
  TEST_RUN_ID=promoted-e1-t03 node scripts/verify-e1-t03.mjs`.
- The two-workspace fixture replays 29 offsets twice with stable per-prefix digests and final
  digest `sha256:420edca1bcc21849e2949663562afe9904159fc68337d230b9fba8b871ac1d8f`.
  It contains public, private, and direct channels in both workspaces; the direct participant
  sets are canonical and service principals have no channel membership.
- Authorization evidence refuses private name discovery, snapshot, head, event count, history,
  SSE, long-poll, projection, search, and error probes with metadata-free 404s. It also proves
  workspace-role-only refusal, audited admin read, nested sibling-channel binding refusal,
  archived read allowance/write refusal, and a revocation checkpoint where the active live
  reader delivers one pre-revocation item and zero post-revocation items while the writer race
  is fenced.
- Lifecycle evidence refuses cross-tenant IDs, service creators and participants, stale channel
  revisions, duplicate direct participant IDs and equivalent sets, direct participant
  replacement, and archived renames before append. A scratch membership-check mutation is
  accepted by the unsafe module and rejected by the baseline matrix; full tracked-tree binding
  also rejects a post-implementation mutation.
- Evidence: `evidence/e1-t03-final/verification-summary.json`,
  `evidence/e1-t03-final/channel-replay-evidence.json`,
  `evidence/e1-t03-final/private-read-refusal-matrix.json`,
  `evidence/e1-t03-final/revocation-race.json`,
  `evidence/e1-t03-final/lifecycle-refusal-matrix.json`,
  `evidence/e1-t03-final/sensitivity.json`, and
  `evidence/e1-t03-final/offline-replay.json`.
- Claim: public, private, and direct channels now reduce from authoritative workspace-scoped
  events with immutable IDs and deterministic replay; channel membership is required for
  private reads, live subscriptions, and writes; archive state blocks conversation mutations
  while authorized reads remain available; direct participant sets are canonical and immutable;
  and current membership is rechecked under a channel fence before source, projection, or live
  delivery. `Replay: N/A (server channel authorization model) + mitigation: cross-channel
  negative matrix, lifecycle logs, revocation race, sensitivity mutation, and canonical replay
  digests`.

### Critic — 2026-08-03 — direct identity collision refutation

VERDICT: refuted

- A fresh read-only critic reproduced `make verify-E1-T03` and independently confirmed the
  replay digest, private-read matrix, revocation race, and sensitivity detector. It also found
  a blocking direct-message identity defect in `packages/protocol/src/channels.mjs`: the
  `digestToken` loop read only `value[0..25]` from a participant-set key that is longer than
  26 characters. Consequently, `[OWNER_A, MEMBER_A]`, `[OWNER_A, NON_MEMBER_A]`, and
  `[SERVICE_A, NON_MEMBER_A]` all produced the same direct channel ID within Workspace A.
- The collision was not caught by the fixture because it contains only one direct channel per
  workspace, and the reducer's participant-set map only detects equivalent sets after the
  caller has supplied an ID. This refutes deterministic direct-channel identity and can route
  a distinct DM lookup to an unrelated existing channel.
- Required repair: make the deterministic token consume the complete canonical participant-set
  key, add an independent distinct-set regression, regenerate fixture IDs and per-prefix
  digests, and rerun the full cold verifier. The critic also noted two non-blocking consistency
  repairs: channel members should be allowed to discover their private channel, and a creator
  who has left should not retain management authority.

### Builder — 2026-08-03 — direct identity repair started

- The collision finding is accepted. E1-T03 is returned to `in-progress` for a complete-key
  deterministic identity repair and the associated discovery/manager authorization alignment.

### Builder — 2026-08-03 — direct identity repair complete

- Repair commit: `c66871746a5348ac3d94a69676b3455eff546954` (`E1-T03: repair deterministic
  direct-channel identity`). `digestToken` now consumes the complete canonical participant-set
  key before emitting the fixed-width token; distinct valid participant sets in both workspaces
  are independently asserted. Fixture direct IDs and every affected replay digest were
  regenerated. Private-channel members can discover their own channel, and management remains
  capability-gated by active channel membership so a creator who leaves cannot retain authority.
- Cold command: `make verify-E1-T03`. Frozen install, `pnpm format:check`, `pnpm lint`,
  `pnpm typecheck`, `pnpm test`, and `pnpm build` all passed with zero skips. The promoted run
  was `PROMOTE_EVIDENCE=1 E1_T03_IMPLEMENTATION_COMMIT=c66871746a5348ac3d94a69676b3455eff546954
  TEST_RUN_ID=promoted-repair-e1-t03 node scripts/verify-e1-t03.mjs` with
  `implementationTreeCleanAtStart: true`.
- The repaired two-workspace fixture replays 29 offsets twice with stable per-prefix digests and
  final digest `sha256:a600b2a92780597f82ceb56a761d98241a67ebd4fab2476f05440473072d1076`.
  The verifier independently probes alternate participant sets so the prior truncated-key
  collision cannot recur silently.
- The repaired authorization evidence proves private member discovery/read, metadata-free
  non-member refusal across name discovery, snapshot, head, event count, history, SSE,
  long-poll, projection, search, and error paths; workspace-role-only refusal; audited admin
  read; cross-channel binding refusal; archived read allowance/write refusal; and the live
  revocation race. Offline replay, zero credential canaries, and sensitivity mutation detection
  also pass. Replay: N/A (server channel authorization model) + mitigation: cross-channel
  negative matrix, lifecycle logs, revocation race, sensitivity mutation, and canonical replay
  digests.
- Evidence: `evidence/e1-t03-final/verification-summary.json`,
  `evidence/e1-t03-final/channel-replay-evidence.json`,
  `evidence/e1-t03-final/private-read-refusal-matrix.json`,
  `evidence/e1-t03-final/revocation-race.json`,
  `evidence/e1-t03-final/lifecycle-refusal-matrix.json`,
  `evidence/e1-t03-final/sensitivity.json`, and
  `evidence/e1-t03-final/offline-replay.json`.
- Claim: direct-channel IDs are deterministic over the full canonical participant set and
  cannot alias distinct valid DMs; private-channel discovery/read and channel management are
  bound to current channel membership; lifecycle reducers and authorization remain fenced,
  replayable, and tenant-scoped under the repaired implementation.
