---
id: E0-T06
epic: 0
title: "Crash, duplicate-delivery, and partition sensitivity harness"
priority: 6
status: pending
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
