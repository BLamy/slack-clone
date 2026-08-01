---
id: E7-T07
epic: 7
title: "Production packaging and identities: signed artifacts, least-privilege deployments, and reproducible configuration"
priority: 707
status: pending
depends_on: [E7-T03, E7-T05]
estimate: L
capstone: false
---

## Goal

The server, scheduler/worker, migration tooling, and verification utilities build into
reproducible signed artifacts with SBOMs and immutable configuration. Each deployment role
uses a distinct least-privilege identity for Durable Streams, Fly, Infisical Agent Proxy,
model providers, telemetry, and release control; no long-lived secret is baked into an
image or shared across roles.

## Context

Production behavior cannot be proven from a developer shell with ambient credentials.
Packaging freezes executable bytes and startup contracts, while workload identity and
brokered secrets constrain what compromise of any one replica can reach.

## Deliverables

- Reproducible container/artifact builds, lockfiles, SBOM/provenance, signing, and verify
  commands.
- Role-to-permission matrix, workload identity/bootstrap, configuration schema, and
  deployment manifests.
- `make verify-E7-T07` plus isolated staging identity/conformance gate.

## Acceptance criteria

- [ ] `make verify-E7-T07` passes cold and builds each artifact twice to matching payload
      digests, normalized SBOMs, signatures/provenance, and embedded version metadata.
- [ ] Runtime images use pinned bases/dependencies, non-root users, read-only roots except
      declared mounts, no package manager/dev tools where unneeded, and no secret/config
      bytes outside the versioned startup schema.
- [ ] Server, scheduler/worker, migrator, and release roles have distinct identities; the
      committed matrix proves each required operation succeeds and every undeclared
      cross-role operation is refused.
- [ ] Production accepts Infisical Agent Proxy only; Agent Vault, ordinary Infisical
      caching Proxy, fake Fly, local harnesses, and unsigned/unattested artifacts fail
      startup before queue consumption.
- [ ] Staging conformance uses real least-privilege identities to read/write only its
      isolated test resources, then inventory proves no Sprite or proxy identity remains;
      missing provider access exits nonzero with `SKIPPED:`.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (production packaging and
      workload identities) + mitigation: cold-clone reproducible builds, signatures/SBOM,
      permission matrix, startup refusal corpus, and real staging identity transcript`.

## Adversarial verification

1. Scan image layers, manifests, SBOM, provenance, env defaults, and build logs for
   canaries and credentials; test history/layer extraction, not only final filesystem.
2. Run each role under every other role's identity and attempt all provider operations.
   Any undeclared success refutes least privilege.
3. Tamper artifact, signature, SBOM, config, and provider-mode attestation independently.
   Startup must fail before consuming a run.
4. Vary host/time/locale/build path and rebuild. Payload differences without a documented
   normalized provenance field refute reproducibility.

## Verification log
