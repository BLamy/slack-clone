# Durable Streams adapter

`@stream-slack/durable-streams` is the only application package allowed to address the
Durable Streams origin. It wraps the pinned official `@durable-streams/client@0.2.6` and
exposes a server-side store contract: create once, append, bounded read, live follow,
cancel, delete, and diagnostics. Services consume records and opaque checkpoints; they do
not construct provider URLs or issue provider requests.

The composition root supplies the provider base URL and a server-only administration
token through `createNodeDurableStreamsStore`; the adapter package captures the Node
`fetch` capability inside its own network door. `DURABLE_STREAMS_ADMIN_TOKEN` is preferred, with
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
gives each authenticated client its own official upstream SSE follow from the client's
opaque acknowledged checkpoint. Subscriber callbacks provide backpressure and SSE `id`
frames are emitted only for snapshot/status acknowledgements, so a reconnect resumes from
the last complete logical batch rather than skipping a partially delivered batch. The local
emulator emits finite SSE responses, so each adapter follow parks an up-to-date reader on an
abortable wake gate instead of recreating the former 350 ms PUT/GET loop. An append wakes
the relevant readers. Slow readers are serialized behind bounded per-client buffers and
receive typed terminal/resync events; membership and session authorization are revalidated
before delivery and heartbeat. Losing a downstream client, resetting a room, shutting down
HTTP delivery, or closing the adapter cancels only the affected upstream session and drains
its in-flight requests.

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
official client and acquisition of ambient network capabilities outside declared transport
doors. The provider door is this adapter plus the E0-T03 conformance harness. Auth0 uses an
origin-fenced client, and browser requests use a same-origin `/api/` door that refuses
absolute, cross-origin, credentialed, fragment, and non-API targets; neither door may
reference the Durable Streams provider or export raw network capabilities. The composition
root supplies the provider origin as Auth0's required reserved role; equal origins fail
before any credentialed request.

The audit is an explicit module contract, not a general-purpose target-taint analysis.
Runtime modules reject constructor/eval recovery, browser-global escape roots, remote
modules, Node network and DNS builtins, CommonJS and dynamic loaders, and
`process.getBuiltinModule` outside the provider door. The application, Auth0, and inbound
HTTP doors have exact export surfaces; the inbound door may import only named
`createServer`. These syntax/import/export rules reject capability acquisition before
later defaults, getters, inheritance, collections, proxies, reflection, or tagged
selectors can obscure it. Public assets are separately scanned for server credential
references. The
request-budget gate drives the HTTP delivery timer boundary through
900,000 deterministic milliseconds and confirms that its single snapshot read and live
follow do not grow. The production-shaped authorization path is included: one subscription
membership read and one membership revalidation per ten-second heartbeat (90 over the
window), with no additional chat snapshot/follow calls. A 350-millisecond polling positive
control executes 2,571 reads over the same clock and must be rejected, proving the detector
can go red.

`make verify-E0-T03` performs the cold install and emulator build before the format, lint,
static, unit, real-emulator conformance, browser integration, concurrency, and build gates.
Generated proof stays under `.artifacts/e0-t03/<run-id>/`; a builder may set
`PROMOTE_EVIDENCE=1` only from a clean tracked tree. Promotion stamps the exact HEAD commit
into every redacted conformance, request-budget, canary, source-audit, and cold-verification
artifact copied into the ticket's committed `evidence/` directory.

Replay: N/A (server transport adapter) + mitigation: real-emulator protocol transcript,
request-budget proof, canary scan, reconnect matrix, and deterministic cancellation tests.
