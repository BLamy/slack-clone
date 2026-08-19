---
id: E7-T04
epic: 7
title: "Observability and redaction: correlated metrics, logs, traces, and audits without secret or tenant-data leakage"
priority: 704
status: pending
depends_on: [E7-T01]
estimate: L
capstone: false
---

## Goal

Operators can trace one invocation across replicas, queue, sandbox, harness, tool gateway,
broker, and message publication using opaque correlation ids and bounded metrics, while a
central redaction/classification layer prevents credentials, prompts, message content,
tool payloads, and foreign tenant identifiers from leaking into telemetry.

## Context

Agent systems are impossible to operate blind, but naive logging duplicates the most
sensitive data in the system. Structured telemetry must be allowlist-based and tested on
success, provider error, crash, timeout, malformed input, and redaction failure paths.

## Deliverables

- Versioned telemetry schema, correlation propagation, cardinality budgets, and redactors.
- Operator run summary derived from durable events plus metrics/traces for live health.
- `make verify-E7-T04` with canary corpus and snapshot assertions for every subsystem.

## Acceptance criteria

- [ ] `make verify-E7-T04` passes cold and produces byte-stable normalized telemetry
      snapshots and run-summary digest from the same event fixture.
- [ ] Correlation ids link tenant-safe run, lease, sandbox, harness, tool, and publication
      stages without using emails, channel names, prompts, connection ids, provider ids,
      or secret-derived values as metric labels.
- [ ] Logs/traces use explicit allowed fields; message/prompt/tool bodies, model payloads,
      headers, cookies, tokens, credentials, and raw provider errors are absent or replaced
      by typed hashes/counts according to policy.
- [ ] Canary scans cover structured fields, interpolated strings, exception cause chains,
      stdout/stderr, stack traces, sampling/export failure, and debug mode; one leak fails.
- [ ] Telemetry exporter failure cannot block or change run semantics, and bounded local
      buffering cannot grow past its declared byte/event limits.
- [ ] Browser evidence is recorded exactly as `Replay: N/A (server observability layer)
      + mitigation: cold-clone telemetry snapshots, exhaustive canary scans, cardinality/
      buffer limits, failure-path fixtures, and event-derived run-summary parity`.

## Adversarial verification

1. Place distinct canaries in every sensitive source and force each success/error/crash
   path. Scan all emitted formats and exporter buffers byte-for-byte.
2. Generate high-cardinality tenant/run/tool/provider input. Metrics label cardinality and
   memory must remain under the stated bound.
3. Fail, slow, and corrupt the exporter. Run results/digests must remain unchanged and
   local buffers bounded.
4. Bypass one error redactor in a scratch worktree. The matching provider-error canary
   must turn the verifier red.

## Verification log
