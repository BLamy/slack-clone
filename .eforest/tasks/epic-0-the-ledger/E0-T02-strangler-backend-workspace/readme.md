---
id: E0-T02
epic: 0
title: "Strangler backend workspace around the working chat demo"
priority: 2
status: in-progress
depends_on: [E0-T01]
estimate: L
capstone: false
---

## Goal

Introduce a package and verification spine around the existing Node server so protocol,
storage, reducers, HTTP delivery, and tests can evolve independently without a big-bang
rewrite or regression of the current two-user demo.

## Context

Today one server module owns authentication, sessions, Durable Streams access, reducers,
SSE polling, API routing, and static files. This task creates seams, not new product
behavior. The working homepage, emulator login, two-session convergence, and owner-only
message edit remain the compatibility contract while later tickets replace internals.

The repository currently lacks format, lint, type, unit, build, and cold-clone gates. Those
gates must be narrow enough to cover owned source without sweeping unrelated generated or
submodule files into the task.

## Deliverables

- Backend package boundaries for protocol, Durable Streams access, application reducers,
  services, and HTTP/SSE delivery, with explicit dependency direction.
- Root developer commands for format check, lint, type or static analysis, unit tests,
  integration tests, build, and composed verification.
- Port-isolated test-stack helpers safe for concurrent task work.
- Compatibility tests and `make verify-E0-T02` cold-clone target.

## Acceptance criteria

- [x] `make verify-E0-T02` installs from the lockfile in a cold clone and passes format,
      lint, static analysis, unit, existing Playwright, and build gates with zero skips.
- [x] The homepage, emulator-backed login, stable login error, two authenticated sessions,
      and owner-only persisted edit behave exactly as before extraction.
- [x] Package dependency checks prove pure protocol/reducer modules cannot import HTTP,
      filesystem, network, environment, clock, or provider modules.
- [x] Two verification runs can use assigned ports concurrently without sharing sessions,
      streams, output directories, or teardown targets.
- [x] Routine verification performs no Replay upload, external tunnel, recursive deletion
      outside its run directory, or mutation of existing recordings.
- [x] The diff contains no opportunistic redesign of the visible Slack UI or authentication
      flow; behavior changes require later task IDs.
- [x] Replay is declared `Replay: N/A (server extraction with unchanged browser behavior) +
      mitigation: inherited Playwright compatibility suite, package-boundary audit, and
      cold-clone composed gates`.

## Adversarial verification

1. Run two full stacks concurrently with distinct port allocations and room names. Any
   collision, cross-session message, or shared teardown refutes isolation.
2. Delete or invert one package boundary and confirm the dependency check catches the
   forbidden import.
3. Execute from a clone with no build artifacts, emulator build, environment file, Replay
   login, or global package binaries. Hidden warm-state dependence refutes portability.
4. Force each child process to fail during startup and verify all siblings terminate while
   unrelated user processes and artifacts remain untouched.
5. Sabotage one inherited edit-authorization assertion; the composed target must fail.

## Verification log

### Builder — 2026-08-01

- Exact implementation commit: `db8077fd92e9578913886c543090d5cce0b5b239`.
- Scope: extracted the protocol, reducer, Durable Streams adapter, application-service,
  and HTTP/SSE seams while retaining `src/server.mjs` as the environment/auth/static-file
  composition root. The public HTML, CSS, client behavior, and Auth0 flow were not
  redesigned.
- Cold command: a no-hardlinks clone detached at the implementation commit first proved
  `node_modules`, `emulate/packages/emulate/dist/index.js`, `.env`, and
  `recordings/latest.json` absent, then `make verify-E0-T02` installed both frozen
  lockfiles, initialized emulator commit `8b88027535e4ea6a18c3ce92a13af706382a451f`,
  and passed format, lint, static analysis, unit, integration, concurrency, and build.
- Results: 5 package layers with zero boundary violations; 35 syntax-checked files; 12/12
  unit tests, 5/5 inherited browser compatibility tests, and 1/1 stack-isolation test,
  with zero failures or skips; 28 files in the SHA-256 build manifest.
