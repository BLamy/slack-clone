---
id: E7-T06
epic: 7
title: "Adversarial agent security suite: prompt injection cannot cross sandbox, tool, broker, harness, or tenant boundaries"
priority: 706
status: pending
depends_on: [E7-T02, E7-T03, E7-T04]
estimate: L
capstone: false
---

## Goal

A permanent attack suite exercises malicious messages, repository files, tool results,
service responses, model output, harness configuration, and provider faults against every
trust boundary. The suite proves that untrusted content cannot gain credentials, broaden
      network/tool scope, escape a Cloudflare OS Gadget, impersonate a principal, cross tenants, or publish an
unproven reply.

## Context

Prompt injection is input, not authority. Security depends on compositional controls from
E4-E7 surviving together; unit tests for each package are necessary but insufficient when
one subsystem's output becomes another's input.

## Deliverables

- Versioned attack corpus, deterministic target services, hostile workspaces, and multi-
  tenant orchestration harness.
- Security invariants mapped to concrete boundary observations and exact refutation output.
- `make verify-E7-T06` plus mutation suite covering each claimed defense.

## Acceptance criteria

- [ ] `make verify-E7-T06` passes cold with zero skips and replays every attack run twice
      to the same allowed/refused effects, canary inventory, and composite digest.
- [ ] Corpus covers prompt/tool/result injection, workspace config/hooks, symlink/path
      escape, shell/argv/env injection, SSRF/rebinding/metadata, approval substitution,
      identity replay, secret exfiltration, output/log poisoning, and tenant enumeration.
- [ ] Each case defines the exact permitted effects and proves all forbidden stream,
      provider, network, broker, service, and message heads remain unchanged.
- [ ] Real parsers/adapters/policy code are used; a fixture that bypasses the production
      boundary or asserts only a mock call cannot satisfy a security invariant.
- [ ] At least one independent mutation per sandbox, broker, gateway, harness, auth, and
      redaction boundary makes its mapped attack fail with the expected citation.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (headless adversarial security
      suite) + mitigation: cold-clone multi-tenant attack corpus, unchanged-head proofs,
      canary inventory, composite replay digest, and per-boundary mutation sensitivity`.

## Adversarial verification

1. Add novel chained attacks that move malicious data across at least three boundaries,
   including tool result to harness to gateway and workspace to harness to broker.
2. Replace deterministic refusals with errors/timeouts and verify no fail-open path,
   partial side effect, or secret-bearing diagnostic appears.
3. Run cases concurrently across tenants and replicas while cancelling/revoking mid-call.
   One cross-run/tenant effect or post-terminal effect refutes the suite.
4. Audit corpus coverage against every security acceptance criterion in E4-E7; any claimed
   boundary lacking a production-code attack and sensitivity mutation is needs-evidence.

## Verification log
