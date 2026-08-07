---
id: E3-T04
epic: 3
title: "Bounded, ACL-safe context pack with durable citations"
priority: 304
status: in-progress
depends_on: [E3-T02]
estimate: L
capstone: false
---

## Goal

Build the deterministic context pack given to an agent from its trigger, permitted thread and
channel history, instructions, workspace inputs, and policy, with explicit trust labels,
strict bounds, and citations to every durable source.

## Context

Channel text, linked files, tool results, and repository content are untrusted input and may
contain prompt injection. Prompts cannot enforce authorization; the pack only supplies data
already authorized by the server, and later capabilities enforce actions independently. A
private-channel membership or context-scope mistake is a data breach even if the model never
mentions the leaked content.

Default conversation continuity is reconstructed from durable channel/run history rather
than a hidden harness resume session. Truncation is deterministic and records omitted ranges.

## Deliverables

- Versioned context-pack schema, canonical assembler, source citation, trust-label, and
  deterministic truncation policies.
- ACL and lifecycle checks over trigger, agent membership, thread/channel history, agent
  instructions, and workspace-input manifests.
- Secret/private canary, oversized-history, Unicode, deleted-message, and revocation fixtures.
- `make verify-E3-T04` cold-clone target and pack manifests.

## Acceptance criteria

- [ ] `make verify-E3-T04` exits 0 from a cold clone and records canonical pack bytes/digests,
      included and
      omitted source ranges, token/byte accounting, and refusal evidence.
- [ ] Every pack item cites authoritative stream, offset, event digest, principal, content
      kind, and trusted/untrusted classification; uncited ambient process data is absent.
- [ ] Only the triggering channel/thread and explicitly permitted workspace inputs visible to
      the agent are included; planted sibling-workspace, private-channel, DM, and removed-
      membership canaries are absent from bytes, logs, and evidence.
- [ ] Size, item, history-depth, attachment, and estimated-token limits use deterministic
      ordering/truncation and report exact omitted ranges without partial invalid encoding.
- [ ] Instructions are structurally separated from untrusted conversation/content, while
      authorization remains outside the prompt and is not weakened by injected text.
- [ ] Reassembling from the same cited source heads in a fresh process yields byte-identical
      context and digest; hidden harness/session history is not consulted.
- [ ] Replay is declared `Replay: N/A (server context assembly) + mitigation: source-citation
      manifest, ACL canaries, deterministic truncation corpus, and byte/digest parity`.

## Adversarial verification

1. Plant unique canaries in sibling workspaces, private channels, DMs, deleted messages,
   connection metadata, environment, and process cache. One canary in the pack refutes scope.
2. Remove channel membership and context grants at every assembly boundary. A pack completed
   from mixed/stale authorization refutes fenced reads.
3. Flood history with Unicode, huge messages, attachments, nested quotes, and adversarial
   tokenization. Nondeterministic selection or exceeded bound refutes truncation.
4. Insert instructions inside untrusted messages that request secrets or broader context.
   Any authorization/schema change refutes control-plane separation.
5. Disable one ACL source filter in a scratch worktree; the canary suite must fail.

## Verification log