- Stream proof: browser DOM and authenticated API matched at next offset
  `0000000000000000_0000000000000539` and canonical digest
  `sha256:5918b9ceb2acc0872442eb970b1733b75fb8945f26302051bdcad6afc967c976`;
  the owner edit remained persisted after reload.
- Isolation proof: concurrent stacks used app/Auth0/Durable Streams ports
  `44885/44884/44883` and `22193/22192/22191`, distinct artifact roots, rejected a
  foreign session, isolated the same room name, stopped their own children, and left
  recordings and unrelated processes untouched.
- Detector sensitivity: adding `node:fs` to the pure protocol package made
  `pnpm typecheck` exit 1 and name the forbidden import. Inverting the inherited non-owner
  edit assertion from 403 to 200 made the composed `pnpm verify` reach Playwright and exit
  1 with `Expected: 200, Received: 403`. Forced emulator/app startup failures also stopped
  only their managed siblings.
- Evidence: `evidence/cold-verification.json`, `evidence/isolation.json`,
  `evidence/sensitivity.json`, and `evidence/build-manifest.json`.
- Replay: N/A (server extraction with unchanged browser behavior) + mitigation: inherited
  Playwright compatibility suite, package-boundary audit, and cold-clone composed gates.
- Claim: at the exact implementation commit, the existing authenticated chat behavior is
  unchanged, the new package direction fails closed, and two independently allocated
  stacks cannot share sessions, streams, output, or teardown. A fresh cold clone, a
  forbidden pure-package capability that passes, a non-owner edit that succeeds, or any
  cross-stack observation refutes this claim.

### Critic — 2026-08-01

VERDICT: refuted

Fresh independent Critic did not implement E0-T02. Predictions for all seven acceptance
criteria were written before any test output or E0-T02 evidence JSON was inspected, in
`work/critic-predictions.md`. The exact range
`2cff7718128a0ebe2343efa8f416629e160225b2..b84297e8ff21388a9b14b402086dfd7bd0330e3c`
was reviewed with application behavior pinned at
`db8077fd92e9578913886c543090d5cce0b5b239`. Full redacted results are in
`evidence/critic-independent-verification.json`.

**Finding 1 — the pure-package boundary has a composed-verifier false green
(blocking, AC3).** `tools/check-boundaries.mjs:92-97` extracts imports with a regex that
requires whitespace after the `import` token. In a disposable exact-implementation clone,
the critic inserted this valid static filesystem import in the pure protocol package:
`// prettier-ignore` followed by `import"node:fs";`. The ignore directive made the spelling
formatter-approved while preserving the regex evasion. `pnpm format:check`, `pnpm lint`,
and `pnpm typecheck` each exited 0; the boundary check printed `layers=5 violations=0`.
Most importantly, `TEST_RUN_ID=critic-boundary-bypass-7f3c9a pnpm verify` also exited 0:
12/12 unit, 5/5 browser compatibility, 1/1 concurrency, and build all passed with the
forbidden capability import present. This directly falsifies the criterion that package
checks prove pure protocol/reducer modules cannot import filesystem capabilities and the
builder claim that a forbidden pure-package capability cannot pass.

**Finding 2 — default port allocation has a practical probe/bind race (blocking,
AC4/deliverable).** `scripts/process-utils.mjs:90-110` tests candidate ports by binding and
then closing each socket before returning the block; no reservation survives until child
startup and no `EADDRINUSE` retry exists. With a fixed critic random candidate, two
independent allocator calls made before either stack started both returned
`41631/41632/41633`. Starting the stacks concurrently produced one ready stack and one
rejection, `app:critic-race-b exited unexpectedly with code 1`, with the child reporting
`EADDRINUSE 127.0.0.1:41633`. Distinct explicitly assigned blocks work, but the default
helper advertised as safe for concurrent task work can issue colliding assignments.

**Cold reproduction and compatibility.** A new `git clone --no-hardlinks` detached at
`db8077f` first proved `node_modules`, the built emulator CLI, `.env`, and
`recordings/latest.json` absent. With Replay environment removed,
`TEST_RUN_ID=critic-cold-7f3c9a make verify-E0-T02` exited 0 after frozen root/emulator
installs and the pinned emulator checkout `8b880275…`. It passed format, lint, five package
layers/35 syntax files, 12/12 unit tests, 5/5 inherited browser tests, 1/1 isolation test,
and the 28-file build. The fresh owner-edit run persisted after reload and DOM/API state
matched at offset `0000000000000000_0000000000000539`, digest
`sha256:2967c3930be9500452335b39588629676ce433ec2c3aa4db7ebf7e29c1516c96`.
The emulator declared a non-fatal Node `>=24` engine warning under Node `23.11.0`; its
build and runtime completed.

