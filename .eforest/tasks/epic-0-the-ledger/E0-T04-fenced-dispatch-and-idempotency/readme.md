---
id: E0-T04
epic: 0
title: "Fenced dispatch and idempotent application writes"
priority: 4
status: verified
depends_on: [E0-T03]
estimate: L
capstone: false
---

## Goal

Create the single application dispatch door that validates an event, authorizes its actor,
checks its idempotency identity and expected stream head, and then appends with producer
fencing. Every later human, agent, worker, and projection write must pass through it.

## Context

Retries and concurrent workers are normal in an agent system. An HTTP success lost before
acknowledgement cannot become a duplicate message, tool call, or agent run, and a stale
worker cannot append after another writer has advanced or revoked its fence. Idempotency is
scoped to the authenticated workspace, actor, operation, and canonical request digest so a
key cannot be replayed for different content.

## Deliverables

- Dispatch request/receipt schemas, typed refusal taxonomy, and canonical request digest.
- Idempotency lookup and producer-sequence fencing integrated with the official adapter.
- Concurrency and lost-ack harnesses over real HTTP and the emulator.
- Frozen race fixtures and `make verify-E0-T04` cold-clone target.

## Acceptance criteria

- [ ] `make verify-E0-T04` exits 0 from a cold clone and records accepted receipts, refusals,
      final stream
      dump, and request digest evidence.
- [ ] One hundred concurrent requests with the same idempotency scope and payload produce
      one logical event and return receipts referencing the same stream offset and digest.
- [ ] Reusing a key with different payload, actor, workspace, or operation is refused and
      leaves every candidate stream head unchanged.
- [ ] Two writers racing the same expected head yield exactly one accepted append; the
      loser receives a stable stale-fence refusal and cannot mutate with that fence later.
- [ ] A crash after accepted append but before local acknowledgement resumes from the
      durable receipt and does not repeat the logical mutation.
- [ ] Validation and authorization failures happen before any append or idempotency success
      record, demonstrated by byte-identical before/after dumps.
- [ ] Replay is declared `Replay: N/A (server dispatch concurrency contract) + mitigation:
      real-HTTP race logs, lost-ack recovery, head dumps, and cold-clone verifier`.

## Adversarial verification

1. Race unique, duplicate, conflicting, and cross-tenant keys with randomized delays around
   head read, append, and receipt persistence. More than one logical winner refutes safety.
2. Replay a captured request after head advancement, actor revocation, and workspace
   deletion. Any new mutation refutes fence and authorization revalidation.
3. Kill the dispatcher at every await point and restart with an empty process cache. Lost
   or duplicated logical effects refute durable recovery.
4. Alter canonicalization order and one payload byte. A matching request digest refutes the
   idempotency identity.
5. Disable the expected-head check in a scratch worktree; the race verifier must go red.

## Verification log

### Builder — 2026-08-02 — activated after E0-T03 verification

- E0-T03 is verified at the exact published queue head, so E0-T04 is now the sole
  eligible gate. This ticket owns the dispatch door, idempotency identity, producer
  fencing, lost-ack recovery, and real-HTTP race harness; E0-T05 remains blocked.

### Builder — 2026-08-02 — fenced dispatch implementation

- Exact implementation commit: `0923df1ea4e7829a44582b6a6aabd36a20ee1606`.
- The new `src/ledger/dispatch.mjs` validates strict request and receipt schemas,
  computes the canonical request digest, re-authorizes every attempt, persists accepted
  receipts to the durable idempotency stream, and recovers target events when the local
  acknowledgement is lost. Chat message and edit writes are composed through this door.
- The official adapter now exposes coordinated appends. It sends the exact expected head
  through `Stream-Seq` and producer `(id, epoch, seq)` headers, maps provider conflicts to
  typed adapter errors, and treats a producer duplicate `204` as a durable-head recovery.
