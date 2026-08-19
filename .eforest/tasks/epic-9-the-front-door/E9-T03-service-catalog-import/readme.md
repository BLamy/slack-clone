---
id: E9-T03
epic: 9
title: Service catalog import
priority: 903
status: pending
depends_on: [E8, E5]
estimate: L
capstone: false
---

## Goal

An administrator can preview and import a versioned service manifest into a workspace
catalog, producing validated connection metadata and required credential slots without
fetching or storing credential values.

## Context

This is the executor.dev-like front door for services. Import is untrusted parsing:
network fetches, redirects, schemas, names, endpoints, and tool descriptions must be
bounded and tenant-scoped before one catalog event is appended.

## Deliverables

- Versioned service-manifest schema, parser, preview diff, and catalog import API.
- Catalog UI for URL/file import, validation findings, required secret slots, and tools.
- SSRF-safe fetch policy, size/time limits, canonicalization, and immutable source hash.
- Browser and replay evidence with malicious-manifest fixtures.

## Acceptance criteria

- [ ] Preview is log-neutral and shows a canonical diff; confirm appends exactly one
      catalog revision bound to manifest bytes, schema version, and SHA-256.
- [ ] Imports reject unknown versions, duplicate/colliding ids, oversized data, invalid
      endpoints, redirects outside policy, local/link-local targets, and embedded values
      in fields declared as credential references.
- [ ] Imported records contain metadata and required credential slot names only; secret
      values, authorization headers, fetch cookies, and importer sessions are absent.
- [ ] Reimporting identical bytes is idempotent; changed bytes create a reviewable new
      revision and never mutate the active service silently.
- [ ] The final preview/import/reimport walkthrough has a cited Replay recording and
      same-session MP4 with zero console errors and catalog offset/digest equal to
      independent replay.

## Adversarial verification

1. Serve redirect chains, DNS rebinding candidates, link-local URLs, slow bodies, and
   decompression bombs; any internal fetch or unbounded resource use refutes import safety.
2. Hide secrets in URLs, defaults, descriptions, headers, and tool schemas; a value in
   catalog events or browser evidence refutes credential separation.
3. Race identical and conflicting confirms from two admins; duplicate active service ids
   or non-deterministic catalog digests refute idempotency.
4. Recompute the manifest hash and catalog projection shown in Replay; mismatch, missing
   preview/confirm distinction, or console errors refute proof.

## Verification log
