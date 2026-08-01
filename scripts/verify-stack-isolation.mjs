import assert from "node:assert/strict";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { run } from "./process-utils.mjs";
import { createRunContext } from "./run-context.mjs";
import { startStack } from "./test-stack.mjs";

const runId = String(
  process.env.TEST_RUN_ID ??
    `concurrent-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/g, "-");
const artifactRoot = path.resolve(
  process.env.TEST_ARTIFACT_DIR ??
    path.join(".artifacts", "e0-t02", runId, "concurrency"),
);
const recordingsBefore = await snapshotDirectory(path.resolve("recordings"));

const contextA = await createRunContext({
  env: {
    ...process.env,
    TEST_RUN_ID: `${runId}-a`,
    TEST_ARTIFACT_DIR: path.join(artifactRoot, "a"),
  },
});
let contextB = await createRunContext({
  env: {
    ...process.env,
    TEST_RUN_ID: `${runId}-b`,
    TEST_ARTIFACT_DIR: path.join(artifactRoot, "b"),
  },
});
while (ports(contextA).some((port) => ports(contextB).includes(port))) {
  contextB = await createRunContext({
    env: {
      ...process.env,
      TEST_RUN_ID: `${runId}-b`,
      TEST_ARTIFACT_DIR: path.join(artifactRoot, "b"),
    },
  });
}

assert.notEqual(contextA.artifactRoot, contextB.artifactRoot);
await mkdir(path.join(artifactRoot, "playwright"), { recursive: true });
const stackA = await startStack(contextA);
let stackB;

try {
  stackB = await startStack(contextB);
  await Promise.race([
    run(
      "pnpm",
      [
        "exec",
        "playwright",
        "test",
        "--config",
        "isolation.playwright.config.mjs",
      ],
      {
        name: `isolation:${runId}`,
        env: {
          ...process.env,
          APP_BASE_URL: contextA.appBaseUrl,
          AUTH0_EMULATOR_URL: contextA.auth0EmulatorUrl,
          DURABLE_STREAMS_URL: contextA.durableStreamsUrl,
          PEER_APP_BASE_URL: contextB.appBaseUrl,
          PEER_AUTH0_EMULATOR_URL: contextB.auth0EmulatorUrl,
          PEER_DURABLE_STREAMS_URL: contextB.durableStreamsUrl,
          PLAYWRIGHT_OUTPUT_DIR: path.join(artifactRoot, "playwright"),
          TEST_ROOM_PREFIX: runId,
          TEST_RUN_ID: runId,
        },
      },
    ),
    stackA.failure,
    stackB.failure,
  ]);
} finally {
  await Promise.all([stackA.stop(), stackB?.stop()]);
}

await Promise.all([
  assert.rejects(
    fetch(contextA.appBaseUrl, { signal: AbortSignal.timeout(1000) }),
  ),
  assert.rejects(
    fetch(contextB.appBaseUrl, { signal: AbortSignal.timeout(1000) }),
  ),
]);
assert.deepEqual(
  await snapshotDirectory(path.resolve("recordings")),
  recordingsBefore,
);

const summary = {
  runId,
  result: "PASS",
  stackA: publicContext(contextA),
  stackB: publicContext(contextB),
  artifactRootsDistinct: true,
  foreignSessionRefused: true,
  sameRoomNameStreamsIsolated: true,
  childrenStopped: true,
  recordingsUnchanged: true,
};
await writeFile(
  path.join(artifactRoot, "isolation-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));

function ports(context) {
  return [context.appPort, context.auth0Port, context.emulatorPort];
}

function publicContext(context) {
  return {
    runId: context.runId,
    appBaseUrl: context.appBaseUrl,
    auth0EmulatorUrl: context.auth0EmulatorUrl,
    durableStreamsUrl: context.durableStreamsUrl,
    artifactRoot: context.artifactRoot,
  };
}

async function snapshotDirectory(directory) {
  const snapshot = [];
  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else {
        const info = await stat(entryPath);
        snapshot.push({
          path: path.relative(directory, entryPath),
          bytes: info.size,
          modifiedMs: info.mtimeMs,
        });
      }
    }
  }
  await visit(directory);
  return snapshot;
}
