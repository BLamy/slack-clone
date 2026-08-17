---
id: E4-T08
epic: 4
title: "Capstone: a real Cloudflare OS workspace executes a pinned run under deny-by-default policy, survives reconnect, and leaves no orphan"
priority: 408
status: in-progress
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
