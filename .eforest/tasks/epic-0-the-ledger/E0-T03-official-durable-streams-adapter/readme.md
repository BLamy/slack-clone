---
id: E0-T03
epic: 0
title: "Official Durable Streams adapter with resumable reads"
priority: 3
status: refuted
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

### Seventh fresh independent critic — 2026-08-02

VERDICT: refuted

- Fresh Codex critic; did not implement this ticket and made no product repair. Before
  executing tests, predictions and narrow refuters for every acceptance criterion,
  applicable adversarial item, requested AC6 family, provenance check, sensitivity
  control, and coverage class were frozen at
  `work/critic7/frozen-predictions.md` (SHA-256
  `626031428244312f8b1687a9a1a029afe9c604278e15f5d1ffdfcae79fbc37d5`).
  The complete task history, E0-T02 dependency contract, exact three diffs after baseline,
  and all five evidence JSON files were inspected before execution.
- Provenance passed. Baseline `c542f4b202995caf09579701db8bf29b375d23ad` is an ancestor;
  repair-6 implementation `f815d7fae0b6626b69d7dcf1bd857e0b6244eee9` has tree
  `a4e1b2f80b8248abf24ef5fff55079571acaeb30`; promoted evidence
  `2c4496f6d6f69d96b836abba483b7a5fc83ff0c1` is its direct child; and submission
  `39c97f25459240aa41043a80df1aa38cdbe8f156` (tree
  `b5c20c26222f86d01d2c90311e1884b8be8581cb`) is the evidence commit's direct child.
  Implementation-to-evidence changed only the five evidence JSON files, and
  evidence-to-submission changed only this readme and `QUEUE.md`; no product path changed
  after the implementation commit. Every evidence file names the exact implementation.
- **Blocking AC6 refutation:** the independent, formatter-valid matrix at
  `work/critic7/source-audit-matrix.mjs` exercised both exported
  `analyzeDurableStreamsAccess` snippet analysis and a full 27-file synthetic-repository
  audit. It contained 20 provider-capable cases and seven clean application cases using
  nested and mutually recursive higher-order functions, closures returning functions,
  async/generator and argument-forwarding wrappers, inheritance, Proxy traps,
  `Reflect.construct`, getters, weak collections, destructuring defaults, optional
  chaining, tagged/callable wrappers, and mixed application/provider flow. The analyzer
  missed five ordinary provider paths: prototype-method inheritance through
  `Object.setPrototypeOf`, a `defineProperty` getter, late `WeakMap.set/get`, nested
  destructuring defaulting to `globalThis.fetch`, and a tagged callable selector. It also
  rejected three clean application paths: literal and inherited getters returning
  `/api/rooms/...`, and a tagged `streamUrl` selector. The full repository audit reproduced
  both classes, including provider bypass `src/nested-destructuring-default.mjs` and clean
  application control `src/application-literal-getter-stream-url.mjs`, so these are
  complete source-gate outcomes rather than snippet-only parser artifacts.
- The narrowest product-tree refuter was canonical and formatter-valid:
  `src/critic7-nested-default-provider.mjs` defaulted a nested transport binding to
  `globalThis.fetch` and invoked a Durable Streams provider URL. `pnpm lint` exited 0 and
  the complete `pnpm typecheck` gate exited 0 with `files=52 violations=0` and syntax
  `files=45`. The temporary source was then removed. Conversely, the clean application
  getter control was reported as `direct-provider-network`. One ordinary provider call
  accepted by the complete gate and one clean application API call rejected by it each
  independently refute AC6.
- The exact non-promoting cold command exited 0:
  `env -u PROMOTE_EVIDENCE TEST_RUN_ID=e0-t03-critic7-cold-r7x2
  E0_T03_IMPLEMENTATION_COMMIT=f815d7fae0b6626b69d7dcf1bd857e0b6244eee9 make
  verify-E0-T03`. Dependencies, generated artifacts, and the emulator build were absent,
  and the pinned emulator submodule was uninitialized before the run. All eight gates
  passed: format, lint, static analysis, unit 42/42, real-emulator conformance, browser
  integration 5/5, concurrency 1/1, and the 30-file build. The emulator's Node >=24
  engine warning under Node 23.11.0 was nonfatal and all actual gates passed.
- The cold run made 20 requests under cap 24, one create, and six SSE requests; cancellation
  held at 14 -> 14 with zero retained followers/waiters. The 900,000 ms idle probe held at
  2 -> 2 calls with 90 keepalives, while its polling positive control made 2,571 calls.
  Five resume suffixes matched exactly and the cold full-stream digest was
  `sha256:f8317cf0182bbc7f13b9ea5669e1d4731b7fcd33b5218ad2ce21d486b59bb92c`.
  Browser/API state matched for room
  `e0-t03-critic7-cold-r7x2-edit-1785646352426` at offset `...0551`, digest
  `sha256:0feeac9eaa936c19dddcc1872e6d1205c88c09a80b9dea1be64788dc02932e50`.
  Canary matches were zero.
