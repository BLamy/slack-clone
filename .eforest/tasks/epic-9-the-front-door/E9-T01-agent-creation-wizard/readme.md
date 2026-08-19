---
id: E9-T01
epic: 9
title: Agent creation wizard
priority: 901
status: pending
depends_on: [E8]
estimate: M
capstone: false
---

## Goal

A workspace administrator can create a normal agent principal and an immutable draft
configuration revision through a resumable wizard without granting execution or storing
credentials before the configuration is valid.

## Context

Chat identity and execution authority are deliberately separate. The wizard creates an
agent principal and configuration draft; later tasks select providers, services, and
grants before activation.

## Deliverables

- Agent draft/revision API with validation, optimistic concurrency, and abandon/resume.
- Wizard for identity, instructions, room membership, and configuration summary.
- Server-side authorization and uniqueness rules for agent handles.
- Browser verification plus final Replay and same-session MP4.

## Acceptance criteria

- [ ] Only a principal with agent-management capability can create, edit, activate, or
      abandon a draft; refused attempts append no agent event.
- [ ] Every saved step creates or advances one immutable revision with a compare-and-set
      parent; stale tabs receive a typed conflict and cannot overwrite newer data.
- [ ] Draft agents cannot be mentioned for execution, claim runs, or receive credentials,
      though their creator can resume the exact validated wizard state.
- [ ] Instructions and display fields are bounded and safely rendered; control text,
      markup, and duplicate handles cannot alter another field or principal.
- [ ] The final create/resume/conflict walkthrough has a cited Replay recording and MP4
      from the same browser session with zero console errors and agent projection
      offset/digest equal to independent replay.

## Adversarial verification

1. Race edits from two tabs and retry stale requests; silent last-write-wins or two
   children of one revision refutes concurrency control.
2. Attempt creation and activation as member, removed admin, agent, and cross-workspace
   user; any unauthorized event or metadata leak refutes the door.
3. Submit oversized, Unicode-confusable, HTML, and prompt-like field values; script
   execution, schema escape, or identity collision refutes validation.
4. Inspect Replay/MP4 and raw stream at the displayed offset; missing transitions,
   digest mismatch, or browser errors refute the wizard proof.

## Verification log
