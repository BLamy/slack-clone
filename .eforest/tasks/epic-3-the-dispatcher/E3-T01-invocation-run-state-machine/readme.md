---
id: E3-T01
epic: 3
title: "Invocation and run state machine on durable streams"
priority: 301
status: implemented
depends_on: [E2]
estimate: L
capstone: false
---

## Goal

Freeze the durable lifecycle and stream topology for turning one trigger into an invocation,
one or more fenced attempts, and exactly one terminal run outcome with replayable status,
usage, approval, artifact, and failure references.

## Context

Chat identity and runnable configuration now exist, but no process may start from an
unrecorded callback. The workspace invocation stream records discoverable work; each run
stream records its immutable snapshot, queue/lease transitions, attempts, bounded activity,
and terminal outcome. Cross-stream references cite source stream, offset, and digest. The
reducer, not a job-table row or worker memory, defines lifecycle truth.

The frozen states cover requested, queued, leased, running, awaiting approval, completed,
failed, timed out, and cancelled. Attempts are subordinate to one invocation; terminal
states are immutable.

## Deliverables

- Versioned invocation/run/attempt event schemas, canonical encoders, and pure reducers.
- Stream topology and source-reference contract linking trigger, config snapshot, invocation,
  attempts, approvals, artifacts, usage, and terminal result.
- Valid and invalid transition fixtures with pinned per-prefix digests.
- `make verify-E3-T01` cold-clone target and lifecycle evidence.

## Acceptance criteria

- [ ] `make verify-E3-T01` exits 0 from a cold clone and replays every valid lifecycle twice
      to identical
      per-prefix state/run digests while rejecting invalid logs at exact offsets.
- [ ] Every invocation binds one workspace, agent, source trigger, immutable E2 snapshot,
      policy, and deterministic correlation identity; every attempt binds one invocation.
- [ ] Requested, queued, leased, running, awaiting-approval, retry, and terminal transitions
      follow one explicit state machine; terminal outcomes cannot reopen or coexist.
- [ ] Duplicate, skipped, regressing, wrong-run, wrong-attempt, finish-without-start, and
      post-terminal events are refused before append with stable typed errors.
- [ ] Usage, activity, approval, artifact, and result records are bounded metadata or content
      references and contain no raw secret, provider token, or unrestricted process output.
- [ ] Replaying invocation and run streams with network and query stores unavailable derives
      the same lifecycle, attempts, usage totals, and terminal result.
- [ ] Replay is declared `Replay: N/A (server run protocol) + mitigation: lifecycle corpus,
      source-reference audit, secret canary scan, and per-prefix replay digests`.

## Adversarial verification

1. Generate valid lifecycles, then mutate state, sequence, run/attempt ID, source reference,
   usage, and terminal event one field at a time. Silent acceptance refutes validation.
2. Race complete, fail, timeout, and cancel at one expected head. More than one terminal
   winner or a mutable terminal outcome refutes fencing.
3. Reuse a valid snapshot and source trigger across another agent, workspace, or invocation.
   Acceptance refutes provenance binding.
4. Plant credential canaries in activity, errors, artifacts, and usage-provider doubles. Any
   appearance in streams, dumps, or evidence refutes the redaction boundary.
5. Disable one transition check in a scratch worktree; the fixture verifier must go red.

## Verification log

### Builder — 2026-08-07 — implementation and cold proof

- Exact implementation commit: `dbe0e925514816019237eb2036804cecd1cb0d7b`.
- Exact cold command: `PROMOTE_EVIDENCE=1 E3_T01_IMPLEMENTATION_COMMIT=dbe0e925514816019237eb2036804cecd1cb0d7b TEST_RUN_ID=e3-t01-cold-final-2 make verify-E3-T01`. The detached checkout was clean before install, initialized the pinned emulator, and all five gates passed: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (161 unit tests and 5 Playwright tests), and `pnpm build`.
- Replay and binding evidence: two offline replays produced identical 14-prefix digests and final state digest `sha256:4088e18c0f69fa8565f81b57efbbe3f270034db0cd95caf2352cea4a52cbe4eb`; query-store and network use were false. The invocation binds workspace, agent, source trigger, immutable E2 snapshot digest `sha256:3333333333333333333333333333333333333333333333333333333333333333`, policy, and deterministic correlation identity; attempts remain bound to the invocation.
- Adversarial evidence: state, sequence, run/attempt IDs, source references, usage, and terminal mutations were refused at exact offsets with stable typed codes; completed/failed/timed-out/cancelled races produced one terminal winner each. Bounded-record checks found zero raw provider-output or secret fields across 14 records, and the published evidence canary scan was clean.
- Sensitivity evidence: a detached mutation disabling secret-canary rejection caused `node --test test/unit/invocation-run.test.mjs` to exit 1, proving the verifier goes red when the protection is removed.
- Evidence: `evidence/e3-t01-final/verification-summary.json`, `prefix-replay.json`, `invalid-offsets.json`, `binding-audit.json`, `bounded-records.json`, `terminal-races.json`, `sensitivity.json`, `canary-scan.json`, and `cold-clone-transcript.json`.
- Replay: N/A (server run protocol) + mitigation: lifecycle corpus, source-reference audit, secret canary scan, and per-prefix replay digests.
- Claim: the builder considers E3-T01 implemented and the cold evidence complete; a fresh critic must independently attempt to refute the exact diff and evidence before this task can become `verified`.
