---
id: E8-T01
epic: 8
title: Authenticated workspace shell
priority: 801
status: pending
depends_on: [E7]
estimate: M
capstone: false
---

## Goal

The web app presents an authenticated, workspace-scoped shell whose identity and
workspace state come from authorized Durable Streams projections, never browser-held
provider tokens or caller-supplied workspace claims.

## Context

This is the browser entry point for the room. It must preserve the server-side session
and principal contracts from E7 while freezing one machine-checkable DOM convention for
stream-backed regions: stream id, consumed offset, reducer version, and state digest.

## Deliverables

- Auth-gated workspace route, layout, loading/error states, and workspace switcher.
- Session-backed current-principal and authorized-workspace query doors.
- Browser verification for redirects, tenant boundaries, navigation, and DOM projection
  correlation.
- Final Replay recording, same-session MP4, and offset/digest evidence ledger.

## Acceptance criteria

- [ ] A fresh unauthenticated browser is redirected through the canonical login flow;
      unauthenticated API calls return typed `401` JSON and never app HTML.
- [ ] An authenticated principal can enter only workspaces returned by the server-side
      membership projection; guessing another workspace id returns a leak-neutral
      refusal and appends no event.
- [ ] Every stream-backed shell region exposes its stream id, consumed offset, reducer
      version, and digest, and an independent stream replay at that offset produces the
      exact same digest.
- [ ] The browser bundle, storage, DOM, network log, Replay recording, and MP4 contain no
      access token, session value, credential, or secret canary.
- [ ] The final authenticated walkthrough has one cited Replay recording and an MP4
      captured from that same browser session, with zero console errors, page errors,
      or failed same-origin requests.

## Adversarial verification

1. Forge, expire, and revoke sessions while navigating direct workspace URLs; any shell
   data after refusal or any refusal-side stream append refutes the gate.
2. Replace a DOM offset or digest with a plausible stale value; a green correlation test
   refutes the browser evidence harness.
3. Search bundle, storage, network, Replay, and MP4 for planted secrets and token-shaped
   strings; one recovered value refutes credential containment.
4. Inspect the cited Replay and MP4 as a pair; differing sessions, hidden console errors,
   or a missing auth-to-workspace transition refutes the proof.

## Verification log
