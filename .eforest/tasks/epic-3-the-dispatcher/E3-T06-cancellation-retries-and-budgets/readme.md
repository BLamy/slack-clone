---
id: E3-T06
epic: 3
title: "Cancellation, retries, deadlines, and resource budgets"
priority: 306
status: in-progress
depends_on: [E3-T03]
estimate: L
capstone: false
---

## Goal

Enforce durable cancellation, attempt deadlines, bounded retries, backoff, token/cost/runtime
budgets, and terminal outcomes such that no worker or child process can mutate after the run
has lost authority.

## Context

Remote providers arrive later, so this task uses a deterministic scripted runner with real
process trees and metered events. Cancellation is a control-plane transition followed by
capability revocation and process termination; killing a PID without fencing writes is not
sufficient. Retryable infrastructure failures are distinct from policy, authorization,
budget, and deterministic task failures. Backoff schedules are durable data and fake-clock
testable, not sleeps embedded in tests.

## Deliverables

- Cancellation/deadline/retry/budget policy and run-attempt event integration.
- Process-group termination and capability-revocation hooks for the scripted runner.
- Fake-clock schedules covering timeout, backoff, lost acknowledgement, and terminal races.
- `make verify-E3-T06` cold-clone target and terminal-state evidence.

## Acceptance criteria

- [ ] `make verify-E3-T06` exits 0 from a cold clone and records attempt timelines, fake-clock
      schedules,
      usage accounting, capability revocations, process/resource counts, and run digests.
- [ ] Authorized cancel, deadline expiry, budget exhaustion, agent revoke, and lease loss
      revoke mutation capability before the next append and terminate the complete process
      group within the frozen bound.
- [ ] Retryable failures create bounded attempts with deterministic backoff and fresh lease/
      capability identity; non-retryable failures never launch another attempt.
- [ ] Token, cost, wall-time, output, attempt, and aggregate delegation budgets cannot be
      exceeded by rounding, concurrency, delayed usage, or retry.
- [ ] Complete, fail, timeout, budget-exhaust, and cancel racing at one head yield exactly one
      immutable terminal outcome; late results and replies are refused.
- [ ] Crash after side effect but before attempt acknowledgement resumes from run events and
      does not repeat a completed logical action under the scripted idempotency contract.
- [ ] Replay is declared `Replay: N/A (headless run-control protocol) + mitigation: real
      process-tree probes, fake-clock schedules, usage manifests, terminal races, and replay`.

## Adversarial verification

1. Spawn grandchildren that ignore normal termination, flood output, and delay cleanup. Any
   survivor or exceeded bound refutes process control.
2. Race every terminal cause at every append boundary. Two terminals or one post-terminal
   mutation refutes fencing.
3. Report usage late, duplicated, fractional, overflowing, and from stale attempts. Any
   budget bypass or double charge refutes accounting.
4. Crash and restart the controller at each retry/backoff boundary with an empty process map.
   Lost schedule or duplicate attempt refutes durability.
5. Disable capability revocation before process kill in a scratch worktree; a planted late
   mutation must make the verifier fail.

## Verification log

### Builder — 2026-08-08 — commit `c266a78614a046ff94960f859dbd8e820cc1f5b5`

- Cold proof: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e3-t06-final-c266a78 make verify-E3-T06` exited 0 from a clean detached worktree at the exact commit after local-reference submodule initialization, frozen install, and emulator setup. The transcript is recorded in `evidence/e3-t06-final/cold-clone-transcript.json`.
- Gates: `pnpm format:check:e3-t06`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all passed; the test gate included 180 unit/ledger tests and five two-session browser integration tests.
- Run-control evidence: `attempt-timelines.json` records two attempts with deterministic backoff and distinct lease/capability digests; `fake-clock-schedules.json`, `capability-revocations.json`, `process-resource-counts.json`, `usage-accounting.json`, `terminal-races.json`, and `crash-recovery.json` cover the frozen schedules, fencing order, complete process-tree termination, all budget dimensions, terminal races, and idempotent restart recovery.
- Replay/evidence integrity: `replay-digests.json` records reducer digest `sha256:b4cd46283d1b20bea8d63405093c3a975bfff8a779dc0b09db14c53c90ce4f83`, lease digest `sha256:2e73c4c5082a385793e40e51887d048b20f72c5e8b6fbbcbe63b1a2f1d773dd4`, 23 reducer prefixes, and four lease prefixes. `canary-scan.json` reports no leaked credential-shaped values. `sensitivity.json` shows the capability-fence mutation made the verifier exit 1.
- Replay: `Replay: N/A (headless run-control protocol) + mitigation: real process-tree probes, fake-clock schedules, usage manifests, terminal races, and replay`.
- Claim: cancellation, deadlines, retries, bounded backoff, attempt/aggregate resource budgets, terminal immutability, process-group cleanup, and crash-safe idempotent logical actions are implemented and supported by the exact diff plus promoted cold evidence; ready for a fresh critic.

### Critic — 2026-08-08 — review of commit `07f1a99`

VERDICT: refuted

- The fresh critic could not execute commands in its sandbox, but its static findings are reproducible against the exact diff: usage deduplication was rehydrated with envelope `ik_` keys while `reportUsage` checked caller keys; the restart watermark `initialLeaseRecordCount` was accepted by the verifier harness but ignored by the coordinator; an over-budget `reportUsage` could finalize before validating the supplied capability; and mutating operations trusted caller timestamps without a monotonic deadline guard.
- These gaps refute the restart/accounting, stale-capability fencing, and deadline portions of the acceptance criteria. The builder is returning the task to implementation to repair them and add independent verifier coverage before another critic.