- `PROMOTE_EVIDENCE` was explicitly absent. Before and after the cold run, committed
  evidence SHA-256 values were byte-identical: canary
  `af3b1d833fe7328966929820c0c665aafc29a63309a5a868fd42280726fcf4a5`, cold
  `2a81dc3b00fe900a087cfdc712e43a273fbf40ce16b0137b667f08907fc5ebf1`, protocol
  `d43172bc89070e2ed884f9b8e6ddb08f42957fd2b800466cba005fc8bf1ccf52`, request
  `1609dcde2ae07d4bcf084e3e76e1f0c18256c1ce4fc64b9a549f431a0b80bdfe`, and source
  `5994a8d699976f36e700dfc5bd075550f365e7e0e7f3d8318f470bd451455f8f`.
  `git diff --exit-code` over evidence passed.
- Required sensitivity was independently proven one defect at a time. Removing
  `propagateNetworkParameters(...)` made the focused source guard exit 1 on
  `higher-order-parameter-dispatch`, actual `[]`. Disabling identifier application
  provenance made it exit 1 on `application-api-variable`, actual
  `["direct-provider-network"]`. Planting a real formatter-valid higher-order provider
  source made full `pnpm typecheck` exit 1 at
  `src/critic7-higher-order-detector-control.mjs:6`. As a non-source control, disabling
  cross-origin redirect classification made its focused protocol test exit 1 because it
  observed `UNEXPECTED_REDIRECT` instead of required `ORIGIN_VIOLATION`.
- Every mutation was restored byte-exact. The source auditor returned to Git blob
  `d7b3e583af718011232adcf110c9d12a9a6d4f9d`, SHA-256
  `c0967d8bba58735dbd2fd28cc3c7401548958ab24bfd6c341691cf338c73f13b`; the adapter
  returned to blob `c514717a80bd2c9f40b0454beb6088aa5997c93a`, SHA-256
  `e6d37efbeb9953004ce161be15ef18dcb9198c17ba56188b10ba36d42b6ac0ee`.
  A final clean `pnpm typecheck` passed with 51 audited files, zero violations, and 44
  syntax files before metadata edits.
- A bounded independent protocol/security sample passed 14 assertions: create-once with
  nonnumeric opaque checkpoint semantics, request-constant official SSE follow,
  malformed checkpoint/body/content-type/partial-frame/closed-stream rejection, malformed
  Retry-After rejection, cross-origin redirect fencing, upstream abort/waiter release,
  and downstream disconnect before header commit. The unique cold run additionally
  executed cleanup, canary scanning, browser/API stream correlation, concurrency, and
  build. These green nonblocking results do not cure AC6.
- Coverage classification: executed — create/append/read/follow, official live semantics,
  create race, opaque resumes, protocol status/body/media/partial-frame/Retry-After and
  redirect behavior, cancellation and HTTP disconnects, resource cleanup, request budget,
  canary/source boundaries, browser/API proof, concurrency, cold verifier, and build;
  explicitly waived — declarations, package/lock metadata, Makefile wiring, docs, and
  committed evidence serialization as non-runtime changes (their format/type/build,
  provenance, schema, and hashes were still checked), plus Replay for this server-transport
  ticket; dead — none identified; requiring repair and fresh evidence — AC6's executed
  provider and application-target provenance boundary. Replay remains honestly
  `N/A (server transport adapter) + mitigation: real-emulator transcript, request-budget
  proof, canary scan, redirect-origin test, source controls, browser/API correlation, and
  reconnect matrix`; no `record:replay`, tunnel, or external upload was run. E0-T04 remains
  blocked.

### Builder repair 7 — 2026-08-02

- Repair target: replace the open-ended call-target taint claim with an enforceable
  network-door boundary. Production and browser modules outside explicit transport doors
  may not acquire ambient network capabilities at all; application API traffic moves
  through a same-origin `/api/` door, while Durable Streams provider access remains
  confined to the official adapter and conformance harness. Promote the seventh critic's
  provider and clean-application cases as architecture-boundary controls, including nested
  defaults, inheritance/getters, weak collections, tagged selectors, and reflective
  construction. The repair is complete only when a full synthetic repository cannot make
  a new module network-capable through those forms, valid application calls use the
  declared door without false positives, and mutation proves both sides of the boundary
  can go red.

### Builder resubmission 7 — 2026-08-02

- Implementation commit: `4afa3d7fe45398e466b21a541298a21026173d2a`; regenerated
  evidence commit: `faa476f6ad0fe224f26d534a083e051073398cc4`, its direct child.
  The repair replaces open-ended provider-target taint inference with explicit transport
  doors: only the Durable Streams adapter and conformance harness may acquire provider
  network capability; the browser uses a same-origin `/api/` door; Auth0 uses a
  configured-origin door that refuses redirects; and the HTTP server imports only the
  bounded inbound `createServer` capability. Doors cannot export raw network capability.
- Normal gates passed before promotion: `pnpm format:check`, `pnpm lint`,
  `pnpm typecheck`, `pnpm test` (45/45 unit and 5/5 browser), and `pnpm build` (33 files).
  Static analysis scanned 27 production files with zero access violations and 47 files
  for syntax. The promoted source evidence contains 83 controls: all provider-capable
  cases are rejected and all declared application-door cases are accepted.
- Detector sensitivity was proven in a disposable worktree at the exact implementation
  commit, one defect at a time. Removing member acquisition tracking made both the
  focused alias control and full synthetic repository's nested-default provider control
  fail. Removing `application-api.js` from the declared-door set made the clean app-door
  control fail. Exporting `globalThis.fetch` from that door made full `pnpm typecheck`
  reject the raw capability. Widening its route prefix from `/api/` to `/` made the
  runtime door test accept a forbidden non-API path and fail. Finally, a real tracked
  `src/` module using a nested default of `globalThis.fetch` made full `pnpm typecheck`
  exit 1 at that file. Every mutation was removed before evidence promotion.
