# Slack Clone Durable Streams Demo

Slack-style two-user chat demo backed by the Durable Streams emulator from the `BLamy/emulate` git submodule.

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

Open `http://127.0.0.1:5175/?room=demo&persona=Ada` and `http://127.0.0.1:5175/?room=demo&persona=Linus` in two windows. A message sent in either window is appended to the durable stream and reflected in the other window.

## Verify

```bash
pnpm test
```

## Replay Recordings

```bash
pnpm record:replay
```

The script starts the Durable Streams emulator and chat app, runs two concurrent Replay Chromium Playwright workers in the same room, uploads the new local Replay recordings, and writes local upload metadata to `recordings/latest.json`.
