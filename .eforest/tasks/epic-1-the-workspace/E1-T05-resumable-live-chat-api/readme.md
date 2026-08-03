---
id: E1-T05
epic: 1
title: "Resumable live chat API without polling"
priority: 105
status: implemented
depends_on: [E1-T04]
estimate: L
capstone: false
---

## Goal

Expose authenticated snapshot and live conversation APIs that use official Durable Streams
live reads, carry opaque application checkpoints, enforce channel access throughout a
connection, and converge after disconnect without hot polling.

## Context

The current app server polls each room every 350 milliseconds and can write JSON errors
after SSE headers. This task replaces that loop with a single resumable live path. Snapshot
and live responses expose event and state metadata needed for later deterministic browser
verification, while the server remains responsible for reduction and authorization.

## Deliverables

- Snapshot and SSE or long-poll chat endpoints with opaque resume checkpoints and typed
  terminal/error events.
- Connection cancellation, heartbeat, backpressure, and membership-revalidation behavior.
- Multi-client reconnect, slow-reader, and request-budget integration harnesses.
- `make verify-E1-T05` cold-clone target and network transcript evidence.

## Acceptance criteria

- [ ] `make verify-E1-T05` exits 0 from a cold clone against the emulator and records request
      counts,
      checkpoints, event offsets, and final state digests for two clients.
- [ ] Two authenticated clients receive each accepted conversation event in stream order and
      converge to the server's canonical state digest.
- [ ] Disconnect at every event boundary and resume from the last acknowledged checkpoint
      yields no missing or duplicated logical effects.
- [ ] An idle channel uses the official blocked live-read path within the frozen request
      budget and performs no repeated create or 350-millisecond snapshot polling.
- [ ] Slow clients stay within bounded buffers and receive a typed resync/closure policy
      without blocking writers or other channels.
- [ ] Membership removal, channel archive, logout, and server shutdown terminate or restrict
      live delivery at the defined checkpoint with no double response or leaked handles.
- [ ] Replay is declared `Replay: N/A (server live-delivery API) + mitigation: real-emulator
      network transcript, reconnect matrix, request counts, and digest convergence`.

## Adversarial verification

1. Disconnect before headers, after headers, mid-event, after delivery-before-ack, and during
   heartbeat. Gap, duplicate effect, or `ERR_HTTP_HEADERS_SENT` refutes resumption.
2. Revoke channel membership while events queue behind a slow client. Delivery beyond the
   frozen revocation boundary refutes continuous authorization.
3. Flood one channel and hold another idle. Cross-channel head-of-line blocking or unbounded
   memory refutes backpressure isolation.
4. Supply stale, malformed, sibling-channel, and sibling-workspace checkpoints. Any data
   leak or silent coercion refutes checkpoint scoping.
5. Restore the old polling loop in a scratch worktree; the request-budget gate must fail.

## Verification log

### Builder — 2026-08-02 — implementation complete

- Implementation commit: `7370d35c99035bff3e979ac8e3c1f7c0a0f5cb90` (`E1-T05: implement
  resumable live chat API`). The live HTTP path now uses per-client official Durable Streams
  follows from opaque acknowledged checkpoints, emits typed resume/status/terminal SSE
  frames, serializes bounded writes with drain timeouts, and revalidates session/workspace
  authorization before batches and heartbeats. The browser reconnects from its last
  acknowledged status checkpoint. The old shared room cursor, reset stop/restart path, and
  350 ms polling shape are gone.
- Focused evidence: `test/unit/live-chat-http.test.mjs` covers independent client follows,
  reconnect suffix delivery, checkpoint conflict/refusal, membership and heartbeat
  revocation, bounded slow-reader resync, and shutdown closure. The existing request-budget
  fixture covers a 900,000 ms idle window with one bounded read, one follow, 90 heartbeats,
  and zero additional adapter calls; its 350 ms polling positive control remains sensitive.
- Exact full verifier: `E1_T05_IMPLEMENTATION_COMMIT=7370d35c99035bff3e979ac8e3c1f7c0a0f5cb90
  TEST_RUN_ID=promoted-e1-t05 node scripts/verify-e1-t05.mjs`. Fresh emulator and browser
  gates passed: format, lint, typecheck, 104 unit tests, 5 Playwright integration tests,
  and build. Promoted evidence is under `evidence/e1-t05-final/`.
- Real-emulator two-client transcript resumed Ada from
  `0000000000000000_0000000000000694` to
  `0000000000000000_0000000000001398` with no duplicate logical effects. Ada and Linus
  converged on final digest
  `sha256:183cdaae419b2dffafd80d94b3661cc53c0f778f575df80d6baa2a7dcab42421`; malformed
  checkpoints returned typed `LIVE_CHECKPOINT_INVALID` status 400. Evidence:
  `evidence/e1-t05-final/verification-summary.json`,
  `evidence/e1-t05-final/network-transcript.json`, and
  `evidence/e1-t05-final/idle-request-budget.json`.
- Claim: authenticated live chat now preserves ordered logical effects across disconnect and
  reconnect without hot polling; slow clients are isolated behind bounded delivery and typed
  resync/closure policy; live authorization is rechecked throughout each connection; and
  shutdown/cancellation paths do not issue a second JSON response. Replay: N/A (server
  live-delivery API) + mitigation: real-emulator network transcript, reconnect matrix,
  request counts, and digest convergence.
