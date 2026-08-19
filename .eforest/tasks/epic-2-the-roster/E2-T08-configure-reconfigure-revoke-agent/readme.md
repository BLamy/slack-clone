---
id: E2-T08
epic: 2
title: "Capstone: configure, reconfigure, and revoke an agent"
priority: 208
status: pending
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
