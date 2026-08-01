---
id: E9-T08
epic: 9
title: Onboard a service and agent
priority: 908
status: pending
depends_on: [E9-T02, E9-T07]
estimate: L
capstone: true
---

## Goal

From a cold start, an administrator imports one real service definition, binds its slots
through Infisical Agent Proxy, grants minimum tools, selects a sandbox and Codex or Claude
Code harness, passes a brokered test, activates the agent, mentions it, and receives one
audited reply without any credential entering the control plane.

## Context

This capstone is the complete executor.dev-like front door. It proves provider-neutral
configuration, real runtime brokerage, revision history, and an ordinary room outcome.

## Deliverables

- Cold-start onboarding harness with fresh workspace, catalog, providers, sandbox, and
  one planted secret canary.
- Full revision/run/audit evidence bundle and independent replay digest ledger.
- Final Replay recordings and same-run MP4s covering onboarding through room reply.
- Sensitivity legs for forged provider, widened grant, stale binding, and secret leak.

## Acceptance criteria

- [ ] The capstone starts with scrubbed environment, fresh streams, ephemeral ports,
      fresh browser/sandbox state, and no preconfigured agent, service, binding, or grant.
- [ ] Import, binding, least-privilege grant, provider selection, brokered test, activation,
      mention, run, and reply each produce one authorized event with complete causation.
- [ ] The selected harness/sandbox pair is revision-pinned and capability-compatible;
      substituting another provider or widening a tool/egress scope is refused pre-effect.
- [ ] The real service call succeeds only through a run-bound Infisical proxy capability;
      revoking the binding makes a fresh test/run fail without changing prior evidence.
- [ ] Independent replay of catalog, agent, policy, test, run, room, and audit streams
      matches every displayed offset/digest and one final composite digest.
- [ ] The planted secret is absent from stream dumps, configs, browser/network, logs,
      errors, artifacts, Replay, and MP4 while issuance/use/revocation remain auditable.
- [ ] Final evidence includes Replay and MP4 captured from the same capstone browser
      sessions, shows the full workflow and reply, and has zero console/page/network
      errors, skips, fallback proof, or unresolved audit links.

## Adversarial verification

1. Repeat from critic-created fresh roots and prove every provider, service, secret
   binding, and agent was created during the run; inherited state refutes cold onboarding.
2. Forge provider revisions, mutate the manifest after preview, widen grants, and replay
   the proxy capability; any side effect outside frozen revisions refutes the front door.
3. Revoke at test, activation, claim, and tool-call boundaries; compare outcomes with the
   documented fence and raw audit sequence. A post-fence effect is terminal refutation.
4. Replay all member streams independently and recompute the composite; missing events,
   unresolved references, or one unequal digest refutes provenance.
5. Scan all artifacts and interrogate Replay/MP4 for the canary, hidden console errors,
   and a complete onboarding-to-reply story; any leak or partial media fails.

## Verification log
