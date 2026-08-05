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

### Builder — 2026-08-05 — initial implementation and cold proof (superseded)

- Exact implementation commit: `846de0f76b216a77ac2eb2832ed67171ffdfab7f`.
- Exact cold command:
  `PROMOTE_EVIDENCE=1 E2_T01_IMPLEMENTATION_COMMIT=846de0f76b216a77ac2eb2832ed67171ffdfab7f
  TEST_RUN_ID=e2-t01-cold-final make verify-E2-T01`.
  The detached checkout was clean before install, hydrated the pinned emulator, and passed
  `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`; all child
  commands exited 0 and `skips: []`.
- The canonical v1 fixture encodes to 1,221 UTF-8 bytes with digest
  `sha256:f49949d51b54b76e1d72b3114607cfc9200454156b26e57b936c0b5a14c65309`. Reordered
  unordered arrays preserve bytes; one semantic budget change changes the digest. The v0
  upgrade is deterministic and invents no security defaults.
- The verifier records 15 typed refusal cases, including forbidden environment/startup fields,
  secret-shaped instructions, unknown provider/version/schema, invalid budgets, contradictory
  policies, and an unversioned connection reference. Fourteen canary placements across
  instructions, provider selections, workspace inputs, and connection references are all
  refused as `AGENT_CONFIG_SECRET_VALUE`.
- Sensitivity evidence mutates a disposable module copy to disable unknown-field rejection;
  the mutant accepts the environment attack and exits 7, proving the verifier detects the
  weakened boundary. Evidence is under `evidence/e2-t01-final/`.
- Replay: N/A (server configuration schema) + mitigation: strict fixture corpus, canary-secret
  refusals, upgrade matrix, and canonical config digests.
- Claim: the versioned AgentConfig contract, canonical encoding, upgrade hook, schema fixtures,
  threat model, and cold verifier satisfy the acceptance criteria; awaiting a fresh independent
  critic.

### Critic — 2026-08-05 — canonical ordering refutation

- `VERDICT: refuted` from a fresh read-only Claude Code audit of implementation commit
  `846de0f76b216a77ac2eb2832ed67171ffdfab7f` and evidence commit `4b9d557`.
- Blocking finding: `compareConnectionRefs` used `localeCompare` on NUL-joined fields. The
  critic independently constructed two valid, semantically distinct grant references whose
  joined strings compare equal under ICU; stable sort therefore preserved input order and
  produced different canonical bytes/digests for the same unordered reference set.
- The committed valid fixture had an empty `connectionGrants.refs` array, and neither the unit
  test nor verifier exercised non-empty reference reordering. The claimed unordered-array parity
  evidence was therefore incomplete. No workspace edits were made by the critic.

The initial evidence artifacts and claim above are retained historically in commit `4b9d557`;
the evidence directory below was regenerated by the repair.

### Builder rework — 2026-08-05 — total canonical ordering and cold rerun

- Exact repair implementation commit: `444b5c392eee30e13f875126826dbcc3365ad9ea`.
- Exact cold command:
  `PROMOTE_EVIDENCE=1 E2_T01_IMPLEMENTATION_COMMIT=444b5c392eee30e13f875126826dbcc3365ad9ea
  TEST_RUN_ID=e2-t01-canonical-repair-final make verify-E2-T01`. The detached checkout was clean
  before install; frozen install, emulator setup, `pnpm format:check`, `pnpm lint`,
  `pnpm typecheck`, `pnpm test`, and `pnpm build` all exited 0 with `skips: []`.
- `connectionGrants.refs` now has two valid non-empty references, including the previously
  colliding joined-string case. Reversing that array, trigger events, provider capabilities,
  workspace paths, and sandbox capabilities preserves canonical bytes. The repaired v1 fixture
  is 1,380 UTF-8 bytes with digest
  `sha256:985cb3cc8e3ddfb848768e8f058afad174135e97253eed9376953c0a820973c7`.
- The verifier still records 15 typed refusal cases, 14 secret-canary refusals, deterministic
  v0 upgrade with no security defaults, and a disposable sensitivity mutant that makes the
  verifier go red when unknown-field rejection is relaxed. Current evidence is under
  `evidence/e2-t01-final/`; awaiting a fresh independent critic of the repair.
