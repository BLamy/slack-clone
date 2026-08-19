---
id: E3-T04
epic: 3
title: "Bounded, ACL-safe context pack with durable citations"
priority: 304
status: verified
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

- Commit: `a49084e5336b1dce9f2cc5ac72207bd200b139d9` (`Cover E3-T04 item and token budgets`), including the bounded context-pack implementation, boundary hardening, verifier, and cold-clone target.
- Command: `PROMOTE_EVIDENCE=1 E3_T04_IMPLEMENTATION_COMMIT=a49084e5336b1dce9f2cc5ac72207bd200b139d9 TEST_RUN_ID=e3-t04-cold-final-v4 make verify-E3-T04`.
- Cold evidence: `evidence/e3-t04-final/cold-clone-transcript.json`, `verification-summary.json`, `pack-manifest.json`, `acl-canaries.json`, `truncation.json`, `trust-boundary.json`, `replay-digests.json`, `refusal-matrix.json`, `sensitivity.json`, and `canary-scan.json`.
- Pack evidence: canonical pack digest `sha256:2e15baf66fe66555415c49fef7fb7c150dbb6d15a40e287fc517f72a3f326c7f`; canonical bytes `4611`; source heads are config offset `0000000000000004_0000000000000000` digest `sha256:1d137b6339b853b9a1fea9673a77020faf0f0631dce82c4b9ab9d450be92a6f3`, channel offset `0000000000000003_0000000000000000` digest `sha256:a550503fa2909b8f6cc5fdbf808973c1c66bd998f054c5d9f03ecebd5b4329cf`, and directory offset `0000000000000005_0000000000000000` digest `sha256:5b8912c967e8730d0bd6855dd2005176f7845489198d4730c1ef43d5842430e4`.
- Gates: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (173 tests plus five Playwright integration tests), and `pnpm build` all passed from the detached cold checkout; the transcript records command stdout/stderr byte counts, SHA-256 digests, redacted previews, durations, and exit codes.
- Truncation: the byte-budget corpus retained the trigger at `maxBytes: 609` and omitted the reply, old message, and workspace file with `reason: budget` and exact one-offset source ranges; the same corpus independently exercises `maxItems: 2` and `maxEstimatedTokens: 12`, both retaining two items and recording three budget omissions, alongside message-limit, history-depth, attachment-limit, and Unicode coverage in `truncation.json`.
- Sensitivity: the clean control exited 0 and source-head-binding, private-scope-fence, and instruction-source-fence mutants each caused the complete functional E3-T04 verifier to exit 1 with repository gates and nested sensitivity disabled for bounded mutant runs. The final scan covered all ten published evidence files and found no credential or canary material.
- Replay: N/A (server context assembly) + mitigation: source-citation manifest, ACL canaries, deterministic truncation corpus, and byte/digest parity.
- Claim: the versioned context pack is deterministic, ACL-bound, citation-complete, bounded, trust-separated, and fail-closed against stale/private/foreign/deleted sources; the exact commit and promoted cold evidence are ready for independent critic verification.

### Critic — 2026-08-07

VERDICT: verified

