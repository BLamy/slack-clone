---
id: E2-T05
epic: 2
title: "Harness and sandbox provider registry with capability negotiation"
priority: 205
status: implemented
depends_on: [E2-T01]
estimate: L
capstone: false
---

## Goal

Define the registry and negotiation boundary through which harness and sandbox providers
publish versioned configuration schemas, lifecycle features, limits, and compatibility so
an agent becomes runnable only when its exact requirements resolve.

## Context

Provider selection must remain data, not conditionals scattered through orchestration. A
deterministic scripted provider is available for contract tests. Production providers land
in later epics and register through the same interface. `almostnode-browser` is deliberately
unknown until the final reach epic; silently falling back to a different sandbox would break
the user's security and reproducibility choice.

Capability negotiation checks requirements such as streaming exec, process cancellation,
filesystem persistence, checkpoint/restore, egress policy, broker support, harness protocol,
and resource ceilings.

## Deliverables

- Versioned harness and sandbox provider descriptors, schemas, and registry APIs.
- Deterministic scripted providers and a provider conformance/compatibility matrix.
- Fail-closed configuration resolution with immutable resolved descriptor digests.
- `make verify-E2-T05` cold-clone target and negotiation evidence.

## Acceptance criteria

- [ ] `make verify-E2-T05` exits 0 from a cold clone and records registry manifests,
      compatibility matrix,
      refusals, and canonical resolved-provider digests.
- [ ] Orchestration-facing code resolves providers through one registry contract and contains
      no provider-name branching or silent default provider.
- [ ] A config is runnable only when exact provider ID/version, provider-owned schema, required
      capabilities, and harness/sandbox compatibility all pass.
- [ ] Missing, disabled, stale, downgraded, duplicate, and unknown providers fail with typed
      reasons before any run or provider side effect.
- [ ] The deterministic scripted providers satisfy the same conformance interface later used
      by Fly, Codex, Claude Code, and the AlmostNode reach provider.
- [ ] `almostnode-browser` and all unimplemented production providers are refused rather than
      represented as available; registry state distinguishes installed from healthy.
- [ ] Replay is declared `Replay: N/A (server provider contract) + mitigation: conformance
      doubles, fail-closed compatibility matrix, registry manifests, and digest evidence`.

## Adversarial verification

1. Register colliding IDs, downgraded versions, altered schemas, duplicate capabilities, and
   descriptors with unstable ordering. Ambiguous resolution refutes registry integrity.
2. Request every unsupported capability pair. A runnable result or fallback refutes
   fail-closed negotiation.
3. Mark a provider unhealthy or remove it between config resolution and use. A new runnable
   snapshot under stale readiness refutes validation.
4. Inject provider-specific branching into orchestration in a scratch worktree; the source
   audit must fail.
5. Add an unregistered AlmostNode-like provider string to a fixture. Acceptance before its
   reach epic refutes roadmap isolation.

## Verification log

### Builder — 2026-08-06 — implementation and cold proof

- Exact implementation commit: `cc0e4cdc0e17ad9789264fd5c9e26da10166e063`.
- Exact cold command: `PROMOTE_EVIDENCE=1 E2_T05_IMPLEMENTATION_COMMIT=cc0e4cdc0e17ad9789264fd5c9e26da10166e063 TEST_RUN_ID=e2-t05-cold-final-v4 make verify-E2-T05`. The detached checkout was clean before install, initialized the pinned emulator, and recorded `make verify-E2-T05` as the entrypoint; every cold child command exited 0 with `skips: []`.
- Gates: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all exited 0 in the cold verifier; the full suite reported 148 passing tests.
- Evidence: `evidence/e2-t05-final/verification-summary.json`, `registry-manifest.json`, `compatibility-matrix.json`, `refusals.json`, `resolved-provider-digests.json`, `conformance.json`, `sensitivity.json`, and `cold-clone-transcript.json`.
- Registry: five exact versioned descriptors, two available scripted providers, three unavailable production providers, manifest digest `sha256:751764325d1387da9404895128892e5a1e95005fb0bd45e27bd9dde42d6ec8b5`; compatibility matrix has seven rows with one runnable and six refused; 16 typed refusal cases; source audit scans 38 files with zero offenses.
- Resolved digest: strict `AgentConfig` resolution reaches `resolveAgentConfigProviders` and records `sha256:541df036a887331550882cddc8f8fb4b27366f24f1d7d632f66813476ea63116`; three real-verifier sensitivity mutants, including injected provider branching, were detected.
- Replay: N/A (server provider contract) + mitigation: conformance doubles, fail-closed compatibility matrix, registry manifests, and digest evidence.
- Claim: exact provider IDs and versions resolve only through the versioned registry; provider-owned schemas, capabilities, readiness, implementation status, reciprocal compatibility, immutable descriptors, and canonical digests fence every runnable configuration, while AlmostNode and unimplemented production providers fail closed without provider-name orchestration branches or secret-shaped evidence.
