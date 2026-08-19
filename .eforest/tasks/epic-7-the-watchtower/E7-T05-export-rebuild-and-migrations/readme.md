---
id: E7-T05
epic: 7
title: "Export, rebuild, and migrations: a tenant can reconstruct every projection from versioned stream history"
priority: 705
status: pending
depends_on: [E7-T01]
estimate: L
capstone: false
---

## Goal

The server exports a tenant-scoped, manifest-hashed stream bundle and rebuilds all chat,
agent, run, connection, catalog, policy, cost, and audit projections from offset `-1`.
Versioned migrations are deterministic pure transforms with resumable checkpoints and
rollback-by-rebuild, never in-place history edits.

## Context

Durable Streams replaces a distributed database only if operators can recover, migrate,
and prove parity without hidden side tables. Secrets remain broker-owned: exports contain
SecretRefs and redacted audit metadata, never credential values or provider bearer data.

## Deliverables

- Export manifest/bundle format, tenant authorization, checksums, and resumable reader.
- Projection rebuild orchestrator, migration registry, compatibility windows, and parity
  report.
- `make verify-E7-T05` with historical-version, interruption, corruption, and isolation
  fixtures.

## Acceptance criteria

- [ ] `make verify-E7-T05` passes cold and exports/rebuilds each fixture twice to identical
      bundle bytes, per-stream digests, projection digests, and parity report.
- [ ] The export manifest freezes tenant, stream ids/types, offset ranges, event counts,
      schema versions, per-stream hashes, bundle hash, and tool version; corrupt/truncated/
      extra bytes fail before projection publication.
- [ ] Rebuild starts from empty projections, reads only exported/canonical events, and
      exactly matches independently queried live digests for every model and derived index.
- [ ] Migrations are ordered, content-addressed, idempotent pure transforms; interruption
      resumes from a verified checkpoint and rollback rebuilds with the prior compatible
      registry without mutating source history.
- [ ] Cross-tenant streams, raw credentials, broker identities, cookies, and secret values
      are absent; unauthorized/foreign export attempts reveal no stream existence.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (headless export/rebuild
      tooling) + mitigation: cold-clone byte-identical bundles, full projection parity,
      corruption/interruption matrix, migration sensitivity, and secret scans`.

## Adversarial verification

1. Corrupt, truncate, reorder, duplicate, splice cross-tenant, and append unknown-version
   events. Rebuild must fail before visible projection state changes.
2. Interrupt export/migration/rebuild at every checkpoint and resume on another process.
   Final bytes/digests must match uninterrupted execution.
3. Delete every materialized view before rebuild. Any dependency on a hidden table/cache
   or external state is a refutation.
4. Make one migration nondeterministic in a scratch worktree. Repeated bundle parity must
   turn red.

## Verification log
