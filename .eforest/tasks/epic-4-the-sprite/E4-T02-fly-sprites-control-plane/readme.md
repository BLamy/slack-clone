---
id: E4-T02
epic: 4
title: "Fly Sprites control plane: authenticated create, inspect, suspend, resume, and destroy behind SandboxProvider"
priority: 402
status: pending
depends_on: [E4-T01]
estimate: L
capstone: false
---

## Goal

`packages/sandbox-fly` implements `SandboxProvider` against Fly Sprites with a narrow
server-owned control-plane client, deterministic request identities, typed provider
errors, and reconciliation from provider reality after retries or process crashes.

## Context

Fly credentials belong to the deployment identity, never to an agent configuration or
harness process. Unit tests may use a protocol fake, but they cannot certify production
compatibility; this task establishes a separately gated real-provider smoke path that
fails loudly when its explicit test credentials or isolated Fly test scope are absent.

## Deliverables

- `packages/sandbox-fly/src/provider.ts`, `client.ts`, `mapping.ts`, and redacted error
  normalization for the supported Fly Sprites API surface.
- Resource labels binding every Sprite to tenant, workspace, agent, invocation, and
  idempotency identities plus a reconciliation command.
- `make verify-E4-T02` and opt-in `make verify-E4-T02-real` provider gates.

## Acceptance criteria

- [ ] `make verify-E4-T02` passes cold with a strict HTTP contract fixture and proves
      request/response mapping, retries, and lifecycle replay to an exact digest.
- [ ] Create, inspect, suspend, resume, and destroy calls use only the server deployment
      identity; scans of agent config, child environment, run events, and command output
      contain no Fly token or authorization header.
- [ ] A timeout after provider acceptance reconciles by immutable labels and returns the
      original Sprite rather than creating another; a conflicting label set is refused.
- [ ] Provider 401/403, quota, timeout, unavailable, and not-found responses map to frozen
      typed errors without leaking response headers or credentials.
- [ ] `make verify-E4-T02-real` creates one uniquely labeled Sprite in an isolated Fly
      test scope, observes it through the real API, suspends/resumes it, destroys it, and
      proves no matching resource remains. Missing real-provider configuration exits
      nonzero with `SKIPPED:` and never falls back to the fake.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (server-side Fly control
      plane) + mitigation: cold-clone HTTP contract tests, redaction scans, and the gated
      real Fly lifecycle transcript`.

## Adversarial verification

1. Inject accepted-then-timeout responses and concurrent retries. Duplicate Sprites or
   ambiguous ownership after reconciliation refute idempotency.
2. Return hostile provider payloads containing tokens, enormous bodies, and unknown
   states. Any raw secret or untyped success is a finding.
3. Run the real gate with an invalid token and an intentionally tiny quota. It must fail
   with the expected typed class and leave no orphan.
4. Replace real-gate routing with the protocol fake in a scratch worktree. A green
   `verify-E4-T02-real` refutes provider attestation.

## Verification log