- `make verify-E0-T04` passed from the clean exact-head tree with zero skipped gates:
  `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (53 unit tests and 5
  browser tests), `pnpm test:conformance:e0-t04`, and `pnpm build`.
- Real HTTP/emulator evidence is committed in `evidence/cold-verification.json`,
  `evidence/dispatch-conformance.json`, `evidence/final-stream-dump.json`, and
  `evidence/request-transcript.json`. One hundred concurrent requests produced one
  logical event with shared receipt offset
  `0000000000000000_0000000000000392` and event digest
  `sha256:da1ad185afc631a2f3b6b0df52b3b31a96fd4f5752b7501fdcb9e673d346101f`; the race
  harness observed one accepted append and one stable stale-fence refusal; lost-ack
  recovery observed one durable target event; validation, revocation, deletion, and key
  conflicts left candidate heads unchanged. Provider transcript records expected-head and
  producer headers on every coordinated POST.
- Replay: N/A (server dispatch concurrency contract) + mitigation: real-HTTP race logs,
  provider header transcript, lost-ack recovery, byte-level head/digest dumps, and the
  cold-clone verifier. No Replay upload, tunnel, or existing recording mutation occurred.
- Claim: at the exact implementation commit, no application message or edit append can
  bypass dispatch; canonical scope/payload reuse is idempotent, conflicting reuse and
  stale expected heads fail closed, provider fencing prevents the losing writer from
  mutating later, and a lost local acknowledgement can be reconstructed from durable
  stream facts. A fresh critic must now test that claim against the exact diff and evidence.

### Critic — 2026-08-02 — independent refutation

- Verdict: `VERDICT: refuted`.
- The fresh critic passed independent duplicate, conflict, race, replay, revocation,
  deletion, canonicalization, lost-ack, and expected-head sensitivity attacks, but found
  three underlying gaps: service retries regenerated message IDs and timestamps before
  dispatch, `resetRoom()` removed and recreated streams outside the dispatch door, and an
  indexed receipt could be returned without a matching target event.
- Scratch attack output is retained under `work/critic-2026-08-02/`; it is not evidence or
  a product artifact. No product code or committed task metadata was changed by the critic.

### Builder — 2026-08-02 — repair in progress

- Reuse explicit-key message and edit payloads from the durable target event, with a
  bounded in-process seed for concurrent first attempts, so a retry after lost response or
  process restart preserves the original ID and timestamp while changed text still reaches
  dispatch as an idempotency conflict.
- Replace destructive room stream removal with an idempotent `chat.room.reset` dispatch
  event; the pure message reducer treats that durable control event as a logical reset and
  live HTTP delivery emits a reset notification without bypassing the application door.
- Require every indexed receipt to resolve to a target event whose dispatch metadata and
  canonical event digest match; otherwise fail closed with `DISPATCH_DURABILITY_GAP`.
- Added focused tests for explicit-key retry reuse, reset idempotency, and orphan-receipt
  refusal. A fresh critic must re-run the exact cold evidence after this repair.

### Builder — 2026-08-02 — repaired cold verification

- Exact repaired implementation commit: `57a19eba516fb4f4f0883833ecced3da3122bfcb`.
- `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e0-t04-repair TEST_ARTIFACT_DIR=.artifacts/e0-t04/e0-t04-repair make verify-E0-T04` passed every gate from a clean exact-head tree: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (55 unit/ledger tests and 5 browser tests), `pnpm test:conformance:e0-t04`, and `pnpm build`.
- The repaired run produced one logical event for 100 concurrent requests with receipt
  offset `0000000000000000_0000000000000393` and event digest
  `sha256:89f3b31bc09cef7d50edd4c9cd963bbadc258e0716eb89e983a3da80e5cbe0e7`; the
  expected-head race remained one accepted/one stale, lost-ack recovery remained one
  target event, and authorization/key conflict candidate streams stayed unchanged.
- Promoted evidence: `evidence/cold-verification.json`,
  `evidence/dispatch-conformance.json`, `evidence/final-stream-dump.json`, and
  `evidence/request-transcript.json`. Replay: N/A (server dispatch concurrency contract)
  + mitigation: real HTTP retry/reset tests, race logs, provider headers, lost-ack
  recovery, head/digest dumps, and the cold-clone verifier. No Replay upload or tunnel
  was attempted.
- Claim: explicit-key message and edit retries recover the original durable payload,
  reset is an idempotent dispatch event rather than a stream bypass, and an orphan or
  mismatched receipt fails closed; the original dispatch fence/idempotency invariants
  remain intact. A fresh critic must now verify this repaired claim.

### Critic — 2026-08-02 — second independent refutation

- Verdict: `VERDICT: refuted`.
- The fresh critic passed the exact cold verifier, reset ordering, receipt-digest
  fail-closed, and expected-head sensitivity checks, but its independent process-restart
  attack found that create and edit retries still conflicted after the stream head
  advanced. The cause was `expectedHead` being included in the logical request digest.
- Scratch attack output is retained under `work/critic-2026-08-02-59d4cad/`; it is not
  committed evidence or a product artifact. The critic did not modify product code or
  committed evidence.

### Builder — 2026-08-02 — logical retry identity repair in progress

- Keep `expectedHead` as a validated provider fence and event provenance field, but remove
  it from `dispatchRequestDigest`; logical idempotency now covers actor, workspace,
  operation, key, stream, and canonical payload only. A retry may therefore reread a
  newer head and still recover the same durable receipt, while changed payloads remain
  conflicts.
- Added a process-restart unit test covering both create and edit after target append and
  lost acknowledgement, plus an assertion that changing only the expected head does not
  change the logical digest. The final cold verifier and a fresh critic must now rerun.

### Builder — 2026-08-02 — final logical retry verification

- Exact final implementation commit: `c94ca7e834c9218a7016c61112d6d45615dd95fc`.
- `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e0-t04-final-final TEST_ARTIFACT_DIR=.artifacts/e0-t04/e0-t04-final-final make verify-E0-T04` passed every gate from a clean exact-head tree: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (56 unit/ledger tests and 5 browser tests), `pnpm test:conformance:e0-t04`, and `pnpm build`.
- The final run produced one logical event for 100 concurrent requests with receipt
  offset `0000000000000000_0000000000000398` and event digest
  `sha256:bbd8084305e44325a5e9b62102312f87c6eabd4e2d47a4410265e4014eb1fd1d`; the
  expected-head race remained one accepted/one stale, lost-ack recovery remained one
  target event, process-restart create/edit recovery preserved IDs and timestamps, and
  authorization/key conflict candidate streams stayed unchanged.
- Promoted evidence: `evidence/cold-verification.json`,
  `evidence/dispatch-conformance.json`, `evidence/final-stream-dump.json`, and
  `evidence/request-transcript.json`. Replay: N/A (server dispatch concurrency contract)
  + mitigation: real HTTP race/retry/reset logs, provider headers, lost-ack recovery,
  head/digest dumps, process-restart tests, and the cold-clone verifier. No Replay upload
  or tunnel was attempted.
- Claim: logical idempotency is stable across expected-head changes and process restart;
  fences still reject concurrent stale writers, reset remains a durable idempotent event,
  and orphan or mismatched receipts fail closed. A fresh critic must now verify this
  final claim.

### Critic — 2026-08-02 — third independent refutation

- Verdict: `VERDICT: refuted`.
- The critic passed the final cold verifier, process-restart create/edit recovery, reset
  ordering, receipt integrity, authorization, and changed-payload attacks. It found two
  remaining gaps: disabling the application expected-head check stayed green because the
  conformance race was still protected by provider `Stream-Seq`, and 100 same-key
  requests split across independent dispatch doors returned stale refusals instead of all
  converging on one receipt.
- Scratch attack output is retained under `work/critic-final/`; it is not committed
  evidence or a product artifact. The critic did not modify product code or metadata.

### Builder — 2026-08-02 — cross-door convergence and verifier sensitivity repair

- On a stale-fence append, re-read the target for the same idempotency key and reconcile
  its durable event/receipt; receipt-stream append conflicts similarly re-read the index.
  Independent doors now converge same-key retries to one receipt while different-key
  races remain stale refusals.
- Added a permissive-provider unit fixture with an already-advanced head so the
  application expected-head refusal itself is mutation-sensitive, and alternated the
  100-request real HTTP conformance race across both dispatch doors.
- Added focused tests for cross-door same-key receipts and provider-independent
  expected-head sensitivity. A final cold run and a fresh critic must now rerun.

### Builder — 2026-08-02 — final converged verification handoff

- Exact final implementation commit: `7125a8ae598f9cb065cebc63450d694e37248c2f`.
- `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e0-t04-final-converged TEST_ARTIFACT_DIR=.artifacts/e0-t04/e0-t04-final-converged make verify-E0-T04` passed every gate from the clean exact-head tree: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (58 unit/ledger tests and 5 browser tests), `pnpm test:conformance:e0-t04`, and `pnpm build`.
- The final conformance run alternated 100 same-key requests across independent dispatch doors and produced one logical event. All receipts reference offset `0000000000000000_0000000000000402` and event digest `sha256:12eb08132e6aa3cc6993163cd2a01d5cb4d32f37e1e842d9a48763d0a4c92171`; the expected-head race remained one accepted append and one stale-fence refusal, lost-ack recovery remained one durable target event, and authorization/key conflicts left candidate streams unchanged.
- The application expected-head check now has provider-independent mutation sensitivity through the permissive-provider fixture; cross-door stale-fence and receipt-index conflicts reconcile only matching durable events and fail closed on orphan or mismatched receipts.
- Promoted evidence: `evidence/cold-verification.json`, `evidence/dispatch-conformance.json`, `evidence/final-stream-dump.json`, and `evidence/request-transcript.json`. Replay: N/A (server dispatch concurrency contract) + mitigation: alternating real-HTTP race logs, provider-independent sensitivity fixture, lost-ack/process-restart recovery, reset ordering, head/digest dumps, and the cold-clone verifier. No Replay upload or tunnel was attempted.
- Claim: independent dispatch doors converge same-key retries to one durable receipt without weakening cross-key fencing; logical idempotency remains stable across expected-head changes and process restart; reset remains a durable idempotent event; and validation, authorization, orphan-receipt, and mismatched-receipt paths fail closed before candidate mutation. A fresh critic must now verify this exact implementation and evidence handoff.

### Critic — 2026-08-02 — fourth independent refutation

- Verdict: `VERDICT: refuted`.
- The fresh critic reproduced seven attack passes and three failures. Same-batch reset delivery emitted `reset, message, message` instead of preserving the durable `message, reset, message` order; a tail receipt with its durable `nextOffset` changed to `offset-999` was accepted; and a provider producer duplicate for a different idempotency key was treated as an accepted append.
- The critic's independent 100-request cross-door convergence, cross-scope conflict, same-head race, advanced-head create/edit recovery, reset idempotency, authorization/validation ordering, orphan-receipt refusal, and expected-head sensitivity checks passed. Baseline dispatch tests remained green, and removing the application expected-head check made the sensitivity test fail.
- Scratch attack output is retained under `work/critic-fourth/`; it is not evidence or a product artifact. No product code, task metadata, evidence, or commits were changed by the critic.

### Builder — 2026-08-02 — repairing fourth-critic findings

- Preserve the raw order of live batches while emitting reset notifications at the reset record's position; do not group messages around a reset.
- Treat a provider-reported producer duplicate as a recovery signal only when the target contains the exact requested idempotency event; otherwise fail closed without writing an idempotency receipt. Validate tail receipt checkpoints against the current target head so a forged offset cannot be accepted when the event is still at the tail.
- Focused regression tests and a fresh cold verifier will rerun before another independent critic.

### Builder — 2026-08-02 — fourth-critic repair verification handoff

- Exact repaired implementation commit: `b011b67326f052951965e0afa66e657e1a6ddab7`.
- `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e0-t04-repair-fourth TEST_ARTIFACT_DIR=.artifacts/e0-t04/e0-t04-repair-fourth make verify-E0-T04` passed every gate from the clean exact-head tree: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (61 unit/ledger tests and 5 browser tests), `pnpm test:conformance:e0-t04`, and `pnpm build`.
- The final conformance run still alternated 100 same-key requests across independent dispatch doors and produced one logical event. All receipts reference offset `0000000000000000_0000000000000400` and event digest `sha256:91f057a0b8a04b5142411b711fc7075e4484a9eef13b1e50b52e67273797dcd6`; the expected-head race remained one accepted append and one stale-fence refusal, lost-ack recovery remained one durable target event, and authorization/key conflicts left candidate streams unchanged.
- Regression coverage now proves reset notifications retain their durable position inside a mixed batch, a provider duplicate without the requested target event fails with `DISPATCH_DURABILITY_GAP` before receipt persistence, and a forged tail receipt checkpoint fails closed. Replay: N/A (server dispatch concurrency contract) + mitigation: real-HTTP/browser stream proof, alternating cross-door race logs, reset-order unit coverage, producer-duplicate and receipt-integrity attacks, lost-ack/process-restart recovery, head/digest dumps, and the cold-clone verifier. No Replay upload or tunnel was attempted.
- Promoted evidence: `evidence/cold-verification.json`, `evidence/dispatch-conformance.json`, `evidence/final-stream-dump.json`, and `evidence/request-transcript.json`.
- Claim: reset delivery preserves authoritative event order; provider duplicate responses cannot create a receipt for an unobserved event; and a tail receipt cannot be forged by changing its checkpoint. Prior cross-door, logical retry, fence, authorization, and durable-receipt invariants remain green. A fresh critic must now verify this repaired exact diff and evidence.

### Critic — 2026-08-02 — replacement critic needs evidence

- Verdict: `VERDICT: needs-evidence`.
- The replacement critic confirmed the promoted cold evidence is tied to the exact repaired implementation, but its independent rerun stopped before the attack and sensitivity audit because it selected a task-local build artifact path rejected by `scripts/build.mjs`; no product, task metadata, evidence, or commits were changed.
- The queue remains at E0-T04 awaiting an independent critic. The same fresh critic will resume with a repository-valid `.artifacts/` path and must complete the essential attack set before any verification status changes.

### Critic — 2026-08-02 — final independent verification

- Verdict: `VERDICT: verified`.
- The fresh critic ran `pnpm test:unit` with 61 passing tests and a bounded independent harness. It reproduced 100 cross-door same-key convergence, the different-key stale-fence race, conflict and candidate-head invariants, forged tail receipt refusal, producer-duplicate mismatch refusal, orphan receipt refusal, authorization/validation ordering, process-restart create/edit recovery, reset idempotency, and the application expected-head sensitivity mutation; all passed.
- Direct HTTP/SSE inspection observed `message, reset, message` for a mixed batch. The exact product repair remains `b011b67326f052951965e0afa66e657e1a6ddab7`; the checkout at critic time was `83b7c16`, metadata-only after the promoted evidence handoff, with no product diff.
- Replay: N/A (server dispatch concurrency contract) + mitigation: promoted cold verifier, bounded independent dispatch races, receipt/provider attacks, direct HTTP/SSE ordering, reset/restart coverage, and mutation sensitivity. No product, task metadata, evidence, or commits were changed by the critic.
