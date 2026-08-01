---
id: E7-T02
epic: 7
title: "Backpressure, quotas, and costs: fair admission across queue, sandbox, model, and tool budgets"
priority: 702
status: pending
depends_on: [E7-T01]
estimate: L
capstone: false
---

## Goal

The scheduler applies deterministic tenant-fair admission, concurrency and rate limits,
bounded queueing, and hard sandbox/model/tool/spend budgets before work starts and as
usage arrives. Overload degrades with typed queued/refused/cancelled outcomes rather than
unbounded memory, provider allocation, or silent starvation.

## Context

E4 accounts for sandbox resources, but production budgets span the whole agent run.
Provider-reported usage may be late or duplicated, so reservations and settlement are
stream events with idempotent source identities and explicit pricing versions.

## Deliverables

- Admission/reservation/settlement events and hierarchical budget reducer.
- Fair queue policy, bounded buffers, provider circuit breakers, and cost aggregation.
- `make verify-E7-T02` with flood, fairness, duplicate-meter, and price-change fixtures.

## Acceptance criteria

- [ ] `make verify-E7-T02` passes cold and replays shuffled duplicate usage/reservation
      events twice to identical queue decisions, balances, costs, and digest.
- [ ] Atomic tenant/workspace/agent limits cover queued/active runs, sandbox resources,
      model tokens/cost, tool calls, bytes, duration, and total spend; losing admissions
      perform no provider side effect.
- [ ] A stated fair policy bounds starvation under one noisy tenant, and queue depth/age
      limits produce typed refusal or expiry with no dropped invocation.
- [ ] Reservations settle once against provider observations and versioned prices; late,
      duplicate, partial, and correction reports cannot double charge or restore budget.
- [ ] Crossing a hard in-flight budget cancels/fences the run before its next external
      effect and records the exact budget and measured value.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (server admission and cost
      control) + mitigation: cold-clone flood/fairness simulation, exact cost digests,
      provider-report dedupe, and over-budget cancellation sensitivity`.

## Adversarial verification

1. Flood from one and many tenants with priorities, retries, and cancellations. Verify the
   stated fairness/starvation bound and fixed memory/queue ceilings.
2. Duplicate, reorder, omit, and correct sandbox/model/tool usage across price-version
   changes. Final cost must equal the independently calculated ledger.
3. Race last-unit admissions on every hierarchical limit. Accepted work must never exceed
   the configured bound.
4. Remove in-flight budget fencing in a scratch worktree. A post-budget tool call must
   make the verifier fail.

## Verification log
