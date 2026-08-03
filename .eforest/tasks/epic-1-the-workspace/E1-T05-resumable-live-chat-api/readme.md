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

### Builder — 2026-08-03 — needs-evidence repair complete

- Repair commit: `2d30a94118d0df72c7b1aa45757de517b47e7f2e` (`E1-T05: close live delivery
  evidence gaps`). Snapshot failures now preserve the provider error before client cleanup,
  so stale provider checkpoints return typed `LIVE_CHECKPOINT_INVALID` 409 responses;
  session revocation retains `LIVE_SESSION_REVOKED` through queued delivery.
- The idle harness now wires the real workspace authorization core: one subscription
  directory read, 90 heartbeat revalidation reads, one bounded snapshot read, and one live
  follow across 900,000 deterministic milliseconds. The polling positive control remains
  sensitive. Focused tests add stale checkpoint scope, logout revocation, and slow-reader
  cross-room isolation.
- Exact promoted cold target: `PROMOTE_EVIDENCE=1
  E1_T05_IMPLEMENTATION_COMMIT=2d30a94118d0df72c7b1aa45757de517b47e7f2e
  TEST_RUN_ID=promoted-e1-t05-repair make verify-E1-T05`. Format, lint, typecheck, 107 unit
  tests, 5 Playwright tests, build, fresh emulator, and real two-client scenario passed.
  The final digest is `sha256:0e7d26ed4c3cf2cf161236ef335a503599c66fd93e523255e13ce562c93ea84b`; both
  clients converged at `0000000000000000_0000000000001426`, and the reconnect delivered
  only the missed second message. The cold bootstrap transcript is committed in
  `evidence/e1-t05-final/cold-clone-transcript.json`.
- Additional live evidence: an idle sibling room received no cross-room event, and a
  logged-out Ada connection terminated with `LIVE_SESSION_REVOKED`. Promoted files are
  `verification-summary.json`, `network-transcript.json`, `idle-request-budget.json`, and
  `cold-clone-transcript.json` under `evidence/e1-t05-final/`. Replay: N/A (server
  live-delivery API) + mitigation: real-emulator network transcript, reconnect matrix,
  request counts, digest convergence, and focused authorization/backpressure tests.
- Claim: the prior evidence gap is closed and the typed stale-checkpoint and logout paths
  are now proven against the implementation commit; awaiting a fresh independent critic.

### Builder — 2026-08-03 — archive and boundary repair complete

- Repair commit: `c0d0901b96a8ecd3a2ebcc2cc2d816c4b58cb2a4` (`E1-T05: enforce archived
  channel live revocation`). The chat stream now treats the durable `chat.room.archived`
  fact as channel-status authority, skips it as a message, and closes the live client with
  typed `LIVE_CHANNEL_ARCHIVED` at its last acknowledged checkpoint. Production revalidation
  checks both the fenced workspace membership and authoritative room status; the HTTP archive
  command appends the durable status fact.
- Focused boundary coverage now includes archive revocation, disconnect after message write
  before status acknowledgement, disconnect during heartbeat, and sibling-workspace event
  checkpoint refusal. The verifier's real-emulator transcript includes archive closure,
  cross-room isolation, logout closure, reconnect suffix delivery, and digest convergence.
- Exact promoted cold target: `PROMOTE_EVIDENCE=1
  E1_T05_IMPLEMENTATION_COMMIT=c0d0901b96a8ecd3a2ebcc2cc2d816c4b58cb2a4
  TEST_RUN_ID=promoted-e1-t05-archive-repair make verify-E1-T05`. Format, lint, typecheck, 111
  unit tests, 5 Playwright tests, build, fresh emulator, and the real two-client scenario
  passed. The final digest is
  `sha256:0f5a01ff6e361489c031f06cfac197148e5b07c02b06f7089ec4687bab480b0f`; both clients
  converged at `0000000000000000_0000000000001458`, and the archive terminal checkpoint is
  `0000000000000000_0000000000000733`.
- Promoted evidence is under `evidence/e1-t05-final/`: `verification-summary.json`,
  `network-transcript.json`, `idle-request-budget.json`, and `cold-clone-transcript.json`.
  The idle budget records 1 subscription directory read, 90 workspace revalidations, 90
  channel-status reads, 1 bounded snapshot read, and 1 live follow across 900,000
  deterministic milliseconds. Replay: N/A (server live-delivery API) + mitigation:
  real-emulator network transcript, reconnect matrix, request counts, digest convergence,
  and focused authorization/backpressure tests.
- Claim: channel archive and all critic-identified live boundary gaps are now implemented
  and evidenced against the exact repair commit; awaiting a fresh independent critic.

### Builder — 2026-08-03 — archive reconnect authority repair complete

- Repair commit: `a34ac48bc18a21c4d73ba5c936fa4f584542e196` (`E1-T05: close archive
  reconnect authority gap`). Every live connection now performs the room-status check before
  SSE headers, including resumed checkpoints after the archive fact. The check shares one
  revalidator between production and the request-budget harness; it avoids recursively
  reacquiring the workspace fence already held by subscription authorization. Archive is
  manager-only through `workspace.channel.manage`, and the chat service rejects message,
  edit, and reset mutations after the durable archive fact.
- The focused verifier adds the previously missing reconnect-after-archive and
  post-archive-write attacks. The real emulator returned `409 LIVE_CHANNEL_ARCHIVED` for a
  post-archive checkpoint and `409 CHAT_ROOM_ARCHIVED` for a post-archive message; the live
  client still terminated with `LIVE_CHANNEL_ARCHIVED` at its acknowledged checkpoint.
