# AGENTS.md — how agents build Stream Slack

This is the operating manual for every human or agent working in this repository.
`ROADMAP.md` defines the product and epic order. `.eforest/tasks/QUEUE.md` is the
generated source for what may start next. `.eforest/loop.md` defines the
builder/critic loop. This file turns those contracts into day-to-day rules.

The target is a Slack-shaped workspace where humans and agents are first-class members.
An agent may join channels, be mentioned, and post replies like a person. Execution is
not implicit in that identity: every invocation is a separately authorized, fenced,
auditable `AgentRun`. Durable Streams are authoritative for workspace facts and run
history. Query stores, caches, and search indexes are disposable projections.

## The one rule

A builder saying a task works is a claim. Reproducible evidence is proof material. A
task becomes `verified` only when a fresh critic fails to refute the claim against the
task specification, the exact diff, and the cited evidence.

For server work, the primary evidence is a deterministic stream dump, offsets,
canonical state digests, and cold-start command output. For browser work, it is the same
stream evidence plus one final Replay Chromium session that produces both an uploaded
Replay recording and its same-session MP4. A screenshot or a passing test summary is
supporting context, never a replacement for an interrogable run.

## Product invariants

These rules outrank implementation convenience:

1. **Durable Streams are authority.** A message append is the source fact. Agent
   invocations, replies, tool calls, approvals, configuration revisions, and audit
   records cite source stream offsets and digests. A database may project state but may
   not become hidden authority.
2. **Cross-stream effects are idempotent sagas.** Durable Streams do not imply
   multi-stream transactions. Derive deterministic effect IDs from source references,
   append idempotently, and reconcile until complete.
3. **Agents are principals; runs are capabilities.** Humans, agents, and service
   principals share the workspace membership model. Only a run-scoped capability may
   start a sandbox, call a harness, use a connection, or post as an agent.
4. **Configuration is versioned and snapshotted.** Every invocation records the exact
   agent configuration, harness, sandbox, connection grants, policies, and provider
   revisions it received. Later edits cannot silently change a live run. Revocation
   still fences it immediately.
5. **Providers sit behind contracts.** Orchestration depends on `SandboxProvider`,
   `HarnessProvider`, and `CredentialBroker` interfaces, never provider-specific
   branches. Fly Sprites is the first production sandbox. Codex and Claude Code are the
   first harnesses. AlmostNode is a final reach provider and may not distort the server
   contracts.
6. **Credentials stay outside the sandbox.** Production credential use goes through
   Infisical Agent Proxy. The platform stores references and policy metadata, not secret
   values. Real upstream credentials may not enter prompts, environment variables,
   files, transcripts, tool arguments, results, logs, evidence, or Durable Streams.
   Infisical Agent Vault may serve as a local compatibility fixture; the ordinary
   Infisical caching Proxy is not a credential broker and is not a substitute.
7. **Brokered does not mean harmless.** A proxy prevents disclosure of a credential; it
   does not prevent abuse of an allowed credential. Destination policy, action scope,
   quotas, redaction, and exact-request approvals remain mandatory.
8. **Server first.** Epics 0–7 establish the event machine, workspace, agent control
   plane, dispatcher, Fly sandbox, credentials/tools, harnesses, and production
   resilience. Product UI work starts only after the Epic 7 server release gate.
9. **Preserve the working demo through a strangler migration.** The current Node server,
   vanilla client, Auth0 emulator, Durable Streams emulator, and two-session Playwright
   flow stay runnable while testable packages replace internals. Do not begin with a
   big-bang rewrite.

## Trust boundary

Assume the model, harness, tools, repository contents, chat content, imported service
descriptions, and sandbox are compromised. Trust only the authenticated platform API,
Durable Streams gateway, identity provider, orchestration control plane, Infisical Agent
Proxy, and sandbox-provider control plane within their narrow roles.

The MVP is not end-to-end encrypted. Operators with infrastructure access can inspect
workspace content; product documentation and UI must not imply otherwise.

Every relevant task attacks at least the applicable members of this matrix:

