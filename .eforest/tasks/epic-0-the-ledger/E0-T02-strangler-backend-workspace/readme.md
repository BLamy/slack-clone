---
id: E0-T02
epic: 0
title: "Strangler backend workspace around the working chat demo"
priority: 2
status: implemented
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