**Independent isolation/startup/side-effect attacks.** With fresh seed `7f3c9a`, canary
`E0T02-CRITIC-CANARY-20260801-7f3c9a-DO-NOT-LEAK`, and the same logical room, stacks at
`20398/20399/20400` and `35786/35787/35788` refused each other's cookies in both
directions, kept both canary messages out of the peer stream, used distinct artifact
roots, and stopped independently: after A stopped, B remained healthy; then both became
unreachable. Artifact and unrelated-process sentinels survived. Fresh app- and
emulator-startup failures each exited 31, terminated only the managed sibling with
`SIGTERM`, and left an unrelated process/artifact alive. A pristine routine `pnpm verify`
passed with a pre-existing recording sentinel unchanged; static call-path audit found no
Replay/tunnel invocation. An out-of-scope `BUILD_DIR` was rejected before deletion and its
sentinel retained SHA-256 `487180fb…a13b442`.

**Detector sensitivity (both required mutations went red).** An ordinary `import
"node:fs"` in the pure protocol package made `pnpm typecheck` exit 1 and identify the
exact forbidden import. Separately, changing `messageOwnedBy` to authorize every user made
the composed `pnpm verify` exit 1 at the unit gate: 10 passed, while the cross-subject
ownership check failed `true !== false` at `test/unit/backend-packages.test.mjs:48` and
the service test reported a missing expected rejection at line 159. The detector can go
red for ordinary defects; Finding 1 proves its boundary coverage is nevertheless
incomplete.

**Earlier static-review leads.** The hard-coded-looking isolation booleans are emitted
only after concrete assertions: artifact-root distinction, foreign-cookie/stream checks,
post-stop connection failures, and recording snapshots. `evidence/isolation.json` does
compress two sources — concurrent facts come from Playwright, while unrelated-process
cleanup comes from unit fixtures — but both were independently reproduced. The import
regex concern is confirmed and escalated by Finding 1: the format gate does not save it
when `prettier-ignore` is used. The default Playwright config does fall back to
`test-results/playwright`, but every routine wrapper sets `PLAYWRIGHT_OUTPUT_DIR` beneath
its run root and no default output appeared; that lead is dismissed for the routine
verification surface. The port race is confirmed by Finding 2.

**Coverage/provenance/redaction.** Executed: all five package modules/manifests; server
composition/auth/static/API/SSE behavior; every format/lint/static/unit/integration/
concurrency/build/setup/process/run-context helper; both lockfiles; both Playwright configs;
all E0-T02 tests; and all 28 build entries. Explicitly waived after source audit:
README/package-boundary prose, `.gitignore`, task/queue metadata, and generated lockfile
text beyond successful frozen installs. Dead: none. Requiring evidence: none. The
committed build manifest hashes to `a4624289…510f6c`; all 28 entries match the exact
implementation tree and the critic's independent build file list. The post-implementation
delta is task/queue/evidence only. No provider credential, session cookie, customer
content, private key, or unredacted capture appears in E0-T02 evidence.

Lifecycle is `refuted`, which keeps E0-T02 as the sole builder-rework gate and leaves
E0-T03 blocked. Replay: N/A (server extraction with unchanged browser behavior) +
mitigation: inherited Playwright compatibility suite, package-boundary audit, and
cold-clone composed gates. The Replay waiver itself is accurate; the package-boundary
mitigation is what failed adversarially.

### Builder rework — 2026-08-01

- Exact rework implementation commit: `0019a5813378653ae107c5464a0b8f5e72885f75`.
- Finding 1 closed: `tools/check-boundaries.mjs` now uses ESLint parser visitors through
  `tools/import-analysis.mjs` for static imports, re-exports, dynamic imports, and ambient
  environment/network/clock/timer/randomness capabilities. It no longer depends on import
  whitespace or line layout.
