---
id: E0-T05
epic: 0
title: "Pure reducers, canonical state digests, and replay CLI"
priority: 5
status: verified
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

### Builder — 2026-08-02 — activated after E0-T04 verification

- E0-T04 is verified at the exact repaired product commit and the queue has no other
  active gate. E0-T05 now owns the pure reducer registry, canonical state/digest contract,
  replay/validation CLI, golden logs, purity audit, mutation tests, and cold-clone verifier.
- The implementation will keep all fold dependencies injected or immutable and will use
  only committed stream fixtures as authority; Replay: N/A (CLI replay apparatus, not
  browser behavior) + mitigation: golden event logs, per-prefix digests, purity audit, and
  mutation tests.

### Builder — 2026-08-02 — implementation and cold evidence

- Implementation commit: `bbc24c1562a8e5cf4982a6a93438c7e3749a28a4`.
- Cold command: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e0-t05-cold-final TEST_ARTIFACT_DIR=.artifacts/e0-t05/e0-t05-cold-final make verify-E0-T05`.
- The cold target reinstalled with `pnpm install --frozen-lockfile`, rebuilt the emulator
  from its lockfile, and passed every gate with zero skips: `pnpm format:check`, `pnpm lint`,
  `pnpm typecheck`, `pnpm test` (70 unit tests plus 5 browser tests), and `pnpm build`.
- `ledger-log.v1.json` replayed to final digest
  `sha256:62bccd2874d1473c699b37e6837e269dda5ceabcc34666cdd6481c169ad0fbc0` across ten
  prefixes; `message-and-run-log.v1.json` replayed to final digest
  `sha256:65f065ca02bd8e8358dec0110a7243817e754f57bd0c78c86d2166c9a4c363b9` across four
  prefixes. Fresh processes produced byte-identical replay output under `TZ=UTC, LANG=C`
  and `TZ=America/New_York, LANG=en_US.UTF-8`.
- Invalid fixtures failed at exact offsets with typed errors: duplicate logical ID at
  `0000000000000002_0000000000000006`, illegal transition at
  `0000000000000002_0000000000000004`, malformed envelope at
  `0000000000000002_0000000000000002`, and unknown event type at
  `0000000000000002_0000000000000001`. One-byte semantic mutations changed the final
  digest for both valid fixtures. The purity audit found no ambient capabilities or
  non-local imports reachable from either reducer module; query-store and build-cache
  paths remained absent with network-disabled replay settings.
- Evidence: `evidence/verification-summary.json`, `evidence/prefix-digests.json`,
  `evidence/invalid-results.json`, `evidence/purity-audit.json`,
  `evidence/mutation-results.json`, and the committed `evidence/valid/` and
  `evidence/invalid/` fixture copies. Replay: N/A (CLI replay apparatus, not browser
  behavior) + mitigation: golden event logs, per-prefix digests, purity audit, and
  mutation tests.
- Builder claim: the pure reducer registry, canonical state/digest contract, typed
  replay/validation CLI, and cold evidence satisfy every E0-T05 acceptance criterion and
  are ready for an independent critic.

### Critic — 2026-08-02 — independent provenance sensitivity audit

VERDICT: refuted

- Critic session `019fc3fe-7505-7343-bf99-f7cbda7ec0f8` confirmed the cold replay, purity,
  canonical ordering, duplicate/offset/transition failures, and timezone/locale checks, but
  found that mutating `serverTimestamp`, `correlationId`, `idempotencyKey`, `actorId`, or
  `causation.digest` could be accepted with the unchanged final digest
  `sha256:62bccd2874d1473c699b37e6837e269dda5ceabcc34666cdd6481c169ad0fbc0`.
- The cause is that the reducer state retained reduced payloads and event IDs but not the
  envelope provenance needed to distinguish source facts. The claim is therefore refuted;
  the next builder pass must retain canonical envelope provenance and add independent
  metadata/source-reference mutation tests. The critic did not edit product code or task
  metadata.

### Builder — 2026-08-02 — provenance repair and cold evidence

- Repair commit: `a23b4962eddf1e413aa76c211a0032d2b2397c7e`. Replay state now retains each
  applied envelope and its canonical Durable Streams offset in `eventProvenance`, so source
  metadata is part of every prefix and final digest. Replay also rejects non-canonical
  offsets with `REDUCER_INVALID_OFFSET` at the offending record.
- Repair cold command: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e0-t05-repair-provenance TEST_ARTIFACT_DIR=.artifacts/e0-t05/e0-t05-repair-provenance make verify-E0-T05`.
- The clean cold target reinstalled and rebuilt the emulator, then passed every gate with
  zero skips: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (71 unit tests
  plus 5 browser tests), and `pnpm build`.
