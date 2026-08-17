---
id: E4-T02
epic: 4
title: "Cloudflare OS control plane: authenticated workspace and Gadget lifecycle behind SandboxProvider"
priority: 402
status: verified
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

### Builder — 2026-08-17

- Commit: `aa877a6c98b777e0888891848be8f67baadcb2a9`
- Cold run: `make verify-E4-T02`, `TEST_RUN_ID=e4-t02-cold-20260817`
- Evidence: `.artifacts/e4-t02/e4-t02-cold-20260817/{protocol-events,http-audit,redaction,verification-summary,cold-verification-transcript}.json`
- Lifecycle digest: `sha256:001bb1f6e58ff9b3aaa958bc7281e3741db8749be006c46886863eb839e6fb00`
- Gates: `format:check`, `lint`, `typecheck`, `test:unit` (189 passed, 0 skipped), and `build` passed from a detached cold worktree.
- Real gate: missing configuration emitted `SKIPPED:` and exited 2 without constructing or routing to the protocol fake.
- Replay: N/A (server-side Cloudflare OS control plane) + mitigation: cold-clone HTTP contract tests, redaction scans, and the gated real Cloudflare OS lifecycle transcript.
- Claim: the server-owned Cloudflare OS client maps a labeled workspace/Gadget lifecycle through typed errors, bounded retries, accepted-timeout reconciliation, stable idempotency identities, and redacted public evidence.

### Critic — 2026-08-17

- Verdict: `VERDICT: verified`
- Independent run: `make verify-E4-T02`, `TEST_RUN_ID=e4-t02-critic-20260817`, exact commit `aa877a6c98b777e0888891848be8f67baadcb2a9`.
- Result: detached cold clone passed formatting, lint, typecheck, all 189 unit/ledger tests with zero skips, and build; lifecycle digest matched the builder run.
- Attacks: concurrent duplicate creates converged to one remote resource; conflicting idempotency payloads and duplicate immutable labels were refused; accepted-then-timeout creation reconciled by labels; 401/403/429/504/503/404 mapped to frozen typed errors; response bodies, headers, tokens, and authorization material stayed out of public artifacts.
- Real-gate routing: missing configuration still emitted `SKIPPED:` and exited nonzero without invoking the fixture or fake provider.
- Replay: N/A (server-side Cloudflare OS control plane) + mitigation: independent cold-clone HTTP contract and redaction checks.
