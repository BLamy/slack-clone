---
id: E0-T02
epic: 0
title: "Strangler backend workspace around the working chat demo"
priority: 2
status: pending
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

- [ ] `make verify-E0-T02` installs from the lockfile in a cold clone and passes format,
      lint, static analysis, unit, existing Playwright, and build gates with zero skips.
- [ ] The homepage, emulator-backed login, stable login error, two authenticated sessions,
      and owner-only persisted edit behave exactly as before extraction.
- [ ] Package dependency checks prove pure protocol/reducer modules cannot import HTTP,
      filesystem, network, environment, clock, or provider modules.
- [ ] Two verification runs can use assigned ports concurrently without sharing sessions,
      streams, output directories, or teardown targets.
- [ ] Routine verification performs no Replay upload, external tunnel, recursive deletion
      outside its run directory, or mutation of existing recordings.
- [ ] The diff contains no opportunistic redesign of the visible Slack UI or authentication
      flow; behavior changes require later task IDs.
- [ ] Replay is declared `Replay: N/A (server extraction with unchanged browser behavior) +
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
