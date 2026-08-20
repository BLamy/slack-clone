---
id: E5-T02
epic: 5
title: "Service connections and SecretRefs: replayable metadata without credential values"
priority: 502
status: refuted
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

### Builder — fourth rework complete — 2026-08-19

- Commit: `eef62d259c0a7f72b3d7cd5cfd175a8dc3bfc7f7`.
- Rework: `normalizeIdentifier` and `normalizeOpaqueId` now run the credential detector
  before accepting any identifier. This fences provider-token-shaped values used as
  principal IDs, workspace/tenant IDs, owner IDs, authorization actors, or run IDs, not
  just event metadata and opaque event IDs.
- Regression controls: the unit suite and verifier now exercise each runtime identifier
  API, verify rejection before capture/event movement, and record the typed error paths in
  `api-identifier-boundary.json`.
- Commands: `pnpm format:check`; `pnpm format:check:e5-t02`; `pnpm lint`;
  `pnpm typecheck`; `pnpm test` (207 unit and 15 integration tests passed); and
  `pnpm build`.
- Local verifier: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e5-t02-final-eef62d2 make
  verify-E5-T02` passed with state/replay digest
  `sha256:f40a7853415af396818e3d0c25c9cf159ccae12875466ce07bf13f85da7424cb`,
  replay view digest
  `sha256:9d70ac30cbe321f7c0f04fa2b05dde4dd9f51b97da9f7ace52e6899f819a640f`, and
  `leaked: false`.
- Evidence: `evidence/e5-t02-final/` was regenerated against this exact commit and now
  includes `api-identifier-boundary.json`.
- Replay: N/A (server connection model) + mitigation: cold-clone reducer replay,
  secret-shaped input corpus, authz matrix, exact lifecycle digests, independent
  envelope/schema/runtime probes, capture-race probes, and detector-sensitivity mutation.
- Claim: the fourth critic's API identifier finding is addressed and E5-T02 is ready for
  another fresh independent verdict.

### Critic — fourth independent review — 2026-08-19

- VERDICT: refuted.
- Exact head: `89a9bb08a822342cc3c2ce112b1bb15cf833c8c1`; product rework under review:
  `74bc1519379258de95a90a1868774e8139cd7b40`. The checkout was clean before the
  critic evidence directory was created.
- Commands: `pnpm install --frozen-lockfile`; `pnpm format:check`;
  `pnpm format:check:e5-t02`; `pnpm lint`; `pnpm typecheck`; `pnpm test` (206 unit and
  15 integration/Playwright tests passed); `pnpm build`; and `git diff --check HEAD^ HEAD`.
  All gates passed. The independent probe was formatted and reran successfully.
- Exact verifier: `TEST_RUN_ID=e5-t02-critic-fourth-20260819
  TEST_ARTIFACT_DIR=.eforest/tasks/epic-5-the-switchboard/E5-T02-service-connection-secretref-model/evidence/e5-t02-critic-20260819-fourth
  make verify-E5-T02` passed with state/replay digest
  `sha256:f40a7853415af396818e3d0c25c9cf159ccae12875466ce07bf13f85da7424cb` and
  replay-view digest
  `sha256:9d70ac30cbe321f7c0f04fa2b05dde4dd9f51b97da9f7ace52e6899f819a640f`.
- Independent requested attacks passed: neutral valid base64, direct and encoded
  provider-token values, public-schema actor/workspace and opaque identifiers, labels,
  nested case variants, URLs, JSON/recursive metadata, extra fields, delimiter-containing
  capture tuples, capture stability through rotate/disable/delete, duplicate/reordered
  replay, stale rotation with no append, foreign-versus-unknown typed not-found parity,
  and evidence-canary detection/cleanup. The full verifier also turned red after only
  the provider-token detector branch was removed in a detached scratch worktree; details
  are in `evidence/e5-t02-critic-20260819-fourth/sensitivity-mutation.json`.
- Finding `E5-T02-CRITIC-FOURTH-001` (high): the exported runtime API accepts a valid
  lowercase provider-token-shaped opaque identifier. Fresh input was accepted by
  `normalizeOpaqueIdForStore`, `normalizePrincipal`, `normalizeOwner`, and the store's
  authorization path; `captureForRun` accepted the same value as `runId` and returned it
  in the captured binding. The capture call did not move the event count, but it still
  crossed the API boundary with credential-shaped material. The gap is at
  `packages/connections/src/schema.mjs:190-283,720-733` and
  `packages/connections/src/store.mjs:166-219,378-393`; durable details are in
  `evidence/e5-t02-critic-20260819-fourth/critic-summary.json` and
  `independent-probes.json`.
- Evidence canary scan: transient marker detection passed and final persistent marker
  and provider-shape scans were clean. Replay: N/A (server connection model) + mitigation:
  cold-clone reducer replay, secret-shaped input corpus, authz matrix, exact lifecycle
  digests, independent schema/runtime probes, capture-race probes, and detector-sensitivity
  mutation. Status remains `refuted` pending builder rework and another fresh critic.

### Critic — fifth independent review — 2026-08-19

- VERDICT: refuted.
- Exact head: `c7ad1ceaf8b2a746e6382b1e20e06e6d6e00b467`; product rework under review:
  `eef62d259c0a7f72b3d7cd5cfd175a8dc3bfc7f7`. The target worktree was clean before
  the new critic evidence directory was created. Only metadata/evidence changes were
  made during this review.
- Commands: `pnpm install --frozen-lockfile`; `pnpm format:check`;
  `pnpm format:check:e5-t02`; `pnpm lint`; `pnpm typecheck`; `pnpm test` (207 unit and
  15 integration/Playwright tests passed); `pnpm build`; and
  `git diff --check HEAD^ HEAD`. All passed.
- Exact verifier: `TEST_RUN_ID=e5-t02-critic-fifth-final-20260819
  TEST_ARTIFACT_DIR=.eforest/tasks/epic-5-the-switchboard/E5-T02-service-connection-secretref-model/evidence/e5-t02-critic-20260819-fifth
  make verify-E5-T02` passed at the exact head with state/replay digest
  `sha256:f40a7853415af396818e3d0c25c9cf159ccae12875466ce07bf13f85da7424cb` and
  replay-view digest
  `sha256:9d70ac30cbe321f7c0f04fa2b05dde4dd9f51b97da9f7ace52e6899f819a640f`.
  The verifier corpus appended zero events, its final scan covered all 16 critic
  evidence files with `leaked: false`, and its transient canary sensitivity probe
  detected and cleaned the marker.
- Independent probe: `node
  .eforest/tasks/epic-5-the-switchboard/E5-T02-service-connection-secretref-model/evidence/e5-t02-critic-20260819-fifth/independent-probes.mjs`.
  Durable details are in `evidence/e5-t02-critic-20260819-fifth/critic-summary.json`,
  `independent-probes.json`, `gate-summary.json`, and `sensitivity-mutation.json`.
- Independent requested attacks that passed: neutral valid base64, direct and encoded
  provider-token values, event `eventId`/`actorId`/`workspaceId`/`idempotencyKey`/
  `connectionId`, runtime tenant/workspace/principal/owner/authorization/run IDs,
  SecretRef and connection labels, runtime reasons, role fields, nested case-variant
  keys and values, URLs, JSON, recursive metadata, extra fields, collision-free
  capture tuples, revision stability across rotate/disable/delete, duplicate/reordered
  replay, stale rotation with exact event-count stability, foreign-versus-unknown
  typed `CONNECTION_NOT_FOUND` parity for read/grant/rotate/disable/delete, ownership
  authorization, canary detection/cleanup, and detector sensitivity.
- Finding `E5-T02-CRITIC-FIFTH-001` (high): the exported `normalizePrincipal` API
  accepts a provider-token-shaped capability and returns it unchanged. The independent
  probe passed `capabilities: ["ghp_" + "a".repeat(32)]`; the normalized principal
  retained the raw value, and `store.create` accepted the same actor capability.
  `packages/connections/src/schema.mjs:242-283` validates capability syntax but never
  calls `assertNoCredentialMaterial` for each capability. The normalizer is public via
  `packages/connections/src/index.mjs:21-30`, and store actors reach it through
  `packages/connections/src/store.mjs:378-393`. This is a remaining API boundary that
  accepts raw provider-token-shaped material, refuting the every-boundary requirement.
- Finding `E5-T02-CRITIC-FIFTH-002` (high): the public event schema accepts both a
  provider-token-shaped terminal `reason` and a neutral valid base64 terminal `reason`.
  An independent Draft-2020-12-compatible Ajv probe accepted both cases, while the
  runtime `normalizeReason` path rejects them at `packages/connections/src/schema.mjs:438-452`.
  `packages/connections/src/schemas/connection-events.v1.schema.json:221-229` gives
  `terminalData.reason` only type, length, and printable-character constraints; it has
  no `not: {"$ref":"#/$defs/credentialValueShape"}`. A schema-only consumer can
  therefore cross the public event boundary with raw credential-shaped reason material.
  The same probe confirmed identifier/opaque-id/label/SecretRef-label, nested
  case-variant URL/JSON/recursive metadata, and extra-field schema controls reject.
- Sensitivity: in detached scratch worktree `/tmp/slack-e5-t02-fifth-sensitivity`,
  removing only `packages/connections/src/schema.mjs:39` (the provider-token detector
  branch) and running `TEST_RUN_ID=e5-t02-fifth-sensitivity
  TEST_ARTIFACT_DIR=/tmp/e5-t02-fifth-sensitivity-artifacts make verify-E5-T02` exited
  `2` at `scripts/verify-e5-t02.mjs:361`, where the provider-token corpus expected
  `CONNECTION_CREDENTIAL_MATERIAL`. Durable result: `sensitivity-mutation.json`.
- Replay: N/A (server connection model) + mitigation: cold-clone reducer replay,
  secret-shaped input corpus, authz matrix, exact lifecycle digests, independent
  envelope/schema/runtime probes, capture-race probes, canary detection, and
  detector-sensitivity mutation. Status remains `refuted` pending builder rework and
  another fresh critic.

### Builder — fifth rework complete — 2026-08-19

- Commit: `dd20209fda6f5a5314d4a0a916aa038f52806a3c`.
- Rework: principal capability values now pass through the credential detector before
  acceptance, and terminal event `reason` values in the public JSON Schema now reject
  the same credential-shaped and valid-base64 forms as metadata, labels, and identifiers.
- Regression controls: unit and verifier fixtures cover provider-token capabilities and
  the full existing secret corpus; public-schema reason validation remains independently
  exercised by the critic's Ajv probe.
- Commands: `pnpm format:check`; `pnpm format:check:e5-t02`; `pnpm lint`;
  `pnpm typecheck`; `pnpm test` (207 unit and 15 integration tests passed); and
  `pnpm build`.
- Local verifier: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e5-t02-final-dd20209 make
  verify-E5-T02` passed with state/replay digest
  `sha256:f40a7853415af396818e3d0c25c9cf159ccae12875466ce07bf13f85da7424cb`,
  replay view digest
  `sha256:9d70ac30cbe321f7c0f04fa2b05dde4dd9f51b97da9f7ace52e6899f819a640f`, and
  `leaked: false`.