- Byte-exact restoration provenance: auditor blob/SHA-256
  `b7cff6089a4611c936c417408498fb8bbe38e7cf` /
  `13b4bce4fbee8a8693ecdb4556d832491e7df8c711cebe740c36c2eb337fe22d`;
  application door `dd10a7c5ac5175aa3c4a05445fda927845e68664` /
  `cd75ea704a6502fb9fb82d9d97f48ca090ab5c7d1ad7cbff7189c1d615a5411c`;
  Auth0 door `5ee68a3c720a8a06231d1c5706533b809132a14a` /
  `4647b481689aea8272990e7be4e104a2d7b1f217a458d85780c33be232ef4cd3`;
  inbound HTTP door `f9aead1e0a7334f3b2a312c3fe6c6a587281204c` /
  `5735dc2202619bed091d683e4ae03c0db74eead5e18bc6486565432c734667de`.
  The shared fixtures, door tests, and conformance verifier likewise returned to blobs
  `cab261997ce4e24ea769a6694d90b025295cca5d`,
  `81c4dafcfe302e6a97c519c580acacdd48da28fa`, and
  `a102a619a0a72487831a499bb85b0b7b801af7a6`; the restored worktree was clean and removed.
- Final cold command:
  `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e0-t03-builder-resubmit7 E0_T03_IMPLEMENTATION_COMMIT=4afa3d7fe45398e466b21a541298a21026173d2a make verify-E0-T03`.
  The tracked implementation tree was clean at start; the pinned emulator installed and
  built from cold state; and all eight gates passed: format, lint, static analysis, unit
  45/45, real-emulator conformance, browser integration 5/5, concurrency 1/1, and build.
- Real conformance created once and made 20 requests under the cap of 24, including six
  SSE requests. The 900,000 ms idle boundary stayed at 2 -> 2 calls, cancellation stayed
  at 14 -> 14 requests with zero retained followers/waiters, and the 350 ms polling
  positive control generated 2,571 calls. Wrong live media rejected as typed
  `CONTENT_TYPE_MISMATCH` after one request and settled its terminal promise.
- Five opaque checkpoints produced every exact suffix without offset parsing, ending at
  `0000000000000000_0000000000000535`; the full-stream digest is
  `sha256:034d96e94708b37c6c84cae2ad7a8c8ea170b26f7993348d416d1c21e7906c8a`.
  Browser/API state matched at offset `0000000000000000_0000000000000551`, digest
  `sha256:73b2d864591e49ee6fe00a84f0bdb20af3fc49da0c8b2bd750460019fa1b9a7b`.
  The canary scan detected all three encoded positive controls and found zero output
  matches across browser/API assets, logs, environment manifests, and run artifacts.
- Replay: N/A (server transport adapter) + mitigation: real-emulator protocol transcript,
  request-budget proof, canary scan, redirect/origin-fenced door tests, full synthetic
  repository audit, browser/API stream correlation, and reconnect matrix. No Replay
  upload or tunnel was attempted and recordings were unchanged.
- Falsifiable claim: at the cited implementation commit, a production module can reach
  network only through a declared, route/origin-fenced transport door; Durable Streams
  provider traffic remains confined to the official adapter and conformance harness;
  clean application traffic passes through `/api/`; and all remaining protocol,
  lifecycle, security, provenance, and cold-clone criteria still pass. Any ambient
  capability acquisition outside a door, raw capability export, provider target through
  an application/Auth0 door, clean `/api/` rejection, or failed exact-commit cold gate
  refutes this claim.

### Eighth fresh independent critic — 2026-08-02

VERDICT: refuted

- Fresh Codex critic; did not implement this ticket and made no product repair. Before
  executing any verifier, predictions and narrow refuters were frozen for all seven
  acceptance criteria, five adversarial items, the repair-7 network-door families,
  exact-diff/provenance and evidence-sensitivity claims, mutation controls, and the four
  coverage classes at `work/critic8/frozen-predictions.md` (SHA-256
  `fa40c5e122f7d943dfcd6191d917242582b7c5d726c67522db5ae1e95c29ecc4`). The full
  task, verified E0-T02 dependency contract, repository/loop instructions, implementation
  diff, evidence manifest, submission diff, and every committed evidence JSON were read
  before execution.
- Provenance passed. Implementation `4afa3d7fe45398e466b21a541298a21026173d2a`
  (tree `d224003b58137725be674306390085b891aac097`) has parent
  `2799ce28b957cb092ba74d22507be42eb8a4f3b9`; evidence
  `faa476f6ad0fe224f26d534a083e051073398cc4` (tree
  `b3dbaa90105af11296bf233237cf2efec635e728`) is its direct child; submission
  `563896e7029bbf7b54c146c730a5fe41682e0620` (tree
  `7a7f4d9e06daed81915e4b182a4552b1836dbd85`) is the evidence commit's direct
  child. Implementation-to-evidence changed only the five evidence JSON files;
  evidence-to-submission changed only this readme and `QUEUE.md`. Every evidence JSON
  stamps the exact implementation commit.
