---
id: E1-T08
epic: 1
title: "Capstone: multi-user, agent-ready chat API"
priority: 108
status: implemented
depends_on: [E1-T06, E1-T07]
estimate: L
capstone: true
---

## Goal

Prove the workspace and conversation server with two humans and one inert agent principal
sharing authorized channels through snapshots and resumable live APIs, while private data,
identity boundaries, structured mentions, and rebuildability hold under restart.

## Context

This capstone deliberately does not invoke a model. It establishes the Slack-like substrate
Epic 2 configures and Epic 3 executes: agents are visible members governed by the same
channel rules as humans, and a mention is a durable source fact rather than a hidden webhook.
All final state must be explainable from workspace and channel streams after deleting
sessions, process maps, and projections.

## Deliverables

- A deterministic API/CLI scenario spanning public, private, and direct-message channels.
- Two human sessions, one agent member, structured mention fixtures, and membership-revoke
  steps under active live connections.
- Source dumps, projection manifests, network transcript, checkpoints, and composite digest.
- `make verify-E1` and `make verify-E1-T08` cold-clone targets.

## Acceptance criteria

- [ ] `make verify-E1-T08` and composed `make verify-E1` exit 0 from a cold clone with fresh
      emulator/query state, zero skips, and self-contained evidence paths.
- [ ] Two humans create and use public, private, and DM channels; messages, replies, edits,
      deletes, and reactions converge across live clients with canonical state digests.
- [ ] The agent appears through the same principal, directory, membership, and mention APIs
      as humans while remaining explicitly typed and unable to authenticate as its owner.
- [ ] A structured agent mention is bound to exactly one source message offset/digest and
      runs no process; retry, edit, reconnect, and replay create no duplicate trigger fact.
- [ ] Removing a member during a live private-channel session stops subsequent reads/writes,
      and non-member probes reveal no private metadata.
- [ ] After server restart and total projection deletion, rebuild plus live catch-up yields
      the same workspace/channel composite digest as two independent offline replays.
- [ ] Replay is declared `Replay: N/A (server/API capstone; product UI lands later) +
      mitigation: multi-client HTTP/SSE transcript, access matrix, source dumps, projection
      rebuild, and composite replay digest`.

## Adversarial verification

1. Run the scenario with human/agent creation order reversed and randomized message
   interleavings. Final ordering may differ only where the durable log differs.
2. Replay every private operation as a non-member, removed member, owned agent, service
   principal, and sibling-workspace member. One accepted or distinguishable probe refutes
   isolation.
3. Kill the API and projector at every scenario boundary, then resume from durable offsets.
   Lost or duplicated logical state refutes recovery.
4. Change agent handle and owner after the mention. Historical target or actor drift refutes
   stable identity.
5. Tamper with one source event, projection row, checkpoint, and claimed digest separately;
   the capstone verifier must localize each mismatch.

## Verification log

### Builder — 2026-08-04 — implementation, detector repair, and cold proof

- Initial implementation commit: `a9347bb7820d5e5d8395ebf0e9111cf6e3124db4`. Detector and
  evidence hardening commit: `13129da04c3644cb9a8a9d2daaf582420564c544`.
- Exact promoted cold command:
  `PROMOTE_EVIDENCE=1 E1_T08_IMPLEMENTATION_COMMIT=13129da04c3644cb9a8a9d2daaf582420564c544
  TEST_RUN_ID=e1-t08-detector-repair-final make verify-E1-T08`. The detached checkout initialized
  the pinned emulator, completed frozen install/setup, and passed `pnpm format:check`, `pnpm lint`,
  `pnpm typecheck`, `pnpm test`, and `pnpm build`; the test suite recorded 130 unit/integration
  passes and five Playwright passes. The run recorded `implementationTreeCleanAtStart: true`,
  `skips: []`, and result `PASS`.
- The final source replay covers 38 records across the workspace directory and public, private, and
  direct channel streams. Final state digest is `sha256:421913b4abb70138e823e70b32e161ea2c5ecd11c01c3e28c8b9069be4087a06`;
  the rebuild/catch-up composite digest is
  `sha256:2b9db2630e42f4ff910d7702c2b6c317257dd8816dc772025b5cfcb9da7664cc`.
- Live HTTP/SSE evidence covers two human sessions, an inert agent member, public/private/DM
  create/reply/edit/delete/reaction flows, idempotent retry, reconnect from checkpoint, and live
  private membership removal. Agent mention provenance is exactly one source binding, remains stable
  after handle/owner changes, and launches no process. The evidence now labels the reducer replay
  offset separately from the live durable-stream source-binding offset. Access probes for removed,
  service, and sibling-workspace principals are generic `CAPSTONE_ACCESS_DENIED` with no private
  metadata leak.
- Tamper evidence uses the production detectors: source event `PROJECTION_SOURCE_DIGEST_MISMATCH`,
  projection row `PROJECTION_CORRUPT_ROW`, checkpoint `PROJECTION_CHECKPOINT_INVALID`, and claimed
  composite digest `COMPOSITE_DIGEST_MISMATCH`; all four are observed and localized. Sensitivity is
  proved by mutating a disposable worktree to omit the private-channel membership recheck: install
  exits 0 and the verifier exits 1.
- Exact composed cold command:
  `PROMOTE_EVIDENCE=1 E1_T08_IMPLEMENTATION_COMMIT=13129da04c3644cb9a8a9d2daaf582420564c544
  TEST_RUN_ID=e1-composed-detector-repair-final make verify-E1`. The generated transcript records
  `verify-E1-T01` through `verify-E1-T08` in order, actual child exit code 0 for every target,
  `rootCheckoutCleanBeforeRun: true`, `zeroSkips: true`, and result `PASS`. It is generated by
  `scripts/composed-verify-e1.mjs` and committed at
  `evidence/e1-t08-final/composed-verify-transcript.json`.
- Promoted evidence is under `evidence/e1-t08-final/`, including source dump, projection manifest,
  checkpoints, network transcript, access matrix, mention evidence, interleavings, tamper matrix,
  sensitivity proof, cold transcript, and composed transcript.
- Replay: N/A (server/API capstone; product UI lands later) + mitigation: multi-client HTTP/SSE
  transcript, access matrix, source dumps, projection rebuild, and composite replay digest.
- Claim: the E1-T08 implementation and its verification apparatus satisfy the acceptance and
  adversarial checks from a clean cold clone; awaiting a fresh independent critic.
