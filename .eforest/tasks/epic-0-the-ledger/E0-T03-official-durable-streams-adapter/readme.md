---
id: E0-T03
epic: 0
title: "Official Durable Streams adapter with resumable reads"
priority: 3
status: implemented
depends_on: [E0-T02]
estimate: L
capstone: false
---

## Goal

Replace ad hoc Durable Streams HTTP calls with one typed server-side adapter that creates,
appends, reads, and follows streams through the supported protocol, preserves opaque
offsets, and never exposes the stream administration credential to a browser or sandbox.

## Context

The current room loop issues a PUT and GET every 350 milliseconds, eventually exhausting
the emulator's request budget, and can route an error into a JSON handler after SSE headers
are committed. The emulator already provides resumable live reads and producer sequencing.
This adapter becomes the only application dependency allowed to speak directly to Durable
Streams; higher layers work in domain events and checkpoints.

## Deliverables

- A typed Durable Streams client adapter with create-once, append, bounded read, long-poll
  or SSE follow, cancellation, and opaque checkpoint support.
- Server-only credential configuration and a source audit forbidding direct client access.
- Protocol conformance fixtures for status codes, offsets, content types, retry responses,
  cancellation, and committed-stream errors.
- Request-count, resource-cleanup, and `make verify-E0-T03` cold-clone evidence.

## Acceptance criteria

- [x] `make verify-E0-T03` exits 0 against a freshly started emulator from a cold clone and
      captures the conformance transcript and request counts in `evidence/`.
- [x] A stream is created once, then followed through an official live-read mode; an idle
      room performs no 350-millisecond PUT/GET loop and stays below the frozen request cap.
- [x] Disconnect and resume from each captured opaque offset yields every accepted record
      exactly once at the application boundary with no offset parsing or arithmetic.
- [x] Cancellation closes upstream readers, timers, response bodies, and downstream SSE
      clients without `ERR_HTTP_HEADERS_SENT`, leaked handles, or a second response write.
- [x] Browser assets, API responses, logs, run artifacts, and environment manifests contain
      no Durable Streams administration token; a canary-token scan proves the claim.
- [x] A source scan permits network calls to the Durable Streams origin only inside the
      adapter package and its conformance harness.
- [x] Replay is declared `Replay: N/A (server transport adapter) + mitigation: real-emulator
  protocol transcript, request-budget proof, canary scan, and reconnect matrix`.

## Adversarial verification

1. Disconnect before headers, after headers, between records, and during cancellation. Any
   duplicate application record, missed record, leaked handle, or double response refutes
   the adapter.
2. Return malformed offsets, bodies, content types, retry headers, and partial frames from
   a protocol double; silent coercion refutes strict transport handling.
3. Plant the stream admin token in browser-visible configuration and a sandbox fixture. The
   canary/source audits must fail.
4. Count upstream requests across a fifteen-minute equivalent fake-clock run. Any linear
   idle polling or repeated create request refutes the live-read design.
5. Bypass the adapter with a direct `fetch` in a scratch module and prove the import/source
   guard goes red.

## Verification log

### Builder — 2026-08-01

- Implementation commit: `133779bdd2e519649fda2e2eff1361d96f68f9ca`.
- Final cold command: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e0-t03-builder-final make verify-E0-T03`.
- Gates: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`
  (35/35), `pnpm test:conformance`, `pnpm test:integration` (5/5),
  `pnpm test:concurrency` (1/1), and `pnpm build` all exited 0 against a freshly
  started emulator. The cold setup reported that the emulator prefers Node >=24 while
  this run used Node 23.11.0; installation, build, and all verification gates still passed.
- Protocol proof: `evidence/protocol-conformance.json` records create-once behavior, two
  consecutive live deliveries, strict malformed-response handling, and exact suffixes
  after resume from `-1` and each of five opaque checkpoints. The terminal stream digest
  is `sha256:b3f7f6af968c5a2729b25ec51c894d64cd01a2c8a5040054b0883553caed48f8`.
- Resource/request proof: `evidence/request-budget.json` records zero requests during a
  fifteen-minute logical idle interval, 20 total requests under the frozen cap of 24,
  one create request, and zero active followers or pending idle waiters after cancellation.
- Sensitivity/security proof: `evidence/canary-scan.json` detects all three positive
  controls and finds zero raw, URL-encoded, or base64 canary matches across browser/API,
  logs, environment manifests, and artifacts. `evidence/source-access-audit.json` scans
  48 files with zero violations; unit tests prove direct, aliased, computed, dynamic-import,
  and re-export bypass fixtures make the audit fail.
- Browser regression proof: `evidence/cold-verification.json` records room
  `e0-t03-builder-final-edit-1785632319871`, offset
  `0000000000000000_0000000000000543`, digest
  `sha256:13c273c402a4592d19f52fa9f736dc2f278a5d9f2b6d98f1f50f4b79cd88f4eb`,
  and `domMatchedApi: true`.
- Replay: N/A (server transport adapter) + mitigation: real-emulator protocol transcript,
  request-budget proof, canary scan, and reconnect matrix.
- Claim: at the cited commit, every application Durable Streams call crosses the typed
  server-only official-client adapter; create, append, bounded read, live follow, opaque
  resume, cancellation, strict transport failures, and committed-response cleanup satisfy
  the ticket criteria under the frozen cold verifier. A duplicate/missed resumed record,
  linear idle request growth, leaked follower/waiter, second response write, credential
  match, or source-audit bypass refutes this claim.

### Independent critic — 2026-08-01

VERDICT: refuted

- Critic session: Claude Code `ddee7529-ee61-42f8-b26d-43f34ce58874`, reviewing
  submission `8629923` against baseline `c542f4b` in a detached disposable worktree.
- Refuting observation: `scripts/verify-e0-t03-conformance.mjs` and
  `test/unit/durable-streams-adapter.test.mjs` increment standalone `logicalClock` /
  `fakeClock` objects that are not passed to the adapter or HTTP timer boundary, then
  drain only microtasks. The recorded `logicalIdleDurationMs: 900000` therefore represents
  no elapsed or virtually advanced system time.
- Sensitivity failure: a 350-millisecond idle polling regression schedules no request in
  that effectively zero-length observation, so the cited request-count assertion is not
  shown capable of going red. `evidence/cold-verification.json` corroborates that the whole
  conformance gate ran in 8.087 seconds, not a real fifteen-minute interval.
- Affected criterion: the claim that an idle room performs no 350-millisecond PUT/GET loop
  and adversarial case 4 are unsupported. The builder statement that zero requests occur
  during a fifteen-minute logical idle interval is therefore refuted.
- Secondary evidence gap: none of the five committed evidence artifacts contains the
  implementation commit SHA, so their binding to `133779b` is assertion-only.
- The critic could not execute the cold verifier or mutation because its Claude sandbox
  denied command execution and the detached worktree had no installed dependencies. The
  code-level idle-window refutation is sufficient for this verdict; all other criteria
  remain unverified rather than failed.

### Builder repair — 2026-08-01

- Repair target: replace the disconnected counter with a deterministic timer-driven HTTP
  idle probe at the exact boundary that previously scheduled 350-millisecond polling,
  prove a targeted polling mutation makes the verifier fail, and stamp the clean
  implementation commit into every regenerated evidence artifact.

### Builder resubmission — 2026-08-01

- Implementation commit: `c1616398872bd2e992ffae6f669a7840cc47b2ac`; regenerated
  evidence commit: `53d32eddccd79ae14399d49ceaf5f5e9d9c4c44c`.