- The exact required non-promoting command ran from genuinely cold generated/dependency
  state and exited 0:
  `env -u PROMOTE_EVIDENCE TEST_RUN_ID=e0-t03-critic8-cold
  E0_T03_IMPLEMENTATION_COMMIT=4afa3d7fe45398e466b21a541298a21026173d2a make
  verify-E0-T03`. Root dependencies, emulator dependencies/build, generated artifacts,
  test reports, recordings metadata, and environment files were absent; the pinned
  emulator submodule was uninitialized. The run installed the frozen dependencies and
  built emulator commit `8b88027535e4ea6a18c3ce92a13af706382a451f`; its Node >=24
  preference under Node 23.11.0 was a nonfatal warning. All eight actual gates passed:
  format, lint, static analysis, unit 45/45, real-emulator conformance, browser integration
  5/5, concurrency 1/1, and the 33-file build.
- Cold evidence was not promoted or altered. Pre/post SHA-256 values remained byte-identical:
  canary `840e5cfbeea580c369e336102815b0b2d44a3511817faa961d707c386828f159`,
  cold `e2c8dcf5ef6a8f29e599b1f3071a7a0726edea5f2926c02c1413d66712b37c65`,
  protocol `6b0f8187c009d3e45308d7d01dc1a79239dd65b0884ebff5f113db75d7225a83`,
  request `57ed0959333e26594f57b3797e9e35d5fe529e06edfdc670f0be9bf03b4b57bf`,
  and source `fa56d638922a039fce3eab8f1fbb15f6ee7ac41faabda0a6d182ff37e3b7a499`.
  Their Git blobs are respectively `feb45befa751703d06e0b67e1d1b4bd562b2f1af`,
  `3ffbc0fe4275a10418003ea3bd92cc4c11a67817`,
  `b925df37f246f1c7d48359e0e8a849d03a92761e`,
  `46721d02df747cdedecb39e14e18b0f0b18a0657`, and
  `e6aa1de1f4e1cbcb5b6c2a079b258d7da1aab439`; `git diff --exit-code` over evidence
  passed.
- Criterion map: AC1 passed the exact cold verifier and provenance checks. AC2 passed with
  20 requests under cap 24, one create, six SSE requests, cancellation fixed at 14 -> 14,
  zero retained followers/waiters, and a 900,000 ms idle interval fixed at 2 -> 2 calls;
  its 350 ms positive control made 2,571 calls. AC3 passed five accepted records and six
  exact suffix resumes using byte-preserved nonnumeric checkpoints. AC4 passed upstream
  abort, downstream disconnect before headers, disconnect after headers/between records,
  zero active timers, and no late JSON/second response. AC5 passed with all three promoted
  canary positive controls detected and zero clean-output matches, plus independent
  server-artifact and browser-source red controls. AC6 is refuted by the complete source
  gate false negatives below. AC7 remains honestly waived as declared for this
  server-transport ticket, with its required non-browser mitigations executed.
- **Blocking AC6/repair-7 refutation:** the independent formatter-idempotent matrix at
  `work/critic8/critic8-source-matrix.mjs` (SHA-256
  `7be1912d0f7e95ebd4a7c47eca928cbf09132bf8bccef6fe231d72b7b4f183cd`) ran 51
  snippets through both exported snippet analysis and a complete synthetic-repository
  audit. Only 27 matched expectation; there were zero false positives but 24 false
  negatives in both modes. Missed ambient paths included `window.top.fetch`, bare `top`,
  `document.defaultView`, `globalThis.Function`, `globalThis.eval`, arrow/async function
  constructors, and nested `navigator.sendBeacon`. Missed Node/loader paths included
  `node:dns`, aliased `createRequire`, aliased/computed `process.getBuiltinModule`, and
  remote static/dynamic imports. Five raw-capability function/default/assignment/getter/
  EventSource export forms, three inbound-door dynamic-loader forms, and two split-role
  door-confusion forms were also accepted. Results are in
  `work/critic8/source-matrix-results.json` (SHA-256
  `ca239882de95ead6780fb3501a22f55eebcc461a4524e98257c176522bba6adc`).
- The matrix result was reproduced against the actual product tree with narrower complete-
  gate refuters, not left as a parser-only concern. A temporary
  `src/critic8-constructor-network-bypass.mjs` obtained fetch through
  `(() => {}).constructor`; `pnpm format:check`, `pnpm lint`, and full `pnpm typecheck`
  all exited 0 with 28 audited files, zero violations, and 48 syntax files. A temporary
  `src/critic8-loader-network-bypass.mjs` used aliased `createRequire(import.meta.url)` to
  export `node:http.request`; the same three gates exited 0 and runtime import confirmed
  the exported capability was a function. Their planted SHA-256 identities were
  `15fa79f5f2ad8130df0e7feb3aa42735ee971f9e1ff5b33bea68989592c86518` and
  `d8986e2810ad802bc7192ca920959a30c3ef7050d6c8b5e08fa3488aac5550aa`.
- Door-specific full-gate refuters also remained green. Adding an exported function to
  `public/application-api.js` that returns `globalThis.fetch` passed format, lint, and
  full typecheck with zero violations, so the door can export a usable raw capability
  despite the claim. Adding `await import("node:http")` and exporting its `request` from
  `src/http-server.mjs` likewise passed all three gates and runtime import returned a
  function, refuting the inbound-only named-`createServer` enforcement claim. Direct
  `export const ... = globalThis.fetch` is detected, but that narrower positive control
  does not cure the function-return escape.
