---
id: E1-T07
epic: 1
title: "Checkpointed, rebuildable chat projections"
priority: 107
status: pending
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