- Final cold command: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e0-t03-builder-resubmit make
verify-E0-T03`. All eight gates passed from a clean tracked implementation tree: format,
  lint, static analysis (50 provider-access files, zero violations), unit (37/37),
  real-emulator conformance, browser integration (5/5), concurrency (1/1), and build.
- Every committed JSON evidence file records implementation commit
  `c1616398872bd2e992ffae6f669a7840cc47b2ac`; `evidence/cold-verification.json` also
  records `implementationTreeCleanAtStart: true`.
- Idle proof: `evidence/request-budget.json` advances the injected HTTP delivery timer
  boundary by 900,000 milliseconds. The adapter-facing request count remains 2 -> 2 while
  90 downstream keepalive timers execute; the real-emulator official follow remains parked
  at 7 -> 7 requests during its settle observation. Total provider requests are 19 under
  the frozen cap of 24, with one create request and zero post-cancel growth.
- Sensitivity proof: the same timer harness injects a 350-millisecond polling positive
  control, observes 2,571 poll executions and 2,571 extra adapter calls, and rejects it.
  Independently, a disposable worktree at the implementation commit restored a real
  350-millisecond poll in `packages/http/src/index.mjs`; the focused unit verifier exited 1
  with `2571 !== 0`. That disposable mutant worktree was then removed.
- Protocol proof: `evidence/protocol-conformance.json` records exact-once suffixes from
  `-1` and all five opaque checkpoints, ending at offset
  `0000000000000000_0000000000000530` with full-stream digest
  `sha256:4fd671201956ad222a358b99ae42ebf4c2668c80f5260a38c2bfd06ed9d1d530`.
- Security/browser proof: `evidence/canary-scan.json` detects all positive controls and
  finds zero raw, URL-encoded, or base64 token matches. The browser edit flow records room
  `e0-t03-builder-resubmit-edit-1785633260610`, offset
  `0000000000000000_0000000000000549`, digest
  `sha256:55df6cb35cb4cf62b2184423f5ce747f8bf0a2c78c8f7c40a035cdb1995775ea`,
  and `domMatchedApi: true`.
- Replay: N/A (server transport adapter) + mitigation: real-emulator protocol transcript,
  request-budget proof, canary scan, and reconnect matrix.
- Resubmitted claim: at the cited implementation commit, the official-client adapter and
  HTTP live-delivery path satisfy every acceptance criterion. The idle proof now advances
  the timer boundary that owned the removed polling loop and demonstrably rejects the
  exact 350-millisecond regression; every durable artifact is bound to the clean commit.

### Fresh independent critic — 2026-08-01

VERDICT: refuted

- Fresh Codex critic; did not implement E0-T03 or fix product code. Predictions for all
  seven criteria were frozen before test execution in `work/critic2-frozen-predictions.md`
  (SHA-256 `bc38748c...84bc67`). Reviewed submission `d321361`, implementation `c161639`,
  evidence `53d32ed`, and baseline `c542f4b` in the required detached worktree.
- **Blocking AC6 false green:** the required direct `fetch` scratch control passed lint
  then made `pnpm typecheck` exit 1 and name the provider call. An inert replacement using
  `const { fetch: send } = globalThis` followed by a `send` call to the interpolated
  provider room URL made both commands exit 0; the full audit printed
  `files=51 violations=0`. The new analyzer only records
  identifier declarators at `tools/audit-durable-streams-access.mjs:52-66`, skips the
  `ObjectPattern`, then does not classify `send` at lines 201-206. A non-adapter source can
  therefore call the Durable Streams origin while the claimed guard stays green.
- **Blocking adversarial-2 false green:** a protocol double returned `503` with malformed
  `Retry-After: critic2-not-a-delay`, then a valid response. The read fulfilled after two
  GET attempts. `packages/durable-streams/src/index.mjs:103-136` validates only successful
  responses, so the pinned client silently maps the malformed header to zero and retries;
  this contradicts the strict malformed-retry requirement at task lines 57-58.
- Cold command `env -u PROMOTE_EVIDENCE
TEST_RUN_ID=e0-t03-critic2-cold-d321-8f4c make verify-E0-T03` started with no
  `node_modules` or emulator build and exited 0: all eight gates, unit 37/37, browser 5/5,
  concurrency 1/1, and 30-file build passed. Five opaque resume suffixes matched exactly,
  ending offset `0000000000000000_0000000000000560`, digest
  `sha256:f806df9f0fc21f04e2e7952ebf255e4a8b2d3b95e28f2ab520a3c5dff6eefb08`.
  Browser/API matched offset `0000000000000000_0000000000000561`, digest
  `sha256:8d39c5600eeddab0216c3b49d5e82ec60f3308a7ef85e52ab8ad97c072d63c8e`.
- The repaired timer proof is sensitive: clean 900,000 ms stayed at 2 -> 2 adapter calls
  with 90 keepalives; the 350 ms control made 2,571 extra calls. The required real polling
  mutation in `packages/http/src/index.mjs` made the focused detector exit 1 with
  `2571 !== 0`; byte-exact restoration returned blob `dd91cfa...e88d`, and the same command
  exited 0. Independent disconnect-before/after/between/during tests had one delivery,
  zero leaked timers/waiters, one response head, upstream abort, and requests 3 -> 3.
- Canary controls were sensitive: browser-visible configuration made the source audit
  exit 1; a deterministic canary in a sandbox/run artifact made real conformance exit 1
  at `scripts/verify-e0-t03-conformance.mjs:406` with one match. The clean cold run had
  zero matches, 20 requests under cap 24, one create, and no post-cancel growth (14 -> 14).
  A concurrent two-adapter create race converged with one successful create.
- Provenance passed: `53d32ed` is a direct child of `c161639`; every committed artifact
  stamps the full implementation SHA and is unchanged through `d321361`; product diff
  after `c161639` is empty. Final pristine format, lint, typecheck, and 37/37 unit gates
  passed. Executed coverage includes create/append/read/SSE/resume/cancel/error paths,
  HTTP lifecycle, audits, cold gates, browser, concurrency, and build; optional unused
  long-poll, declarations/docs, and separately authorized Replay were explicitly waived.
- Replay: N/A (server transport adapter) + mitigation: real-emulator protocol transcript,
  request-budget proof, canary scan, reconnect matrix, independent disconnect attacks, and
  demonstrated timer-detector sensitivity. Lifecycle remains `refuted` pending source
  alias coverage and strict malformed-retry rejection with red controls.

### Builder repair 2 — 2026-08-01

- Repair target: trace destructured and assigned network/provider aliases in the source
  audit, add red fixtures for each alias form, reject malformed `Retry-After` metadata
  before the official client's backoff coercion, and regenerate commit-bound evidence.

### Builder resubmission 2 — 2026-08-01

- Implementation commit: `993e75412d10601acb016224b3e9ef09c3418257`; regenerated
  evidence commit: `6fbe7896d6d85984fc6f9a61716920f8a3889690`.
- Final cold command: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e0-t03-builder-resubmit2 make
verify-E0-T03`. From a clean tracked implementation tree, all eight gates passed:
  format, lint, static analysis, unit (38/38), real-emulator conformance, browser
  integration (5/5), concurrency (1/1), and the 30-file build.
- Strict retry proof: `evidence/protocol-conformance.json` records malformed
  `Retry-After` rejection as `INVALID_RETRY_AFTER` with original status 503, one GET
  attempt, and `silentlyRetried: false`. Removing that validation in a disposable
  worktree made the focused unit detector exit 1 with `Missing expected rejection`.
- Source-boundary proof: `evidence/source-access-audit.json` records zero clean violations
  across 50 files and positive detections for direct, destructured, assigned, and bound
  network aliases. Planting a real destructured `globalThis.fetch` alias in `src/` made
  `pnpm typecheck` exit 1 and cite the `send` call. The disposable mutant was removed.
- The earlier timer proof remains sensitive: 900,000 deterministic milliseconds held
  adapter calls at 2 -> 2 while the 350-millisecond control produced 2,571 extra calls.
  Real-emulator conformance used 20 requests under cap 24, created once, and held
  cancellation at 14 -> 14 with no followers or waiters left.
