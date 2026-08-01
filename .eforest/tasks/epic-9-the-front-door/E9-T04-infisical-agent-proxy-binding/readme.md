---
id: E9-T04
epic: 9
title: Infisical Agent Proxy credential binding
priority: 904
status: pending
depends_on: [E9-T03]
estimate: L
capstone: false
---

## Goal

A catalog service can bind each required credential slot to an authorized Infisical
Agent Proxy reference so real values are injected only into a scoped run and never enter
the control plane, browser, event log, or agent configuration.

## Context

The binding is a reference and policy, not a secret. Resolution happens through the
proxy at execution time using a short-lived, run-bound capability with explicit audit
and revocation.

## Deliverables

- Credential-binding schema and authorization API for Infisical reference metadata.
- Proxy capability issuance/revocation boundary and redacted audit events.
- Binding UI that can validate references without revealing values.
- Leak-canary, cross-tenant, expiry, Replay, and MP4 verification.

## Acceptance criteria

- [ ] Binding events contain workspace/service/slot ids, opaque reference, policy, actor,
      and revision only; no resolved value or reusable Infisical credential is present.
- [ ] The proxy accepts only a short-lived capability bound to workspace, agent revision,
      run attempt, service, slots, and sandbox identity, and rejects replay or scope drift.
- [ ] Browser validation reports only typed present/missing/denied status and cannot read,
      infer length of, or enumerate unauthorized secret values/references.
- [ ] Expiry, revocation, agent revision change, and workspace removal prevent subsequent
      resolution without mutating prior audit history.
- [ ] The final bind/validate/revoke journey has a cited Replay and same-session MP4 with
      zero console errors; binding/audit offsets and digests match independent replay and
      all canary scans are clean.

## Adversarial verification

1. Replay capabilities across runs, sandboxes, services, slots, agents, and workspaces;
   one successful scope substitution refutes the broker boundary.
2. Probe response codes, timing, sizes, and UI states for unauthorized reference/value
   enumeration; a distinguishable hidden secret is a leak.
3. Plant unique canaries as secret values and scan streams, logs, DOM, network, Replay,
   MP4, errors, and artifacts; one hit refutes containment.
4. Revoke during resolution and after injection; use after the defined boundary or an
   unaudited issuance/refusal refutes lifecycle correctness.

## Verification log
