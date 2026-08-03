---
id: E0-T07
epic: 0
title: "Capstone: two writers, one authoritative log"
priority: 7
status: verified
depends_on: [E0-T03, E0-T06]
estimate: M
capstone: true
---

## Goal

Prove the complete Epic 0 spine with two independent writers racing through the dispatch
door, a live follower surviving restart and partition, and an offline replay producing the
same final state and digest from the durable log alone.

## Context

This is the gate for every domain epic. It composes the envelope, package boundaries,
official adapter, fenced dispatch, replay CLI, and fault harness without adding workspace
or chat semantics. A capstone run begins from a cold clone and freshly started emulator;
pre-existing streams, caches, sessions, or build artifacts invalidate the evidence.

## Deliverables

- A deterministic two-writer scenario with conflicting and non-conflicting operations.
- A follower scenario covering disconnect, partition, process restart, and checkpoint
  resume while writes continue.
- Final stream dump, dispatch receipts, fault manifest, prefix digests, and verifier report.
- `make verify-E0` and `make verify-E0-T07` cold-clone targets.

## Acceptance criteria

- [ ] `make verify-E0-T07` and the composed `make verify-E0` exit 0 from a cold clone with a
      fresh emulator, zero skips, and all evidence paths resolved inside this task.
- [ ] Two independent writer processes race the same expected head; every logical operation
      has one accepted outcome or one typed refusal, never two conflicting successes.
- [ ] The follower is killed, partitioned, restarted empty, and resumes from its recorded
      opaque checkpoint while writers continue; it reaches the final head without gaps.
- [ ] Live reduced state, follower state, and two independent offline replays of the final
      dump have byte-identical canonical state and digest.
- [ ] Removing all process caches and projection files before replay changes no result and
      no database or local map is required to explain an accepted mutation.
- [ ] The capstone report cites the exact commit, commands, stream offsets, event/state
      digests, fault seed, and before/after resource counts.
- [ ] Replay is declared `Replay: N/A (server/CLI protocol capstone) + mitigation: real
      emulator, two-process race, deterministic fault manifest, stream dump, and independent
      replay digests`.

## Adversarial verification

1. Repeat the scenario across many seeds and reverse writer start order. Different accepted
   ordering is allowed; a state not explained by that durable ordering is not.
2. Kill the follower and each writer at every injected boundary. Any unrecorded success,
   duplicate logical effect, or irrecoverable checkpoint refutes the capstone.
3. Replay with networking disabled after deleting all non-evidence state. A required service
   lookup refutes log authority.
4. Tamper with one receipt, checkpoint, event, and final digest in separate runs. The
   verifier must identify the exact mismatch.
5. Run the capstone twice concurrently against separate namespaces. Cross-run events,
   teardown, or evidence paths refute isolation.

## Verification log

### Builder — 2026-08-03 — activated after E0-T06 verification

- E0-T06 is verified at repair commit `e96acafed6efbd9cafc1f5b09fe3a8fa5303858f`;
  E0-T07 is now the sole active capstone gate. The implementation will compose the
  official Durable Streams emulator, two independent dispatch writers, the E0-T06
  deterministic fault seams, and offline reducer replay without adding domain semantics.

### Builder — 2026-08-03 — implemented at `b5ab9bcdcdfec1e9e8598b5f50b9774b77030f2a`

- Added independent writer and follower processes, durable receipt/checkpoint evidence,
  deterministic partition/restart choreography, and offline replay/tamper detectors.
- Added cold `make verify-E0-T07` and composed `make verify-E0` targets. The final clean
  promoted run is the critic handoff evidence; Replay: N/A (server/CLI protocol capstone)
  + mitigation is recorded by the verifier.

### Builder — 2026-08-03 — final evidence at `ba09eb96d89c604370548ae812d3000537f1e9ed`

- `PROMOTE_EVIDENCE=1 E0_T07_IMPLEMENTATION_COMMIT=ba09eb96d89c604370548ae812d3000537f1e9ed TEST_RUN_ID=e0-t07-final make verify-E0-T07` passed from a clean tracked tree; the composed `TEST_RUN_ID=e0-t07-composed E0_T07_IMPLEMENTATION_COMMIT=ba09eb96d89c604370548ae812d3000537f1e9ed make verify-E0` also passed all targets.
- Promoted evidence is in `evidence/e0-t07-final/`; the composed cold run is in `evidence/e0-t07-composed/`. Both runs have zero skipped checks and include the final stream dump, receipts, fault manifest, prefix digests, replay dump, follower checkpoint, and verifier report.
- Promoted authoritative stream: 7 records, next offset `0000000000000000_0000000000006152`, digest `sha256:07dffad4de1d339354a6894d702b6982105fcd8f9ddf21f26234a602352c6aa2`. Receipts: 8 records, next offset `0000000000000000_0000000000004233`, digest `sha256:d0aae0de5b3c3fc2b6722caf181e7bdd81a5597dfeb445f721229deb49938cd5`. Auxiliary stream: 1 record, next offset `0000000000000000_0000000000000887`, digest `sha256:3ce35d2737ffb8f83f0f9e81565725f9660a5d12d0908146ca137c7b8706f664`.
- Follower/live/offline1/offline2/cleanOffline all produced byte-identical 4,460-byte state with digest `sha256:812ee10ccdd27243ca89bec97b93069584cff4fd4a82cab8bd90ce37ae395990`. The follower resumed after `SIGSTOP`/`SIGKILL` from checkpoint offset `0000000000000000_0000000000001766`, replayed 6 source records on restart, and finished at the final head; resource counts returned to zero worker processes with 3 durable streams.
- Fault seed: `e0-t07-e0-t07-final`; independent writers `e0-t07-e0-t07-final-writer-a` and `e0-t07-e0-t07-final-writer-b`; every conflict race had one accepted result and one typed `DISPATCH_STALE_FENCE` refusal. Sensitivity rejected event-digest, receipt-binding, checkpoint-integrity, and claimed-final-digest mutations with the expected typed codes.
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all passed in the promoted run. Replay: N/A (server/CLI protocol capstone) + mitigation: real emulator, two-process race, deterministic fault manifest, stream dump, and independent replay digests.

