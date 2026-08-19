---
id: E2-T07
epic: 2
title: "Immutable, capability-resolved invocation snapshot"
priority: 207
status: pending
depends_on: [E2-T02, E2-T05]
estimate: L
capstone: false
---

## Goal

Resolve a runnable agent configuration into a canonical immutable snapshot that binds exact
config revision, provider descriptors, policies, membership, budgets, workspace inputs, and
connection-grant versions for a future invocation without resolving any secret value.

## Context

Epic 3 needs a stable object to lease and execute. Reading live configuration throughout a
run would create time-of-check/time-of-use ambiguity; copying secret values or provider
tokens would create an exfiltration path. A snapshot is immutable evidence, not permanent
authorization: every privileged mutation still validates current lease and revocation state.

## Deliverables

- Snapshot schema, canonical resolver, digest, and source-reference manifest.
- Resolution checks for active config, membership, provider compatibility/readiness, budgets,
  workspace inputs, and connection-grant references.
- Concurrent reconfiguration and revocation fixtures.
- `make verify-E2-T07` cold-clone target and snapshot evidence.

## Acceptance criteria

- [ ] `make verify-E2-T07` exits 0 from a cold clone and records canonical snapshots, source
      offsets and
      digests, refusal reasons, and sensitivity results.
- [ ] A snapshot names exact agent/config revision, harness and sandbox descriptor versions,
      policy values, membership/context scope, budget, workspace-input manifest, and
      connection-grant revisions with one canonical digest.
- [ ] Snapshot bytes contain no provider control token, upstream credential, resolved secret,
      arbitrary environment map, or broker session, verified by canary scanning.
- [ ] Updating config, provider descriptors, membership, or grants after snapshot creation
      does not rewrite its bytes; resolution after the update produces a new digest.
- [ ] Disabled, suspended, non-member, unhealthy-provider, incompatible, expired-grant, and
      over-budget inputs refuse snapshot creation before any provider side effect.
- [ ] Revoking an input after snapshot creation makes current authorization reject its use
      even though the historical snapshot remains replayable evidence.
- [ ] Replay is declared `Replay: N/A (server invocation-resolution contract) + mitigation:
      source-bound snapshot manifests, canary scans, reconfiguration races, and digest tests`.

## Adversarial verification

1. Change each referenced source between read and resolution completion. A mixed-version
   snapshot refutes atomic/fenced resolution.
2. Substitute valid provider, membership, grant, and workspace-input references from another
   agent or tenant. Acceptance refutes scoping.
3. Plant secrets in provider doubles and grant resolvers. Any value in snapshot, logs, or
   evidence refutes non-resolution.
4. Revoke every input immediately after snapshot creation and attempt a protected use. One
   acceptance under stale authority refutes revocation revalidation.
5. Remove one source digest from a scratch snapshot; verification must fail.

## Verification log
