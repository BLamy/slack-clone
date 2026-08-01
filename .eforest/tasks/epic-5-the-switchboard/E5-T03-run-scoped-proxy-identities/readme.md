---
id: E5-T03
epic: 5
title: "Run-scoped proxy identities: least-privilege issuance, rotation, revocation, and replay resistance"
priority: 503
status: pending
depends_on: [E5-T02]
estimate: L
capstone: false
---

## Goal

Each invocation receives a unique, short-lived proxy identity authorizing only its
captured connection revisions and exact tool purposes. Identity issuance and revocation
are fenced to the run lease, rotate before expiry, and become unusable immediately on
cancel, terminal state, agent revocation, or connection revocation.

## Context

Sharing a workspace-wide broker token between agents would let prompt injection cross
connection and tenant boundaries. Run identity is therefore a first-class capability
with an auditable lifecycle, not an environment variable copied from the server.

## Deliverables

- Proxy-identity events/reducer, issuer, revoker, and scope validator.
- Proof-of-possession or equivalent single-run binding between Sprite and broker endpoint.
- `make verify-E5-T03` with expiry, replay, rotation, cancellation, and tenant-race cases.

## Acceptance criteria

- [ ] `make verify-E5-T03` passes cold and replays identity lifecycle fixtures twice to
      byte-identical active-scope, expiry, and revocation digests.
- [ ] An issued identity binds tenant, workspace, agent revision, run/lease, Sprite,
      connection revision set, tool-purpose set, audience, issued-at, expiry, and unique id.
- [ ] The orchestrator persists only identity metadata and hashes; bearer material is
      delivered through the sandbox bootstrap boundary and absent from streams, logs,
      evidence, command lines, and inherited process environments.
- [ ] Rotation overlaps only for the documented grace interval and invalidates the old
      identity afterward; replay from another Sprite or run is refused.
- [ ] Cancel, run terminal, lost lease, agent disable, and connection disable each revoke
      before the next request and produce exactly one terminal identity event.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (headless proxy identity
      protocol) + mitigation: cold-clone lifecycle replay, cross-scope refusal matrix,
      canary scans, clock-boundary tests, and revocation sensitivity`.

## Adversarial verification

1. Steal an identity and replay it from sibling run/Sprite, after rotation, and after every
   revocation trigger. Any accepted request is a critical finding.
2. Race renewal with cancel and lease loss across hostile clock skew. No post-terminal
   identity may become active.
3. Scan process tables, `/proc`-style fixtures, argv, env, dumps, traces, and errors for
   canary bearer bytes. One occurrence refutes delivery isolation.
4. Disable audience or Sprite binding in a scratch worktree. The cross-run replay fixture
   must make the verifier fail.

## Verification log
