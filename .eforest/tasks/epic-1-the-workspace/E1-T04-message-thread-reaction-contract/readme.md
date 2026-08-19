---
id: E1-T04
epic: 1
title: "Message, thread, edit, delete, and reaction event contract"
priority: 104
status: verified
depends_on: [E1-T03]
estimate: L
capstone: false
---

## Goal

Replace last-object-wins room records with a versioned conversation event model for
messages, thread replies, edits, deletes, and reactions, reduced deterministically without
losing authorship or revision history.

## Context

The current edit path appends a replacement object with the same message ID. Agent replies,
approvals, and provenance need explicit event kinds and causal relationships. A message ID
is immutable, edits create revisions, deletes create tombstones, and reactions are
idempotent actor/message/emoji relationships. Thread roots and replies must remain in the
same authorized channel.

## Deliverables

- Conversation schemas, reducer, canonical ordering rules, and stable refusal taxonomy.
- Dispatch policies for authors, channel moderators, message limits, and referenced roots.
- Golden logs covering threads, concurrent edits, deletion, and reaction add/remove.
- Property tests and `make verify-E1-T04` cold-clone target.

## Acceptance criteria

- [ ] `make verify-E1-T04` exits 0 from a cold clone and replays valid fixtures twice to
      identical
      per-prefix conversation digests with all invalid fixtures refused at cited offsets.
- [ ] Message create, edit, delete, reply, reaction add, and reaction remove are distinct
      immutable events; replay retains actor attribution and revision history.
- [ ] Only the author may edit; author or an explicitly capable moderator may delete;
      every refusal leaves the channel head unchanged.
- [ ] A thread reply must reference a visible non-deleted root in the same channel and
      workspace; cross-channel, missing, cyclic, and reply-to-reply roots follow the frozen
      typed policy.
- [ ] Duplicate reaction adds/removes and retried message commands have one logical effect
      under their idempotency scope.
- [ ] Payload size, content type, Unicode normalization, and control-character limits are
      enforced before append without interpreting stored text as HTML or authority.
- [ ] Replay is declared `Replay: N/A (server conversation event contract) + mitigation:
      golden logs, authorization refusals, property tests, and per-prefix digest evidence`.

## Adversarial verification

1. Attempt edits and deletes as another human, an owned agent, workspace admin without the
   moderator capability, and sibling-workspace member. Any ambient privilege refutes policy.
2. Generate random valid conversations, then permute, duplicate, omit, or cross-link one
   event. Silent invalid state refutes reducer validation.
3. Race two edits and an author deletion at one expected head. The accepted stream ordering
   must fully explain final state, with stale writes refused or deterministically rebased by
   the frozen policy.
4. Fuzz Unicode, bidi controls, oversized bodies, invalid encodings, and markup. Crashes,
   divergent digests, or executable server output refute the boundary.
5. Disable author checking or revision validation in a scratch worktree; tests must fail.

## Verification log

### Builder — 2026-08-03 — activated after E1-T03 verification

- E1-T03 is verified at `a551a3a`; E1-T04 is now the sole active queue gate. This ticket
  will add immutable message, thread, edit, delete, and reaction events with deterministic
  replay, explicit author/moderator authorization, same-channel visible-root validation,
  idempotent reaction effects, and bounded text handling before append.

### Builder — 2026-08-03 — implementation complete

- Implementation commit: `d19ef5f0507765b373191c85ddc8d413f15eeb6f` (`E1-T04: implement
  message thread reaction contract`). The implementation adds six registered conversation
  event types, a text/plain/NFC/control-character boundary, immutable message revision
  history and delete tombstones, same-channel visible-root validation, author and active
  moderator policy, reaction toggle projection, and a server-side command/idempotency door.
  The compact E0 message shape remains backward-compatible so earlier ledger digests do not
  change.
- Cold command: `make verify-E1-T04`. Frozen install, `pnpm format:check`, `pnpm lint`,
  `pnpm typecheck`, `pnpm test`, and `pnpm build` all passed with zero skips. The promoted
  run was `PROMOTE_EVIDENCE=1 E1_T04_IMPLEMENTATION_COMMIT=d19ef5f0507765b373191c85ddc8d413f15eeb6f
  E1_T04_NETWORK_DISABLED=1 TEST_RUN_ID=promoted-e1-t04 node scripts/verify-e1-t04.mjs` from
  a clean implementation tree.
