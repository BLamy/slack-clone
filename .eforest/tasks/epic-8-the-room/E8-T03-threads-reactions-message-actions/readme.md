---
id: E8-T03
epic: 8
title: Threads, reactions, and message actions
priority: 803
status: pending
depends_on: [E8-T02]
estimate: L
capstone: false
---

## Goal

Authorized room members can open threads, react, edit, and delete through typed,
append-only message events that converge to the same projection in every session.

## Context

The prototype already treats edits as later records, but it has no versioned action
contract, conflict rule, thread model, or idempotency guarantee. This task freezes those
semantics without granting agents special message privileges.

## Deliverables

- Typed thread, reaction, edit, and delete event schemas and reducers.
- Server authorization/idempotency doors and convergent room/thread projections.
- Accessible message menus, thread panel, reaction controls, and conflict feedback.
- Multi-session browser and replay evidence.

## Acceptance criteria

- [ ] Replaying the same event log twice yields byte-identical room and thread digests;
      duplicate idempotency keys do not duplicate reactions or mutations.
- [ ] Only the message author or an explicitly authorized moderator can edit/delete;
      refused actions append nothing and do not reveal hidden message state.
- [ ] Two sessions observe thread replies, reaction toggles, edits, and deletes in event
      order without reload, and both exposed offsets/digests equal independent replay.
- [ ] Concurrent edits resolve by the frozen version/fencing rule and return a typed
      conflict rather than silently losing an accepted write.
- [ ] The final multi-session action walkthrough has a cited Replay recording and an MP4
      from the same session, with zero console/page/network errors.

## Adversarial verification

1. Replay and reorder duplicate reaction/edit requests; any duplicate projection or
   non-deterministic digest refutes convergence.
2. Attempt each action as another member, a removed member, an agent, and a moderator;
   any privilege inferred from principal type rather than grants is a finding.
3. Race two edits against the same version and kill one client before acknowledgement;
   two accepted incompatible results or an untyped loss refutes fencing.
4. Correlate both recorded browser projections to the raw log; a staged UI update,
   reload, or hidden console error refutes live behavior.

## Verification log
