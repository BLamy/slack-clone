---
id: E5-T02
epic: 5
title: "Service connections and SecretRefs: replayable metadata without credential values"
priority: 502
status: implemented
depends_on: [E5-T01]
estimate: M
capstone: false
---

## Goal

The platform models an external service connection as stream events containing owner,
provider, integration, non-secret metadata, and versioned `SecretRef` identifiers. Create,
rotate, disable, and delete transitions are deterministic, while raw credential values
are rejected at every API and event boundary.

## Context

Slack-style administrators need to attach services to workspaces and agents, but Durable
Streams must never become a secret database. A `SecretRef` identifies broker-managed
material and version policy; it is not a URI that clients can dereference themselves.

## Deliverables

- Connection events, reducer, API schemas, and canonical validation in
  `packages/connections`.
- Secret-shaped input detector and migration-safe versioning for broker/provider refs.
- `make verify-E5-T02` with lifecycle, rotation, deletion, and leak fixtures.

## Acceptance criteria

- [ ] `make verify-E5-T02` passes cold and replays duplicate/reordered valid lifecycle
      events twice to an identical connection view and digest.
- [ ] The public schema permits only opaque `SecretRef` ids, provider/mount names, and
      non-secret labels; token-, password-, private-key-, cookie-, and connection-string-
      shaped values are rejected before append.
- [ ] Rotation creates a new immutable ref revision and atomically advances the active
      pointer; existing in-flight runs retain their captured revision, while new runs use
      the new one.
- [ ] Disable/delete immediately prevents new grants and records a tombstone without
      revealing whether provider-side secret material exists to unauthorized callers.
- [ ] Authorization distinguishes workspace-owned, agent-owned, and user-owned
      connections, and cross-tenant ids return the same typed not-found response without
      stream-head movement.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (server connection model) +
      mitigation: cold-clone reducer replay, secret-shaped input corpus, authz matrix,
      and exact lifecycle digests`.

## Adversarial verification

1. Submit secrets encoded as base64, JSON, URLs, multiline keys, Unicode-confusable keys,
   and nested metadata. Any accepted raw value refutes the model.
2. Race rotate, disable, and invocation capture. Every run must bind exactly one committed
   ref revision with no time-of-check/time-of-use switch.
3. Enumerate foreign connection ids through create/update/delete/grant error behavior.
   Any distinguishable tenant existence signal is a finding.
4. Remove one secret-shape detector branch in a scratch worktree. Its corpus entry must
   turn `verify-E5-T02` red.

## Verification log

### Builder — 2026-08-19

- Commit: `380bdd2047711f683c89535060b36fd0678d3920`.
- Commands: `pnpm install --frozen-lockfile`; `pnpm setup:emulate`;
  `pnpm format:check`; `pnpm format:check:e5-t02`; `pnpm lint`; `pnpm typecheck`;
  `pnpm test:unit` (204 passed); `pnpm test:integration` (15 emulator/Auth0 tests
  passed); and `pnpm build`.
- Local verifier: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e5-t02-final-380bdd2 make
  verify-E5-T02` passed duplicate/reordered replay parity with state/replay digest
  `sha256:f40a7853415af396818e3d0c25c9cf159ccae12875466ce07bf13f85da7424cb` and
  replay view digest
  `sha256:9d70ac30cbe321f7c0f04fa2b05dde4dd9f51b97da9f7ace52e6899f819a640f`.
- Evidence: `evidence/e5-t02-final/` contains the lifecycle state/events, replay
  digests, secret corpus, authorization matrix, detector sensitivity, cold transcript,
  and final canary scan. The secret corpus appended zero events and the final scan
  reported `leaked: false`.
- Replay: N/A (server connection model) + mitigation: cold-clone reducer replay,
  secret-shaped input corpus, authz matrix, and exact lifecycle digests.
- Claim: E5-T02 is implemented and ready for a fresh critic. Connections persist only
  opaque provider/mount SecretRef metadata, rotation advances immutable revisions while
  preserving captured run bindings, disable/delete fence new grants with tombstones,
  and foreign/unknown identifiers share the same typed not-found response.

### Critic — 2026-08-19

- VERDICT: refuted.
- Exact head: `b3eb419a7769e452c5580c96cdd5ae13f1ca33a7`; implementation commit:
  `380bdd2047711f683c89535060b36fd0678d3920`. The worktree was clean before the
  critic metadata change.
