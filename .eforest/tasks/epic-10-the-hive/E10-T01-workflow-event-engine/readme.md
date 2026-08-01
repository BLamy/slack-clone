---
id: E10-T01
epic: 10
title: Workflow event engine
priority: 1001
status: pending
depends_on: [E9]
estimate: L
capstone: false
---

## Goal

Versioned workspace workflows deterministically match typed Durable Streams events and
emit authorized command intents with exactly-once effects, bounded recursion, and full
causation without evaluating arbitrary user code.

## Context

The hive needs event-driven coordination, but a workflow is not a privileged escape
hatch. Definitions are data, actions pass through their normal authorization doors, and
replay must predict the same decisions without repeating side effects.

## Deliverables

- Versioned workflow trigger/condition/action schema and canonical validator.
- Deterministic matcher, command-intent outbox, idempotency ledger, and causation graph.
- Recursion/depth/rate budgets, pause/disable controls, and redacted audit projection.
- Replay, crash-recovery, malformed-definition, and sensitivity tests.
- Browser workflow-inspection journey with Replay and same-session MP4 evidence.

## Acceptance criteria

- [ ] Given identical workflow revisions and input streams, two cold replays produce
      byte-identical decision logs, command-intent ids, and state digests.
- [ ] Duplicate delivery, worker crash before/after append, and restart cannot produce a
      second accepted command for the same workflow/input/action tuple.
- [ ] Every action is re-authorized under the workflow owner/service principal and target
      resource at execution; a match never grants authority absent from effective policy.
- [ ] Unknown fields/operators, invalid types, excessive depth, cycles, and self-trigger
      storms fail closed with typed, redacted audit events and no target side effect.
- [ ] A mutation suite proves changing one predicate, revision, input offset, or action
      changes the expected decision/digest and that the unmodified full gate exits 0.
- [ ] The final browser journey shows a workflow revision match, command intent, and audit
      result with a cited Replay and same-session MP4, zero console errors, and displayed
      definition/input/decision offsets and digests equal to independent replay.

## Adversarial verification

1. Crash workers around every append/ack boundary and redeliver each event; duplicate
   target effects or divergent decision ids refute exactly-once behavior.
2. Build direct and indirect workflow cycles with high fan-out; execution beyond the
   declared budget or loss of the causal root refutes containment.
3. Forge an action targeting another workspace or a resource revoked after match; an
   accepted effect refutes execution-time authorization.
4. Recompute decisions from raw definitions and events in a network-isolated process;
   nondeterminism, hidden mutable state, or digest mismatch refutes replayability.
5. Interrogate Replay and MP4 against the raw causal chain; staged UI state, mismatched
   sessions, or any console error refutes the browser evidence.

## Verification log
