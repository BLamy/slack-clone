---
id: E8-T02
epic: 8
title: Channels, direct messages, and roster
priority: 802
status: pending
depends_on: [E8-T01]
estimate: M
capstone: false
---

## Goal

The workspace shell renders authorized channels, direct messages, and a roster where
human and agent principals appear together with explicit type and presence labels.

## Context

A URL must not be an authorization capability. Lists and room contents are derived from
membership projections, and direct-message membership remains private across tenants.

## Deliverables

- Channel/DM navigation, roster UI, empty states, unread markers, and deep links.
- Authorized list/detail query doors with live projection updates.
- Human-versus-agent identity treatment that does not change ordinary room membership.
- Browser suites and final Replay/MP4 evidence.

## Acceptance criteria

- [ ] Channel and DM lists exactly equal the authenticated principal's server projection;
      hidden names, ids, counts, and unread state are absent from HTML and network data.
- [ ] Adding or revoking membership updates an already-open browser without reload and
      moves the exposed offset/digest to the independently replayed result.
- [ ] The roster includes both human and agent principals with stable ids and accessible
      type labels; duplicate display names never collapse identities.
- [ ] Direct channel/DM URL probes by a non-member are leak-neutral and append nothing.
- [ ] A final channel-to-DM-to-roster walkthrough has a cited Replay recording and
      same-session MP4 with zero console errors, page errors, and failed same-origin
      requests; each visible list's offset/digest matches independent replay.

## Adversarial verification

1. Enumerate room ids as members, non-members, and cross-workspace users; any metadata
   difference beyond the typed refusal is an information leak.
2. Revoke membership while the target room is open; stale content or a still-usable
   composer after the revocation event reaches head refutes live authorization.
3. Create a human and agent with identical names and avatars; identity confusion or a
   message attributed to the wrong stable id refutes roster correctness.
4. Compare Replay DOM attributes with independently dumped streams at the recorded
   offsets; any digest mismatch or console error refutes the browser claim.

## Verification log
