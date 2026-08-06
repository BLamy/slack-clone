---
id: E2-T07
epic: 2
title: "Immutable, capability-resolved invocation snapshot"
priority: 207
status: implemented
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

### Builder — 2026-08-06 — implementation and cold proof

- Exact implementation commit: `0b9c7275e4fe74e55c973b6aa9cc800bfcfa68e4`.
- Exact cold command: `PROMOTE_EVIDENCE=1 E2_T07_IMPLEMENTATION_COMMIT=0b9c7275e4fe74e55c973b6aa9cc800bfcfa68e4 TEST_RUN_ID=e2-t07-cold-final make verify-E2-T07`. The detached checkout was clean before install, initialized the pinned emulator, and recorded `make verify-E2-T07` as the entrypoint; all five required gates exited 0 with `skips: []`.
- Canonical snapshot: 7,127 bytes, digest `sha256:470c2121c38bc9d4a720bf3cfab256c53cd2026c3bb62eefed292c6581529260`; the exact scripted provider manifest digest is `sha256:751764325d1387da9404895128892e5a1e95005fb0bd45e27bd9dde42d6ec8b5`.
- Source manifest: config `agent:ag_aaaaaaaaaaaaaaaaaaaaaaaaaa_ffffffffffffffffffffffffff/config` at `0000000000000030_aaaaaaaaaaaaaaaa` / `sha256:1111111111111111111111111111111111111111111111111111111111111111`; directory and workspace-input source `workspace:ws_aaaaaaaaaaaaaaaaaaaaaaaaaa/directory` at `0000000000000040_bbbbbbbbbbbbbbbb` / `sha256:2222222222222222222222222222222222222222222222222222222222222222`; connection grant sources are recorded in `source-references.json`.
- Refusal evidence covers disabled config, suspended membership, non-member scope, unhealthy and incompatible providers, expired grants, over-budget use, and cross-workspace grants. Five current-use revocation races reject stale authority while the historical snapshot remains replayable.
- Reconfiguration evidence changes config, provider manifest, membership, grant source, and workspace-input source; every new resolution has a new digest while the historical bytes remain unchanged. Three source/digest mutants make the real verifier exit 1. Canary scanning found no provider token, credential, environment, or broker-session value in snapshot bytes or promoted evidence.
- Evidence: `evidence/e2-t07-final/verification-summary.json`, `snapshot-manifest.json`, `source-references.json`, `refusal-matrix.json`, `revocation-races.json`, `canary-scan.json`, `sensitivity.json`, and `cold-clone-transcript.json`.
- Replay: N/A (server invocation-resolution contract) + mitigation: source-bound snapshot manifests, canary scans, reconfiguration races, and digest tests.
- Claim: invocation resolution creates a canonical, deeply immutable, secret-free snapshot bound to exact config/provider/membership/context/budget/input/grant sources; current authorization re-resolves every authority and rejects revocation or drift without invalidating historical replay evidence.
