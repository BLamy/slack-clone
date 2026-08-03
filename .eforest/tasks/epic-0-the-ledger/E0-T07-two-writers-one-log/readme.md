---
id: E0-T07
epic: 0
title: "Capstone: two writers, one authoritative log"
priority: 7
status: implemented
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