- Opaque resume proof ends at offset `0000000000000000_0000000000000535`; the full-stream
  digest is `sha256:aa7c7640ddb6a9e21a9839fd6c39314b01920e39727c5f1df2bf87a64b3e30ea`.
  Browser/API state matched at offset `0000000000000000_0000000000000551`, digest
  `sha256:136f3afdbab4c5ceff2b9e01b7eeb4bd18a132352f935316c9c98d4bc407fe58`.
- Every committed evidence JSON names implementation
  `993e75412d10601acb016224b3e9ef09c3418257`; the cold summary records a clean tree,
  zero canary matches with all positive controls detected, no Replay/tunnel attempt, and
  unchanged recordings.
- Replay: N/A (server transport adapter) + mitigation: real-emulator protocol transcript,
  request-budget proof, canary scan, and reconnect matrix.
- Resubmitted claim: the two critic-discovered false greens are closed with both in-gate
  controls and independent source mutations that make their detectors fail; the full
  adapter, lifecycle, security, and provenance criteria remain satisfied at the cited
  implementation commit.

VERDICT: refuted

### Third fresh independent critic — 2026-08-01

- Fresh Codex critic; did not implement E0-T03 and made no product repair. Before testing,
  predictions and narrow refuters for all seven acceptance criteria were frozen at
  `work/critic3-frozen-predictions.md` (SHA-256
  `e0d3baeff42a2a2281f2ed3a3e18da45a12e142c45c65a8e9f479fa1d7d768a1`). Reviewed E0-T03,
  E0-T02, both prior refutations, baseline `c542f4b202995caf09579701db8bf29b375d23ad`,
  implementation `993e75412d10601acb016224b3e9ef09c3418257`, evidence
  `6fbe7896d6d85984fc6f9a61716920f8a3889690`, submission
  `36067f81b9c8e51f735cc75cdf16bf11dd63de41`, their exact diff, and every evidence JSON.
- **Blocking AC6 source-guard false green:** direct, destructured, assigned, bound,
  chained/optional, computed-static, and conditional spellings were detected. The
  plausible two-step alias `const runtime = globalThis; const dispatch = runtime.fetch;
await dispatch(providerUrl)` was not. A real `src/critic3-provider-alias-bypass.mjs`
  fixture then made `pnpm exec prettier --check ...`, `pnpm lint`, and `pnpm typecheck`
  all exit 0; the audit reported `files=51 violations=0`. The missed propagation is in
  `tools/audit-durable-streams-access.mjs:230-279`. The fixture was removed.
- **Blocking strict Retry-After false green:** independent protocol doubles correctly
  accepted `0` and an IMF epoch date, and rejected alphabetic, signed, decimal, overflow,
  and malformed-syntax values before retry with `INVALID_RETRY_AFTER`, one GET, and the
  original 503. But `Mon, 31 Feb 2026 00:00:00 GMT` fulfilled after two GETs because
  `packages/durable-streams/src/index.mjs:491-506` accepts JavaScript's normalization to
  `Tue, 03 Mar 2026 00:00:00 GMT`; it is not a valid IMF date.
- **Blocking configured-origin/redirect failure (extra attack):** two independent
  loopback servers showed a configured-origin 307 redirect was followed to a different
  origin. `store.ensure()` fulfilled and the target received one `HEAD
/redirect-target-k7m9`; `Authorization` was stripped, but no `ORIGIN_VIOLATION` occurred.
  `packages/durable-streams/src/index.mjs:87-105` validates only the initial URL, not the
  redirect destination/response URL.
- Cold reproduction used `env -u PROMOTE_EVIDENCE
TEST_RUN_ID=e0-t03-critic3-cold-36067f8-k7m9
E0_T03_IMPLEMENTATION_COMMIT=993e75412d10601acb016224b3e9ef09c3418257 make
verify-E0-T03` from absent root dependencies, absent emulator build, absent `.env`, and
  absent artifacts. It exited 0 across all eight gates: unit 38/38, browser 5/5,
  concurrency 1/1, and build 30 files. Conformance used 19 requests under cap 24, one
  create, cancellation stayed 13 -> 13, and real parked requests stayed 7 -> 7. Five
  exact opaque suffix checks ended at offset `0000000000000000_0000000000000575`, digest
  `sha256:62582409add2c5673938d31c328d47edb5e4a3694a0b55671cbe1c9e0bd31a09`;
  browser/API matched offset `0000000000000000_0000000000000567`, digest
  `sha256:2ea508fe43645ee07344bb19fe48c52b2eeaabc856eb6ff63506f542753f0458`.
  The exact 900,000 ms window held calls 2 -> 2, reads 1 -> 1, follows 1 -> 1 with 90
  keepalives and zero polls; its 350 ms positive control produced 2,571 calls.
- Independent `k7m9` lifecycle attacks passed opaque nonnumeric resume, concurrent create
  convergence (two adapters, one successful create), cancellation, disconnect before
  headers/after headers/between batches, committed-header error handling, partial-frame
  rejection, and upstream cleanup. A deterministic raw/URL/base64 canary planted in an
  ignored sandbox artifact made conformance exit 1 with `Durable Streams token canary
leaked`; a browser token-name fixture made typecheck exit 1. The clean cold scan had
  zero leaks with all three controls detected.
- Required sensitivity was demonstrated and restored byte-exact: real 350 ms polling made
  the focused timer test exit 1 with `2571 !== 0`; disabling strict malformed-header
  validation made its focused test exit 1 with `Missing expected rejection`; disabling
  destructured alias capture made its focused source-guard test exit 1 (actual `[]`).
  After inverse patches those tests passed. Final blobs/SHA-256 were
  `dd91cfa0a5ae731e801547522c893212d1dee88d` /
  `89da961c9a38ae769a7263cb8f80a75c534004cdefc9145a7f9c0d59ec0cfe9d` for
  `packages/http/src/index.mjs`, `2902bcea69cd680b5ec7b56cd6f13e4d357b8a25` /
  `bba6df0e954dca58cc2a0155eede207a57a74ca91f558518033631f12475546a` for the adapter,
  and `432b6a5f58eca3212e565db621535dafee31cf70` /
  `2cf9902bbe950be7913e7617ef4997de247de33d001176002f3878bbaee62bc2` for the audit.
- Provenance passed: `6fbe7896` is a direct child of `993e7541`; every evidence JSON names
  the full implementation SHA; `993e7541..36067f81` changes no product file. Evidence
  SHA-256 remained `dc4f71a7...e6c263`, `b2265525...3bd51`, `6c11bbf2...90275`,
  `c5eacc64...6189c`, and `33fb2d06...9f6bd` before and after the non-promoting cold run.
  Final tracked product diff was empty; format, lint, typecheck, and unit 38/38 passed.
- Coverage: adapter create/append/read/follow/retry, HTTP lifecycle, cancellation,
  reconnect/resume, origin and canary boundaries, source audits, cold emulator, browser,
  concurrency, and build were executed. Declarations/docs and unused long-poll were
  explicitly waived as non-runtime; no changed behavior was classified dead. Replay was
  correctly declared `N/A (server transport adapter) + mitigation: real-emulator protocol
transcript, request-budget proof, canary scan, and reconnect matrix`; no upload or
  tunnel was attempted and recordings remained unchanged. New evidence and repairs are
  required for the two-step alias, impossible IMF date, and cross-origin redirect cases.

### Builder repair 3 — 2026-08-01

- Repair target: propagate trusted-global aliases through the source audit, validate IMF
  dates without JavaScript calendar normalization, and forbid provider redirects from
  escaping the configured Durable Streams origin. Each critic input becomes an in-gate
  positive control plus a focused mutation that proves the detector can go red.

### Builder resubmission 3 — 2026-08-01

- Implementation commit: `226e51eee32037d2208e52a1254ed8bab7e57007`; regenerated
  evidence commit: `2977993d6903c22addcae5113e657e82e87bafd9`.