- Evidence: `evidence/e5-t02-final/` was regenerated against this exact commit.
- Replay: N/A (server connection model) + mitigation: cold-clone reducer replay,
  secret-shaped input corpus, authz matrix, exact lifecycle digests, independent
  envelope/schema/runtime probes, capture-race probes, and detector-sensitivity mutation.
- Claim: the fifth critic's capability and terminal-reason findings are addressed and
  E5-T02 is ready for a final fresh independent verdict.

### Critic — sixth independent review — 2026-08-19

- VERDICT: refuted.
- Exact head: `80e8296b8ba57300eae98b8f57863d8cd87cb5eb`; reviewed product fix:
  `dd20209fda6f5a5314d4a0a916aa038f52806a3c`. The target worktree was clean before
  this critic's evidence directory was created. Only critic evidence, metadata, this
  readme entry, and the regenerated queue are in the final critic commit.
- Gates: `pnpm install --frozen-lockfile`; `pnpm format:check`;
  `pnpm format:check:e5-t02`; `pnpm lint`; `pnpm typecheck`; `pnpm test`
  (207 unit and 15 emulator/Auth0 Playwright tests passed); `pnpm build`; and the
  final E5-T02 evidence scan all passed.
- Exact verifier:
  `TEST_RUN_ID=e5-t02-critic-sixth-final-20260819
  TEST_ARTIFACT_DIR=.eforest/tasks/epic-5-the-switchboard/E5-T02-service-connection-secretref-model/evidence/e5-t02-critic-20260819-sixth
  make verify-E5-T02` passed at the exact head with state/replay digest
  `sha256:f40a785341af396818e3d0c25c9cf159ccae12875466ce07bf13f85da7424cb` and
  replay-view digest
  `sha256:9d70ac30cbe321f7c0f04fa2b05dde4dd9f51b97da9f7ace52e6899f819a640f`.
  Its final scan included the independent probe and nested cold-replay evidence,
  reported `leaked: false`, and detected the transient canary sensitivity fixture.
