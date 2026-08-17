---
id: E4-T06
epic: 4
title: "Ephemeral and persistent sandbox lifecycles: explicit retention, resume, reset, and destruction semantics"
priority: 406
status: implemented
depends_on: [E4-T03, E4-T04]
estimate: L
capstone: false
---

## Goal

Agent configurations can select an ephemeral workspace destroyed after each run or a
persistent workspace resumed across runs under one agent-scoped lineage. Persistence is
explicit, encrypted by the provider boundary, digest-checked on resume, and revocable;
run scratch, broker identity, and secret material are never retained.

## Context

Long-lived coding agents benefit from caches and a durable working tree, while one-shot
service agents should leave nothing behind. Treating provider persistence as an
implementation detail risks cross-run secret leakage and stale-source execution, so both
modes need a common event model and destructive reset contract.

## Deliverables

- Lifecycle policy and lineage schemas in `packages/sandbox` and Cloudflare OS
  implementations for create/resume/suspend/reset/destroy.
- Persistent-tree manifest, ephemeral scratch separation, and retention-expiry worker.
- `make verify-E4-T06` with multi-run, crash, revoke, and expiry fixtures.

## Acceptance criteria

- [ ] `make verify-E4-T06` passes cold and replays two independent lifecycle sequences in
      each mode to identical lineage, tree, and terminal digests.
- [ ] Ephemeral mode destroys the Cloudflare OS Gadget/workspace and all writable storage after terminal run
      state; a provider inventory query finds no matching retained resource.
- [ ] Persistent mode resumes only the configured agent lineage, verifies its last tree
      digest before use, and records the base and new digests for every run.
- [ ] `/tmp`, broker sockets, proxy identities, environment credentials, and run-specific
      tool caches are excluded from retained state and absent after suspend/resume.
- [ ] Revocation or reset rotates the lineage fence and makes every old handle and resume
      token unusable; concurrent resume yields one winner.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (headless sandbox lifecycle)
      + mitigation: cold-clone multi-run replay, provider inventory checks, canary-secret
      scans, and stale-lineage races`.

## Adversarial verification

1. Plant canaries in every writable mount, environment, broker socket path, and process
   temp directory, then suspend/resume. Only declared workspace bytes may survive.
2. Race two resumes and retry destroy after accepted-then-timeout. Duplicate active
   workspaces or resurrected destroyed state refute fencing.
3. Corrupt the retained manifest and provider disk independently. Resume must fail before
   execution and identify a digest mismatch without publishing corrupt bytes.
4. Make ephemeral cleanup a no-op in a scratch adapter. The inventory assertion must fail.

## Verification log

### Builder — 2026-08-17

- Commit: `f1f441e3965f2f88ca4b0a2cd8a2192cbc414c9c`
- Cold run: `make verify-E4-T06`, `TEST_RUN_ID=e4-t06-cold-20260817`
- Evidence: `.artifacts/e4-t06/e4-t06-cold-20260817/{ephemeral-sequence,persistent-sequence,retention-race,provider-enforcement,verification-summary,cold-verification-transcript}.json`
- Lineage digests: ephemeral `sha256:d8dde86f1d7383d1635fc01ba7103f87f285cc7fd2a8978e1fd44ab194220c5c`; persistent `sha256:2dbb406a7ee0631e7c1329351f5cc769c8876d4e88c2fc338c65d724cbd5b550`.
- Tree digests: persistent first `sha256:996f1911f84d3501c23fb45cbb4d3a6498c39b8ea16c7ead57d673ae6366a5ba`; persistent second `sha256:62633bea51e388038e53567b2c14b02e5e0cb7dc5af3e1ac2b717aba4a11cfb5`.
- Terminal/event digests: ephemeral terminal `sha256:f7b4d2d29b761eb8f94973c02eac3202cd1dd6a81fbe61d62c6b4a78c1bbaa44`; persistent event `sha256:3d90ead780f71185f6a631bfd4f3f242dc21c6965cff6a5c5de9f83e190e7cd7`; retention expiry `sha256:ecbaf7364fe8b33dfda7f99d7487aa4c478ec01bcf45262c6c89512d7d999472`; provider lifecycle `sha256:7bf6805629dee8d2a14046ae201bcb6c46abcc86a882b9419daa750554a861c0`.
- Gates: `format:check`, `lint`, `typecheck`, `test:unit` (189 passed, 0 skipped), and `build` passed from a detached cold worktree.
- Replay: N/A (headless sandbox lifecycle) + mitigation: cold-clone multi-run replay, provider inventory checks, canary-secret scans, and stale-lineage races.
- Claim: lifecycle policy and lineage schemas bind explicit ephemeral or provider-encrypted persistent retention; only declared workspace bytes survive persistent suspend/resume, excluded mounts and credential-shaped material are refused, expiry/reset/revoke rotate fences, concurrent resumes have one winner, and Cloudflare OS reset/destroy leave no inventory match.
