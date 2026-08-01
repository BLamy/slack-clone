---
id: E11-T03
epic: 11
title: Browser runtime conformance
priority: 1103
status: pending
depends_on: [E11-T02]
estimate: L
capstone: false
---

## Goal

The AlmostNode provider passes a browser-native conformance suite for workspace files,
process semantics, streaming, cancellation, deterministic fixtures, isolation, and
authorized networking without hidden host execution.

## Context

Passing unit-shaped adapter tests is insufficient. The suite runs in the supported browser
runtime and records which semantics match the common sandbox contract; unsupported
semantics remain explicit blockers rather than compatibility theater.

## Deliverables

- Shared sandbox conformance corpus executed against AlmostNode in a real browser.
- Browser-native fixtures for filesystem/process/I/O/network/time/cancel/crash behavior.
- Isolation and no-host-fallback monitors plus deterministic result manifest.
- Replay, same-session MP4, trace, and stream correlation evidence.

## Acceptance criteria

- [ ] Every capability advertised by E11-T02 passes its shared positive, negative, timeout,
      cancellation, crash, and cleanup cases in the pinned browser with zero skipped tests.
- [ ] Filesystem paths, environment, exit status, stdout/stderr ordering, backpressure, and
      resource-limit results match the frozen sandbox contract or are not advertised.
- [ ] Process/network monitors prove no host shell, local daemon, unrestricted fetch, or
      unregistered bridge supplies browser results.
- [ ] Two concurrent runs for different workspaces share no bytes, storage keys, messages,
      capabilities, service workers, or broker authorization.
- [ ] Final conformance evidence has Replay plus same-session MP4, zero console
      errors, and result/lifecycle offsets and digests equal independent replay.

## Adversarial verification

1. Block host process/network and inspect descendants/requests; a green test using hidden
   host support refutes browser-native conformance.
2. Fuzz paths, encodings, output volume, exit races, timeouts, and worker termination; an
   advertised behavior outside contract or leaked byte refutes the provider.
3. Run cross-workspace canaries concurrently under storage/service-worker churn; one
   recovered canary or misrouted event refutes isolation.
4. Corrupt one conformance result event and inject a console error; a still-green manifest
   or recording verifier refutes the evidence apparatus.

## Verification log
