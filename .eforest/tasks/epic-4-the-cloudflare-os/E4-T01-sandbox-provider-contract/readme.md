---
id: E4-T01
epic: 4
title: "Sandbox provider contract: capability discovery, fenced lifecycle operations, and provider-neutral run identities"
priority: 401
status: verified
depends_on: [E3]
estimate: M
capstone: false
---

## Goal

`packages/sandbox` defines the provider-neutral `SandboxProvider` contract used by the
dispatcher to create, inspect, execute in, suspend, resume, and destroy an isolated agent
workspace. Every operation is idempotency-keyed and fenced to one immutable invocation
snapshot, while provider capabilities are explicit data rather than adapter guesses.

## Context

Cloudflare OS is the first server runtime and AlmostNode is a later reach, so the queue must
freeze semantics before either adapter leaks provider-specific behavior into run state.
The contract is a security boundary: an agent chooses only a configured provider id and
profile; it never supplies raw provider credentials, host paths, network policy, or an
unbounded command channel.

## Deliverables

- `packages/sandbox/src/provider.ts`, `capabilities.ts`, `errors.ts`, and versioned
  schemas for sandbox specs, handles, lifecycle state, and execution requests.
- An in-memory conformance provider covering idempotency, stale fences, crash recovery,
  and capability refusal without pretending to prove a real provider.
- `make verify-E4-T01` plus frozen run-event fixtures and state digests.

## Acceptance criteria

- [ ] `make verify-E4-T01` passes through `tools/verify/cold_clone.sh` with zero skips and
      replays the same lifecycle fixture twice to byte-identical run and sandbox digests.
- [ ] The contract exposes typed `create`, `inspect`, `exec`, `cancel`, `suspend`,
      `resume`, and `destroy` operations; every mutating call requires `runId`,
      `invocationDigest`, `idempotencyKey`, and expected lifecycle fence.
- [ ] Repeating an accepted request returns the original result without creating a
      second sandbox or execution; changing its payload under the same key is refused and
      leaves the event-log head unchanged.
- [ ] Capability discovery names persistence, network-policy, resource-limit,
      cancellation, and streaming-exec support; an unsupported requested capability fails
      before provider side effects and is recorded as a typed refusal.
- [ ] Provider auth material and provider-native handles are absent from public agent
      config and redacted from run events, proven with canary scans over serialized
      requests, errors, fixtures, and evidence.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (headless sandbox contract;
    no browser surface) + mitigation: cold-clone conformance, lifecycle event replay,
    digest equality, and mutation sensitivity`.

## Adversarial verification

1. Race duplicate creates and execs with identical and conflicting idempotency keys. More
   than one provider side effect, or acceptance of conflicting payloads, refutes fencing.
2. Feed stale invocation digests, unknown capability names, malformed handles, and events
   from a sibling run. Any provider call before validation is a finding.
3. Put canary provider tokens in adapter exceptions and debug metadata. One raw canary in
   a run dump, log, or returned error refutes redaction.
4. Remove the expected-fence check in a scratch worktree. `verify-E4-T01` staying green
   refutes the measuring apparatus.

## Verification log

### Builder — 2026-08-17

- Commit: `b5a1c2b4d53437248fea7fc782808309b40e60e2`
- Cold run: `make verify-E4-T01`, `TEST_RUN_ID=e4-t01-cold-20260817`
- Evidence: `.artifacts/e4-t01/e4-t01-cold-20260817/{capabilities,lifecycle-events,sensitivity,verification-summary,cold-verification-transcript}.json`
- Lifecycle digest: `sha256:a0f4199e321fae5e8aeae2bd5be03bac6e9c4d9c0b5cc09715befa6049c7e1f0`
- Gates: `format:check`, `lint`, `typecheck`, `test:unit` (189 passed, 0 skipped), and `build` passed from a detached cold worktree.
- Replay: N/A (headless sandbox contract; no browser surface) + mitigation: cold-clone conformance, lifecycle event replay, digest equality, and mutation sensitivity.
- Claim: provider-neutral sandbox lifecycle operations are capability-discovered, idempotency-keyed, invocation-fenced, typed, and redacted at the public/evidence boundary.

### Critic — 2026-08-17

- Verdict: `VERDICT: verified`
- Independent run: `make verify-E4-T01`, `TEST_RUN_ID=e4-t01-critic-20260817`, exact commit `b5a1c2b4d53437248fea7fc782808309b40e60e2`.
- Result: detached cold clone passed formatting, lint, typecheck, all 189 unit/ledger tests with zero skips, and build; lifecycle digest matched the builder run.
- Attacks: duplicate create and exec requests produced one side effect each; conflicting payloads returned `SANDBOX_IDEMPOTENCY_CONFLICT`; stale fences and unsupported capabilities were refused before mutation; serialized events contained no provider handles or credential-shaped canaries.
- Replay: N/A (headless sandbox contract; no browser surface) + mitigation: independent cold-clone conformance and sensitivity checks.
