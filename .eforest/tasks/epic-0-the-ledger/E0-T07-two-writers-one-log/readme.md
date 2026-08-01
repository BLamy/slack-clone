---
id: E0-T07
epic: 0
title: "Capstone: two writers, one authoritative log"
priority: 7
status: pending
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
