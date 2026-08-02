# Fenced dispatch

`src/ledger/dispatch.mjs` is the application write door. Callers submit a strict
`DispatchRequest` with a workspace, authenticated actor, operation, idempotency key,
target stream, exact expected head, and canonical JSON payload. The door computes
`sha256(canonicalJson(logicalRequest))` over the actor, workspace, operation, key, stream,
and payload before any provider append; the expected head remains a separate append fence.
Authorization runs on every attempt.

An accepted operation produces a `DispatchReceipt` containing the request digest, event
digest, target stream, and provider checkpoint. The receipt is appended to the durable
`__stream_slack_dispatch_idempotency__` stream. The target event carries the same request
identity as metadata, so a process that loses its local acknowledgement can recover the
event and rebuild the receipt from Durable Streams without a cache acting as authority.

The target append sends the exact expected checkpoint as `Stream-Seq` and sends
`Producer-Id`, `Producer-Epoch`, and `Producer-Seq`. The adapter turns a provider conflict
into a stable stale-fence refusal. A duplicate producer response is a successful recovery
case, not a second logical event.

Validation and authorization happen before idempotency success lookup or append. A key
already bound to another canonical request, actor, workspace, operation, or stream is
refused. A retry may reread a newer expected head while retaining the same logical digest.
Cross-stream receipt persistence is an idempotent saga: the target event is
durable before its receipt is published, and a later retry reconciles the missing receipt.

Replay: N/A (server dispatch concurrency contract) + mitigation: real-HTTP race logs,
provider header transcript, lost-ack recovery, byte-level stream dumps, and cold-clone
verification.
