---
id: E6-T06
epic: 6
title: "Fresh sessions and normalized results: no hidden harness history, one portable provenance envelope"
priority: 606
status: pending
depends_on: [E6-T03, E6-T04]
estimate: L
capstone: false
---

## Goal

Every run starts each harness with a new home, conversation, process, and local state;
only the immutable context pack, workspace, and explicit resume artifact may enter. Both
harnesses normalize assistant replies, usage, errors, tool provenance, and terminal causes
into one versioned result envelope used by Slack message publication.

## Context

Persistent sandboxes must not imply persistent hidden model sessions. Unrecorded harness
history breaks reproducibility and can leak one channel or tenant into another. Explicit
resume is a future-capable input with a digest, never an ambient home-directory feature.

## Deliverables

- Fresh-session factory, home/cache allowlist, optional explicit-resume schema, and cleanup.
- Canonical result/provenance normalizer with raw-provider artifact references kept
  access-controlled and content-addressed.
- `make verify-E6-T06` with planted-history, crash, resume, and differential fixtures.

## Acceptance criteria

- [ ] `make verify-E6-T06` passes cold and normalizes paired Codex/Claude fixture runs to
      stable versioned envelopes and exact provenance digests.
- [ ] A fresh run cannot read prior harness conversation ids, homes, caches, auth state,
      transcripts, tool results, or environment canaries, including on persistent Cloudflare OS workspaces.
- [ ] Only an explicit resume artifact named and hashed in the invocation snapshot may
      restore history; missing, foreign, mutable, or digest-mismatched artifacts fail
      before harness launch.
- [ ] The envelope freezes assistant message blocks, tool call/result references, model/
      harness ids, token/usage counters, timings, terminal cause, input/output digests, and
      redaction metadata without claiming native fields that were absent.
- [ ] Raw provider output is stored as a restricted content-addressed artifact and cannot
      be published into chat or shown cross-tenant by a guessed id.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (headless harness session
      isolation) + mitigation: cold-clone planted-history matrix, explicit-resume digest
      checks, cross-harness normalization goldens, and canary scans`.

## Adversarial verification

1. Plant canaries in every prior home/cache/transcript/config location and persistent
   volume, then launch both harnesses. Any canary in input/output is a critical finding.
2. Forge, mutate, cross-tenant, and race explicit resume artifacts. Only the exact captured
   digest may launch.
3. Feed provider-specific missing/extra/unknown fields. The normalizer must preserve truth
   without inventing parity or dropping security-relevant provenance.
4. Reuse the prior harness home in a scratch worktree. The planted-history fixture must
   turn the verifier red.

## Verification log
