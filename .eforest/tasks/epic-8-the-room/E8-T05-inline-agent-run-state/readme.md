---
id: E8-T05
epic: 8
title: Inline agent run state
priority: 805
status: pending
depends_on: [E8-T03, E8-T04]
estimate: L
capstone: false
---

## Goal

A structured agent mention renders one inline, live run card that follows the durable
run state machine through terminal reply while preserving room authorization and secret
redaction.

## Context

Agent execution is a separate auditable resource linked to a normal message. The room
may show bounded status and output, but it must not become a raw executor-log or secret
transport.

## Deliverables

- Message-to-run linkage projection and authorized run summary query/live feed.
- Inline queued/running/waiting/succeeded/failed/cancelled UI with transcript excerpts.
- Redaction, truncation, artifact-link, reconnect, and terminal reply behavior.
- Browser and cross-stream correlation evidence.

## Acceptance criteria

- [ ] One accepted structured mention creates exactly one run id; duplicate delivery or
      browser retry cannot create a second run.
- [ ] Every legal run transition appears once and in order without reload; illegal,
      duplicate, and out-of-order events cannot regress or fork the projected state.
- [ ] The run card exposes correlated message-stream and run-stream offsets/digests that
      equal independent replay at the displayed state.
- [ ] A planted secret in executor output is absent from DOM, APIs, network logs, Replay,
      MP4, and stored room events while a redaction marker remains auditable.
- [ ] The final mention-to-terminal-reply walkthrough has a cited Replay recording and
      same-session MP4 with zero console/page/network errors.

## Adversarial verification

1. Deliver the mention and every transition twice, then reorder terminal events; more
   than one run or a regressed terminal card refutes idempotency.
2. View the linked message as a room non-member and a member without run-log grants;
   leaked status, prompts, logs, artifacts, or ids refute authorization.
3. Plant secrets in stdout, stderr, tool arguments, filenames, and artifact metadata;
   any recoverable value in browser or evidence refutes redaction.
4. Recompute both stream projections at recorded offsets; one unequal digest or UI-only
   state refutes the causal linkage.

## Verification log
