---
id: E3-T03
epic: 3
title: "Durable run queue, fenced worker leases, and scoped capabilities"
priority: 303
status: verified
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

### Builder — 2026-08-07

- Commit: `d679aa608e1d12ae048b253fcea6dfb470178fc6` (`Thread worker scope through E3-T03 mutations`), on `codex/e3-t03-durable-run-queue`, including the prior implementation and verifier-hardening commits.
- Command: `PROMOTE_EVIDENCE=1 E3_T03_IMPLEMENTATION_COMMIT=d679aa608e1d12ae048b253fcea6dfb470178fc6 TEST_RUN_ID=e3-t03-final-cold-20260807 make verify-E3-T03`.
- Cold evidence: `evidence/e3-t03-final/cold-clone-transcript.json`, `verification-summary.json`, `queue-proof.json`, `worker-race.json`, `lease-schedules.json`, `authority-fences.json`, `capability-scopes.json`, `replay-digests.json`, `reducer-integration.json`, `sensitivity.json`, and `canary-scan.json`.
- Queue proof: invocation stream digest `sha256:9b0ae935fced669b4b6c4c103cd88bd0c169974fa7b6be88e61dfed3569d310c`; run stream digest `sha256:0c73479c6db0344b93427db7f8edc8f4ccf68f1e2ff2f1458d42fc72b7a9da86`; queue digest `sha256:ac5983f8a2127f4cc762f7ffd6a0679411b82c1a0db64acb537b9bd2a36e22a8`; rebuilt eligible order was `iv_ffffffffffffffffffffffffff`, `iv_eeeeeeeeeeeeeeeeeeeeeeeeee`, `iv_dddddddddddddddddddddddddd`.
- Lease evidence: 100 workers produced one generation-1 winner and 99 typed `RUN_QUEUE_LEASE_HELD` losers; expiry/reacquisition advanced to generation 2; authority revocation and workspace suspension fenced callbacks before mutation; replay/reducer final digests are recorded in `replay-digests.json` and `reducer-integration.json`.
- Capability evidence: worker, endpoint, active foreign run, foreign-agent coordinator, foreign-workspace coordinator, post-expiry use, generation-two reuse, and forged token scopes were all refused without callback execution.
- Sensitivity: the unmutated control exited 0 and queue-proof-binding, capability-endpoint-scope, and lease-generation-fence mutants each exited non-zero under the verifier. Published evidence scan found no bearer, private-key, or API-key material.
- Replay: N/A (server queue and lease protocol) + mitigation: hundred-worker race, partition/supersession schedules, queue rebuild, and stream digests.
- Claim: the durable queue projection, lease event reducer/coordinator, generation fences, and scoped capabilities are implemented and pass the cold builder verifier; the exact commit and promoted evidence are ready for independent critic verification.

### Critic — 2026-08-07 — final independent review

- `VERDICT: verified` from a fresh read-only critic reviewing exact commit `d679aa608e1d12ae048b253fcea6dfb470178fc6`, its parent diff, the task readme, and promoted evidence.
- The critic reran `E3_T03_SKIP_GATES=1 E3_T03_SKIP_SENSITIVITY=1 ... node scripts/verify-e3-t03.mjs` with exit 0 and byte-matched the substantive queue, race, lease, capability, authority, replay, and reducer evidence. It confirmed worker scope on heartbeat/release/mutate, exact `RUN_QUEUE_CAPABILITY_INVALID` stale predicates, all eight capability attacks, `callbackCalls: 0`, deterministic queue/replay digests, and a clean canary scan.
- The promoted cold transcript records a clean detached checkout at `d679aa608e1d12ae048b253fcea6dfb470178fc6`, all five gates passing, 170 tests, five Playwright tests, one accepted lease among 100 workers, generation 1 to 2 reacquisition, authority fences, and three detected sensitivity mutants. No correctness or evidence gap blocked verification; remaining hygiene observations were non-blocking.
- Status is now `verified` and the regenerated queue advances to E3-T04.
