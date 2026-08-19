---
id: E11-T08
epic: 11
title: Two harness and two sandbox parity
priority: 1108
status: pending
depends_on: [E11-T07]
estimate: L
capstone: true
---

## Goal

From a cold start, the same bounded service-backed task executes through Codex and Claude
Code on both the pinned Cloudflare OS production sandbox and explicit AlmostNode reach sandbox,
producing protocol-conformant outcomes, evidence, and policy enforcement without claiming
browser support that the real harnesses did not earn.

## Context

This capstone is a four-cell parity proof, not a routing migration. Cloudflare OS remains the
production default; AlmostNode requires explicit reach selection and is never a fallback.
If real Claude Code cannot pass E11-T05, this task cannot be verified and no mock or
substitute may satisfy the missing cell.

## Deliverables

- Cold-start 2x2 matrix harness with identical task, service policy, fixtures, budgets,
  expected semantic result, and normalized evidence schema.
- Per-cell stream/event/artifact/media manifests and one composite parity digest report.
- Final Replay recordings and same-session MP4s for browser-hosted AlmostNode cells plus
  equivalent verified evidence for Cloudflare OS cells.
- Sensitivity legs for harness substitution, host fallback, provider reroute, and leakage.

## Acceptance criteria

- [ ] All four cells use actual pinned Codex/Claude harnesses and Cloudflare OS/AlmostNode providers;
      mocks, host execution for browser cells, or provider substitution fail authenticity.
- [ ] Each cell starts from fresh workspace/sandbox/session state, receives the same
      versioned task and effective policy, and produces the same canonical semantic result
      while provider-specific events remain explicitly classified.
- [ ] Normalized run ordering, terminal class, tool/service effects, artifact hashes,
      approvals, and audit causation satisfy the common protocol in every cell.
- [ ] The real service operation uses Infisical Agent Proxy under attempt-bound capability;
      canaries are absent from every browser, Wasm, worker, stream, log, artifact, Replay,
      MP4, and Cloudflare OS evidence surface.
- [ ] AlmostNode runs occur only after explicit reach selection; disabling/failing it never
      reroutes production Cloudflare OS runs or changes Cloudflare OS provider configuration/defaults.
- [ ] Independent replay of per-cell run/audit/artifact streams equals displayed offsets/
      digests and the composite parity report; one tampered event makes the verifier red.
- [ ] Final AlmostNode evidence includes Replay and MP4 from each same browser session,
      covering both harnesses with zero console/page/network errors, zero skips,
      zero fallback proof, and verified links to the corresponding Cloudflare OS-cell evidence.

## Adversarial verification

1. Repeat from critic-created fresh roots with host harnesses and undeclared bridges
   blocked; any warm state, mock, or host fallback refutes a matrix cell.
2. Remove each harness/provider in turn and plant a protocol-perfect substitute; a green
   authenticity gate refutes parity sensitivity.
3. Force AlmostNode failure before and during a production Cloudflare OS run; rerouting, shared
   credentials/storage, or changed Cloudflare OS behavior refutes reach isolation.
4. Recompute all four projections, artifact hashes, policy decisions, service effects,
   and composite digest independently; unexplained semantic drift or tamper tolerance fails.
5. Interrogate each Replay/MP4 pair and scan every evidence surface for canaries, hidden
   errors, skipped real harness work, or cross-cell state; any hit is terminal refutation.

## Verification log
