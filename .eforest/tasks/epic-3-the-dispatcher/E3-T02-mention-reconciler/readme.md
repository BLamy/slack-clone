---
id: E3-T02
epic: 3
title: "Idempotent mention-to-invocation reconciler"
priority: 302
status: verified
depends_on: [E1-T06, E3-T01]
estimate: L
capstone: false
---

## Goal

Tail canonical channel mention facts and reconcile each eligible agent target into one
source-bound invocation and immutable configuration snapshot despite duplicate delivery,
worker races, lost acknowledgements, and process restart.

## Context

Message append and invocation creation occur on different streams and are not falsely treated
as atomic. The accepted message is the source fact. The reconciler derives an invocation ID
from workspace, channel stream, message offset and digest, and agent ID, then uses fenced
dispatch to ensure the corresponding invocation. Its own checkpoint is recoverable; replaying
the source can repeat reconciliation but cannot repeat the logical invocation.

Human mentions remain conversation metadata. An unavailable agent produces a typed durable
non-runnable outcome rather than disappearing or launching with a silent fallback provider.

## Deliverables

- Resumable mention consumer and deterministic invocation-ID derivation.
- E2 snapshot resolution and typed eligible/non-runnable reconciliation outcomes.
- Duplicate, race, restart, delayed-config, membership, and checkpoint-corruption fixtures.
- `make verify-E3-T02` cold-clone target and source-to-invocation evidence.

## Acceptance criteria

- [ ] `make verify-E3-T02` exits 0 from a cold clone and records channel source offsets/digests,
      reconciler checkpoints, invocation receipts, snapshots, and final replay digests.
- [ ] One canonical agent mention produces one effective invocation whose deterministic ID
      binds the exact channel stream, message offset/digest, workspace, and agent.
- [ ] One hundred duplicate deliveries and racing reconcilers return the same logical
      invocation receipt and never create a second run or snapshot.
- [ ] Crash after source read, snapshot resolution, invocation append, or before checkpoint
      acknowledgement resumes without losing or duplicating the logical invocation.
- [ ] Human, service, disabled, suspended, removed, non-member, invalid-config, and
      unavailable-provider targets never launch; each follows the frozen typed outcome without
      leaking hidden configuration.
- [ ] A config or membership change racing snapshot resolution yields one internally
      consistent source-fenced snapshot or a retry/refusal, never a mixed revision.
- [ ] Replay is declared `Replay: N/A (headless stream reconciler) + mitigation: source and
      checkpoint manifests, hundred-way race, crash schedules, and replay digests`.

## Adversarial verification

1. Deliver the same source mention concurrently, in reordered batches, and after checkpoint
   regression. More than one effective invocation refutes idempotency.
2. Forge channel offset, event digest, agent ID, and workspace independently. Acceptance or
   cross-scope invocation creation refutes source binding.
3. Change config, provider readiness, membership, and agent lifecycle at every resolution
   boundary. A mixed or unauthorized snapshot refutes fencing.
4. Corrupt and cross-wire reconciler checkpoints. Silent skip, duplicate logical work, or
   sibling-channel consumption refutes checkpoint integrity.
5. Replace deterministic ID derivation with randomness in a scratch worktree; the duplicate
   race verifier must fail.

## Verification log

- 2026-08-07 builder handoff: commit `53a2a6efe71ba31bf62129523e6542c1d0c35f85`. Cold command
  `PROMOTE_EVIDENCE=1 make verify-E3-T02` passed from a clean detached checkout after
  `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`;
  the test run recorded 165 unit tests and 5 integration tests. Evidence is in
  `evidence/e3-t02-final/` (`source-manifest.json`, `checkpoint-manifest.json`,
  `invocation-receipts.json`, `duplicate-race.json`, `crash-schedules.json`,
  `outcomes.json`, `source-attacks.json`, `replay-digests.json`, `sensitivity.json`,
  `cold-clone-transcript.json`, and `verification-summary.json`). The hundred-way race
  converged to one invocation/checkpoint and one receipt; all five crash/lost-ack schedules
  resumed to one invocation/checkpoint; source/checkpoint scope attacks were refused; and
  the random-ID mutation made the race verifier exit non-zero. Replay: N/A (headless stream
  reconciler) + mitigation: source and checkpoint manifests, hundred-way race, crash
  schedules, and replay digests. Claim: the deterministic reconciler is implemented and
  ready for a fresh critic; it is not yet verified.

### Critic — 2026-08-07 — first independent review

- `VERDICT: needs-evidence` from a fresh read-only critic reviewing the exact implementation and
  handoff commits plus promoted evidence. It reproduced the hundred-way race, five crash/lost-ack
  schedules, source/checkpoint attacks, replay digests, and random-ID sensitivity detector.
- The critic found three gaps: the verifier fabricated an E2-shaped snapshot instead of exercising
  `createInvocationSnapshot`/`replayInvocationSnapshot`; lifecycle refusals were returned by a
  code map rather than real E2 state; and resolver errors were checkpointed as permanent refusals,
  leaving no tested retry for config or membership drift. Status remained `implemented`.

### Builder remediation — 2026-08-07 — E2-bound retry proof