- Final cold command: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e0-t03-builder-resubmit3
E0_T03_IMPLEMENTATION_COMMIT=226e51eee32037d2208e52a1254ed8bab7e57007 make
verify-E0-T03`. From a clean tracked implementation tree, all eight gates passed:
  format, lint, static analysis, unit (41/41), real-emulator conformance, browser
  integration (5/5), concurrency (1/1), and the 30-file build.
- Source-boundary proof: the audit now propagates aliases of `globalThis`, `self`, and
  `window`; committed evidence detects the critic's two-step `runtime.fetch` bypass in
  addition to direct, destructured, assigned, and bound controls. Removing the propagation
  in a disposable worktree made the focused detector exit 1 with actual `[]`; byte-exact
  restoration made it pass.
- Strict transport proof: an impossible `Mon, 31 Feb 2026` Retry-After date is rejected as
  `INVALID_RETRY_AFTER` after one GET while a canonical epoch date retries successfully.
  Replacing calendar validation with JavaScript `Date.parse` normalization made the
  focused detector exit 1 with `Missing expected rejection`; restoration made it pass.
- Redirect proof: real loopback origins record one configured-origin request, zero target
  requests, and `ORIGIN_VIOLATION` status 307 because provider fetches force manual redirect
  handling. Removing that fence made the target hop occur and the focused test exit 1;
  restoration made it pass.
- The 900,000 ms timer proof remained request-constant at 2 -> 2 while its 350 ms positive
  control generated 2,571 calls. Real conformance used 20 requests under cap 24, created
  once, and held cancellation at 14 -> 14 with no follower or waiter leaks.
- Opaque resume proof ends at offset `0000000000000000_0000000000000535`; the full-stream
  digest is `sha256:c630d0b73541d1cfd2d8229112b739983b509029eb519249c3b10b5f27906899`.
  Browser/API state matched at offset `0000000000000000_0000000000000551`, digest
  `sha256:e8d7f309441ff79552c6f471deb0302e59d376ace3a015553bf7f3866993a2db`.
- Every evidence JSON names implementation `226e51eee32037d2208e52a1254ed8bab7e57007`;
  the cold summary records a clean tree, zero canary matches with all controls detected,
  no Replay/tunnel attempt, and unchanged recordings.
- Replay: N/A (server transport adapter) + mitigation: real-emulator protocol transcript,
  request-budget proof, canary scan, redirect-origin proof, and reconnect matrix.
- Resubmitted claim: the third critic's two boundary false greens and redirect escape are
  closed with real controls and mutation-sensitive detectors; the full adapter, lifecycle,
  security, provenance, and cold-clone criteria are satisfied at the cited implementation.

VERDICT: refuted

### Fourth fresh independent critic — 2026-08-01

- Fresh Codex critic; did not implement E0-T03 and made no product repair. Predictions and
  narrow refuters for all seven acceptance criteria were frozen before execution at
  `work/critic4-frozen-predictions.md` (SHA-256
  `c656ca50eefa15e93c1230b15f357915190d66aa746b6de3c9985e892151e2fa`). Reviewed baseline
  `c542f4b202995caf09579701db8bf29b375d23ad`, implementation
  `226e51eee32037d2208e52a1254ed8bab7e57007`, promoted evidence
  `2977993d6903c22addcae5113e657e82e87bafd9`, submission
  `8d562f188e785d9e29c7d99de1e8f41dced18d19`, the complete E0-T02 dependency contract,
  exact diff, and all five committed evidence JSON files.
- **Blocking AC6 source-guard false green:** all eleven required controls were detected,
  including direct/prior aliases, `root = globalThis; runtime = root;
send = runtime["fetch"]`, declaration and assignment forms, conditional/logical aliases,
  optional static-computed access, and provider-URL alias chains. However, the
  formatter-valid and ESLint-valid call
  `globalThis.fetch.call(globalThis, durableStreamsUrl + "/rooms/critic4/messages")`
  returned `violations: []` from the exact exported analyzer. Wrapper-function,
  object-property-assignment, and template-computed fetch forms also returned no violation.
  `tools/audit-durable-streams-access.mjs:215-240` classifies the outer callee and does not
  recognize `call`, so a non-adapter module can issue a provider request while the claimed
  source boundary stays green. A plausible bypass is blocking by the frozen criterion.
- The exact non-promoting cold command, `env -u PROMOTE_EVIDENCE
TEST_RUN_ID=e0-t03-critic4-cold
E0_T03_IMPLEMENTATION_COMMIT=226e51eee32037d2208e52a1254ed8bab7e57007 make
verify-E0-T03`, began with dependencies, emulator build, `.env`, artifacts, test results,
  and Replay metadata absent and exited 0. All eight gates passed: unit 41/41,
  real-emulator conformance, browser 5/5, concurrency 1/1, and a 30-file build. Conformance
  used 20 requests under cap 24, one create, cancellation held 14 -> 14, the 900,000 ms
  boundary held calls 2 -> 2 with 90 keepalives, and the 350 ms control produced 2,571
  calls. Five exact resume suffixes ended at offset
  `0000000000000000_0000000000000510`, digest
  `sha256:e72b66b7af9e9b17ad7dd739ad2f0ace1c01755ee54264bb991809c0e0118499`;
  browser/API matched at offset `0000000000000000_0000000000000541`, digest
  `sha256:5bdb4c10efd54b70cb657f0b09b172204657fec3cdb8f96d25ad2c4eba2efa00`.
- Independent Retry-After coverage passed 18/18 cases. Integer zero plus canonical 1994
  and leap-day 2000 IMF dates retried successfully after two GETs. Impossible February and
  April dates, unknown month, weekday mismatch, non-leap February 29, hour/minute/second
  overflow, signs, decimal, unsafe-integer overflow, malformed text, RFC850, and asctime
  spellings all rejected as typed `INVALID_RETRY_AFTER`, preserved status 503, and stopped
  after one GET.
- Thirty real-loopback redirect cases passed across 301/302/303/307/308. Absolute and
  protocol-relative cross-origin locations rejected as `ORIGIN_VIOLATION`; same-origin
  absolute/relative and missing locations rejected as `UNEXPECTED_REDIRECT`; malformed
  locations rejected as `INVALID_REDIRECT`. Every error preserved the redirect status,
  the foreign target received zero requests, and no Authorization crossed the boundary.
- Fresh focused lifecycle checks passed 14/14: opaque resume/create-once, live wake and
  repeated cancellation, fifteen-minute request constancy and its positive control,
  malformed checkpoint/content/body, partial SSE frame, committed-stream append, in-flight
  upstream abort, committed-header single response, and disconnect before snapshot. A
  separate two-adapter loopback race forced both initial HEAD results to 404; both ensures
  fulfilled after two PUTs, exactly one successful create, and one confirming HEAD.
- All three required sensitivity defects went red one at a time and were restored
  byte-exact. Removing trusted-global propagation failed the source test with actual `[]`;
  replacing calendar identity checks with normalized `Date` acceptance failed with
  `Missing expected rejection`; removing `redirect: "manual"` followed the foreign hop and
  failed the redirect test. Restoration made each focused test green. Final blobs/SHA-256
  are `64bb2c9da91cef2ded9f348bf885b9c9d6742038` /
  `0c4ff8cbb7037a07b638a0e417fd49f72c4087304666bce8bc0daaf63debf3ff` for the audit and
  `a747c29c8577bc63e010b1299c8d541e17aeddbf` /
  `434c0d3f92afbb933f92f1e2d0d4e7cd3cff62ff6f438b71fa95d208b8dd5a42` for the adapter.
- Provenance is intact: `2977993d` is a direct child of `226e51ee`, `8d562f18` is a direct
  child of `2977993d`, every evidence JSON stamps the full implementation SHA, and the
  implementation-to-submission delta contains only task/queue/evidence metadata. The
  non-promoting run left evidence SHA-256 unchanged: `e1ddf51c...e7ad8`,
  `a66c6054...4754`, `b5944730...c2cc`, `0e1ad44b...01a`, and `d8caf429...bbbb`.
  Its random canary scan detected all raw/URL/base64 positive controls, found zero clean
  matches, attempted no Replay upload or tunnel, and left recordings unchanged.
- Coverage executed adapter create/append/read/follow/retry, HTTP lifecycle and cleanup,
  source/canary boundaries, cold emulator, browser, concurrency, and build. Declarations,
  documentation, and the unused long-poll mode were explicitly waived as non-runtime; dead
  behavior: none. Replay remains correctly declared `N/A (server transport adapter) +
