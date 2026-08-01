---
id: E5-T02
epic: 5
title: "Service connections and SecretRefs: replayable metadata without credential values"
priority: 502
status: pending
depends_on: [E5-T01]
estimate: M
capstone: false
---

## Goal

The platform models an external service connection as stream events containing owner,
provider, integration, non-secret metadata, and versioned `SecretRef` identifiers. Create,
rotate, disable, and delete transitions are deterministic, while raw credential values
are rejected at every API and event boundary.

## Context

Slack-style administrators need to attach services to workspaces and agents, but Durable
Streams must never become a secret database. A `SecretRef` identifies broker-managed
material and version policy; it is not a URI that clients can dereference themselves.

## Deliverables

- Connection events, reducer, API schemas, and canonical validation in
  `packages/connections`.
- Secret-shaped input detector and migration-safe versioning for broker/provider refs.
- `make verify-E5-T02` with lifecycle, rotation, deletion, and leak fixtures.

## Acceptance criteria

- [ ] `make verify-E5-T02` passes cold and replays duplicate/reordered valid lifecycle
      events twice to an identical connection view and digest.
- [ ] The public schema permits only opaque `SecretRef` ids, provider/mount names, and
      non-secret labels; token-, password-, private-key-, cookie-, and connection-string-
      shaped values are rejected before append.
- [ ] Rotation creates a new immutable ref revision and atomically advances the active
      pointer; existing in-flight runs retain their captured revision, while new runs use
      the new one.
- [ ] Disable/delete immediately prevents new grants and records a tombstone without
      revealing whether provider-side secret material exists to unauthorized callers.
- [ ] Authorization distinguishes workspace-owned, agent-owned, and user-owned
      connections, and cross-tenant ids return the same typed not-found response without
      stream-head movement.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (server connection model) +
      mitigation: cold-clone reducer replay, secret-shaped input corpus, authz matrix,
      and exact lifecycle digests`.

## Adversarial verification

1. Submit secrets encoded as base64, JSON, URLs, multiline keys, Unicode-confusable keys,
   and nested metadata. Any accepted raw value refutes the model.
2. Race rotate, disable, and invocation capture. Every run must bind exactly one committed
   ref revision with no time-of-check/time-of-use switch.
3. Enumerate foreign connection ids through create/update/delete/grant error behavior.
   Any distinguishable tenant existence signal is a finding.
4. Remove one secret-shape detector branch in a scratch worktree. Its corpus entry must
   turn `verify-E5-T02` red.

## Verification log
