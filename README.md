# Slack Clone Durable Streams Demo

Slack-style two-user chat demo backed by the Durable Streams and Auth0 emulators from the `BLamy/emulate` git submodule.

## Setup

```bash
git submodule update --init --recursive
pnpm install
pnpm setup:emulate
```

## Run

```bash
pnpm dev
```

Open `http://127.0.0.1:5175/` for the homepage, then choose **Open demo room** to enter the chat at `http://127.0.0.1:5175/app?room=demo`. The chat route redirects to the local Auth0 Universal Login connection picker when there is no session. Choose the seeded username/password connection and sign in with `ada@example.test` or `linus@example.test` using password `DemoPass123`; the GitHub and Google buttons are deterministic local social-connection fixtures. Messages are appended to the durable stream, reflected in the other window, and can be edited by their author with the update persisted as another stream record.

The client is React 19 with Vite, React Aria, shadcn-style components, and Storybook. Node remains the authenticated API, SSE, and static-serving boundary; `pnpm dev` builds the client into `dist/client` before starting the stack. For fast client iteration, run `pnpm dev:client` on port 5173 while the Node stack is running; Vite proxies auth and API requests to port 5175. Storybook is available with `pnpm storybook`, and its browser interaction suite runs with `pnpm test:storybook`.

The local services are configured together in [`emulate.config.yaml`](emulate.config.yaml). `pnpm dev:emulate` loads that file and starts Durable Streams, Auth0, and the Cloudflare OS proxy from their configured ports. The Cloudflare OS entry is disabled by default because its `source` must point to a local checkout of the official `cloudflare-os` repository; enable it after setting that path:

```yaml
cloudflare-os:
  port: 4102
  runtime:
    enabled: true
    source: ../cloudflare-os
    port: 8787
    startup_timeout_ms: 120000
```

The Cloudflare package launches the checkout's official `pnpm run-local` Wrangler runtime and proxies it locally; it is development infrastructure and does not replace the real-provider `make verify-E4-T08-real` gate.

## Verify

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:conformance
pnpm test:integration
pnpm test:concurrency
pnpm build
```

`pnpm build` produces both the Vite client bundle and the backend build manifest. `pnpm test` runs the backend unit and integration gates; `pnpm test:storybook` and `pnpm build-storybook` cover the component surface separately.

`pnpm verify` composes the E0-T03 gates in that order. `make verify-E0-T03` additionally
installs the frozen lockfile and builds the pinned emulator before running the composed
verification. Test runs allocate their own emulator, Auth0, and app ports and keep all
generated output under `.artifacts/e0-t03/<run-id>/`; set `EMULATE_PORT`, `AUTH0_PORT`,
`APP_PORT`, and `TEST_ARTIFACT_DIR` only when a caller needs explicit assignments.
Default allocations hold atomic per-port leases in the system temporary directory until
the emulator, Auth0, and app have bound, preventing independent verification processes
from selecting the same probed block.

The extracted backend dependency direction and capability boundaries are documented in
[`docs/backend-packages.md`](docs/backend-packages.md). The official client adapter,
opaque checkpoint contract, request budget, and server-only token boundary are documented
in [`docs/durable-streams-adapter.md`](docs/durable-streams-adapter.md).

## Replay Recordings

```bash
pnpm record:replay
```

The script starts the Durable Streams and Auth0 emulators plus the chat app, runs two concurrent Replay Chromium Playwright workers in the same room, uploads the new local Replay recordings, and writes local upload metadata to `recordings/latest.json`. It also enables Playwright video for the run and writes a side-by-side MP4 proof under `recordings/`.

Replay recording is intentionally separate from routine verification. None of the
format, lint, static-analysis, unit, conformance, integration, concurrency, build, or
composed E0-T03
commands upload a Replay, open a tunnel, or mutate existing recordings.
