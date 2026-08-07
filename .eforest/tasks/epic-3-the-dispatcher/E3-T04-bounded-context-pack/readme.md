---
id: E3-T04
epic: 3
title: "Bounded, ACL-safe context pack with durable citations"
priority: 304
status: implemented
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

### Builder — 2026-08-07

- Commit: `557cde0cb5d6925297217227311c850f4478dadf` (`Strengthen E3-T04 critic sensitivity evidence`), including the bounded context-pack implementation, boundary hardening, verifier, and cold-clone target.
- Command: `PROMOTE_EVIDENCE=1 E3_T04_IMPLEMENTATION_COMMIT=557cde0cb5d6925297217227311c850f4478dadf TEST_RUN_ID=e3-t04-cold-final-v2 make verify-E3-T04`.
- Cold evidence: `evidence/e3-t04-final/cold-clone-transcript.json`, `verification-summary.json`, `pack-manifest.json`, `acl-canaries.json`, `truncation.json`, `trust-boundary.json`, `replay-digests.json`, `refusal-matrix.json`, `sensitivity.json`, and `canary-scan.json`.
- Pack evidence: canonical pack digest `sha256:2e15baf66fe66555415c49fef7fb7c150dbb6d15a40e287fc517f72a3f326c7f`; canonical bytes `4611`; source heads are config offset `0000000000000004_0000000000000000` digest `sha256:1d137b6339b853b9a1fea9673a77020faf0f0631dce82c4b9ab9d450be92a6f3`, channel offset `0000000000000003_0000000000000000` digest `sha256:a550503fa2909b8f6cc5fdbf808973c1c66bd998f054c5d9f03ecebd5b4329cf`, and directory offset `0000000000000005_0000000000000000` digest `sha256:5b8912c967e8730d0bd6855dd2005176f7845489198d4730c1ef43d5842430e4`.
- Gates: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (173 tests plus five Playwright integration tests), and `pnpm build` all passed from the detached cold checkout; the transcript records command stdout/stderr byte counts, SHA-256 digests, redacted previews, durations, and exit codes.
- Sensitivity: the clean control exited 0 and source-head-binding, private-scope-fence, and instruction-source-fence mutants each caused the complete E3-T04 verifier to exit 1 with nested sensitivity disabled. The final scan covered all ten published evidence files and found no credential or canary material.
- Replay: N/A (server context assembly) + mitigation: source-citation manifest, ACL canaries, deterministic truncation corpus, and byte/digest parity.
- Claim: the versioned context pack is deterministic, ACL-bound, citation-complete, bounded, trust-separated, and fail-closed against stale/private/foreign/deleted sources; the exact commit and promoted cold evidence are ready for independent critic verification.
