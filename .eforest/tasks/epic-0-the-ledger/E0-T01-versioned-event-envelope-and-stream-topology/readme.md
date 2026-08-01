---
id: E0-T01
epic: 0
title: "Versioned event envelope and authoritative stream topology"
priority: 1
status: implemented
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

### Builder — 2026-08-01

- Exact implementation commit:
  `3974930495021b6f6eae8a0cc08716ec9a77ef08`.
- Gates: `make verify-E0-T01` passed 9 checks with zero skipped; `pnpm test:ledger`
  passed 6/6; and `pnpm test` passed the same 6 ledger tests plus 4/4 Playwright
  tests against the Auth0 and Durable Streams emulators.
- Cold clone: `git clone --no-hardlinks . <ticket-work>/repo`, detached checkout of the
  exact implementation commit, `make verify-E0-T01` PASS, and `pnpm test:ledger` 6/6.
- Canonical evidence: `evidence/canonical-parity.json` records envelope digest
  `sha256:4947425de8918cc240bee9704f7d9b6eaa57253f6bca047cc318f97b0d4c276a`;
  `evidence/refusal-stream-dumps.json` records zero append calls and byte-identical
  before/after dumps for every rejected golden fixture.
- Adversarial evidence: `evidence/attack-matrix.json`,
  `evidence/digest-sensitivity.json`, and `evidence/source-refusals.json`. In a
  disposable clone of the exact implementation commit, disabling the envelope version
  fence made `make verify-E0-T01` fail with exit 2 at `tools/verify-e0-t01.mjs:148`, as
  recorded in `evidence/verifier-sensitivity.json`.
- Replay: N/A (server/CLI schema contract) + mitigation: canonical fixtures, refusal
  dumps, digest parity, and cold-clone verification.
- Claim: at the exact implementation commit, every event reaching the append callback
  has a registered v1 envelope, canonical bytes and digest, validated tenant-safe stream
  name, and complete canonical source references; any malformed golden or adversarial
  input is rejected before append. A cold clone or independent mutation that violates
  any of those properties refutes this claim.