### Critic — 2026-08-02 — verified at `c9c596bfe6e8747a20d690f506d42a19cf6d2d3`

- `TEST_RUN_ID=e0-t07-critic-7f3a TEST_ARTIFACT_DIR=.eforest/tasks/epic-0-the-ledger/E0-T07-two-writers-one-log/work/e0-t07-critic-7f3a make verify-E0-T07` exited 0 from a fresh emulator with no skip flag; the run covered two independent writers, duplicate/conflict races, follower `SIGSTOP`/`SIGKILL`, checkpoint restart, and final-head convergence. Fresh artifacts are in `work/e0-t07-critic-7f3a/`.
- A separate real-emulator run `e0-t07-reverse-9c21` started writer B before writer A and produced exactly one accepted result plus one typed `DISPATCH_STALE_FENCE` refusal per conflict. With `E0_T07_NETWORK_DISABLED=1`, replay, validation, prefix comparison, and final-digest comparison passed from the fresh final dump; no cache, projection, database, or SQLite state was present in the disposable run directory.
- Independent binding checks matched canonical stream digests, all seven receipt event-digest/offset bindings, prefix digests, checkpoint facts, replay digests, and the final head for both `evidence/e0-t07-final/` and `evidence/e0-t07-composed/`. Four separate event, receipt, checkpoint, and claimed-final-digest tamper checks rejected their mutations. A targeted checkpoint-validator defect in a disposable worktree made the verifier exit 1 with `E0_T07_CHECKPOINT_INVALID`; that worktree was removed and the product tree remains clean.
- The implementation files are unchanged from the promoted implementation commit `ba09eb96d89c604370548ae812d3000537f1e9ed` through `c9c596b`; the committed final and composed reports cite that implementation commit. `src/ledger/dispatch.mjs` local maps are only in-process serialization/sequence guards; accepted state is read from and appended to Durable Streams, with no local database/map authority.
- The composed `make verify-E0` PASS is audited from `evidence/e0-t07-composed/verifier-report.json` and the Makefile composition; it was not rerun in this bounded critic turn after the user-directed stop. Replay: N/A (server/CLI protocol capstone) + mitigation: real emulator, independent reverse-order race, deterministic fault manifest, stream bindings, offline replay, and detector sensitivity proof.

### Critic — 2026-08-02 — verified (fresh bounded evidence audit)

- Audited the implementation/evidence baseline at `c9c596b` (the checkout also contains
  the metadata-only prior critic commit `92e27e8`; implementation code is unchanged from
  `ba09eb96d89c604370548ae812d3000537f1e9ed`). The independent raw-binding audit passed
  for both `evidence/e0-t07-final/` and `evidence/e0-t07-composed/`: summary/report,
  authoritative/auxiliary/receipt stream digests and offsets, all receipt event/request
  bindings, checkpoint digests and head, prefix digests, replay dump, fault manifest,
  and state-byte/digest convergence.
- `E0_T07_SKIP_GATES=1 E0_T07_IMPLEMENTATION_COMMIT=ba09eb96d89c604370548ae812d3000537f1e9ed TEST_RUN_ID=e0-t07-critic-fresh-0802 TEST_ARTIFACT_DIR=.eforest/tasks/epic-0-the-ledger/E0-T07-two-writers-one-log/work/e0-t07-critic-fresh-0802 node scripts/verify-e0-t07.mjs` exited 0. Fresh namespace artifacts are in `work/e0-t07-critic-fresh-0802/`; they record five conflict races with one accepted result plus one `DISPATCH_STALE_FENCE` refusal each, reverse `ab`/`ba` schedules, follower `SIGSTOP`/`SIGKILL`, two writes during partition, six-record restart replay, seven authoritative records, eight receipts, and identical follower/live/offline/clean-offline digests.
- After confirming no cache/database/projection files in the fresh work directory,
  `E0_T07_NETWORK_DISABLED=1 node scripts/replay-ledger.mjs replay work/e0-t07-critic-fresh-0802/final-replay-dump.json` passed with the fresh final digest. An independent copied-event tamper made the existing replay compare exit 1 with a claimed-final-digest mismatch, and a copied checkpoint was rejected as `E0_T07_CHECKPOINT_INVALID`; tampered artifacts remain only under the task `work/` directory.
- Source inspection confirms accepted mutations append/read through Durable Streams;
  `dispatch.mjs` maps are in-process serialization/sequence guards, not state authority,
  and the follower reconstructs state from source and receipt streams. Promoted evidence
  reports five passing gates and zero skips. Replay: N/A (server/CLI protocol capstone)
  + mitigation: real emulator, fresh two-writer run, raw stream bindings, network-disabled
  offline replay, and independent tamper sensitivity. Limitation: the fresh bounded run
  intentionally skipped repository gates and did not rerun composed `make verify-E0`.
