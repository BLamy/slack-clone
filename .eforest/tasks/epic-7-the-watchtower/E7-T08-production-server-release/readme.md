---
id: E7-T08
epic: 7
title: "Capstone: a multi-replica production server runs real Codex and Claude agents with brokered tools through failover"
priority: 708
status: pending
depends_on: [E7-T06, E7-T07]
estimate: L
capstone: true
---

## Goal

A signed production deployment with at least two server/worker replicas accepts Slack API
messages that mention Codex- and Claude-backed agents, schedules real Fly Sprites, injects
connections through real Infisical Agent Proxy, executes approved tools, publishes one
provenance-bound reply per invocation, and survives replica failover with exact replay,
cost, security, and cleanup evidence.

## Context

This is the server-first release gate before product UI expansion and the later almostnode
reach. Local emulators and fakes remain developer tools but cannot certify production.
The test uses dedicated tenants, users, agents, connections, providers, and canary data
with least privilege and an explicit cleanup inventory.

## Deliverables

- Signed production release manifest and deployment record with artifact/config/identity
  digests.
- API-driven end-to-end release scenario for Codex and Claude, replica kill/failover,
  approval, cancellation, revocation, export/rebuild, and provider cleanup.
- `make verify-E7-T08-production` as the registered Epic 7 capstone target.

## Acceptance criteria

- [ ] `tools/verify/cold_clone.sh verify-E7-T08-production` targets the attested production
      deployment with multiple replicas, real Durable Streams, Fly Sprites, Infisical
      Agent Proxy, Codex CLI, and Claude Code; missing/false provider evidence exits
      nonzero with `SKIPPED:` and no local/fake fallback can pass.
- [ ] Two authenticated tenant users mention differently configured agents; each invocation
      captures exact config/context/catalog/grant/harness digests and publishes exactly one
      reply attributed to the correct agent and run.
- [ ] Killing the active replica after sandbox create and during tool execution transfers
      ownership without a second Sprite, service call, cost charge, or reply; stale-owner
      writes are refused and the run stream replays to the observed terminal state.
- [ ] Approval mutation, cross-tenant ids, direct egress, stolen proxy identity, prompt/
      workspace injection, over-budget continuation, and post-cancel tool/message effects
      all fail with unchanged forbidden heads and no canary leakage.
- [ ] Exporting the isolated tenant and rebuilding every projection yields exact live
      digests; cost ledger matches provider observations; final Fly/proxy/run inventories
      contain no test resources or active identities.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (API-driven production server
      capstone; product UI release is later) + mitigation: cold-clone production-provider
      attestations, API transcript, replay/export digests, failover side-effect ledger,
      security canary scans, cost parity, and cleanup inventories`.

## Adversarial verification

1. Independently attest artifact signature, deployment replica count, provider identities,
   harness process/version, Sprite ids, broker mode, service audit requests, and message
   events. Any fake/local substitution refutes release.
2. Kill/partition replicas at every external-effect boundary and heal stale replicas.
   Logical effects must remain exactly once and ownership fencing visible in events.
3. Run the E7-T06 attack corpus against the deployed system concurrently across tenants,
   including cancellation/revocation/budget races. One forbidden effect is a release stop.
4. Tamper one artifact/config/identity or disable one failover/security assertion in a
   scratch release candidate. The production target must fail before declaring capstone.

## Verification log
