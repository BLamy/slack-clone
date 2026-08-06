---
id: E2-T05
epic: 2
title: "Harness and sandbox provider registry with capability negotiation"
priority: 205
status: in-progress
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
