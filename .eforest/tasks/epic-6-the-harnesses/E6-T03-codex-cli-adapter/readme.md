---
id: E6-T03
epic: 6
title: "Codex CLI adapter: pinned noninteractive launch, structured activity, tool mediation, and cancellation"
priority: 603
status: pending
depends_on: [E6-T02]
estimate: L
capstone: false
---

## Goal

`packages/harness-codex` launches the pinned Codex CLI noninteractively inside the claimed
Sprite, supplies only the immutable context pack and shared tool gateway, translates its
structured output into canonical harness events, and terminates the full process tree on
cancel or budget exhaustion.

## Context

Codex is a selectable harness, not a privileged server extension. Its configuration,
authentication, home directory, tools, and network access are run-scoped and controlled
by the same sandbox/broker policies as every other agent process.

## Deliverables

- Codex launch-plan builder, structured-event parser, error mapping, and adapter manifest.
- Isolated Codex home/config generation with brokered auth reference and shared gateway.
- `make verify-E6-T03` plus opt-in real Codex CLI smoke gate.

## Acceptance criteria

- [ ] `make verify-E6-T03` passes cold and replays normal, tool-call, malformed-output,
      timeout, and cancellation transcripts to exact canonical event/result digests.
- [ ] Launch argv and environment are a frozen function of the adapter manifest and
      invocation snapshot; prompt/config text cannot add Codex flags, tools, mounts,
      approval bypasses, model endpoints, or inherited host settings.
- [ ] The adapter consumes a documented machine-readable Codex output mode; unknown or
      invalid records produce typed adapter failure rather than being interpreted as chat
      text or tool authority.
- [ ] Codex can reach only the shared gateway and approved model/auth path. It receives no
      raw service credential and cannot invoke an unregistered local/MCP tool.
- [ ] Cancel, timeout, lost lease, and budget exhaustion terminate Codex and descendants,
      append one terminal cause, and reject later output or tool calls.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (headless Codex CLI adapter)
      + mitigation: cold-clone structured transcript replay, launch-plan injection tests,
      process-tree cancellation, and gated real CLI smoke`.

## Adversarial verification

1. Inject config files in workspace/home, malicious prompt flags, proxy env, PATH shims,
   and MCP/tool definitions. The actual launch and tool list must remain frozen.
2. Feed truncated, duplicated, interleaved, huge, and future-version event records. No
   malformed record may execute a tool or fabricate success.
3. Spawn descendants and race cancel with a tool call/result. No descendant or late
   gateway request may survive.
4. Replace the real CLI smoke with scripted harness output in a scratch worktree. Provider
   attestation must fail.

## Verification log
