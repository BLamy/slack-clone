# Stream Slack task system

All planned work is represented by task folders under epic folders. `../../ROADMAP.md`
defines the capability stack, `../loop.md` defines the builder/critic state machine, and
`QUEUE.md` is generated from task frontmatter.

## A task is a folder

```text
.eforest/tasks/epic-3-the-dispatcher/E3-T02-mention-reconciler/
  readme.md      specification and append-only Verification log
  work/          disposable task-local probes and logs; gitignored
  evidence/      redacted durable proof and promoted fixtures; committed
```

Create `work/` and `evidence/` when a ticket starts or when its evidence needs them; empty
directories are not required in Git. Nothing in `work/` is completion evidence.

## Queue rules

Regenerate `QUEUE.md` with:

```sh
python3 tools/build_queue.py
python3 tools/audit_backlog.py
```

- Priority is `epic × 100 + task`; E0 uses 1, 2, … and E10 uses 1001, 1002, ….
- Work the lowest-priority eligible ticket, one active gate at a time.
- A task ID dependency requires that task to be `verified`.
- A bare epic dependency such as `E4` requires that epic's capstone to be `verified`.
- `implemented` awaits a fresh critic; `refuted` returns to builder rework.
- Do not edit generated queue contents by hand.

## Frontmatter and body

```markdown
---
id: E3-T02
epic: 3
title: Deterministic mention reconciler
priority: 302
status: pending
depends_on: [E1-T06, E3-T01]
estimate: M
capstone: false
---

## Goal
The observable end state.

## Context
Why it exists, authority boundaries, frozen contracts, and what it unlocks.

## Deliverables
- Concrete files, packages, APIs, commands, fixtures, or pages.

## Acceptance criteria
- [ ] Binary behavior with an exact observable and evidence requirement.

## Adversarial verification
1. Concrete manipulation and the condition that refutes the claim.

## Verification log
```

Acceptance boxes stay unchecked. Status and append-only evidence record the lifecycle.

## Writing good tasks

- Specify outcomes, not implementation activity.
- State the authority and trust boundary whenever a ticket crosses streams, identities,
  providers, sandboxes, credentials, tenants, or approvals.
- Every criterion must be objectively falsifiable.
- Require at least one sensitivity attack that demonstrates the verifier fails after a
  targeted defect.
- Server work names stream/cold-run evidence and declares why Replay is not applicable.
- Browser work names Replay recording, same-session MP4, console/network checks, and
  stream offset/digest correlation.
- Split a ticket rather than weakening its proof. Use `E3-T04a`/`E3-T04b` only when a
  discovered seam makes the original ticket too large.
- Secret values and unredacted customer/provider data are never evidence.
