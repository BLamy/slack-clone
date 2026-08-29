---
id: E6-T07
epic: 6
title: "Capstone: Codex and Claude Code each complete the same brokered task on real Fly Sprites"
priority: 607
status: pending
depends_on: [E6-T05, E6-T06]
estimate: L
capstone: true
---

## Goal

From a cold clone, two agent configurations differing only by harness run the same pinned
task on separate real Fly Sprites: one with Codex CLI, one with Claude Code. Each starts
fresh, uses the same granted brokered tool through Infisical Agent Proxy, publishes a
provenance-bound Slack reply, and cleans up without secret or session leakage.

## Context

This proves harness choice is real and portable rather than two scripted code paths.
Protocol fakes, stub model output, Agent Vault, local processes, or ordinary Infisical
caching Proxy cannot satisfy the capstone. Provider unavailability is a visible blocker.

## Deliverables

- Real Codex and Claude agent fixtures with pinned artifact/model configuration.
- One deterministic read-oriented canary service task and expected semantic/result
  invariants, plus provider/harness/broker attestation manifests.
- `make verify-E6-T07-real` as the registered Epic 6 capstone target.

## Acceptance criteria

- [ ] `tools/verify/cold_clone.sh verify-E6-T07-real` attests real Fly, real Codex CLI,
      real Claude Code, and real Infisical Agent Proxy; missing any provider exits nonzero
      with `SKIPPED:` and no fake/local fallback can pass.
- [ ] Both invocations cite the same context/workspace/catalog/grant/task digests and
      distinct harness artifact, run, Sprite, proxy identity, and fresh-home identities.
- [ ] Each harness independently search/describes and executes the same granted operation;
      canonical policy/request digests match, and the service observes exactly one request
      per run with no extra destination.
- [ ] Each normalized result satisfies the committed semantic invariant and publishes one
      provenance-bound agent reply; native transcript differences remain attached but do
      not change authorization or provenance fields.
- [ ] Cancellation/revocation of a follow-up probe stops both harness process trees and
      broker access; canary scans find no service/model credentials or prior-session data,
      and final Fly inventory is empty.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (real headless dual-harness
      capstone) + mitigation: cold-clone real-provider attestations, canonical request and
      reply digests, target-service counts, canary scans, and Fly inventories`.

## Adversarial verification

1. Independently verify process/version output, artifact digests, provider resource ids,
   model calls, and target-service audit data for both runs; scripted substitution refutes.
2. Plant prior-session canaries and workspace tool/config injection for both harnesses.
   Neither may alter launch, tool scope, or output.
3. Race cancel, identity revoke, output reconnect, and tool execution. Each run must settle
   once with no post-terminal request or message.
4. Break Codex then Claude launch attestation and shared request normalization separately.
   Each mutation must turn the real capstone target red.

## Verification log
