# Agent configuration contract

`AgentConfig` is portable policy data. It selects a registered harness and sandbox by
provider ID and exact version, but it does not contain provider-owned settings, credentials,
environment variables, shell text, or a connection object. The runtime contract is exported
from `@stream-slack/protocol`; the structural JSON Schema is
`packages/protocol/src/schemas/agent-config.v1.schema.json`.

## Authority map

| Field              | Authority and meaning                                                                     | Explicit boundary                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `schemaVersion`    | Protocol owns the version fence.                                                          | Unknown and future versions fail closed.                                                                |
| `instructions`     | Agent owner supplies bounded instruction text and ordered guardrails.                     | Secret-shaped values and control characters are refused.                                                |
| `context`          | Workspace policy supplies the maximum authorized context shape and byte/message ceilings. | `none` is all-zero; private context is a request, not an ACL bypass.                                    |
| `trigger`          | Workspace policy selects durable trigger facts accepted by later dispatch.                | Only registered `mention` and `manual` triggers exist in v1.                                            |
| `delegation`       | Workspace policy bounds recursion depth, fan-out, and cross-channel reach.                | Disabled delegation must have zero limits; cross-channel reach requires workspace scope.                |
| `concurrency`      | Dispatcher policy bounds total and per-channel runs.                                      | Serialized channels have exactly one active run.                                                        |
| `budgets`          | Workspace policy bounds wall time, input/output/total tokens, and cost cents.             | Positive safe integers only; total token budget covers both ceilings.                                   |
| `harness`          | Provider registry supplies the allowed provider IDs, versions, and capabilities.          | No provider settings or inline tokens are accepted.                                                     |
| `sandbox`          | Provider registry supplies the allowed sandbox and lifecycle capabilities.                | `networkPolicy` is explicit `deny-all`; startup/bootstrap fields are not schema fields.                 |
| `workspaceInputs`  | Workspace policy names a source and normalized relative paths with a byte ceiling.        | No absolute paths, traversal, arbitrary mounts, or environment maps.                                    |
| `connectionGrants` | Later connection control plane owns the grant and revision references.                    | Every reference requires `connectionId`, `grantId`, `revision`, and purpose; values are never embedded. |

The configuration stream in E2-T02 is authoritative for revisions. The provider registry is
represented as versioned descriptors in `@stream-slack/protocol`; `AgentConfig` validation queries
that descriptor registry directly. A runnable configuration must then call
`resolveAgentConfigProviders`, which validates provider-owned settings, readiness, and reciprocal
compatibility before returning immutable provider snapshots and digests. E2-T05 resolves exact
provider snapshots without adding provider-specific branches to orchestration.

## Revision stream

Each agent owns `agent:<agentId>/config`. The stream stores envelope records with the canonical
event digest and never stores a resolved credential. Revision events are
`agent.config.created`, `agent.config.revised`, `agent.config.activated`,
`agent.config.disabled`, and `agent.config.retired`; their strict payload schemas live in
`packages/protocol/src/schemas/agent-config-events.v1.schema.json`.

Create and revise events carry the normalized config, its `configDigest`, a deterministic
`revisionId`, and both the expected and predecessor revision IDs. The reducer records the
immutable revision manifest with actor, event ID, and source offset, while lifecycle events only
change the derived runnable state. Revisions are appended; they are never replaced in place.

Every append reads the stream head and supplies that opaque offset as Durable Streams `Stream-Seq`.
If two writers use the same expected predecessor, provider CAS accepts one append and maps the
loser to a stable stale-revision refusal. Replaying from offset `-1` reconstructs the full history,
active revision, and runnable status without a mutable configuration row or process cache.

The lifecycle is `draft -> active -> disabled -> active` with `retired` terminal; a revision may
be prepared while active or disabled, but it cannot become runnable until an explicit activation.
Disabled and retired states always expose `runnable: false`.

## Threat model

The persisted configuration is treated as attacker-controlled input. Unknown fields are not
ignored because an ignored field can become an accidental capability when a later provider
reads it. The validator rejects forbidden field names such as `environment`, `token`,
`providerSettings`, and `startupCommand`, and scans every persisted string for common bearer,
API-key, private-key, JWT, and secret-assignment shapes. Connection grants are references only;
the broker owns all credential values and request policy.

The validator also rejects prototype-sensitive objects, accessor fields, symbol fields, sparse
or custom-property arrays, non-safe integers, invalid enums, unknown providers and versions,
duplicate unordered values, path traversal, and contradictory policy combinations. Canonical
encoding sorts only unordered arrays (`trigger.events`, provider capabilities, workspace paths,
and connection references) with deterministic UTF-16 code-unit ordering; ordered guardrails
remain ordered. `agentConfigDigest` hashes those canonical UTF-8 bytes with SHA-256.

Version 0 is the only supported prior input. Its complete security policy is required and is
mapped by `upgradeAgentConfig` to v1 without inventing a permissive default. Missing version,
unknown versions, or a v0 payload missing any policy field fail closed.

Replay: N/A (server configuration schema) + mitigation: strict fixture corpus, canary-secret
refusals, upgrade matrix, and canonical config digests.
