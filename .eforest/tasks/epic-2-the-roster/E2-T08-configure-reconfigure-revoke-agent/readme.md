---
id: E2-T08
epic: 2
title: "Capstone: configure, reconfigure, and revoke an agent"
priority: 208
status: verified
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

### Critic — 2026-08-06 — independent verification

- `VERDICT: refuted` from fresh independent agent `019fd982-c106-7183-af36-c2ec282c51f4`, which reviewed implementation commit `8d166e0de1d4a3954a1ef833efc3a39c3de60cbf`, evidence commit `e0ec6d2`, the task specification, and the promoted evidence without editing the worktree.
- The critic confirmed the cold/composed manifests are internally consistent, all commands exit 0, skips are empty, snapshot and composite digests are reproducible, and the planted canary is absent. It found proof gaps requiring remediation: projection replay reused the live stream store and omitted connection records/other sources; revocation checks were sequential/synthetic and did not check actual CLI revoke use; sensitivity rows self-reported instead of running a defect mutant; lost-ack/idempotency attacks were incomplete; connection negatives were policy explanations rather than route calls; and post-revoke historical-byte stability was asserted without a comparison.
- Status: `in-progress`; builder must repair the evidence apparatus and obtain a fresh critic verdict.

### Builder — 2026-08-06 — remediation and replacement cold/composed proof

- Remediation implementation commit: `399d3c0fe1d914719966e408ae296b90c31e20b3`. It replaces live-store replay with a fresh source-seeded store, includes connection/audit/dispatch source records, adds durable grant revocation, checks actual CLI revoke fencing before the response returns, exercises a client-aborted create followed by idempotent retry and changed-payload refusal, routes connection authorization through HTTP, and runs a disposable verifier mutant that must exit 1.
- Exact cold command: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e2-t08-cold-remedied-20260806 E2_T08_IMPLEMENTATION_COMMIT=399d3c0fe1d914719966e408ae296b90c31e20b3 make verify-E2-T08`. The detached checkout was clean before install, initialized the pinned emulator, and all six gates exited 0 with `skips: []`: `pnpm format:check`, `pnpm format:check:e2-t08`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
- Exact composed command: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e2-composed-remedied-20260806 E2_T08_IMPLEMENTATION_COMMIT=399d3c0fe1d914719966e408ae296b90c31e20b3 make verify-E2`. All eight targets passed in dependency order with exit code 0 and no skips; prior targets ran at composed checkout `4f25b5c200e32cc1fd1642a5bbedef8d4a15b6a4`, E2-T08 ran at the exact remediation commit, and `rootCheckoutCleanBeforeRun: true`.
- Replacement evidence: lifecycle `draft -> active -> retired`, revisions `[1, 2, 3]`; first snapshot digest `sha256:96c7fc75926851d76ee79e1ed3a4f2ffd29e507f210f8fe9231e8bbeeba2dcd4`, second snapshot digest `sha256:00ac02fe291c2e45491821eecc675a6e0321c658e4432452f0a95beffa2ac0e5`, and first bytes remain stable after reconfigure and revoke. The matrix has 206 rows, 68 refused rows, HTTP-backed connection rows, and sibling agent/channel/connection 404s with unchanged heads.
- Revocation and replay evidence: both grants are durably revoked at source revision 3 while config references revision 2; the actual revoke append is observed before the response and a concurrent snapshot-use check refuses with `INVOCATION_SNAPSHOT_AGENT_CONFIG_INACTIVE`. A fresh replay store seeded from directory `43`, config `6`, connection `3 + 3`, audit `0`, and dispatch `12` records reproduces roster/config/history/snapshots and all source stream digests to composite `sha256:1d3d11ba552484ceb61b3b51a0bc633da054a9b4736f94f3638ec3c943b96095`.
- Idempotency and sensitivity evidence: the client-aborted create leaves exactly one durable principal event; the same-key retry succeeds and a changed payload exits 4/refuses. Nine sensitivity mutations are recorded, including a disposable replay-composite source-digest mutant whose verifier exit code is 1. Canary scanning reports no leak in the promoted evidence set.
- Evidence: `evidence/e2-t08-final/verification-summary.json`, `http-transcript.json`, `cli-transcript.json`, `source-dumps.json`, `snapshot-manifests.json`, `role-matrix.json`, `roster.json`, `revocation-races.json`, `replay-composite.json`, `tamper-matrix.json`, `sensitivity.json`, `canary-scan.json`, `cold-clone-transcript.json`, and `composed-verify-transcript.json`.
- Replay: N/A (server/CLI agent-control capstone) + mitigation: role matrix, revision/snapshot manifests, revocation race, canary scan, and composite stream replay.
- Claim: the builder considers the critic’s proof gaps repaired and E2-T08 implemented; a second fresh critic must independently attempt to refute this replacement evidence before the task can become `verified`.
### Critic — 2026-08-06 — second independent verification

