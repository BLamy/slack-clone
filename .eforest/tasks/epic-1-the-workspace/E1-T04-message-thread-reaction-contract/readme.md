---
id: E1-T04
epic: 1
title: "Message, thread, edit, delete, and reaction event contract"
priority: 104
status: pending
depends_on: [E1-T03]
estimate: L
capstone: false
---

## Goal

Replace last-object-wins room records with a versioned conversation event model for
messages, thread replies, edits, deletes, and reactions, reduced deterministically without
losing authorship or revision history.

## Context

The current edit path appends a replacement object with the same message ID. Agent replies,
approvals, and provenance need explicit event kinds and causal relationships. A message ID
is immutable, edits create revisions, deletes create tombstones, and reactions are
idempotent actor/message/emoji relationships. Thread roots and replies must remain in the
same authorized channel.

## Deliverables

- Conversation schemas, reducer, canonical ordering rules, and stable refusal taxonomy.
- Dispatch policies for authors, channel moderators, message limits, and referenced roots.
- Golden logs covering threads, concurrent edits, deletion, and reaction add/remove.
- Property tests and `make verify-E1-T04` cold-clone target.

## Acceptance criteria

- [ ] `make verify-E1-T04` exits 0 from a cold clone and replays valid fixtures twice to
      identical
      per-prefix conversation digests with all invalid fixtures refused at cited offsets.
- [ ] Message create, edit, delete, reply, reaction add, and reaction remove are distinct
      immutable events; replay retains actor attribution and revision history.
- [ ] Only the author may edit; author or an explicitly capable moderator may delete;
      every refusal leaves the channel head unchanged.
- [ ] A thread reply must reference a visible non-deleted root in the same channel and
      workspace; cross-channel, missing, cyclic, and reply-to-reply roots follow the frozen
      typed policy.
- [ ] Duplicate reaction adds/removes and retried message commands have one logical effect
      under their idempotency scope.
- [ ] Payload size, content type, Unicode normalization, and control-character limits are
      enforced before append without interpreting stored text as HTML or authority.
- [ ] Replay is declared `Replay: N/A (server conversation event contract) + mitigation:
      golden logs, authorization refusals, property tests, and per-prefix digest evidence`.

## Adversarial verification

1. Attempt edits and deletes as another human, an owned agent, workspace admin without the
   moderator capability, and sibling-workspace member. Any ambient privilege refutes policy.
2. Generate random valid conversations, then permute, duplicate, omit, or cross-link one
   event. Silent invalid state refutes reducer validation.
3. Race two edits and an author deletion at one expected head. The accepted stream ordering
   must fully explain final state, with stale writes refused or deterministically rebased by
   the frozen policy.
4. Fuzz Unicode, bidi controls, oversized bodies, invalid encodings, and markup. Crashes,
   divergent digests, or executable server output refute the boundary.
5. Disable author checking or revision validation in a scratch worktree; tests must fail.

## Verification log