- Runtime door controls separate real fences from the blocker. The application door
  accepted five same-origin `/api/` controls, rejected nine non-API/cross-origin/
  credential/hash controls, forced `credentials: "same-origin"`, `redirect: "error"`,
  and credentialed EventSource. The Auth0 client fixed token/userinfo calls to its
  configured origin, used manual redirect handling, rejected all five redirect classes
  and an escaped final response URL, cancelled the escaped body, and exported no raw
  capability. However, configuring that unrestricted Auth0 origin to a local provider-
  role endpoint made it issue `POST /oauth/token` there and disclose the fresh dummy
  `critic8-door-confusion-secret`; the corresponding computed-env synthetic repository
  remained violation-free. Thus Auth0's local origin/redirect fence passes, while the
  declared-door role-confusion claim remains independently refuted. The application
  split-provider matrix case was stopped by its runtime cross-origin fence and is not
  counted as an additional blocker. Runtime results are in
  `work/critic8/door-runtime-results.json` (SHA-256
  `dd5abd39464bb087815e14060c8952a21dadbb8b11284936073c01014ecd10ff`).
- Independent protocol/lifecycle execution with namespace `critic8-c8n4` passed. It
  preserved six deliberately nonnumeric checkpoints containing braces, encoded slashes,
  percent signs, plus signs, and query-like text; delivered the two live records exactly
  once; and produced every expected resume suffix including an empty terminal suffix.
  Four malformed checkpoints failed pretransport as `INVALID_CHECKPOINT`; wrong live
  media failed after one request as `CONTENT_TYPE_MISMATCH` and settled; a partial frame
  delivered zero records and failed as `MALFORMED_SSE_FRAME`. Eight malformed Retry-After
  values made one attempt and failed, while three valid controls made two attempts.
  Cross-origin 308 produced `ORIGIN_VIOLATION`, zero target requests, and no forwarded
  authorization. Cancellation aborted upstream with requests fixed at 3 -> 3 and no
  followers/waiters. HTTP disconnect controls observed 0 heads/0 follows before headers
  and 1 head/1 cancel/0 timers after headers, with only the first record delivered and no
  late JSON. Results are in `work/critic8/protocol-lifecycle-results.json` (SHA-256
  `f532e4dc90fc85752b885e335a736125bf546d4214d1143382c938305d935e55`).
- Detector sensitivity was proven one isolated defect at a time. A runtime canary preload
  made `pnpm test:conformance` exit 1 with three forbidden token matches. A browser source
  containing `DURABLE_STREAMS_ADMIN_TOKEN` made full `pnpm typecheck` exit 1 as a server-
  credential reference. A real outside-door `globalThis.fetch` source made full typecheck
  exit 1 at line 2. Removing `public/application-api.js` from the declared door set made
  full typecheck exit 1 on its ambient fetch. Widening `API_PREFIX` from `/api/` to `/`
  made the complete 45-test unit gate fail 44/45 because `/rooms/demo/messages` was
  accepted. Directly exporting `globalThis.fetch` from the door made full typecheck exit
  1 as `exports raw network capability`. These positive controls show the intended gates
  can turn red; the nearby function/constructor/loader false greens prove insufficient
  coverage rather than an inert verifier.
- Every mutation was restored byte-exact before this metadata edit. The auditor returned
  to blob/SHA-256 `b7cff6089a4611c936c417408498fb8bbe38e7cf` /
  `13b4bce4fbee8a8693ecdb4556d832491e7df8c711cebe740c36c2eb337fe22d`;
  application door `dd10a7c5ac5175aa3c4a05445fda927845e68664` /
  `cd75ea704a6502fb9fb82d9d97f48ca090ab5c7d1ad7cbff7189c1d615a5411c`;
  Auth0 door `5ee68a3c720a8a06231d1c5706533b809132a14a` /
  `4647b481689aea8272990e7be4e104a2d7b1f217a458d85780c33be232ef4cd3`;
  inbound HTTP door `f9aead1e0a7334f3b2a312c3fe6c6a587281204c` /
  `5735dc2202619bed091d683e4ae03c0db74eead5e18bc6486565432c734667de`;
  adapter `066e0beecbc9b0da17c48a8367b4087c8de8ba89` /
  `9c1dbbd974d744aec4989e50f61cba116259d8083bb1be1fa88aac86ddce23bd`.
  All temporary tracked-path files were absent, `git diff --exit-code` against submission
  passed, and final restored `pnpm format:check`, `pnpm lint`, `pnpm typecheck` (27 files,
  zero violations; 47 syntax files), and `pnpm test:unit` (45/45) all exited 0.