- Scope: fresh critic session; reviewed the tracked diff `a2d6d1b..HEAD` (9eff1a2) and every promoted file in `evidence/e3-t04-final/`. No product code was changed by the critic.
- Commit binding: the builder cites implementation commit `a49084e`; `git show --stat 9eff1a2` touches only `evidence/e3-t04-final/{cold-clone-transcript,truncation,verification-summary}.json` and `readme.md`, so `src/ledger/context-pack.mjs`, `scripts/verify-e3-t04.mjs`, `scripts/cold-verify-e3-t04.mjs`, `scripts/context-pack-fixture.mjs`, `test/unit/context-pack.test.mjs`, and `Makefile` at HEAD are byte-identical to the cited commit. Evidence is tied to the exact implementation.
- Transcript authenticity: `scripts/cold-verify-e3-t04.mjs:222-288` builds each transcript entry from real `execFileSync` results — exit codes come from `error.status`, digests are SHA-256 over the complete stdout/stderr, and previews are the redacted last 4000 bytes. A nonzero gate rethrows before `transcript.result = "PASS"` and before the transcript is written (lines 121, 148-151), so a PASS transcript cannot be produced by a failing run. `cold-clone-transcript.json` records a detached worktree at `a49084e`, `git status --porcelain --untracked-files=all` with 0 stdout bytes (clean checkout), `pnpm install --frozen-lockfile`, `pnpm setup:emulate`, and `node scripts/verify-e3-t04.mjs` (exit 0, stdout 33261 bytes, `sha256:238d4a5c…c33cc16`). Gate stdout is inherited into that digested verifier stdout, so the five gate results in `verification-summary.json:10-41` are covered by real output rather than an assertion of success.
- AC1 (cold `make verify-E3-T04`): `Makefile:83-84` delegates to `scripts/cold-verify-e3-t04.mjs`, which refuses a non-40-hex commit (lines 24-28) and fails closed on a dirty checkout (lines 95-97). Pack bytes/digests, included/omitted ranges, accounting, and refusals are all present in the promoted files.
- AC2 (citations): `scripts/verify-e3-t04.mjs:191-227,836-842` resolves every instruction, item, and trigger citation back to a supplied record, asserts the citation `eventDigest` equals the recomputed `digestEventEnvelope`, checks source-head digests, and asserts contiguous ordinals. Ambient absence is enforced by the env-canary probe at `scripts/verify-e3-t04.mjs:283-291,577`.
- AC3 (scope): `acl-canaries.json` records `siblingCanaryAbsent`/`ambientProcessValueAbsent` plus four refusals (`CONTEXT_PACK_PRIVATE_SCOPE` ×2, `CONTEXT_PACK_MEMBERSHIP_INACTIVE` ×2). `src/ledger/context-pack.mjs:1161-1204` requires active agent workspace membership, active channel, and active channel membership *before* the private/direct fence, so `includePrivate` cannot substitute for membership. Independent critic grep of the whole `evidence/` tree for `sibling-canary`, `ambient-value-must-not-enter-the-pack`, `PRIVATE KEY`, bearer/api-key patterns returned no matches.
- AC4 (bounds): `scripts/verify-e3-t04.mjs:378-463` exercises byte, item, and estimated-token budgets as three *independent* cases, each raising `maxMessages` to 50 so the omissions cannot be attributed to the message limit, and each asserting at least one `reason: "budget"` omission. `truncation.json` independently records `maxBytes: 609`, `maxItems: 2`, and `maxEstimatedTokens: 12`, each retaining two items with three budget omissions, alongside history-depth, attachment-limit (`attachmentBytes: 11`), and Unicode cases. `src/ledger/context-pack.mjs:238-254` refuses (`TRIGGER_LIMIT`) rather than emitting a partial trigger, and `226-236` refuses when trusted instructions alone exceed budget. `reversedInputByteParity` is backed by a real digest/canonical-bytes comparison against reversed `sourceRecords` (`scripts/verify-e3-t04.mjs:347-352`), so ordering is replay-derived, not input-derived.
- AC5 (trust separation): `scripts/verify-e3-t04.mjs:540-546` asserts the emitted pack has no `authorization`/`sourceRecords` keys and that the canonical serialization contains neither `workspaceMembership` nor `channelMembership`, with `policy.includePrivate` unchanged under injected instruction text; instructions carry `trusted-instructions` and no item may.
- AC6 (fresh-process parity): `scripts/verify-e3-t04.mjs:561-587` spawns a genuinely separate `node --input-type=module` child, compares digest and byte length, and asserts `replayContextPack` throws `DIGEST_MISMATCH` on tampered content. `replay-digests.json` shows `sha256:2e15baf6…f326c7f` / 4611 bytes in both processes.
- AC7 (Replay): `verification-summary.json:8` and the builder log carry the exact required string `Replay: N/A (server context assembly) + mitigation: source-citation manifest, ACL canaries, deterministic truncation corpus, and byte/digest parity`, with `replayUploadAttempted: false`. No browser surface is in the diff, so the declaration is appropriate.
- Adversarial items 1-4: covered by the ACL canary suite, the eight-case refusal matrix (`CONTEXT_PACK_CHANNEL_INACTIVE`, `MEMBERSHIP_INACTIVE`, `SOURCE_HEAD`, `WORKSPACE_INPUT_SCOPE`, `INSTRUCTION_SCOPE`, `SOURCE_SCOPE`, `TRIGGER_INVALID` ×2 including an appended `channel.message.deleted` trigger), the Unicode/attachment/nested-budget corpus, and the injection case above.
- Adversarial item 5 (sensitivity): `scripts/verify-e3-t04.mjs:693-766` asserts each needle occurs exactly once, checks out `a49084e` into a disposable worktree, neutralizes the source-head-binding, private-scope, and instruction-source fences, and asserts a nonzero verifier exit; the unmutated control asserts exit 0 (line 719). The mutant children disable only `E3_T04_SKIP_GATES`/`E3_T04_SKIP_SENSITIVITY` (lines 793-818), which suppresses repository gates and infinite nesting while leaving every functional E3-T04 check active — so the red result is produced by the detector under test, not by a gate. `sensitivity.json` records `controlExitCode: 0` and three mutants at exit 1.
- Additional critic attack (not on the builder list): I checked whether `policy.includePrivate` could act as a self-service ACL override. It cannot — the private/direct branch at `src/ledger/context-pack.mjs:1196-1204` is reached only after all three membership/lifecycle checks pass, and the authorization object is asserted structurally (`assertExactKeys`, `1144-1160`) and excluded from the emitted pack, so injected text or a permissive policy flag cannot widen the authorized channel set.
- Execution limits: this session's sandbox denied command execution for a rerun of `node scripts/verify-e3-t04.mjs`; read-only inspection (`git show`, `git diff --stat`, `grep`) was available and used. This is an environment limitation, not an evidence defect: the transcript's construction, gate wiring, budget cases, and mutation harness were verified by reading the exact code that produced the promoted files, and the canary scan was reproduced independently by grep over `evidence/`.
- Non-blocking observation: `verification-summary.json` gate entries record only `command`/`durationMs`/`result`; per-gate exit codes and output digests exist only inside the parent verifier's digested stdout. The builder note "173 tests plus five Playwright integration tests" is narrative and not separately recorded. Neither weakens an acceptance criterion.
- Verdict: no acceptance criterion or adversarial item was refuted. Status set to `verified`.