- Finding 2 closed: dynamic allocation now acquires atomic per-port leases shared across
  processes, retains them until the emulator/Auth0/app health check proves all three ports
  bound, releases normally and on process exit, and reclaims stale owners. Retry candidates
  advance deterministically even when two allocators receive the same random value.
- Regressions: 15/15 unit tests include the exact `// prettier-ignore` plus
  `import"node:fs";` spelling, same-process same-candidate allocation, and two separate Node
  allocator processes forced to the same first candidate. Both processes received disjoint
  blocks: `45418/45419/45420` and `37499/37500/37501`.
- Exact-head sensitivity: in the disposable cold clone, the critic's formatter-aware import
  mutation passed format and lint but made the composed `pnpm verify` exit 1 at static
  analysis with `packages/protocol/src/index.mjs imports capability module node:fs`.
- Cold proof: a new no-hardlinks clone detached at the rework commit proved dependencies,
  emulator build, `.env`, Replay metadata, and `.artifacts` absent before
  `TEST_RUN_ID=cold-rework-0019a58 make verify-E0-T02`. Both frozen installs completed;
  format, lint, 5 layers/36 syntax files, 15 unit tests, 5 browser tests, the forced-collision
  two-stack test, and the 28-file build all passed with zero skips.
- Stream proof: DOM and authenticated API matched at offset
  `0000000000000000_0000000000000541`, digest
  `sha256:193d979cc362ff5f3827d4e66422c0e57c251aac45b3a0cf043b8656f96c8a7e`.
- Evidence: `evidence/builder-rework-verification.json` and
  `evidence/build-manifest-rework-delta.json`; the complete rework manifest hashes to
  `16044155ed82ac900527e9fc89e405ff7333f249198f4158a85fc83bb58f65f5`.
- Replay: N/A (server extraction with unchanged browser behavior) + mitigation: inherited
  Playwright compatibility suite, package-boundary audit, and cold-clone composed gates.
- Claim: at the exact rework commit, no parser-valid forbidden capability import can evade
  the pure-leaf check, and independently running allocators cannot reserve overlapping port
  blocks before bind. A formatter-approved forbidden import that passes `pnpm verify`, or
  any overlap under a forced identical candidate, refutes this rework.

### Critic resubmission confirmation — 2026-08-01

VERDICT: refuted

Fresh independent critic did not implement E0-T02 and made no product-code fix. Predictions
were recorded before the fresh commands in
`work/critic-confirmation-0ae14b4-predictions.md`; durable redacted results are in
`evidence/critic-resubmission-network-capability-refutation.json`.

**Blocking finding — computed global network capability false green (AC3).** In a new
`git clone --no-hardlinks` detached at exact candidate head
`0ae14b4fb81dbd26b38cd70263a5f59b4c3d17b1`, the critic appended the inert fixture that
captures `globalThis`, resolves `["fe" + "tch"]`, and returns the captured capability only
if its exported function is later called. The fixture was never called and no external
request was made. The literal one-line function spelling first made `pnpm format:check`
exit 1, so only its whitespace was expanded to the Prettier-canonical multiline body and
the required sequence restarted. The semantically identical fixture then produced:

- `pnpm format:check` — exit 0, all matched files use Prettier code style;
- `pnpm lint` — exit 0, no diagnostics;
- `pnpm typecheck` — exit 0, `PASS backend package dependency direction and pure-leaf
  capability boundary`, `layers=5 violations=0`, and 36 syntax files.

This falsifies the acceptance criterion that package checks prove pure protocol/reducer
modules cannot access network capabilities and directly refutes the rework claim that no
parser-valid forbidden capability can evade the pure-leaf check. The checker observes calls
whose callee path is already a recognized global name, but does not propagate this alias or
fold the computed string expression at capture time.

