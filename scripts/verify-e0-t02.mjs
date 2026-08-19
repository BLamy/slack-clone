import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { run } from "./process-utils.mjs";

const runId = String(
  process.env.TEST_RUN_ID ?? `verify-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/g, "-");
const artifactRoot = path.resolve(
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e0-t02", runId),
);
await mkdir(artifactRoot, { recursive: true });
const recordingsBefore = await snapshotDirectory(path.resolve("recordings"));
const env = {
  ...process.env,
  BUILD_DIR: path.join(artifactRoot, "build"),
  TEST_ARTIFACT_DIR: artifactRoot,
  TEST_RUN_ID: runId,
};
const gates = [
  ["format", "format:check"],
  ["lint", "lint"],
  ["static-analysis", "typecheck"],
  ["unit", "test:unit"],
  ["integration", "test:integration"],
  ["concurrency", "test:concurrency"],
  ["build", "build"],
];
const results = [];

for (const [name, script] of gates) {
  const startedAt = Date.now();
  await run("pnpm", [script], { name, env });
  results.push({
    name,
    command: `pnpm ${script}`,
    result: "PASS",
    durationMs: Date.now() - startedAt,
  });
}

const recordingsAfter = await snapshotDirectory(path.resolve("recordings"));
if (JSON.stringify(recordingsAfter) !== JSON.stringify(recordingsBefore)) {
  throw new Error("Routine E0-T02 verification mutated existing recordings");
}
const streamProof = JSON.parse(
  await readFile(path.join(artifactRoot, "stream-proof.json"), "utf8"),
);
const summary = {
  schemaVersion: 1,
  task: "E0-T02",
  runId,
  result: "PASS",
  artifactRoot,
  gates: results,
  replayUploadAttempted: false,
  externalTunnelAttempted: false,
  recordingsUnchanged: true,
  streamProof,
};
await writeFile(
  path.join(artifactRoot, "verification-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));

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
      if (entry.isDirectory()) await visit(entryPath);
      else {
        const info = await stat(entryPath);
        snapshot.push({
          path: path.relative(directory, entryPath),
          bytes: info.size,
          mtimeMs: info.mtimeMs,
        });
      }
    }
  }
  await visit(directory);
  return snapshot;
}