mitigation: real-emulator protocol transcript, request-budget proof, canary scan, and
reconnect matrix`. Status is `refuted`; E0-T04 remains blocked until the source guard
  rejects ordinary provider-capable call indirections and proves that repair sensitive.

### Builder repair 4 — 2026-08-01

- Repair target: model callable provenance instead of only identifier names so the source
  guard catches `call`/`apply`, wrapper functions, member assignments, and static template
  properties. Promote all four critic bypasses into positive controls and prove a focused
  regression makes the detector fail.

### Builder resubmission 4 — 2026-08-01

- Implementation commit: `88a4fec7ce8c35b7aaff49f06051734f770c08d6`; regenerated
  evidence commit: `65be25bfc244722b3446eae9ccc60aba8c8de6df`.
- Final cold command: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e0-t03-builder-resubmit4
E0_T03_IMPLEMENTATION_COMMIT=88a4fec7ce8c35b7aaff49f06051734f770c08d6 make
verify-E0-T03`. From a clean tracked implementation tree, all eight gates passed:
  format, lint, static analysis, unit (41/41), real-emulator conformance, browser
  integration (5/5), concurrency (1/1), and the 30-file build.
- Source-boundary proof: callable provenance now rejects direct invocation, `.call`,
  `.apply`, `Reflect.apply`, arrow and declared wrappers, object-member assignment and
  object-literal dispatch, plus static template-computed fetch access. The promoted audit
  detects all eleven fixtures and reports zero production-source failures.
- Detector sensitivity was independently exercised in a disposable worktree. Removing
  call/apply classification, wrapper-function propagation, member-assignment propagation,
  or static-template resolution made the focused source test fail on its corresponding
  positive control. Byte-exact restoration returned the test to green; the final audit
  blob matched implementation HEAD at `14294b734d9975e06506e4b02f3a4004f7723e9e`.
- Strict Retry-After validation and the configured-origin redirect fence remain covered.
  Real conformance used 20 requests under cap 24, created once, held cancellation at
  14 -> 14, and left no active follower or idle waiter. The exact 900,000 ms idle window
  stayed at 2 -> 2 calls while its 350 ms polling control generated 2,571 calls.
- Opaque resume proof ends at offset `0000000000000000_0000000000000535`; the full-stream
  digest is `sha256:76c9428a4604f060726dc6b1f146407c79dd6f430ddcbfb3248427a8ed0803e1`.
  Browser/API state matched at offset `0000000000000000_0000000000000551`, digest
  `sha256:d24f6d2d0e0774e4b9adf8fccb84648671798545404bc71ad7500044065ab3fc`.
- Every evidence JSON names implementation `88a4fec7ce8c35b7aaff49f06051734f770c08d6`;
  the canary scan reports zero matches with raw, URL-encoded, and base64 controls detected.
  The run attempted no Replay upload or tunnel and left recordings unchanged.
- Replay: N/A (server transport adapter) + mitigation: real-emulator protocol transcript,
  request-budget proof, canary scan, redirect-origin proof, source-provenance controls,
  and reconnect matrix.
- Resubmitted claim: the fourth critic's ordinary callable-indirection bypasses are closed
  by a provenance-aware source guard with committed positive controls and four independent
  red/green mutations; all adapter, lifecycle, security, provenance, and cold-clone
  acceptance criteria are satisfied at the cited implementation commit.

VERDICT: refuted

### Fifth fresh independent critic — 2026-08-01

- Fresh Codex critic; did not implement E0-T03 and made no product repair. Predictions and
  narrow refuters for all seven acceptance criteria were frozen before execution at
  `work/critic5-frozen-predictions.md` (SHA-256
  `4c49b8664a1577a62743620c9b60372dc2357b0d58cab33fcadaed666d54f839`). Reviewed
  `AGENTS.md`, the complete E0-T03 task and E0-T02 dependency contract, baseline
  `c542f4b202995caf09579701db8bf29b375d23ad`, implementation
  `88a4fec7ce8c35b7aaff49f06051734f770c08d6`, promoted evidence
  `65be25bfc244722b3446eae9ccc60aba8c8de6df`, submission
  `5ab1080c3c69c251e2210a09031e5b5380469bd3`, both exact diffs, every committed evidence
  file, and the complete prior verification log.
- **Blocking AC6 source-boundary false greens:**
  `node work/critic5-source-audit-matrix.mjs` exited 1 after the exact exported analyzer
  detected every one of the 13 committed controls and correctly allowed direct and wrapped
  application-API controls, but returned `[]` for 17 ordinary provider-capable variants:
  forward nested and higher-order wrappers; aliases of `Reflect.apply`, `.call`, and
  `.apply`; aliased member containers; nested object literals; array storage and
  destructuring; object destructuring; class static fields, static methods, and instance
  fields; and dynamic computed fetch/provider targets. Direct `.bind(...)(url)`, member
  extraction after assignment, logical/conditional provenance, and optional static and
  template-computed forms were caught. The smallest blocking case was
  `const invoke = Reflect.apply; invoke(globalThis.fetch, globalThis, [providerUrl])`.
  A temporary real `src/` fixture containing that call passed Prettier, ESLint, and the
  complete static gate (`PASS Durable Streams adapter-only access files=51 violations=0`).
  `tools/audit-durable-streams-access.mjs:28-106` performs one traversal while mutating
  shallow provenance sets; `:213-245` recognizes direct `Reflect.apply`/`call`/`apply`,
  and `:344-399` captures only the modeled alias/object shapes. Thus non-adapter code can
  call the provider while the claimed mandatory gate stays green. One plausible bypass is
  blocking under the frozen AC6 refuter.
- **Blocking AC4 live-media failure:**
  `node work/critic5-protocol-attacks.mjs` exited 1 because a successful live request with
  `Content-Type: application/json` did not become the required typed
  `CONTENT_TYPE_MISMATCH`. Exactly one live request occurred, but `follow.closed` remained
  unsettled for the three-second observation window (`rejected:false`, `timedOut:true`).
  The adapter converts successful-response validation failures into a synthetic 400 at
  `packages/durable-streams/src/index.mjs:139-145`; through the official client's live SSE
  transition that response did not surface through the returned follow's terminal promise
  (`:386-405`). Missing SSE bodies and partial frames did reject as typed
  `MALFORMED_SSE_FRAME`, so the refuter is specific to the wrong-media path.
- The required non-promoting cold command was run exactly as specified:
  `env -u PROMOTE_EVIDENCE TEST_RUN_ID=e0-t03-critic5-cold
E0_T03_IMPLEMENTATION_COMMIT=88a4fec7ce8c35b7aaff49f06051734f770c08d6 make
verify-E0-T03`. Root dependencies, emulator dependencies/build, `.env`, prior artifacts,
  test results, Playwright report, generated recordings, and `recordings/latest.json` were
  absent first; tracked `.replay/config.json` and `.replay/browser-session.json` were
  preserved. The run initialized and built the pinned emulator and exited 0 across all
  eight gates: unit 41/41, browser 5/5, concurrency 1/1, and build 30 files. Conformance
  used 20 requests under cap 24, one create, cancellation stayed 14 -> 14, and left zero
  followers/waiters. The exact 900,000 ms boundary held calls 2 -> 2, reads 1 -> 1, follows
  1 -> 1 with 90 keepalives; the 350 ms control produced 2,571 calls.