- Cold replay: a detached exact-head worktree at `/tmp/slack-e5-t02-sixth-cold` ran
  `pnpm install --frozen-lockfile` and the same verifier. It produced matching state and
  replay-view digests under `evidence/e5-t02-critic-20260819-sixth/cold-replay/`.
- Independent probe: `node
  evidence/e5-t02-critic-20260819-sixth/independent-probes.mjs` exercised direct
  exported runtime APIs, provider-token and neutral standard-base64 capabilities and
  reasons, case-variant and recursive inputs, extra event/SecretRef/owner fields, store
  authorization/capture, lifecycle/capture stability, duplicate/reordered replay,
  ownership and foreign-vs-unknown authz parity, and Ajv 8 Draft 2020-12 schema-only
  validation. Durable details are in
  `evidence/e5-t02-critic-20260819-sixth/independent-probes.json`.
- Finding `E5-T02-CRITIC-SIXTH-001` (high): a neutral RFC 4648 URL-safe base64 value
  (round-trip-valid, URL-safe alphabet, opaque-id-compatible spelling) bypasses
  `looksLikeCredentialValue`'s standard-base64 test at
  `packages/connections/src/schema.mjs:661-672`. The direct exported APIs accepted it
  as a principal capability, opaque id, metadata value, terminal reason, and event id.
  Store probes then accepted it through create, authorization, and capture; a capture
  echoed the value in its frozen run binding, and disable appended it as a terminal
  reason. An independent Ajv 8 Draft 2020-12 validation also accepted the same class in
  `terminalData.reason`, metadata, and `eventId`; the public schema's
  `credentialValueShape` only matches the standard `+/` alphabet at
  `packages/connections/src/schemas/connection-events.v1.schema.json:73-98` and
  `225-230`. This refutes the raw-material rejection requirement and the final
  terminal-reason schema boundary despite the provider-token and standard-base64
  controls passing.
- Detector sensitivity: the verifier's existing provider-token and URL detector
  mutations turned its corpus red; the independent URL-safe-base64 observation shows
  the missing URL-safe branch is not covered. Evidence: `evidence/e5-t02-critic-20260819-sixth/`.
- Replay: N/A (server connection model) + mitigation: cold-clone reducer replay,
  secret-shaped input corpus, authz matrix, exact lifecycle digests, independent
  runtime/schema probes, evidence leak scans, and detector sensitivity. Status remains
  `refuted` pending builder rework and another fresh critic.

### Builder — sixth rework complete — 2026-08-20

- Commit: `084019c957a42beb3c8ceee429108e19e6f0704a`.
- Rework: runtime credential detection now recognizes round-trip-valid standard and
  RFC 4648 URL-safe base64 by normalizing its alphabet and padding before decoding; the
  public `credentialValueShape` rejects the corresponding `+/_-` alphabet. The verifier
  corpus, runtime boundary fixtures, and detector-sensitivity mutation cover the newly
  closed path.
- Regression controls: unit tests reject URL-safe metadata and opaque identifiers; the
  verifier rejects URL-safe values before append/capture and proves the base64 detector
  is required; existing provider-token and standard-base64 controls remain active.
- Commands: `pnpm format:check`; `pnpm format:check:e5-t02`; `pnpm lint`;
  `pnpm typecheck`; `pnpm test` (207 unit and 15 integration tests passed); and
  `pnpm build`.
