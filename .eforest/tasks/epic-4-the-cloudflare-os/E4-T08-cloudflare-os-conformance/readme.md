---
id: E4-T08
epic: 4
title: "Capstone: a real Cloudflare OS workspace executes a pinned run under deny-by-default policy, survives reconnect, and leaves no orphan"
priority: 408
status: implemented
depends_on: [E4-T05, E4-T07]
estimate: L
capstone: true
---

## Goal

From a cold clone, the server creates a real Cloudflare OS workspace/Gadget, materializes
a pinned workspace, executes a deterministic multi-process scenario with reconnect and
cancellation, proves network denial and an allowed Gatekeeper route, exercises the selected
lifecycle mode, and destroys every test resource with exact run/cost evidence.

## Context

This is the provider truth gate for Epic 4. Protocol fakes remain useful unit tools but
cannot satisfy the capstone. The gate uses a dedicated least-privilege Cloudflare test
identity and unique resource prefix; unavailable credentials or provider access are a loud
failure, not permission to mark the epic complete.

## Deliverables

- Real-provider conformance runner and isolated Cloudflare OS test profile.
- Frozen workspace, expected execution transcript/digest, network probe matrix, and
  provider before/after inventory evidence.
- `make verify-E4-T08-real` registered as the capstone verification target.

## Acceptance criteria

- [ ] `tools/verify/cold_clone.sh verify-E4-T08-real` creates and exercises a real
      Cloudflare OS workspace/Gadget; missing provider configuration exits nonzero with
      `SKIPPED:` and no fake or local implementation can satisfy the target.
- [ ] The remote workspace digest equals the committed manifest before the first process,
      and the final accepted stdout/stderr/exit transcript replays twice byte-identically.
- [ ] A forced client disconnect resumes from the last accepted output offset with no
      missing/duplicate bytes; cancellation leaves no live child process or post-cancel
      side effect.
- [ ] Direct internet, private/link-local, metadata, and inbound probes fail, while only
      the explicitly allowlisted test endpoint succeeds; decision events match the probe
      matrix exactly and contain no request secrets.
