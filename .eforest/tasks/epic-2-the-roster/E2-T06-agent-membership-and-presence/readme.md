---
id: E2-T06
epic: 2
title: "Agent membership and derived availability presence"
priority: 206
status: in-progress
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

- [ ] `make verify-E2-T06` exits 0 from a cold clone and records roster manifests, membership
      matrices,
      readiness inputs, and replayed durable-state digests.
- [ ] Humans and agents use the same join, invite, remove, directory, and channel-membership
      contracts; responses retain an explicit immutable principal kind.
- [ ] An agent is `available` only with active membership, enabled valid config, and healthy
      required providers; each missing prerequisite produces a specific non-runnable reason.
- [ ] Disabling, suspending, removing, or invalidating the provider changes availability at
      the frozen boundary and cannot be overridden by a stale heartbeat.
- [ ] Transient busy/idle presence is bounded and disposable; deleting it does not change
      authorization, configuration, or replayed membership state.
- [ ] Service principals never appear as chat members, and an agent owner cannot join or move
      the agent into a channel without the required channel capability.
- [ ] Replay is declared `Replay: N/A (server roster and presence projection) + mitigation:
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
