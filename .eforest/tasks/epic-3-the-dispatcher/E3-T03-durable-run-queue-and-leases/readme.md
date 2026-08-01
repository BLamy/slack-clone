---
id: E3-T03
epic: 3
title: "Durable run queue, fenced worker leases, and scoped capabilities"
priority: 303
status: pending
depends_on: [E3-T01, E3-T02]
estimate: L
capstone: false
---

## Goal

Project eligible invocations into a deterministic queue and let workers atomically acquire,
heartbeat, release, expire, and supersede leases whose fencing generation scopes every later
run mutation.

## Context

A lease is scheduling coordination, not permission by itself. Acquisition validates the
current invocation state, immutable snapshot, agent lifecycle, queue proof, and concurrency
policy. The issued run capability binds workspace, agent, invocation, attempt, lease
generation, and allowed endpoints. Expiry may make work eligible again, but the incremented
fence ensures a slow or partitioned old worker can never resume mutations.

Queue order is a replayable projection with stable priority and tie-breaking. A missing or
rebuildable projection cannot invent work that the invocation streams do not contain.

## Deliverables

- Queue projection/rebuild logic and canonical eligibility proof.
- Lease and heartbeat events, fencing-generation reducer, and run-scoped capability format.
- Multi-worker race, expiry, partition, revocation, and queue-rebuild harnesses.
- `make verify-E3-T03` cold-clone target and lease evidence.

## Acceptance criteria

- [ ] `make verify-E3-T03` exits 0 from a cold clone and records queue proofs, lease generations,
      capability scopes, race results, and final run digests.
- [ ] Rebuilding the queue from invocation/run streams produces identical eligible ordering
      and digest without a job database or worker registry as hidden authority.
- [ ] One hundred workers racing one queue proof yield exactly one accepted lease generation;
      all losers receive typed refusals and cannot append run events.
- [ ] Every worker mutation validates the current lease generation and scoped capability;
      lease loss, supersession, agent revoke, or workspace suspension fences the next write.
- [ ] Expired/partitioned work can be reacquired under a higher generation while the stale
      worker's late heartbeat, result, reply, and release are all refused.
- [ ] Capabilities are short-lived, least-privileged opaque values; run streams and evidence
      store only redacted IDs/digests, never the bearer value.
- [ ] Replay is declared `Replay: N/A (server queue and lease protocol) + mitigation:
      hundred-worker race, partition/supersession schedules, queue rebuild, and stream digests`.

## Adversarial verification

1. Race acquire, heartbeat, expiry, supersession, cancel, and terminal append with randomized
   delays. Two live generations or one stale mutation refutes fencing.
2. Replay a captured capability against another run, attempt, agent, endpoint, workspace,
   generation, and post-expiry time. Any accepted use refutes scope.
3. Delete and rebuild the queue during active writes. Lost, duplicated, or differently
   ordered eligible work refutes projection determinism.
4. Partition the winner past expiry, let a second worker complete, then release the first.
   Any state change from the first refutes stale-worker quarantine.
5. Disable generation checking in a scratch worktree; the partition harness must fail.

## Verification log
