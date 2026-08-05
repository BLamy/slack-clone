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

The configuration stream introduced by E2-T02 will be authoritative for revisions. This
ticket only defines and validates the portable payload. The provider registry is represented
as data in `AGENT_CONFIG_PROVIDER_REGISTRY`; E2-T05 can extend that registry without adding
provider-specific branches to orchestration.

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
and connection references); ordered guardrails remain ordered. `agentConfigDigest` hashes those
canonical UTF-8 bytes with SHA-256.

Version 0 is the only supported prior input. Its complete security policy is required and is
mapped by `upgradeAgentConfig` to v1 without inventing a permissive default. Missing version,
unknown versions, or a v0 payload missing any policy field fail closed.

Replay: N/A (server configuration schema) + mitigation: strict fixture corpus, canary-secret
refusals, upgrade matrix, and canonical config digests.
