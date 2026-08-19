# Stream topology v1

Durable Streams are the authority for Stream Slack facts. Process memory, databases,
search indexes, caches, provider state, and browser state are projections or external
observations; none may become an undeclared source of truth.

## Identifier and naming policy

Identifiers use lowercase ASCII Crockford-base32 tokens with explicit type prefixes.
Workspace-scoped IDs embed the exact workspace token. Builders validate the supplied
workspace and scoped resource together before producing a name. They never lowercase,
Unicode-normalize, percent-decode, trim, or replace bytes. Traversal text, separators,
case variants, confusables, malformed lengths, and a resource ID owned by a sibling
workspace are refused.

Only the builders exported by `src/ledger/topology.mjs` may create stream names. Parsed
names must round-trip to one of these exact forms:

| Logical stream | Canonical name | Authoritative facts | Rebuild procedure |
| --- | --- | --- | --- |
| Workspace directory | `workspace:<workspaceId>/directory` | principals, channels, memberships, roles, references | replay from offset `-1` through the versioned directory reducer |
| Channel | `channel:<channelId>` | messages, revisions, threads, reactions, structured mentions | replay from offset `-1` through the channel reducer |
| Agent configuration | `agent:<agentId>/config` | immutable config revisions, lifecycle, provider references | replay from offset `-1`; select the latest valid revision without mutating history |
| Workspace invocations | `workspace:<workspaceId>/invocations` | deterministic invocation requests, admission, and queue facts | replay from offset `-1`; recompute invocation IDs from cited source references |
| Run | `run:<runId>` | leases, attempts, harness/tool/approval/artifact/cost/terminal facts | replay from offset `-1` with fencing checks; provider state is only reconciled observation |
| Connection configuration | `connection:<connectionId>/config` | service metadata, SecretRefs, policy and grant revisions | replay from offset `-1`; secret values are never events |
| Workspace audit | `workspace:<workspaceId>/audit` | security and administration decisions that require an immutable workspace trail | replay from offset `-1` into the audit view |
| Derived projection checkpoint | `projection:<projectionId>` | optional versioned checkpoints and rebuild cursors, never domain authority | discard it and replay its declared source streams from offset `-1` |

## Source references and cross-stream effects

A complete source reference is the tuple `{ stream, offset, digest }`. The stream must
be a canonical v1 name in the same workspace, the offset is two lowercase 64-bit hex
words, and the digest is a lowercase SHA-256 reference over canonical source bytes.
Partial references are invalid and are refused before append.

Cross-stream work is an idempotent saga, not a transaction. A reconciler reads one
source event, derives a deterministic effect or idempotency ID from the complete source
reference and policy revision, appends the target fact idempotently, and records progress
so it can retry until complete. No database row, in-memory map, provider request, or Git
commit may stand in for either source or target stream history.

## Derived indexes

Roster lists, channel lists, unread counts, search documents, run queues, presence,
metrics, and UI caches are disposable. Each index declares its source stream set,
envelope versions, reducer version, and last complete source offset. Rebuild means delete
the index, read every declared source from offset `-1`, validate and reduce events in
order, and compare its canonical digest with a live reduction before serving it.

Unknown envelope versions and event types stop reduction with typed errors. They are not
skipped, coerced, or treated as empty facts.
