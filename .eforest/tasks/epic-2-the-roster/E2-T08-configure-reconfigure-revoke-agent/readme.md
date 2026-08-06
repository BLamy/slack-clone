---
id: E2-T08
epic: 2
title: "Capstone: configure, reconfigure, and revoke an agent"
priority: 208
status: implemented
depends_on: [E2-T04, E2-T06, E2-T07]
estimate: L
capstone: true
---

## Goal

Prove the complete server-side agent roster and configuration control plane by creating an
agent, adding it to a channel, activating a scripted-provider configuration, snapshotting it,
reconfiguring it, and revoking it under concurrent access with exact replayable evidence.

## Context

This capstone does not invoke a real model or sandbox. It proves the administrative and
identity boundary on which the dispatcher depends: the agent is a normal visible member,
configuration is immutable and versioned, provider selection is negotiated, and neither
ownership nor a historical snapshot can route around current authorization or revocation.

## Deliverables

- Deterministic API/CLI scenario with separate workspace admin, agent manager, connection
  manager, ordinary member, agent owner, and agent principals.
- Scripted harness/sandbox descriptors, multiple config revisions, membership/presence
  changes, snapshots, and revocation race.
- HTTP/CLI transcript, stream dumps, snapshot manifests, canary scan, and composite digest.
- `make verify-E2` and `make verify-E2-T08` cold-clone targets.

## Acceptance criteria

- [ ] `make verify-E2-T08` and composed `make verify-E2` exit 0 from a cold clone with fresh
      streams/projections, zero skips, and self-contained evidence paths.
- [ ] An authorized manager creates and configures an agent, adds it to a channel, activates
      it, and sees it become available through the same roster contract as humans.
- [ ] The first snapshot remains byte-identical after reconfiguration; a second snapshot
      cites the new config/provider/grant versions and has a different canonical digest.
- [ ] Agent owner, ordinary member, agent principal, and mismatched scoped administrators are
      refused for every unauthorized management or connection operation with unchanged heads.
- [ ] Revocation racing snapshot use prevents the revoked configuration/grant from authorizing
      a future run, while historical events and snapshots remain replayable.
- [ ] Stream dumps, API/CLI output, snapshot manifests, provider doubles, and evidence contain
      no raw or resolved credential, verified with planted canaries.
- [ ] Deleting projections and replaying all source streams reproduces roster, active config,
      availability, revision history, and snapshot manifests to one composite digest.
- [ ] Replay is declared `Replay: N/A (server/CLI agent-control capstone) + mitigation:
      role matrix, revision/snapshot manifests, revocation race, canary scan, and composite
      stream replay`.

## Adversarial verification

1. Run every capstone command as every principal and with sibling-workspace resource IDs.
   Any matrix mismatch or existence leak refutes separation of duties.
2. Race two revisions, provider-health loss, membership removal, and revocation around
   snapshot resolution. Mixed-version or post-revocation authority refutes fencing.
3. Retry every mutating CLI command after simulated lost acknowledgement. Duplicate principal,
   membership, revision, or lifecycle events refute idempotency.
4. Delete all projections and process state midway, then finish from replayed sources. Any
   missing authority or changed digest refutes durability.
5. Tamper with a config revision, provider descriptor, grant reference, and snapshot digest
   separately; the verifier must localize every mismatch.

## Verification log

### Builder — 2026-08-06 — implementation and cold/composed proof

- Exact implementation commit: `8d166e0de1d4a3954a1ef833efc3a39c3de60cbf`.
- Exact cold command: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e2-t08-cold-final-20260806d E2_T08_IMPLEMENTATION_COMMIT=8d166e0de1d4a3954a1ef833efc3a39c3de60cbf make verify-E2-T08`. The detached checkout was clean before install, initialized the pinned emulator, and ran all six gates with exit code 0 and `skips: []`: `pnpm format:check`, `pnpm format:check:e2-t08`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
- Exact composed command: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e2-composed-final-20260806b E2_T08_IMPLEMENTATION_COMMIT=8d166e0de1d4a3954a1ef833efc3a39c3de60cbf make verify-E2`. The composed transcript reports all eight targets in dependency order, every target exit code 0, every target bound to the implementation commit, `zeroSkips: true`, and `rootCheckoutCleanBeforeRun: true`.
- Lifecycle and snapshot evidence: agent `draft -> active -> retired`, configuration revisions `[1, 2, 3]`; first snapshot digest `sha256:9bfadc4ee22498b80431367b333e642060ed33589bd2557f2490df9a9c1d22f1`, second snapshot digest `sha256:d7fbdebec9fd633e48d0df018a921e5a61262bd658fb0a6f914f498d7e0d47b4`, first snapshot bytes stable after reconfigure and revoke, and second snapshot canonical bytes differ. The role/authorization matrix covers 206 rows, including 49 refused rows with unchanged source heads and sibling-scope 404s.
- Revocation and replay evidence: provider health loss, connection-grant revocation, workspace-membership removal, and stale historical-config use are refused with typed codes while pre-revocation and historical snapshots remain valid. Projection deletion plus source replay reproduces the roster, retired active-config state, revision history, and snapshot manifests to composite digest `sha256:8cfe699738d3eb50f8d9b9722ce46ef990031d84c01aa375bb6eb43ef6b34d47`; source records are directory `43` and config `6`.
- Idempotency, tamper, and canary evidence covers retried create/config/lifecycle mutations, concurrent revision CAS, config/provider/grant/snapshot/directory tampering, API/CLI canaries, and published evidence. Sensitivity is `true`; the injected canary was absent from stream dumps, transcripts, provider doubles, and all 14 promoted evidence files.
- Evidence: `evidence/e2-t08-final/verification-summary.json`, `http-transcript.json`, `cli-transcript.json`, `source-dumps.json`, `snapshot-manifests.json`, `role-matrix.json`, `roster.json`, `revocation-races.json`, `replay-composite.json`, `tamper-matrix.json`, `sensitivity.json`, `canary-scan.json`, `cold-clone-transcript.json`, and `composed-verify-transcript.json`.
- Replay: N/A (server/CLI agent-control capstone) + mitigation: role matrix, revision/snapshot manifests, revocation race, canary scan, and composite stream replay.
- Claim: the builder considers E2-T08 implemented and the cold/composed evidence complete; a fresh critic must independently attempt to refute the claim before this task can become `verified`.
