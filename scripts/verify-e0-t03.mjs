import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { run } from "./process-utils.mjs";

const runId = String(
  process.env.TEST_RUN_ID ?? `verify-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/gu, "-");
const implementationCommit = String(
  process.env.E0_T03_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }),
).trim();
assert.match(
  implementationCommit,
  /^[0-9a-f]{40}$/u,
  "E0-T03 evidence requires an exact implementation commit",
);
if (process.env.PROMOTE_EVIDENCE === "1") {
  const trackedChanges = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    { encoding: "utf8" },
  ).trim();
  assert.equal(
    trackedChanges,
    "",
    "promoted E0-T03 evidence must start from a clean tracked implementation tree",
  );
}
const artifactRoot = path.resolve(
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e0-t03", runId),
);
const taskEvidenceDirectory = path.resolve(
  ".eforest/tasks/epic-0-the-ledger/E0-T03-official-durable-streams-adapter/evidence",
);
await mkdir(artifactRoot, { recursive: true });
const recordingsBefore = await snapshotDirectory(path.resolve("recordings"));
const env = {
  ...process.env,
  BUILD_DIR: path.join(artifactRoot, "build"),
  E0_T03_IMPLEMENTATION_COMMIT: implementationCommit,
  TEST_ARTIFACT_DIR: artifactRoot,
  TEST_RUN_ID: runId,
};
const gates = [
  ["format", "format:check"],
  ["lint", "lint"],
  ["static-analysis", "typecheck"],
  ["unit", "test:unit"],
  ["conformance", "test:conformance"],
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
  throw new Error("Routine E0-T03 verification mutated existing recordings");
}
const conformance = JSON.parse(
  await readFile(
    path.join(artifactRoot, "e0-t03-conformance-summary.json"),
    "utf8",
  ),
);
const streamProof = JSON.parse(
  await readFile(path.join(artifactRoot, "stream-proof.json"), "utf8"),
);
const summary = {
  schemaVersion: 1,
  task: "E0-T03",
  runId,
  implementationCommit,
  implementationTreeCleanAtStart:
    process.env.PROMOTE_EVIDENCE === "1" ? true : null,
  result: "PASS",
  artifactRoot,
  gates: results,
  replay:
    "N/A (server transport adapter) + mitigation: real-emulator protocol transcript, request-budget proof, canary scan, and reconnect matrix",
  replayUploadAttempted: false,
  externalTunnelAttempted: false,
  recordingsUnchanged: true,
  conformance: {
    capturedOffsets: conformance.protocolConformance.capturedOffsets,
    resumeMatrix: conformance.protocolConformance.resumeMatrix,
    requestBudget: conformance.requestBudget,
    canaryScan: conformance.canaryScan,
  },
  browserRegression: streamProof,
};
await writeFile(
  path.join(artifactRoot, "verification-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
if (process.env.PROMOTE_EVIDENCE === "1") {
  await mkdir(taskEvidenceDirectory, { recursive: true });
  await writeFile(
    path.join(taskEvidenceDirectory, "cold-verification.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
}
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
