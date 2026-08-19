---
id: E8-T07
epic: 8
title: Accessibility, responsive behavior, and performance
priority: 807
status: pending
depends_on: [E8-T06]
estimate: M
capstone: false
---

## Goal

The complete room remains keyboard- and screen-reader-operable, responsive at supported
viewports, and bounded under long histories and active agent output without weakening
live stream correctness.

## Context

This is a measurable quality gate for the E8 capstone. Virtualization or batching may
improve rendering, but displayed offsets and digests must still describe exactly the
state the user can observe.

## Deliverables

- Automated accessibility, keyboard journey, responsive-layout, and focus tests.
- Long-room and high-frequency-run fixtures with documented performance budgets.
- Reduced-motion, reconnect, offline, and error-state behavior.
- Final Replay/MP4 evidence at desktop and narrow viewport.

## Acceptance criteria

- [ ] Automated accessibility scans report zero serious/critical violations, and the
      keyboard-only journey can navigate rooms, compose mentions, inspect threads, and
      answer an approval without focus loss or keyboard trap.
- [ ] At 320 CSS pixels no primary action or message content requires horizontal page
      scrolling; at desktop width the room, thread, and run card remain simultaneously
      usable according to committed screenshot assertions.
- [ ] The committed 10,000-message plus active-output fixture stays within documented
      render, input-latency, DOM-node, and memory budgets in the pinned browser runner.
- [ ] Reconnect and history virtualization preserve exact message/run offsets and digests
      against independent replay; no dropped event is hidden by a fresh snapshot.
- [ ] Final desktop and narrow journeys cite Replay recordings and same-session MP4s,
      with zero console/page/network errors and no unexplained accessibility exceptions.

## Adversarial verification

1. Navigate the whole room using keyboard and a screen-reader accessibility tree; an
   unreachable control, unlabeled state, or focus reset refutes operability.
2. Flood run updates while scrolling a 10,000-message room; lost input, exceeded budget,
   or digest mismatch refutes performance correctness.
3. Resize across the supported range during mention and approval dialogs; clipped
   controls or background focus escape refutes responsiveness.
4. Inspect Replay/MP4 and raw traces for hidden errors, dropped live events, and budget
   violations; a recording that merely looks smooth is insufficient.

## Verification log