- `VERDICT: refuted` from fresh independent agent `019fd9a7-e735-7343-8aca-063b3df1f265`, which reviewed remediation commit `399d3c0fe1d914719966e408ae296b90c31e20b3`, evidence commit `a773882`, the task specification, and the promoted cold/composed evidence without editing the worktree.
- The critic independently confirmed the fresh source-seeded replay, durable grant revocation, actual in-flight config fencing, HTTP-backed connection matrix, exact digests, canary scan, and disposable replay-integrity mutant. It found one remaining proof gap: adversarial item 3 requires retrying every mutating CLI command after a simulated lost acknowledgement, but only `create` used a client-aborted request; config-create, both activate calls, revise, and revoke were retried only after successful acknowledgement.
- Status: `in-progress`; builder must exercise client-aborted-after-durable-append plus same-key retry for every mutating CLI operation, then obtain a fresh critic verdict.

### Builder — 2026-08-06 — final lost-ack remediation cold/composed proof

- Final implementation commit: `f23695f3d6f3ff92802304ae9d5bd815ad9fb001`. The verifier now drives a client-aborted-after-durable-append HTTP request and same-key CLI retry for every mutating control-plane operation in the scenario: `create`, `config-create`, both `activate` transitions, `revise`, and `revoke`; each target stream contains exactly one matching durable event.
- Exact cold command: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e2-t08-cold-final-20260806e E2_T08_IMPLEMENTATION_COMMIT=f23695f3d6f3ff92802304ae9d5bd815ad9fb001 make verify-E2-T08`. The detached checkout was clean before install, initialized the pinned emulator, and all six gates passed with exit code 0 and `skips: []`: `pnpm format:check`, `pnpm format:check:e2-t08`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`; unit/integration and Playwright checks were green.
- Exact composed command: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e2-composed-final-20260806c E2_T08_IMPLEMENTATION_COMMIT=f23695f3d6f3ff92802304ae9d5bd815ad9fb001 make verify-E2`. All eight targets passed in dependency order, every target exited 0, `zeroSkips: true`, `rootCheckoutCleanBeforeRun: true`, and the final E2-T08 target was bound to `f23695f3d6f3ff92802304ae9d5bd815ad9fb001`.
- Final workflow evidence: lifecycle `draft -> active -> retired`, configuration revisions `[1, 2, 3]`; first snapshot digest `sha256:237e2c373a9c6b4139fe90d13e32c74396878ea7567e63558681eb1e1a334b2f`, second snapshot digest `sha256:e3eb2aff9e07b08d55cf113ce2c1e1b82ab28ee0eeead18f22ace95282ab56b1`, and replay composite digest `sha256:7d3a6eaee703f6081d877d9365d4cf2e94f676cd6152f126e79105ba85ebe141`. The authorization matrix has 206 rows; sensitivity is true; all canary scans are clean.
- Lost-ack evidence records six client-aborted operations with `durableEventCount: 1` and `clientAborted: true`, all same-key retries recovered, and changed-payload create retry exited 4/refused. The actual revoke race observes the durable retired event before the client response, refuses historical snapshot use with `INVOCATION_SNAPSHOT_AGENT_CONFIG_INACTIVE`, durably revokes both connection grants, and verifies historical snapshot bytes remain stable.
- Evidence: `evidence/e2-t08-final/verification-summary.json`, `http-transcript.json`, `cli-transcript.json`, `source-dumps.json`, `snapshot-manifests.json`, `role-matrix.json`, `roster.json`, `revocation-races.json`, `replay-composite.json`, `tamper-matrix.json`, `sensitivity.json`, `canary-scan.json`, `cold-clone-transcript.json`, and `composed-verify-transcript.json`.
- Replay: N/A (server/CLI agent-control capstone) + mitigation: role matrix, revision/snapshot manifests, revocation race, canary scan, and composite stream replay.
- Claim: the builder considers the remaining lost-ack proof gap closed and E2-T08 implemented; a third fresh critic must independently verify the exact final diff and promoted evidence before this task can become `verified`.

### Critic — 2026-08-06 — third independent verification

- `VERDICT: refuted` from fresh independent agent `019fd9c7-310f-74a2-9232-3717dbcd61de`, which reviewed implementation commit `f23695f3d6f3ff92802304ae9d5bd815ad9fb001`, evidence commit `4c5b125`, and the task specification without editing the worktree.
- The critic independently confirmed the final verifier and composed manifest, all six lost-ack operations with one durable matching event and successful retries, revoke fencing and snapshot stability, connection revocation, fresh replay, role matrix, canary/tamper coverage, and disposable sensitivity mutant. It found one wrapper gap: plain `make verify-E2-T08` exits 2 after the verifier passes because `scripts/cold-verify-e2-t08.mjs` scans artifact directory entries as files and reads the generated `playwright/` and `sensitivity-mutant/` directories, causing `EISDIR`; promoted mode masks this by writing directly into the evidence directory.
- Status: `in-progress`; builder must make artifact scanning regular-file-safe, then rerun the plain cold target and obtain a fresh critic verdict.

### Builder — 2026-08-06 — wrapper-safe final cold/composed proof

- Wrapper-fix implementation commit: `db4ff223843b19ce0a5630a7af23804a074f259f`. `scripts/cold-verify-e2-t08.mjs` now filters the artifact destination to regular files before the canary scan, so the plain target cannot mistake generated `playwright/` or `sensitivity-mutant/` directories for evidence files.
- Exact plain cold command: `TEST_RUN_ID=e2-t08-plain-final-20260806g E2_T08_IMPLEMENTATION_COMMIT=db4ff223843b19ce0a5630a7af23804a074f259f make verify-E2-T08`. It exited 0 from a detached clean clone after all six gates, 158 tests, 5 Playwright tests, build, verifier, and the post-verifier artifact scan; result `PASS`, `sensitivity: true`, and `skips: []`.
- Exact promoted cold command: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e2-t08-cold-final-20260806g E2_T08_IMPLEMENTATION_COMMIT=db4ff223843b19ce0a5630a7af23804a074f259f make verify-E2-T08`. All six gates exited 0 with `skips: []`; the promoted cold evidence was committed as `49d0f2639f96f6a3e755c7acafa2af2606fba108` and the final composed evidence as `e5c382d323d7a536ae4bf2ca578296ef52d7f45f`.
- Exact composed command: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e2-composed-final-20260806d E2_T08_IMPLEMENTATION_COMMIT=db4ff223843b19ce0a5630a7af23804a074f259f make verify-E2`. All eight E2 targets passed in dependency order from clean cold clones, every command exited 0, `zeroSkips: true`, `rootCheckoutCleanBeforeRun: true`, and E2-T08 was bound to `db4ff223843b19ce0a5630a7af23804a074f259f`; composed evidence commit is `e5c382d323d7a536ae4bf2ca578296ef52d7f45f`.
- Final workflow evidence: lifecycle `draft -> active -> retired`, configuration revisions `[1, 2, 3]`; six mutating CLI operations each use client-aborted-after-durable-append plus same-key recovery with exactly one durable event. First snapshot digest `sha256:237e2c373a9c6b4139fe90d13e32c74396878ea7567e63558681eb1e1a334b2f`, second snapshot digest `sha256:e3eb2aff9e07b08d55cf113ce2c1e1b82ab28ee0eeead18f22ace95282ab56b1`, first bytes stable after reconfigure/revoke, and matrix coverage is 206 rows with 68 refused rows.
- Revocation and replay evidence: revoke observes the durable retired event before response, refuses historical snapshot use with `INVOCATION_SNAPSHOT_AGENT_CONFIG_INACTIVE`, durably revokes both grants, and preserves historical snapshot bytes. A fresh replay store seeds directory 43, config 6, both connection streams 3 each, dispatch 12, and audit 0 records; projection deletion/replay reproduces roster, retired active config, revision history, connections, and snapshot manifests to composite digest `sha256:7d3a6eaee703f6081d877d9365d4cf2e94f676cd6152f126e79105ba85ebe141`.
- Sensitivity and canary evidence: 9 targeted mutations go red, including the disposable replay-composite source-digest mutant; `sensitivity: true`, canary scan `PASS`, and `publishedEvidenceLeaked: false`. Evidence files are `evidence/e2-t08-final/verification-summary.json`, `http-transcript.json`, `cli-transcript.json`, `source-dumps.json`, `snapshot-manifests.json`, `role-matrix.json`, `roster.json`, `revocation-races.json`, `replay-composite.json`, `tamper-matrix.json`, `sensitivity.json`, `canary-scan.json`, `cold-clone-transcript.json`, and `composed-verify-transcript.json`.
- Replay: N/A (server/CLI agent-control capstone) + mitigation: role matrix, revision/snapshot manifests, revocation race, canary scan, and composite stream replay.
- Claim: the wrapper gap is closed and E2-T08 is implemented; a fourth fresh critic must independently verify the exact diff, plain/promoted/composed proof, and committed evidence before this task can become `verified`.

### Critic — 2026-08-06 — fourth independent verification

- `VERDICT: verified` from fresh independent agent `019fda10-7cb1-7c83-a543-f60a45375e92`, which reviewed the exact implementation commit `db4ff223843b19ce0a5630a7af23804a074f259f`, promoted evidence commit `49d0f2639f96f6a3e755c7acafa2af2606fba108`, composed evidence commit `e5c382d323d7a536ae4bf2ca578296ef52d7f45f`, and handoff commit `1473865359cf163c86815afed9cec1308cecede9` without editing the worktree.
- The critic reran the plain cold command and confirmed 158 tests, 5 Playwright tests, six gates, zero skips, and a successful post-verifier artifact scan. It verified the `Dirent.isFile()` filter at `scripts/cold-verify-e2-t08.mjs:176`, independently recomputed both snapshot digests and composite digest `sha256:7d3a6eaee703f6081d877d9365d4cf2e94f676cd6152f126e79105ba85ebe141`, confirmed all six lost-ack operations, 206 authorization rows, revoke/grant fencing, fresh replay, canary pass, and the nine-mutation sensitivity mutant exiting 1.
- Status: `verified`; the main tracked worktree was clean after the critic run.
