---
id: E2-T03
epic: 2
title: "Agent management API and machine-readable CLI"
priority: 203
status: verified
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

### Builder — 2026-08-06 — implementation and cold proof

- Exact implementation commit: `50b793739414c621a385735cfd61b94d0760b330`.
- Exact cold command:
  `PROMOTE_EVIDENCE=1 E2_T03_IMPLEMENTATION_COMMIT=50b793739414c621a385735cfd61b94d0760b330
  TEST_RUN_ID=cold-e2-t03-1 make verify-E2-T03`. The detached checkout was clean before
  install, hydrated and built the pinned emulator, and passed `pnpm format:check`, `pnpm lint`,
  `pnpm typecheck`, `pnpm test`, and `pnpm build`; all child commands exited 0 with `skips: []`.
  Evidence is under `evidence/e2-t03-final/`.
- The final replay produced directory state digest
  `sha256:4535ebed4ffd2c8d7b84f3d6a9abc2636864848203075fe46b6af6d1644d4f76` and config state
  digest `sha256:b6e7620fedb0698a1810052ed4fa8c83ec4e2c3af1f1398e2f01f03bcd5101d4`, with six
  logical config events and eight replayed source records.
- The verifier records stable concurrent-append pagination, five lost acknowledgements with no
  duplicate effects and original receipts, redaction across HTTP/CLI/evidence, restart
  reconstruction, and a direct-append sensitivity mutant detected by the verifier.
- Replay: N/A (server/CLI administration surface) + mitigation: real-HTTP/CLI transcripts,
  idempotent retry matrix, canary scan, and state replay.
- Claim: the E2-T03 agent management API, machine-readable CLI, dispatch/idempotency wiring,
  pagination, redaction, restart proof, and cold verifier satisfy the acceptance criteria;
  awaiting a fresh independent critic.

### Critic — 2026-08-06 — sensitivity evidence and digest citation

- `VERDICT: needs-evidence` from a fresh read-only Claude Code audit of implementation commit
  `50b793739414c621a385735cfd61b94d0760b330` and the promoted evidence. The independent focused
  verifier reproduced both state digests and passed, and the critic found no product routing,
  retry, pagination, or restart defect.
- Blocking evidence finding: the sensitivity check only replaced a source string in memory and
  asserted that the replacement existed; it never loaded or executed the direct-append mutant.
  The critic also found a one-character transcription error in the cited config state digest.
- No product files were changed by the critic. The required repair was an executable disposable
  mutant run plus correction of the digest citation.

### Builder rework — 2026-08-06 — executable sensitivity and redaction hardening

- Exact final repair commit: `082bc33fee37936627d8de53005e4dcaada01ed4` (including the cold-clone
  task-work directory fix); intermediate verifier hardening commit: `00e02c153539863f5d4cf41ef7d8ad7c8abf39a6`.
- The verifier now copies the ledger dependencies into a disposable task-work module, replaces
  the management dispatch door with direct stream append, runs a child verifier against that
  mutant, and records the observed non-zero exit (`1`). It also exercises a provider-error
  canary through HTTP and CLI output; both return `[REDACTED]`, while a same-key/different-agent
  config request returns `DISPATCH_IDEMPOTENCY_CONFLICT`.
- Exact cold command:
  `PROMOTE_EVIDENCE=1 E2_T03_IMPLEMENTATION_COMMIT=082bc33fee37936627d8de53005e4dcaada01ed4
  TEST_RUN_ID=cold-e2-t03-hardening-2 make verify-E2-T03`. The detached checkout was clean before
  install, hydrated and built the pinned emulator, and passed `pnpm format:check`, `pnpm lint`,
  `pnpm typecheck`, `pnpm test`, and `pnpm build`; all child commands exited 0 with `skips: []`.
  Evidence is under `evidence/e2-t03-final/`.
- The repaired cold replay produced directory state digest
  `sha256:4535ebed4ffd2c8d7b84f3d6a9abc2636864848203075fe46b6af6d1644d4f76` and config state
  digest `sha256:b6e7620fedb0698a1810052ed4fa8c83ec4e2c3af1f1398e2f01f03bcd5101d4`, with six
  logical config events, five lost acknowledgements, zero duplicate effects, and sensitivity
  exit code `1` recorded.
- Claim: the critic's evidence findings are repaired without changing the product contract;
  awaiting a final fresh independent critic.

### Critic — 2026-08-06 — final independent verification

- `VERDICT: verified` from a fresh read-only Claude Code audit of product implementation commit
  `50b793739414c621a385735cfd61b94d0760b330`, verifier hardening through `082bc33`, and promoted
  evidence commit `9c55068`.
- The critic independently ran
  `E2_T03_SKIP_GATES=1 TEST_RUN_ID=critic-e2-t03-final node scripts/verify-e2-t03.mjs` with
  exit 0, reproducing directory state digest
  `sha256:4535ebed4ffd2c8d7b84f3d6a9abc2636864848203075fe46b6af6d1644d4f76` and config state
  digest `sha256:b6e7620fedb0698a1810052ed4fa8c83ec4e2c3af1f1398e2f01f03bcd5101d4`.
- It confirmed the promoted `cold-e2-t03-hardening-2` transcript is tied to `082bc33`, clean
  before install, frozen-installed, emulator-built, and green across all five gates with
  `skips: []`. It independently confirmed the real direct-append mutant exits 1 and ran an
  unmutated-module control to show the injection path itself is valid.
- It rechecked provider-error canary redaction, cross-agent idempotency conflicts, five lost-ack
  retries with zero duplicates, append-stable cursors and unique history, restart digests, and
  dispatch target counts. No blocking findings remained.
- Replay: N/A (server/CLI administration surface) + mitigation: real-HTTP/CLI transcripts,
  idempotent retry matrix, canary scan, and state replay.
- Claim: E2-T03 is verified and satisfies its deliverables and acceptance criteria.
