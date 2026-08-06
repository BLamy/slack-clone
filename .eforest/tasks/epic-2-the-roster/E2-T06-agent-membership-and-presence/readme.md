---
id: E2-T06
epic: 2
title: "Agent membership and derived availability presence"
priority: 206
status: verified
depends_on: [E2-T03, E2-T05]
estimate: M
capstone: false
---

## Goal

Make configured agents participate in workspace directories and channel membership through
the same APIs as humans while deriving an explicit availability state from durable lifecycle
and current provider readiness without confusing ephemeral presence for authority.

## Context

Users should add an agent to a channel as they add a teammate. The roster clearly labels its
principal kind and owner/manager metadata, but membership authorization is identical. An
agent may be `disabled`, `unavailable`, `available`, or transiently `busy`; only durable
config and membership events determine permission. Provider heartbeat and active-run state
may affect display presence but cannot grant access or survive as hidden truth.

## Deliverables

- Agent-aware directory/channel membership views and handle uniqueness policy.
- Deterministic availability derivation from principal, config, membership, provider, and
  active-run inputs, plus bounded transient presence events.
- Membership/readiness transition and stale-heartbeat fixtures.
- `make verify-E2-T06` cold-clone target and roster evidence.

## Acceptance criteria

- [x] `make verify-E2-T06` exits 0 from a cold clone and records roster manifests, membership
      matrices,
      readiness inputs, and replayed durable-state digests.
- [x] Humans and agents use the same join, invite, remove, directory, and channel-membership
      contracts; responses retain an explicit immutable principal kind.
- [x] An agent is `available` only with active membership, enabled valid config, and healthy
      required providers; each missing prerequisite produces a specific non-runnable reason.
- [x] Disabling, suspending, removing, or invalidating the provider changes availability at
      the frozen boundary and cannot be overridden by a stale heartbeat.
- [x] Transient busy/idle presence is bounded and disposable; deleting it does not change
      authorization, configuration, or replayed membership state.
- [x] Service principals never appear as chat members, and an agent owner cannot join or move
      the agent into a channel without the required channel capability.
- [x] Replay is declared `Replay: N/A (server roster and presence projection) + mitigation:
      membership/readiness matrix, stale-heartbeat tests, manifests, and durable-state replay`.

## Adversarial verification

1. Forge heartbeats for disabled, removed, sibling-workspace, and unknown agents. Any granted
   availability or membership refutes presence isolation.
2. Race provider-health loss, config disable, membership removal, and presence update. A
   stale available state beyond the policy boundary refutes derivation.
3. Attempt agent membership changes as its owner without channel capability and as a service
   principal. Acceptance refutes shared membership authorization.
4. Delete all transient presence state and restart. Any changed durable permission refutes
   the authority split.
5. Remove principal-kind labeling or a readiness prerequisite in a scratch worktree; the
   verifier must fail.

## Verification log

### Builder — 2026-08-06 — implementation and cold proof

- Exact implementation commit: `be3560cf84fb84e6a8d636f73cab95fb1c78350e`.
- Exact cold command: `PROMOTE_EVIDENCE=1 E2_T06_IMPLEMENTATION_COMMIT=be3560cf84fb84e6a8d636f73cab95fb1c78350e TEST_RUN_ID=e2-t06-cold-final-v2 make verify-E2-T06`. The detached checkout was clean before install, initialized the pinned emulator, and recorded `make verify-E2-T06` as the entrypoint; all required gates exited 0 with `skips: []`.
- Durable replay: 34 records on `workspace:ws_aaaaaaaaaaaaaaaaaaaaaaaaaa/directory`, final state digest `sha256:8a61ade8616a7c8814669220cf22e7606130be08dea91ce4e19e98aaa57f717e`; the roster manifest digest is `sha256:6339894cf3e0c29cffbd3506f5af58df03422adf19f31f114134098ea8dee8a3`.
- Membership/readiness evidence: `membership-matrix.json` proves the shared human/agent workspace and channel event contracts, service exclusion, and owner capability refusal. `readiness-inputs.json` records the exact healthy scripted harness and sandbox descriptors. `transition-matrix.json` covers active, fresh busy, stale, sibling-workspace, suspended, removed, disabled, invalid, unhealthy, expired, and unknown-agent states with specific reasons.
- Presence and sensitivity: bounded 60-second maximum TTL; stale and sibling heartbeats cannot grant availability; deleting transient presence leaves durable state unchanged. Five real-verifier mutants removed principal-kind labeling, provider-stale fencing, protocol handle uniqueness, the service-principal channel-membership fence, and reducer handle uniqueness; all five exited nonzero and were detected. A readiness canary was injected into the derivation input and the six published evidence outputs remained canary-free.
- Gates: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all passed in the cold verifier; the local suite reported 151 passing tests and 5 passing integration tests.
- Evidence: `evidence/e2-t06-final/verification-summary.json`, `roster-manifest.json`, `membership-matrix.json`, `readiness-inputs.json`, `durable-replay.json`, `transition-matrix.json`, `sensitivity.json`, and `cold-clone-transcript.json`.
- Replay: N/A (server roster and presence projection) + mitigation: membership/readiness matrix, stale-heartbeat tests, manifests, and durable-state replay.
- Claim: humans and agents share the durable membership contracts while service principals remain non-chat principals; agent availability is fail-closed on membership, configuration, and exact provider readiness, and ephemeral busy/idle signals affect only bounded display state and cannot override durable authorization or replayed state.

### Critic — 2026-08-06

VERDICT: verified

- A fresh independent tool-enabled critic reviewed the exact implementation, hardened verifier, and promoted evidence. `E2_T06_SKIP_GATES=1 TEST_RUN_ID=e2-t06-critic-followup node scripts/verify-e2-t06.mjs` exited 0 and reproduced 34 records, durable digest `sha256:8a61ade8616a7c8814669220cf22e7606130be08dea91ce4e19e98aaa57f717e`, and roster digest `sha256:6339894cf3e0c29cffbd3506f5af58df03422adf19f31f114134098ea8dee8a3`.
- The critic independently passed fresh-ID attacks for service-principal join, owner channel-capability spoofing, duplicate handles, stale/sibling/unknown heartbeats, disabled configuration, removed membership, and transient-presence deletion. The disposable no-PROMOTE `make verify-E2-T06` run passed with `skips: []`; all five gates exited 0.
- The critic confirmed the five sensitivity mutants all exit 1, the readiness canary remains absent from published evidence/output, the pinned digests match, and the exact Replay literal is present. No finding refuted the implementation or evidence.
- Status: `verified`.
