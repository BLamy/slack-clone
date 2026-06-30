import { readdir, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnLogged, run, stop, waitForHttp } from "./process-utils.mjs";

const room = `replay-${Date.now()}`;
const appBaseUrl = "http://127.0.0.1:5175";
const recordingsDir = path.resolve("recordings");
const testResultsDir = path.resolve("test-results");

const emulator = spawnLogged(
  "node",
  [
    "emulate/packages/emulate/dist/index.js",
    "start",
    "--service",
    "durable-streams,auth0",
    "--port",
    "4100",
    "--seed",
    "emulate.config.yaml",
  ],
  {
    name: "emulate",
  },
);

const app = spawnLogged("node", ["src/server.mjs"], {
  name: "app",
  env: {
    ...process.env,
    DURABLE_STREAMS_URL: "http://127.0.0.1:4100",
    AUTH0_EMULATOR_URL: "http://127.0.0.1:4101",
    AUTH0_CLIENT_ID: "slack-clone-auth0",
    AUTH0_CLIENT_SECRET: "slack-clone-secret",
    AUTH0_REALM: "Username-Password-Authentication",
    PORT: "5175",
  },
});

try {
  await rm(testResultsDir, { recursive: true, force: true });
  await waitForHttp(`${appBaseUrl}/api/health`);

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

  await mkdir(recordingsDir, { recursive: true });
  const videos = await findVideos(testResultsDir);
  const mp4Path = path.join(recordingsDir, `${room}.mp4`);
  if (videos.length >= 2) {
    await createSideBySideMp4(videos.slice(0, 2), mp4Path);
  } else if (videos.length === 1) {
    await transcodeMp4(videos[0], mp4Path);
  } else {
    throw new Error("Replay Playwright run did not produce a video file for MP4 proof");
  }

  const summary = {
    room,
    appBaseUrl,
    durableStreamsUrl: "http://127.0.0.1:4100",
    auth0EmulatorUrl: "http://127.0.0.1:4101",
    recordings: uploaded,
    mp4Path,
    sourceVideos: videos,
    createdAt: new Date().toISOString(),
  };

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

async function findVideos(dir) {
  const found = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.name.endsWith(".webm")) {
        found.push(entryPath);
      }
    }
  }
  await walk(dir);
  return found.sort();
}

async function createSideBySideMp4(videos, outputPath) {
  await run(
    "ffmpeg",
    [
      "-y",
      "-i",
      videos[0],
      "-i",
      videos[1],
      "-filter_complex",
      "[0:v]scale=1280:720,setpts=PTS-STARTPTS[left];[1:v]scale=1280:720,setpts=PTS-STARTPTS[right];[left][right]hstack=inputs=2[v]",
      "-map",
      "[v]",
      "-an",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    { name: "mp4" },
  );
}

async function transcodeMp4(video, outputPath) {
  await run(
    "ffmpeg",
    ["-y", "-i", video, "-an", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outputPath],
    { name: "mp4" },
  );
}