- Commands: `pnpm install --frozen-lockfile`; `make verify-E5-T02
  TEST_RUN_ID=e5-t02-critic-20260819
  TEST_ARTIFACT_DIR=.eforest/tasks/epic-5-the-switchboard/E5-T02-service-connection-secretref-model/work/critic-run`;
  `pnpm format:check`; `pnpm lint`; `pnpm typecheck`; `pnpm test` (204 unit and
  15 integration tests passed); `pnpm build`; and `git diff --check`. All commands
  passed. The verifier independently reproduced state/replay digest
  `sha256:f40a7853415af396818e3d0c25c9cf159ccae12875466ce07bf13f85da7424cb` and
  replay-view digest
  `sha256:9d70ac30cbe321f7c0f04fa2b05dde4dd9f51b97da9f7ace52e6899f819a640f`.
- Finding E5-T02-CRITIC-001: a standard-base64 encoding of a synthetic
  provider-token-prefix-shaped value was accepted by the exported normalizer and by
  `store.create` at `$.connection.metadata.encoded`; the independent append probe
  observed events changing from `0` to `1`. `looksLikeCredentialValue` only decodes
  base64 when the decoded bytes are printable and then checks a limited keyword set;
  provider token prefixes are absent from that decoded check. This directly refutes
  the base64/token-shaped rejection criterion and the raw-value-before-append goal.
- Finding E5-T02-CRITIC-002: the committed public event schema defines metadata only as
  an object with `additionalProperties: true` (`src/schemas/connection-events.v1.schema.json:109-112`),
  with no non-secret key/value or recursive constraints. A schema-only API consumer can
  therefore accept token-shaped metadata even though the runtime normalizer rejects the
  builder's fixed corpus.
- Independent adversarial results: JSON, URL, multiline private-key, Unicode-confusable
  and zero-width-confusable keys, nested cookie metadata, and SecretRef extra fields
  were rejected before append; the race matrix preserved captured revisions, fenced
  stale/concurrent rotation, blocked capture after disable/delete, and retained a
  tombstone; all read/grant/rotate/disable/delete foreign-vs-unknown comparisons
  returned identical typed `CONNECTION_NOT_FOUND` JSON with no state-digest movement.
- Sensitivity: removing the URL/connection-string detector branch in a scratch schema
  copy accepted the corpus URL fixture, and the corresponding corpus assertion turned
  red. Durable critic details are in
  `evidence/e5-t02-critic-20260819/critic-summary.json`.
- Replay: N/A (server connection model) + mitigation: cold-clone reducer replay,
  secret-shaped input corpus, authz matrix, exact lifecycle digests, and independent
  negative-path probes. Status remains `refuted` pending builder rework and a fresh
  critic.

### Builder — rework complete — 2026-08-19

- Commit: `a0974dbc743870d4256aa89642fbf732567ce57d`.
- Rework: decoded standard-base64 values are checked against the complete provider-token
  and private-key detector corpus before any append; the unit and verifier corpora now
  include an independently generated base64 `ghp_`-shaped token. The public JSON schema
  now recursively bounds metadata keys, values, arrays, integers, printable strings,
  URLs, credential assignments, provider-token prefixes, private keys, and generic
  base64-shaped strings.
- Commands: `pnpm format:check`; `pnpm format:check:e5-t02`; `pnpm lint`;
  `pnpm typecheck`; `pnpm test` (204 unit and 15 integration tests passed); and
  `pnpm build`.
