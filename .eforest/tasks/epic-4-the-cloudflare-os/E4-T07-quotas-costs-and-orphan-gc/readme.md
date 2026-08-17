---
id: E4-T07
epic: 4
title: "Sandbox quotas, cost accounting, and orphan garbage collection from provider-observed reality"
priority: 407
status: implemented
depends_on: [E4-T04, E4-T06]
estimate: L
capstone: false
---

## Goal

The server enforces tenant, workspace, agent, and run limits before provider allocation,
records provider-observed resource usage as replayable cost events, and reconciles labeled
Cloudflare OS workspaces/Gadgets so expired or unowned resources are destroyed without
touching live work.

## Context

Cloudflare OS workspaces can outlive a crashed scheduler and become both a bill and a
security liability. Queue counters alone are not authoritative, so garbage collection
compares durable leases with a scoped provider inventory and requires repeated absence
proof before destructive action.

## Deliverables

- Quota/reservation and usage/cost event reducers in `packages/sandbox`.
- Cloudflare OS workspace/Gadget inventory reconciler, orphan quarantine, grace period, and
  idempotent GC worker.
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

### Builder — 2026-08-17

- Commit: a536b9edda876e7d6879d5fffc3f72c5c3f48a03
- Cold run: make verify-E4-T07, TEST_RUN_ID=e4-t07-cold-final-20260817; detached tracked checkout with exact implementation commit.
- Evidence: .artifacts/e4-t07/e4-t07-cold-final-20260817/{quota-reservation,usage-cost,gc-inventory,deletion-sensitivity,verification-summary,cold-verification-transcript}.json.
- Digests: quota/event and shuffled replay sha256:ba6fe0ed245300d859aab8974af63553b60f0efd4ad8812be6faf3cd00b1be4e; GC sha256:62f62e9c8037b5a9af0bd6f1dd8cfbea88d1f6db2f7fc0ea43930727338ed093; reservation races sha256:3e50f5cc4092060ec2d24758e3c9e96f0503fceac232177440a1f3b9729e65ca; deletion sensitivity sha256:dc81cc5104b23ebd87e885f5b0ae320d2ec92d9bb95ae43182ceb094da34f0fa.
- Reservation evidence: all six dimensions admitted one and rejected one under concurrent attempts; provider calls were 6, with no call for rejected reservations. Duplicate usage observations produced two cost records and one canonical spend total.
- GC evidence: 19 paginated provider pages; exact deployment/tenant/workspace/agent ownership filtering preserved live, foreign, partial, and unlabeled resources; owned orphans were destroyed with expected fences; accepted-timeout cleanup reconciled; delayed heartbeat, monotonic clock rollback, and crash checkpoint were exercised.
- Sensitivity: the disposable mutation that removed the second lease check exited 1, proving the false-orphan detector turns red.
- Gates: format:check, task format gate, lint, typecheck, test:unit (189 passed, 0 skipped), and build passed.
- Replay: N/A (server quota and GC worker) + mitigation: cold-clone race/replay fixtures, provider inventory transcripts, exact cost digests, and deletion sensitivity.
- Claim: scoped atomic reservations, provider-observed deduplicated cost events, paginated ownership-safe quarantine/GC, monotonic/fenced lease rechecks, and deletion sensitivity satisfy the E4-T07 acceptance criteria.

### Critic — 2026-08-17

- Verdict: VERDICT: refuted
- Exact implementation commit: a536b9edda876e7d6879d5fffc3f72c5c3f48a03
- Independent cold run: make verify-E4-T07, TEST_RUN_ID=e4-t07-critic-20260817; formatting, lint, typecheck, 189 unit tests with 0 skipped, build, and the verifier all passed with matching builder digests.
- Findings: the reservation fixture incremented providerCalls after reserve without invoking a provider; cleanup sensitivity failed only after entering the destroy stub; delayed-heartbeat sequence advance was not exercised; timeout removed the resource before 504 so no idempotent destroy retry was proven; stale-fence rejection was not tested.
- Replay: N/A (server quota and GC worker) + mitigation: independent cold clone, quota race replay, paginated ownership inventory, canary scan, and mutation review.
- Status: refuted pending verifier repair.

### Repair Builder — 2026-08-17

- Commit: d1990f029bf395ccb26211185e2b13dfba9b321a
- Cold run: make verify-E4-T07, TEST_RUN_ID=e4-t07-cold-repair-20260817; detached tracked checkout with exact repair commit and frozen install.
- Evidence: .artifacts/e4-t07/e4-t07-cold-repair-20260817/{quota-reservation,usage-cost,gc-inventory,deletion-sensitivity,verification-summary,cold-verification-transcript}.json.
- Digests: quota/event and shuffled replay sha256:ba6fe0ed245300d859aab8974af63553b60f0efd4ad8812be6faf3cd00b1be4e; GC sha256:20a365e283c3e8ffca01f1420f938621c94c93e156963fd966fb670c6d4c38a9; reservation races sha256:3e50f5cc4092060ec2d24758e3c9e96f0503fceac232177440a1f3b9729e65ca; deletion sensitivity sha256:d326fbc8812bb369acd095c9e734a1e7b5b2ad420b09ace254c4f53486d913fd.
- Repair coverage: accepted reservations invoke an actual provider stub while rejected races make no provider call; delayed heartbeat sequence advancement resets grace; a retained 504 resource is retried with the same deterministic idempotency key; stale provider fences are rejected without deletion.
- GC evidence: 23 paginated provider pages; live, foreign, partial, and unlabeled resources remain; timeout retry has two destroy attempts with one idempotency key; delayed heartbeat and monotonic rollback paths are exercised.
- Sensitivity: the disposable mutation that removes the second lease check exits 73 from the simulated destroy guard, proving the detector turns red before a destructive provider action can proceed.
- Gates: format:check, task format gate, lint, typecheck, test:unit (189 passed, 0 skipped), and build passed from the detached checkout.
- Replay: N/A (server quota and GC worker) + mitigation: cold-clone race/replay fixtures, provider inventory transcripts, exact cost digests, and deletion sensitivity.
- Claim: the repaired evidence closes the prior critic findings and the E4-T07 implementation is ready for a fresh independent critic.
- Status: implemented; fresh critic required.
