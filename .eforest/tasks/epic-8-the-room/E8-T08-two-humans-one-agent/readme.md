---
id: E8-T08
epic: 8
title: Two humans and one agent share a room
priority: 808
status: pending
depends_on: [E8-T07]
estimate: L
capstone: true
---

## Goal

From a cold start, two authenticated humans and one configured agent participate as
normal room members: humans exchange and edit messages, one structurally mentions the
agent, both observe its run, an authorized human resolves an approval, and the agent
posts one durable reply.

## Context

This capstone proves the room experience without bypassing the E7 execution contracts.
The agent has ordinary identity and membership in chat, but execution, approvals, and
credentials remain separately authorized and auditable.

## Deliverables

- Cold-start two-human/one-agent end-to-end harness with fresh data and browser profiles.
- Deterministic event-order, projection, authorization, and secret-containment report.
- One final Replay recording set and MP4s tied to the same capstone run manifest.
- Adversarial sensitivity legs for duplicate trigger, stale approval, and digest drift.

## Acceptance criteria

- [ ] The capstone boots from a fresh clone with scrubbed environment, fresh stream data,
      ephemeral ports, fresh sessions, and no pre-existing executor or browser state.
- [ ] Two distinct human principals and one agent principal share exactly one authorized
      room; a fourth non-member can infer no room, message, run, or roster metadata.
- [ ] One structured mention creates one run; the approval is granted by an authorized
      human; the agent emits one reply; retrying browser requests creates no duplicate.
- [ ] Both human sessions observe the same ordered messages, thread/actions, run states,
      approval, and reply without reload, and independently replayed room/run/audit
      streams equal every final DOM offset/digest and one composite capstone digest.
- [ ] No planted credential appears in streams, DOM, network, logs, Replay, MP4, or
      artifacts, and non-member/unauthorized probes append no event.
- [ ] Final evidence contains Replay recordings and MP4s from the same capstone sessions,
      shows the complete interaction in both human contexts, and reports zero console
      errors, page errors, failed same-origin requests, skips, or fallback evidence.

## Adversarial verification

1. Re-run from critic-created fresh roots and verify no ports, sessions, streams, or
   executor state are reused; warm-state dependence refutes the capstone.
2. Duplicate and reorder mention, approval, and terminal delivery; more than one run or
   reply, or acceptance of a stale approval, refutes exactly-once effects.
3. Independently dump and replay room, run, and audit streams at the recorded boundaries;
   any DOM/member/composite digest mismatch refutes the visible story.
4. Plant secrets across prompt, environment, stdout/stderr, and artifact metadata, then
   scan every evidence surface; one recoverable value is terminal refutation.
5. Interrogate each Replay and matching MP4 for both human views, live transitions,
   approval actor, final reply, navigation, and console; partial or cross-run media fails.

## Verification log
