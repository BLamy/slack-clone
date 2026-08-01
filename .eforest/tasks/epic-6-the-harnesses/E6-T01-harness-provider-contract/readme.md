---
id: E6-T01
epic: 6
title: "Harness provider contract: Codex and Claude Code behind one fenced invocation interface"
priority: 601
status: pending
depends_on: [E4, E5]
estimate: L
capstone: false
---

## Goal

`packages/harness` defines a `HarnessProvider` contract that prepares a pinned harness,
starts one fresh invocation in a sandbox, streams normalized activity, cancels it, and
returns a canonical terminal result. Agent configuration selects a registered harness id
and version policy; it cannot supply executables, host flags, raw credentials, or tools.

## Context

Codex CLI and Claude Code differ in command-line shape and event formats, but sandbox,
broker, policy, provenance, and reply semantics must not fork. The contract freezes the
common security boundary while adapters retain typed provider-specific metadata for
debugging.

## Deliverables

- `packages/harness/src/provider.ts`, `events.ts`, `capabilities.ts`, `result.ts`, and
  frozen provider/error schemas.
- Deterministic scripted harness used only for contract tests and mutation sensitivity.
- `make verify-E6-T01` with lifecycle, stream, cancellation, and malformed-event fixtures.

## Acceptance criteria

- [ ] `make verify-E6-T01` passes cold and replays two independent provider transcripts
      twice to byte-identical normalized activity and terminal-result digests.
- [ ] The contract requires run/lease, invocation/config/workspace/catalog digests,
      sandbox handle, harness artifact digest, allowed tools, budgets, and idempotency key.
- [ ] Providers expose typed support for streaming events, cancellation, structured tool
      calls, resume policy, model selection, and auth mode; unsupported requirements fail
      before process launch.
- [ ] Only the orchestrator chooses executable and frozen flags from a registered adapter;
      agent/user text cannot inject argv, environment, working directory, or tool endpoints.
- [ ] Duplicate start returns one invocation, exactly one terminal result is accepted, and
      stale lease/cancel fences all later activity.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (headless harness contract) +
      mitigation: cold-clone transcript replay, argv/env injection corpus, lifecycle
      races, canonical result digests, and mutation sensitivity`.

## Adversarial verification

1. Inject shell metacharacters, flags, env names, paths, and tool URLs through every agent
   config/text field. None may alter the registered launch plan.
2. Reorder/duplicate malformed activity and race cancel with terminal result. Normalized
   state must remain deterministic with one terminal event.
3. Request unsupported capabilities and cross-run sandbox/tool handles. No child process
   may start before refusal.
4. Delete the immutable launch-plan check in a scratch worktree. The injection corpus
   must make `verify-E6-T01` fail.

## Verification log
