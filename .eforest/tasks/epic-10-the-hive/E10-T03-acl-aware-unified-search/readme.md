---
id: E10-T03
epic: 10
title: ACL-aware unified search
priority: 1003
status: pending
depends_on: [E9]
estimate: L
capstone: false
---

## Goal

Authorized users can search channels, direct messages, agents, runs, services, and
evidence through a rebuildable projection that applies current ACLs before returning
results, snippets, facets, counts, or timing-sensitive existence signals.

## Context

Search is a common cross-tenant leak. The index is derived, disposable state with a
source offset vector and digest; Durable Streams and authorization projections remain
authority.

## Deliverables

- Multi-entity search projection, checkpoint vector, rebuild tool, and query API.
- Server-side ACL filter with revocation/update propagation and leak-neutral responses.
- Search UI with keyboard navigation, filters, highlights, and source links.
- Cross-tenant, stale-index, browser, Replay, and MP4 tests.

## Acceptance criteria

- [ ] A cold rebuild from the same source boundaries produces byte-identical index digest,
      result ordering, snippets, and facets for a fixed query corpus.
- [ ] Unauthorized entities affect neither results, snippets, facets, counts, pagination,
      autocomplete, nor observable response class; direct result URLs reauthorize.
- [ ] Membership or grant revocation removes affected results within the committed offset
      bound, while stale index entries remain impossible to retrieve through any filter.
- [ ] Every result exposes source stream/offset/digest and resolves to content whose
      independently replayed state and access decision match exactly.
- [ ] The final multi-entity search and revocation walkthrough has Replay and same-session
      MP4 evidence with zero console errors and search/source digest correlation.

## Adversarial verification

1. Compare owner and outsider queries across exact terms, prefixes, typos, facets, counts,
   pages, and timing; any hidden-entity signal refutes ACL safety.
2. Revoke access during pagination and follow cached/deep links; returned stale content or
   metadata refutes query-time authorization.
3. Corrupt, delete, and rebuild index checkpoints; silent partial results or a digest that
   still matches refutes the measuring apparatus.
4. Inspect Replay results and independently resolve each stream reference at its offset;
   one unequal digest, broken ACL, or console error refutes proof.

## Verification log
