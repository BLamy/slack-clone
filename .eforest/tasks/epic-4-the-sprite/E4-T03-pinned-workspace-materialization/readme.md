---
id: E4-T03
epic: 4
title: "Pinned workspace materialization: one invocation digest becomes one byte-exact sandbox tree"
priority: 403
status: pending
depends_on: [E4-T02]
estimate: L
capstone: false
---

## Goal

The Fly adapter materializes an invocation's immutable workspace manifest into its Sprite
at `/workspace`, verifies a canonical tree digest before execution, and refuses archive,
path, symlink, or late-head changes that could make the sandbox run different source than
the dispatcher claimed.

## Context

E3 freezes the invocation snapshot. This task carries that proof across the remote
provider boundary. Materialization is input transfer, not a mutable synchronization
channel: source changes after dispatch create a new invocation and can never alter the
workspace already bound to a run.

## Deliverables

- Content-addressed workspace manifest and transfer implementation in
  `packages/sandbox-fly/src/workspace/`.
- Canonical tree-digest parity utilities shared with the dispatcher and an archive/path
  hardening corpus.
- `make verify-E4-T03` with clean, corrupt, truncated, and hostile-tree fixtures.

## Acceptance criteria

- [ ] `make verify-E4-T03` passes from a cold clone and byte-compares two independent
      materializations of the same manifest, including modes and empty directories, to
      the same committed digest.
- [ ] Execution is impossible until the remote tree digest exactly equals the invocation
      digest's workspace manifest; mismatch appends a refusal and starts no process.
- [ ] Absolute paths, `..`, NUL, non-NFC aliases, symlink escapes, device files, hard-link
      aliases, oversized entries, and decompression bombs are rejected before any write
      outside a newly created staging directory.
- [ ] Publication into `/workspace` is atomic: crash at every transfer boundary leaves
      either the previous complete tree or the new complete tree, never a mixed tree.
- [ ] A source-stream append after invocation capture does not change the remote tree;
      its bytes appear only in a separately dispatched invocation with a different digest.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (headless workspace
      materialization) + mitigation: cold-clone tree parity, hostile archive corpus,
      crash matrix, and exact digest comparison`.

## Adversarial verification

1. Fuzz manifests and archives with traversal, Unicode aliases, link cycles, sparse
   bombs, and truncated chunks. Any out-of-root write or partial published tree refutes.
2. Mutate one transferred byte after upload but before publish. Execution proceeding or
   the expected digest remaining green refutes the digest gate.
3. Dispatch from one head, advance the stream, and retry transfer. The claimed workspace
   must stay on the original head without reading mutable latest state.
4. Bypass staging rename in a scratch worktree and crash mid-copy. `verify-E4-T03` must
   turn red on mixed-tree detection.

## Verification log