- raw-secret canary exfiltration and secret leakage through output or evidence;
- proxy bypass, SSRF, redirects, DNS rebinding, metadata IPs, and private-network access;
- cross-tenant, cross-agent, cross-channel, and cross-connection confused-deputy use;
- human/agent identity spoofing and owner/agent privilege confusion;
- duplicate triggers caused by message edits, redelivery, replay, or worker races;
- stale leases and capability replay after cancel, timeout, disable, or revoke;
- private-channel context leakage;
- recursive agent mentions, delegation cycles, and unbounded cost;
- approval time-of-check/time-of-use changes;
- persistent-sandbox residue and cross-run data inheritance;
- harness or bootstrap supply-chain substitution;
- malformed/unknown event versions and reducer poisoning;
- slow consumers, output floods, process trees, and fork bombs.

## Canonical topology

The exact versioned schema lands in E0, but task planning uses this authority map:

- `workspace:<id>/directory` — principals, channels, memberships, roles, and references;
- `channel:<id>` — message timeline, edits, threads, reactions, and structured mentions;
- `agent:<id>/config` — immutable agent configuration revisions and lifecycle;
- `workspace:<id>/invocations` — deterministic invocation requests and queue facts;
- `run:<id>` — lease, harness, tool, approval, artifact, cost, and terminal events;
- `connection:<id>/config` — service metadata, credential references, and policy versions;
- derived indexes — rebuildable projections whose loss does not lose source facts.

## Roles

**Builder** — implements exactly one eligible ticket. The builder may self-test freely,
but finishes by recording a final evidence run and writing a falsifiable claim.

**Critic** — a fresh agent/session that did not implement the ticket. The critic does not
fix product code. It tries to falsify every acceptance criterion, maps evidence to the
diff, reruns the task's attacks with independent inputs, and proves the verification
apparatus can go red.

The same agent may fill both roles on different tickets, never on the same ticket.

## Task lifecycle

```text
pending → in-progress → implemented → verified
                              ↘ refuted → in-progress
```

Status lives in each task's `readme.md` frontmatter. Only the critic sets `verified`.
After any status or dependency change, run:

```sh
python3 tools/build_queue.py
```

Commit the task readme and regenerated queue together. There is one active queue gate at
a time. Every dependency must be `verified` before a task starts; a bare epic dependency
means that epic's capstone must be verified.

Project state lives in `.eforest/project.json`:

- `building` — the queue may advance;
- `paused` — only a human may resume it;
- `invalid_loop` — verification cannot progress honestly; record the reason and stop;
- `complete` — every required ticket and final capstone is verified.

Never route around `paused` or `invalid_loop`.

## Builder protocol

1. Read `.eforest/project.json`, `.eforest/tasks/QUEUE.md`, and the complete top eligible
   task. Confirm no other task is active.
2. Inspect `git status --short --branch`. Existing changes belong to the user or another
   worker unless proven otherwise. Do not overwrite, clean, stage, or reformat them.
3. Set only the selected task to `in-progress`, regenerate the queue, and commit that
   transition when the workflow calls for publication.
4. Keep scratch scripts, provider responses, logs, and exploratory artifacts inside the
   task folder's `work/` directory. It is gitignored. Do not use the repository root as a
   scratchpad.
5. Implement the smallest coherent task. Respect the task's declared write scope and
   adapter boundaries.
6. Run gates from cheapest to most expensive. A fix after any failure restarts the
   sequence:

   ```sh
   pnpm format:check
   pnpm lint
   pnpm typecheck
   pnpm test
   pnpm build
   ```

   The current prototype predates some gates. A command applies once its defining task
   lands it. Before then, `pnpm test` plus task-local commands are the baseline; a missing
   gate is never reported as a pass.
7. For stream/server work, record a cold-start final run, source offsets, canonical
   digest(s), replay/rebuild result, and sensitivity proof in `evidence/`.
8. For browser-impacting work, the final run must:
   - drive the real UI with pointer/keyboard events;
   - assert zero console errors and no unhandled request failures;
   - expose and compare relevant stream offsets/digests in the DOM;
   - use Replay Chromium once to produce both the uploaded Replay recording and the
     same-session MP4;
   - exercise error, cancellation, or removal paths changed by the diff.
