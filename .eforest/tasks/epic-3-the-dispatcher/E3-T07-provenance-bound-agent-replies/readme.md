---
id: E3-T07
epic: 3
title: "Agent replies bound to run provenance and current membership"
priority: 307
status: verified
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

- [x] `make verify-E3-T07` exits 0 from a cold clone and records reply receipts, channel/run
      source
      references, refusal heads, message-state digests, and canary scan.
- [x] The server derives the agent actor, channel, thread root, invocation, attempt, lease
      generation, snapshot digest, context digest, and source mention reference; the caller
      cannot override any provenance field.
- [x] A valid reply appears through the same message reducer/API as a human message with an
      explicit agent principal kind and traceable run provenance.
- [x] Retry after lost acknowledgement yields the original reply receipt and one logical
      channel message; duplicate and conflicting payloads follow dispatch idempotency rules.
- [x] Lease loss, terminal run, agent disable/suspend, membership removal, channel archive,
      capability expiry, and cross-channel target all refuse before channel append.
- [x] Output size/content limits and redaction run before append; planted credentials in the
      scripted runner never appear in channel events, run dumps, logs, or evidence.
- [x] Replay is declared `Replay: N/A (server reply dispatch contract) + mitigation:
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

### Builder repair — 2026-08-09 — commit `5b67ca17be19d133e2271297c6e1c9f7d27bcf0e`

- A fresh critic returned `needs-evidence`: the generic message protocol unnecessarily admitted caller `mentions`, one source-channel comparison was tautological, omitted authority fields failed open, a dispatch result without an event skipped actor/provenance checks, accepted events were not promoted for digest reproduction, arbitrary error canaries were not exercised, and sensitivity lacked override/reducer/replay mutations.
- The repair removes the unrelated `mentions` widening, binds the source reference stream to the source event's channel, requires explicit active workspace and agent status, requires the normal dispatch door to return the accepted event, and replaces untrusted external error details with fixed refusal text. Unit and functional fixtures cover each boundary, including source-stream mismatch and missing authority fields.
- Cold proof: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e3-t07-repair-final-5b67ca1 E3_T07_IMPLEMENTATION_COMMIT=5b67ca17be19d133e2271297c6e1c9f7d27bcf0e make verify-E3-T07` exited 0 from a clean detached worktree. All five repository gates passed, including 183 unit/ledger tests and five browser integration tests.
- Reproducible evidence: `accepted-events.json` promotes all three accepted scenario envelopes. Their independently addressable event and reducer-state digests are listed in `message-digests.json`; the accepted-event-set digest is `sha256:f5de3eff1a99323e34fb642656ab00e2f2df1770ff653f67e39f4550d8bde1b5`. `refusal-heads.json` contains 17 actual run-bound refusal artifacts and `stale-authority.json` contains 12 refusal cases. The refusal-head digest is `sha256:d12f22a583fe63722e314a547f362db4af4a2ca5e604168f8fec61b38f493c5d`.
- Redaction and sensitivity: a high-entropy append-error canary is absent from the thrown refusal and persisted artifact, and the final canary scan reports zero findings across 12 evidence files. All nine mutants are detected, including caller override allowlisting, reducer agent-kind enforcement, trusted lost-ack replay, and the accepted-event contract.
- Replay: `Replay: N/A (server reply dispatch contract) + mitigation: provenance manifests, lost-ack replay, stale-authority matrix, canary scan, and digests`.
- Claim: the critic's seven findings are repaired and the replacement promoted evidence is tied to the exact repair commit; E3-T07 remains `implemented` pending a new independent critic verdict.

### Builder repair — 2026-08-09 — commit `8bd740a611a6d671265cdfc90556e2c227b1bd2f`

- Critic session `4da35a6c-49dc-4235-8290-d012533a0842` returned `needs-evidence` because its permission layer denied independent `node`, `pnpm`, and mutation commands. Its static audit confirmed the seven earlier repairs but identified a plausible same-message/different-context hole: provenance in the idempotency key could let a changed context obtain a new key while retaining the deterministic reply message ID.
- The repair now derives the idempotency key from the stable logical reply message ID, so a changed context/output for the same invocation attempt reaches the normal append door under the original key and is rejected as an idempotency conflict. The verifier records one accepted reply, advances the run to a different context citation, retries, and requires one logical channel reply plus a run-bound refusal. The harness's extra message-ID guard was removed so this fixture proves the production idempotency boundary rather than a test-only check.
- All validator-derived refusal details are now fixed strings rather than partially redacted source text, closing the critic's residual arbitrary-canary concern across invocation, source, context, output, and envelope validation paths.
- Cold proof: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e3-t07-final-8bd740a E3_T07_IMPLEMENTATION_COMMIT=8bd740a611a6d671265cdfc90556e2c227b1bd2f make verify-E3-T07` exited 0 from a clean detached worktree with all five repository gates passing. Evidence records three accepted scenarios, 18 actual refusal artifacts, 12 stale-authority cases, and zero canary findings.
- Digests: accepted event set `sha256:47628fa727835247780c06d233a281bad9414d826883707941b33754b9ba553f`; refusal heads `sha256:37854b766bb7ef4d15e25a73e67ee81d8ec48064d0561a81897806f8dcff0310`; provenance `sha256:c70331bbcd8f05dfc5bfa0b9615336478945e734396be911a079012b70604a70`.
- Sensitivity: all ten mutants fail, including a new `reply-idempotency-provenance-drift` mutant that restores provenance to the idempotency key. E3-T07 remains `implemented` pending a fresh executable critic verdict.

### Critic — 2026-08-09 — session `019fe931-2062-7e82-bc0c-14d6033d0f46`

VERDICT: verified

- Independently reviewed implementation commit `8bd740a611a6d671265cdfc90556e2c227b1bd2f`, evidence commit `bc21570ab64cda04d4a023656c613be046ffa68c`, the full task, and verified E3-T03/E3-T04 dependency contracts.
- `TEST_RUN_ID=e3-t07-critic-independent-20260809 E3_T07_IMPLEMENTATION_COMMIT=8bd740a611a6d671265cdfc90556e2c227b1bd2f make verify-E3-T07` passed independently, including format, lint, typecheck, 183 unit/ledger tests, five browser integration tests, build, functional attacks, canary scan, stale-authority races, and sensitivity.
- New-input attacks covered caller provenance overrides, omitted authority, source stream/channel mismatch, missing accepted event, external and validator error canaries, lost-ack replay, changed context/output under the same logical reply identity, and membership removal at the normal message door. No attack produced an unauthorized or duplicate channel append.
- Recomputed accepted-set digest `sha256:47628fa727835247780c06d233a281bad9414d826883707941b33754b9ba553f`, all three event-envelope digests, refusal-head digest `sha256:37854b766bb7ef4d15e25a73e67ee81d8ec48064d0561a81897806f8dcff0310`, and provenance digest `sha256:c70331bbcd8f05dfc5bfa0b9615336478945e734396be911a079012b70604a70`; all matched promoted evidence.
- In a disposable worktree, weakened omitted-workspace authority handling made the verifier exit 1 with `reply unexpectedly accepted; expected AGENT_REPLY_AUTHORITY_REVOKED`. The worktree was removed and the main checkout remained clean.
- Residual risk: deterministic in-process adapters do not model concurrent production replicas or a real external Durable Streams service; that broader integration proof belongs to later capstones and does not refute E3-T07.