- The golden conversation log replays 12 offsets twice with stable per-prefix digests and
  final digest `sha256:b0634cfd50db4f167aa5199815a70ab80d93b4acb5af7dfaeb9e57903e2502cc`.
  Six invalid fixtures refuse at cited offsets with typed author, revision, root, and text
  errors. Authorization evidence covers author-only edits, active moderator deletes, stale
  revisions, archived channels, inactive members, root scope, Unicode/control limits, and
  two concurrent retries producing one target event and one durable receipt. A generated
  64-record property log, offline replay, credential scan, and guard sensitivity checks also
  pass. Replay: N/A (server conversation event contract) + mitigation: golden logs,
  authorization refusals, property tests, and per-prefix digest evidence.
- Evidence: `evidence/e1-t04-final/verification-summary.json`,
  `conversation-replay-evidence.json`, `refusal-matrix.json`, `authorization-matrix.json`,
  `boundary-matrix.json`, `idempotency.json`, `property-results.json`, `sensitivity.json`,
  and `offline-replay.json`.
- Claim: conversation source events now preserve authorship, revisions, tombstones, thread
  root relationships, and reaction effects deterministically; command validation and
  channel-scoped authorization refuse unauthorized or malformed mutations before the
  durable append door, while same-id retries converge to one logical effect.

### Critic — 2026-08-03 — refuted

- Fresh critic `019fc602-abae-7d23-ac06-02159d178b63` ran `make verify-E1-T04` against
  `f3383de` and independently replayed the 12-record fixture twice. The pinned gates,
  six invalid fixtures, authorization matrix, root/revision attacks, retry door,
  generated property log, offline replay, and disposable author/revision mutants all
  passed. Replay: N/A (server conversation event contract) + mitigation: golden logs,
  authorization refusals, property tests, and per-prefix digest evidence.
- VERDICT: refuted. A compact legacy `channel.message.created` event bypassed workspace
  channel scope and actor checks, while the explicit v1 shape refused the same attack
  (`packages/reducers/src/index.mjs:409`). U+0085 (Unicode C1 control) was accepted by
  the text boundary (`packages/protocol/src/messages.mjs:84`). Repair must enforce the
  same scope/actor policy for compact events without regressing historical E0 digests,
  and reject the complete C0/C1 control range before append.

### Builder — 2026-08-02 — refutation repaired

- Repair commit: `4e3da78b0257aba1a21febe72e0e48764e6b4c05` (`E1-T04: close compact
  scope and control boundary`). Compact legacy messages now use the same authenticated
  actor and workspace-scoped channel guard as explicit conversation events while keeping
  the E0 projection byte-for-byte unchanged. Message and reaction text boundaries reject
  C0 and C1 controls, including U+0085, before append. Unit and verifier regressions cover
  forged authors, foreign-workspace channels, legacy projection preservation, and C1 text.
- Cold command: `TEST_RUN_ID=repair-cold make verify-E1-T04`. Frozen install and all five
  gates passed: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
  `pnpm build`. Promoted command:
  `PROMOTE_EVIDENCE=1 E1_T04_IMPLEMENTATION_COMMIT=4e3da78b0257aba1a21febe72e0e48764e6b4c05
  E1_T04_NETWORK_DISABLED=1 TEST_RUN_ID=promoted-e1-t04-repair node scripts/verify-e1-t04.mjs`.
- Promoted replay remains 12 records with identical per-prefix digests and final digest
  `sha256:b0634cfd50db4f167aa5199815a70ab80d93b4acb5af7dfaeb9e57903e2502cc`. New evidence
  is `evidence/e1-t04-final/legacy-compatibility.json`; updated summary and boundary
  evidence record the compact-scope and C1-control refusals. Replay: N/A (server
  conversation event contract) + mitigation: golden logs, authorization refusals,
  property tests, and per-prefix digest evidence.

### Critic — 2026-08-02 — refuted