- Local verifier: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e5-t02-final-084019c make
  verify-E5-T02` passed with state/replay digest
  `sha256:f40a7853415af396818e3d0c25c9cf159ccae12875466ce07bf13f85da7424cb`,
  replay view digest
  `sha256:9d70ac30cbe321f7c0f04fa2b05dde4dd9f51b97da9f7ace52e6899f819a640f`, and
  `leaked: false`.
- Evidence: `evidence/e5-t02-final/` was regenerated against this exact commit.
- Replay: N/A (server connection model) + mitigation: cold-clone reducer replay,
  secret-shaped input corpus, authz matrix, exact lifecycle digests, independent
  envelope/schema/runtime probes, capture-race probes, and detector-sensitivity mutation.
- Claim: the sixth critic's URL-safe base64 finding is addressed and E5-T02 is ready for
  a final fresh independent verdict.

### Critic — final independent review — 2026-08-20

- VERDICT: refuted.
- Exact head: `90b3805ad806c36e109f12debad09f3fb2e420e2`; reviewed product fix:
  `084019c957a42beb3c8ceee429108e19e6f0704a`. The checkout was clean before this
  critic's evidence directory was created. No product source was changed by this
  review; the critic-owned changes are the evidence directory, this readme entry, and
  the regenerated queue metadata.
- Gates: `pnpm install --frozen-lockfile`; `pnpm format:check`;
  `pnpm format:check:e5-t02`; `pnpm lint`; `pnpm typecheck`; `pnpm test` (207 unit
  and 15 emulator/Auth0 Playwright tests passed); and `pnpm build` all passed at the
  exact head.
- Exact verifier: `TEST_RUN_ID=e5-t02-critic-final-20260820
  TEST_ARTIFACT_DIR=evidence/e5-t02-critic-20260820-final
  E5_T02_ENTRYPOINT='make verify-E5-T02 (fresh critic exact-head run)'
  make verify-E5-T02` passed. It reproduced state/replay digest
  `sha256:f40a7853415af396818e3d0c25c9cf159ccae12875466ce07bf13f85da7424cb`,
  replay-view digest
  `sha256:9d70ac30cbe321f7c0f04fa2b05dde4dd9f51b97da9f7ace52e6899f819a640f`,
  duplicate/reordered parity, base64 detector sensitivity, and final
  `leaked: false`. The complete command/result record is
  `evidence/e5-t02-critic-20260820-final/gate-summary.json`.
- Cold replay: a new detached worktree at `/tmp/slack-e5-t02-final-cold` checked out
  the exact head, ran `pnpm install --frozen-lockfile`, and passed the same verifier
  into `evidence/e5-t02-critic-20260820-final/cold-replay/` with the matching state and
  replay-view digests.
- Required URL-safe attack: the probe constructed a 24-character neutral RFC 4648
  base64url value as 22 repeated lowercase `a` characters plus `-a`, without writing
  the raw value to evidence. Runtime rejection passed for principal capabilities,
  opaque ids, metadata, reasons, terminal reasons, connection-definition metadata,
  and all `normalizeConnectionEvent` envelope identifiers. Store create,
  authorization, capture, and disable/delete terminal paths rejected it with
  `CONNECTION_CREDENTIAL_MATERIAL` and no attack-induced append. Ajv 8 Draft-2020-12
  rejected the corresponding metadata, terminal-reason, event-id, workspace-id,
  actor-id, idempotency-key, and connection-id cases. Standard base64, dynamic
  provider-shaped, padded URL-safe, underscore, mixed-alphabet, recursive, case,
  extra-field, Unicode-escaped JSON-key, and parsed `__proto__` attacks also produced
  the expected refusals. Durable details are in
  `evidence/e5-t02-critic-20260820-final/independent-probes.json` and the probe
  source in the same directory.
- Finding `E5-T02-CRITIC-FINAL-001` (high): a canonical 23-character RFC 4648
  base64url value, independently generated from neutral bytes and round-trip checked,
  passed `normalizeMetadata`, `normalizeOpaqueIdForStore`, `normalizeReason`, and
  `normalizePrincipal` capabilities. The same value passed store create metadata,
  capture run-id, and terminal disable paths; the terminal path advanced the event
  count. Ajv accepted it in metadata, terminal reason, and event id. The bypass is
  directly explained by `packages/connections/src/schema.mjs:679-690`, where
  `isBase64EncodedValue` returns false below 24 characters, and by the public
  schema's `{24,}` generic base64 shape at
  `packages/connections/src/schemas/connection-events.v1.schema.json:73-94`.
  This is a raw encoded-value boundary bypass and refutes the every-boundary
  rejection criterion despite the required 24-character case passing.
- Finding `E5-T02-CRITIC-FINAL-002` (medium): valid opaque/identifier grammar values
  that are longer than the heuristic and happen to use only the base64url alphabet
  were classified as credential material. `connection-normal-identifier-000001` and
  `run-20260820-normal-identifier` were rejected by
  `normalizeOpaqueIdForStore`; a valid long workspace identifier was rejected by
  `normalizeConnectionEvent`, and the store lifecycle create plus public schema
  `normalLongIdentifier` compatibility control failed. Short/common connection,
  SecretRef, workspace, event, and principal controls still passed. This is the
  compatibility consequence of applying the generic detector in
  `packages/connections/src/schema.mjs:722-743` and the schema-level `not` constraint
  in `packages/connections/src/schemas/connection-events.v1.schema.json:100-108`
  without distinguishing an opaque identifier from encoded credential material.
- Lifecycle/capture stability, immutable revision binding, duplicate/reordered replay,
  authz ownership and foreign/unknown not-found parity, leak scans, and detector
  sensitivity all passed independently. They do not cure the two findings above.
- Replay: N/A (server connection model) + mitigation: detached exact-head cold-clone
  replay, secret-shaped input corpus, direct runtime/store boundary probes, Ajv 8
  Draft-2020-12 validation, authz matrix, lifecycle/capture probes, recursive leak
  scan, and detector-sensitivity mutation. Status remains `refuted` pending builder
  rework and another fresh critic.

### Builder — seventh rework complete — 2026-08-20

- Commit: `4e68d2f85fcbdcf0434d5e8c7b911e2daf691ae3`.
- Rework: generic encoded-value detection now applies to credential-bearing free-form
  values (metadata, labels, reasons, and capabilities) with a canonical minimum of 22
  characters, while identifier normalizers retain explicit provider/URL/assignment
  checks without misclassifying legitimate opaque IDs. The public schema mirrors this
  split with `credentialValueShape` for free-form values and
  `identifierCredentialShape` for identifiers.
- Regression controls: unit and verifier fixtures reject canonical 23-character and
  longer URL-safe values before metadata/reason append, prove detector sensitivity, and
  preserve the ordinary long opaque identifier `connection-final-lifecycle` through
  runtime normalization and principal scope checks.
- Commands: `pnpm format:check`; `pnpm format:check:e5-t02`; `pnpm lint`;
  `pnpm typecheck`; `pnpm test` (207 unit and 15 integration tests passed); and
  `pnpm build`.
- Local verifier: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e5-t02-final-4e68d2f make
  verify-E5-T02` passed with state/replay digest
  `sha256:f40a7853415af396818e3d0c25c9cf159ccae12875466ce07bf13f85da7424cb`,
  replay view digest
  `sha256:9d70ac30cbe321f7c0f04fa2b05dde4dd9f51b97da9f7ace52e6899f819a640f`, and
  `leaked: false`.