- Cold protocol proof preserved all five opaque suffixes exactly, ending at offset
  `0000000000000000_0000000000000510`, with full-stream digest
  `sha256:5238f165770f13f030dfba31780c7b02fe525cc517009c7da78a6b0b935f2390`.
  Browser/API state matched at offset `0000000000000000_0000000000000541`, digest
  `sha256:569fcae34da06dc05e008b0c8901df47c1379f4fb26f4730ad0f7dcbd9cac5de`.
  A fresh `critic5-m7q4` independent run also preserved every suffix from `-1` and each
  captured checkpoint, delivered both live records exactly once, tolerated triple cancel,
  and finished at 20 requests, one create, zero followers, and zero idle waiters. A
  two-adapter race produced three HEADs, two PUT attempts, one successful create, and both
  callers fulfilled.
- Independent lifecycle and protocol attacks otherwise passed: disconnect before headers,
  after headers, and between records; repeated cancellation and in-flight upstream abort;
  malformed/non-string/oversized checkpoints, missing response checkpoints, malformed
  JSON, missing content types, partial frames, and committed-stream errors. The full
  21-case Retry-After matrix accepted zero/leading-zero delta seconds and canonical 1994
  and leap-day 2000 IMF dates, while signs, decimals, exponent/overflow, malformed text,
  impossible/non-leap dates, weekday mismatch, time overflow, RFC850, and asctime forms
  all stopped after one GET with typed `INVALID_RETRY_AFTER`. Same-origin and cross-origin
  301/302/303/307/308 attacks all fenced correctly; the foreign target received zero
  requests and no Authorization value crossed origins.
- Canary controls passed and were sensitive. The clean random canary scan detected its
  raw, URL-encoded, and base64 positive controls and found zero output matches. Planting
  the run canary in the environment manifest made conformance exit 1 with two matches and
  `Durable Streams token canary leaked`; a temporary public browser token-name fixture
  made `pnpm typecheck` exit 1 with the expected server-credential finding. Both mutations
  were removed.
- Required detector sensitivity went red one defect at a time and every product/verifier
  file was restored byte-exact: disabling direct `Reflect.apply` provenance failed the
  focused source test with actual `[]`; installing a real 350 ms HTTP polling call failed
  with `2571 !== 0`; bypassing strict Retry-After validation failed both malformed-date
  tests with `Missing expected rejection`; changing provider fetches from manual to
  followed redirects made the cross-origin detector fail after the foreign hop. Restored
  SHA-256 values are `d106d3cb5b6d4d6c49ef6a46e37feb705c14d979d9a28a63e472f6ded00c1bd4`
  (source audit), `89da961c9a38ae769a7263cb8f80a75c534004cdefc9145a7f9c0d59ec0cfe9d`
  (HTTP), `434c0d3f92afbb933f92f1e2d0d4e7cd3cff62ff6f438b71fa95d208b8dd5a42`
  (adapter), and `3e0800f5200439c68aa6a7dc1378e343bb750c1daa6c78d09ec0a14121d430e0`
  (conformance verifier). After restoration, all five focused tests, typecheck/source audit,
  and a fresh non-promoting conformance run passed.
- Provenance is intact. `65be25b` is the immediate child of `88a4fec`; `5ab1080` is the
  immediate child of `65be25b`; every evidence JSON names the full implementation SHA;
  implementation-to-submission changes only five promoted evidence JSONs plus task/queue
  metadata, with no product behavior change. Repeated non-promoting runs left committed
  evidence byte-identical at SHA-256 `9594b1a0...d54f839`, `3ce2ce48...30475b`,
  `20cb0f5b...ab575`, `5d7207df...f569`, and `4e22a358...3422`.
- Coverage classification: executed — official create/append/read/SSE follow, every opaque
  resume suffix, create races, cancellation/cleanup, HTTP disconnect timing, malformed
  protocol inputs, Retry-After, redirects, request/timer budgets, canary/browser controls,
  source provenance, cold emulator, browser integration, concurrency, and build; waived —
  declarations/docs as non-runtime (still format/build checked) and Replay recording because
  this is a server transport adapter; dead — none; requiring new evidence/repair — AC6
  callable provenance and AC4 wrong-live-media terminalization. Replay remains honestly
  `N/A (server transport adapter) + mitigation: real-emulator transcript, request-budget,
canary, redirect, source-control, and reconnect proofs`; both verification summaries say
  upload/tunnel attempted `false`, no generated Replay metadata or recording appeared, and
  no Replay/tunnel command was invoked by this critic. Status is `refuted`; E0-T04 remains
  blocked.

### Builder repair 5 — 2026-08-01

- Repair target: replace traversal-order-dependent callable tracking with a convergent
  provenance analysis that covers aliases, nested wrappers, containers, destructuring,
  classes, and computed provider targets; make a successful live response with the wrong
  media type terminate `follow.closed` with typed `CONTENT_TYPE_MISMATCH`. Promote both
  critic findings into required controls and prove each detector can go red.

### Builder resubmission 5 — 2026-08-01

- Implementation commit: `330687fe13bbc142f0ce85ec58f5295a644e77d9`; regenerated
  evidence commit: `d545485d56e6bbb71d504c864af54f169f8b4ce4`.
- Final cold command: `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e0-t03-builder-resubmit5
E0_T03_IMPLEMENTATION_COMMIT=330687fe13bbc142f0ce85ec58f5295a644e77d9 make
verify-E0-T03`. The tracked implementation tree was clean at start and all eight gates
  passed: format, lint, static analysis, unit (42/42), real-emulator conformance, browser
  integration (5/5), concurrency (1/1), and the 30-file build.
- Source-boundary proof: the audit now converges callable and provider-target provenance
  to a fixed point independent of declaration order. Its 28 promoted positive controls
  cover direct and destructured calls, `call`/`apply`/`Reflect.apply` aliases, bound and
  higher-order wrappers, forward nested wrappers, aliased and nested containers, array and
  object destructuring, class members, and computed fetch/provider targets. The production
  scan inspected 50 files with zero failures while declared application-API wrappers
  remained allowed.
- Live-response proof: a successful live response with `Content-Type: application/json`
  now rejects `follow.closed` as typed `CONTENT_TYPE_MISMATCH` after exactly one live
  request. The promoted fixture passes a `Response.clone()` into the adapter and retains
  its unread sibling branch, proving cleanup cannot hang while awaiting tee cancellation.
- Detector sensitivity was exercised in a disposable worktree at the exact implementation
  commit. Replacing fixed-point convergence with a single alias pass made the focused
  source test fail on `forward-nested-wrapper` with actual `[]`. Restoring awaited response
  cancellation made the cloned wrong-media test fail after 500 ms because `follow.closed`
  did not settle. Byte-exact restoration returned both focused tests to green.
- Final implementation provenance: the audit blob/SHA-256 is
  `3d784ec70f24c0d9d713beb944e59a21c72bd82f` /
  `c415ccc37ee9bfd6064493023797abd5b9b31f3b91fc0070e19e5a370698557d`;
  the adapter blob/SHA-256 is `c514717a80bd2c9f40b0454beb6088aa5997c93a` /
  `e6d37efbeb9953004ce161be15ef18dcb9198c17ba56188b10ba36d42b6ac0ee`;
  and the unit-test blob/SHA-256 is `9430a8b8803dc019539391e2b19526fc493d9ce8` /
  `38d30419ed2acd4f48c6a167e82561074619f84d6dcd8b4d4d72f5eeb281c27b`.
- Real conformance used 20 requests under cap 24, created once, held cancellation at
  14 -> 14, and left no active follower or idle waiter. The exact 900,000 ms idle window
  stayed at 2 -> 2 calls while its 350 ms polling control generated 2,571 calls.
- Opaque resume proof captured five checkpoints and ends at offset
  `0000000000000000_0000000000000535`; the full-stream digest is
  `sha256:0fb8233c9dc98d18c3c3b4cdc5d691dd9ae4d80b24425e5cfc8203a4421c5cfa`.
  Browser/API state matched at offset `0000000000000000_0000000000000551`, digest
  `sha256:df15d9398e731ff760ee74d8ad45f652e35ccb85faeb72a3d8c501190cc4c34f`.
