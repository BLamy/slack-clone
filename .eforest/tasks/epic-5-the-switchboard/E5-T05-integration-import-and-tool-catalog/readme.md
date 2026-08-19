---
id: E5-T05
epic: 5
title: "Service onboarding: import integrations into a versioned searchable tool catalog"
priority: 505
status: pending
depends_on: [E5-T02]
estimate: L
capstone: false
---

## Goal

Administrators can onboard a service by importing a pinned OpenAPI or curated integration
manifest into a versioned catalog of connections, operations, input/output schemas, risk
metadata, and required secret purposes. Import never executes a service request and
produces deterministic catalog bytes from the same source artifact.

## Context

This is the executor.dev-like onboarding seam: connect a service once, then let agents
discover narrowly described tools instead of receiving raw tokens or arbitrary HTTP.
Catalog versions are immutable so an invocation cannot see a changed schema halfway
through a run.

## Deliverables

- `packages/tool-catalog` importer, canonicalizer, reducer, search index, and manifest
  validation corpus.
- Curated manifest format plus constrained OpenAPI import with explicit operation allowlist.
- `make verify-E5-T05` with duplicate, hostile, oversized, and evolving specs.

## Acceptance criteria

- [ ] `make verify-E5-T05` passes cold and imports each frozen source twice to byte-identical
      catalog events, derived search index, and version digest.
- [ ] Each operation freezes id, method/action, target template, input/output JSON Schema,
      risk class, read/write effect, required connection purposes, and human description.
- [ ] Import rejects remote `$ref`, executable extensions, ambiguous auth, undeclared
      servers, templated hosts, duplicate ids, unbounded bodies, and operations outside the
      administrator's explicit allowlist.
- [ ] Source credentials, example tokens, and secret-shaped examples are rejected rather
      than copied into catalog or search data.
- [ ] Updating a source creates a new immutable catalog version; captured invocations keep
      the prior version, and a deterministic diff names added/removed/changed operations.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (server-side integration
      importer) + mitigation: cold-clone canonical import, hostile-spec corpus, catalog
      digest parity, and mutation sensitivity`.

## Adversarial verification

1. Import specs with remote refs, cyclic schemas, billion-laughs-style expansion, method/
   host smuggling, duplicate ids, and secret examples. Any network fetch or accepted
   ambiguity is a finding.
2. Reorder semantically identical source documents and vary locale/timezone. Catalog bytes
   and digest must remain identical.
3. Change a catalog after invocation capture. Search/describe for that run must remain on
   the pinned version.
4. Remove one forbidden-extension check in a scratch worktree. Its corpus specimen must
   make the verifier red.

## Verification log
