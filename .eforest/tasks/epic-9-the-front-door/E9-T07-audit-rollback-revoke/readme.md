---
id: E9-T07
epic: 9
title: Audit, rollback, and revoke
priority: 907
status: pending
depends_on: [E9-T06]
estimate: M
capstone: false
---

## Goal

Administrators can inspect the complete agent/service/policy revision history, roll back
by creating a new revision, and revoke bindings or agent execution with immediate,
auditable effect on future authority.

## Context

History is append-only. Rollback never rewrites events, and revocation must fence new
claims/capabilities while preserving redacted evidence for prior runs.

## Deliverables

- Unified redacted revision/audit projection with actor, causation, and effective time.
- Rollback preview/confirm and binding/agent revoke controls.
- Revocation propagation and in-flight-run policy with deterministic terminal outcomes.
- Browser, replay, and cold-rebuild tests.

## Acceptance criteria

- [ ] Rebuilding from raw events produces the same ordered audit history and effective
      configuration digest as the server and browser at their exposed offsets.
- [ ] Rollback creates a new revision referencing its source, shows an exact semantic diff,
      and revalidates current providers/services/policy before activation.
- [ ] Revocation fences new dispatch, claims, proxy capabilities, and tool calls at the
      documented boundary; repeated revocation is idempotent and prior evidence remains.
- [ ] Audit APIs/UI are tenant- and capability-scoped and redact secret values, tokens,
      prompts marked private, and provider-internal command details.
- [ ] The final inspect/rollback/revoke walkthrough has Replay plus same-session MP4,
      zero console errors, and audit/config offsets and digests equal independent replay.

## Adversarial verification

1. Rebuild history from a cold dump, reorder/omit one event, and demand digest failure;
   a green incomplete history refutes audit integrity.
2. Roll back across removed providers, changed schemas, and revoked bindings; activation
   without current validation refutes rollback safety.
3. Race revocation against dispatch, claim, secret resolution, and tool execution; a side
   effect beyond the frozen boundary or an unrecorded result refutes fencing.
4. Probe audit as unauthorized roles and scan all media for canaries; leaked history or
   secrets, digest drift, or console errors refute evidence.

## Verification log
