---
id: E3-T07
epic: 3
title: "Agent replies bound to run provenance and current membership"
priority: 307
status: pending
depends_on: [E3-T03, E3-T04]
estimate: L
capstone: false
---

## Goal

Let a currently leased run post a bounded reply through the normal message dispatch door as
its agent principal, threaded to the trigger and cryptographically bound by digest references
to the invocation, attempt, snapshot, context pack, and source mention.

## Context

The sandbox never chooses its chat actor or writes a channel stream directly. A run-scoped
capability identifies one agent and permitted source channel/thread. The server derives the
message actor and provenance envelope, revalidates current lease, agent lifecycle, channel
membership, and budget, and idempotently appends. If membership or authority disappears
while the model works, the output remains in the run as a bounded artifact/refusal but cannot
enter a channel under stale permission.

## Deliverables

- Agent-reply request, provenance envelope, validation, and message-dispatch integration.
- Bounded final-output and typed refused-reply artifact behavior.
- Lost-ack, stale-lease, spoof, removal, duplicate, and terminal-race fixtures.
- `make verify-E3-T07` cold-clone target and channel/run cross-reference evidence.

## Acceptance criteria

- [ ] `make verify-E3-T07` exits 0 from a cold clone and records reply receipts, channel/run
      source
      references, refusal heads, message-state digests, and canary scan.
- [ ] The server derives the agent actor, channel, thread root, invocation, attempt, lease
      generation, snapshot digest, context digest, and source mention reference; the caller
      cannot override any provenance field.
- [ ] A valid reply appears through the same message reducer/API as a human message with an
      explicit agent principal kind and traceable run provenance.
- [ ] Retry after lost acknowledgement yields the original reply receipt and one logical
      channel message; duplicate and conflicting payloads follow dispatch idempotency rules.
- [ ] Lease loss, terminal run, agent disable/suspend, membership removal, channel archive,
      capability expiry, and cross-channel target all refuse before channel append.
- [ ] Output size/content limits and redaction run before append; planted credentials in the
      scripted runner never appear in channel events, run dumps, logs, or evidence.
- [ ] Replay is declared `Replay: N/A (server reply dispatch contract) + mitigation:
      provenance manifests, lost-ack replay, stale-authority matrix, canary scan, and digests`.

## Adversarial verification

1. Override actor, owner, channel, thread, run, attempt, snapshot, context, and source mention
   independently. One accepted mismatch refutes server-derived provenance.
2. Remove membership and revoke lease at every boundary before channel append. One late reply
   refutes current-state authorization.
3. Crash after channel append before run acknowledgement, then retry from another worker.
   More than one logical message or missing source ref refutes idempotency.
4. Plant secret canaries and executable markup in output and error paths. Leakage or unsafe
   representation refutes redaction/content handling.
5. Let the scripted sandbox call the channel stream directly in a scratch test; network and
   source guards must refuse it.

## Verification log
