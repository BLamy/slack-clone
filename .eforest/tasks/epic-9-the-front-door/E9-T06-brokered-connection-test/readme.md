---
id: E9-T06
epic: 9
title: Brokered connection test
priority: 906
status: pending
depends_on: [E9-T05]
estimate: M
capstone: false
---

## Goal

An administrator can run a bounded, non-destructive service connection test inside the
selected sandbox using the same policy and Infisical Agent Proxy path as production,
receiving only a sanitized result and durable audit trail.

## Context

Control-plane validation alone cannot prove runtime connectivity. The test must exercise
real brokerage and egress without becoming an arbitrary command runner or secret oracle.

## Deliverables

- Catalog-defined connection-test contract and sandbox execution path.
- One-time test capability, timeout/resource limits, cancellation, and sanitized result.
- Connection-test UI with progress, typed remediation, and audit link.
- Success/failure/leak/race browser evidence.

## Acceptance criteria

- [ ] Only catalog-declared, policy-allowed test operations run; callers cannot supply a
      command, endpoint, environment variable, tool, or secret slot outside the revision.
- [ ] Each test uses one attempt-bound proxy capability, sandbox identity, timeout, and
      resource budget and revokes access at terminal state or cancellation.
- [ ] Results expose typed reachability/auth/scope status and bounded diagnostics only;
      secret canaries, credential length, response bodies, and sensitive headers are absent.
- [ ] Duplicate clicks, refreshes, and request replay resolve to one test attempt; a new
      test creates explicit lineage rather than reusing an expired capability.
- [ ] The final success/failure/cancel journey has cited Replay and same-session MP4,
      zero console errors, and test/audit offsets and digests equal independent replay.

## Adversarial verification

1. Alter command, endpoint, DNS result, redirect, slot, and tool after preview; any
   undeclared execution or egress refutes catalog pinning.
2. Cancel and kill the browser/sandbox at every phase; a surviving capability or orphaned
   test with ambiguous state refutes cleanup.
3. Return canaries in every error/output channel and vary secret lengths; leaked content
   or an oracle-quality distinction refutes sanitization.
4. Correlate Replay status to sandbox, proxy, and audit events by attempt and offset;
   staged UI, duplicate attempts, or digest mismatch refutes proof.

## Verification log
