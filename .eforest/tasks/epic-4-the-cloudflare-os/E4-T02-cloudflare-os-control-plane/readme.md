---
id: E4-T02
epic: 4
title: "Cloudflare OS control plane: authenticated workspace and Gadget lifecycle behind SandboxProvider"
priority: 402
status: pending
depends_on: [E4-T01]
estimate: L
capstone: false
---

## Goal

`packages/sandbox-cloudflare-os` implements `SandboxProvider` against Cloudflare OS
workspaces and Gadgets with a narrow server-owned control-plane client, deterministic
request identities, typed provider errors, and reconciliation from provider reality after
retries or process crashes.

## Context

Cloudflare credentials belong to the deployment identity, never to an agent configuration
or harness process. Unit tests may use a protocol fake, but they cannot certify production
compatibility; this task establishes a separately gated real-provider smoke path that
fails loudly when its explicit test credentials or isolated Cloudflare account/workspace
scope are absent.

## Deliverables

- `packages/sandbox-cloudflare-os/src/provider.ts`, `client.ts`, `mapping.ts`, and redacted
  error normalization for the supported Cloudflare OS control-plane surface.
- Resource labels binding every workspace/Gadget to tenant, workspace, agent, invocation, and
  idempotency identities plus a reconciliation command.
- `make verify-E4-T02` and opt-in `make verify-E4-T02-real` Cloudflare OS provider gates.

## Acceptance criteria

- [ ] `make verify-E4-T02` passes cold with a strict HTTP contract fixture and proves
      request/response mapping, retries, and lifecycle replay to an exact digest.
- [ ] Create, inspect, suspend, resume, and destroy calls use only the server deployment
      identity; scans of agent config, child environment, run events, and command output
      contain no Cloudflare token or authorization header.
- [ ] A timeout after provider acceptance reconciles by immutable labels and returns the
      original workspace/Gadget rather than creating another; a conflicting label set is refused.
- [ ] Provider 401/403, quota, timeout, unavailable, and not-found responses map to frozen
      typed errors without leaking response headers or credentials.
- [ ] `make verify-E4-T02-real` creates one uniquely labeled workspace/Gadget in an
      isolated Cloudflare OS test scope, observes it through the real control plane,
      suspends/resumes it, destroys it, and proves no matching resource remains. Missing
      real-provider configuration exits nonzero with `SKIPPED:` and never falls back to the fake.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (server-side Cloudflare OS
      control plane) + mitigation: cold-clone HTTP contract tests, redaction scans, and
      the gated real Cloudflare OS lifecycle transcript`.

## Adversarial verification

1. Inject accepted-then-timeout responses and concurrent retries. Duplicate Cloudflare OS
   workspaces/Gadgets or
   ambiguous ownership after reconciliation refute idempotency.
2. Return hostile provider payloads containing tokens, enormous bodies, and unknown
   states. Any raw secret or untyped success is a finding.
3. Run the real gate with an invalid Cloudflare token and an intentionally tiny quota. It must fail
   with the expected typed class and leave no orphan.
4. Replace real-gate routing with the protocol fake in a scratch worktree. A green
   `verify-E4-T02-real` refutes provider attestation.

## Verification log
