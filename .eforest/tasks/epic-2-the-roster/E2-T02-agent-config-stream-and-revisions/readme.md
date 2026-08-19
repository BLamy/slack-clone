---
id: E2-T02
epic: 2
title: "Agent configuration stream and immutable revisions"
priority: 202
status: verified
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

### Critic — 2026-08-05 — legacy-shaped revision shadowing

- `VERDICT: refuted` from a fresh read-only Claude Code audit of implementation commit
  `fca92859931312b1f01d097e6a474ec359b66903` and evidence commit `dbf1e4d`.
- Blocking finding: `isLegacyAgentConfigRevision` routed any three-field
  `agent.config.revised` payload to `reduceLegacyAgentConfigRevised`, even after a strict v1
  revision chain existed. An independently appended legacy-shaped event therefore replaced the
  whole agent record, erasing immutable revisions, source offsets, lifecycle state, and digests.
  The critic reproduced this against the promoted seven-event fixture.
- Required repair: legacy agent-config replay must be explicitly scoped to the E0-T05 compatibility
  path; default E2 replay must reject the legacy-shaped payload with a typed refusal, and the
  E2 verifier must cover the shadowing mutation. No product files were changed by the critic.

### Builder rework — 2026-08-05 — explicit legacy compatibility boundary and cold rerun

- Exact repair implementation commit: `0c316d94d658cdf03a450b94e98356be7128fed2`.
- Legacy-shaped `agent.config.revised` payloads now require the explicit E0-T05 replay option;
  default E2 replay rejects them before mutation. The repair adds a typed unit regression, a
  static invalid shadowing fixture, and both full-chain and fixture-backed refusal cases.
- Exact cold command:
  `PROMOTE_EVIDENCE=1 E2_T02_IMPLEMENTATION_COMMIT=0c316d94d658cdf03a450b94e98356be7128fed2
  TEST_RUN_ID=e2-t02-legacy-repair-final make verify-E2-T02`. The detached checkout was clean
  before install, hydrated the pinned emulator, and passed `pnpm format:check`, `pnpm lint`,
  `pnpm typecheck`, `pnpm test`, and `pnpm build`; all child commands exited 0 with
  `skips: []`. Evidence is under `evidence/e2-t02-final/`.
- The repaired verifier records seven typed refusal cases, including the reproduced legacy
  revision shadow, while retaining the one-winner race, two canary refusals, deterministic v0
  upgrade, lifecycle checks, and sensitivity mutant. The final state digest remains
  `sha256:a48f87c190bac1ea973d22e67ed240169af9b23d3b9081ffee0e3cd5dc2ca223`.
- Claim: the critic's legacy shadowing refutation is repaired without weakening E0 compatibility;
  all E2-T02 acceptance criteria are satisfied, awaiting a fresh independent critic.

### Builder hardening — 2026-08-05 — compatibility-spoof refusal and final cold proof

- Exact hardening implementation commit: `a64f2866709b2fcd2543e11263f29018b7f92cdc`.
- A strict v1 revision chain now rejects legacy-shaped revisions even when a dump falsely claims
  E0-T05 compatibility. The unit regression and verifier cover both the default and spoofed
  compatibility paths; genuine E0-T05 legacy fixtures remain explicitly supported.
- Exact cold command:
  `PROMOTE_EVIDENCE=1 E2_T02_IMPLEMENTATION_COMMIT=a64f2866709b2fcd2543e11263f29018b7f92cdc
  TEST_RUN_ID=e2-t02-compat-hardening-final make verify-E2-T02`. The detached checkout was clean
  before install, hydrated the pinned emulator, and passed `pnpm format:check`, `pnpm lint`,
  `pnpm typecheck`, `pnpm test`, and `pnpm build`; all child commands exited 0 with
  `skips: []`. Evidence is under `evidence/e2-t02-final/`.
- The final verifier records eight typed refusal cases, one CAS winner, two canary refusals,
  deterministic upgrade/lifecycle/replay checks, sensitivity exit 7, and final digest
  `sha256:a48f87c190bac1ea973d22e67ed240169af9b23d3b9081ffee0e3cd5dc2ca223`.
- Claim: the compatibility-spoof hardening closes the remaining critic observation while
  preserving the E0 replay boundary; awaiting the final fresh independent critic.

### Critic — 2026-08-05 — final independent verification

- `VERDICT: verified` from a fresh read-only Claude Code audit of implementation commit
  `a64f2866709b2fcd2543e11263f29018b7f92cdc` and evidence commit `ababa2f`.
- The critic independently ran `TEST_RUN_ID=critic-cold-audit node scripts/cold-verify-e2-t02.mjs`
  from a detached checkout: clean-before-install, frozen install, pinned emulator setup, all
  five gates exit 0, `skips: []`, and final digest
  `sha256:a48f87c190bac1ea973d22e67ed240169af9b23d3b9081ffee0e3cd5dc2ca223`.
- It reproduced the original legacy-shadowing attack at multiple insertion points, under default
  replay and spoofed E0-T05 compatibility, plus direct `replayRecords` compatibility bypass; all
  refused with `REDUCER_AGENT_CONFIG_INVALID_EVENT`. It independently exercised a revise-vs-revise
  race, broader canary locations, lifecycle refusals, suffix replay, forged scope/predecessors,
  duplicate offsets, and sensitivity mutants. No blocking findings; the task is verified.
- Non-blocking observations retained for follow-up: non-promoted cold runs currently rewrite the
  transcript path under `evidence/e2-t02-final`; the repo-wide E0-T05 purity gate has a pre-existing
  dependency failure; and the shipped race/canary verifier is narrower than the critic's expanded
  attacks. These do not refute E2-T02 or its promoted proof.
