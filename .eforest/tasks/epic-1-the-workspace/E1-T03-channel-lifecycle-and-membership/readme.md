---
id: E1-T03
epic: 1
title: "Channel lifecycle, membership, and private-read isolation"
priority: 103
status: in-progress
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