- Replaying `ledger-log.v1.json` twice in fresh processes produced final digest
  `sha256:5462e5c9d9d93fa56ae173a15d49ea3c931db073a2ee3da0dd2083ebeb99b79e` across ten
  prefixes. Replaying `message-and-run-log.v1.json` twice produced final digest
  `sha256:abe1b4ab514e5b182efd0e509efef3f42b4b8ae7bf843361b18b991c7d9522ef` across four
  prefixes. Full replay bytes and prefix digest output remained identical under the two
  locale/timezone environments.
- The verifier independently changed `serverTimestamp`, `correlationId`, `idempotencyKey`,
  `actorId`, `eventId`, and the stream offset for both valid logs; each valid mutation
  changed the final digest. Schema-version mutations failed typed validation, and paired
  `causation.digest` mutations changed the final digest. Invalid-offset evidence reports
  `REDUCER_INVALID_OFFSET` at `not-an-offset`; query-store and build-cache paths remained
  absent under network-disabled replay settings.
- Promoted evidence: `evidence/verification-summary.json`,
  `evidence/prefix-digests.json`, `evidence/invalid-results.json`,
  `evidence/mutation-results.json`, `evidence/provenance-results.json`,
  `evidence/purity-audit.json`, and committed `evidence/valid/` plus
  `evidence/invalid/` fixture copies. Replay: N/A (CLI replay apparatus, not browser
  behavior) + mitigation: golden event logs, per-prefix digests, purity audit, and
  mutation tests.
- Repair claim: the critic’s provenance sensitivity finding is addressed at the state
  contract, and the repaired implementation is ready for a fresh independent critic.

### Critic — 2026-08-02 — final independent verification

VERDICT: verified

- Fresh critic session `019fc409-9fc1-7aa3-9f01-e4bc6cb81447` audited handoff `3ac6463`
  and repair `a23b4962eddf1e413aa76c211a0032d2b2397c7e` without editing the repository.
- Both valid logs replayed in fresh processes with byte-identical full output and prefix
  digests: ten prefixes ending at
  `sha256:5462e5c9d9d93fa56ae173a15d49ea3c931db073a2ee3da0dd2083ebeb99b79e`, and four
  prefixes ending at
  `sha256:abe1b4ab514e5b182efd0e509efef3f42b4b8ae7bf843361b18b991c7d9522ef`.
- Independent attacks confirmed typed failures for invalid offsets, duplicate event and
  logical IDs, unknown/malformed events, illegal transitions, and revision regressions.
  Timestamp, correlation, idempotency, actor, event ID, schema, offset, payload, and
  non-null causation digest mutations were either rejected or changed prefix/final
  digests. Canonical key reordering remained invariant.
- The reducer capability audit was clean; a disposable `Date.now()` mutation was detected
  as `clock`. Query-store/build-cache paths stayed absent with network-disabled settings.
  Replay: N/A (CLI replay apparatus, not browser behavior) + mitigation: golden event
  logs, per-prefix digests, purity audit, and mutation tests.
- E0-T05 is verified and unlocks E0-T06.
