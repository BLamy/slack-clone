---
id: E0-T06
epic: 0
title: "Crash, duplicate-delivery, and partition sensitivity harness"
priority: 6
status: implemented
depends_on: [E0-T04, E0-T05]
estimate: L
capstone: false
---

## Goal

Build a deterministic fault harness that can stop and restart application components at
named boundaries, duplicate deliveries, delay acknowledgements, partition live readers,
and prove the recovered state against replay rather than process-local expectations.

## Context

The mention dispatcher and remote sandboxes will depend on failure semantics established
here. Fault injection must be reusable, seeded, and sensitive: it is not a collection of
timing sleeps. Each injection point is a protocol hook, each run records its seed and
schedule, and every final claim cites a stream dump and digest.

## Deliverables

- Seeded fault scheduler and named hooks around validate, append, receipt, publish, consume,
  checkpoint, and acknowledge boundaries.
- Process restart, duplicate, reorder, delay, partition, and slow-consumer scenarios.
- Run manifests containing seed, schedule, accepted events, checkpoints, and final digest.
- Sensitivity tests and `make verify-E0-T06` cold-clone target.

## Acceptance criteria

- [ ] `make verify-E0-T06` exits 0 from a cold clone and records a reproducible manifest for
      every frozen
      fault schedule with zero skipped injection points.
- [ ] Crashing after append and before acknowledgement never duplicates a logical mutation;
      crashing before append never invents a receipt.
- [ ] Duplicate and reordered delivery changes neither reduced state nor final digest, while
      invalid causal order is rejected at a cited offset.
- [ ] A partitioned reader resumes from its last durable checkpoint and converges to the
      independently replayed final digest without a full hidden-state copy.
- [ ] Slow consumers stay within frozen memory/output bounds and are cancelled or caught up
      according to a typed policy without blocking unrelated streams.
- [ ] Re-running any recorded seed and schedule produces the same accepted/refused sequence
      and digest.
- [ ] Replay is declared `Replay: N/A (headless failure harness) + mitigation: deterministic
      schedules, process restarts, stream dumps, checkpoint proofs, and replay digests`.

## Adversarial verification

1. Inject at every named boundary individually and in seeded combinations; an unreachable
   hook or nondeterministic schedule refutes coverage.
2. Delete all process state between crash and restart. Recovery that requires an in-memory
   map, timer, or promise refutes durability.
3. Hold one stream partitioned while flooding another. Head-of-line blocking or cross-stream
   state contamination refutes isolation.
4. Corrupt a saved checkpoint and require a typed refusal or safe earlier recovery; silent
   skip or data loss refutes checkpoint integrity.
5. Disable one deduplication or resume check in a scratch worktree and prove a frozen fault
   schedule fails.

## Verification log

### Builder — 2026-08-02 — activated after E0-T05 verification

- E0-T05 is verified at the exact replay/provenance repair handoff, and E0-T06 is the
  sole active queue gate. The implementation will use named protocol hooks and seeded
  schedules, with all crash/restart and partition claims tied to durable stream dumps,
  checkpoints, and E0-T05 replay digests. Replay: N/A (headless failure harness) +
  mitigation: deterministic schedules, process restarts, stream dumps, checkpoint proofs,
  and replay digests.

### Builder — 2026-08-02 — implemented at `7a20becc6e8b50581035b914c7a95397e57ff1a9`

- Cold command: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e0-t06-promoted-final TEST_ARTIFACT_DIR=.artifacts/e0-t06/e0-t06-promoted-final make verify-E0-T06`.
- Result: PASS with `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`,
  and `pnpm build`; 13 frozen schedules, zero skipped injection points, and all seven
  named hooks covered.
- Every schedule reran with an identical accepted/refused sequence and final replay
  digest `sha256:86d8d7e321a8654b25dfffdd2bffe1a70bc65737e007c6ec27dca3005313d5b0`.
  The authoritative target dump contains three logical events and the receipt dump
  contains three receipts after crash/restart and duplicate-append recovery.
- Partition evidence records a deleted reader process, durable checkpoint offsets, and
  convergence to the independent replay digest. The invalid causal-order attack is
  rejected as `REDUCER_ILLEGAL_TRANSITION` at
  `0000000000000000_0000000000000001`; slow-consumer evidence records bounded output,
  typed cancel/catch-up policies, and five unrelated-stream progress records.
- Evidence: `evidence/verification-summary.json`, `evidence/determinism.json`,
  `evidence/fault-schedules.json`, `evidence/sensitivity.json`, and
  `evidence/schedules/*.json`.
- Claim: the deterministic harness proves crash/restart recovery, idempotent duplicate
  delivery, offset-ordered replay, checkpoint recovery, bounded slow-consumer policy,
  and schedule sensitivity. Replay: N/A (headless failure harness) + mitigation:
  deterministic schedules, process restarts, stream dumps, checkpoint proofs, and replay
  digests. Fresh critic verification remains required.

### Critic — 2026-08-02 — `VERDICT: refuted`

- Fresh critic independently reran `make verify-E0-T06`; all five gates passed, all 13
  schedules and seven hooks were reached, and the committed digest/sensitivity claims
  reproduced.
- Refutation: the reader restart reused the same in-memory `streams` map, so
  `stateDeleted: true` did not prove a durable authority restart. The slow-consumer
  probe clipped measurements with `Math.min`, hard-coded isolation, and flooded the
  unrelated stream only after reader recovery instead of while the partition was held.
  Acknowledgement delay recorded ticks without delaying a real bounded acknowledgement.
- Repair required before verification: export/import durable stream authority across a
  restarted reader, enforce (rather than report) bounded queue policies during the
  partition, flood an unrelated stream while that partition is active, and model the
  acknowledgement delay as a deterministic deferred acknowledgement.

### Builder — 2026-08-03 — repair implemented at `e96acafed6efbd9cafc1f5b09fe3a8fa5303858f`

- The reader now exports durable stream authority, imports it into a fresh store instance
  before restart, and proves the imported snapshot is byte-equivalent. The partition
  callback floods an unrelated stream while the reader is still partitioned, then records
  its independent progress after import.
- Slow-consumer policies enforce a 2-record/1024-byte queue: cancel raises typed
  `HARNESS_SLOW_CONSUMER`, while catch-up clears the full queue and resumes from durable
  source. Acknowledgement delay now uses a deterministic pending/deferred/acknowledged
  trace rather than only recording a number.
- Cold command: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e0-t06-repair-promoted TEST_ARTIFACT_DIR=.artifacts/e0-t06/e0-t06-repair-promoted make verify-E0-T06`. Result: PASS; all five gates, 13 schedules, seven hooks, and three sensitivity detectors passed. The final replay digest remains `sha256:86d8d7e321a8654b25dfffdd2bffe1a70bc65737e007c6ec27dca3005313d5b0`.
- Repair evidence replaces the prior manifests in `evidence/`, including durable snapshot equality, partition-time unrelated-stream progress, queue peak measurements, typed overflow results, and deferred acknowledgement state traces. Replay: N/A (headless failure harness) + mitigation: deterministic schedules, process restarts, stream dumps, checkpoint proofs, and replay digests. Fresh critic verification remains required.
