---
id: E2-T01
epic: 2
title: "Versioned agent configuration schema without embedded secrets"
priority: 201
status: in-progress
depends_on: [E1]
estimate: M
capstone: false
---

## Goal

Freeze the versioned configuration contract that selects how an agent is instructed,
triggered, contextualized, budgeted, connected to services, paired with a harness, and run
inside a sandbox without embedding provider logic or secret values.

## Context

An agent is already a principal and channel member from Epic 1. Its execution configuration
is separate, revisioned state. The portable core names provider IDs and capability
requirements; provider-owned settings are validated by registered schemas in E2-T05.
Connection grants and credential bindings are references only. Arbitrary environment maps,
shell bootstrap text, or plaintext credentials would bypass the later broker boundary and
are forbidden.

The initial contract includes instructions, permitted context scope, trigger/delegation
policy, concurrency, timeout, token and cost budgets, harness selection, sandbox selection
and lifecycle, workspace inputs, and connection-grant references.

## Deliverables

- Versioned `AgentConfig` and nested policy schemas with canonical encoding.
- Strict valid/invalid fixture corpus, upgrade hooks, and secret-shaped canary cases.
- Configuration threat model and field-level authority documentation.
- `make verify-E2-T01` cold-clone target and schema evidence.

## Acceptance criteria

- [ ] `make verify-E2-T01` exits 0 from a cold clone and records canonical fixture bytes,
      refusal codes,
      and per-version schema digests with zero skipped cases.
- [ ] The schema expresses harness and sandbox provider IDs/versions, instructions, context,
      trigger/delegation, concurrency, lifecycle, timeout, token/cost, workspace-input, and
      connection-grant policies without provider-specific orchestration branches.
- [ ] Raw secret values, arbitrary environment maps, unrestricted startup commands, inline
      provider tokens, and unversioned connection objects are impossible or explicitly
      rejected by the persisted schema.
- [ ] Unknown fields, provider IDs, schema versions, enum values, invalid budgets, and
      contradictory policies fail with stable typed paths instead of being ignored.
- [ ] Encoding the same configuration twice is byte-identical; one semantic field change
      changes its SHA-256 digest.
- [ ] Upgrading every supported prior fixture is deterministic and never fills a security
      field with a permissive default.
- [ ] Replay is declared `Replay: N/A (server configuration schema) + mitigation: strict
      fixture corpus, canary-secret refusals, upgrade matrix, and canonical config digests`.

## Adversarial verification

1. Place credential canaries in every string, map, provider-settings, instructions-adjacent,
   and workspace-input location. Any accepted secret-bearing execution field refutes the
   configuration boundary.
2. Fuzz negative, fractional, overflowing, missing, and mutually contradictory resource and
   recursion budgets. Silent coercion refutes strict policy.
3. Submit unknown providers and future schema versions. Permissive fallback to a runnable
   provider refutes fail-closed negotiation.
4. Reorder maps and arrays where order is non-semantic. Digest drift refutes canonicalization;
   lost semantic order refutes the schema.
5. Relax unknown-field validation in a scratch worktree; the fixture verifier must fail.

## Verification log
