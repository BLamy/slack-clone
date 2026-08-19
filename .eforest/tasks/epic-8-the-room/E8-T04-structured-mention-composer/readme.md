---
id: E8-T04
epic: 8
title: Structured mention composer
priority: 804
status: pending
depends_on: [E8-T02]
estimate: M
capstone: false
---

## Goal

The composer creates accessible, structured mentions bound to stable authorized
principal ids so mentioning an agent is unambiguous and plain text cannot spoof a run.

## Context

Execution must be triggered from server-validated mention entities, never by reparsing
rendered text or trusting a display name. Renames and duplicate names must preserve the
same intended principal.

## Deliverables

- Keyboard-accessible mention search, selection, editing, and serialized composer model.
- Server canonicalization and authorization of mention ids at message append time.
- Rendering for human and agent mentions plus malformed/removed-principal handling.
- Browser, Replay, and same-session MP4 proof.

## Acceptance criteria

- [ ] Submitting a selected mention stores its stable principal id and visible label;
      copy/pasted `@name` text stores no structured mention and triggers no agent run.
- [ ] Suggestions contain only principals visible in the active room and remain usable
      by keyboard and screen reader with deterministic focus/selection behavior.
- [ ] The server rejects hidden, removed, cross-workspace, duplicate-offset, and malformed
      mention ranges before appending the message.
- [ ] Rename and duplicate-display-name fixtures render correctly while dispatch remains
      bound to the originally selected stable id.
- [ ] The final compose/send/render walkthrough has a cited Replay recording and MP4 from
      the same browser session, zero console errors, and a message offset/digest that
      matches independent replay of its structured mentions.

## Adversarial verification

1. Forge mention ids/ranges directly at the API and use overlapping Unicode text; an
   appended malformed or unauthorized mention refutes canonicalization.
2. Rename an agent after selection but before send; dispatch to a name-derived or wrong
   principal refutes stable binding.
3. Paste visually identical `@agent` text and inspect streams/run queues; any execution
   side effect refutes the structured-only trigger boundary.
4. Use Replay to inspect keyboard focus, serialized request, rendered chip, and correlated
   stream state; missing steps, console errors, or digest drift refute the proof.

## Verification log