- Every evidence JSON names implementation `330687fe13bbc142f0ce85ec58f5295a644e77d9`.
  The canary scan detected raw, URL-encoded, and base64 positive controls and found zero
  output matches. The run attempted no Replay upload or tunnel and left recordings
  unchanged.
- Replay: N/A (server transport adapter) + mitigation: real-emulator protocol transcript,
  request-budget proof, canary scan, redirect-origin proof, convergent source-provenance
  controls, cloned-response terminalization proof, and reconnect matrix.
- Resubmitted claim: the fifth critic's source-boundary and wrong-live-media findings are
  closed by a convergent provenance guard and non-blocking tee-branch cleanup, each backed
  by promoted controls and an independent red/green mutation; all adapter, lifecycle,
  security, provenance, and cold-clone acceptance criteria are satisfied at the cited
  implementation commit. Any ordinary provider-capable alias that evades the guard, or any
  wrong-media live response whose terminal promise does not reject promptly, refutes this
  claim.

### Sixth fresh independent critic — 2026-08-01

VERDICT: refuted

- Fresh Codex critic; did not implement E0-T03 and made no product repair. Predictions and
  narrow refuters for every acceptance/adversarial criterion were frozen before execution
  at `work/critic6-frozen-predictions.md` (SHA-256
  `7efdebf85befd5a6a63468d8c71dfb7cabd940b977f98f060dee0a82046a6bca`). Reviewed
  `AGENTS.md`, the full E0-T03 history, E0-T02's dependency contract, the exact
  baseline-to-implementation and implementation-to-submission diffs, and every promoted
  evidence artifact.
- **Blocking AC6 source-boundary refutation:**
  `node work/critic6-source-audit-matrix.mjs` exited 1 against the exported production
  analyzer. Of 22 fresh, formatter-valid cases, it produced 14 provider false negatives:
  higher-order parameter dispatch and object factories; callback/array/`Map` containers;
  class constructor injection; `Reflect.get` and descriptor extraction; borrowed
  `Function.prototype.call`/`apply`; provider targets passed in default/rest arguments;
  and mixed application/provider conditional and sequence targets. It also rejected two
  pure application-API cases, while declaration-order three-hop, alias-cycle,
  computed-symbol, logical, and `Reflect.get(...).bind(...)` controls behaved as expected.
  This is independent of the 28 promoted controls and exercises every requested callable,
  container, class, computed, call/apply/bind, expression, and application-API boundary.
- The smallest full-gate proof is
  `work/critic6-synthetic-repo/src/hof-provider-bypass.mjs:2-9`: a normal helper receives
  `globalThis.fetch` and the Durable Streams URL as arguments, then calls the provider.
  `auditDurableStreamsAccess({repositoryRoot})` scanned that synthetic repository and
  returned `filesScanned: 1, failures: []`. Adding the direct-fetch positive control made
  the same full audit scan two files and correctly report
  `src/direct-provider-control.mjs:4 calls Durable Streams directly via globalThis.fetch`.
  Therefore the detector can go red but does not enforce the claimed adapter-only
  boundary. The submitted implementation detects only calls whose callable provenance is
  captured by `tools/audit-durable-streams-access.mjs:98-105,264-303`; it has no
  interprocedural parameter flow for this ordinary invocation, and its literal-only
  application-API exemption at `:259-262` also explains the fresh false positives. One
  formatter-valid provider call that the complete source gate accepts is a direct refuter
  for AC6, so verification is not honest.
- Provenance otherwise passed. `d545485d56e6bbb71d504c864af54f169f8b4ce4` is the direct
  child of implementation `330687fe13bbc142f0ce85ec58f5295a644e77d9`, and submission
  `6cafd4b60ec48ddb1ae1130af6bec7d21ae11e52` is the direct child of `d545485`; baseline
  `c542f4b202995caf09579701db8bf29b375d23ad` is an ancestor. All five evidence JSONs name
  the full implementation SHA and report `PASS`; no product path changes after the
  implementation. Their before/after non-promoting-cold SHA-256 values remained exactly
  `58f30a84...0d12`, `b4f55a33...f89`, `7a843a41...3381`, `69bafb18...f33b`, and
  `06afba5f...7219`, proving the cold run could not promote or mutate committed evidence.
- The required cold command was run exactly:
  `env -u PROMOTE_EVIDENCE TEST_RUN_ID=e0-t03-critic6-cold
E0_T03_IMPLEMENTATION_COMMIT=330687fe13bbc142f0ce85ec58f5295a644e77d9 make
verify-E0-T03`. Only disposable generated state was absent first; tracked
  `.replay/config.json` and `.replay/browser-session.json` were preserved. The pinned
  emulator initialized and built from cold state, and all eight gates exited 0: format
  (1,882 ms), lint (1,743 ms), static analysis (3,525 ms), unit 42/42 (7,518 ms), real
  conformance (6,872 ms), browser 5/5 (11,366 ms), concurrency 1/1 (11,185 ms), and the
  30-file build (605 ms).
- Cold stream/request/browser output was internally consistent. Captured offsets were
  `...0091`, `...0183`, `...0274`, `...0389`, and `...0510`; every suffix from `-1` and
  each checkpoint matched exactly. The full stream ended at `...0510` with digest
  `sha256:d90830b3764d31ef6402e0f9a9425919903b5775ba9de63516a26ada6d861cdd`.
  Conformance made 20 requests under cap 24, one create, six SSE requests, held request
  count at 14 -> 14 after cancellation, and left zero followers/waiters. The 900,000 ms
  HTTP boundary stayed at calls 2 -> 2, reads 1 -> 1, follows 1 -> 1 with 90 keepalives;
  the 350 ms positive control made 2,571 calls. Browser/API state matched for room
  `e0-t03-critic6-cold-edit-1785643199817` at offset `...0541`, digest
  `sha256:76cd59882d5122b43fa8224217aa3fb0455a020669fd3f727fc25d81ad23738b`.
- Fresh protocol attacks otherwise passed. A successful live `Response.clone()` with an
  unread sibling branch made `follow.closed` reject typed `CONTENT_TYPE_MISMATCH`, status
  200, in 15.245 ms after exactly one live request, with zero followers/waiters and no
  locked sibling. Twelve malformed Retry-After/calendar forms stopped after one request;
  zero, leading-zero, and canonical past leap-day forms retried exactly once. A
  protocol-relative cross-origin 308 produced typed `ORIGIN_VIOLATION`; the target saw
  zero requests and no Authorization header. Two adapters raced through three HEADs and
  two PUT attempts to exactly one successful create, with both callers fulfilled.
- Fresh nonnumeric opaque checkpoints
  `opaque:critic6-k6p9:{alpha,beta,omega}/%2F?sig=...` yielded exact suffixes
  `[a,b,c]`, `[b,c]`, `[c]`, and `[]` without duplication or arithmetic; terminal empty
  suffix digest was
  `sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`.
  Triple cancellation caused one upstream abort and no request growth, with zero retained
  followers/waiters. Fresh malformed local/remote checkpoints, wrong JSON media,
  malformed JSON, an unterminated SSE frame, and a committed stream rejected as typed
  `INVALID_CHECKPOINT`, `CONTENT_TYPE_MISMATCH`, `PARSE_ERROR`, `MALFORMED_SSE_FRAME`,
  and `STREAM_CLOSED`; the partial frame delivered zero records and the committed response
  preserved final offset `opaque:critic6-k6p9:committed-final`.
- Fresh HTTP lifecycle attacks passed at all four required timings. Disconnect before
  headers made zero writes/follows; disconnect after headers committed one response,
  canceled once, cleared its timer, and refused a late JSON write; disconnect during a
  two-record batch delivered the first record but made zero writes after close and never
  wrote the second; two close signals concurrent with delivery shutdown still canceled
  once and left zero intervals. The independent idle probe again distinguished zero call
  growth from the 2,571-call polling control.