- Evidence: `evidence/e5-t02-final/` was regenerated against this exact commit.
- Replay: N/A (server connection model) + mitigation: cold-clone reducer replay,
  secret-shaped input corpus, authz matrix, exact lifecycle digests, independent
  envelope/schema/runtime probes, capture-race probes, and detector-sensitivity mutation.
- Claim: the final critic's short URL-safe bypass and identifier false-positive findings
  are addressed and E5-T02 is ready for a final fresh independent verdict.

### Critic — seventh independent review — 2026-08-20

- VERDICT: refuted.
- Exact head: `6677c51700bde89c027492153081775bf8b171ff`; reviewed product fix:
  `4e68d2f85fcbdcf0434d5e8c7b911e2daf691ae3`. The exact-head checkout was clean
  before this review's critic evidence was created. No product source was changed;
  this review owns only the evidence directory, this readme entry, and regenerated
  queue metadata.
- Frozen install and full gates passed at the exact head: `pnpm install
  --frozen-lockfile`; `pnpm format:check`; `pnpm format:check:e5-t02`; `pnpm lint`;
  `pnpm typecheck`; `pnpm test` (207 unit and 15 integration/Playwright tests);
  `pnpm build`; and `git diff --check`. The durable command/result record is
  `evidence/e5-t02-critic-20260820-independent/gate-summary.json`.
- Exact verifier passed in the fresh critic evidence directory with run ID
  `e5-t02-critic-20260820-independent-final`, state/replay digest
  `sha256:f40a7853415af396818e3d0c25c9cf159ccae12875466ce07bf13f85da7424cb`,
  replay-view digest
  `sha256:9d70ac30cbe321f7c0f04fa2b05dde4dd9f51b97da9f7ace52e6899f819a640f`,
  duplicate/reordered replay parity, sensitivity red-state proofs, and
  `leaked: false`. Evidence: `evidence/e5-t02-critic-20260820-independent/`.
- Detached cold replay also passed from a new worktree at
  `/tmp/slack-e5-t02-independent-cold`, after its own `pnpm install
  --frozen-lockfile`, with matching state/replay/replay-view digests. Its durable
  output is `evidence/e5-t02-critic-20260820-independent/cold-replay/`.
- Independent probe: `node
  evidence/e5-t02-critic-20260820-independent/independent-probe.mjs` exited 1
  as expected because it recorded seven findings; the exact verifier then passed.
  The probe generated round-trip-valid canonical 23-character and longer URL-safe
  fixtures without storing raw fixture material. All unwrapped credential-bearing
  free-form runtime paths rejected both lengths, including metadata, labels,
  reasons, terminal data, capabilities, and connection-definition metadata. It
  also rejected provider-shaped inputs. However, one plausible boundary attack—
  surrounding the same canonical URL-safe material with whitespace—passed
  `normalizeLabel`, `normalizeReason`, and `normalizeMetadata`: label/reason
  returned trimmed values, while metadata retained the wrapped value. Store create
  accepted and persisted the wrapped metadata event, and the public schema accepted
  the wrapped label, reason, and metadata values. Durable results and redacted
  observations are in `evidence/e5-t02-critic-20260820-independent/independent-probes.json`.
- Finding `E5-T02-CRITIC-INDEPENDENT-FREEFORM-001` (high): runtime free-form
  credential detection runs before label/reason trimming and metadata preserves
  surrounding whitespace. The relevant paths are
  `packages/connections/src/schema.mjs:450-465`, `:570-578`, `:672-701`, and
  `:760-765`, with store append through
  `packages/connections/src/store.mjs:45-85` and `:237-279`. This permits a
  credential-bearing encoded value to cross the runtime free-form boundary and be
  appended to the authoritative stream, despite the unwrapped canonical 23-character
  and longer cases being rejected.
- Finding `E5-T02-CRITIC-INDEPENDENT-SCHEMA-001` (high): the public
  `credentialValueShape` generic base64 pattern is anchored to the untrimmed JSON
  string, so whitespace-wrapped encoded material is accepted in public label,
  metadata, and terminal-reason validation. The relevant schema ranges are
  `packages/connections/src/schemas/connection-events.v1.schema.json:99-124`,
  `:162-207`, and `:247-256`. This creates a runtime/public-schema policy mismatch
  at the same free-form boundary.
- Controls that passed: long ordinary opaque IDs remain accepted at runtime and in
  the public identifier schema; URL-safe opaque compatibility remains valid; explicit
  provider-token, private-key, URL, connection-string, assignment, and JSON shapes
  reject in identifier fields; event identity fields follow that identifier policy;
  recursive, case-variant, extra-field, Unicode-escaped, and parsed prototype-key
  inputs reject; lifecycle/rotation/disable/delete and capture revision binding hold;
  duplicate/reordered replay parity, authz parity, canary/leak scans, and detector
  sensitivity all pass. These controls do not cure the two free-form findings.
- Replay: N/A (server connection model) + mitigation: detached exact-head cold
  replay, full gate transcript, independent runtime/store/Ajv probes, lifecycle and
  capture checks, authz matrix, recursive adversarial corpus, leak scans, and
  detector-sensitivity mutation. Status remains `refuted` pending builder rework
  and another fresh critic.

### Builder — whitespace boundary rework — 2026-08-20

