---
id: E5-T01
epic: 5
title: "Credential broker contract: Infisical Agent Proxy in production, Agent Vault locally, and no raw-secret orchestration path"
priority: 501
status: implemented
depends_on: [E3]
estimate: L
capstone: false
---

## Goal

`packages/credential-broker` defines a provider-neutral broker that turns a versioned
`SecretRef` plus a fenced run identity into a short-lived injection capability without
returning plaintext to the dispatcher, harness, durable stream, or agent configuration.
Production uses **Infisical Agent Proxy**; **Agent Vault** is an allowed local-development
fallback. The ordinary Infisical caching Proxy is explicitly unsupported and cannot
satisfy the capability handshake or production gate.

## Context

Agents need real service credentials without making chat configuration a secret store.
Similar product names create a dangerous substitution risk: the target is Infisical's
agent-oriented proxy boundary, not the general caching Proxy. The adapter must fail closed
on provider/mode ambiguity, verify an endpoint-bound production attestation, and expose only
opaque, single-use, run-scoped handles to callers.

## Deliverables

- `SecretRef`, `CredentialBroker`, injection-capability, audit-event, and typed-error
  schemas in `packages/credential-broker`.
- Infisical Agent Proxy adapter, local Agent Vault adapter, and a strict provider/mode
  capability handshake with an out-of-band signature verifier.
- `make verify-E5-T01` and opt-in `make verify-E5-T01-real` with canary-secret evidence.

## Acceptance criteria

- [ ] `make verify-E5-T01` passes cold and replays issue/use/revoke fixtures twice to the
      same broker-state and audit digests with no plaintext secret in either dump.
- [ ] Broker callers receive only an opaque capability bound to tenant, workspace, agent,
      run, connection, permitted operation, expiry, and request digest; no public method
      returns secret bytes or a reusable provider token.
- [ ] Production configuration accepts only an attested Infisical Agent Proxy adapter.
      An ordinary Infisical caching Proxy endpoint, generic Infisical token client, Agent
      Vault, or unknown mode is rejected before a run starts.
- [ ] Local mode may select Agent Vault explicitly, emits a visible non-production
      provider marker, and cannot boot when the process declares a production environment.
