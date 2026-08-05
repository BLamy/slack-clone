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

### Builder — 2026-08-04 — multi-user chat API capstone and cold proof

- Implementation commit: `a9347bb7820d5e5d8395ebf0e9111cf6e3124db4` adds the Durable Streams-backed
  public/private/DM API, HTTP/SSE session delivery, agent/member identity boundaries, structured
  mention receipts, access revocation, projection recovery verifier, and cold-clone gate.
- Exact promoted cold command:
  `PROMOTE_EVIDENCE=1 E1_T08_IMPLEMENTATION_COMMIT=a9347bb7820d5e5d8395ebf0e9111cf6e3124db4
  TEST_RUN_ID=e1-t08-final-2 make verify-E1-T08`. The detached checkout initialized the pinned
  emulator, completed frozen install/setup, and passed `pnpm format:check`, `pnpm lint`,
  `pnpm typecheck`, `pnpm test`, and `pnpm build`; the test suite recorded 129 unit/integration
  passes and five Playwright passes.
- Exact composed cold command:
  `E1_T08_IMPLEMENTATION_COMMIT=a9347bb7820d5e5d8395ebf0e9111cf6e3124db4
  TEST_RUN_ID=e1-composed-20260804 make verify-E1` returned exit code 0 after running
  `verify-E1-T01` through `verify-E1-T08` in order. Each target created its cold checkout,
  installed from its frozen lockfile, rebuilt the pinned emulator/query state, and returned PASS;
  the capstone target returned zero skips. The committed transcript is
  `evidence/e1-t08-final/composed-verify-transcript.json`.
- The final source replay covers 38 records across the workspace directory and public, private, and
  direct channel streams. Final state digest is `sha256:421913b4abb70138e823e70b32e161ea2c5ecd11c01c3e28c8b9069be4087a06`;
  the rebuild/catch-up composite digest is
  `sha256:2b9db2630e42f4ff910d7702c2b6c317257dd8816dc772025b5cfcb9da7664cc`.
- Live HTTP/SSE evidence covers two human sessions, an inert agent member, public/private/DM
  create/reply/edit/delete/reaction flows, idempotent retry, reconnect from checkpoint, and live
  private membership removal. Agent mention provenance is exactly one source binding, remains stable
  after handle/owner changes, and launches no process. Access probes for removed, service, and
  sibling-workspace principals are generic `CAPSTONE_ACCESS_DENIED` with no private metadata leak.
- Projection deletion/rebuild, catch-up from a persisted checkpoint, two independent offline replays,
  randomized message interleavings, source/row/checkpoint/composite tamper cases, and the canary scan
  all pass with localized sensitivity failures. Promoted evidence is under `evidence/e1-t08-final/`,
  including source dump, projection manifest, checkpoints, network transcript, access matrix, mention
  evidence, interleavings, tamper matrix, sensitivity proof, and cold transcript.
- Replay: N/A (server/API capstone; product UI lands later) + mitigation: multi-client HTTP/SSE
  transcript, access matrix, source dumps, projection rebuild, and composite replay digest.
- Claim: the E1-T08 implementation satisfies the acceptance and adversarial checks from a clean cold
  clone; awaiting a fresh independent critic.