- Commit: `22fa4673d8e7b910fcc0b9da3e262f85ccbcf36a`.
- Rework: base64 and base64url classification trims only for detection, so
  surrounding whitespace cannot bypass the free-form credential boundary. Label and
  reason normalizers classify their canonical trimmed values, and the public
  `credentialValueShape` rejects the same whitespace-wrapped encoded form. The
  verifier corpus and unit tests cover whitespace-wrapped metadata, labels, and
  reasons.
- Commands: `pnpm format:check`; `pnpm format:check:e5-t02`; `pnpm lint`;
  `pnpm typecheck`; `pnpm test` (207 unit and 15 integration/Playwright tests
  passed); and `pnpm build`.
- Local verifier: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e5-t02-final-22fa467 make
  verify-E5-T02` passed with state/replay digest
  `sha256:f40a7853415af396818e3d0c25c9cf159ccae12875466ce07bf13f85da7424cb`,
  replay view digest
  `sha256:9d70ac30cbe321f7c0f04fa2b05dde4dd9f51b97da9f7ace52e6899f819a640f`,
  and `leaked: false`.
- Evidence: `evidence/e5-t02-final/` was regenerated against this exact commit;
  the updated secret corpus includes the whitespace-wrapped URL-safe case.
- Replay: N/A (server connection model) + mitigation: cold-clone reducer replay,
  secret-shaped input corpus, authz matrix, exact lifecycle digests, independent
  schema/runtime probes, capture-race probes, and detector-sensitivity mutation.
- Claim: the independent critic's whitespace findings are addressed and E5-T02 is
  ready for a fresh final critic.

### Critic — eighth independent review — 2026-08-20

- VERDICT: refuted.
- Exact head: `7f8674818c6b2e9df5b5ba0fbcbf8b1840d4f471`; reviewed product fix:
  `22fa4673d8e7b910fcc0b9da3e262f85ccbcf36a`. The checkout was clean before this
  critic evidence was created. No product source was changed; this review owns only
  `evidence/e5-t02-critic-20260820-fresh/` and this task/queue metadata.
- Frozen install and full gates passed: `pnpm install --frozen-lockfile`,
  `pnpm format:check`, `pnpm format:check:e5-t02`, `pnpm lint`, `pnpm typecheck`,
  `pnpm test` (207 unit and 15 integration/Playwright tests), and `pnpm build`.
  The durable command record is
  `evidence/e5-t02-critic-20260820-fresh/gate-summary.json`.
- Exact verifier passed in the fresh critic evidence directory with run ID
  `e5-t02-critic-20260820-fresh-final`, state/replay digest
  `sha256:f40a7853415af396818e3d0c25c9cf159ccae12875466ce07bf13f85da7424cb`,
  replay-view digest
  `sha256:9d70ac30cbe321f7c0f04fa2b05dde4dd9f51b97da9f7ace52e6899f819a640f`,
  duplicate/reordered parity, and detector-sensitivity proofs. The verifier's
  canary scan reported `leaked: false`.
- Detached cold replay passed in `/tmp/slack-e5-t02-critic-fresh-cold` at the same
  exact head after its own `pnpm install --frozen-lockfile`; the copied cold evidence
  in `evidence/e5-t02-critic-20260820-fresh/cold-replay/` matches the warm state,
  replay, and view digests. Durable checkout/command details are in
  `cold-replay/critic-cold-run.json`.
- Independent probe: `node
  evidence/e5-t02-critic-20260820-fresh/independent-probe.mjs` exited 1 as expected
  with 11 red observations. The probe generated independent round-trip-valid
  canonical 23-character and longer URL-safe fixtures and tested all required
  runtime/store/public free-form paths, whitespace wrappers, ordinary long opaque
  identifiers, explicit provider-shaped identifiers, event identity fields,
  recursive/case/extra/Unicode-escaped/parsed-prototype inputs, lifecycle/capture,
  replay parity, authorization parity, recursive leak scans, and sensitivity.
  Results are redacted and durable in
  `evidence/e5-t02-critic-20260820-fresh/independent-probes.json`.
- Finding `E5-T02-CRITIC-FRESH-ZERO-WIDTH-001` (high): inserting U+200B into a
  canonical 23-character URL-safe value made the detector return false. The value
  was accepted by runtime metadata, connection-definition metadata, reason, and
  terminal-data paths; store create appended it (`eventCount: 1`); and the public
  schema accepted it in metadata, label, and terminal reason. This is a plausible
  invisible-format-character evasion of the generic free-form encoded-value boundary.
- Finding `E5-T02-CRITIC-FRESH-SCHEMA-ESCAPED-JSON-001` (high): runtime parsing
  rejected JSON text with a Unicode-escaped credential key, but the public schema
  accepted the same shape in metadata, label, and terminal reason. The schema's
  regex-only `credentialValueShape` does not mirror the runtime JSON parsing rule.
  Root finding details and source locations are in
  `evidence/e5-t02-critic-20260820-fresh/critic-summary.json`.
- Controls that passed independently: canonical 23+ and whitespace-wrapped values
  were rejected in the tested free-form runtime/store/public paths; ordinary long
  opaque IDs remained accepted; explicit provider-token/private-key/URL/connection-
  string/assignment/JSON identifiers rejected; event identity fields followed the
  identifier policy; recursive, case-variant, extra-field, and parsed prototype-key
  attacks rejected; lifecycle/capture fencing, duplicate/reordered replay, authz
  parity, leak scans, and detector sensitivity passed. These do not cure the two
  high-severity findings.
- Replay: N/A (server connection model) + mitigation: detached exact-head cold
  replay, full gate transcript, independent runtime/store/Ajv probes, lifecycle and
  capture checks, authz matrix, recursive leak scan, and detector-sensitivity mutation.
  Status remains `refuted` pending builder rework and another fresh critic.

### Builder — hidden format and escaped JSON boundary rework — 2026-08-20

- Commit: `e0cba219821a43db91da91252f9c28d7f370f8d8`.
- Rework: credential classification now compares an NFKC-normalized candidate with
  Unicode format controls removed, catching invisible characters inserted into
  encoded values and credential-shaped JSON while preserving the identifier
  generic-base64 compatibility policy. The public schema mirrors the runtime with
  format-control-aware encoded-value and JSON-key patterns for both free-form values
  and explicit identifier credential shapes.
- Regression controls: unit and verifier fixtures cover zero-width URL-safe values
  and Unicode-escaped JSON credential keys, alongside the previous whitespace,
  canonical 23-character, and long opaque-ID cases.
- Commands: `pnpm format:check`; `pnpm format:check:e5-t02`; `pnpm lint`;
  `pnpm typecheck`; `pnpm test` (207 unit and 15 integration/Playwright tests
  passed); and `pnpm build`.
- Local verifier: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e5-t02-final-e0cba21 make
  verify-E5-T02` passed with state/replay digest
  `sha256:f40a7853415af396818e3d0c25c9cf159ccae12875466ce07bf13f85da7424cb`,
  replay view digest
  `sha256:9d70ac30cbe321f7c0f04fa2b05dde4dd9f51b97da9f7ace52e6899f819a640f`,
  and `leaked: false`.
