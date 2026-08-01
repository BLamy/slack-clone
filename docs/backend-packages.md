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

`tools/check-boundaries.mjs` verifies both package manifests and source imports. A later
provider or framework migration must preserve this direction or deliberately amend the
contract in a ticket that owns the boundary.