- Exact promoted cold target: `PROMOTE_EVIDENCE=1
  E1_T05_IMPLEMENTATION_COMMIT=a34ac48bc18a21c4d73ba5c936fa4f584542e196
  TEST_RUN_ID=promoted-e1-t05-archive-reconnect make verify-E1-T05`. Format, lint, typecheck,
  112 unit tests, 5 Playwright tests, build, fresh emulator, and the real two-client scenario
  passed. The final digest is
  `sha256:46c9c0a5b2e891f9c5f65f2d998026c48dee1be2d212648fa0a773068bbcb2cd`; both clients
  converged at `0000000000000000_0000000000001470`, and the archive terminal checkpoint is
  `0000000000000000_0000000000000739`.
- Promoted evidence is under `evidence/e1-t05-final/`: `verification-summary.json`,
  `network-transcript.json`, `idle-request-budget.json`, and `cold-clone-transcript.json`.
  The idle budget records one authorized subscription, 90 workspace membership
  revalidations, 91 authoritative room-status reads (one at open plus 90 heartbeats), one
  bounded snapshot read, one live follow, and zero polling calls across 900,000 deterministic
  milliseconds. Replay: N/A (server live-delivery API) + mitigation: real-emulator network
  transcript, reconnect matrix, request counts, digest convergence, and focused tests.
- Claim: the archive reconnect authority bypass and post-archive mutation path are closed
  against the exact repair commit; awaiting a fresh independent critic.

### Builder — 2026-08-03 — workspace fence repair complete

- Repair commit: `b4dc236c5aed39fbb36abe5afe001b26d43a7057` (`E1-T05: release workspace
  fence before live delivery`). Workspace subscription authorization now completes its
  fenced membership check before registering the long-lived HTTP delivery. The delivery then
  performs its own open workspace and room-status revalidation, so a slow initial socket
  cannot hold the workspace fence while waiting for drain.
- A real-fence unit attack proves an unrelated workspace read completes while another SSE
  client is non-draining. The real emulator also passed archive reconnect refusal,
  post-archive mutation refusal, logout closure, cross-room isolation, and digest convergence.
- Exact promoted cold target: `PROMOTE_EVIDENCE=1
  E1_T05_IMPLEMENTATION_COMMIT=b4dc236c5aed39fbb36abe5afe001b26d43a7057
  TEST_RUN_ID=promoted-e1-t05-fence-repair make verify-E1-T05`. Format, lint, typecheck,
  113 unit tests, 5 Playwright tests, build, fresh emulator, and the real two-client scenario
  passed. The final digest is
  `sha256:e2323b11e208a2a69d89fd3db860857b45548f12208209e36762c44d98e5bd04`; both clients
  converged at `0000000000000000_0000000000001450`, and the archive terminal checkpoint is
  `0000000000000000_0000000000000729`.
- Promoted evidence is under `evidence/e1-t05-final/`. Its idle budget records one
  subscription check, 91 workspace checks, 91 room-status reads, one message snapshot, one
  follow, and no additional message-delivery calls while idle; the polling positive control
  remains sensitive. Replay: N/A (server live-delivery API) + mitigation: real-emulator
  network transcript, reconnect matrix, request counts, digest convergence, and focused
  authorization/backpressure tests.
- Claim: the workspace-fence slow-reader bypass is closed against the exact repair commit;
  awaiting a fresh independent critic.

### Builder — 2026-08-02 — stream accounting repair complete

- Repair commit: `a228ee99bada05eade5c8168fb25ab9034d15a14` (`E1-T05: account for
  authorization stream reads`). The idle request probe now delegates room-status checks to
  the real `createChatService.readRoomStatus` implementation and counts its underlying
  Durable Stream reads through the fake stream store. Evidence distinguishes the HTTP
  message-delivery budget from the authorization/status reads required by the open check and
  90 deterministic heartbeats.
- Exact promoted cold target: `PROMOTE_EVIDENCE=1
  E1_T05_IMPLEMENTATION_COMMIT=a228ee99bada05eade5c8168fb25ab9034d15a14
  TEST_RUN_ID=promoted-e1-t05-stream-accounting make verify-E1-T05`. Format, lint, typecheck,
  113 unit tests, 5 Playwright tests, build, fresh emulator, and the real two-client scenario
  passed. The final digest is
  `sha256:b65a0aa4a8c964817a76aaa77597682ae3947fbbacacf12f913e916bde3d9ff3`; both clients
  converged at `0000000000000000_0000000000001470`, and the archive terminal checkpoint is
  `0000000000000000_0000000000000739`.
- Promoted idle evidence records 91 authorization reads, 92 directory reads, 91 room-status
  reads, 2 Durable Stream reads before logical time advances, 92 afterward, and a delta of 90
  status reads matching the 90 heartbeat executions. Message-delivery reads/follows remain
  constant at one each with zero polling calls. The real emulator also proved archive
  reconnect refusal (`409 LIVE_CHANNEL_ARCHIVED`), post-archive mutation refusal
  (`409 CHAT_ROOM_ARCHIVED`), logout closure, cross-room isolation, opaque-checkpoint resume,
  and digest convergence. Replay: N/A (server live-delivery API) + mitigation: real-emulator
  network transcript, reconnect matrix, request counts, digest convergence, and focused
  authorization/backpressure tests.
- Claim: the idle-budget evidence now measures the actual authorization stream path and the
  implementation commit is ready for a fresh independent critic.
