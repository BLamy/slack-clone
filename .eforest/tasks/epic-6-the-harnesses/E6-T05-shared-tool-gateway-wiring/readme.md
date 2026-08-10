---
id: E6-T05
epic: 6
title: "Shared tool gateway wiring: identical brokered tools and policy semantics for both harnesses"
priority: 605
status: pending
depends_on: [E5, E6-T03, E6-T04]
estimate: L
capstone: false
---

## Goal

Codex and Claude Code connect to the same run-scoped tool gateway projection, exposing
only search, describe, and execute for their immutable catalog/grant snapshot. Native
harness tool-call shapes are translated to one canonical request before policy, approval,
broker, execution, and provenance logic.

## Context

Harness choice must not change authorization. Separate per-harness integrations would
drift into different tools, schemas, approval behavior, or secret exposure, so adapters
terminate at a thin translation layer and share all substantive gateway code.

## Deliverables

- Run-scoped gateway endpoint/transport and Codex/Claude translation bindings.
- Canonical tool-call/result correlation, approval pause/resume, and disconnect recovery.
- `make verify-E6-T05` with cross-harness differential and security fixtures.

## Acceptance criteria

- [ ] `make verify-E6-T05` passes cold and drives equivalent Codex and Claude fixture calls
      to byte-identical canonical request, policy, broker, result, and provenance digests.
- [ ] Both harnesses receive exactly the captured catalog/grant operation set; adapter-
      native built-ins or workspace-defined tools cannot bypass or shadow gateway names.
- [ ] Native arguments are parsed then canonicalized once by E5; adapter differences
      cannot alter request digest, risk class, approval requirement, connection scope, or
      outbound target.
- [ ] Approval pause/resume correlates one native call to one canonical request, and
      reconnect/duplicate native records cause at most one service execution.
- [ ] Gateway auth is bound to run, harness process, Cloudflare OS workspace, lease, and expiry; a stolen
      endpoint/token from the other harness or run is refused.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (headless shared tool wiring)
      + mitigation: cold-clone cross-harness differential replay, exact request digests,
      duplicate-call races, and cross-run refusal tests`.

## Adversarial verification

1. Encode the same semantic call through both native formats using reordered keys,
   duplicates, numbers, Unicode, and unknown fields. Canonical outcome must match or fail.
2. Inject native built-ins, project tool definitions, gateway-name collisions, and stale
   endpoints. None may bypass the E5 policy/broker path.
3. Duplicate and reorder tool-call/result records around approval and disconnect. The
   target service must observe at most one approved request.
4. Fork policy logic into one adapter in a scratch worktree. Differential digests must go
   red.

## Verification log