- Local verifier: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e5-t02-rework-a0974db make
  verify-E5-T02` passed with state/replay digest
  `sha256:f40a7853415af396818e3d0c25c9cf159ccae12875466ce07bf13f85da7424cb`,
  replay view digest
  `sha256:9d70ac30cbe321f7c0f04fa2b05dde4dd9f51b97da9f7ace52e6899f819a640f`, and
  `leaked: false`.
- Evidence: `evidence/e5-t02-final/` was regenerated against the rework commit;
  `secret-corpus.json` records the new base64 provider-token case and zero appended
  events.
- Replay: N/A (server connection model) + mitigation: cold-clone reducer replay,
  secret-shaped input corpus, authz matrix, exact lifecycle digests, and independent
  negative-path probes.
- Claim: the two critic findings are addressed and E5-T02 is ready for a fresh
  independent verdict.

### Critic — second independent review — 2026-08-19

- VERDICT: refuted.
- Exact head: `31627f41ebe83b577fb82d13e61d651193f31719`; rework implementation commit:
  `a0974dbc743870d4256aa89642fbf732567ce57d`. The checkout was clean before this
  verification metadata change.
- Commands: `pnpm format:check`; `pnpm format:check:e5-t02`; `pnpm lint`;
  `pnpm typecheck`; `pnpm test` (204 unit and 15 integration/Playwright tests
  passed); `pnpm build`; `git diff --check`; and
  `make verify-E5-T02 TEST_RUN_ID=e5-t02-second-critic-20260819
  TEST_ARTIFACT_DIR=.eforest/tasks/epic-5-the-switchboard/E5-T02-service-connection-secretref-model/work/critic-second-20260819`.
  All gates passed. The verifier reported state/replay digest
  `sha256:f40a7853415af396818e3d0c25c9cf159ccae12875466ce07bf13f85da7424cb`
  and replay-view digest
  `sha256:9d70ac30cbe321f7c0f04fa2b05dde4dd9f51b97da9f7ace52e6899f819a640f`.
- Evidence: `evidence/e5-t02-critic-20260819-second/critic-summary.json` records
  the independent probes, exact source locations, gate results, and sensitivity
  mutation. Replay: N/A (server connection model) + mitigation: cold-clone reducer
  replay, secret-shaped input corpus, authz matrix, exact lifecycle digests, and
  independent negative-path probes.
- Finding E5-T02-CRITIC-SECOND-001: using one `runId`, an independent probe captured
  revision 1, rotated the connection, and captured the same run again at revision 2.
  `captureForRun` constructs and freezes a new snapshot on each call but keeps no
  run-to-revision binding ledger (`packages/connections/src/store.mjs:165-210`).
  This refutes the exactly-one committed revision/TOCTOU race criterion even though
  distinct run IDs and stale rotation attempts pass.
- Finding E5-T02-CRITIC-SECOND-002: `normalizeConnectionEvent` accepted a synthetic
  provider-token-shaped `eventId`, and `replayConnectionEvents` applied it. The event
  normalizer validates opaque-id syntax but does not run the credential detector over
  top-level event identifiers (`packages/connections/src/schema.mjs:286-364,727-735`),
  leaving a raw credential-shaped value accepted at the event boundary.
- Finding E5-T02-CRITIC-SECOND-003: an independent Ajv 2020 validation of the public
  JSON Schema accepted nested uppercase token/authorization keys and values, an
  uppercase URL, a JSON value with an uppercase secret key, an uppercase provider
  token prefix, and a provider-token-shaped label. The schema patterns are
  case-sensitive and `label` has no secret-shape constraint
  (`packages/connections/src/schemas/connection-events.v1.schema.json:103-167,170-220`).
  Lowercase provider-token/base64 controls, Unicode-confusable keys, and extra event,
  created-data, and SecretRef fields were rejected.
- Finding E5-T02-CRITIC-SECOND-004: in a detached exact-head worktree, removing the
  provider-token regex from `CREDENTIAL_VALUE_PATTERNS` left
  `make verify-E5-T02` green. The verifier's new provider-token fixture uses the
  metadata key `encodedProviderToken`, so the key detector catches it and masks the
  removed value-detector branch (`packages/connections/src/schema.mjs:34-43` and
  `scripts/verify-e5-t02.mjs:290-341`). The targeted detector sensitivity claim is
  therefore false for the reworked branch.
- Independent requested attacks that survived: standard base64 generic and
  provider-token-prefix values were rejected before append; JSON, URL, multiline key,
  Unicode-confusable key, nested values, SecretRef/extra-field runtime checks, stale
  rotation, disable/delete fencing, foreign-versus-unknown typed-error equality, and
  duplicate/reordered replay parity all passed. These do not close the four findings
  above. Status remains `refuted` pending rework and another fresh critic.

### Builder — second rework complete — 2026-08-19

- Commit: `5f248f71b9ef073d866abf7e13302320e50387bb`.
- Rework: run captures now bind one immutable revision per connection/run key before
  rotation or terminal fencing; event normalization scans the complete envelope before
  append; and the public JSON Schema recursively rejects case-variant credential keys,
  values, URLs, provider-token shapes, and secret-shaped labels/opaque ids.
- Independent verifier controls now include a provider-token event-id boundary probe and
  a provider-token detector mutation with the neutral `encodedValue` fixture key, so
  removing that detector branch makes the verifier red instead of being masked by a
  credential-shaped metadata key.
- Commands: `pnpm format:check`; `pnpm format:check:e5-t02`; `pnpm lint`;
  `pnpm typecheck`; `pnpm test` (205 unit and 15 integration tests passed); and
  `pnpm build`.
- Local verifier: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e5-t02-final-5f248f7 make
  verify-E5-T02` passed with state/replay digest
  `sha256:f40a7853415af396818e3d0c25c9cf159ccae12875466ce07bf13f85da7424cb`,
  replay view digest
  `sha256:9d70ac30cbe321f7c0f04fa2b05dde4dd9f51b97da9f7ace52e6899f819a640f`, and
  `leaked: false`.
