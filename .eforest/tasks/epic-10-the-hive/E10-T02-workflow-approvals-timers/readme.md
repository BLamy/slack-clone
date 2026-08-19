---
id: E10-T02
epic: 10
title: Workflow approvals and timers
priority: 1002
status: pending
depends_on: [E10-T01]
estimate: L
capstone: false
---

## Goal

Workflows can durably wait for scoped human approval or a recorded deadline and resume
exactly once after restart, denial, expiry, cancellation, or the winning timer event.

## Context

Wall-clock sleeps and in-memory callbacks are forbidden. Time enters as a durable,
testable event, and approvals bind to the exact workflow instance, step, action, and
revision they authorize.

## Deliverables

- Waiting-step, approval-request/decision, deadline, cancellation, and resume schemas.
- Durable timer scheduler with claim leases, deterministic clock adapter, and recovery.
- Approval capability checks, expiry, reminders, and conflict semantics.
- Restart/race/skew/replay verification harness.
- Browser wait/approve/expire journey with Replay and same-session MP4 evidence.

## Acceptance criteria

- [ ] Killing all workers during a wait and restarting after the deadline yields one
      terminal timer outcome and one resume/expiry command, with no in-memory dependency.
- [ ] Approve, deny, cancel, and deadline races have one fenced winner; losing requests
      return typed conflicts and cannot append a second effective decision.
- [ ] Approval is bound to workspace, workflow instance/revision, step, action digest,
      approver capability, and expiry and cannot be replayed against another target.
- [ ] Replaying with the recorded clock/deadline events yields the exact transition order
      and digest without consulting current wall time.
- [ ] Refused, expired, and cancelled steps issue no credential, tool, message, or agent-run
      side effect beyond their redacted audit events.
- [ ] The final browser journey shows waiting, one approval and one expiry with a cited
      Replay and same-session MP4, zero console errors, and workflow/timer/audit offsets
      and digests equal to independent replay.

## Adversarial verification

1. Race decisions and timers on either side of expiry with skewed workers; two winners or
   an unrecorded wall-clock choice refutes determinism.
2. Replay a signed approval after action, revision, target, or approver capability changes;
   acceptance refutes scope binding.
3. Crash between claim, decision append, command enqueue, and acknowledgement; a lost or
   duplicate resume refutes recovery.
4. Replay in a process with a deliberately wrong system clock; changed output refutes the
   recorded-time contract.
5. Inspect Replay/MP4 transition timing and correlate it to recorded deadline and decision
   events; staged state, cross-session media, or console errors refute proof.

## Verification log
