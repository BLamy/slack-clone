---
id: E4-T07
epic: 4
title: "Sandbox quotas, cost accounting, and orphan garbage collection from provider-observed reality"
priority: 407
status: pending
depends_on: [E4-T04, E4-T06]
estimate: L
capstone: false
---

## Goal

The server enforces tenant, workspace, agent, and run limits before provider allocation,
records provider-observed resource usage as replayable cost events, and reconciles labeled
Fly resources so expired or unowned Sprites are destroyed without touching live work.

## Context

Remote sandboxes can outlive a crashed scheduler and become both a bill and a security
liability. Queue counters alone are not authoritative, so garbage collection compares
durable leases with a scoped provider inventory and requires repeated absence proof before
destructive action.

## Deliverables

- Quota/reservation and usage/cost event reducers in `packages/sandbox`.
- Fly inventory reconciler, orphan quarantine, grace period, and idempotent GC worker.
- `make verify-E4-T07` with crash, clock, quota-race, and false-orphan fixtures.

## Acceptance criteria

- [ ] `make verify-E4-T07` passes cold and replays shuffled duplicate usage reports to one
      canonical reservation, usage, cost, and GC digest.
- [ ] Atomic reservations prevent concurrent creates from exceeding configured sandbox,
      CPU, memory, storage, duration, and spend ceilings; losing requests call no provider.
- [ ] Cost records cite provider resource id, metering window, measured units, pricing
      version, tenant/run, and source observation; duplicate provider reports count once.
- [ ] Reconciliation is restricted to resources carrying the deployment's ownership
      labels. An apparent orphan is quarantined for a stated grace period and rechecked
      against current leases before destroy.
- [ ] Scheduler crash, delayed heartbeat, wall-clock rollback, and provider pagination
      cannot delete a live sandbox or leave an expired one indefinitely in the fixture.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (server quota and GC worker)
      + mitigation: cold-clone race/replay fixtures, provider inventory transcripts,
      exact cost digests, and deletion sensitivity`.

## Adversarial verification

1. Race reservations at every limit and duplicate/reorder usage windows. Any over-allocation
   or double charge refutes accounting.
2. Present live, expired, foreign-deployment, unlabeled, and partially labeled resources
   across paginated inventory. Only confirmed owned orphans may be deleted.
3. Freeze, jump, and roll back clocks while heartbeats arrive late. Safety must use
   monotonic/fenced evidence rather than a single wall-clock comparison.
4. Remove the second orphan check in a scratch worktree. The false-orphan fixture must
   fail before a destroy call.

## Verification log
