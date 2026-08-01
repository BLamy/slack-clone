---
id: E4-T06
epic: 4
title: "Ephemeral and persistent sandbox lifecycles: explicit retention, resume, reset, and destruction semantics"
priority: 406
status: pending
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

- Lifecycle policy and lineage schemas in `packages/sandbox` and Fly implementations for
  create/resume/suspend/reset/destroy.
- Persistent-tree manifest, ephemeral scratch separation, and retention-expiry worker.
- `make verify-E4-T06` with multi-run, crash, revoke, and expiry fixtures.

## Acceptance criteria

- [ ] `make verify-E4-T06` passes cold and replays two independent lifecycle sequences in
      each mode to identical lineage, tree, and terminal digests.
- [ ] Ephemeral mode destroys the Sprite and all writable storage after terminal run
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
