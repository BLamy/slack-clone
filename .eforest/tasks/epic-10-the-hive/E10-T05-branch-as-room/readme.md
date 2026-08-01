---
id: E10-T05
epic: 10
title: Branch as room
priority: 1005
status: pending
depends_on: [E10-T04]
estimate: L
capstone: false
---

## Goal

An authorized Electric Forest branch has one linked conversation room where humans and
agents discuss work while live task, run, verdict, evidence, and branch state appear as
typed system references rather than copied mutable text.

## Context

A branch room joins collaboration to project truth without merging their authorities.
Room messages remain room events; project cards resolve source references at explicit
offsets and all commands cross the adapter's authorization boundary.

## Deliverables

- Idempotent branch-room link lifecycle and authorized deep links.
- Live project cards for task/run/verdict/evidence/head state with source correlation.
- Room commands that invoke supported project-adapter actions with confirmation/approval.
- Multi-session browser, Replay, MP4, reconnect, and deletion/archive tests.

## Acceptance criteria

- [ ] One branch maps to at most one active room per workspace, and duplicate creation or
      adapter redelivery cannot fork the link.
- [ ] Each project card exposes source project/stream/offset/digest and independently
      resolving that source boundary yields the exact displayed state.
- [ ] Room membership does not imply project mutation authority; unauthorized commands
      are leak-neutral and append neither project command nor optimistic success state.
- [ ] Source updates arrive live without reload, preserve room message order, and archive
      or revoke the room according to the frozen branch lifecycle policy.
- [ ] The final branch-room lifecycle and live-update journey has Replay plus same-session
      MP4, zero console errors, and room/source offsets and digests matching replay.

## Adversarial verification

1. Race room creation from two sessions and redeliver branch events; two active links or
   divergent room digests refute uniqueness.
2. Forge project cards and command ids in browser/API traffic; displayed unresolvable state
   or accepted unauthorized mutation refutes the reference boundary.
3. Revoke source or room access while open; stale cards/commands after the causal event
   reaches head refute live authorization.
4. Correlate every Replay card to independently fetched source bytes; mismatch, reload,
   or hidden console errors refute the browser story.

## Verification log
