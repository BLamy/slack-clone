---
id: E9-T05
epic: 9
title: Tool policy and grants
priority: 905
status: pending
depends_on: [E9-T04]
estimate: L
capstone: false
---

## Goal

Administrators grant an agent an explicit, revisioned subset of catalog tools, service
scopes, egress destinations, and approval requirements that every run enforces at the
server and sandbox boundaries.

## Context

A prompt or harness option cannot widen authority. Effective policy is the intersection
of workspace, agent revision, service binding, sandbox capability, and per-run approval.

## Deliverables

- Canonical tool/grant policy schema, evaluator, explanation API, and revision events.
- Least-privilege policy editor with diff and effective-access preview.
- Enforcement hooks for dispatch, credential brokerage, tool calls, and egress.
- Policy matrix, mutation, and browser evidence.

## Acceptance criteria

- [ ] Deny is the default, wildcard grants require an explicit elevated capability, and
      the canonical evaluator returns the same decision/explanation across all doors.
- [ ] A run is pinned to one agent/policy revision; later widening or narrowing does not
      silently change an active attempt, and retries re-evaluate under their new attempt.
- [ ] Tool, credential, and egress enforcement each reject a forged client/harness request
      outside effective policy before the side effect and append a redacted audit event.
- [ ] Policy events and UI contain references/scopes only, never secret values or raw
      provider credentials.
- [ ] The final grant/edit/denial walkthrough has Replay and same-session MP4 evidence,
      zero console errors, and policy/audit offsets and digests matching independent replay.

## Adversarial verification

1. Generate the role/tool/service/scope/egress matrix and compare every enforcement door;
   one disagreement or fail-open unknown field refutes the evaluator.
2. Mutate policy during an active run and retry an old approved tool call; authority that
   changes outside the frozen attempt contract refutes revision pinning.
3. Bypass the UI through harness arguments, environment, redirects, alternate DNS, and
   direct proxy calls; any side effect beyond grants is a finding.
4. Verify each denial in Replay against its redacted audit event and digest; missing audit,
   leaked parameters, or console errors refute the evidence.

## Verification log
