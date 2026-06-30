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

Open `http://127.0.0.1:5175/?room=demo` in two windows. Each window redirects to a local Auth0-backed login form. Sign in with seeded users `ada@example.test` or `linus@example.test` using password `DemoPass123`. A message sent in either window is appended to the durable stream and reflected in the other window.

## Verify

```bash
pnpm test
```

## Replay Recordings

```bash
pnpm record:replay
```

The script starts the Durable Streams and Auth0 emulators plus the chat app, runs two concurrent Replay Chromium Playwright workers in the same room, uploads the new local Replay recordings, and writes local upload metadata to `recordings/latest.json`. It also enables Playwright video for the run and writes a side-by-side MP4 proof under `recordings/`.
