---
id: E11-T05
epic: 11
title: Feasibility-gated Claude Code AlmostNode bridge
priority: 1105
status: pending
depends_on: [E11-T03]
estimate: L
capstone: false
---

## Goal

Claude Code receives an AlmostNode bridge only after executable browser probes prove its
real runtime and transport prerequisites; if they do not, the task remains unverified
with a typed unsupported capability rather than substituting a mock, host process, or
different harness.

## Context

Claude Code browser support is not assumed. This reach task cannot weaken the common
harness contract, alter the Cloudflare OS production adapter, or claim parity from protocol-shaped
fixtures. Verification requires the actual Claude Code harness in the browser boundary.

## Deliverables

- Executable prerequisite gate for Claude Code runtime, transport, filesystem, and I/O.
- Conditional real bridge using the common harness/run protocol, if and only if probes pass.
- Stable unsupported reason/capability result when prerequisites fail, with no partial run.
- Real-harness browser corpus, Replay, same-session MP4, and event manifest when supported.

## Acceptance criteria

- [ ] Prerequisite probes execute with host processes and hidden local bridges blocked and
      record exact package/runtime versions and evidence for every required capability.
- [ ] The task can reach implemented/verified only if actual Claude Code executes inside
      AlmostNode; a mock, Codex substitution, API-only imitation, or host Claude process fails.
- [ ] When supported, all emitted events validate against the common harness protocol and
      duplicate/cancel/crash/reconnect cases yield one ordered terminal run.
- [ ] When unsupported, provider discovery and selection return a typed, actionable reason
      before run or credential issuance, and E11-T08 cannot be declared verified.
- [ ] A supported final task/failure/cancel journey has Replay and same-session MP4, zero
      console errors, and run offsets/digests equal independent replay.

## Adversarial verification

1. Block host Claude/Node and every undeclared transport, then inspect processes/network;
   a successful hidden fallback is direct refutation.
2. Replace real Claude execution with protocol-perfect fixtures; any gate that remains
   green refutes harness authenticity sensitivity.
3. Remove one prerequisite after discovery but before run; partial execution, credential
   issuance, or a generic crash refutes fail-closed selection.
4. If supported, attack event order, cancellation, policy escape, Replay correlation, and
   console tripwires exactly as for Codex; asymmetric weakening refutes parity readiness.

## Verification log
