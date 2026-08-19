---
id: E0-T01
epic: 0
title: "Versioned event envelope and authoritative stream topology"
priority: 1
status: pending
depends_on: []
estimate: M
capstone: false
---

## Goal

Freeze the canonical envelope, identifiers, and stream naming policy that every later
workspace, chat, agent, run, connection, and projection event uses. Durable Streams are
the source of truth; process maps, query indexes, and provider control planes may cache or
project state but can never become an undeclared authority.

## Context

The current room stream stores unversioned message-shaped objects. Adding agents on top of
that shape would make identity, causation, tenancy, retries, and migrations ambiguous. The
envelope must carry a stable event ID, schema version, event type, workspace and actor IDs,
server-issued timestamp, causation/correlation references, and idempotency identity. Stream
names are derived from validated IDs, never raw user paths.

Cross-stream workflows are explicitly sagas. A source event is referenced by stream,
offset, and digest; no later task may claim multi-stream atomicity that Durable Streams do
not provide.

## Deliverables

- Versioned schemas and canonical encoders for the event envelope and source references.
- A documented topology for workspace directory, channel, agent-config, invocation/run,
  connection, audit, and rebuildable projection streams.
- Valid and invalid golden fixtures, including forward-version and malformed-ID cases.
- A deterministic verifier and `make verify-E0-T01` cold-clone target.

## Acceptance criteria

- [ ] `make verify-E0-T01` exits 0 from a cold clone with zero skipped checks and records
      the exact command output under this task's `evidence/` directory.
- [ ] Encoding the same logical event twice produces byte-identical canonical JSON and
      SHA-256 digest on every supported runtime.
- [ ] Unknown schema versions, unknown event types, invalid IDs, client-supplied server
      timestamps, and incomplete source references are refused before append with stable
      typed errors.
- [ ] Every rejected fixture leaves a captured before/after stream dump byte-identical.
- [ ] Stream names built from traversal text, separators, Unicode confusables, or sibling
      workspace IDs are rejected rather than normalized into an existing stream.
- [ ] The topology document names the authoritative source and rebuild procedure for every
      derived index and explicitly defines cross-stream work as an idempotent saga.
- [ ] Replay is declared `Replay: N/A (server/CLI schema contract) + mitigation: canonical
      fixtures, refusal dumps, digest parity, and cold-clone verification`.

## Adversarial verification

1. Mutate each envelope field independently, including type confusion, extra keys, integer
   overflow, invalid UTF-8 representations, and future versions; any accepted malformed
   record refutes the boundary.
2. Generate colliding-looking workspace and actor IDs with case, normalization, separators,
   and confusables. Any two inputs resolving to one authority refutes stream isolation.
3. Flip one byte in every golden event. The digest must change or decoding must fail.
4. Remove the version or source-offset validation in a scratch worktree and prove the
   verifier goes red; a green sabotage run refutes test sensitivity.

## Verification log
