---
id: E2-T02
epic: 2
title: "Agent configuration stream and immutable revisions"
priority: 202
status: implemented
depends_on: [E2-T01]
estimate: M
capstone: false
---

## Goal

Persist agent configuration changes as immutable, optimistic-concurrency revisions whose
active version and complete history are reconstructed from the agent's configuration stream.

## Context

Runs must cite exactly what was configured when they began. Updating an agent in place would
make old work unauditable and let a race silently swap harness, sandbox, grants, or budget.
Each revision has a canonical digest and expected predecessor; activation and retirement are
explicit events. Secret resolution never occurs in this stream.

## Deliverables

- Agent-config event schemas and pure reducer for create, revise, activate, disable, and
  retire transitions.
- Immutable revision IDs/digests and optimistic expected-revision enforcement.
- Concurrent-update, upgrade, disable, and replay fixtures.
- `make verify-E2-T02` cold-clone target and revision-chain evidence.

## Acceptance criteria

- [ ] `make verify-E2-T02` exits 0 from a cold clone and replays all valid revision chains
      twice to the
      same active revision, history manifest, and final digest.
- [ ] Every accepted revision stores an immutable canonical config digest, predecessor, actor,
      and source offset; historical bytes cannot be overwritten or reinterpreted in place.
- [ ] Two revisions racing the same expected predecessor yield exactly one winner and one
      stable stale-revision refusal with unchanged losing payload.
- [ ] Activate, disable, and retire transitions follow the frozen state machine; disabled or
      retired configurations are never reported runnable.
- [ ] Replaying from offset `-1` derives the active version and full revision history without
      a mutable configuration row or process cache.
- [ ] Config streams, dumps, receipts, and logs contain only connection/grant references and
      no resolved secret, verified by a canary scan.
- [ ] Replay is declared `Replay: N/A (server config revision protocol) + mitigation:
      concurrent revision races, immutable manifests, canary scan, and replay digests`.

## Adversarial verification

1. Race revisions that change harness, sandbox, grants, and budgets from one predecessor.
   Two winners or a hybrid revision refutes optimistic concurrency.
2. Forge predecessor IDs, config digests, authors, agent IDs, and workspace IDs. Acceptance
   or mutation of another stream refutes revision binding.
3. Activate retired, unknown, invalid-version, and sibling-agent revisions. Any runnable
   state refutes the lifecycle reducer.
4. Delete the active projection and rebuild from stream events. Different active bytes or
   history order refutes stream authority.
5. Permit in-place update in a scratch worktree; the immutable-manifest test must fail.

## Verification log

### Builder — 2026-08-05 — implementation and cold proof

- Exact implementation commit: `fca92859931312b1f01d097e6a474ec359b66903`.
- Exact cold command:
  `PROMOTE_EVIDENCE=1 E2_T02_IMPLEMENTATION_COMMIT=fca92859931312b1f01d097e6a474ec359b66903
  TEST_RUN_ID=e2-t02-cold-final make verify-E2-T02`. The detached checkout was clean before
  install, hydrated the pinned emulator, and passed `pnpm format:check`, `pnpm lint`,
  `pnpm typecheck`, `pnpm test`, and `pnpm build`; all child commands exited 0 with
  `skips: []`. The cold transcript is under `evidence/e2-t02-final/`.
- The valid seven-event chain replays twice to final state digest
  `sha256:a48f87c190bac1ea973d22e67ed240169af9b23d3b9081ffee0e3cd5dc2ca223`, with two
  immutable revision manifests, seven source-offset-bound transitions, and retired/runnable
  state `false`.
- The verifier records five typed refusal cases, one-winner/one-stale-refusal concurrent create
  race with no losing payload persisted, two rejected secret canaries, deterministic v0 upgrade,
  disabled and retired non-runnable lifecycle checks, and a sensitivity mutant that exits 7.
- Replay: N/A (server config revision protocol) + mitigation: concurrent revision races,
  immutable manifests, canary scan, and replay digests.
- Claim: the E2-T02 config event schemas, stream append boundary, immutable revision reducer,
  optimistic concurrency, lifecycle transitions, upgrade path, fixtures, and cold verifier
  satisfy the acceptance criteria; awaiting a fresh independent critic.