- Fresh critic `019fc60f-ce4d-7862-aa5a-3f7ea166149d` ran the pinned cold verifier and
  independently matched all 12 replay prefixes twice at final digest
  `sha256:b0634cfd50db4f167aa5199815a70ab80d93b4acb5af7dfaeb9e57903e2502cc`. Foreign
  compact channels, forged authors, reactions, authorization, roots, revisions,
  idempotency, permutations, and the revision sensitivity mutant passed; Replay: N/A
  (server conversation event contract) + mitigation: golden logs, authorization refusals,
  property tests, and per-prefix digest evidence.
- VERDICT: refuted. Compact legacy `channel.message.created` still accepted U+0085 and
  U+0000 because that branch checked only `typeof data.text` at
  `packages/reducers/src/index.mjs:412`, bypassing the conversation text validator.
  Repair must validate compact text too while retaining the historical projection shape
  and digest.

### Builder — 2026-08-02 — compact text boundary repaired

- Repair commit: `e711b8fe95f73fca32e7f59bebe96297375efdb8` (`E1-T04: enforce legacy
  text boundary`). Compact legacy message creation now runs the same text validator as
  explicit conversation events, rejecting C0/NUL and C1/U+0085 controls before append
  without changing the stored compact projection. Unit and verifier regressions cover both
  controls.
- Cold command: `TEST_RUN_ID=repair-compact-text-cold-2 make verify-E1-T04`; frozen install
  and all five gates passed. Promoted command:
  `PROMOTE_EVIDENCE=1 E1_T04_IMPLEMENTATION_COMMIT=e711b8fe95f73fca32e7f59bebe96297375efdb8
  E1_T04_NETWORK_DISABLED=1 TEST_RUN_ID=promoted-e1-t04-compact-text node scripts/verify-e1-t04.mjs`
  passed from a clean implementation tree. The promoted legacy evidence now records
  `compactControlsRefused: ["C0", "C1"]`. Replay: N/A (server conversation event
  contract) + mitigation: golden logs, authorization refusals, property tests, and
  per-prefix digest evidence.

### Critic — 2026-08-02 — refuted

- Fresh critic `019fc61a-391f-7912-a932-c4a12bcc6306` ran
  `E1_T04_NETWORK_DISABLED=1 TEST_RUN_ID=critic-20260803 make verify-E1-T04`, replayed
  all 12 prefixes twice, and confirmed final digest
  `sha256:b0634cfd50db4f167aa5199815a70ab80d93b4acb5af7dfaeb9e57903e2502cc`. All six
  invalid fixtures, compact scope/control attacks, explicit boundaries, reactions,
  authorization, roots, revisions, permutations, and author-guard sensitivity passed.
  Promoted evidence bound `e711b8fe` from a clean implementation tree. Replay: N/A
  (server conversation event contract) + mitigation: golden logs, authorization refusals,
  property tests, and per-prefix digest evidence.
- VERDICT: refuted. `src/ledger/conversation-auth.mjs:186` defaulted to an immediate
  no-op fence, so `authorizeDispatch` could succeed without `withChannelFence`, leaving
  a membership-revocation lookup/append race. The default must fail closed like the
  existing channel authorization fence.

### Builder — 2026-08-02 — authorization fence repaired

- Repair commit: `34d72c1b306ca52a91db7a7aee2b2e375af6d7cf` (`E1-T04: require conversation
  authorization fencing`). `createConversationAuthorization` now rejects a missing or
  invalid fence with `CONVERSATION_FENCE_REQUIRED`, and performs the state lookup inside
  the supplied fence. Unit and verifier regressions prove an omitted fence cannot
  authorize a message command.
- Cold command: `TEST_RUN_ID=repair-fence-cold make verify-E1-T04`; frozen install and
  all five gates passed. Promoted command:
  `PROMOTE_EVIDENCE=1 E1_T04_IMPLEMENTATION_COMMIT=34d72c1b306ca52a91db7a7aee2b2e375af6d7cf
  E1_T04_NETWORK_DISABLED=1 TEST_RUN_ID=promoted-e1-t04-fence node scripts/verify-e1-t04.mjs`
  passed from a clean implementation tree. New evidence is
  `evidence/e1-t04-final/fence.json`; it records `CONVERSATION_FENCE_REQUIRED`. Replay:
  N/A (server conversation event contract) + mitigation: golden logs, authorization
  refusals, property tests, and per-prefix digest evidence.

