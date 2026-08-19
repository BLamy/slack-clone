---
id: E3-T05
epic: 3
title: "Per-conversation batching, serialization, and recursion guards"
priority: 305
status: verified
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

### Builder repair — 2026-08-07 — commit `3e9f66c4456bed51e14bee3ab2291e03f5d82c77`

- Cold proof: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e3-t05-cold-final-20260807-v3 E3_T05_IMPLEMENTATION_COMMIT=3e9f66c4456bed51e14bee3ab2291e03f5d82c77 make verify-E3-T05` exited 0 from a detached clean worktree after submodule initialization, frozen install, and emulator setup.
- Gates: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all passed. The promoted transcript records command output hashes and the clean checkout proof in `evidence/e3-t05-final/cold-clone-transcript.json`.
- Evidence: `batch-manifest.json` records two deterministic batches, one provider call for three source members, and three terminal dispositions; `concurrency-keys.json`, `fairness.json`, `causation-graph.json`, `refusals.json`, `aggregate-budget.json`, and `replay-digests.json` record the queue, key, causation, typed refusal, fairness, sibling-budget, and replay claims.
- Guard matrix: seven non-running refusals cover self-authored, quoted/code, edit, retry, agent-reply, and replay sources; delegation-required, revoked, cycle, depth, fan-out, concurrency, and aggregate-budget breaches are typed before provider execution.
- Aggregate budget repair: admitted siblings share a root accumulator in deterministic source-offset order; the second sibling in `aggregate-budget.json` declares a wider budget but inherits the smaller root budget, sees the first sibling's usage, and is refused before provider execution.
- Sensitivity: `sensitivity.json` shows all five detached mutations (self-trigger fence, cycle fence, conversation-key fence, aggregate-budget accumulator, and aggregate-budget narrowing) were detected by the verifier; `canary-scan.json` reports no leaked values across the promoted evidence.
- Replay: `Replay: N/A (server scheduling and recursion policy) + mitigation: burst schedules, durable causation graphs, cycle/fairness matrix, and replay digests`.
- Claim: E3-T05 deliverables are implemented, the earlier aggregate-budget gap is repaired, and the exact diff plus cold evidence are ready for a fresh critic; no browser recording is applicable to this server-only task.

### Critic — 2026-08-07 — commit `3e9f66c4456bed51e14bee3ab2291e03f5d82c77`

VERDICT: verified

- Execution limitation, stated honestly: this critic session could not execute an
  interpreter (`node -e`, `node scripts/verify-e3-t05.mjs`, and `make verify-E3-T05` were
  all refused by the environment before running). No command output in this entry is
  claimed as a fresh run. The audit is a static interrogation of the exact diff, the
  immutable cold transcript, the promoted evidence, and the sensitivity harness, resting on
  the builder's already-executed cold proof.
- Provenance: `git diff 3e9f66c..HEAD` over `packages/`, `src/`, `scripts/`, `test/`,
  `Makefile`, and `package.json` is empty, so the tree under review is product-identical to
  the cited implementation commit; commit `28a92dd` touches only evidence and the readme.
  `evidence/e3-t05-final/cold-clone-transcript.json` records a detached worktree at
  `3e9f66c`, an empty `git status --porcelain --untracked-files=all` before install,
  `pnpm install --frozen-lockfile`, `pnpm setup:emulate`, and `node scripts/verify-e3-t05.mjs`
  all at exit 0, with run id `e3-t05-cold-final-20260807-v3` and all five gates PASS.
- Source-order determinism: `planConversationSchedule` sorts on `sourceTrigger.offset` with
  `invocationId` then `agentId` tie-breaks (`compareItems`), and the verifier plans the same
  burst forward and reversed. `replay-digests.json` and `concurrency-keys.json` show
  `scheduleDigest` == `reversedInputDigest`
  (`sha256:24cc503c9df281db996b4b49f64f7a8b8990471f08406fc28ff248128a978a05`), so input
  arrival order cannot change the schedule.
- Refusal before provider: every refusal path returns a `non-running`/`terminal` decision and
  never enters `batches`; the only provider callback (`executeBatch` in
  `src/ledger/conversation-scheduler.mjs`) can only be reached through a planned batch.
  `refusals.json` types self-trigger, quoted, code, edit, retry, agent-reply, and replayed
  sources; `causation-graph.json` types DELEGATION_REQUIRED, DELEGATION_REVOKED, CYCLE,
  DELEGATION_DEPTH, DELEGATION_FANOUT, DELEGATION_CONCURRENCY, and BUDGET_EXCEEDED.
- Traceability: `batch-manifest.json` records two batches, one provider call serving three
  members, three terminal dispositions, and a replayed terminal count of 3.
  `replayConversationSchedule` re-derives both digests and rejects duplicate decisions,
  duplicate terminal dispositions, and any batch member lacking its matching admitted
  decision; the verifier's tamper case (`decisions[0].status = "queued"`) must throw.
- Current grants/limits: `refusalFor` re-reads the item's own `delegationGrant` status,
  source/target agents, channel scope, `maxDepth`, `maxChildren`, and `maxConcurrent` at
  planning time, so a revoked or out-of-scope grant cannot admit a queued descendant.
- Sibling accumulation and budget widening: `aggregate-budget.json` shows two siblings under
  root `iv_aaaaaaaaaaaaaaaaaaaaaaaaaa`; the first is admitted with usage after
  `{1,10,5,15}`, and the second — despite declaring `secondDeclaredBudget`
  `{100,100,100,200}` — is held to the root budget `{3,15,8,23}` via `minBudget`, sees the
  first sibling's usage via `maxUsage`, and is refused with
  `CONVERSATION_SCHEDULER_BUDGET_EXCEEDED` with `aggregateUsageAfter: null`.
- Detector sensitivity: `sensitivity.json` reports control exit 0 and five of five mutants
  detected (self-trigger fence, cycle fence, conversation-key fence, aggregate-budget
  accumulator, aggregate-budget narrowing), each verifier exit 1. Tracing each mutation by
  hand against the fixtures confirms each one changes an asserted code or status rather than
  merely reordering output: neutering the self-trigger fence yields DELEGATION_REQUIRED, the
  cycle fence yields DELEGATION_CONCURRENCY, the key fence admits a decision asserted to be
  `queued`, and both budget mutants admit the second sibling.
- Residual observations, not refutations: the scheduler trusts the caller-supplied causation
  chain (root/ancestors) as durable input, so accumulator scoping is only as sound as that
  chain — consistent with the task contract that chains come from durable causation; and
  fairness is proven for one planning round rather than a multi-round starvation soak.
- Replay: `Replay: N/A (server scheduling and recursion policy) + mitigation: burst schedules,
  durable causation graphs, cycle/fairness matrix, and replay digests`.
- No substantive refutation remains against any acceptance criterion.
