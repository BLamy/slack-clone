---
id: E1-T06
epic: 1
title: "Canonical structured mentions as durable trigger facts"
priority: 106
status: implemented
depends_on: [E1-T04]
estimate: M
capstone: false
---

## Goal

Resolve visible `@handle` text into canonical, workspace-scoped principal references at
message dispatch and persist validated mention targets and spans as part of the source
message fact consumed later by the agent dispatcher.

## Context

Plain-text reparsing is not a safe job trigger: handles can change, quoted text can contain
mentions, edits and retries can retrigger work, and a client can spoof display text. The
server validates structured mention spans against the exact message bytes, current channel
membership, principal kind, and a frozen Markdown-aware parsing policy. Epic 1 records the
fact only; no agent process runs until Epic 3.

## Deliverables

- Mention span/reference schema, canonical parser, resolver, and typed ambiguity/refusal
  behavior for humans and agents.
- Dispatch integration that binds mentions to the accepted message offset and digest.
- Unicode, Markdown, retry, edit, handle-change, and membership fixtures.
- `make verify-E1-T06` cold-clone target and canonical mention evidence.

## Acceptance criteria

- [ ] `make verify-E1-T06` exits 0 from a cold clone and records canonical mention fixtures,
      source event
      offsets/digests, refusals, and replayed mention-state digests.
- [ ] Each accepted mention contains a stable principal ID, kind, validated byte span, and
      source message stream/offset/digest; display text alone is never a trigger authority.
- [ ] Mentions inside fenced code, inline code, escaped text, block quotes, URLs, or malformed
      spans follow the frozen non-trigger policy consistently across runtimes.
- [ ] Unknown, ambiguous, disabled, non-member, service, and sibling-workspace targets are
      refused or stored as plain text according to one typed policy without leaking identity.
- [ ] Retrying message creation returns the original mention fact; editing, replaying,
      reconnecting, or changing a handle creates no second trigger fact.
- [ ] Replaying historical events after handle or profile changes resolves the original
      stable target and produces the same digest.
- [ ] Replay is declared `Replay: N/A (server mention parsing and source binding) +
      mitigation: parser corpus, retry/edit matrix, source-offset evidence, and replay digest`.

## Adversarial verification

1. Fuzz Unicode normalization, bidi controls, zero-width characters, punctuation, duplicate
   handles, Markdown boundaries, and invalid spans. Cross-runtime disagreement refutes the
   canonical parser.
2. Forge a valid display handle with another principal ID or vice versa. Acceptance refutes
   server resolution.
3. Remove an agent from the channel between client composition and dispatch. A durable
   trigger targeting the removed member refutes head-time validation.
4. Retry, edit, delete, restore, and replay one mentioned message under concurrent delivery.
   More than one source trigger fact refutes idempotency.
5. Disable code-block exclusion or source-digest binding in a scratch worktree; the verifier
   must fail.

## Verification log

### Builder — 2026-08-04 — implementation and repaired cold proof

- Implementation commits: `278293ee52b5ecab83a5da39f2e66976adf89ce7` added the canonical
  mention protocol, resolver, reducer/schema validation, dispatch receipt binding, fixtures,
  and verifier; `165657df77ed5edbc5b449c5647b75dce7152267` repaired the independent critic's
  zero-width/format-control finding, sorted Markdown exclusion ranges before inline-code
  parsing, fixed escaped-backslash and astral-letter boundaries, and restored the existing
  E0-T03 conformance file to `format:check`. The latter is the exact implementation commit
  bound by the promoted evidence.
