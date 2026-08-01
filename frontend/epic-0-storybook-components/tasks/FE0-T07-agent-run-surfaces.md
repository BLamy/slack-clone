---
id: FE0-T07
epic: FE0
title: Agent creation, identity, runs, approvals, and provenance
status: pending
depends_on: [FE0-T02, FE0-T05, FE0-T06]
---

Map the agent directory, creation wizard, identity preview, permission review, agent
badges/avatars, run statuses, run timelines, tool calls, approval cards, run controls,
artifacts, provenance references, and audit events. Use sanitized fixtures and make
redaction, exact-request changes, cancellation, and terminal failure visible.

Current Storybook compositions: `stream-slack-agent-studio--directory`,
`stream-slack-agent-studio--identity-form`, `stream-slack-agent-studio--review`, and
`stream-slack-agent-studio--review-dark`. The thread story also exposes the relationship
between an AI response and its selected, redacted run log without calling the backend.
Backend activation remains out of scope until the frontend approval gate passes.