- [ ] `make verify-E5-T01-real` resolves a dedicated canary through a real Infisical Agent
      Proxy boundary, uses it only inside the test consumer, revokes the run capability,
      and proves a second use fails. Missing real-provider configuration exits nonzero
      with `SKIPPED:` and never falls back.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (headless credential broker)
  - mitigation: cold-clone state replay, canary scans, provider-mode refusal fixtures,
    and gated real Infisical Agent Proxy transcript`.

## Adversarial verification

1. Present ordinary Infisical caching Proxy, generic API, Agent Vault, and forged
   capability handshakes as production. Any accepted substitute refutes the contract.
2. Put canaries in secret values, provider tokens, headers, exceptions, and process env;
   scan stdout/stderr, streams, traces, errors, and evidence. One leak is a finding.
3. Replay, extend, cross-tenant, and change the request under an issued capability. Any
   successful second or out-of-scope use refutes binding.
4. Make the real gate route to the fake/local adapter in a scratch worktree. A green run
   refutes provider attestation.

## Verification log

### Builder — 2026-08-19

- Commit: `6d8da0c7b20755cfb7adbc5b85641e6b98de16f7`.
- Commands: `pnpm install --frozen-lockfile`; `pnpm format:check`; `pnpm lint`;
  `pnpm typecheck`; `pnpm test:unit` (195 passed); `pnpm build`; `pnpm setup:emulate`;
  `pnpm test:integration` (15 passed); and a detached cold worktree replay with
  `make verify-E5-T01 TEST_RUN_ID=e5-t01-cold-final`.
- Local verifier: `make verify-E5-T01 TEST_RUN_ID=e5-t01-final-commit` passed twice-
  replay parity with state digest
  `sha256:cf6eebbae78c7dbf3447b060ec2d355a018d990628789a7e2e71955e521bb5ef`, audit
  digest `sha256:1e69f64bb7b1939a41b9e900d81b2368df1eb2df953e9e1fde004412651ef043`,
  provider-mode refusals, binding/request sensitivity, and `leaked: false`.
- Real gate: `make verify-E5-T01-real` exited 2 with `SKIPPED:` for missing explicit
  Infisical Agent Proxy configuration; no Agent Vault or other fallback was used.
- Evidence: `evidence/e5-t01-final/` and `evidence/e5-t01-real-skip/skipped.json`.
  The committed evidence contains no canary plaintext.
- Replay: N/A (headless credential broker) + mitigation: cold-clone state replay,
  canary scans, provider-mode refusal fixtures, and gated real Infisical Agent Proxy
  transcript.
- Claim: E5-T01 is implemented and ready for a fresh critic. The public broker exposes
  only run-bound opaque capabilities and redacted receipts; Agent Vault is local-only,
  ordinary caching Proxy and generic token clients fail closed, and production transport
  must be explicitly injected into the attested Agent Proxy adapter.

### Rework — 2026-08-19

- The first critic returned `VERDICT: refuted` after static review; command execution was
  permission-blocked. Rework addresses its actionable findings before a new verdict:
  live capability replay, production-like environment aliases, signed endpoint-bound
  attestation, complete literal private-IP coverage, and evidence scanning beyond JSON.

### Builder — rework complete — 2026-08-19

- Commit: `ea12807d9c7c2de34573f6339c3f7230fb7efb98`.
- Commands: `pnpm format:check`; `pnpm lint`; `pnpm typecheck`; `pnpm test:unit`
  (195 passed); `pnpm build`; `pnpm test:integration` (15 passed); and a detached cold
  worktree replay with `make verify-E5-T01 TEST_RUN_ID=e5-t01-cold-final-rework`.
- Local verifier: `make verify-E5-T01 TEST_RUN_ID=e5-t01-final-rework` passed twice-replay
  parity with state digest
  `sha256:285cb6db0df9df65fdbffbdb0a5cf38260802e2fb289cfe43e354682760bb013`, audit
  digest `sha256:5b5a5b5e8f6c3872e12554f00c03da8cbb2936532cc3160a301621695a0a8e42`,
  provider-mode refusals, cross-binding/request/live-replay sensitivity, and
  `leaked: false` across all evidence files plus environment values.
- Production hardening: local providers are rejected for production-like environments;
  live capabilities are single-use and revoke remains idempotent after use; proxy
  endpoints reject literal private, loopback, link-local, multicast, mapped, and
  reserved IP forms; and signed attestations bind the provider key and endpoint digest.
- Real gate: `make verify-E5-T01-real` exited 2 with `SKIPPED:` for missing explicit
  Infisical Agent Proxy configuration, including its out-of-band attestation public key;
  no Agent Vault or other fallback was used.
- Evidence: `evidence/e5-t01-final/` and `evidence/e5-t01-real-skip/skipped.json`.
  The committed evidence contains no canary plaintext.
- Replay: N/A (headless credential broker) + mitigation: cold-clone state replay,
  canary scans, provider-mode refusal fixtures, and gated real Infisical Agent Proxy
  transcript.
- Claim: E5-T01 rework is implemented and ready for a fresh critic. The public broker
  exposes only opaque, tenant/workspace/agent/run/connection/operation/request-bound
  capabilities; provider authentication and handles remain internal; and production
  requires an explicitly injected transport plus a verified endpoint-bound attestation.

### Critic follow-up — 2026-08-19

- The next critic was execution-blocked and returned `VERDICT: needs-evidence`; its
  static race finding was actionable. Follow-up rework reserves a capability before
  provider I/O, rejects concurrent use/revoke races, brands adapters in a private trust
  registry, and covers IPv4-compatible and NAT64 literal forms.

### Builder — race follow-up complete — 2026-08-19

- Commit: `fd1128476f812a7144590a4203fa61b1e1d42403`.
- Commands: `pnpm format:check`; `pnpm lint`; `pnpm typecheck`; `pnpm test:unit`
  (196 passed); `pnpm build`; `pnpm test:integration` (15 passed); and a detached cold
  worktree with `pnpm install --frozen-lockfile` followed by `make verify-E5-T01`.
- Local verifier: `PROMOTE_EVIDENCE=1 make verify-E5-T01 TEST_RUN_ID=e5-t01-final-race`
  passed twice-replay parity with state digest
  `sha256:b98ce75f188640e564a80b5ad27f3df9d424bbbfd094dd51aec117727d8e6b13`, audit
  digest `sha256:5b5a5b5e8f6c3872e12554f00c03da8cbb2936532cc3160a301621695a0a8e42`,
  provider-mode refusals, cross-binding/request/live-replay sensitivity, and
  `leaked: false` across every evidence file and environment value.
- Concurrency hardening: a capability is reserved before provider I/O, so concurrent
  calls produce one provider invocation and one typed `CAPABILITY_IN_FLIGHT` refusal;
  revoke is fenced while use is in flight and remains idempotent after use.
- Real gate: `TEST_ARTIFACT_DIR=.eforest/tasks/epic-5-the-switchboard/E5-T01-credential-broker-contract/evidence/e5-t01-real-skip make verify-E5-T01-real`
  exited 2 with `SKIPPED:` for missing explicit Infisical Agent Proxy configuration;
  no Agent Vault or other fallback was used.
- Evidence: `evidence/e5-t01-final/` and `evidence/e5-t01-real-skip/skipped.json`;
  the committed evidence contains no canary plaintext.
- Replay: N/A (headless credential broker) + mitigation: cold-clone state replay,
  canary scans, provider-mode refusal fixtures, and gated real Infisical Agent Proxy
  transcript.
- Claim: E5-T01 is implemented and ready for a fresh critic. Trusted adapters are
  factory-branded, production requires an out-of-band signed endpoint-bound attestation
  and injected transport, and capabilities are opaque, run-bound, single-use, and
  revocable without exposing provider handles or credential bytes.

### Critic follow-up — 2026-08-19

- A fresh critic executed the full review at commit `4975f58418f049b01fa0d9b3f75ef4df9ee9e1a6`
  and returned `VERDICT: refuted`.
- Findings: arbitrary plaintext was accepted in the provider `requestId` result field,
  and documentation/reserved IPv4 ranges were not fully rejected by the production
  endpoint guard. Concurrency reservation, revoke-in-flight fencing, binding/request
  checks, environment aliases, provider substitution, signed attestation binding,
  adapter trust branding, private/loopback/mapped/compatible/NAT64 forms, evidence
  scanning, and verifier sensitivity all passed.

### Builder — redaction and reserved-network follow-up complete — 2026-08-19

- Commit: `ee86ef2bd5ffbb9e9373cd7e11e2a1e1ef057914`.
- Fixes: `requestId` is normalized as a SHA-256 digest like `responseDigest`, with a
  regression proving plaintext metadata is refused; production endpoint validation now
  rejects TEST-NET, 6to4 relay, and TEST-NET-2/3 IPv4 ranges, with explicit endpoint
  fixtures for `192.0.2.1`, `192.88.99.1`, `198.51.100.1`, and `203.0.113.1`.
- Commands: `pnpm format:check`; `pnpm lint`; `pnpm typecheck`; `pnpm test` (197 unit
  tests and 15 emulator/Auth0 integration tests passed); `pnpm build`; and a detached
  cold worktree with `pnpm install --frozen-lockfile` followed by
  `TEST_RUN_ID=e5-t01-cold-final-redaction make verify-E5-T01`.
- Local verifier: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e5-t01-final-redaction make verify-E5-T01`
  passed twice-replay parity with state digest
  `sha256:b98ce75f188640e564a80b5ad27f3df9d424bbbfd094dd51aec117727d8e6b13`, audit
  digest `sha256:5b5a5b5e8f6c3872e12554f00c03da8cbb2936532cc3160a301621695a0a8e42`,
  provider-mode refusals, cross-binding/request/live-replay sensitivity, and
  `leaked: false` across eight evidence files and 58 environment-key values.
