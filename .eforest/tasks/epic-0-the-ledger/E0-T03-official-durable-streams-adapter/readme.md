---
id: E0-T03
epic: 0
title: "Official Durable Streams adapter with resumable reads"
priority: 3
status: in-progress
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

- [ ] `make verify-E0-T03` exits 0 against a freshly started emulator from a cold clone and
      captures the conformance transcript and request counts in `evidence/`.
- [ ] A stream is created once, then followed through an official live-read mode; an idle
      room performs no 350-millisecond PUT/GET loop and stays below the frozen request cap.
- [ ] Disconnect and resume from each captured opaque offset yields every accepted record
      exactly once at the application boundary with no offset parsing or arithmetic.
- [ ] Cancellation closes upstream readers, timers, response bodies, and downstream SSE
      clients without `ERR_HTTP_HEADERS_SENT`, leaked handles, or a second response write.
- [ ] Browser assets, API responses, logs, run artifacts, and environment manifests contain
      no Durable Streams administration token; a canary-token scan proves the claim.
- [ ] A source scan permits network calls to the Durable Streams origin only inside the
      adapter package and its conformance harness.
- [ ] Replay is declared `Replay: N/A (server transport adapter) + mitigation: real-emulator
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