### Critic — 2026-08-02 — refuted

- Fresh critic `019fc624-d2df-7e03-b2a6-ec49932a3635` ran the disabled-network cold
  verifier, independently matched all 12 replay prefixes twice at final digest
  `sha256:b0634cfd50db4f167aa5199815a70ab80d93b4acb5af7dfaeb9e57903e2502cc`, and passed
  all invalid fixtures, conversation attacks, and sensitivity checks. Promoted evidence
  confirmed `34d72c1` and a clean start. Replay: N/A (server conversation event contract)
  + mitigation: golden logs, authorization refusals, property tests, and per-prefix digest
  evidence.
- VERDICT: refuted. The empty-channel compatibility return at
  `packages/reducers/src/index.mjs:827` accepts a compact message for an unknown channel
  in the same workspace, bypassing existence and membership checks. Also, a supplied
  fence that returns without invoking its callback is accepted; `authorizeDispatch`
  returns the fence's arbitrary result without proving authorization ran. E1 must require
  projected channel membership and fail closed on skipped fence callbacks, while keeping
  E0 compatibility explicit and isolated.

### Builder — 2026-08-02 — projection and fence repair published

- Repair commit: `7e8b9bc4d578eb6bb06e91bb9c7205a9ccee3d07` (`E1-T04: require projected
  channel membership`). Explicit conversation events now require a projected channel and
  active membership; compact legacy messages may use the projection-free path only when
  the replay input is explicitly identified as the E0-T05 compatibility format. A fence
  callback that is omitted or returns without invoking its authorization operation now
  fails closed with `CONVERSATION_FENCE_REQUIRED`.
- The valid fixture now begins with durable principal, workspace, workspace-membership,
  channel, and channel-membership facts, followed by the six conversation event variants:
  23 records total. This makes the strict E1 projection contract testable without changing
  the E0 compatibility boundary.
- Cold command: `TEST_RUN_ID=repair-projection-cold-2 make verify-E1-T04`; exit code 0.
  Frozen install and all five gates passed: `pnpm format:check`, `pnpm lint`,
  `pnpm typecheck`, `pnpm test`, and `pnpm build`. Promoted command:
  `PROMOTE_EVIDENCE=1 E1_T04_IMPLEMENTATION_COMMIT=7e8b9bc4d578eb6bb06e91bb9c7205a9ccee3d07
  E1_T04_NETWORK_DISABLED=1 TEST_RUN_ID=promoted-e1-t04-projection node scripts/verify-e1-t04.mjs`
  passed from a clean implementation tree.
- The promoted replay consumed all 23 offsets twice with identical bytes and stable
  per-prefix digests; final digest is
  `sha256:57f7e79e68667d6e74de4852393cd1ed78f676ed4dac44942ec64431fffc1e34`. Six invalid
  fixtures refused at their cited offsets. Evidence now includes the strict projection,
  legacy compatibility, and omitted/no-op fence checks. Replay: N/A (server conversation
  event contract) + mitigation: golden logs, authorization refusals, property tests,
  and per-prefix digest evidence.
- Claim: E1 conversation appends cannot rely on an unprojected or stale authorization
  path; legacy E0 replay is explicit and scoped, while source offsets, state digests,
  membership checks, fence execution, and refusal sensitivity remain interrogable.

### Critic — 2026-08-02 — refuted

- Fresh critic `019fc637-77ce-7b03-862f-7ce2a3e76de7` ran
  `E1_T04_NETWORK_DISABLED=1 TEST_RUN_ID=critic-final-projection make verify-E1-T04`;
  the cold verifier passed all five gates. It independently replayed the 23-record valid
  fixture twice at final digest
  `sha256:57f7e79e68667d6e74de4852393cd1ed78f676ed4dac44942ec64431fffc1e34`, matched all
  six invalid fixture refusals, exercised projection/membership/scope/text, omitted and
  skipped-callback fence checks, and proved the channel guard mutation goes red. Replay:
  N/A (server conversation event contract) + mitigation: golden logs, authorization
  refusals, property tests, and per-prefix digest evidence.
