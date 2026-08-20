VERDICT: refuted

## Finding E5-T02-CRITIC-BA08576-001 — high

The exact verifier is not sensitive to the public credential-schema branch required by
the task. In a disposable checkout at exact head `ba08576`, removing only the
`percentEncodedCredentialShape` reference at
`packages/connections/src/schemas/connection-events.v1.schema.json:179` left
`make verify-E5-T02` green (exit 0, with the same state/replay digests). The independent
Ajv 2020 matrix against that mutated schema found 15 cases where the public schema
accepted data that runtime normalization and `createConnectionStore` rejected with
`CONNECTION_CREDENTIAL_MATERIAL`; no mutated case appended an event. The clean schema
passes all 73 independent cases, so this is a verifier-coverage failure rather than a
current clean-head runtime/schema mismatch.

The required runtime mutations were sensitive: zero decoding passes and removal of the
provider-token detector each made the exact verifier exit 2 at its secret-corpus
assertion. The unmutated independent matrix also covered raw/mixed/double percent JSON,
password/secret/client-secret/private-key assignments and prefixes, URLs, all requested
`ghp`, `sk`, `rk`, `pk`, `github_pat`, and `xox[baprs]` families, confusables, all eight
format-control cases, base64/base64url, and the ordinary percent positive control with
zero clean-head findings.

All functional gates passed: the cold verifier, 209 unit tests, 15 emulator/Playwright
tests, formatting, lint, type/boundary analysis, build, and `git diff --check`. Independent
lifecycle/capture/rotation/disable/delete, duplicate/reordered replay, authorization,
resource-bound, and leak checks passed. Replay: N/A (server connection model) +
mitigation: cold-clone reducer replay, secret-shaped input corpus, authz matrix, exact
lifecycle digests, independent Ajv/runtime/store parity, and sensitivity mutations.

Product code and `emulate` were not modified by this critic.
