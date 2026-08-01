---
id: E0-T04
epic: 0
title: "Fenced dispatch and idempotent application writes"
priority: 4
status: pending
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
