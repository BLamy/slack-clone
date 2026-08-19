---
id: E10-T08
epic: 10
title: Issue to agent to approved result
priority: 1008
status: pending
depends_on: [E10-T05, E10-T06, E10-T07]
estimate: L
capstone: true
---

## Goal

From a cold start, an Electric Forest issue enters a linked branch room, a human assigns
an agent, the agent delegates one bounded subtask, both attach verifiable evidence, a
human approves the proposed result, and the canonical project receives exactly that
approved result through its native command door.

## Context

This capstone proves the Buzz-like hive on Durable Streams: collaboration, workflows,
search, project truth, delegation, evidence, and human approval form one replayable causal
chain without Nostr, Git, a database, or chat text becoming authority.

## Deliverables

- Cold-start issue-to-result harness with fresh project, workspace, agents, and browsers.
- Composite replay manifest spanning project, room, workflow, run, delegation, approval,
  search, artifact, and audit streams.
- Final Replay recording set and same-run MP4 evidence with verified artifact hashes.
- Sensitivity legs for duplicate issue, forged delegation, stale approval, and tampering.

## Acceptance criteria

- [ ] The capstone uses fresh streams, project, workspace, sessions, sandboxes, provider
      state, and artifacts with scrubbed environment and ephemeral ports.
- [ ] One source issue yields one linked branch room and workflow instance; duplicate
      delivery/reconnect cannot create duplicate rooms, runs, delegation, or source result.
- [ ] Parent and child agents run under their pinned, intersected policies; the human
      approval binds exact result/evidence/source-head digests and a stale result is refused.
- [ ] The project adapter applies exactly the approved result through its native door;
      branch-room text, workflow projection, and artifacts cannot mutate project truth.
- [ ] Every evidence reference resolves to authorized immutable bytes and verified hashes;
      search locates the result only for authorized principals and reveals nothing outside ACLs.
- [ ] Independent replay of all member streams matches every visible offset/digest and one
      final composite digest linking source issue through approved result.
- [ ] Final Replay and same-session MP4 evidence shows issue arrival, room creation, both
      agents, delegation, evidence, approval, and source result with zero console/page/
      network errors, skips, fallbacks, secret leaks, or unresolved references.

## Adversarial verification

1. Repeat from critic-created fresh roots; any inherited issue, room, agent, artifact,
   index, or provider state refutes the cold-start claim.
2. Duplicate/reorder source, workflow, delegation, evidence, and approval events while
   crashing workers; more than one effective result refutes idempotency.
3. Mutate result, source head, evidence hash, policy, or approval after presentation;
   source acceptance of a stale/mismatched tuple refutes the approval gate.
4. Rebuild every projection and composite independently, then tamper one member byte;
   equality after tamper or mismatch before tamper refutes proof integrity.
5. Interrogate Replay/MP4, search, artifacts, and source state for the complete causal
   story, ACL enforcement, zero errors, and zero canaries; partial media or leakage fails.

## Verification log
