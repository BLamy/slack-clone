---
id: E5-T06
epic: 5
title: "Tool gateway: search, describe, and schema-validated execute over pinned catalog operations"
priority: 506
status: pending
depends_on: [E5-T05]
estimate: L
capstone: false
---

## Goal

Harnesses receive one stable tool gateway with `search`, `describe`, and `execute`
operations over the invocation's pinned catalog. Execute canonicalizes and validates the
exact request, invokes only the catalog-defined target through the broker, and appends a
redacted request/result provenance record.

## Context

The gateway is the product's safe alternative to arbitrary network tools. Search output
is not authority, descriptions are versioned, and execution never accepts a raw URL,
header, credential, shell command, or operation outside the captured catalog.

## Deliverables

- `packages/tool-gateway` API, catalog search/describe views, execute validator, and
  canonical request digest.
- Broker integration, response limits, typed service errors, and provenance events.
- `make verify-E5-T06` with read/write, malformed, timeout, and exfiltration fixtures.

## Acceptance criteria

- [ ] `make verify-E5-T06` passes cold and replays identical gateway calls twice to the
      same search ordering, request digests, redacted result events, and final digest.
- [ ] Search is deterministic and tenant/catalog scoped; describe returns the exact pinned
      schema and risk metadata by operation/version id.
- [ ] Execute accepts only `{operationId, catalogVersion, input}`; unknown fields, raw
      destinations, headers, credentials, and schema-invalid inputs are refused before
      broker or network activity.
- [ ] The outbound method, destination, headers, and credential purpose are derived solely
      from the pinned operation plus authorized connection; user input can fill only
      declared parameters.
- [ ] Request/result events retain canonical input/result hashes, timing, status, policy
      ids, and service error class while redacting configured sensitive fields and all
      credential material.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (headless tool gateway) +
      mitigation: cold-clone gateway replay, schema/exfiltration corpus, redaction scans,
      and canonical request-digest assertions`.

## Adversarial verification

1. Attempt URL/header/method smuggling, prototype pollution, duplicate JSON keys, schema
   ambiguity, oversized inputs, and response bombs. Any out-of-catalog request refutes.
2. Search and execute foreign tenant/catalog/connection ids. Error shape and stream heads
   must not reveal existence.
3. Put canaries in declared sensitive inputs and service responses. One raw canary in logs,
   streams, errors, or evidence is a finding.
4. Mutate the destination derivation in a scratch worktree. The outbound capture fixture
   must make `verify-E5-T06` fail.

## Verification log
