---
id: E0-T05
epic: 0
title: "Pure reducers, canonical state digests, and replay CLI"
priority: 5
status: pending
depends_on: [E0-T01, E0-T04]
estimate: M
capstone: false
---

## Goal

Provide the deterministic reduction and replay apparatus that makes a stream dump sufficient
to reconstruct application state, inspect every prefix, and compare live state with replayed
state by canonical digest.

## Context

Durable Streams only become the application authority if reducers are pure and independently
replayable. A passing endpoint test is not enough: future chat, configuration, and run
reducers need the same registry, canonical state encoder, per-prefix digest output, and
typed failure behavior. The CLI consumes exported records and never contacts a hidden query
database to fill gaps.

## Deliverables

- Pure reducer interface and versioned reducer registry for the E0 envelope fixtures.
- Canonical state encoding and SHA-256 digest implementation.
- CLI commands to validate, replay, print prefix digests, and compare a dump to a claimed
  final digest.
- Property tests, golden logs, and `make verify-E0-T05` cold-clone target.

## Acceptance criteria

- [ ] `make verify-E0-T05` exits 0 from a cold clone with zero skips and commits valid/invalid
      dump plus
      per-prefix digest evidence under this task.
- [ ] Replaying every valid golden log twice in fresh processes yields byte-identical state
      and the same pinned digest at every prefix.
- [ ] Reducer dependency inspection finds no filesystem, network, database, environment,
      clock, random, locale, or process-global state reachable from a fold.
- [ ] Unknown events, illegal transitions, duplicate logical IDs, and malformed envelopes
      fail at the exact offending offset with a stable typed error.
- [ ] The replay CLI reaches the claimed result with network disabled and no query-store or
      build-cache files present.
- [ ] Flipping one semantic byte in each fixture either fails validation at that offset or
      changes that prefix and final digest.
- [ ] Replay is declared `Replay: N/A (CLI replay apparatus, not browser behavior) +
      mitigation: golden event logs, per-prefix digests, purity audit, and mutation tests`.

## Adversarial verification

1. Property-generate valid event sequences, replay them across randomized chunk boundaries,
   and compare every prefix; chunking must not affect state.
2. Mutate order, IDs, versions, timestamps, source references, and payload bytes one at a
   time. Unchanged final digest or silent acceptance refutes sensitivity.
3. Run under different timezone, locale, hash seed, and clean environment settings. Any
   digest drift refutes canonical reduction.
4. Block network and remove all projection files before replay. Any missing-state lookup
   refutes stream authority.
5. Make a reducer read `Date.now()` in a scratch worktree; purity or digest tests must fail.

## Verification log
