---
id: E4-T04
epic: 4
title: "Streaming execution and cancellation: ordered output, reconnectable offsets, and fenced process termination"
priority: 404
status: verified
depends_on: [E4-T02]
estimate: L
capstone: false
---

## Goal

Remote commands execute through a bounded Cloudflare OS workspace session whose stdout,
stderr, status, heartbeat, and terminal result append to a replayable run stream with
monotonic sequence numbers. Clients may reconnect from an offset, and cancellation
terminates the process tree before any later tool or message effect is accepted.

## Context

Harnesses need interactive output without turning a dropped HTTP connection into an
unknown run. The durable stream is authoritative; a websocket or SSE connection is only
a projection. Cancellation must be a fenced state transition rather than best-effort
signal delivery.

## Deliverables

- `packages/sandbox/src/exec-events.ts` and Cloudflare OS streaming transport with
  replay/resume.
- Bounded output chunking, terminal-result idempotency, process-tree cancellation, and
  timeout enforcement.
- `make verify-E4-T04` with disconnect, duplicate, reorder, overflow, and kill fixtures.

## Acceptance criteria

- [ ] `make verify-E4-T04` passes cold and replays each execution transcript twice to the
      same byte sequence, exit result, and state digest.
- [ ] Stdout and stderr chunks carry a single monotonic sequence and channel tag; resume
      after every possible disconnect returns each accepted chunk exactly once in order.
- [ ] Exactly one terminal event is accepted. Late output, duplicate exits, and stale
      heartbeats after terminal state are refused without advancing the public run view.
- [ ] Cancellation and timeout kill the full provider process tree, append a typed cause,
      and fence subsequent tool/message/credential operations for that execution.
- [ ] Per-chunk, per-command, and per-run byte limits produce a typed truncation or limit
      event; they never buffer unbounded output in server memory.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (headless remote execution
      transport) + mitigation: cold-clone transcript replay, disconnect matrix,
      cancellation sensitivity, and exact sequence assertions`.

## Adversarial verification

1. Disconnect after every chunk and terminal boundary, then resume from old and future
   offsets. Missing, duplicated, or reordered accepted bytes refute replayability.
2. Emit output floods, invalid UTF-8, split multibyte sequences, and simultaneous stdout/
   stderr writes. Memory growth beyond the stated bound or nondeterministic replay fails.
3. Race cancel with child-process spawn and terminal exit. Any live descendant or
   accepted post-cancel side effect refutes fencing.
4. Remove the late-output guard in a scratch worktree. The verify target must fail on a
   post-terminal chunk.

## Verification log

### Builder — 2026-08-17

- Commit: `13dca35ec0e376a446228ef71ada7dda0d938e2b`
- Cold run: `make verify-E4-T04`, `TEST_RUN_ID=e4-t04-cold-20260817`
- Evidence: `.artifacts/e4-t04/e4-t04-cold-20260817/{transcript,reconnect-matrix,cancellation,limits,transport-audit,verification-summary,cold-verification-transcript}.json`
- Transcript digest: `sha256:c5704831d44532b2d5461260ab79258067983034f2b5469bf5e27ae82f9b332d`
- Gates: `format:check`, `lint`, `typecheck`, `test:unit` (189 passed, 0 skipped), and `build` passed from a detached cold worktree.
- Replay: N/A (headless remote execution transport) + mitigation: cold-clone transcript replay, disconnect matrix, cancellation sensitivity, and exact sequence assertions.
- Claim: the bounded event journal preserves byte-exact stdout/stderr order across reconnects, accepts one terminal event, emits typed output limits, and fences cancellation/timeout effects before process-tree termination.

### Critic — 2026-08-17

- Verdict: `VERDICT: verified`
- Exact implementation commit: `13dca35ec0e376a446228ef71ada7dda0d938e2b`
- Independent cold run: `make verify-E4-T04`, `TEST_RUN_ID=e4-t04-critic-20260817`; the detached clone passed with transcript digest `sha256:c5704831d44532b2d5461260ab79258067983034f2b5469bf5e27ae82f9b332d` and six reconnect boundaries.
- Independent attacks passed: every disconnect offset replayed the exact ordered transcript; future offsets, late output, stale heartbeats, and duplicate terminals were refused without sequence advancement; invalid UTF-8 bytes remained byte-exact; chunk floods emitted a typed limit event; cancellation and timeout fenced effects and left zero simulated descendants.
- Sensitivity: in a disposable worktree, removing the late-event guard made the direct terminal detector exit 1 with `Missing expected exception`; the worktree was removed after the check.
- Gates: `format:check`, `lint`, `typecheck`, `test:unit` (189 passed, 0 skipped), and `build` passed from the detached cold worktree.
- Replay: N/A (headless remote execution transport) + mitigation: independent cold clone, reconnect matrix, terminal-integrity attacks, cancellation sensitivity, and exact sequence/digest comparison.