- Evidence: `evidence/e5-t02-final/` was regenerated against this exact commit;
  the updated secret corpus includes zero-width and escaped-JSON cases.
- Replay: N/A (server connection model) + mitigation: cold-clone reducer replay,
  secret-shaped input corpus, authz matrix, exact lifecycle digests, independent
  schema/runtime probes, capture-race probes, and detector-sensitivity mutation.
- Claim: the eighth critic's hidden-format and escaped-JSON findings are addressed,
  and E5-T02 is ready for another fresh final critic.

### Critic — ninth independent review — 2026-08-20

- VERDICT: refuted.
- Exact head: `a3572bf964fda394cadeb5c50368c8426356685d`; reviewed product fix:
  `e0cba219821a43db91da91252f9c28d7f370f8d8`. The review ran the product from a
  clean detached checkout at `/tmp/slack-e5-t02-ninth-cold`. The target checkout
  later contained unrelated unowned edits in the connection schema, public schema,
  verifier, and unit test; the critic did not modify, stage, or revert them.
- Fresh critic evidence is committed only under
  `evidence/e5-t02-critic-20260820-ninth/`, with this readme entry and regenerated
  queue metadata. Product source was not changed by the critic.
- Exact-head gates: the initially clean target passed
  `pnpm install --frozen-lockfile`, `pnpm format:check`,
  `pnpm format:check:e5-t02`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (207 unit
  and 15 integration/Playwright tests), and `pnpm build` before the unrelated edits
  appeared. The detached cold checkout independently passed install, formatting,
  lint, typecheck, 207 unit tests, build, and `git diff --check`; its full
  `pnpm test` was blocked only because the pinned `emulate` submodule lacked its
  pre-existing generated `packages/emulate/dist/index.js`, and the submodule was
  intentionally not modified. See `evidence/e5-t02-critic-20260820-ninth/gate-summary.json`.
- `make verify-E5-T02` passed in the detached cold checkout with run ID
  `e5-t02-critic-20260820-ninth-cold-json-store`, state/replay digest
  `sha256:f40a7853415af396818e3d0c25c9cf159ccae12875466ce07bf13f85da7424cb`,
  replay-view digest
  `sha256:9d70ac30cbe321f7c0f04fa2b05dde4dd9f51b97da9f7ace52e6899f819a640f`,
  duplicate/reordered parity, lifecycle/capture, authorization parity, and clean
  verifier leak scan. Evidence is in `evidence/e5-t02-critic-20260820-ninth/cold-replay/`.
- The independent redacted probe intentionally exited 1 with 49 findings and zero
  probe failures. It generated canonical URL-safe values of lengths 23 and 24,
  standard base64, space/tab/NBSP wrappers, and eight Unicode format controls
  (U+200B, U+200D, U+FEFF, U+202E, U+2060, U+2066, U+180E, U+061C) across the
  required free-form paths. It also ran a 60-row Unicode-escaped/case/control JSON
  matrix across runtime, store, and public schema boundaries. Full results are in
  `evidence/e5-t02-critic-20260820-ninth/independent-probes.json`.
- Finding `E5-T02-CRITIC-NINTH-FREEFORM-ASSIGNMENT-001` (high): a
  client-secret assignment-shaped value was accepted by runtime and store in
  metadata, reasons, connection-definition metadata, and terminal data, while the
  public schema rejected it. This crosses the intended credential-bearing free-form
  policy and can append the value to the authoritative store.
- Finding `E5-T02-CRITIC-NINTH-SCHEMA-UNICODE-CF-URL-001` (high): the public
  `credentialValueShape` accepted a URL-shaped value with each tested invisible
  format control inserted into the scheme across metadata, label, reason,
  connection-definition metadata, and terminal data. Runtime and store rejected the
  same inputs, so the public/runtime policy remains inconsistent.
- Finding `E5-T02-CRITIC-NINTH-SCHEMA-DEPTH-001` (medium): the public schema
  accepted depth-9 metadata while runtime/store rejected beyond the depth limit,
  leaving a recursive resource/policy mismatch.
- Controls that passed independently: canonical 23+ and standard base64 rejection,
  whitespace-wrapper rejection, format-control insertion/wrapping rejection in
  runtime/store, Unicode-escaped JSON-key rejection in all required runtime/store/
  public free-form paths, ordinary long opaque identifiers in runtime/public schema,
  explicit provider-shaped identifiers, event identity fields, recursive/cyclic,
  case-variant, extra-field, and parsed prototype-key attacks, lifecycle/capture,
  duplicate/reordered replay, authorization parity, leak scans, and detector
  sensitivity. These do not cure the three findings.
- Replay: N/A (server connection model) + mitigation: detached exact-head cold
  replay, full gate transcript, independent runtime/store/Ajv probes, lifecycle and
  capture checks, authorization matrix, recursive adversarial corpus, leak scans,
  and detector-sensitivity mutations. Status remains `refuted` pending product rework
  and another fresh critic.