- Coverage classification: executed — create/append/bounded read/official follow,
  create-once, opaque resume, retry/media/frame/redirect strictness, request budget,
  cancellation, all requested HTTP disconnect points, canary and source controls,
  application/Auth0 runtime fences, browser/API correlation, concurrency, cold setup,
  build, provenance, and detector sensitivity; explicitly waived — declarations,
  package/lock/config metadata, docs, task metadata, and committed evidence serialization
  as non-runtime behavior (their format, provenance, schema/stamps, and hashes were still
  checked), plus Replay as declared; dead — none identified; requiring repair and fresh
  evidence — AC6 enforcement for ambient global/constructor/reflection paths, Node
  builtins and dynamic loaders, raw function/getter exports, inbound-door imports, and
  cross-role Auth0/provider configuration. Replay: N/A (server transport adapter) +
  mitigation: exact-commit real-emulator transcript, request-budget proof, canary scan,
  door runtime matrix, browser/API correlation, cancellation, and reconnect matrix. No
  `record:replay`, upload, tunnel, or other externally mutating command ran; recordings
  remained unchanged. E0-T04 remains blocked pending product repair and new exact-commit
  evidence.

### Builder repair 8 — 2026-08-02

- Repair target: replace capability-flow guesswork with explicit static module and door
  contracts. Runtime source outside declared doors will reject dynamic code, constructor
  recovery, browser-global escape roots, remote modules, Node network builtins, dynamic
  loaders, `createRequire`, and `process.getBuiltinModule` by syntax and import policy.
  Each declared door will have an exact export surface and role-specific contract, the
  inbound HTTP door will permit only named `createServer`, and composition will reject an
  Auth0 origin that aliases the Durable Streams provider origin. Promote every critic-8
  false-negative family plus valid application controls into the required source/runtime
  gate and prove full-gate mutations for constructor acquisition, aliased loaders, wrapped
  raw exports, inbound dynamic imports, and role-confused configuration.

### Builder resubmission 8 — 2026-08-02

- Implementation commit: `339aca3cb9b4d92dac30c5b1156cb7a200317aed`; regenerated
  evidence commit: `000ecb05103e942099e13e4364ae75442fd59879`.
- The repair replaces inferred capability-flow allowlisting with explicit syntax, import,
  and export contracts. Runtime source now rejects constructor/dynamic-code recovery,
  browser-global escape roots, reflective capability recovery, Deno/Bun networking,
  Node network builtins and loaders, remote module schemes, CommonJS loading, dynamic
  imports outside provider doors, and raw capability exports or returns. Durable Streams,
  Auth0, application API, and inbound HTTP doors each have an exact export surface; the
  inbound door permits only the named `node:http` `createServer` import. Auth0 startup
  also rejects a configured origin that aliases the reserved Durable Streams origin, and
  the browser application door remains fixed to same-origin `/api/` paths.
- Routine exact-tree gates all exited 0 before promotion: `pnpm format:check`, `pnpm lint`,
  `pnpm typecheck`, `pnpm test` (45 unit and 5 browser tests), `pnpm build` (33 files),
  and `pnpm test:conformance` (20 requests, five captured offsets, zero canary matches).
  The source verifier has 85 static door-contract cases; together with the 28 legacy
  conformance controls, promoted sensitivity covers 113 fixtures.
- Detector sensitivity was proven in a detached worktree at the implementation commit,
  one defect at a time. Removing the constructor guard failed both the
  `arrow-constructor-recovery` fixture and full synthetic repository test. Disabling the
  runtime-loader rule failed `create-require-alias`; disabling raw `ReturnStatement`
  handling failed the allowed `applicationApiFetch` raw-return control; and disabling
  dynamic-import handling failed `inbound-dynamic-module`. Bypassing the Auth0 role
  conflict made the runtime test report a missing expected exception, while widening
  `/api/` to `/` made `/rooms/demo/messages` incorrectly pass and the door test fail.
- Full repository sensitivity also went red for four temporary product-tree plants:
  constructor recovery in `src/` was named as a forbidden runtime member; aliased
  `createRequire` was named as an undeclared runtime loader; a wrapped raw fetch export
  from the application door was rejected; and a dynamic `node:http` export from the
  inbound door was rejected both as a dynamic import and an undeclared door symbol.
  After byte-exact restoration, `pnpm typecheck` and the 24 focused adapter/door tests
  passed and the disposable worktree was clean before removal.
- Restoration provenance: auditor blob/SHA-256
  `f45aaf1492aa8c5186f8bce5b3f8df243506d02f` /
  `fded8be400db796247c7982a7930fcb9fdfcb144db79bab871b11d2a5fc1a2bf`;
  Auth0 door `19175606b467069867575b8c406eebb927e534a9` /
  `c37da49428fca647dc1fa81b7aaaf0777a2629ef6d77f55e2aa75d556b0fba40`;
  application door `dd10a7c5ac5175aa3c4a05445fda927845e68664` /
  `cd75ea704a6502fb9fb82d9d97f48ca090ab5c7d1ad7cbff7189c1d615a5411c`;
  inbound HTTP door `f9aead1e0a7334f3b2a312c3fe6c6a587281204c` /
  `5735dc2202619bed091d683e4ae03c0db74eead5e18bc6486565432c734667de`.
  Fixtures, adapter tests, door tests, conformance verifier, and server restored to blobs
  `761ec4ecc8dc1772811b69639e0e8f8701cb4e9b`,
  `023601737f86d4be4ee8f7a8ee0da52e8643e3ce`,
  `1e4404cc8ce01567fc8764f4b14db76053f77d19`,
  `0f0a1a4590d530c72d92583a53fb5c1378468510`, and
  `839f34832cc5142adad47a39201421f512c62221` respectively.
