---
id: E5-T09
epic: 5
title: "Capstone: a real Cloudflare OS agent uses a real Infisical Agent Proxy connection through one approved tool call without seeing credentials"
priority: 509
status: pending
depends_on: [E5-T04, E5-T08]
estimate: L
capstone: true
---

## Goal

From a cold clone, an administrator imports a pinned test integration, creates a
SecretRef-backed connection, grants it to an agent, and runs that agent in a real
Cloudflare OS workspace/Gadget. The run searches/describes a tool, pauses for exact-request approval, executes
through a real Infisical Agent Proxy, receives the test result, then loses access on
revocation with zero credential leakage or retained provider resource.

## Context

This is the executor.dev-like onboarding and secure execution milestone. Agent Vault and
protocol fakes remain local-test aids but cannot satisfy the capstone. Ordinary Infisical
caching Proxy is explicitly not the provider under test.

## Deliverables

- Dedicated canary integration and least-privilege Cloudflare OS/Infisical test identities.
- End-to-end capstone runner, expected event/request/result digests, canary scans, and
  provider inventory/revocation evidence.
- `make verify-E5-T09-real` as the registered Epic 5 capstone target.

## Acceptance criteria

- [ ] `tools/verify/cold_clone.sh verify-E5-T09-real` uses a real Cloudflare OS
      workspace/Gadget and real
      Infisical Agent Proxy. Missing either provider exits nonzero with `SKIPPED:`; fake,
      Agent Vault, generic Infisical API, or ordinary caching Proxy cannot pass.
- [ ] Catalog import and connection/grant creation replay to committed version digests,
      and the invocation snapshot cites those exact revisions before sandbox creation.
- [ ] The first write-class execute pauses; approval of its canonical request digest
      causes exactly one brokered service call and one redacted result event.
- [ ] Changing one nested input after approval, calling an ungranted operation, direct
      service networking, and replaying the proxy identity from another Cloudflare OS
      workspace all fail
      before the target service observes a request.
- [ ] Canary secret bytes are absent from chat, model/harness input, argv, env, workspace,
      retained storage, streams, logs, traces, errors, and evidence; after revoke the same
      call fails and final Cloudflare OS inventory is empty.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (real headless brokered-tool
      capstone) + mitigation: cold-clone Cloudflare OS plus Infisical Agent Proxy
      transcript, request/result digests, target-service request count, canary scans, and
      inventories`.

## Adversarial verification

1. Verify provider identities and target-service audit data independently; prove neither
   fake, Agent Vault, nor ordinary Infisical caching Proxy served the successful call.
2. Exfiltrate through prompt input, tool arguments, errors, stdout/stderr, redirects, DNS,
   and direct sockets. Any canary disclosure or unbrokered request refutes the capstone.
3. Race approval, cancel, grant revoke, connection rotate, identity expiry, and execution.
   At most one request with the approved digest may reach the service.
4. Sabotage exact-digest binding, mode attestation, and canary scanning separately. Each
   mutation must turn the real capstone target red.

## Verification log