**Prior full-suite artifact provenance.** The supplied artifact at
`work/critic-resubmission-0019a58.qzbCqM/repo/.artifacts/e0-t02/critic-resubmission-ambient-6b92d1/verification-summary.json`
belongs to detached implementation head
`0019a5813378653ae107c5464a0b8f5e72885f75`; the clone has exactly one dirty product file,
`packages/protocol/src/index.mjs`, containing the equivalent inert fixture. The summary is
task `E0-T02`, run `critic-resubmission-ambient-6b92d1`, result `PASS`, with format, lint,
static-analysis, unit, integration, concurrency, and build all marked PASS. Its SHA-256 is
`53caa778da13fad4fac7683e6b05499d3b9e0f7a5eb0777eb580343bcb2c3d60`.
The fixture source, built copy, and 1,844-byte build-manifest entry all hash to
`15cd036a8bd9b181d1632418b89a11c253ecd3d1e6d0d0c72819b6fed330ad08`;
all 28 manifest entries independently rehash with zero mismatches. The stream-proof object
also matches the summary exactly at offset `0000000000000000_0000000000000571`, digest
`sha256:c2b86b18516dcfe99f91687d9c9ca2d529baf2f217a02839b598ad6185b6a418`.

Lifecycle is `refuted`, keeping E0-T02 as the sole gate and E0-T03 blocked. Replay: N/A
(server/static-analysis confirmation with no changed browser behavior) + mitigation:
exact-head no-hardlink reproduction and hash-verified prior full-suite artifact.

### Builder capability rework — 2026-08-01

- Exact implementation commit: `0bdcc0a764513f266de246f904c86a9e49e1e1b8`.
- The pure-package checker now uses ESLint lexical scope references. Unresolved ambient
  globals are rejected at capture time, so later aliasing, optional calls, and computed
  property spelling cannot hide their authority. A deterministic-global allowlist keeps
  ordinary values available, while locally bound and injected names—including a parameter
  named `fetch`—remain valid.
- The boundary also rejects unknown provider globals, `import.meta`, dynamic imports, bare
  module imports and external manifest dependencies in pure packages, internal package
  subpaths that violate dependency direction, and relative imports that escape a package.
- Regression suite: 18/18 unit tests with zero skips. It includes the critic's exact
  `globalThis` alias plus `["fe" + "tch"]` fixture, direct process/fetch/Math aliases,
  unknown provider globals, module metadata, and a negative control for injected names.
- Detector sensitivity: the formatter-valid critic fixture passed format and lint, then
  made both `pnpm typecheck` and a cold composed `pnpm verify` exit 1 with
  `packages/protocol/src/index.mjs reads forbidden ambient global globalThis capability`.
  The fixture was never called, made no request, and was removed cleanly afterward.
- Local composed proof: `TEST_RUN_ID=builder-capability-rework-local pnpm verify` passed all
  seven gates: 18 unit tests, 5 browser tests, forced-collision two-stack isolation, and a
  28-file build. DOM and authenticated API matched offset
  `0000000000000000_0000000000000565`, digest
  `sha256:8485dbce6c213d3b7dbe3589db2489a8bd6e4f2d30d0ad64636100ed6f18443f`.
- Cold proof: a no-hardlinks clone detached at the implementation commit had no root or
  emulator dependencies, emulator build, `.env`, Replay metadata, or artifacts before
  `TEST_RUN_ID=cold-capability-0bdcc0a make verify-E0-T02`. Frozen installs, the pinned
  emulator build, all seven gates, 18/18 unit tests, 5/5 browser tests, 1/1 concurrency
  test, and the 28-file build passed with zero skips. The cold DOM/API proof matched offset
  `0000000000000000_0000000000000549`, digest
  `sha256:eb6f0fc0691b0b813b74cf3a5a95f284576e352bcc8fab0228234289431ab678`.
- Evidence: `evidence/builder-capability-rework-verification.json`; the cold summary,
  stream proof, and build manifest hash respectively to `5980ea53…d7c377`,
  `737d8f5b…9b83cf`, and `1d0bfe80…7f614b`.
- Replay: N/A (server/static-analysis rework with unchanged browser behavior) +
  mitigation: inherited Playwright compatibility suite, lexical package-boundary audit,
  exact-head cold clone, and a cold detector-sensitivity failure.
- Claim: at the exact implementation commit, unresolved ambient authority is rejected at
  lexical capture time regardless of later aliasing or computed property spelling, while
  injected/local names remain permitted. The critic's formatter-valid fixture now makes
  the full verifier go red, and the unmutated exact-head cold clone passes every gate.