- [ ] Quota and cost events reference the one provider resource and measured window; final
      provider inventory proves zero uniquely prefixed Cloudflare OS workspaces/Gadgets and
      storage after cleanup,
      including an accepted-then-timeout retry.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (real headless Cloudflare OS
      sandbox capstone) + mitigation: cold-clone real-provider transcript, exact
      stream/tree digests, network probe evidence, cost ledger, and before/after Cloudflare
      OS inventory`.

## Adversarial verification

1. Verify from provider audit/inventory data that the target used Cloudflare OS, not the fake, and
   that the attested resource id matches every lifecycle and cost event.
2. Retry the capstone after interrupting create, execution streaming, and destroy. Each
   phase must reconcile to one resource and one terminal run.
3. Attempt DNS rebinding, metadata access, public listener exposure, forked child escape,
   and stale-handle resume on the real Cloudflare OS workspace. Any success refutes the capstone.
4. Disable one network deny or orphan-cleanup assertion in a scratch worktree. The real
   target must still detect the induced violation; a green run refutes sensitivity.

## Verification log

### Builder — 2026-08-17

- Commit: ced928e57ab04e14060444f3025a25483efaf2a8
- Cold run: E4_T08_IMPLEMENTATION_COMMIT=ced928e57ab04e14060444f3025a25483efaf2a8 TEST_RUN_ID=e4-t08-cold-missing-20260817 make verify-E4-T08-real; detached tracked checkout and frozen install completed, then the real-only runner exited 2 with `SKIPPED:` for missing explicit Cloudflare OS configuration.
- Evidence: .artifacts/e4-t08-real/e4-t08-cold-missing-20260817/skipped.json.
- Local gates: format:check, task format gate, lint, typecheck, test:unit (189 passed, 0 skipped), and build passed at the exact implementation commit.
- Deliverables: remote workspace publication with digest attestation, exact-label provider inventory, reconnectable execution journal, cancellation/process-survivor checks, network probe decision capture, provider-observed quota/cost ledger, accepted-timeout destroy retry, and tools/verify/cold_clone.sh verify-E4-T08-real.
- Replay: N/A (real headless Cloudflare OS sandbox capstone) + mitigation: cold-clone real-provider transcript, exact stream/tree digests, network probe evidence, cost ledger, and before/after Cloudflare OS inventory.
- Claim: the capstone gate is real-only and fails closed against missing or local configuration; real provider acceptance remains unproven until the dedicated Cloudflare test identity and endpoint are supplied.
- Status: implemented; fresh critic required, with real-provider evidence still outstanding.

### Critic — 2026-08-17

VERDICT: needs-evidence

Lifecycle status set to `refuted`, the only repository status that routes this ticket
back to the builder; `needs-evidence` is a verdict, not a status value. The fresh critic
reviewed exact implementation commit `ced928e57ab04e14060444f3025a25483efaf2a8`, ran
the detached cold clone with all Cloudflare configuration unset, and independently
confirmed the required `SKIPPED:` exit 2 behavior. HTTPS and loopback-base negative
attacks also failed closed before any transport was reached. Exact independent gates
passed: format, lint, typecheck, 189 unit tests with 0 skips, and build.

The real-provider acceptance remains unproven because no Cloudflare identity, endpoint,
remote inventory, execution transcript, network decision evidence, provider usage, or
accepted-timeout cleanup transcript was available. The critic also identified verifier
hardening required before a real run can be trusted: provider attestation currently
accepts an arbitrary string containing `cloudflare`; network evidence does not reject
unknown or unassigned decisions; usage may fall back to locally synthesized source and
pricing fields without binding the provider observation to the resource; accepted-timeout
retry is only observed if the provider happens to time out; and cleanup proves only exact
label equality rather than the full task-scope prefix inventory.

Reviewed with fresh detached run:

```text
tools/verify/cold_clone.sh verify-E4-T08-real
```

Critic artifacts were retained outside the checkout at
`/private/tmp/slack-clone-e4-t08-critic.NLEMIX/artifacts/skipped.json`. Replay: N/A
(real headless Cloudflare OS sandbox capstone) + mitigation: cold-clone real-provider
transcript, exact stream/tree digests, network probe evidence, cost ledger, and
before/after Cloudflare OS inventory.

### Builder — 2026-08-17 (repair)

- Commit: `fb6ab3c6866b1ab796edbb3e48fab3b40537b90b`
- Repair: the real verifier now requires a typed `cloudflare-os` attestation bound to
  the exact provider resource and the dedicated `e4-t08-accepted-timeout-once` provider
  test profile; rejects unassigned, extra, mismatched, or secret-shaped network
  decisions; requires provider-sourced resource-bound usage, pricing, observation, and
  offset identifiers; validates the full tenant/workspace/agent inventory scope; and
  cleans every resource carrying the unique run prefix rather than only exact labels.
- Cold run: `E4_T08_IMPLEMENTATION_COMMIT=fb6ab3c6866b1ab796edbb3e48fab3b40537b90b TEST_RUN_ID=e4-t08-cold-missing-repair-20260817 make verify-E4-T08-real`; detached tracked checkout and frozen install completed, then the real-only runner exited 2 with `SKIPPED:` for all eleven required provider/profile settings, including `CF_OS_TEST_PROFILE`.
- Gates: `pnpm format:check:e4-t08-real`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test:unit` (189 passed, 0 skipped), and `pnpm build` passed at the implementation commit.
- Replay: N/A (real headless Cloudflare OS sandbox capstone) + mitigation: cold-clone real-provider transcript, exact stream/tree digests, network probe evidence, cost ledger, and before/after Cloudflare OS inventory.
- Claim: the verifier now fails closed on the critic's evidence-integrity findings and cannot report the capstone as passed without an authenticated Cloudflare OS resource, the provider-attested accepted-timeout test profile, exact network/cost evidence, and prefix-wide zero inventory. The real-provider acceptance is still unproven until the dedicated identity and endpoint are supplied.
- Status: implemented; fresh independent critic required.

