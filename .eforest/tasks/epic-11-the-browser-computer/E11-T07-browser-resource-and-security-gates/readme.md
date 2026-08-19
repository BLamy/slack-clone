---
id: E11-T07
epic: 11
title: Browser resource and security gates
priority: 1107
status: pending
depends_on: [E11-T04, E11-T05, E11-T06]
estimate: L
capstone: false
---

## Goal

Codex and feasibility-proven Claude Code AlmostNode runs are bounded by enforced CPU/time,
memory, storage, output, concurrency, tool, egress, and lifecycle gates, with cross-origin
isolation and fail-closed recovery demonstrated under hostile workloads.

## Context

A browser tab is not a security boundary by assertion. This reach provider must survive
resource exhaustion, worker/service-worker abuse, storage leakage, broker attacks, and
supply-chain/version drift without degrading the Fly production path.

## Deliverables

- Enforced resource budget contract, monitors, terminal classifications, and cleanup.
- Browser origin/worker/storage isolation and pinned asset/package integrity gates.
- Security regression corpus derived from E11-T01's high-risk threats.
- Soak/attack Replay, same-session MP4, resource trace, and canary report.

## Acceptance criteria

- [ ] Each resource limit terminates only the offending run with one typed terminal event,
      fences later effects, cleans capabilities/storage, and leaves another workspace live.
- [ ] Cross-origin isolation, CSP, worker/service-worker scope, storage namespaces, package
      integrity, and broker origin checks are asserted at startup and fail closed on drift.
- [ ] Parallel hostile runs cannot starve control-plane UI, Durable Streams heartbeats,
      cancellation, audit append, or the pinned healthy-run liveness bound.
- [ ] Every high-risk E11-T01 threat has an executed regression or remains an explicit
      blocker; no allowlist exception can be added without a versioned policy event.
- [ ] Final resource/security journeys for both supported harnesses have Replay and
      same-session MP4, zero console errors with terminations rendered as typed states,
      and resource/run/audit offsets and digests equal replay.

## Adversarial verification

1. Exhaust CPU, memory, storage, output, network, workers, and concurrent runs separately
   and together; collateral failure or a surviving post-limit effect refutes containment.
2. Attack CSP/origin, service-worker takeover, cache/storage partitioning, dependency
   integrity, and broker origin checks; one cross-workspace byte or capability is terminal.
3. Kill tabs/workers/network during cleanup and reopen under another principal; residual
   state, authority, or ambiguous run status refutes recovery.
4. Inspect Replay/resource traces and replay event streams; hidden errors, untested high
   threats, canary leakage, or digest mismatch refutes the security gate.

## Verification log