### Final independent critic — 2026-08-01

VERDICT: refuted

Fresh independent Critic did not implement E0-T02 and made no product-code fix.
Predictions were written before execution in `work/critic-final-a502186-predictions.md`.
The submitted head was `a502186e0e6d4c91e2332f7b015881051f0230dc`; application code was
pinned at `0bdcc0a764513f266de246f904c86a9e49e1e1b8`. Full redacted results are in
`evidence/critic-final-constructor-capability-refutation.json`.

**Blocking finding — constructor-derived network authority remains green (AC3).** In a
new no-hardlinks detached clone, the critic added this inert pure-protocol fixture:
`const capabilityFactory = (() => {}).constructor;` and an exported, never-called
function returning `capabilityFactory("return globalThis.fetch")`. It made no request.
The fixture passed the direct Prettier check (exit 0), ESLint (exit 0), and
`node tools/static-analysis.mjs` (exit 0), which printed `layers=5 violations=0` and
`syntax files=39`. The checker rejects unresolved ambient identifiers but permits a
function literal's constructor property, which can compile a later `globalThis.fetch`
resolver. A pure leaf therefore retains latent dynamic-code/network authority while the
claimed boundary is green. This directly falsifies AC3.

**Required matrix and valid controls.** The prior exact `globalThis` → optional
`["fe" + "tch"]` → local-function form, direct `fetch`, `process`, and `Math` aliases,
destructuring from `globalThis`, an unknown provider global, `import.meta`, a bare external
import, an internal HTTP subpath, and a relative package escape all passed format/lint and
were individually named by failing static analysis. External pure-manifest dependency and
removed service dependency also went red. Corrected negative controls — a local function,
injected names including a parameter named `fetch`, deterministic allowlisted globals,
and a local relative import — passed format, lint, and static analysis with
`layers=5 violations=0`, `syntax files=38`. An initial parameter literally named
`globalThis` was discarded because the repository's lint policy intentionally forbids
shadowing that restricted name.

**Cold, provenance, and browser results.** Builder hashes for the three rework sources,
the preserved cold summary (`5980ea53…d7c377`), stream proof
(`737d8f5b…9b83cf`), and build manifest (`1d0bfe80…7f614b`) all matched. All 28 manifest
entries rehashed against the exact implementation with zero mismatches. A separate fresh
no-hardlinks clone passed `make verify-E0-T02`: frozen root and pinned emulator setup,
format, lint, static analysis, 18/18 unit tests, 5/5 inherited browser tests, 1/1 real
two-stack test, and the 28-file build. The owner edit persisted and DOM/API state matched
at offset `0000000000000000_0000000000000553`, digest
`sha256:c2dadedb75552cae78e2c535b678bbdc04d3a40561d6ff674c03d907f3f36349`.

**Isolation, side effects, and sensitivity.** Same-process and independent-process
allocators forced to one candidate received disjoint blocks; an explicit real stack used
exactly `41453/41454/41455`, returned health 200, and stopped cleanly. A forced app failure
SIGTERM'd only its managed sibling while an unrelated process and artifact survived.
Offline routine `pnpm verify` preserved the sole recording sentinel byte-for-byte and
matched DOM/API at offset `0000000000000000_0000000000000549`, digest
`sha256:7214426cf3c69ce088659dad0c64967e0c075e258605b2c480be31f1e24a9fa1`;
an out-of-scope `BUILD_DIR` was rejected before deletion. A critic-authored
`messageOwnedBy` defect made composed verification exit 1 after format/lint/static passed,
with 16 unit passes and two precise owner-authorization failures; the clone was restored.

Harness disclosure: a first dummy manifest dependency caused pnpm's dependency-status
check to attempt one registry lookup, which failed 404 before any fixture executed. The
manifest was restored without a lockfile change and rerun using an already-installed
dependency and direct local binaries. No fixture or application request was made.

Lifecycle remains `refuted`, keeping E0-T02 the sole builder-rework gate and E0-T03
blocked. Replay: N/A (server/static-analysis critique with unchanged browser behavior) +
mitigation: exact-head cold browser compatibility, DOM/API stream correlation,
package-boundary matrix, runtime isolation, and detector-sensitivity proof.