### Builder — final public-boundary rework — 2026-08-20

- Commit: `a0ec965684fd0461c684e5acce37110a9d9c3475`.
- Rework: client-secret assignment forms are rejected consistently across runtime and
  public-schema credential detectors; any Unicode format control is rejected before
  free-form credential classification; and the public metadata schema now mirrors the
  runtime's bounded nesting policy, including the maximum empty-container boundary.
  Unit and verifier controls cover the client-secret assignment and depth boundary.
- Commands: `pnpm format:check:e5-t02`; `pnpm lint`; `pnpm typecheck`; `pnpm test`
  (208 unit and 15 integration/Playwright tests passed); and `pnpm build`.
- Local verifier: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e5-t02-final-a0ec965-20260820
  make verify-E5-T02` passed duplicate/reordered replay parity with state/replay
  digest `sha256:f40a7853415af396818e3d0c25c9cf159ccae12875466ce07bf13f85da7424cb`,
  replay-view digest
  `sha256:9d70ac30cbe321f7c0f04fa2b05dde4dd9f51b97da9f7ace52e6899f819a640f`, and
  `leaked: false`.
- Evidence: `evidence/e5-t02-final/` was regenerated against this exact commit; the
  secret corpus records the client-secret assignment and metadata-depth boundary,
  and the canary scan remains clean.
- Replay: N/A (server connection model) + mitigation: cold-clone reducer replay,
  secret-shaped input corpus, authz matrix, exact lifecycle digests, independent
  schema/runtime boundary checks, and detector-sensitivity mutation.
- Claim: the ninth critic's assignment, Unicode format-control, and schema-depth
  findings are addressed. E5-T02 is implemented and ready for a fresh final critic.

### Critic — tenth independent review — 2026-08-20

- VERDICT: refuted.
- Exact head: `b2523f50d5b9f047a05fe62fcf9d1c915540dfb9`; builder product commit:
  `a0ec965684fd0461c684e5acce37110a9d9c3475`. The target checkout was clean at
  orientation. Product source and the pinned `emulate` submodule were not changed by
  the critic.
- Gates: `pnpm install --frozen-lockfile`; `pnpm format:check`;
  `pnpm format:check:e5-t02`; `pnpm lint`; `pnpm typecheck`; `pnpm test` (208 unit
  and 15 integration/Playwright tests passed); `pnpm build`; and `git diff --check`.
  All passed before critic-owned evidence was added. The gate manifest is in
  `evidence/e5-t02-critic-20260820-tenth/gate-summary.json`.
- Cold verifier: `TEST_RUN_ID=e5-t02-critic-20260820-tenth-cold2
  TEST_ARTIFACT_DIR=evidence/e5-t02-critic-20260820-tenth/cold-replay
  make verify-E5-T02` passed duplicate/reordered replay parity with state/replay
  digest `sha256:f40a7853415af396818e3d0c25c9cf159ccae12875466ce07bf13f85da7424cb`,
  replay-view digest
  `sha256:9d70ac30cbe321f7c0f04fa2b05dde4dd9f51b97da9f7ace52e6899f819a640f`, and
  `leaked: false`. Replay: N/A (server connection model) + mitigation: cold-clone
  reducer replay, secret-shaped input corpus, authz matrix, exact lifecycle digests,
  independent Ajv/runtime/store probes, Unicode-control matrix, and detector mutation.
- Independent probe: `evidence/e5-t02-critic-20260820-tenth/independent-probes.json`
  records 266 runtime/store/public-schema cases. The exact `client-secret`,
  `client_secret`, and `client secret` forms, all eight requested Unicode format
  controls inserted into URL-shaped and URL-safe/base64-shaped values, escaped and
  case-variant JSON credential keys, and the metadata nesting boundary all rejected
  consistently.
- Finding `E5-T02-CRITIC-TENTH-ASSIGNMENT-BOUNDARY-001` (high):
  `prefix-client-secret=redacted` and `prefix_client_secret=redacted` were accepted
  by `normalizeMetadata`, `normalizeReason`, `normalizeConnectionDefinition`,
  `normalizeConnectionEvent`, and `createConnectionStore`; each store case appended
  one event. The runtime assignment detector at
  `packages/connections/src/schema.mjs:40` requires a preceding boundary that does
  not include `-` or `_`, while the public `credentialValueShape` at
  `packages/connections/src/schemas/connection-events.v1.schema.json:119` rejects
  the same values. This leaves raw assignment-shaped material accepted at the
  authoritative append boundary.
- Finding `E5-T02-CRITIC-TENTH-METADATA-WIDTH-002` (medium): a 65-property safe
  metadata object was accepted and appended by runtime/store, while the public schema
  rejects `maxProperties: 64`. The runtime object loop at
  `packages/connections/src/schema.mjs:632-649` has no matching property cap;
  evidence is in `independent-probes.json:140-158`.
- Finding `E5-T02-CRITIC-TENTH-METADATA-LENGTH-003` (medium): Ajv accepts 512 astral
  Unicode code points under the public `maxLength: 512`, while runtime/store reject
  the same value because `value.length` counts 1024 UTF-16 code units at
  `packages/connections/src/schema.mjs:571-579`. Evidence is in
  `independent-probes.json:161-168` and the critic summary.
- Independent lifecycle evidence in
  `evidence/e5-t02-critic-20260820-tenth/independent-lifecycle.json` passed revision
  capture, rotate fencing, disable/delete grant fencing, tombstones, duplicate and
  reordered replay, and foreign/unknown authorization parity with new IDs and zero
  findings. Sensitivity evidence in `sensitivity.json` removed the provider-token
  detector branch in a disposable exact-head worktree; `make verify-E5-T02` exited 2
  at the event-boundary assertion, proving the detector is sensitive.
- Status remains `refuted` pending product rework and another fresh critic.