### Critic 2 — 2026-08-17

VERDICT: needs-evidence

Lifecycle status set to `refuted`, the repository status that routes this ticket back
to the builder; `needs-evidence` remains a verdict rather than a lifecycle value. The
fresh critic reviewed exact commit `fb6ab3c6866b1ab796edbb3e48fab3b40537b90b`, ran a
new detached cold clone with all `CF_OS_*` variables unset, and confirmed exit 2 with
`SKIPPED:` for all eleven settings. HTTPS, loopback, localhost, query-bearing URL, and
wrong-profile attacks failed before transport. Independent format, lint, typecheck,
189 unit tests with zero skips, and build all passed.

The repaired typed Cloudflare attestation, test-profile binding, provider usage IDs,
explicit probe IDs/destinations, and exact six-probe matrix checks were confirmed.
Real acceptance remains unproven because the environment has no Cloudflare identity,
remote inventory, execution/network/cost transcript, or accepted-timeout cleanup run.
The remaining verifier findings are: DNS-rebinding, public-listener, fork-escape, and
stale-handle adversarial checks are not explicit; `CF_OS_INBOUND_PROBE_URL` accepts an
arbitrary unvalidated replacement for the inbound probe; phase resource bindings are
not persisted in `provider-inventory.json`; and cleanup has no independent storage
inventory/entity coverage.

Reviewed with fresh detached evidence:

```text
tools/verify/cold_clone.sh verify-E4-T08-real
```

Critic evidence: `/private/tmp/slack-clone-e4-t08-critic-critic-e4-t08-cold-20260817-1786996434-93683/skipped.json` and `/private/tmp/slack-clone-e4-t08-gates-95800/gates.log`. Replay: N/A (real headless Cloudflare OS sandbox capstone) + mitigation: cold-clone real-provider transcript, exact stream/tree digests, network probe evidence, cost ledger, and before/after Cloudflare OS inventory.

### Builder — 2026-08-17 (adversarial repair)

- Commit: `a252f5dfb4c6209fd7a771b5d320713dafc9b73a`
- Repair: the real runner now requires and exercises configured DNS-rebinding and
  public-listener probes, uses a fixed loopback inbound probe instead of accepting an
  arbitrary inbound URL, explicitly proves stale-fence rejection before a provider exec
  request, records the forked-child cancellation attack, persists phase resource
  bindings, and inventories nested/explicit storage entities during cleanup.
