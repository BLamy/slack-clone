---
id: E6-T02
epic: 6
title: "Pinned harness installation: allowlisted artifacts, verified digests, and repeatable Cloudflare OS workspace layers"
priority: 602
status: pending
depends_on: [E6-T01]
estimate: L
capstone: false
---

## Goal

Each harness version resolves to an administrator-approved immutable artifact manifest,
installs into a content-addressed Cloudflare OS workspace/Gadget layer, and verifies executable bytes and reported
version before any invocation. Installation never runs an unpinned remote script and
cannot be influenced by agent prompts or project workspace files.

## Context

Selecting “Codex” or “Claude Code” is meaningless if ambient latest packages change under
a run. Reproducibility and supply-chain control require artifact digest, runtime version,
source registry, install recipe, and adapter compatibility to be one reviewed manifest.

## Deliverables

- Harness artifact manifest/registry and installer in `packages/harness-install`.
- Content-addressed layer cache with signature/checksum verification and atomic publish.
- `make verify-E6-T02`, plus separately gated real artifact-resolution checks.

## Acceptance criteria

- [ ] `make verify-E6-T02` passes cold and installs frozen Codex and Claude fixture
      artifacts twice to identical tree/executable digests and version probes.
- [ ] A manifest freezes harness id/version, platform/architecture, runtime prerequisites,
      source URL/registry, artifact digest, optional signature identity, entrypoint, and
      adapter compatibility version.
- [ ] Redirects to unapproved origins, mutable tags, missing integrity, digest/signature
      mismatch, archive traversal, lifecycle scripts, and workspace-shadowed binaries are
      refused before atomic layer publication.
- [ ] Concurrent identical installs produce one published layer; crash leaves no layer
      addressable until every file and executable/version probe matches the manifest.
- [ ] A real resolution gate downloads approved production artifacts, verifies their
      pinned digests, and fails nonzero with `SKIPPED:` when provider access is absent; it
      may populate cache but never execute a model run.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (headless harness installer)
      + mitigation: cold-clone repeatable installs, hostile archive corpus, digest and
      version probes, atomic-crash matrix, and real artifact resolution`.

## Adversarial verification

1. Substitute same-version/different-byte artifacts, redirect chains, mutable tags,
   install hooks, path escapes, and executable shadowing. Any published layer is a finding.
2. Race installs and crash at each unpack/verify/rename boundary. Only one complete digest-
   addressed layer may become visible.
3. Change locale, timezone, umask, and archive order. Resulting tree digest must remain
   identical or fail explicitly.
4. Bypass checksum verification in a scratch worktree. A one-byte mutation must turn the
   verifier red.

## Verification log
