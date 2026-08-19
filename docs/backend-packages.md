# Backend package boundaries

E0-T02 wraps the working server with a one-way dependency spine. The browser contract is
unchanged; `src/server.mjs` remains the composition root while later tickets replace the
packages behind these interfaces.

```text
src/server.mjs (composition, auth HTML, static files, environment)
  ├─ @stream-slack/http (HTTP JSON and SSE delivery)
  ├─ @stream-slack/services (message use cases and authorization)
  ├─ @stream-slack/durable-streams (provider access)
  │    ├─ @stream-slack/protocol
  │    └─ @stream-slack/reducers
  ├─ @stream-slack/protocol (pure values and validation)
  └─ @stream-slack/reducers (pure stream materialization)
```

`protocol` and `reducers` are deterministic leaves. They may not import HTTP, filesystem,
network, environment, clock, or provider code and may not read ambient globals for those
capabilities. `durable-streams` receives `fetch` and digest functions from the composition
root. `services` receives the store, ID generator, and clock. `http` receives services,
session lookups, fetch, timer functions, and provider URLs. Only `src/server.mjs` reads
environment variables or selects production adapters.

`tools/check-boundaries.mjs` verifies both package manifests and parser-discovered source
imports. It also inspects lexical references, so aliases, computed property names,
alternate whitespace, comments, and formatter-ignore directives cannot evade the pure
leaf policy. Pure packages may use an explicit allowlist of deterministic language globals
and local relative modules only. Prototype, legacy getter/setter reflection, property
descriptor introspection, call-stack, dynamic-code, metaprogramming, and non-static
computed-property escape hatches are forbidden; static record properties and numeric
literal indices remain available. A later provider or framework migration must preserve
this direction or deliberately amend the contract in a ticket that owns the boundary.

E0-T03 makes the provider boundary executable as well as architectural. The
`durable-streams` package owns the pinned official client and all requests to room-stream
paths. `tools/audit-durable-streams-access.mjs`, included in `pnpm typecheck`, enforces
declared module doors: ambient and dynamically loaded network capabilities stay out of
ordinary runtime source, each door has an exact export surface, browser calls cross the
same-origin `/api/rooms/...` application surface, Auth0 cannot share the provider origin,
and the inbound HTTP door imports only named `createServer`. The adapter's opaque
checkpoint, live-follow, cancellation, retry, and credential rules are documented in
[`durable-streams-adapter.md`](durable-streams-adapter.md).
