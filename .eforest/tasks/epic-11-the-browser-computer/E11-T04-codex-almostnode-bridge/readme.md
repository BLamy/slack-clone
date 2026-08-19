---
id: E11-T04
epic: 11
title: Codex AlmostNode bridge
priority: 1104
status: pending
depends_on: [E11-T03]
estimate: L
capstone: false
---

## Goal

The pinned `@agent-wasm/codex` runtime executes through the AlmostNode `AgentAdapter` and
normalizes lifecycle, prompts, tool requests, output, cancellation, and terminal status
into the same harness/run protocol used by server sandboxes.

## Context

This is a reach adapter, not a second agent protocol and not a production fallback. It may
use only E11-T03-conformant browser capabilities; credentials and service calls wait for
the brokered E11-T06 path.

## Deliverables

- Version-pinned Codex browser harness bridge using `@agent-wasm/codex`.
- Normalized input/event/cancel/terminal mapping and capability declaration.
- Deterministic local task corpus with tool, output, failure, and cancellation cases.
- Browser Replay, same-session MP4, and cross-harness event manifest.

## Acceptance criteria

- [ ] Real `@agent-wasm/codex` code runs inside the conformance-proven browser boundary;
      host Codex, mock model/harness success, or out-of-band result injection fails the gate.
- [ ] Every emitted event validates against the common harness/run schema and preserves
      run/attempt ids, sequence, causation, timestamps, exit class, and redacted payload.
- [ ] Duplicate input/tool delivery and cancel/terminal races produce one normalized effect
      and one terminal state; reconnect resumes from durable sequence without loss.
- [ ] The bridge advertises only capabilities exercised by the corpus and cannot request
      credentials, tools, egress, or filesystem access outside the pinned run policy.
- [ ] The final Codex task/failure/cancel walkthrough has Replay and same-session MP4,
      zero console errors, and run offsets/digests equal independent replay.

## Adversarial verification

1. Remove/rename `@agent-wasm/codex` and block host execution; a still-green run refutes
   proof that the real browser harness ran.
2. Duplicate/reorder tool and terminal events, kill the worker, and reconnect; duplicate
   effects or sequence gaps refute normalization.
3. Ask Codex to escape workspace/policy through prompts and tool arguments; any broker,
   filesystem, or network effect outside grants refutes containment.
4. Rebuild run projection from the Replay-correlated event manifest; unequal digests,
   hidden host calls, or console errors refute the bridge claim.

## Verification log
