---
id: E8-T06
epic: 8
title: Run controls and approvals
priority: 806
status: pending
depends_on: [E8-T05]
estimate: L
capstone: false
---

## Goal

Authorized people can cancel, retry, approve, or deny an agent run from the room through
idempotent, capability-checked commands whose decisions are durable and race-safe.

## Context

Controls are security doors, not cosmetic buttons. Approval scope, actor, expiry, run
revision, and single-use semantics must be enforced by the server and visible in audit
events without exposing credentials.

## Deliverables

- Capability-aware controls and typed refusal/conflict states.
- Durable approval request/decision schema with expiry, scope, and fencing.
- Cancel/retry linkage and lineage UI.
- Race, replay, and multi-role browser verification.

## Acceptance criteria

- [ ] Buttons appear only for currently legal actions, while direct unauthorized API
      calls receive leak-neutral refusals and append no command or decision event.
- [ ] Repeated approve/deny/cancel/retry requests with one idempotency key produce one
      durable command; conflicting decisions yield one winner and a typed conflict.
- [ ] An approval is bound to exact run, attempt, requested capability, and expiry and
      cannot authorize a retried or mutated request.
- [ ] Two browser roles observe decision and terminal state live with exposed run/audit
      offsets and digests equal to independent replay.
- [ ] The final approval, cancellation, and retry walkthrough has a cited Replay and an
      MP4 from the same session with zero console/page/network errors.

## Adversarial verification

1. Race approve versus deny and cancel versus completion from separate sessions; two
   winners or an impossible state refutes fencing.
2. Replay an approval against another attempt, capability, or expired request; accepted
   reuse refutes scope binding.
3. Invoke hidden controls directly as member, agent, removed approver, and cross-tenant
   user; any unauthorized append is a security finding.
4. Compare UI lineage and audit decisions with raw events at their displayed offsets;
   missing commands, digest drift, or console errors refute the proof.

## Verification log