- Final cold command:
  `PROMOTE_EVIDENCE=1 TEST_RUN_ID=e0-t03-builder-resubmit8 E0_T03_IMPLEMENTATION_COMMIT=339aca3cb9b4d92dac30c5b1156cb7a200317aed make verify-E0-T03`.
  The clean implementation tree installed the pinned emulator and passed all eight gates:
  format, lint, static analysis (27 production files, zero violations; 47 syntax files),
  unit 45/45, real-emulator conformance, browser integration 5/5, concurrency 1/1, and
  the 33-file build. Every committed evidence JSON stamps the exact implementation SHA.
- Real conformance created once and used 20 requests under the frozen cap of 24. The
  900,000 ms idle boundary stayed at 2 -> 2 calls, cancellation stayed at 14 -> 14 with
  zero retained followers/waiters, and the 350 ms polling positive control generated
  2,571 calls. Five opaque checkpoints reproduced every exact suffix, ending at
  `0000000000000000_0000000000000535`; the full-stream digest is
  `sha256:1c5f785a3fe38ae9dee9a8d7cdc195857bed35d30c85108e6ffa6a15da73829a`.
  Browser/API state matched at offset `0000000000000000_0000000000000551`, digest
  `sha256:0519a6c427eeb36317e79319cf5bad85095af61ebd51ac824030bf866fd10b2c`.
  Canary positive controls all fired and the clean scan found zero raw, URL-encoded, or
  base64 matches.
- Replay: N/A (server transport adapter) + mitigation: exact-commit real-emulator
  transcript, request-budget proof, canary scan, static door-contract sensitivity,
  route/origin role tests, browser/API correlation, cancellation, and reconnect matrix.
  No Replay upload or external tunnel was attempted; recordings were unchanged.
- Falsifiable claim: at the cited implementation commit, production network access is
  limited to declared modules with exact syntax/import/export contracts; Durable Streams
  traffic remains confined to its official adapter and conformance harness; Auth0 cannot
  share the provider origin; clean browser traffic is limited to same-origin `/api/`;
  and every remaining protocol, lifecycle, secrecy, provenance, and cold-clone criterion
  passes. Any constructor/loader/reflection bypass, raw capability return, undeclared door
  import/export, role-confused origin, clean `/api/` rejection, or failed exact-commit
  cold gate refutes this claim.

### Ninth fresh independent critic — 2026-08-02

VERDICT: refuted

- Fresh Claude Code critic; did not implement this ticket and made no product repair.
  Predictions and narrow refuters for all seven acceptance criteria, the five adversarial
  items, the repair-8 syntax/import/export/door/route/origin contract families, and the
  four coverage classes were frozen before any inspection of test results at
  `work/critic10/frozen-predictions.md`. Read the task, `AGENTS.md`, `.eforest/loop.md`,
  the verified E0-T02 contract, all eight prior verdicts, and the exact
  implementation/evidence/submission diffs before analysis.
- **Execution constraint, stated plainly:** this critic session's permission mode denied
  every execution command. `make verify-E0-T03`, `pnpm typecheck`, `node -e`, `python3`,
  `shasum`, and `git hash-object` were all refused before running, so the mandated cold
  command `env -u PROMOTE_EVIDENCE TEST_RUN_ID=e0-t03-critic10-cold
  E0_T03_IMPLEMENTATION_COMMIT=339aca3cb9b4d92dac30c5b1156cb7a200317aed make
  verify-E0-T03` was **not executed**, and neither were the sensitivity mutations,
  runtime door attacks, or independent protocol runs. No prediction hash was recorded
  because hashing was also denied. Accordingly AC1–AC5 and AC7 are recorded as
  **unverified by this critic**, not as passing. The verdict below rests only on
  static reading of the exact implementation tree, which is sufficient because both
  blocking findings turn on gate *scope* and *unwatched syntax*, not on runtime behavior.
- Provenance (read-only) is consistent: implementation `339aca3` touches only
  `test/unit/durable-streams-adapter.test.mjs` atop the substantive repair `c3b2b74`;
  evidence `000ecb0` changes only the five evidence JSON files; submission `2d46079`
  changes only this readme and `QUEUE.md`. Working tree was clean at start.
- **Blocking AC6 finding 1 — non-`.mjs` production modules are outside every static
  gate.** `tools/audit-durable-streams-access.mjs:526-533` scans only `.mjs`/`.js` under
  `src`, `packages`, `public`; `tools/static-analysis.mjs:6,68` syntax-checks only
  `.mjs`; `tools/check-boundaries.mjs:144` only `.mjs`; `eslint.config.mjs` `files`
  covers only `src/**/*.mjs`, `packages/**/*.mjs`, …; and `package.json:13`
  `format:check` enumerates `public/*.js` and `src/*.mjs` explicitly. A production
  module named `src/<name>.cjs` is therefore read by no gate at all. Such a file may
  contain `module.exports = require("node:http")`, and `src/server.mjs` may import it as
  `./<name>.cjs` — a relative specifier matched by no pattern in the audit
  (`NETWORK_MODULE_PATTERN`, `MODULE_LOADER_PATTERN`, `REMOTE_MODULE_PATTERN` at lines
  76-79 all miss it). The declared contract "production network access is limited to
  declared modules with exact syntax/import/export contracts" is defeated by file
  extension alone. The repair-8 claim of an exhaustive static contract is refuted at its
  scope boundary rather than at any individual rule.
