---
id: E2-T03
epic: 2
title: "Agent management API and machine-readable CLI"
priority: 203
status: in-progress
depends_on: [E2-T02]
estimate: L
capstone: false
---

## Goal

Expose authenticated server and CLI operations to create agent principals, inspect and
revise configurations, manage lifecycle, and retrieve revision history through the same
fenced dispatch and replayable state used by the platform.

## Context

The first administration surface is intentionally server/CLI, keeping the roadmap
server-first. The CLI is JSON-in/JSON-out for scripting and future agent use; it does not
edit stream files or provider state directly. Reads return redacted configuration and
capability status, never broker credentials or hidden environment data.

## Deliverables

- Agent create, get, list, revise, activate, disable, revoke, and history endpoints.
- Machine-readable CLI with explicit workspace/agent targeting, idempotency keys, expected
  revisions, stable exit codes, and redacted output.
- API schema, pagination, error, retry, and restart integration tests.
- `make verify-E2-T03` cold-clone target and HTTP/CLI transcripts.

## Acceptance criteria

- [ ] `make verify-E2-T03` exits 0 from a cold clone and records matching API/CLI receipts,
      config revision
      digests, and final replayed state.
- [ ] Every mutating API and CLI command requires authenticated workspace context,
      idempotency identity, and expected revision where applicable, then routes through the
      dispatch door.
- [ ] Retried create/revise/disable/revoke commands return the original logical receipt and
      create no duplicate principal or revision.
- [ ] List and history pagination remain stable across concurrent appends and expose only
      agents/configurations visible to the caller.
- [ ] JSON output and logs are schema-stable, bounded, and redacted; canary secrets placed in
      provider doubles never appear in stdout, stderr, HTTP bodies, or evidence.
- [ ] Restarting the API with empty process state changes no command result or revision
      history after replay and projection catch-up.
- [ ] Replay is declared `Replay: N/A (server/CLI administration surface) + mitigation:
      real-HTTP/CLI transcripts, idempotent retry matrix, canary scan, and state replay`.

## Adversarial verification

1. Replay each command with another agent, workspace, expected revision, and idempotency
   scope. Any confused target or duplicate mutation refutes routing.
2. Fuzz pagination cursors while appending revisions. Missing, duplicated, or leaked rows
   refute stable listing.
3. Place canaries in provider errors, child-process output, and mock connection metadata.
   One reflected value refutes redaction.
4. Kill the server after append but before response for every command, then retry through the
   CLI. More than one logical effect refutes dispatch integration.
5. Bypass the API by appending directly in a scratch command; source/import guards must fail.

## Verification log
