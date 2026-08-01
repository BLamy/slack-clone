# Stream Slack

Slack-style two-user chat demo backed by the Durable Streams and Auth0 emulators from the `BLamy/emulate` git submodule. The connected client is React 19 + Vite + shadcn/ui with React Aria behavior; Node remains the auth, API, SSE, and static-serving boundary.

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

Open `http://127.0.0.1:5175/` for the homepage, then choose **Open demo room** to enter the chat at `http://127.0.0.1:5175/app?room=demo`. The chat route redirects to the React login form when there is no session. Sign in with seeded users `ada@example.test` or `linus@example.test` using password `DemoPass123`. Messages are appended to the durable stream, reflected in the other window, and can be edited or deleted by their author with each mutation persisted as another stream record.

For fast client iteration, run `pnpm dev:client` on `http://127.0.0.1:5173`; Vite proxies `/login`, `/logout`, `/app`, and `/api` to the Node server at port 5175. `pnpm dev` builds the client first, then starts the emulator-backed production-shaped stack.

## Verify

```bash
pnpm test
pnpm test:storybook
pnpm build-storybook
```

## Replay Recordings

```bash
pnpm record:replay
```

The script starts the Durable Streams and Auth0 emulators plus the chat app, runs two concurrent Replay Chromium Playwright workers in the same room, uploads the new local Replay recordings, and writes local upload metadata to `recordings/latest.json`. It also enables Playwright video for the run and writes a side-by-side MP4 proof under `recordings/`.

The local Replay QA project is configured in `.replay/config.json`. Keep journey instructions credential-free; use the seeded login shown in the UI when a Replay QA exploration or journey runs.
