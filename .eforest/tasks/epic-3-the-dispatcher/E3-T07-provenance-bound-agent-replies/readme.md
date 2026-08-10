---
id: E3-T07
epic: 3
title: "Agent replies bound to run provenance and current membership"
priority: 307
status: implemented
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

### Builder — 2026-08-09 — commit `4e35af2aefee13f2ba56ef44aab8eebe36d642e5`

- Cold proof: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e3-t07-final-4e35af2 E3_T07_IMPLEMENTATION_COMMIT=4e35af2aefee13f2ba56ef44aab8eebe36d642e5 make verify-E3-T07` exited 0 from a clean detached worktree at the exact implementation commit. The wrapper used the pinned local `emulate` gitlink as its clone source, a frozen install, emulator setup, and the stable `localhost` binding after the host's exhausted IPv4 loopback socket pool made `127.0.0.1` return `EADDRNOTAVAIL`. The redacted transcript is `evidence/e3-t07-final/cold-clone-transcript.json`.
- Gates: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all passed in the detached checkout. The test gate included 183 unit/ledger tests and five two-session browser integration tests.
- Provenance and message path: `provenance.json` records the server-derived agent, actor, invocation, attempt, lease generation, snapshot, context, channel, thread root, and source mention references, plus 13 independently rejected caller override fields. Valid replies traverse the fenced mention-aware conversation dispatcher and reducer. `reply-receipts.json` records three accepted outputs and lost-ack replay with one logical channel message.
- Refusals and redaction: `stale-authority.json` records nine zero-append cases, including membership removal both before dispatch and at the final message door, channel archive, agent/workspace disable, capability expiry, terminal run, lease revocation, and a mismatched source mention. `refusal-heads.json` contains 12 actual artifacts; `redaction.json` proves markup escaping, secret removal, raw-byte budget enforcement before append, and byte/digest-only refusal storage. `canary-scan.json` reports no findings across all promoted evidence, including the transcript.
- Replay and sensitivity: `replay-digests.json` records channel digest `sha256:cdc497c94e2100ab19896218372c868c0fb19d42d4595607f59dbb8ed030b56b`, refusal-head digest `sha256:82afee2f881a26547a0ce7cbc373e24941c7faecc86a4fade0195fc48688f9ad`, and provenance digest `sha256:c70331bbcd8f05dfc5bfa0b9615336478945e734396be911a079012b70604a70`. `sensitivity.json` shows all five independent fence/budget mutants made the verifier exit 1.
- Replay: `Replay: N/A (server reply dispatch contract) + mitigation: provenance manifests, lost-ack replay, stale-authority matrix, canary scan, and digests`.
- Claim: provenance-bound agent replies, normal-door authorization, idempotent lost-ack recovery, stale-authority refusal, raw output limits, and redacted run-bound refusal artifacts are implemented and supported by the exact diff plus promoted cold evidence; ready for a fresh critic.
