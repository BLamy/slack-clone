---
id: E4-T05
epic: 4
title: "Default-deny sandbox networking: destination allowlists, metadata blocking, and auditable egress decisions"
priority: 405
status: implemented
depends_on: [E4-T02]
estimate: L
capstone: false
---

## Goal

Every Cloudflare OS Gadget starts with default-deny egress and receives only the run-scoped
destinations needed for its configured Gatekeeper and tool gateway. DNS resolution,
redirects, IP changes, private ranges, provider metadata endpoints, and inbound listeners
are policed by one server-owned policy whose decisions are recorded without payload or
secret leakage.

## Context

An agent with arbitrary shell access must not turn a credential broker into general
internet access or reach tenant infrastructure. Hostname-only checks are insufficient due
to DNS rebinding and redirects; policy is enforced at the sandbox boundary and verified
against the real provider in E4-T08.

## Deliverables

- Versioned network-policy schema and compiler in `packages/sandbox` plus Cloudflare OS
  enforcement at the Gadget/Worker boundary.
- Resolver/redirect validation, private/link-local/metadata deny rules, and redacted
  decision events.
- `make verify-E4-T05` with an adversarial DNS and HTTP target matrix.

## Acceptance criteria

- [ ] `make verify-E4-T05` passes cold with zero skips and the same request matrix replays
      to a byte-identical allow/deny decision log and digest.
- [ ] A sandbox with an empty allowlist cannot make outbound connections or accept inbound
      traffic; loopback is limited to explicitly provisioned local sidecars.
- [ ] Allow rules bind scheme, canonical host, port, resolved address class, and purpose;
      redirects and every DNS refresh are re-evaluated before connect.
- [ ] RFC1918, loopback, link-local, Unix host mounts, and Cloudflare/Worker metadata endpoints
      remain denied even when reached by CNAME, numeric/encoded IP, redirect, or rebinding.
- [ ] Decision events include tenant/run, rule id, normalized destination, and outcome but
      omit query strings, headers, request bodies, tokens, and resolved secret values.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (sandbox network security
      boundary) + mitigation: cold-clone adversarial DNS matrix, deny-log replay, canary
      scans, and real-provider enforcement in E4-T08`.

## Adversarial verification

1. Exercise DNS rebinding, CNAME chains, IPv4/IPv6 encodings, redirects, proxy variables,
   and direct sockets. One route to a denied address refutes the boundary.
2. Attempt Cloudflare/Worker metadata access and inbound listener exposure from the public and
   sibling sandbox networks. Any response is a critical finding.
3. Put canaries in URLs, headers, and bodies. One canary in a decision event or error
   refutes observability redaction.
4. Delete the redirect re-check in a scratch worktree. The malicious redirect fixture
   must turn `verify-E4-T05` red.

## Verification log

### Builder — 2026-08-17

- Commit: `fe2bfc9edfd807ac267ad8c4eb0ff27a24f5744b`
- Cold run: `make verify-E4-T05`, `TEST_RUN_ID=e4-t05-cold-20260817`
- Evidence: `.artifacts/e4-t05/e4-t05-cold-20260817/{compiled-policy,decision-log,adversarial-matrix,provider-enforcement,verification-summary,cold-verification-transcript}.json`
- Policy digest: `sha256:49e15f184594ebd8a1b4cb53168ed19b3093d6796270507b54b9d55bd3839357`; decision digest: `sha256:4d7c778b5b36c654247e822e255e7dbbf61e19bd36a9955dcc3821faeac228d9`.
- Gates: `format:check`, `lint`, `typecheck`, `test:unit` (189 passed, 0 skipped), and `build` passed from a detached cold worktree.
- Replay: N/A (sandbox network security boundary) + mitigation: cold-clone adversarial DNS matrix, deny-log replay, canary scans, and real-provider enforcement in E4-T08.
- Claim: default-deny policy compilation binds scheme, host, port, public address class, and purpose; resolver refreshes, CNAMEs, redirects, encoded/private/metadata addresses, proxy bypass, and inbound exposure are denied and redacted decisions are replay-stable.
