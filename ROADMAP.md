# Stream Slack roadmap

## North star

Build a self-hostable Slack-shaped workspace where humans and AI agents work in the same
channels as first-class members. Mentioning an enabled agent creates a durable,
observable run. The workspace owner chooses the agent's harness (Codex or Claude Code),
sandbox (Cloudflare OS first; AlmostNode as a final reach), instructions, context policy,
budgets, and service connections.

The product borrows Buzz's useful product bet—people, agents, workflows, project context,
and evidence belong in one workspace—but replaces Nostr events and relay distribution
with workspace-scoped Durable Streams. It borrows Executor's onboarding shape—add an
integration, create a connection, review policy, then expose search/describe/execute to
every harness—while keeping credentials behind Infisical Agent Proxy.

## Design references

- [Block Buzz architecture](https://github.com/block/buzz/blob/main/ARCHITECTURE.md) —
  humans and agents as peers in one event-backed workspace; this project substitutes
  Durable Streams and workspace-scoped server authority for Nostr.
- [Executor](https://github.com/UsefulSoftwareCo/executor) — separate integration,
  connection, policy, and shared tool-catalog concepts.
- [Infisical Agent Proxy](https://infisical.com/blog/agent-proxy) and
  [Agent Vault](https://github.com/Infisical/agent-vault) — production and local
  credential-brokering references.
- [Cloudflare OS](https://github.com/cloudflare/cloudflare-os/tree/main) — the first
  production sandbox reference: isolated Gadgets on Dynamic Worker Facets, Durable Object
  workspaces, and capability-based Gatekeepers for controlled external access.
- AlmostNode is the local reach reference for `@agent-wasm/sdk` and browser-hosted
  harness adapters. It is not vendored here, so cold-clone task contracts cannot depend
  on reading that adjacent checkout at runtime.

## The architectural bet

The chat timeline is not merely an interface to an agent runner. It is the durable source
of the request, context, progress, approvals, result, and provenance.

```text
channel message @agent
        │ source offset + digest
        ▼
mention reconciler ── deterministic invocation ──► durable run queue
                                                     │ fenced lease
                                                     ▼
                                           sandbox provider (Cloudflare OS first)
                                                     │
                                  credential broker ◄┼► harness (Codex/Claude)
                                                     │ normalized events
                                                     ▼
agent reply + run reference ───────────────────► channel stream
```

There is no multi-stream transaction fiction. Reconcilers consume source references and
perform idempotent, retryable effects. A live projection can always be deleted and rebuilt
from source streams to the same canonical digest.

## Domain model

- `Principal` — stable workspace actor with type `human`, `agent`, or `service`.
- `WorkspaceMembership` and `ChannelMembership` — human and agent access use the same
  membership path; an agent owner is provenance, not an authorization shortcut.
- `Message`, `MessageRevision`, `Thread`, `Reaction`, `Mention` — structured chat facts.
- `AgentDefinition` and immutable `AgentRevision` — harness, sandbox, instructions,
  context, budgets, triggers, and connection-grant references.
- `Invocation` — deterministic effect requested from a message mention.
- `AgentRun` and `RunAttempt` — fenced lifecycle, output, tool calls, approvals, costs,
  artifacts, and terminal state.
- `SandboxProvider` — capability discovery, provision, materialize, exec/stream, cancel,
  checkpoint/restore, network policy, destroy, and health.
- `HarnessProvider` — prepare, start, stream normalized events, request approval, cancel,
  resume when explicitly supported, and normalize exit.
- `ServiceDefinition`, `ServiceConnection`, and `CredentialBinding` — versioned service
  schema, an authenticated instance, and an Infisical reference/policy; never a stored
  secret value.
- `CredentialBroker` — validate a binding, mint a short-lived run-scoped proxy session,
  revoke it, and prove redaction.

## Security posture

Models and sandboxes are untrusted. The credential broker runs outside them. A run
receives only a short-lived proxy capability constrained to tenant, agent, run,
connection, destination, and expiration. Direct egress is default-deny. Destructive tool
calls require an approval bound to the exact normalized input digest; changing one byte
invalidates approval.

The architecture must prove both:

1. the agent cannot learn the upstream credential; and
2. the agent cannot use a permitted connection outside its granted action, destination,
   tenant, run, budget, or approval.

## Capability stack and release gates

### Epic 0 — The Ledger

Turn the prototype into a testable, replayable event machine without breaking the current
demo. Freeze the event envelope and stream topology, extract the backend through a
strangler boundary, adopt the official Durable Streams client/live-read semantics, add
fenced idempotent dispatch, pure reducers, canonical digests, a replay CLI, and
crash/duplicate/partition tests.

**Capstone:** two writers race one stream, the server restarts, and replay from offset
`-1` exactly matches live state without an in-memory map or projection acting as hidden
authority.

### Epic 1 — The Workspace

Build the server-side Slack domain: stable principals, tenant-scoped workspaces and roles,
public/private channels, memberships, message threads/reactions/edits/deletes, resumable
live reads, structured mentions, and rebuildable projections.

**Capstone:** two humans and an inert agent member use public and private channels through
the API; authorization, reconnect, and exact replay all hold.

### Epic 2 — The Roster

Make an agent a manageable workspace member. Freeze versioned agent configuration,
immutable revisions, management API/CLI, administration permissions, provider capability
negotiation, membership/presence, and invocation snapshots. Configurations select adapter
IDs; they cannot carry provider-specific secrets or arbitrary environment maps.

**Capstone:** create, configure, reconfigure, disable, and revoke an agent entirely
through server APIs, proving older revisions remain immutable and live runs are fenced.

### Epic 3 — The Dispatcher

Turn a validated mention into exactly one durable run. Add the invocation/run reducer,
mention reconciler, queue and fenced leases, bounded context packs, batching and recursion
guards, cancellation/retry/budget policy, and provenance-bound agent replies.

**Capstone:** a deterministic fake sandbox and harness complete mention → run → threaded
agent reply across injected crashes at every saga boundary with one logical execution.

### Epic 4 — The Cloudflare OS Sandbox

Define the provider-neutral sandbox contract and make Cloudflare OS the first real
implementation. Cover tenant-safe workspace/Gadget control-plane addressing, pinned
workspace materialization, streaming execution, process-tree cancellation, default-deny
egress through explicit Gatekeepers, ephemeral/persistent modes, checkpoints, quotas, cost
events, and orphan collection.

**Capstone:** a real Cloudflare OS workspace/Gadget passes the provider conformance suite
from cold config, including restart, restore, cancel, revoke, and destroy with no public
app URL.

### Epic 5 — The Switchboard

Build the Infisical Agent Proxy and Executor-like service plane. Freeze service,
connection, secret-reference, and grant models; mint short-lived run proxy identities;
bootstrap the proxy into Cloudflare OS Gatekeepers; import OpenAPI and MCP integrations; expose one
search/describe/execute gateway; bind mutation policy to exact approvals; and prove
cross-tenant isolation, rotation, revocation, and redaction.

Infisical Agent Vault may be used as a local open-source fixture. The normal Infisical
caching Proxy is explicitly out of scope because it returns secret API responses to its
client rather than brokering an agent's upstream request.

**Capstone:** a real brokered service call rotates its upstream secret mid-test while the
agent continues working and no real credential appears anywhere inside or emitted by the
sandbox.

### Epic 6 — The Harnesses

Normalize Codex and Claude Code behind one harness protocol. Pin and attest installations,
stream common lifecycle/tool/artifact/approval events, give both the same run-scoped
service catalog, enforce fresh-session context, and normalize cancellation and exit.

**Capstone:** two configured agent members—one Codex, one Claude Code—run on Cloudflare OS, use the
same brokered gateway, and reply with exact config/run/tool provenance.

### Epic 7 — The Watchtower

Earn the production server gate before expanding the UI: multi-replica scheduling,
reconciliation, backpressure, quotas, persistent sessions, complete tenant isolation,
redacted metrics/traces, export/rebuild/migrations, an adversarial security suite, and
least-privileged deployment identities.

**Server release:** two API replicas and two workers survive kill, rotate, cancel, and
revoke operations during real Codex and Claude runs on Cloudflare OS plus Infisical Agent Proxy,
then replay to the same digest with no duplicate reply or tool effect.

### Epic 8 — The Room

Build the Slack client only after the server gate: authenticated workspace shell,
channels/DMs/roster, full message interactions, structured mention composer, inline run
progress, approvals/cancel/retry, and accessible responsive behavior.

**Capstone:** two humans mention a real agent, approve one exact mutation, reconnect, and
observe matching DOM/server offsets and digests in a clean Replay recording.

### Epic 9 — The Front Door

Create the Executor-like onboarding experience: agent wizard, harness/sandbox picker,
service import and version review, Infisical binding, policy/grants, a sanitized
connection test, and audit/rollback/revoke controls.

**Capstone:** a clean workspace onboards a service once, grants a subset to one new agent,
runs an approved mutation, and proves another agent cannot use the connection.

### Epic 10 — The Hive

Expand toward the useful Buzz surface on Durable Streams: message/reaction/schedule/
webhook workflows, approvals and timers, ACL-aware unified search, Electric Forest
project references, branch-as-room timelines, content-addressed artifacts, and explicitly
granted agent-to-agent delegation.

**Capstone:** an issue/message triggers agent work, patch/test evidence returns to its
room, a human approves the exact result, and every hop is cross-linked by durable
offset/digest with no Nostr, Git, or database record acting as hidden authority.

### Epic 11 — The Browser Computer (reach)

AlmostNode is intentionally last and is not on the production Cloudflare OS critical path. First
classify its weaker browser trust/isolation and unsupported OS surface. Only then register
`almostnode-browser` behind the unchanged sandbox contract, prove lifecycle/network/
resource behavior, bridge Codex and Claude where feasible, and integrate brokered egress.

Current reference surfaces include `@agent-wasm/sdk` for workspace/agent lifecycle and
`@agent-wasm/codex` for browser-hosted Codex. Claude-in-browser is a feasibility gate,
not an assumed capability.

**Reach capstone:** change only an existing agent's sandbox provider from Cloudflare OS to
AlmostNode and pass the same mention/tool/approval/reply scenario across the two-harness ×
two-sandbox matrix. A documented infeasibility may stop this reach without weakening the
Cloudflare OS production release.

## Dependency spine

```text
E0 → E1 → E2 → E3 ─┬→ E4 ─┐
                    └→ E5 ─┴→ E6 → E7 → E8 → E9 → E10 → E11 (reach)
```

E4 and E5 may progress in parallel after E3 because their contracts meet at E6. All
browser product work is downstream of E7. E11 cannot be pulled forward to solve a server
contract and must not become a hidden prerequisite for the Cloudflare OS path.

## Explicit non-goals for the first server release

- Nostr compatibility, cross-relay federation, portable Nostr identities, or gossip;
- end-to-end encrypted channels;
- arbitrary provider plugins before the fake/Cloudflare OS and Codex/Claude matrices are proven;
- giving a model raw credentials for convenience;
- an autonomous agent bypass around exact approvals;
- making browser sandbox isolation claims equivalent to Cloudflare OS worker isolation;
- replacing the current demo before its behaviors have migrated behind tested seams.

## Definition of the product milestones

- **Agent backend MVP:** E3 capstone—mentions drive a durable fake run exactly once.
- **Real agent backend:** E6 capstone—Codex and Claude run on Cloudflare OS with brokered services.
- **Production server:** E7 capstone—multi-replica, recoverable, secure, observable.
- **Usable Slack agent product:** E9 capstone—UI plus first-class onboarding.
- **Buzz-like workspace:** E10 capstone—workflows, project context, delegation, evidence.
- **Browser reach:** E11 capstone—AlmostNode earns adapter parity without weakening the
  earlier Cloudflare OS gates.
