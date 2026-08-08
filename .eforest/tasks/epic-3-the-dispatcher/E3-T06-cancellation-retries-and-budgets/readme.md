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