- Real gate: `TEST_RUN_ID=e5-t01-real-missing-final-redaction TEST_ARTIFACT_DIR=.eforest/tasks/epic-5-the-switchboard/E5-T01-credential-broker-contract/evidence/e5-t01-real-skip make verify-E5-T01-real`
  exited 2 with `SKIPPED:` for all 12 missing explicit Infisical Agent Proxy inputs;
  `fallbackUsed: false` and no Agent Vault fallback.
- Evidence: `evidence/e5-t01-final/` and `evidence/e5-t01-real-skip/skipped.json`,
  both tied to the exact implementation commit and containing no canary plaintext.
- Replay: N/A (headless credential broker) + mitigation: cold-clone state replay,
  canary scans, provider-mode refusal fixtures, and gated real Infisical Agent Proxy
  transcript.
- Claim: the two critic findings are closed and E5-T01 is implemented for a fresh
  independent verdict.

### Critic follow-up — 2026-08-19

- The next fresh critic executed the exact 0b650778de0849c9343967539136a9e41e9b66d2
  head and returned VERDICT: refuted.
- Findings: public IPv4 values embedded in IPv4-mapped, IPv4-compatible, and NAT64
  IPv6 literals were accepted; and the evidence scanner's fixed credential patterns
  did not detect a newly chosen arbitrary canary in an artifact. The requestId fix,
  required reserved IPv4 fixtures, concurrency/replay/revoke fencing, provider
  substitution, signed attestation, and full gates all passed. The real gate remained
  an explicit SKIPPED with no fallback.

