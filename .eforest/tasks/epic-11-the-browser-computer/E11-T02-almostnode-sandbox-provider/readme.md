---
id: E11-T02
epic: 11
title: AlmostNode sandbox provider
priority: 1102
status: pending
depends_on: [E11-T01]
estimate: L
capstone: false
---

## Goal

A reach-only AlmostNode sandbox adapter implements the provider-neutral lifecycle using
the `@agent-wasm/sdk` workspace and `AgentAdapter`: provision, execute, stream, cancel,
inspect health, and destroy without becoming a Cloudflare OS fallback or production default.

## Context

Only capabilities proven in E11-T01 may be advertised. The adapter is selected explicitly
behind a reach flag; unsupported operations return typed capability errors before a run.

## Deliverables

- AlmostNode provider registration and lifecycle adapter behind an explicit reach gate.
- Workspace image/seed contract, run identity, output normalization, and teardown audit.
- Capability/health reporting derived from runtime probes rather than hardcoded claims.
- Lifecycle browser suite with Replay and same-session MP4.

## Acceptance criteria

- [ ] The adapter passes the shared lifecycle contract for every advertised capability;
      unadvertised operations fail pre-effect with a typed unsupported result.
- [ ] Each run receives a fresh workspace/worker/storage namespace and stable run identity;
      destroy removes its persisted bytes and capabilities within the documented boundary.
- [ ] Cancellation fences later output/tool effects and reaches one terminal state across
      duplicate cancel, tab close, worker crash, and reconnect.
- [ ] Provider selection requires the reach gate and explicit user choice; Cloudflare OS remains the
      unchanged production default, and AlmostNode is never an automatic retry target.
- [ ] The final provision/run/cancel/destroy walkthrough has Replay and same-session MP4,
      zero console errors, and lifecycle stream offsets/digests equal replay.

## Adversarial verification

1. Invoke every provider method regardless of advertised capabilities; a silent shim,
   partial effect, or success on unsupported behavior refutes truthful discovery.
2. Plant data in one workspace, destroy it, then provision another principal/workspace;
   any recovered byte or shared capability refutes isolation.
3. Race cancel/destroy with output and broker calls, then reconnect; post-fence effects or
   multiple terminal states refute lifecycle fencing.
4. Disable the reach flag and fail the adapter; any automatic AlmostNode route or altered
   Cloudflare OS behavior refutes production-path isolation.

## Verification log
