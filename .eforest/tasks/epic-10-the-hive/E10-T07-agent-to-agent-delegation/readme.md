---
id: E10-T07
epic: 10
title: Agent-to-agent delegation
priority: 1007
status: pending
depends_on: [E10-T02, E10-T03]
estimate: L
capstone: false
---

## Goal

An agent can delegate a bounded subtask to another authorized agent through a durable run
request that preserves human origin, parentage, budgets, grants, approval requirements,
and terminal result without creating autonomous mention loops.

## Context

Delegation does not inherit all parent authority. The child receives the intersection of
explicit delegation scope, child policy, parent remaining budget, workspace policy, and
any human approval, with a complete causal graph visible to authorized users.

## Deliverables

- Delegation request/result schema and parent/child run graph projection.
- Depth/fan-out/token/time/cost budgets, cycle detection, and cancellation propagation.
- Scoped policy derivation, approval escalation, and result-to-parent handoff.
- Browser run graph plus loop, budget, revocation, Replay, and MP4 tests.

## Acceptance criteria

- [ ] Every child records stable human origin, delegating principal, parent attempt,
      requested scope, effective policy digest, budget, and idempotency key.
- [ ] Cycles, repeated edges, excessive depth/fan-out, exhausted budget, and unauthorized
      targets are refused before creating a child run or issuing credentials.
- [ ] Child authority is the policy intersection and cannot widen through prompt, harness,
      provider, tool arguments, or a later parent-policy mutation.
- [ ] Cancellation/revocation propagates according to the frozen graph policy, and late
      child output cannot revive or complete a terminal parent.
- [ ] The final parent/child/approval/result journey has Replay plus same-session MP4,
      zero console errors, and graph/run/audit offsets and digests equal replay.

## Adversarial verification

1. Construct self, mutual, and longer cycles using duplicate delivery and renamed agents;
   any child beyond limits refutes graph enforcement.
2. Ask a low-privilege parent to delegate to a powerful child and forge tool/service
   scopes; authority outside the intersection refutes least privilege.
3. Cancel/revoke at each graph depth while outputs race; an orphaned side effect, revived
   parent, or ambiguous terminal state refutes propagation.
4. Rebuild the causal graph from raw streams and inspect it in Replay; missing origin,
   digest drift, secret leakage, or console errors refute evidence.

## Verification log
