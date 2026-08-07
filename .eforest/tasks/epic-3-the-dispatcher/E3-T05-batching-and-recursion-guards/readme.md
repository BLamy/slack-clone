---
id: E3-T05
epic: 3
title: "Per-conversation batching, serialization, and recursion guards"
priority: 305
status: implemented
depends_on: [E3-T02, E3-T03]
estimate: L
capstone: false
---

## Goal

Serialize work under a configurable agent/conversation key, deterministically batch queued
mentions when allowed, and prevent self-trigger, agent-to-agent cycles, unbounded fan-out, and
cost explosions before a harness process starts.

## Context

Mentions can arrive faster than an agent can answer. The default permits at most one active
run per agent and thread/channel scope, preserving understandable conversation order. Each
source invocation remains independently traceable even when several are included in one
batch. Human-authored mentions trigger by default; agent-authored delegation is opt-in and
requires explicit target grants, maximum depth, fan-out, concurrency, and aggregate budget.

Agent replies, quoted mentions, edits, retries, and replay are never accidental triggers.
Cycles are detected from durable causation chains, not process-local sets.

## Deliverables

- Concurrency-key, queue-order, deterministic batch, and source-invocation manifest contracts.
- Delegation graph, causation-depth, fan-out, concurrency, and aggregate-budget guards.
- Burst, self-mention, mutual-cycle, replay, retry, and fairness fixtures.
- `make verify-E3-T05` cold-clone target and scheduling evidence.

## Acceptance criteria

- [ ] `make verify-E3-T05` exits 0 from a cold clone and records queue order, batches,
      concurrency keys,
      causation graphs, refusals, and final scheduling digests.
- [ ] At most one run is active for each configured agent/conversation key; queued work
      advances in deterministic source-offset order with no starvation across independent keys.
- [ ] Every batched source invocation is listed once with its source offset/digest and reaches
      one terminal disposition even though one harness call may serve the batch.
- [ ] Human-authored canonical mentions trigger by default; agent-authored mentions require an
      explicit current delegation grant and configured depth, fan-out, concurrency, and budget.
- [ ] Self-mentions, quoted/code mentions, edits, retries, replayed source events, and agent
      reply text create no accidental second invocation.
- [ ] Cycles and limit breaches append typed non-running outcomes before provider side effects,
      and aggregate budgets are consumed deterministically across the causation tree.
- [ ] Replay is declared `Replay: N/A (server scheduling and recursion policy) + mitigation:
      burst schedules, durable causation graphs, cycle/fairness matrix, and replay digests`.

## Adversarial verification

1. Send bursts from many humans to one agent/thread and to independent keys under randomized
   delivery. Overlap on one key or starvation of another refutes scheduling.
2. Construct self, two-agent, long-cycle, diamond, and fan-out graphs at every limit boundary.
   One process launch beyond policy refutes recursion guards.
3. Retry, edit, delete, restore, and replay every source in a batch. Duplicate inclusion or
   missing terminal disposition refutes traceability.
4. Revoke delegation and budget while descendants queue. Any newly started descendant under
   stale authority refutes current-policy checking.
5. Remove cycle detection or the concurrency key in a scratch worktree; frozen schedules
   must fail.

## Verification log

### Builder repair — 2026-08-07 — commit `573c21329dc2fb80d96c2219309d9084c2276457`

- Cold proof: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e3-t05-cold-repaired-20260807 E3_T05_IMPLEMENTATION_COMMIT=573c21329dc2fb80d96c2219309d9084c2276457 make verify-E3-T05` exited 0 from a detached clean worktree after submodule initialization, frozen install, and emulator setup.
- Gates: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all passed. The promoted transcript records command output hashes and the clean checkout proof in `evidence/e3-t05-final/cold-clone-transcript.json`.
- Evidence: `batch-manifest.json` records two deterministic batches, one provider call for three source members, and three terminal dispositions; `concurrency-keys.json`, `fairness.json`, `causation-graph.json`, `refusals.json`, `aggregate-budget.json`, and `replay-digests.json` record the queue, key, causation, typed refusal, fairness, sibling-budget, and replay claims.
- Guard matrix: seven non-running refusals cover self-authored, quoted/code, edit, retry, agent-reply, and replay sources; delegation-required, revoked, cycle, depth, fan-out, concurrency, and aggregate-budget breaches are typed before provider execution.
- Aggregate budget repair: admitted siblings share a root accumulator in deterministic source-offset order; the second sibling in `aggregate-budget.json` sees the first sibling's usage and is refused before provider execution.
- Sensitivity: `sensitivity.json` shows all three detached mutations (self-trigger fence, cycle fence, and conversation-key fence) were detected by the verifier; `canary-scan.json` reports no leaked values across the promoted evidence.
- Replay: `Replay: N/A (server scheduling and recursion policy) + mitigation: burst schedules, durable causation graphs, cycle/fairness matrix, and replay digests`.
- Claim: E3-T05 deliverables are implemented, the earlier aggregate-budget gap is repaired, and the exact diff plus cold evidence are ready for a fresh critic; no browser recording is applicable to this server-only task.
