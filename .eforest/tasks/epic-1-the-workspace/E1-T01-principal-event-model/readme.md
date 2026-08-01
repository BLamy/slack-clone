---
id: E1-T01
epic: 1
title: "First-class human, agent, and service principal event model"
priority: 101
status: pending
depends_on: [E0]
estimate: M
capstone: false
---

## Goal

Define the durable identity contract for humans, agents, and internal services so all three
can be addressed consistently while retaining distinct authentication, ownership, and
authorization boundaries.

## Context

Current messages persist a display name and email but no stable actor ID. An agent must look
and participate like a normal workspace member without becoming a human impersonation
mechanism. `ownedBy` records who manages an agent; it does not inherit the owner's roles or
let the agent present the owner's subject. Service principals exist for narrowly scoped
workers and never appear as chat authors.

Authentication subjects and profile fields are separate. The server derives the principal
from verified authentication and stamps it on dispatch; clients cannot select an actor in
an event body.

## Deliverables

- Versioned principal events and pure reducer for create, profile update, suspend, and
  deactivate transitions across `human`, `agent`, and `service` kinds.
- Stable subject-binding and agent-owner reference schemas with typed refusal reasons.
- Golden identity logs, authorization fixtures, and canonical state digests.
- `make verify-E1-T01` cold-clone target and evidence.

## Acceptance criteria

- [ ] `make verify-E1-T01` exits 0 from a cold clone and replays every identity fixture twice
      to the same
      pinned per-prefix and final digests.
- [ ] Human, agent, and service principals have globally unambiguous immutable IDs and
      explicit kinds; profile names, handles, and emails are mutable non-authority fields.
- [ ] The dispatch door ignores or rejects a client-supplied actor ID and stamps the
      authenticated principal; an agent credential can never produce a human-authored event.
- [ ] An agent's `ownedBy` reference grants no implicit workspace, channel, connection, or
      secret permission and cannot cross a workspace boundary.
- [ ] Suspended or deactivated principals cannot create new mutations while historical
      events retain their original actor attribution.
- [ ] Principal fixtures and evidence contain no access token, password, session cookie, or
      provider credential, verified by canary scanning.
- [ ] Replay is declared `Replay: N/A (server identity event model) + mitigation: golden
      logs, impersonation refusal matrix, canary scan, and deterministic reducer digests`.

## Adversarial verification

1. Submit events with another human, owned agent, service, and sibling-workspace actor ID.
   Any accepted spoof refutes server-derived identity.
2. Change profile handle and email, then replay old messages. Attribution drift or ID reuse
   refutes stable identity.
3. Reuse an agent credential after owner role escalation, suspension, transfer, and
   deactivation. Any inherited or stale privilege refutes separation.
4. Mutate principal kind and owner references in golden logs. Silent transition or unchanged
   digest refutes schema sensitivity.
5. Remove the authenticated-subject match in a scratch worktree; the negative matrix must
   fail.

## Verification log
