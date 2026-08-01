---
id: FE0
title: Storybook component workbench
status: pending
approval_gate: true
backend_wiring: prohibited
---

# Frontend Epic 0 — The Storybook Workbench

## Goal

Map and implement the reusable Stream Slack frontend language in Storybook before it
is connected to the Node server. Storybook is the review surface for component
contracts, visual variants, accessibility behavior, and responsive composition. The
backend remains out of scope until the screenshot set is approved.

## Authority and boundaries

- `src/components/ui/` contains shadcn-generated React Aria primitives.
- `src/index.css` owns semantic OKLCH tokens and the light/dark theme map.
- `src/stories/` owns fixture-driven component and composition stories.
- `frontend/epic-0-storybook-components/component-inventory.md` is the initial catalog.
- `.eforest/tasks/QUEUE.md` remains the server queue and is intentionally unchanged by
  this frontend exception.
- Stories may use static fixtures and local state, but must not call `/api`, SSE, Auth0,
  Durable Streams, or Replay upload services.

## Review loop

1. Define the component contract and states in a story.
2. Render the light, dark, system, keyboard, responsive, and failure variants that
   apply to the component.
3. Capture screenshots from the local Storybook build and inspect console/network
   health.
4. Present the screenshots for human approval.
5. Only after approval compose the component into the React pages and wire the existing
   backend APIs.

## Task map

| Task | Scope | Storybook output |
| --- | --- | --- |
| FE0-T01 | Tokens, themes, brand, typography | Theme matrix and brand surfaces |
| FE0-T02 | Actions, identity, status, feedback primitives | Buttons, badges, avatars, tooltips, focus states |
| FE0-T03 | Fields and form semantics | Text fields, search, selects, comboboxes, validation |
| FE0-T04 | Navigation and overlays | Sidebar pieces, menus, dialogs, command palette, responsive nav |
| FE0-T05 | Workspace shell | Desktop, tablet, and mobile workspace compositions |
| FE0-T06 | Messaging | Timeline, composer, threads, reactions, attachments, edits |
| FE0-T07 | Agent/run surfaces | Agent identity, run progress, tools, approvals, provenance |
| FE0-T08 | Front door and administration | Homepage, login, onboarding, providers, connections, policies |
| FE0-T09 | Feedback states | Loading, empty, error, offline, and recovery states |
| FE0-T10 | Review harness | Screenshot matrix, keyboard paths, a11y and viewport checks |

## Exit criteria

- Every catalog entry has an owner task and a named Storybook story family.
- Each story family covers applicable light/dark/system, focus/keyboard, disabled,
  loading, error/empty, and narrow/wide variants.
- Stories use React Aria semantics and do not hide focus or status information behind
  color alone.
- `pnpm exec tsc --noEmit`, `pnpm build`, `pnpm build-storybook`, and the Storybook
  test suite pass from a clean install.
- Screenshot artifacts are reviewed in the chat and the human explicitly approves the
  visual direction.
- No page or component in this epic depends on a live backend response.

## Verification log

- 2026-08-01 builder run, commits `195e2a4` and `0eddae5`: `pnpm exec tsc --noEmit`,
  `pnpm build`, `pnpm build-storybook`, and `pnpm test:storybook` passed. The
  Storybook suite reports 1 file and 4 tests passed. `pnpm storybook:screenshots`
  captured five variants in `evidence/`; the manifest records zero console errors
  and zero request failures. Light and dark theme scans report zero accessibility
  violations. `git diff --check` passed.
- `pnpm test` remains blocked in this clean worktree because the pinned `emulate`
  submodule is present only as an uninitialized gitlink and
  `emulate/packages/emulate/dist/index.js` is missing. The submodule was not edited.
  Replay: N/A (approval-gated Storybook-only frontend pass; no backend browser claim)
  + mitigation: the local screenshot harness covers visual, console, request-failure,
  responsive, keyboard-focus, and accessibility checks; backend tests stay deferred
  to the post-approval app branch.
- 2026-08-01 component iteration, commit `510537f`: neutralized agent message
  surfaces, added owner edit/delete actions with inline edit and delete confirmation
  states, removed the sidebar border artifact, and added agent directory, identity,
  and review page compositions. `pnpm exec tsc --noEmit`, `pnpm build`,
  `pnpm build-storybook`, and `pnpm test:storybook` passed; the Storybook suite reports
  3 files and 10 tests passed. `pnpm storybook:screenshots` captured 12 variants with
  zero console errors and zero request failures. Browser accessibility scans reported
  zero violations for message actions, workspace shell, agent directory, identity,
  review, and dark review stories.
- Replay: N/A (Storybook-only component iteration; no backend or external upload was
  authorized) + mitigation: screenshot evidence is committed under `evidence/` and
  backend wiring remains prohibited until human visual approval.
- Human visual approval: pending.