- **Blocking AC6 finding 2 — browser DOM-driven network is entirely unwatched.** For a
  `public/` module outside the declared application door, `document.createElement("script")`
  followed by an assigned `.src`, or `new Image().src = <provider URL>`, or a
  `link rel=preload`, issues a real cross-origin GET. The audit does not see it:
  `globalContainerEscapes` (lines 700-706) explicitly exempts a global container in
  object position, so bare `document` is not reported; the `MemberExpression` handler
  (lines 394-408) reports only computed access or a property in `NETWORK_MEMBER_NAMES`
  / `GLOBAL_ALIAS_MEMBER_NAMES` / `GLOBAL_ESCAPE_MEMBER_NAMES`, and `createElement`,
  `head`, `body`, `append`, and `appendChild` are in none of them; and `Image`,
  `Worker`, `SharedWorker`, and `navigator.serviceWorker` are absent from
  `AMBIENT_NETWORK_GLOBALS` (lines 14-24), so the `Program:exit` global-through sweep
  (lines 432-447) never fires. `navigator.sendBeacon` is caught only because
  `sendBeacon` is special-cased by name at lines 409-415 — evidence that the model is a
  name blocklist, not the claimed exhaustive contract. A standalone `public/` module
  that does not import `application-api.js` also escapes the `PROVIDER_REFERENCE`
  cross-check at lines 477-488, so it may target the Durable Streams origin directly.
  This directly contradicts the claim that "clean browser traffic is limited to
  same-origin `/api/`".
- Fixture coverage confirms these are genuine blind spots rather than tested-and-allowed
  behavior: `test/support/source-audit-fixtures.mjs` contains no case for
  `document.createElement`, `Image`, `Worker`, a `.cjs` module, or a `node:process`
  named-import of `getBuiltinModule`; its only related cases are
  `window.navigator.sendBeacon` (line 676) and the member form
  `process.getBuiltinModule` (lines 735, 838). The critic-8 family was closed in its
  member spelling only.
- Additional plausible gap, reported as non-blocking because it was not executed:
  `import { getBuiltinModule } from "node:process"` then `getBuiltinModule("node:http")`
  uses no watched member, no watched specifier, no `require` identifier, and no
  unresolved global, so it appears to pass the audit; it needs a runtime check on the
  target Node version before being treated as confirmed.
- Coverage classification: **executed by this critic** — static reading of the audit,
  static-analysis, boundary, lint, and format scopes against the exact implementation
  tree, plus fixture-coverage and provenance inspection; **requiring repair and fresh
  evidence** — AC6 enforcement for non-`.mjs` production extensions and for browser
  DOM/element-driven network acquisition, and the fixture/gate scope that let both pass;
  **unverified this round** — AC1 cold verifier, AC2 request budget/idle, AC3 opaque
  resume, AC4 cancellation, AC5 canary scan, and all detector-sensitivity controls,
  because command execution was denied; **explicitly waived** — AC7 Replay, as declared
  for this server-transport ticket. No mutation was made to any tracked file, so no
  restoration was required; `git status` was clean before and after analysis and only
  this readme and `QUEUE.md` are modified by this entry.
- Replay: N/A (server transport adapter) + mitigation: static contract audit of the
  exact implementation commit against the declared door families. No `record:replay`,
  upload, tunnel, or other externally mutating command was run; recordings unchanged.
- E0-T04 remains blocked. Repair should widen gate scope by file extension and add
  DOM/element network acquisition to the contract, then supply new exact-commit evidence
  with red controls for both families; a subsequent critic session with execution
  permission must still independently confirm AC1–AC5.

### Builder reproduction of critic 9 — 2026-08-02

- The critic's decisive AC6 observations were reproduced after its session ended. Direct
  calls to `analyzeDurableStreamsAccess` returned zero violations for all three fresh
  samples: a `document.createElement("script")` provider request, a `new Image().src`
  provider request, and a named `getBuiltinModule` import from `node:process` that obtains
  `node:http`.
- A detached exact-submission worktree then loaded both blocking samples through real
  production entrypoints: `src/server.mjs` imported a `.cjs` module whose body was
  `module.exports = require("node:http")`, and `public/app.js` imported a browser module
  that assigned the provider URL to an `Image` source. With both samples present,
  `pnpm format:check`, `pnpm lint`, and `pnpm typecheck` exited 0; the audit reported 29
  scanned files and zero violations while the syntax gate remained at 47 files because
  the `.cjs` module was outside its scope. All 45 unit tests also passed.
- The first browser attempt stopped before startup only because this fresh worktree's
  pinned emulator build was absent. After `pnpm setup:emulate`, the same product samples
  passed all 5 Playwright compatibility tests, produced matching DOM/API stream proof,
  and passed `pnpm build` with both samples included in the 35-file output. This confirms
  that the findings are executable production paths and full-gate false greens, not only
  static suspicions.
- Both temporary product samples and their imports were removed with exact inverse
  patches. `git diff --exit-code` over every product/config/test path then passed, and a
  final `pnpm typecheck` returned to 27 source-audit files, 47 syntax files, and zero
  violations. Only this task readme and regenerated `QUEUE.md` remain changed for the
  refutation metadata. Replay/tunnel commands were not invoked.