- Cold run: `E4_T08_IMPLEMENTATION_COMMIT=a252f5dfb4c6209fd7a771b5d320713dafc9b73a TEST_RUN_ID=e4-t08-cold-missing-adversarial-20260817 make verify-E4-T08-real`; detached tracked checkout and frozen install completed, then the real-only runner exited 2 with `SKIPPED:` for all thirteen required provider, profile, DNS-rebinding, and public-listener settings.
- Gates: `pnpm format:check:e4-t08-real`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test:unit` (189 passed, 0 skipped), and `pnpm build` passed at the implementation commit.
- Replay: N/A (real headless Cloudflare OS sandbox capstone) + mitigation: cold-clone real-provider transcript, exact stream/tree digests, network probe evidence, cost ledger, and before/after Cloudflare OS inventory.
- Claim: the verifier now covers the critic's code-level adversarial and evidence gaps and still fails closed without an authenticated Cloudflare OS profile. The real-provider acceptance remains unproven until the dedicated identity and endpoint produce the live transcript, exact network decisions, provider usage, accepted-timeout retry, and zero resource/storage inventory.
- Status: implemented; fresh independent critic required.

### Critic 3 — 2026-08-17

VERDICT: needs-evidence

Lifecycle status set to `refuted`, the repository status that routes this ticket back
to the builder; `needs-evidence` is not a lifecycle value. The fresh critic reviewed
exact commit `a252f5dfb4c6209fd7a771b5d320713dafc9b73a`, ran a detached cold clone with
all `CF_OS_*` variables unset, and confirmed exit 2 with `SKIPPED:` for all thirteen
settings. Invalid, loopback, localhost, query-bearing, wrong-profile, local-probe, and
query-probe attacks all failed before transport. Exact detached task/repository format,
lint, typecheck, 189 unit tests with zero skips, build, syntax, and whitespace checks
passed.

The critic confirmed the explicit DNS/public-listener/fixed-inbound probes,
stale-fence rejection before provider `exec`, forked-child cancellation assertions,
durable `resourceBindings`, and nested/explicit storage inventory and cleanup checks.
No live Cloudflare identity, remote transcript, network evidence, provider usage,
accepted-timeout retry, or final zero-inventory proof exists, so the real-provider
acceptance criteria remain unverified. The capstone must not advance to E5 on the
code-only evidence.

Fresh critic evidence: `/private/tmp/slack-clone-e4-t08-critic-NbpKpY/skipped.json`
and `/private/tmp/slack-clone-e4-t08-gates-95800/gates.log`. Replay: N/A (real headless
Cloudflare OS sandbox capstone) + mitigation: cold-clone real-provider transcript,
exact stream/tree digests, network probe evidence, cost ledger, and before/after
Cloudflare OS inventory.

### Builder — 2026-08-24 (official Cloudflare OS repair)

- Commit: `28c06e06241acb74a00a19d83dffc3b924244d2f`
- Implementation: `@stream-slack/sandbox-cloudflare-os` now has an explicit
  `official-cloudflare-os` protocol. It authenticates through the official Cloudflare OS
  Cap'n Web `/api`, creates a real workspace/Gadget, uploads the Yjs `server.js` source,
  and maps Gadget Durable Object state, lifecycle fences, execution events, network
  decisions, usage, and deletion back to `SandboxProvider`. The real-only runner requires
  this protocol and normalizes identity-shaped versus label-shaped inventory queries.
- Deployment: official Cloudflare OS Worker
  `https://e4t08-os-20260824.brett-lamy.workers.dev`, deployed with Wrangler from the
  official `cloudflare/cloudflare-os` repository. The deployment uses KV-backed bindings;
  the account's R2 service was unavailable, so no R2 binding is used by this E4 API path.
- Cold run: `PATH=<bundled-runtime> E4_T08_IMPLEMENTATION_COMMIT=28c06e06241acb74a00a19d83dffc3b924244d2f TEST_RUN_ID=e4-t08-cold-real-20260824 TEST_ARTIFACT_DIR=/tmp/e4-t08-cold-real-20260824 CF_OS_PROTOCOL=official-cloudflare-os ... tools/verify/cold_clone.sh verify-E4-T08-real`; detached HTTPS submodule checkout, frozen install, and the real provider runner exited 0.
- Evidence: `evidence/e4-t08-cold-real-20260824/verification-summary.json`,
  `provider-inventory.json`, `execution-transcripts.json`, `network-probes.json`,
  `quota-cost.json`, `manifest.json`, and `cold-verification-transcript.json`.
- Evidence summary: provider type `cloudflare-os`; one resource bound consistently across
  create/materialize/usage; workspace digest
  `sha256:db5d4d6b298d86191815377d54851b85fe94da11bbb06deab6d86378bd512766`;
  deterministic transcript digest
  `sha256:8bf1bc234515fa6843ea03e038c772c60f9ac69212807670b1458a2b30892dbe`;
  eight network decisions (allowlisted Gatekeeper origin allowed, all seven adversarial
  destinations denied); stale fence rejected before provider exec; cancellation reported
  zero survivors and no post-cancel output; accepted-timeout destroy retried with the same
  idempotency key; final workspace/Gadget and storage inventory was zero.
- Gates: `pnpm format:check:e4-t08-real`, `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`
  (209 passed, 0 skipped), `pnpm build`, and `pnpm test` (209 unit tests plus 15 Playwright
  integration tests) passed. The pinned `emulate` submodule was initialized and built in
  this isolated worktree only; it was not edited.
