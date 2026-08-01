---
id: E11-T01
epic: 11
title: AlmostNode feasibility and threat classification
priority: 1101
status: pending
depends_on: [E10]
estimate: M
capstone: false
---

## Goal

A reproducible probe suite and threat model classify which sandbox and harness contracts
AlmostNode can satisfy in the browser, which require a broker, and which are unsupported,
using current `@agent-wasm/sdk` workspace/`AgentAdapter` and `@agent-wasm/codex` surfaces.

## Context

Epic 11 is an explicit final reach epic. It is not on the Fly production path and cannot
change Fly defaults, reliability gates, or security posture. Claude Code browser support
is unknown until this task's executable probes prove its prerequisites.

## Deliverables

- Version-pinned runtime capability probe covering workspace, process, filesystem,
  streaming I/O, cancellation, networking, storage, and both harness prerequisites.
- Threat model and trust-boundary/data-flow inventory for browser, worker/Wasm, brokers,
  Durable Streams, Infisical Agent Proxy, service workers, storage, and app origin.
- Go/no-go matrix with evidence links, unsupported reasons, and required mitigations.
- Browser probe Replay, same-session MP4, console/network log, and environment manifest.

## Acceptance criteria

- [ ] Every required sandbox/harness capability has an executed positive or negative probe,
      pinned package/browser versions, exact observable, and reproducible artifact.
- [ ] Claude Code is marked supported only if its real runtime prerequisites execute in
      the browser boundary; mocks, Node on the host, or translating it to Codex do not count.
- [ ] The threat model classifies secret exposure, origin/storage escape, broker abuse,
      egress, persistence, supply-chain, denial-of-service, and cross-workspace attacks with
      a fail-closed mitigation or explicit blocker for every high-risk path.
- [ ] No probe changes the registered Fly production provider, defaults, policies, or run
      routing; a repository/config diff proves reach isolation.
- [ ] The final probe journey has a cited Replay and same-session MP4 with zero console
      errors; expected negative-probe failures are asserted as typed results, not exceptions.

## Adversarial verification

1. Re-run probes with host Node/process/network unavailable; any claimed browser capability
   that secretly uses the host refutes feasibility evidence.
2. Substitute package/browser versions and remove one prerequisite; a still-green stale
   matrix refutes version pinning and sensitivity.
3. Attempt origin, storage, worker, broker, and egress escapes described in the threat model;
   an unclassified high-risk path refutes completeness.
4. Compare Replay/MP4, console/network logs, and repository diff; hidden host execution,
   unexplained errors, or a Fly-path change refutes the reach-only claim.

## Verification log