- Exact remediation commit: `89c01e14846cafdd6d3da50616897bd96221d9d6`. The reconciler now replays
  and validates the E2 immutable snapshot, binds its workspace/channel/agent/config/directory
  sources, preserves typed E2 refusals, and leaves the source checkpoint untouched for retryable
  stale config, context, grant, membership, provider, source, and workspace-input errors.
- Exact cold command: `PROMOTE_EVIDENCE=1 E3_T02_IMPLEMENTATION_COMMIT=89c01e14846cafdd6d3da50616897bd96221d9d6 TEST_RUN_ID=e3-t02-remediated-cold-20260807 make verify-E3-T02`. It passed from a clean detached checkout with all five gates, 166 unit tests, 5 integration tests, and `implementationTreeCleanAtStart: true`.
- Promoted evidence is in `evidence/e3-t02-final/`: `snapshot-manifest.json` records the real E2
  snapshot source manifest and digest; `resolution-races.json` proves config and membership drift
  return typed retry with zero invocation/checkpoint before the stable second attempt; `outcomes.json`
  drives service, disabled, suspended, removed, non-member, invalid-config, and unavailable-provider
  cases through real E2 snapshot resolution; and the existing race, crash, source-attack, replay,
  sensitivity, transcript, and canary artifacts were regenerated. The hundred-way race remains one
  invocation/checkpoint/receipt, all five crash schedules converge to one, and the random-ID mutant
  exits 1. Replay: N/A (headless stream reconciler) + mitigation: source and checkpoint manifests,
  E2 snapshot manifest, lifecycle matrix, resolution races, hundred-way race, crash schedules, and
  replay digests. Claim: remediation is implemented and ready for a second fresh critic; status is
  still `implemented`.

### Critic — 2026-08-07 — second independent review

- `VERDICT: refuted` from a second fresh read-only critic. It reproduced the remediated verifier
  and unit suite and confirmed the state-driven refusal and checkpoint-free retry fixes, but removed
  `validateResolvedSnapshot` in a scratch checkout without causing any verifier failure. It also
  found that the thrown `STALE_*` retry branch had no fixture and that the snapshot manifest was
  serialized from verifier input rather than the reconciler's validated boundary. Status remained
  `implemented`.

### Builder remediation — 2026-08-07 — binding attacks and detector sensitivity

- Exact remediation commit: `c47281e01a75d5dd96a1b30eb0ddc0a64004482c`. The snapshot-resolved
  boundary now exposes the validated, replayed snapshot to the evidence harness; binding attacks
  cover foreign workspace, agent, channel, config stream, config source digest, missing directory
  source, and forged snapshot digest; and the verifier's snapshot manifest is built from that
  validated boundary payload.
- `resolution-races.json` now includes a thrown stale-provider error in addition to config and
  membership drift. `sensitivity.json` contains two real mutants: random invocation IDs and removal
  of E2 snapshot binding validation; both make their verifier exit non-zero. The cold wrapper
  promotes `snapshot-attacks.json` alongside the other committed evidence.
- Exact cold command: `PROMOTE_EVIDENCE=1 E3_T02_IMPLEMENTATION_COMMIT=c47281e01a75d5dd96a1b30eb0ddc0a64004482c TEST_RUN_ID=e3-t02-final-cold-20260807 make verify-E3-T02`. It passed from a clean detached checkout with all five gates, 166 unit tests, 5 integration tests, two sensitivity mutants, seven snapshot-binding attacks, one invocation/checkpoint from the hundred-way race, five convergent crash schedules, and a clean post-verifier canary scan. Replay: N/A (headless stream reconciler) + mitigation: source/checkpoint manifests, validated E2 snapshot manifest, snapshot-binding attacks, lifecycle matrix, resolution races, hundred-way race, crash schedules, sensitivity mutants, and replay digests. Claim: this remediation is implemented and ready for a third fresh critic; status remains `implemented`.

### Critic — 2026-08-07 — third independent review

- `VERDICT: verified` from a fresh read-only critic. It independently inspected the complete diff through `c47281e01a75d5dd96a1b30eb0ddc0a64004482c`, the cold transcript, and all promoted evidence, then reproduced all five gates and `node scripts/verify-e3-t02.mjs` from a disposable detached worktree with matching race, crash, lifecycle, retry, binding-attack, replay, and sensitivity results.
- The critic confirmed 100 duplicate deliveries converge to one invocation/checkpoint/receipt; all five crash boundaries converge after a real first failure; eight non-runnable cases produce typed audits and zero invocations; direct config/membership retries and thrown provider retry leave no checkpoint before the stable retry; six recomputed field-binding mutations plus one forged digest are refused; and the snapshot manifest is captured from the reconciler's validated `snapshot-resolved` boundary and tied to the invocation digest.
- It independently confirmed the canary is clean, replay digests are stable, `Replay: N/A (headless stream reconciler) + mitigation: ...` is correctly declared, and both real mutants make the verifier exit non-zero. It also ran additional retry and checkpoint-scope mutations; both were detected. The critic identified no correctness or evidence gap. The evidence publication changes are included with this status transition and regenerated queue. Status is now `verified`.