- VERDICT: refuted. Compact `channel.message.created` accepted in a projected E1 state
  without the E0 marker: `compactProjectedWithoutE0Marker: "ACCEPTED"`. The compatibility
  flag was only consulted by the empty-projection branch at
  `packages/reducers/src/index.mjs:851-860`; the compact branch itself still proceeded
  through projected channel checks. Repair must require explicit E0-T05 compatibility for
  every compact event, even when a projection happens to be present.

### Builder — 2026-08-02 — explicit legacy replay repair published

- Repair commit: `697b8f3f8e5549386a5dae602c3fc3ed58116bbd` (`E1-T04: require explicit
  legacy replay mode`). The compact E0 message reducer branch now fails with
  `REDUCER_LEGACY_COMPACT_REPLAY_REQUIRED` unless the caller explicitly opts into
  `allowLegacyCompactMessages`; the opt-in remains wired only to the E0-T05 replay dump
  marker. Unit and verifier regressions prove a compact event is refused without the
  marker even when an E1 channel projection exists, while the opted-in historical shape
  and scope/text checks remain unchanged.
- Focused commands passed: `E1_T04_SKIP_GATES=1 E1_T04_NETWORK_DISABLED=1
  TEST_RUN_ID=repair-explicit-compact node scripts/verify-e1-t04.mjs` and `pnpm test:unit`
  (99/99 tests). Cold command:
  `TEST_RUN_ID=repair-explicit-compact-cold make verify-E1-T04`; exit code 0. Frozen
  install and all five gates passed: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`,
  `pnpm test`, and `pnpm build`.
- Promoted command:
  `PROMOTE_EVIDENCE=1 E1_T04_IMPLEMENTATION_COMMIT=697b8f3f8e5549386a5dae602c3fc3ed58116bbd
  E1_T04_NETWORK_DISABLED=1 TEST_RUN_ID=promoted-e1-t04-explicit-compact node scripts/verify-e1-t04.mjs`
  passed from a clean implementation tree. The 23-record replay retains final digest
  `sha256:57f7e79e68667d6e74de4852393cd1ed78f676ed4dac44942ec64431fffc1e34`; all six
  invalid fixtures, fence checks, property checks, and sensitivity checks pass. The
  promoted `legacy-compatibility.json` now records
  `compactMessageRequiresExplicitE0Compatibility: true`. Replay: N/A (server
  conversation event contract) + mitigation: golden logs, authorization refusals,
  property tests, and per-prefix digest evidence.
- Claim: the legacy compact shape is a deliberately marked E0 compatibility mode rather
  than an implicit alternate E1 append path; unmarked compact events cannot bypass the
  explicit conversation contract even when projections are present.

### Critic — 2026-08-02 — final independent verification

VERDICT: verified

- Fresh critic `019fc63f-bc94-79d2-a7ab-16c9f6fcfb96` ran
  `E1_T04_NETWORK_DISABLED=1 TEST_RUN_ID=critic-explicit-compact make verify-E1-T04` and
  exited 0 with all five gates passing. It independently confirmed the 23-record replay
  digest `sha256:57f7e79e68667d6e74de4852393cd1ed78f676ed4dac44942ec64431fffc1e34`, all six
  invalid fixture refusals at cited offsets, strict projected E1 variants, and successful
  E0-T05 fixture replay. Replay: N/A (server conversation event contract) + mitigation:
  golden logs, authorization refusals, property tests, and per-prefix digest evidence.
- The compact projected-state attack refused with
  `REDUCER_LEGACY_COMPACT_REPLAY_REQUIRED`; explicit compatibility preserved the compact
  shape while rejecting foreign/unknown channels, forged actors, and C0/C1 text. Omitted
  and skipped-callback fences refused with zero lookup calls. Disabling the new guard in a
  disposable check changed refusal to acceptance, proving detector sensitivity.
- Exact diff coverage was exercised in `scripts/verify-e1-t04.mjs:556-680` and
  `test/unit/messages.test.mjs:185-248`. The working tree remained clean and the critic
  made no edits, staging, or commits. Evidence: `evidence/e1-t04-final/verification-summary.json`,
  `legacy-compatibility.json`, `fence.json`, `refusal-matrix.json`, and `sensitivity.json`.