- Exact promoted cold command: `E1_T06_IMPLEMENTATION_COMMIT=165657df77ed5edbc5b449c5647b75dce7152267
  PROMOTE_EVIDENCE=1 TEST_RUN_ID=e1-t06-final-20260804-r2 make verify-E1-T06`. The detached
  checkout was clean before install, initialized the pinned emulator submodule, ran
  `pnpm install --frozen-lockfile`, `pnpm setup:emulate`, and the verifier; all exited 0.
  The verifier passed `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (120/120),
  and `pnpm build`.
- Parser evidence covers UTF-8 byte spans and fenced/inline/escaped/blockquote/URL exclusions;
  malformed spans and zero-width space, word joiner, BOM, soft hyphen, and zero-width-inside-
  handle inputs refuse with `MENTION_INVALID_TEXT`. Typed resolution refusals cover service,
  disabled, non-member, ambiguous, unknown, forged scope, forged kind, wrong bytes, and
  overlapping spans without identity leakage.
- Accepted dispatch facts are source-bound to `channel:ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc`,
  offset `0000000000000000_0000000000000001`, and event digest
  `sha256:4e3c1960740e4ee257fb139fa8f4d1d908e839474e20709f6098b8debc5c4f6c`; retry leaves one
  target event and returns the same source fact. Replay preserves the original `ada` target
  after a handle change with source digest `sha256:f60c0ff0ca8a831de64ac44b493184152106d29c843699382eea982d04ea9f30`,
  mention-state digest `sha256:95508697c8887311cdbccb90a00a63feb30d7162df6dc0d7eae257b9c6abae48`,
  and final state digest `sha256:db29485d3ffd116e870974363d8f39929c15ed2851986624aae740b6835cc66a`.
- Evidence: `evidence/e1-t06-final/cold-clone-transcript.json`,
  `verification-summary.json`, `parser-corpus.json`, `resolution-refusal-matrix.json`,
  `dispatch-retry.json`, `mention-replay-evidence.json`, and `sensitivity.json`. Replay:
  N/A (server mention parsing and source binding) + mitigation: parser corpus, typed refusal
  matrix, retry/edit matrix, source-offset evidence, replay digest, and sensitivity proof.
- Claim: canonical structured mentions resolve only from the authorized replayed workspace
  state, persist stable principal facts with exact source bytes and accepted stream references,
  preserve idempotent history across retry/edit/replay/handle changes, and refuse malformed or
  identity-sensitive inputs without leaking principal identity; awaiting a fresh independent
  critic.

### Builder — 2026-08-04 — reducer-policy repair and final cold proof

- Repair commit: `cf70595b745c49304f99becc9b9a67ed044917e1` (`Harden reducer mention policy`)
  makes the reducer compare every persisted mention fact with the canonical visible parser
  candidates, so a direct event writer cannot smuggle a mention from inline or fenced Markdown
  into durable state. The unit suite adds the inline-code regression; the previous `1eb49c2`
  repair remains responsible for format-control plain text, ZWJ preservation, load-bearing fenced
  exclusion, and dispatch/reducer source-digest alignment.
- Exact promoted cold command:
  `E1_T06_IMPLEMENTATION_COMMIT=cf70595b745c49304f99becc9b9a67ed044917e1
  PROMOTE_EVIDENCE=1 TEST_RUN_ID=e1-t06-final-20260804-r4 make verify-E1-T06`. The detached
  checkout was clean before install, initialized the pinned emulator submodule, ran frozen
  install and emulator setup, then passed `pnpm format:check`, `pnpm lint`, `pnpm typecheck`,
  `pnpm test`, and `pnpm build`.
- Parser evidence records visible UTF-8 spans, ZWJ emoji followed by a valid mention, all frozen
  Markdown/URL exclusions, and zero handles for zero-width space, word joiner, BOM, soft hyphen,
  and zero-width-inside-handle inputs. Typed resolution refusals cover service, disabled,
  non-member, ambiguous, unknown, forged-scope, forged-kind, wrong-byte, and overlapping-span
  cases without identity leakage.
- Retry evidence binds both attempts to one target event and one source checkpoint:
  `channel:ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc`, offset
  `0000000000000000_0000000000000001`, digest
  `sha256:aaa850e6ed60bdebb52aa364f0502c1fbe96f1068601f8520c0b2f98ba59b157`; the reducer
  projection explicitly reports `projectedSourceMatchesDispatch: true`. Replay twice produces
  the same final digest `sha256:c952583e83ebaf9417417a02f18a7da7773c3fa87719baeb373c56b138aaabab`,
  preserves principal `ada` after the profile handle becomes `ada-renamed`, and leaves one
  trigger fact after edit.
- Promoted evidence is under `evidence/e1-t06-final/`, including the cold transcript,
  verification summary, parser corpus, refusal matrix, dispatch retry, replay evidence, and
  sensitivity proof. Replay: N/A (server mention parsing and source binding) + mitigation:
  parser corpus, typed refusal matrix, retry/edit matrix, source-offset evidence, replay digest,
  reducer exclusion regression, and sensitivity proof.
- Claim: the reducer, parser, resolver, and dispatch receipt together make canonical structured
  mentions durable, workspace-scoped, Markdown-aware, idempotent, and stable across profile
  changes; awaiting a fresh independent critic.
