---
id: E7-T01
epic: 7
title: "Multi-replica scheduling: durable ownership, fenced leases, failover, and exactly-one active run"
priority: 701
status: pending
depends_on: [E6]
estimate: L
capstone: false
---

## Goal

Multiple stateless server replicas consume the durable run queue concurrently while a
stream-backed lease protocol elects exactly one active owner for each invocation. Crash,
partition, restart, and rolling deployment transfer ownership without duplicate sandbox,
harness, tool, or Slack message effects.

## Context

The single-process dispatcher from E3 is not a production scheduler. Durable Streams is
the authority; local locks, process memory, sticky sessions, and clocks are hints only.
Every downstream side effect already accepts the run/lease fence and must reject stale
replicas.

## Deliverables

- Replica/lease events and reducer, queue consumer, heartbeat/failover, and reconciliation
  worker in `packages/scheduler`.
- Deterministic multi-replica simulation with crash and partition control.
- `make verify-E7-T01` with exact side-effect ledgers and replay digests.

## Acceptance criteria

- [ ] `make verify-E7-T01` passes cold and replays every multi-replica fixture twice to an
      identical owner timeline, run state, side-effect set, and digest.
- [ ] For 100 replicas racing one queue proof, exactly one lease is accepted; losers cannot
      create a sandbox, start a harness, use a tool, or publish a message with stale fences.
- [ ] Owner crash before and after each external side effect reconciles from durable events
      and provider idempotency keys, then either resumes the same effect or transfers once.
- [ ] Network partition and delayed heartbeats cannot produce split-brain ownership;
      failover requires a fenced lease transition, not wall-clock expiry alone.
- [ ] Rolling mixed-version replicas respect a declared scheduler protocol range and refuse
      ownership when their version cannot interpret current run events.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (headless distributed
      scheduler) + mitigation: cold-clone replica simulation, exact side-effect ledger,
      partition/failover matrix, replay digests, and stale-fence sensitivity`.

## Adversarial verification

1. Race hundreds of replicas with reordered/delayed lease events and hostile clock skew.
   More than one accepted owner or side effect refutes scheduling.
2. Crash each owner before/after sandbox create, harness start, tool execute, and message
   publish. Logical effects must count exactly once.
3. Partition the former owner while a new owner takes over, then heal it. Every stale write
   from the former owner must be refused.
4. Remove a downstream lease-fence check in a scratch worktree. The duplicate-effect
   fixture must turn `verify-E7-T01` red.

## Verification log
