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
