---
id: E5-T01
epic: 5
title: "Credential broker contract: Infisical Agent Proxy in production, Agent Vault locally, and no raw-secret orchestration path"
priority: 501
status: pending
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
on provider/mode ambiguity and expose only opaque, run-scoped handles to callers.

## Deliverables

- `SecretRef`, `CredentialBroker`, injection-capability, audit-event, and typed-error
  schemas in `packages/credential-broker`.
- Infisical Agent Proxy adapter, local Agent Vault adapter, and a strict provider/mode
  capability handshake.
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
      + mitigation: cold-clone state replay, canary scans, provider-mode refusal fixtures,
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