9. Append a builder entry to `## Verification log`: exact commit, commands, evidence
   paths, offsets/digests, recording URL and MP4 path when applicable, plus the claim.
   Server-only claims state `Replay: N/A (<reason>) + mitigation` explicitly.
10. Set `status: implemented`, regenerate the queue, and hand the exact diff and evidence
    to a fresh critic.

## Evidence boundaries in this repository

`pnpm test` is the routine local baseline. `pnpm record:replay` performs external uploads,
writes recording metadata/media, and may clear test artifact directories. Run it only
when the selected task requires browser evidence and external recording is authorized;
it is not a harmless substitute for the normal test command.

Durable evidence belongs in `evidence/` and is committed: event fixtures, digest files,
redacted conformance output, and promoted traces. Raw secrets, provider tokens, session
cookies, unredacted HTTP captures, and customer content are forbidden.

Every browser claim cites the uploaded Replay URL as durable proof and names the local
MP4 for quick visual review. If Replay upload fails, report the failure; never invent a
URL or silently present the MP4 as equivalent.

## Critic protocol

1. **Orient.** Read the task, its dependency contracts, the exact diff, and the builder's
   evidence manifest before running anything.
2. **Predict first.** For every acceptance criterion, write a falsifiable prediction and
   the narrow observation that would refute it.
3. **Reproduce.** Replay cited stream dumps, compare claimed digests, and verify the
   evidence came from the claimed commit and cold configuration.
4. **Attack independently.** Run every adversarial item using new IDs, timing, seeds, and
   canaries. Add at least one plausible attack not listed by the builder.
5. **Audit coverage.** Classify each changed behavior as executed, explicitly waived
   (types/config/logging with reason), dead, or requiring new evidence.
6. **Prove sensitivity.** In a disposable worktree, introduce a targeted defect and show
   the claimed task verifier fails. A detector that cannot go red is refuted even when
   the happy path is green.
7. **Interrogate browser evidence.** Use the uploaded Replay recording for browser
   claims: console, network, exceptions, interaction timeline, source execution, and
   stream correlation. Do not replace that recording with a fresh unrelated rerun.
8. **Issue a verdict.** First line is `VERDICT: verified | refuted | needs-evidence`.
   Every finding cites a diff hunk, command result, stream offset/digest, or Replay point.
   Append it to the Verification log, update status, regenerate the queue, and commit.

## Queue, branches, and concurrent work

- One queue gate is active. Parallel agents may investigate or criticize independently,
  but may not implement later dependency tasks.
- One ticket owns one focused branch and one task folder. If scope grows beyond one
  coherent session/day, split the ticket rather than weakening acceptance criteria.
- Hardcoded prototype ports collide. Ticket work that starts services must allocate
  task-local ports and record them in `work/`.
- Never write task artifacts into another ticket's `work/` or `evidence/`.
- Do not edit the pinned `emulate` submodule unless a ticket explicitly owns that
  dependency and its separate instructions have been read.

## Stacked PRs and merge authority

Verified ticket branches may be published as stacked PRs. A request to continue, ship,
publish, open a PR, or finish a ticket is not permission to merge. Keep the stack open
until the human explicitly asks to merge the relevant PR or stack in the current request.

Use `kitlangton/stack` for stack inspection, synchronization, and every authorized merge:
`stack status`, dry-run `stack sync`, then `stack sync --apply` for maintenance. After an
explicit merge request, inspect `stack merge` and apply with `stack merge --apply` only
when the plan matches. Do not substitute `gh pr merge`, a direct trunk push, or another
merge path. If `stack` is unavailable, stop and report it.

Every PR body declares evidence with either Replay recording links or the literal form
`Replay: N/A (<reason>) + mitigation` and the stream/cold-run artifacts standing in.

## Definition of done

A ticket is done only when:

- its deliverables and every acceptance criterion are implemented;
- required gates pass from a cold, documented state;
- evidence is redacted, committed where appropriate, and tied to the exact diff;
- a fresh critic has failed to refute correctness, evidence sufficiency, and detector
  sensitivity;
- status is `verified` and the regenerated queue is committed;
- any publication requested by the workflow is complete, without inferring merge
  authority.

