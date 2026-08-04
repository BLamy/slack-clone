---
id: E1-T06
epic: 1
title: "Canonical structured mentions as durable trigger facts"
priority: 106
status: in-progress
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
