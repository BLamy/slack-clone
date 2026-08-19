# .eforest/loop.md — the loop that builds Stream Slack

`.git` stores file history. `.eforest` stores the planned future and the evidence-backed
history of the build. `tasks/QUEUE.md` is the future, task Verification logs and
`evidence/` are the durable past, and this file is the state machine that advances one
into the other.

The full operating doctrine is in `../AGENTS.md`.

## The two roles

**Builder:** takes the top eligible task, implements only that task, runs the full
available gate sequence, and records a final claim with deterministic evidence. Scratch
work lives in that task's `work/`; committed proof lives in `evidence/`.

**Critic:** a fresh session that never implemented the task. It predicts failure modes,
tries to falsify each criterion, audits evidence against the exact diff, proves the
detector can go red, and records `verified`, `refuted`, or `needs-evidence`. Only the
critic can verify.

## The loop

```text
pick top eligible task
        │
        ▼
builder: in-progress → implementation → final claim + evidence
        │
        ▼
critic: falsification + sufficiency + sensitivity
        │
        ├── verified ──► regenerate queue ──► next eligible task
        │
        └── refuted / needs-evidence ──► builder rework, new final run
```

One task is active at a time. A dependency is satisfied only by `verified`. A bare epic
dependency is satisfied only when that epic's capstone is verified.

## Project states

State lives in `project.json`:

- `building` — eligible work may run;
- `complete` — all required tasks and the final capstone are verified;
- `paused` — a human stopped the loop; no agent may inspect, signal, or resume work;
- `invalid_loop` — honest progress is impossible without human judgment.

Set `invalid_loop` when the same substantive refutation repeats through three consecutive
attempts without new evidence of convergence, a required gate can pass only by weakening
it, the queue/task/status records disagree materially, or a security boundary cannot be
met within the ticket's contract. Record the exact reason in `statusReason` and stop.

## Evidence by phase

- E0–E7: cold-start server/CLI commands, stream dumps, offsets, digests, replay/rebuild
  parity, independent races/fault injection, and explicit
  `Replay: N/A (<reason>) + mitigation`.
- E8–E11 browser surfaces: all stream evidence above plus one final Replay Chromium run
  that produces both the uploaded Replay recording and same-session MP4, with zero
  console errors and explicit DOM/server offset-digest correlation.

## Retry discipline

Rework does not patch a verdict in place. The builder returns to the cheapest applicable
gate, reruns all later gates, records new evidence, and appends a new claim. Old
Verification log entries are immutable history. Never delete or rewrite a refutation.

