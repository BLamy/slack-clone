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
