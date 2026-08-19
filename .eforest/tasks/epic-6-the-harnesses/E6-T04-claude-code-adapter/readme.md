---
id: E6-T04
epic: 6
title: "Claude Code adapter: pinned noninteractive launch, structured activity, tool mediation, and cancellation"
priority: 604
status: pending
depends_on: [E6-T02]
estimate: L
capstone: false
---

## Goal

`packages/harness-claude` launches the pinned Claude Code CLI noninteractively inside the
claimed Cloudflare OS workspace, supplies only the immutable context pack and shared tool gateway,
normalizes its structured activity, and fences tools/output when the run cancels, expires,
or loses its lease.

## Context

Claude Code must satisfy the same observable contract as Codex without pretending their
native formats are identical. Provider-specific settings remain inside this adapter; the
dispatcher and Slack reply path consume only canonical events and results.

## Deliverables

- Claude Code launch-plan builder, structured-event parser, error mapping, and adapter
  manifest.
- Isolated Claude home/config generation with brokered auth reference and shared gateway.
- `make verify-E6-T04` plus opt-in real Claude Code CLI smoke gate.

## Acceptance criteria

- [ ] `make verify-E6-T04` passes cold and replays normal, tool-call, malformed-output,
      timeout, and cancellation transcripts to exact canonical event/result digests.
- [ ] Launch argv and environment are a frozen function of the adapter manifest and
      invocation snapshot; prompt/config text cannot add Claude flags, hooks, tools,
      permission bypasses, model endpoints, or inherited host settings.
- [ ] The adapter consumes a documented machine-readable Claude Code output mode; unknown
      or invalid records fail typed and cannot become assistant text, a tool call, or a
      successful terminal event.
- [ ] Claude Code can reach only the shared gateway and approved model/auth path. It
      receives no raw service credential and cannot invoke an unregistered local/MCP tool.
- [ ] Cancel, timeout, lost lease, and budget exhaustion terminate Claude and descendants,
      append one terminal cause, and reject later output or tool calls.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (headless Claude Code adapter)
      + mitigation: cold-clone structured transcript replay, launch-plan injection tests,
      process-tree cancellation, and gated real CLI smoke`.

## Adversarial verification

1. Inject project settings, hooks, skills, prompt flags, proxy env, PATH shims, and tool
   definitions. The actual launch and tool list must remain frozen.
2. Feed truncated, duplicated, interleaved, huge, and future-version event records. No
   malformed record may execute a tool or fabricate success.
3. Spawn descendants and race cancel with a tool call/result. No descendant or late
   gateway request may survive.
4. Replace the real CLI smoke with scripted harness output in a scratch worktree. Provider
   attestation must fail.

## Verification log