- Evidence: `evidence/e5-t02-final/` was regenerated against this exact commit and
  records the new event-boundary and detector-sensitivity controls.
- Replay: N/A (server connection model) + mitigation: cold-clone reducer replay,
  secret-shaped input corpus, authz matrix, exact lifecycle digests, and independent
  negative-path probes.
- Claim: the second critic's four findings are addressed and E5-T02 is ready for a
  fresh independent verdict.

### Critic — third independent review — 2026-08-19

- VERDICT: refuted.
- Exact head: `7b0c8700904fb96d6b7688f130d2143216a7c9d0`; product rework under review:
  `5f248f71b9ef073d866abf7e13302320e50387bb`. The checkout was clean before this
  critic wrote its new evidence directory.
- Gates: `pnpm install --frozen-lockfile`; `pnpm format:check`;
  `pnpm format:check:e5-t02`; `pnpm lint`; `pnpm typecheck`; `pnpm test`
  (205 unit and 15 integration/Playwright tests passed); `pnpm build`; and
  `git diff --check 7b0c870^ 7b0c870` all passed.
- Exact verifier: `TEST_RUN_ID=e5-t02-critic-third-final-20260819
  TEST_ARTIFACT_DIR=.eforest/tasks/epic-5-the-switchboard/E5-T02-service-connection-secretref-model/evidence/e5-t02-critic-20260819-third
  make verify-E5-T02` passed at the exact head. It reported state/replay digest
  `sha256:f40a7853415af396818e3d0c25c9cf159ccae12875466ce07bf13f85da7424cb`,
  replay-view digest
  `sha256:9d70ac30cbe321f7c0f04fa2b05dde4dd9f51b97da9f7ace52e6899f819a640f`, zero
  appended events for the verifier corpus, and `leaked: false` across all 12 critic
  evidence files.
- Independent probe: `node
  .eforest/tasks/epic-5-the-switchboard/E5-T02-service-connection-secretref-model/evidence/e5-t02-critic-20260819-third/independent-probes.mjs`.
  Durable details are in
  `evidence/e5-t02-critic-20260819-third/independent-probes.json` and the exact
  verifier artifacts in the same directory.
- Finding `E5-T02-CRITIC-THIRD-001` (high): a neutral standard-base64 value under
  the safe metadata key `encodedValue` was accepted by `createConnectionStore` and
  appended as one event; the independent probe records `appendedBefore: 0`,
  `appendedAfter: 1`, and `markerPersisted: true`. The public schema rejects this
  generic base64 shape, but runtime `looksLikeCredentialValue` only rejects decoded
  base64 when the decoded text also matches a credential pattern/keyword
  (`packages/connections/src/schema.mjs:660-689`), and the store appends the
  normalized event at `packages/connections/src/store.mjs:234-277`. This refutes the
  base64/raw-value rejection requirement at the API boundary.
- Finding `E5-T02-CRITIC-THIRD-002` (high): the public JSON Schema accepts a
  provider-token-shaped `actorId` and `workspaceId` (`accepted: true` for both in
  the independent Ajv probe), because the public event properties use the
  unconstrained `identifier` definition at
  `packages/connections/src/schemas/connection-events.v1.schema.json:30-35` and
  `identifier` has no credential-shape exclusion at lines 100-103. The neighboring
  opaque-ID definition does exclude `credentialValueShape` at lines 104-107, so
  eventId, idempotencyKey, and connectionId controls reject the same shape. Runtime
  normalization rejects all four requested envelope fields, but a schema-only API
  consumer can accept the actor/workspace cases; this leaves the public event
  boundary inconsistent with the raw-material rejection contract.
