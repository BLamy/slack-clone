---
id: E5-T04
epic: 5
title: "Cloudflare OS credential-proxy bootstrap: attested Gatekeeper endpoint, no secret environment, and default-deny egress"
priority: 504
status: pending
depends_on: [E4-T05, E5-T03]
estimate: L
capstone: false
---

## Goal

A Cloudflare OS workspace/Gadget boots with a run-scoped credential proxy through an
attested Gatekeeper endpoint that is reachable only by the run's processes, authenticates
with its bound proxy identity, and routes approved secret-backed service requests without
placing real credentials in the workspace, environment, command line, filesystem, or
general network path.

## Context

The sandbox and broker become one security boundary here. The bootstrap must distinguish
the expected Infisical Agent Proxy path from ordinary Infisical caching Proxy behavior,
and E4's network policy must allow only the broker/tool endpoints required by the run.

## Deliverables

- Attested bootstrap manifest and Cloudflare OS/Gatekeeper startup wiring in
  `packages/sandbox-cloudflare-os`.
- Loopback or mutually authenticated local broker endpoint, health/readiness gate, and
  teardown/revocation hook.
- `make verify-E5-T04` plus opt-in real Cloudflare OS/Infisical integration gate.

## Acceptance criteria

- [ ] `make verify-E5-T04` passes cold with two isolated Cloudflare OS workspace/Gadget
      fixtures and proves each
      can use only its own broker identity and connection revision.
- [ ] No secret value or reusable broker token appears in Cloudflare OS env, argv, workspace,
      retained volume, process listing, run stream, or bootstrap manifest; canary scans
      cover success and every error path.
- [ ] Agent execution waits for a successful provider/mode attestation identifying
      Infisical Agent Proxy; an ordinary caching Proxy or generic endpoint fails closed.
- [ ] Egress permits the attested broker/tool path and denies direct calls to the target
      service, metadata/private networks, arbitrary internet, and sibling proxy endpoints.
- [ ] Cancel, suspend, destroy, or lease loss closes the endpoint and revokes identity
      before process continuation; persistent resume requires a newly issued identity.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (headless Cloudflare OS proxy
      bootstrap) + mitigation: cold-clone isolation matrix, canary scans, network-deny
      transcript, lifecycle replay, and gated real-provider smoke`.

## Adversarial verification

1. Read env, argv, filesystem, process metadata, crash dumps, and retained volumes from
   hostile child processes. Any credential bytes refute injection isolation.
2. Attempt direct service access, sibling proxy access, metadata access, and proxy
   impersonation. Only the own-run attested endpoint may answer.
3. Swap Infisical Agent Proxy for ordinary caching Proxy during readiness and after first
   request. The run must stop before another tool call.
4. Delay teardown while issuing requests after cancel. A single accepted post-cancel call
   is a finding.

## Verification log
