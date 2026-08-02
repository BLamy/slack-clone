---
id: E0-T03
epic: 0
title: "Official Durable Streams adapter with resumable reads"
priority: 3
status: implemented
depends_on: [E0-T02]
estimate: L
capstone: false
---

## Goal

Replace ad hoc Durable Streams HTTP calls with one typed server-side adapter that creates,
appends, reads, and follows streams through the supported protocol, preserves opaque
offsets, and never exposes the stream administration credential to a browser or sandbox.

## Context

The current room loop issues a PUT and GET every 350 milliseconds, eventually exhausting
the emulator's request budget, and can route an error into a JSON handler after SSE headers
are committed. The emulator already provides resumable live reads and producer sequencing.
This adapter becomes the only application dependency allowed to speak directly to Durable
Streams; higher layers work in domain events and checkpoints.

## Deliverables

- A typed Durable Streams client adapter with create-once, append, bounded read, long-poll
  or SSE follow, cancellation, and opaque checkpoint support.
- Server-only credential configuration and a source audit forbidding direct client access.
- Protocol conformance fixtures for status codes, offsets, content types, retry responses,
  cancellation, and committed-stream errors.
- Request-count, resource-cleanup, and `make verify-E0-T03` cold-clone evidence.

## Acceptance criteria

- [x] `make verify-E0-T03` exits 0 against a freshly started emulator from a cold clone and
      captures the conformance transcript and request counts in `evidence/`.
- [x] A stream is created once, then followed through an official live-read mode; an idle
      room performs no 350-millisecond PUT/GET loop and stays below the frozen request cap.
- [x] Disconnect and resume from each captured opaque offset yields every accepted record
      exactly once at the application boundary with no offset parsing or arithmetic.
- [x] Cancellation closes upstream readers, timers, response bodies, and downstream SSE
      clients without `ERR_HTTP_HEADERS_SENT`, leaked handles, or a second response write.
- [x] Browser assets, API responses, logs, run artifacts, and environment manifests contain
      no Durable Streams administration token; a canary-token scan proves the claim.
- [x] A source scan permits network calls to the Durable Streams origin only inside the
      adapter package and its conformance harness.
- [x] Replay is declared `Replay: N/A (server transport adapter) + mitigation: real-emulator
      protocol transcript, request-budget proof, canary scan, and reconnect matrix`.

## Adversarial verification

1. Disconnect before headers, after headers, between records, and during cancellation. Any
   duplicate application record, missed record, leaked handle, or double response refutes
   the adapter.
2. Return malformed offsets, bodies, content types, retry headers, and partial frames from
   a protocol double; silent coercion refutes strict transport handling.
3. Plant the stream admin token in browser-visible configuration and a sandbox fixture. The
   canary/source audits must fail.
4. Count upstream requests across a fifteen-minute equivalent fake-clock run. Any linear
   idle polling or repeated create request refutes the live-read design.
5. Bypass the adapter with a direct `fetch` in a scratch module and prove the import/source
   guard goes red.

## Verification log

### Builder — 2026-08-01

- Implementation commit: `133779bdd2e519649fda2e2eff1361d96f68f9ca`.
- Final cold command: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e0-t03-builder-final make verify-E0-T03`.
- Gates: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`
  (35/35), `pnpm test:conformance`, `pnpm test:integration` (5/5),
  `pnpm test:concurrency` (1/1), and `pnpm build` all exited 0 against a freshly
  started emulator. The cold setup reported that the emulator prefers Node >=24 while
  this run used Node 23.11.0; installation, build, and all verification gates still passed.
- Protocol proof: `evidence/protocol-conformance.json` records create-once behavior, two
  consecutive live deliveries, strict malformed-response handling, and exact suffixes
  after resume from `-1` and each of five opaque checkpoints. The terminal stream digest
  is `sha256:b3f7f6af968c5a2729b25ec51c894d64cd01a2c8a5040054b0883553caed48f8`.
- Resource/request proof: `evidence/request-budget.json` records zero requests during a
  fifteen-minute logical idle interval, 20 total requests under the frozen cap of 24,
  one create request, and zero active followers or pending idle waiters after cancellation.
- Sensitivity/security proof: `evidence/canary-scan.json` detects all three positive
  controls and finds zero raw, URL-encoded, or base64 canary matches across browser/API,
  logs, environment manifests, and artifacts. `evidence/source-access-audit.json` scans
  48 files with zero violations; unit tests prove direct, aliased, computed, dynamic-import,
  and re-export bypass fixtures make the audit fail.
- Browser regression proof: `evidence/cold-verification.json` records room
  `e0-t03-builder-final-edit-1785632319871`, offset
  `0000000000000000_0000000000000543`, digest
  `sha256:13c273c402a4592d19f52fa9f736dc2f278a5d9f2b6d98f1f50f4b79cd88f4eb`,
  and `domMatchedApi: true`.
- Replay: N/A (server transport adapter) + mitigation: real-emulator protocol transcript,
  request-budget proof, canary scan, and reconnect matrix.
- Claim: at the cited commit, every application Durable Streams call crosses the typed
  server-only official-client adapter; create, append, bounded read, live follow, opaque
  resume, cancellation, strict transport failures, and committed-response cleanup satisfy
  the ticket criteria under the frozen cold verifier. A duplicate/missed resumed record,
  linear idle request growth, leaked follower/waiter, second response write, credential
  match, or source-audit bypass refutes this claim.
