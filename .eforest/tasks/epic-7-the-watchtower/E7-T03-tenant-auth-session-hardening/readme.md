---
id: E7-T03
epic: 7
title: "Tenant auth and session hardening: external users, internal capabilities, and uniform cross-tenant refusal"
priority: 703
status: pending
depends_on: [E7-T01]
estimate: L
capstone: false
---

## Goal

Every public API, stream subscription, scheduler mutation, sandbox callback, harness/tool
request, and administrative action authenticates one typed principal and authorizes the
exact tenant/workspace/run resource before data access. Browser sessions and internal
capabilities have distinct audiences, rotation, revocation, and uniform refusal semantics.

## Context

Auth0-backed users, agents-as-users, server replicas, Fly Sprites, harnesses, and broker
proxies are different principals. Reusing one token shape or trusting an internal header
would collapse tenant isolation at production scale.

## Deliverables

- Central principal/audience verifier and endpoint authorization matrix.
- Hardened browser session cookies/CSRF, internal capability rotation, callback proof,
  and revocation propagation.
- `make verify-E7-T03` with tenant, confused-deputy, replay, CSRF, and enumeration corpus.

## Acceptance criteria

- [ ] `make verify-E7-T03` passes cold and executes the complete endpoint/principal matrix
      with exact expected status/error classes and zero unauthorized stream-head movement.
- [ ] User session, API, replica, sandbox, harness, gateway, and broker identities have
      disjoint issuer/audience/type checks; no credential is accepted at another boundary.
- [ ] Browser sessions use Secure/HttpOnly/SameSite policy, rotation, expiry, logout/
      revoke, origin and CSRF validation for mutations, and no credential in client storage.
- [ ] Every object lookup is tenant-scoped before existence disclosure; foreign and unknown
      ids return indistinguishable typed responses, timing bands, and no data-dependent log.
- [ ] Revocation, role removal, lease loss, and agent/connection disable propagate before
      the next sensitive action across all replicas and internal capabilities.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (server authentication and
      authorization hardening; UI proof is deferred) + mitigation: cold-clone full matrix,
      cross-audience replay corpus, stream neutrality, timing bands, and revocation races`.

## Adversarial verification

1. Replay every credential type at every other boundary, with algorithm/key confusion,
   stale keys, malformed claims, duplicate headers, and proxy spoofing. None may cross.
2. Enumerate foreign ids across APIs/subscriptions and compare response body/status/timing/
   logs. Any stable existence oracle is a finding.
3. Exercise CSRF, CORS, origin confusion, cookie fixation, logout race, and revoked-session
   websocket/SSE continuation. No post-revoke event may flow.
4. Remove one tenant predicate in a scratch worktree. Its matrix case must turn red.

## Verification log
