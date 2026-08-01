---
id: E3-T02
epic: 3
title: "Idempotent mention-to-invocation reconciler"
priority: 302
status: pending
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
