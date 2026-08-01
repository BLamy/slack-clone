---
id: FE0-T06
epic: FE0
title: Message timeline, composer, and thread surfaces
status: pending
depends_on: [FE0-T03, FE0-T05]
---

Build message cards, headers, bodies, actions, reactions, threads, composer, toolbar,
mentions, attachments, link previews, and edit forms from local fixtures. Stories must
cover owner/non-owner actions, edited/conflicted messages, long content, sending,
failure, and keyboard composer behavior. The thread fixture must show an AI response
as an explicit selectable surface; selecting it opens the complete, redacted run log
panel for that agent response.

Current Storybook composition: `stream-slack-threads--thread` covers the empty run-log
selection, `stream-slack-threads--thread-with-run-log` covers the selected response and
run timeline, tool calls, and raw log, and the same story is captured at a narrow
viewport. Backend activation remains out of scope until the frontend approval gate
passes.
