---
id: E10-T04
epic: 10
title: Electric Forest project adapter
priority: 1004
status: pending
depends_on: [E9]
estimate: L
capstone: false
---

## Goal

A provider-neutral project adapter maps authorized Electric Forest project, task, branch,
run, verdict, and evidence events into canonical workspace references and commands while
preserving source offsets, digests, causation, and native authorization.

## Context

This integration must not make Git or a database authoritative and must not special-case
one repository. The adapter translates between versioned contracts; it does not mutate
Electric Forest state outside its supported command doors.

## Deliverables

- Project-adapter interface and Electric Forest implementation with capability discovery.
- Versioned event/reference mapping, checkpoints, retry/idempotency, and command mapping.
- Connection/authorization configuration through the E9 service and policy contracts.
- Golden mapping, cold-replay, disconnect/reconnect, and cross-tenant tests.
- Browser project-connection/live-reference journey with Replay and same-session MP4.

## Acceptance criteria

- [ ] Every supported source event maps deterministically to a canonical reference carrying
      source project, stream, offset, digest, schema version, actor, and causation.
- [ ] Duplicate delivery, reconnect from checkpoint, and crash around append produce no
      duplicate canonical event or source command effect.
- [ ] Commands are accepted only through declared Electric Forest doors under current
      source and workspace grants; forged project/task/branch ids fail pre-effect.
- [ ] Unknown source versions/events quarantine with a typed audit finding and do not
      advance the checkpoint past unprocessed truth.
- [ ] Cold replay of the golden project yields source and canonical digests equal to the
      committed mapping ledger with no Git or database as an alternate authority.
- [ ] The final browser journey shows connect, disconnect/reconnect, and a live project
      reference with a cited Replay and same-session MP4, zero console errors, and source/
      canonical checkpoint offsets and digests equal to independent replay.

## Adversarial verification

1. Duplicate, omit, reorder, and version-skew source events around checkpoint commits;
   skipped truth, duplicate effects, or an advanced bad checkpoint refutes reliability.
2. Substitute task/branch ids across projects and workspaces; one accepted cross-scope
   command or leaked source fact refutes authorization.
3. Remove network mid-command and vary acknowledgement order; ambiguous or repeated source
   mutations refute idempotent mapping.
4. Rebuild independently from raw Electric Forest streams and recompute both sides; one
   unsupported hidden dependency or digest mismatch refutes fidelity.
5. Inspect Replay and MP4 against source/canonical event ledgers; staged reference state,
   mismatched sessions, or console errors refute the browser claim.

## Verification log
