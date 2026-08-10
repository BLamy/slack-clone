---
id: E3-T08
epic: 3
title: "Capstone: mention to scripted agent reply"
priority: 308
status: implemented
depends_on: [E3-T05, E3-T06, E3-T07]
estimate: L
capstone: true
---

## Goal

Prove the complete durable dispatcher by posting a canonical mention, reconciling exactly one
invocation and snapshot, leasing it to a scripted agent runner, assembling bounded context,
and posting one provenance-bound agent reply while injected crashes, duplicates, cancellation,
and recursion attempts are handled honestly.

## Context

This is the final provider-neutral server gate. It uses the same registry, queue, lease,
capability, context, process, and reply contracts that Cloudflare OS, Infisical, Codex, and Claude Code
will implement later, but the scripted harness makes the scenario deterministic and
credential-free. A green result must be reconstructable from channel, config, invocation,
run, and audit streams after projections and process state are deleted.

## Deliverables

- Deterministic two-human/one-agent API scenario with mention burst, duplicate delivery,
  queued batch, cancellation, retryable crash, self-mention, and final reply.
- Scripted runner implementing the registered sandbox/harness contracts and metered process
  lifecycle without provider-specific shortcuts.
- Composite source/ref manifest, fault schedules, context/reply artifacts, stream dumps,
  projection rebuild, and canonical digest.
- `make verify-E3` and `make verify-E3-T08` cold-clone targets.

## Acceptance criteria

- [ ] `make verify-E3-T08` and composed `make verify-E3` exit 0 from a cold clone with fresh
      emulator/query state, zero skips, and every cited evidence path present.
- [ ] One canonical human-authored mention produces one deterministic invocation, immutable
      snapshot, winning lease, bounded cited context pack, scripted attempt, terminal run,
      and agent-authored threaded reply.
- [ ] Duplicate delivery, reconciler/worker races, and crash after append-before-ack create no
      duplicate logical invocation, attempt side effect, terminal outcome, or reply.
- [ ] A burst under one conversation key serializes and batches according to policy; a
      self-mention and ungranted agent delegation launch nothing and record typed outcomes.
- [ ] Cancellation and revocation terminate the scripted process tree, fence subsequent
      writes, and prevent late replies; bounded retry uses a new attempt without exceeding
      run or aggregate budgets.
- [ ] Context and reply contain only authorized source data, all output provenance resolves,
      and planted private/secret canaries are absent from prompts, process env, events, logs,
      artifacts, and evidence.
- [ ] After deleting projections and process state, independent replay of all source streams
      reproduces queue, run, context/reference, conversation, and audit state to one composite
      digest.
- [ ] Replay is declared `Replay: N/A (server/CLI scripted-agent capstone; real providers and
      UI land later) + mitigation: multi-process fault schedules, source/ref manifest,
      canary scans, projection rebuild, and independent composite replay`.

## Adversarial verification

1. Kill reconciler, queue worker, scripted runner, and API at every named boundary, then
   resume with empty process state. Lost or duplicated logical work refutes the capstone.
2. Race two workers, cancellation, lease expiry, agent disable, membership removal, and
   terminal reply. One stale mutation or second terminal refutes fencing.
3. Replay, edit, quote, and duplicate the source mention; construct self and two-agent cycles.
   Any unpermitted extra process launch refutes trigger/recursion policy.
4. Substitute sibling-workspace channel, agent, snapshot, connection-grant, and run IDs at
   each API. Any accepted cross-scope action or leaked context refutes isolation.
5. Tamper with one event, checkpoint, context citation, run artifact, reply provenance, and
   composite digest separately; the verifier must identify every mismatch.
6. Bypass one registered adapter or dispatch door in a scratch worktree; source/conformance
   guards and the composed capstone must fail.

## Verification log

### Builder — c7faa9229352cfeedcd723db46741ff631f39898

- `make verify-E3-T08` passed from a clean detached cold clone with `E3_T08_SKIP_GATES=0` and `E3_T08_SKIP_SENSITIVITY=0`.
- Gates: `pnpm format:check`, `pnpm format:check:e3-t08`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all passed.
- Evidence: `evidence/e3-t08-final/` — source/ref manifest, stream dumps, queue/lease manifest, context pack, reply receipt, fault schedules, attempt/process/cancellation/retry artifacts, projection rebuild, composite replay digest, canary scan, sensitivity, and cold-clone transcript.
- Composite replay digest: `sha256:3cadfdb13667d6d5c4aeb167e7c1dbf3e7172258bdf7469a1822b34f71fe4124`; rebuilt digest matched.
- Replay: N/A (server/CLI scripted-agent capstone; real providers and UI land later) + mitigation: multi-process fault schedules, source/ref manifest, canary scans, projection rebuild, and independent composite replay.
- Claim: the canonical human mention reconciles once, leases once, assembles authorized bounded context, produces one provenance-bound threaded reply, and handles duplicate delivery, batching/recursion refusals, crash retry, cancellation, authority revocation, process cleanup, and stale-write fencing without secret-shaped evidence.

### Builder — f1d3b486513e72af10ce4fdb70b88c86cda72ec7

- Addressed the independent critic's `needs-evidence` finding by persisting the active agent configuration as a two-record Durable Stream and binding the snapshot reference to its replayed state digest and stream head.
- `make verify-E3-T08` passed from a clean detached cold clone with `E3_T08_SKIP_GATES=0` and `E3_T08_SKIP_SENSITIVITY=0`.
- Gates: `pnpm format:check`, `pnpm format:check:e3-t08`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all passed.
- Evidence: `evidence/e3-t08-final/` — the source/ref manifest now includes the resolved config state reference; projection rebuild independently replays the config stream and matches the pre-delete projection.
- Composite replay digest: `sha256:0c6b02ddbe3724ccbd22428122e65b6e33fcf4c9a6215edf86c3bf9b2a203880`; rebuilt digest matched.
- Replay: N/A (server/CLI scripted-agent capstone; real providers and UI land later) + mitigation: multi-process fault schedules, source/ref manifest, canary scans, projection rebuild, and independent composite replay.
- Claim: the prior config provenance gap is closed; the canonical mention, immutable snapshot, lease, bounded context, scripted run, threaded reply, fault handling, source replay, and evidence canary protections remain reproducible from the exact implementation commit.
