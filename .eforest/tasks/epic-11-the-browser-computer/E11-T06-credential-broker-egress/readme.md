---
id: E11-T06
epic: 11
title: Browser credential broker and egress
priority: 1106
status: pending
depends_on: [E11-T03]
estimate: L
capstone: false
---

## Goal

AlmostNode runs call authorized services through a host-side egress broker that uses
Infisical Agent Proxy to inject real credentials beyond the browser boundary, so secret
values never enter JavaScript, Wasm memory, worker messages, storage, DOM, or recordings.

## Context

This is the only permitted real-credential path for the browser reach provider. The
browser sends a typed service operation under a run-bound capability; it never receives
a raw credential or arbitrary authenticated fetch primitive. Fly production is unchanged.

## Deliverables

- Run-bound browser-to-egress request protocol and broker identity attestation.
- Infisical Agent Proxy injection, allowlisted endpoint/tool enforcement, and revocation.
- Response sanitization, size/time/rate limits, audit, and browser-memory leak probes.
- End-to-end service-call Replay, same-session MP4, and canary evidence.

## Acceptance criteria

- [ ] The browser receives only an opaque single-run capability and typed operation schema;
      reusable service/Infisical credentials and authorization headers never cross into it.
- [ ] Broker revalidates run, attempt, agent/policy revision, sandbox identity, service/tool,
      endpoint, method, scopes, expiry, and revocation before each upstream side effect.
- [ ] Redirects, DNS changes, alternate encodings, custom headers, and response bodies
      cannot widen egress or reflect secrets beyond the catalog response schema.
- [ ] Cancellation, revocation, tab close, worker crash, and run termination fence future
      broker use, and duplicate requests follow the operation's idempotency contract.
- [ ] Final success/denial/revoke service calls have Replay and same-session MP4 with zero
      console errors; broker/audit/run digests match replay and canary scans of
      browser/Wasm/worker/storage/media are empty.

## Adversarial verification

1. Search JavaScript/Wasm memory, worker messages, caches, storage, DOM, network tooling,
   errors, Replay, and MP4 for unique secret canaries; one hit refutes the architecture.
2. Replay/substitute capabilities across runs, tabs, workers, agents, tools, endpoints,
   and workspaces; one accepted substitution refutes broker binding.
3. Attack redirects, DNS rebinding, request smuggling, header injection, response reflection,
   and oversized/slow bodies; egress outside policy or secret oracle behavior is a finding.
4. Revoke at every request phase and correlate Replay to broker/audit events; post-fence
   effects, missing audit, digest drift, or console errors refute proof.

## Verification log
