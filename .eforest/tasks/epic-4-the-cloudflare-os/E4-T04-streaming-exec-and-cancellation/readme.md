---
id: E4-T04
epic: 4
title: "Streaming execution and cancellation: ordered output, reconnectable offsets, and fenced process termination"
priority: 404
status: pending
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