- Credential controls were sensitive. A fresh preload planted the run's random canary in
  raw, URL-encoded, and base64 forms in a sandbox/run artifact; non-promoting conformance
  exited 1 at `scripts/verify-e0-t03-conformance.mjs:867` with `3 !== 0` and
  `Durable Streams token canary leaked`. A temporary browser-visible credential fixture
  made `pnpm typecheck` exit 1 with
  `public/critic6-browser-canary.js references a server credential`. Both plants were
  removed; clean cold scanning found zero matches and all three built-in controls.
- Required detector sensitivity went red one defect at a time. Replacing fixed-point
  provenance convergence with one alias pass made the focused test exit 1 on
  `forward-nested-wrapper`, actual `[]`; restoration returned it green. Replacing the
  submitted non-awaited cloned-response cancellation with awaited cancellation made the
  adapter test exit 1 after 508.759 ms because `follow.closed did not settle`; restoration
  returned all 21 adapter tests green. Product/verifier files were restored byte-exact:
  source audit blob/SHA-256 `3d784ec70f24c0d9d713beb944e59a21c72bd82f` /
  `c415ccc37ee9bfd6064493023797abd5b9b31f3b91fc0070e19e5a370698557d`, adapter
  blob/SHA-256 `c514717a80bd2c9f40b0454beb6088aa5997c93a` /
  `e6d37efbeb9953004ce161be15ef18dcb9198c17ba56188b10ba36d42b6ac0ee`.
  A clean `pnpm typecheck` then passed with 50 audited files and zero submitted-tree
  violations; this green result coexists with the demonstrated higher-order false green.
- Coverage classification: executed — typed adapter create/append/read/SSE follow,
  create races, every opaque resume suffix, malformed/committed/retry/redirect handling,
  wrong-media clone terminalization, cancellation and response-body cleanup, HTTP
  disconnects and timers, services/server/browser integration, request budgets,
  canary/source boundaries, cold verification, concurrency, and build; waived — type
  declarations, manifests, lockfile, Makefile, and documentation as non-runtime changes
  (still inspected and format/type/build checked), plus Replay recording for this
  server-transport ticket; dead — none identified; requiring repair — the executed and
  refuted AC6 interprocedural provider-call and application-API provenance boundary.
  Replay remains honestly `N/A (server transport adapter) + mitigation: real-emulator
protocol transcript, request-budget proof, canary scan, redirect-origin proof,
cloned-response proof, source controls, and reconnect matrix`; upload and tunnel flags
  were false, recordings were unchanged, and no Replay command was run. E0-T04 remains
  blocked.

### Builder repair 6 — 2026-08-01

- Repair target: add interprocedural capability flow for higher-order parameters,
  callback and collection extraction, object/class factories, reflective and borrowed
  invocation, default/rest parameters, and mixed target expressions. Replace the
  literal-only application-API exemption with structural target provenance so variable
  and all-application conditional targets stay allowed while any provider-capable branch
  is rejected. Promote the sixth critic's complete 22-case matrix and full-gate
  higher-order bypass into required red/green controls.

### Builder resubmission 6 — 2026-08-01

- Implementation commit: `f815d7fae0b6626b69d7dcf1bd857e0b6244eee9`. Promoted
  evidence commit: `2c4496f6d6f69d96b836abba483b7a5fc83ff0c1`, its direct
  child. The repair adds fixed-point argument-to-parameter capability flow, including
  default and rest parameters; callback, collection, factory, and class propagation;
  reflective, descriptor, and borrowed invocation; and structural application-API
  provenance across bound, returned, conditional, logical, and sequence targets.
- Normal gates passed before evidence promotion: `pnpm format:check`, `pnpm lint`,
  `pnpm typecheck`, `pnpm test` (42/42 unit and 5/5 browser), and `pnpm build` (30
  files). Static analysis scanned 51 production files with zero Durable Streams access
  violations and 44 files for syntax.
- The sixth critic's 22-case matrix is now shared by the unit and conformance verifiers.
  Six additional controls cover partially bound and returned provider/application
  targets, Set iterator extraction, and `Object.assign` factories. Together with the 28
  prior cases, `evidence/source-access-audit.json` records 56 fixtures: every provider
  case detects `direct-provider-network`, while all five structural application-API
  cases remain allowed.
- Detector sensitivity was proven in a disposable worktree at the exact implementation
  commit. Removing `propagateNetworkParameters(...)` made the focused source guard exit
  1 on `higher-order-parameter-dispatch`, actual `[]`. Discarding structural identifier
  provenance made it exit 1 on `application-api-variable`, actual
  `["direct-provider-network"]`. A temporary formatter-valid source file that called
  `globalThis.fetch` through a higher-order helper made the complete `pnpm typecheck`
  gate exit 1 at that file with `calls Durable Streams directly via invoke`. After each
  mutation was removed, the focused guard and full typecheck returned green and the
  disposable worktree was clean.
- Byte-exact restoration provenance: source audit blob/SHA-256
  `d7b3e583af718011232adcf110c9d12a9a6d4f9d` /
  `c0967d8bba58735dbd2fd28cc3c7401548958ab24bfd6c341691cf338c73f13b`;
  shared fixture blob/SHA-256 `ecda02a22f30a8924566305944da8c3b4d3d360d` /
  `23c7b47d62a282ffd9dfe41c7abefaf11f1ab4fd4926249886b9c8832217c199`;
  unit test blob/SHA-256 `14303f0c041a9a1b4a131085c42da2ef6f131925` /
  `c6acb6ed887a050eee7be466da02f41196795d6345e650b1334efeab5dd54d68`;
  conformance verifier blob/SHA-256
  `0b7edef141ee7cc8e86866be0ed78f8070c53d15` /
  `4dcc6a4b5f25f3ea7e8038dc42ed64d968012d3dfa111da80dfb1d9f439b85a0`.
- Final cold command:
  `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e0-t03-builder-resubmit6 E0_T03_IMPLEMENTATION_COMMIT=f815d7fae0b6626b69d7dcf1bd857e0b6244eee9 make verify-E0-T03`.
  The pinned emulator was installed and built from cold state, then all eight gates
  passed: format, lint, static analysis, unit 42/42, real-emulator conformance, browser
  integration 5/5, concurrency 1/1, and the 30-file build.
- Real conformance used 20 requests under cap 24, created once, held cancellation at
  14 -> 14, and left no active follower or idle waiter. The exact 900,000 ms idle window
  stayed at 2 -> 2 calls; its 350 ms polling control generated 2,571 calls. A wrong-media
  live response rejected as typed `CONTENT_TYPE_MISMATCH` after one request and its
  terminal promise settled.
- Opaque resume proof captured five checkpoints and every expected suffix, ending at
  offset `0000000000000000_0000000000000535`; the full-stream digest is
  `sha256:42b16cc7fd2bd96cea2b9ec766da526e5a3935587867b58d0f5c83aff3609e53`.
  Browser/API state matched at offset `0000000000000000_0000000000000551`, digest
  `sha256:d71d4ba75294253f2bd29a160050f2a0c22ab22aa5b5f17df5552031b8622472`.
  The canary scan detected all three positive-control encodings and found zero output
  matches.
- Replay: N/A (server transport adapter) + mitigation: real-emulator protocol transcript,
  request-budget proof, canary scan, redirect-origin proof, interprocedural source controls,
  cloned-response terminalization proof, and reconnect matrix. No upload or tunnel was
  attempted and recordings were unchanged.
- Falsifiable claim: ordinary higher-order, reflective, container, factory, class,
  default/rest, bound, returned, and mixed-expression provider capabilities can no longer
  cross the adapter-only source boundary, while structurally proven application API calls
  remain allowed; all other E0-T03 transport, lifecycle, security, provenance, and
  cold-clone criteria still pass at the cited implementation commit. One formatter-valid
  provider-capable call accepted by the complete source gate, one clean application call
  rejected by it, or any failed exact-commit cold gate refutes this claim.
