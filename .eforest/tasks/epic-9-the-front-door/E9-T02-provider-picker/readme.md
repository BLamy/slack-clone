---
id: E9-T02
epic: 9
title: Harness and sandbox provider picker
priority: 902
status: pending
depends_on: [E9-T01]
estimate: M
capstone: false
---

## Goal

The agent wizard selects compatible harness and sandbox provider revisions from a
server-owned capability registry, supporting Codex or Claude Code without embedding
provider-specific execution logic in the agent definition.

## Context

Provider selection is a typed compatibility decision. A stored configuration references
adapter ids and immutable revisions; availability, capability, policy, and region are
validated again at activation and run time.

## Deliverables

- Provider capability/health query and compatibility decision API.
- Harness and sandbox picker with reasoned disabled states and configuration summary.
- Revision-pinned provider references with migration/unsupported-state rendering.
- Browser, Replay, and MP4 evidence for both supported harness choices.

## Acceptance criteria

- [ ] Picker options exactly equal authorized, healthy provider revisions returned by
      the server; hidden provider ids and configuration are absent from browser data.
- [ ] Every harness/sandbox pair is checked against declared capabilities, region,
      policy, and required services; incompatible pairs cannot be saved via UI or API.
- [ ] Agent revisions store only adapter id, revision, and non-secret options; no command
      string, provider token, credential, or resolved environment value is persisted.
- [ ] Disabling or superseding a provider leaves old revisions auditable but blocks new
      activation/runs with a typed remediation result.
- [ ] Final Codex and Claude Code selection journeys each cite Replay and same-session
      MP4 evidence with zero console errors and correlated agent-revision offset/digest.

## Adversarial verification

1. Forge unsupported adapter ids, revisions, and option keys directly at the API; any
   persisted unregistered choice refutes server ownership.
2. Change provider health/capabilities between display, save, activation, and run; a run
   launched on an invalid pair refutes revalidation.
3. Inspect configuration events and browser artifacts for provider command lines or
   secrets; one leaked runtime detail is a finding.
4. Cross-check Replay-visible selections against registry and revision stream at the
   displayed offset; disagreement or console failure refutes evidence.

## Verification log