### Builder — IPv6 representation and scanner sensitivity follow-up — 2026-08-19

- Commits: `4976fe1e659acdbb2f908accfdd83a471eca6cff` for the IPv6 representation
  guard and `bddc23d7285e55537cdb0a359eaa8185e6c3cbc6` for scanner hardening.
- Fixes: all IPv4-mapped, IPv4-compatible, and NAT64 IPv6 literals are rejected even
  when their embedded IPv4 is public; endpoint fixtures cover public and private
  embedded forms. Local and real evidence scanners now scan environment values,
  detect compound canary values chosen independently, avoid self-report false positives,
  and prove sensitivity by injecting a temporary artifact canary that the verifier
  detects before cleanup.
- Commands: `pnpm format:check`; `pnpm lint`; `pnpm typecheck`; `pnpm test` (197 unit
  tests and 15 emulator/Auth0 integration tests passed); `pnpm build`; and a detached
  cold worktree with `pnpm install --frozen-lockfile` followed by
  `TEST_RUN_ID=e5-t01-cold-final-sensitivity make verify-E5-T01`.
- Local verifier: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e5-t01-final-sensitivity make verify-E5-T01`
  passed twice-replay parity at implementation commit
  `bddc23d7285e55537cdb0a359eaa8185e6c3cbc6`, with state digest
  `sha256:b98ce75f188640e564a80b5ad27f3df9d424bbbfd094dd51aec117727d8e6b13`, audit
  digest `sha256:5b5a5b5e8f6c3872e12554f00c03da8cbb2936532cc3160a301621695a0a8e42`,
  `evidenceCanary.detected: true`, and final `leaked: false` across eight files and
  58 environment-key values.
- Real gate: `TEST_RUN_ID=e5-t01-real-missing-final-sensitivity TEST_ARTIFACT_DIR=.eforest/tasks/epic-5-the-switchboard/E5-T01-credential-broker-contract/evidence/e5-t01-real-skip make verify-E5-T01-real`
  exited 2 with `SKIPPED:` for all 12 missing explicit Infisical Agent Proxy inputs;
  `fallbackUsed: false` and no Agent Vault fallback.
- Evidence: `evidence/e5-t01-final/` and `evidence/e5-t01-real-skip/skipped.json`,
  tied to the exact code commit and containing no canary plaintext.
- Replay: N/A (headless credential broker) + mitigation: cold-clone state replay,
  canary scans, provider-mode refusal fixtures, and gated real Infisical Agent Proxy
  transcript.
- Claim: the two additional critic findings are closed and E5-T01 is implemented for
  another fresh independent verdict.
