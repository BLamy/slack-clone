---
id: E1-T07
epic: 1
title: "Checkpointed, rebuildable chat projections"
priority: 107
status: in-progress
depends_on: [E1-T04, E1-T05]
estimate: L
capstone: false
---

## Goal

Materialize efficient workspace directory, channel list, message history, thread, reaction,
and unread views from authoritative streams while proving every projection can be deleted
and rebuilt exactly from checkpoints and source events.

## Context

Full room replay on every read will not scale to agent output and run events. A query store
is allowed as a disposable projection, never as authority. Its rows carry source stream,
offset, event digest, reducer version, and projection checkpoint. Access control is applied
at query time from authoritative membership state; private rows existing in storage do not
grant discovery.

## Deliverables

- Projection worker, checkpoint contract, reducer-version metadata, and query interfaces.
- Workspace/channel/message/thread/reaction/unread projection schemas.
- Rebuild, catch-up, corruption-detection, and shadow-compare commands.
- `make verify-E1-T07` cold-clone target with deletion/rebuild evidence.

## Acceptance criteria

- [ ] `make verify-E1-T07` exits 0 from a cold clone and records source heads, checkpoints,
      row manifests,
      and canonical projection digests before and after a full rebuild.
- [ ] Deleting the entire query store and rebuilding from source streams produces an
      identical canonical row manifest and digest with no manual seed or hidden database.
- [ ] Duplicate delivery, worker crash after row write before checkpoint, and resume from an
      older valid checkpoint cause no duplicate row or missed logical effect.
- [ ] Every projected row can be traced to source stream, offset, and digest; corrupt source
      reference or reducer version is detected rather than silently accepted.
- [ ] Snapshot and live-query results from the projection match independent source replay at
      every frozen checkpoint.
- [ ] Private channel and DM rows remain undiscoverable to non-members across list, count,
      pagination, error, and timing-oriented probes.
- [ ] Replay is declared `Replay: N/A (server projection and rebuild apparatus) + mitigation:
      projection deletion, source replay, row manifests, crash recovery, and digest parity`.

## Adversarial verification

1. Kill the projector before row write, after row write, and before checkpoint persistence;
   each restart must converge without duplicate logical rows.
2. Corrupt, regress, skip, and cross-wire checkpoints between channels and workspaces. Silent
   continuation or leaked data refutes checkpoint integrity.
3. Compare random prefixes through independent pure replay and projected queries. One
   unexplained mismatch refutes projection correctness.
4. Probe private projection data with valid sibling IDs and pagination cursors. Any metadata
   leak refutes query-layer authorization.
5. Disable idempotent upsert or source-digest checks in a scratch worktree; the failure
   harness must go red.

## Verification log

### Builder — 2026-08-04 — projection implementation and cold proof

- Implementation commits: `052a2fb26bdde640aa145a942b11abf7f5a75c63` adds the disposable
  checkpointed projection store, worker, query ACLs, verifier, and unit coverage; `8ec0bd8e5b46d9c85865876bbf4c95cb8e5fc902`
  records the lint-safe final implementation.
- Exact promoted cold command:
  `E1_T07_IMPLEMENTATION_COMMIT=8ec0bd8e5b46d9c85865876bbf4c95cb8e5fc902
  TEST_RUN_ID=e1-t07-final-20260804-r1 PROMOTE_EVIDENCE=1 make verify-E1-T07`. The clean detached
  checkout initialized the pinned emulator, completed frozen install and setup, and passed
  `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
- The final source replay covers 31 records across four authoritative streams. Checkpoint sequence
  31 records state digest `sha256:8d8dd7212213714ef3fb6e63ec9b0ce109299a4b9bc02bde3ff4bbce03f03385`
  and checkpoint digest `sha256:21a27823288372391a8dbbbc851a32d2f5cd6f0eed991a1aa38267d5d22a9b1c`;
  the canonical projection digest is `sha256:a374a259a0048556fbb5e7abedd7bf0b55a9a176eaa88da374ce753995718495`
  with row counts workspace 1, principals 3, memberships 3, channels 3, channel memberships 5,
  messages 2, threads 1, reactions 2, and unread rows 7.
- Deleting the entire disposable query store and rebuilding produces the same row manifest and
  digest. Duplicate delivery and a crash after 12 row writes before checkpoint persistence recover
  with no duplicate logical rows or missed effects. Independent replay comparison passes all 31
  frozen prefixes. Source references, reducer version, cross-workspace checkpoints, and row
  provenance corruption fail closed with typed projection errors.
- Query-time authorization shows the owner sees direct/public/private channels while the service
  principal sees only public channels; private and direct rows, counts, pagination, and messages
  refuse outsider access with generic `PROJECTION_ACCESS_DENIED` and no identity leak. The
  sensitivity mutant omits checkpoint persistence, installs in a disposable worktree, and is
  rejected by the nested verifier (exit 1).
- Promoted evidence is under `evidence/e1-t07-final/`, including the source dump, checkpoint and
  row manifests, crash recovery, prefix shadow comparison, access matrix, corruption detection,
  cold transcript, and sensitivity proof. Replay: N/A (server projection and rebuild apparatus) +
  mitigation: projection deletion, source replay, row manifests, crash recovery, ACL matrix, and
  digest parity.
- Claim: rebuildable workspace, channel, message, thread, reaction, and unread projections now
  converge from authoritative streams under duplicate delivery and crash recovery, preserve
  source/checkpoint provenance, and enforce query-time private/DM access boundaries; awaiting a
  fresh independent critic.
