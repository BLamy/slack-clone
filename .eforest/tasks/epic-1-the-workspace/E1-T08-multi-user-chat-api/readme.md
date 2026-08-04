---
id: E1-T08
epic: 1
title: "Capstone: multi-user, agent-ready chat API"
priority: 108
status: in-progress
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