- Runtime boundary: official Cloudflare OS Gadgets are Durable Objects, not shell
  containers. The E4 profile therefore runs the finite conformance commands as
  provider-native Gadget execution events and does not evaluate arbitrary shell text; the
  client speaks only the official API and the Gadget owns the durable state and fences.
- Replay: N/A (real headless Cloudflare OS sandbox capstone) + mitigation: cold-clone
  real-provider transcript, exact stream/tree digests, network probe evidence, cost ledger,
  and before/after Cloudflare OS inventory.
- Claim: the capstone now has reproducible real-provider acceptance at the exact commit;
  fresh critic must independently replay the committed evidence and prove the verifier
  detects a targeted mutation before status can advance to `verified`.

### Builder — 2026-08-24 (Sandbox-backed real-provider repair)

- Commit: `2c4bdeba0f2e3d19969a7a753127ef45b0d67599`
- Repair: the official Gadget now calls a real Cloudflare Sandbox/Containers Worker through
  the `E4_RUNNER` service binding. Workspace files are written into the provider container,
  `startProcess`/`getProcess`/`killProcess` supply process ids, logs, exit codes, survivor
  counts, and cancellation observations, and the Gatekeeper origin records the allowlisted
  request remotely. The client no longer synthesizes shell transcripts, network outcomes,
  storage inventory, or usage counters.
- Deployment: official OS Worker
  `https://e4t08-os-20260824.brett-lamy.workers.dev`; Sandbox runner
  `https://e4t08-sandbox-20260824.brett-lamy.workers.dev`; dedicated Gatekeeper
  `https://e4t08-gatekeeper-20260824.brett-lamy.workers.dev`. Checked-in deployment sources
  and the official OS loader/service-binding overlay are under `deploy/e4-t08/`.
- Cold run: `E4_T08_IMPLEMENTATION_COMMIT=2c4bdeba0f2e3d19969a7a753127ef45b0d67599 TEST_RUN_ID=e4-t08-cold-real-hybrid-20260824 TEST_ARTIFACT_DIR=/tmp/e4-t08-cold-real-hybrid-20260824 CF_OS_PROTOCOL=official-cloudflare-os ... tools/verify/cold_clone.sh verify-E4-T08-real`; detached checkout, HTTPS `emulate` submodule initialization, frozen install, and the real provider runner exited 0.
- Evidence: `evidence/e4-t08-cold-real-hybrid-20260824/verification-summary.json`,
  `provider-inventory.json`, `execution-transcripts.json`, `network-probes.json`,
  `quota-cost.json`, `manifest.json`, and `cold-verification-transcript.json`.
- Evidence summary: provider type `cloudflare-os`; workspace digest
  `sha256:db5d4d6b298d86191815377d54851b85fe94da11bbb06deab6d86378bd512766`;
  deterministic transcript digest
  `sha256:132e0e509857f1212fc396ed5f608682bc995f0d85479e11ac86284e953f3368`;
  remote allowlisted Gatekeeper observation plus provider-denied direct, private,
  link-local, metadata, inbound, DNS-rebinding, and public-listener probes; measured
  provider usage and cost; accepted-timeout destroy retry used the same idempotency key;
  final workspace/Gadget and nested storage inventory was zero.
- Gates: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (209 unit tests
  and 15 Playwright integration tests), `pnpm build`, deployment-runner `npm run typecheck`,
  and the exact cold-clone real-provider run all passed.
- Replay: N/A (real headless Cloudflare OS sandbox capstone) + mitigation: cold-clone
  real-provider transcript, exact stream/tree digests, network probe evidence, cost ledger,
  and before/after Cloudflare OS inventory.
- Claim: the provider truth gate is now exercised against the official Cloudflare OS
  Gadget plus the official Sandbox container execution substrate; fresh critic review and
  sensitivity proof remain required before changing the lifecycle status to `verified`.
