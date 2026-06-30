import { mkdir, writeFile } from "node:fs/promises";
import { spawnLogged, run, stop, waitForHttp } from "./process-utils.mjs";

const room = `replay-${Date.now()}`;
const appBaseUrl = "http://127.0.0.1:5175";

const emulator = spawnLogged("node", ["emulate/packages/emulate/dist/index.js", "start", "--service", "durable-streams", "--port", "4100"], {
  name: "emulate",
});

const app = spawnLogged("node", ["src/server.mjs"], {
  name: "app",
  env: {
    ...process.env,
    DURABLE_STREAMS_URL: "http://127.0.0.1:4100",
    PORT: "5175",
  },
});

try {
  await waitForHttp(`${appBaseUrl}/api/health`);
  await fetch(`${appBaseUrl}/api/rooms/${room}/messages`, { method: "DELETE" });

  const before = await listRecordings();
  const beforeIds = new Set(before.map((recording) => String(recording.id)));

  await run("pnpm", ["exec", "playwright", "test", "--config", "replay.playwright.config.mjs"], {
    name: "replay-playwright",
    env: {
      ...process.env,
      REPLAY_ROOM: room,
    },
  });

  const after = await listRecordings();
  const created = after.filter((recording) => !beforeIds.has(String(recording.id)));

  if (created.length < 2) {
    throw new Error(`Expected at least 2 new Replay recordings, found ${created.length}`);
  }

  const uploaded = [];
  for (const recording of created.slice(-2)) {
    const result = await run("replayio", ["upload", String(recording.id)], { name: `upload-${recording.id}` });
    uploaded.push({
      localId: recording.id,
      url: findReplayUrl(result.output) ?? recording.url ?? null,
      uploadOutput: result.output,
    });
  }

  const summary = {
    room,
    appBaseUrl,
    durableStreamsUrl: "http://127.0.0.1:4100",
    recordings: uploaded,
    createdAt: new Date().toISOString(),
  };

  await mkdir("recordings", { recursive: true });
  await writeFile("recordings/latest.json", `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await Promise.all([stop(app), stop(emulator)]);
}

async function listRecordings() {
  const result = await run("replayio", ["list", "--json"], { name: "replay-list" });
  const jsonStart = result.output.indexOf("[");
  if (jsonStart === -1) return [];
  return JSON.parse(result.output.slice(jsonStart));
}

function findReplayUrl(output) {
  return output.match(/https:\/\/app\.replay\.io\/recording\/[^\s)]+/)?.[0] ?? null;
}
