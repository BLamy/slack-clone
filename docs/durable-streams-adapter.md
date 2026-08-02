# Durable Streams adapter

`@stream-slack/durable-streams` is the only application package allowed to address the
Durable Streams origin. It wraps the pinned official `@durable-streams/client@0.2.6` and
exposes a server-side store contract: create once, append, bounded read, live follow,
cancel, delete, and diagnostics. Services consume records and opaque checkpoints; they do
not construct provider URLs or issue provider requests.

The composition root supplies three capabilities: the provider base URL, a server-only
administration token, and `fetch`. `DURABLE_STREAMS_ADMIN_TOKEN` is preferred, with
`EMULATE_TOKEN` retained only as a local compatibility fallback. The token is used only in
the adapter's authorization header. It is never returned in API payloads, rendered into
browser assets, logged, or copied into evidence. Verification starts the app with a unique
canary token and scans raw, URL-encoded, and base64 forms across browser assets, API
responses, logs, run artifacts, and a redacted environment manifest.

## Checkpoints and live reads

Offsets are non-empty, bounded strings with no control characters. The adapter never
splits them, converts them to numbers, compares their numeric components, or performs
offset arithmetic. Reads pass the caller's checkpoint to the official client and return
the response checkpoint unchanged. The conformance matrix resumes at every captured
checkpoint and checks the exact expected suffix with no duplicate record IDs.

Browser SSE delivery takes one bounded snapshot before committing response headers, then
shares one official upstream SSE follow per active room. Subscriber callbacks provide
backpressure. The local emulator emits finite SSE responses, so the adapter parks an
up-to-date reader on an abortable wake gate instead of recreating the former 350 ms
PUT/GET loop. An append wakes the reader. Losing the last downstream client, resetting a
room, shutting down HTTP delivery, or closing the adapter cancels the upstream session and
drains its in-flight requests.

## Failure contract and evidence

Successful provider responses are checked for the expected media type and opaque
checkpoint before application code sees them. The SSE body wrapper also rejects a stream
that ends with a partial frame instead of allowing the official parser to discard it.
Malformed JSON, missing checkpoints, unexpected media types, exhausted retries,
cancellation, and append-after-close failures become `DurableStreamsAdapterError` values
with stable codes. A present `Retry-After` must be non-negative integer seconds or an IMF
HTTP date; malformed values become `INVALID_RETRY_AFTER` before the official client's
backoff layer can silently coerce them. HTTP delivery checks whether headers have committed
before sending JSON, preventing a late live-read failure from causing a second response
write.

`pnpm typecheck` runs `tools/audit-durable-streams-access.mjs`. It rejects imports of the
official client and direct requests to provider room streams outside this adapter and the
E0-T03 conformance harness, including destructured, assigned, bound, and chained fetch
aliases; it separately scans public assets for server credential references. The
request-budget gate drives the HTTP delivery timer boundary through
900,000 deterministic milliseconds and confirms that its single snapshot read and live
follow do not grow. A 350-millisecond polling positive control executes 2,571 reads over
the same clock and must be rejected, proving the detector can go red.

`make verify-E0-T03` performs the cold install and emulator build before the format, lint,
static, unit, real-emulator conformance, browser integration, concurrency, and build gates.
Generated proof stays under `.artifacts/e0-t03/<run-id>/`; a builder may set
`PROMOTE_EVIDENCE=1` only from a clean tracked tree. Promotion stamps the exact HEAD commit
into every redacted conformance, request-budget, canary, source-audit, and cold-verification
artifact copied into the ticket's committed `evidence/` directory.

Replay: N/A (server transport adapter) + mitigation: real-emulator protocol transcript,
request-budget proof, canary scan, reconnect matrix, and deterministic cancellation tests.