- Finding `E5-T02-CRITIC-THIRD-003` (high): capture binding keys are formed by string
  concatenation as `connection.connectionId + ":" + runId`
  (`packages/connections/src/store.mjs:174-177`). With independently valid IDs
  `connection-critic-a:b` + `run-critic-c` and `connection-critic-a` +
  `b:run-critic-c`, the second capture returned the first connection/run binding
  (revision 1) rather than binding the requested connection/run tuple. This can
  cross-bind a run to the wrong connection and refutes the exactly-one committed
  revision/connection binding guarantee for the accepted opaque-ID grammar.
- Passing requested attacks: a same-run capture stayed at revision 1 across
  rotation while a new run received revision 2; existing captures remained usable
  after disable/delete; new grants returned `CONNECTION_NOT_ACTIVE`; stale rotation
  returned `CONNECTION_REVISION_CONFLICT` before terminal fencing and
  `CONNECTION_NOT_ACTIVE` after disable/delete, with no event append and a tombstone.
  Provider-token-shaped runtime eventId, actorId, idempotencyKey, and connectionId
  all returned `CONNECTION_CREDENTIAL_MATERIAL` before append. Case-variant nested
  keys/values, URLs, JSON secrets, provider-token values, labels, opaque IDs, extra
  fields, recursive arrays/objects, and the remaining secret corpus were rejected;
  duplicate/reordered replay converged to equal independent digests; foreign and
  unknown read/grant/rotate/disable/delete errors were byte-equal typed
  `CONNECTION_NOT_FOUND` with an unchanged state digest. The evidence canary probe
  detected a transient marker and found no persistent marker/provider-shape leak.
- Sensitivity: in disposable exact-head worktree
  `/tmp/slack-e5-t02-third-sensitivity.ocE1eq`, removing only the provider-token
  branch at `packages/connections/src/schema.mjs:39` made the full verifier exit 2
  at `scripts/verify-e5-t02.mjs:351` because neutral `encodedValue` was accepted.
  The command and result are recorded in
  `evidence/e5-t02-critic-20260819-third/sensitivity-mutation.json`.
- Replay: N/A (server connection model) + mitigation: cold-clone reducer replay,
  secret-shaped input corpus, authz matrix, exact lifecycle digests, independent
  envelope/schema/runtime probes, capture-race probes, and detector-sensitivity
  mutation. Status remains `refuted` pending rework and another fresh critic.

### Builder — third rework complete — 2026-08-19

- Commit: `74bc1519379258de95a90a1868774e8139cd7b40`.
- Rework: runtime base64 detection now rejects every valid base64-shaped metadata value
  before append, while a direct provider-token corpus case keeps the provider-token
  detector sensitivity control meaningful. Public `identifier` schema fields now share
  the credential-shape exclusion used by opaque ids, covering actor/workspace IDs. Run
  capture bindings now use a canonical digest of the connection/run tuple, eliminating
  delimiter collisions.
- Regression controls: the unit suite and verifier now exercise delimiter-containing IDs,
  a neutral base64 value, direct and encoded provider-token values, and the public schema
  identifier boundary.
- Commands: `pnpm format:check`; `pnpm format:check:e5-t02`; `pnpm lint`;
  `pnpm typecheck`; `pnpm test` (206 unit and 15 integration tests passed); and
  `pnpm build`.
- Local verifier: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e5-t02-final-74bc151 make
  verify-E5-T02` passed with state/replay digest
  `sha256:f40a7853415af396818e3d0c25c9cf159ccae12875466ce07bf13f85da7424cb`,
  replay view digest
  `sha256:9d70ac30cbe321f7c0f04fa2b05dde4dd9f51b97da9f7ace52e6899f819a640f`, and
  `leaked: false`.
- Evidence: `evidence/e5-t02-final/` was regenerated against this exact commit and now
  includes `capture-key-binding.json` plus the neutral-base64 corpus result.
- Replay: N/A (server connection model) + mitigation: cold-clone reducer replay,
  secret-shaped input corpus, authz matrix, exact lifecycle digests, and independent
  envelope/schema/runtime probes, capture-race probes, and detector-sensitivity mutation.
- Claim: all findings from the third critic are addressed and E5-T02 is ready for another
  fresh independent verdict.
