import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  FAULT_HOOKS,
  FROZEN_FAULT_SCHEDULES,
  runFaultSchedule,
  runSensitivityChecks,
} from "../src/ledger/fault-harness.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const runId = String(
  process.env.TEST_RUN_ID ?? `verify-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/gu, "-");
const implementationCommit = String(
  process.env.E0_T06_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
assert.match(
  implementationCommit,
  /^[0-9a-f]{40}$/u,
  "E0-T06 evidence requires an exact implementation commit",
);
if (process.env.PROMOTE_EVIDENCE === "1") {
  const trackedChanges = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    { cwd: root, encoding: "utf8" },
  ).trim();
  assert.equal(
    trackedChanges,
    "",
    "promoted E0-T06 evidence must start from a clean tracked implementation tree",
  );
}

const artifactRoot = path.resolve(
  root,
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e0-t06", runId),
);
const taskEvidenceDirectory = path.join(
  root,
  ".eforest/tasks/epic-0-the-ledger/E0-T06-crash-duplicate-partition-harness/evidence",
);
const scheduleDirectory = path.join(artifactRoot, "schedules");
await mkdir(scheduleDirectory, { recursive: true });

const summaries = [];
const determinism = [];
for (const schedule of FROZEN_FAULT_SCHEDULES) {
  const options = optionsFor(schedule);
  const first = await runFaultSchedule(schedule, options);
  const second = await runFaultSchedule(schedule, options);
  assert.deepEqual(
    comparableRun(first),
    comparableRun(second),
    `${schedule.name} changed across identical seed and schedule runs`,
  );
  assert.deepEqual(
    first.schedule.coveredHooks,
    [...FAULT_HOOKS],
    `${schedule.name} skipped a named fault hook`,
  );
  assert.equal(
    first.schedule.matchedScheduleEntries.length,
    first.schedule.schedule.length,
    `${schedule.name} skipped a frozen injection point`,
  );
  assert.equal(first.targetDump.length, 3);
  assert.equal(first.receiptDump.length, 3);
  assert.equal(
    first.authoritativeReplay.finalStateDigest,
    first.reader.finalDigest,
  );
  assert.equal(
    first.invalidCausalOrder.rejected.code,
    "REDUCER_ILLEGAL_TRANSITION",
  );
  assert.equal(
    first.invalidCausalOrder.rejected.offset,
    first.invalidCausalOrder.citedOffset,
  );
  assert.ok(
    first.slowConsumer.bounds.cancelPeakRecords <=
      first.slowConsumer.bounds.maxRecords,
  );
  assert.ok(
    first.slowConsumer.bounds.cancelPeakBytes <=
      first.slowConsumer.bounds.maxBytes,
  );
  assert.ok(
    first.slowConsumer.bounds.catchUpPeakRecords <=
      first.slowConsumer.bounds.maxRecords,
  );
  assert.ok(
    first.slowConsumer.bounds.catchUpPeakBytes <=
      first.slowConsumer.bounds.maxBytes,
  );
  assert.equal(first.slowConsumer.cancel.code, "HARNESS_SLOW_CONSUMER");
  assert.equal(first.slowConsumer.cancel.policy, "cancel");
  assert.equal(first.slowConsumer.catchUp.policy, "catch-up");
  assert.equal(
    first.slowConsumer.unrelatedStreamProgress.headOfLineBlocked,
    false,
  );
  assert.ok(first.slowConsumer.unrelatedStreamProgress.progressRecords > 0);

  for (const operation of first.operations.filter(
    ({ result }) => result === "refused",
  )) {
    assert.equal(operation.targetCount >= 0, true);
    assert.equal(operation.receiptCount >= 0, true);
  }
  if (
    schedule.name === "append-before-crash" ||
    schedule.name === "validate-crash"
  ) {
    const refusal = first.operations.find(({ result }) => result === "refused");
    assert.equal(refusal.code, "HARNESS_CRASH");
    assert.equal(refusal.targetCount, 0);
    assert.equal(refusal.receiptCount, 0);
  }
  if (schedule.name === "append-after-crash") {
    const refusal = first.operations.find(({ result }) => result === "refused");
    assert.equal(refusal.code, "HARNESS_CRASH");
    assert.equal(refusal.targetCount, 1);
    assert.equal(refusal.receiptCount, 0);
  }
  if (schedule.name === "receipt-before-crash") {
    const refusal = first.operations.find(({ result }) => result === "refused");
    assert.equal(refusal.targetCount, 1);
    assert.equal(refusal.receiptCount, 0);
  }
  if (schedule.name === "consume-partition") {
    assert.ok(
      first.processRestarts.some(
        ({ component, stateDeleted }) => component === "reader" && stateDeleted,
      ),
    );
    assert.notEqual(
      first.reader.resumeFrom,
      "0000000000000000_0000000000000000",
    );
    assert.equal(first.reader.sourceReplayCount, first.targetDump.length);
    assert.equal(
      first.slowConsumer.unrelatedStreamProgress.partitionedDuringProbe,
      true,
    );
    assert.equal(first.reader.durableAuthorityRestarts.length, 1);
    assert.equal(
      first.reader.durableAuthorityRestarts[0].exportedStreamCount,
      first.reader.durableAuthorityRestarts[0].importedStreamCount,
    );
  }
  if (
    schedule.name === "checkpoint-corrupt" ||
    schedule.name === "seeded-combination"
  ) {
    assert.equal(first.reader.checkpointRecovery.result, "recovered-from-zero");
  }
  if (
    schedule.name === "acknowledge-delay" ||
    schedule.name === "seeded-combination"
  ) {
    assert.ok(first.delayedAcknowledgements.length > 0);
    assert.equal(
      first.delayedAcknowledgements[0].stateTrace.at(-1),
      "acknowledged",
    );
  }

  await writeJson(path.join(scheduleDirectory, `${schedule.name}.json`), first);
  summaries.push({
    name: schedule.name,
    seed: first.schedule.seed,
    schedule: first.schedule.schedule,
    coveredHooks: first.schedule.coveredHooks,
    matchedScheduleEntries: first.schedule.matchedScheduleEntries,
    operations: first.operations,
    processRestarts: first.processRestarts,
    checkpointCount: first.checkpoints.length,
    authoritativeFinalDigest: first.authoritativeReplay.finalStateDigest,
    readerFinalDigest: first.reader.finalDigest,
    invalidCausalOrder: first.invalidCausalOrder,
    slowConsumer: first.slowConsumer,
  });
  determinism.push({
    name: schedule.name,
    acceptedRefusedSequence: first.operations.map((operation) => ({
      code: operation.code ?? null,
      requestIndex: operation.requestIndex ?? null,
      result: operation.result,
    })),
    digest: first.finalDigest,
    identical: true,
  });
}

const sensitivity = await runSensitivityChecks();
assert.equal(sensitivity.length, 3);
assert.ok(sensitivity.every(({ outcome }) => outcome === "rejected"));
await writeJson(path.join(artifactRoot, "sensitivity.json"), sensitivity);
await writeJson(path.join(artifactRoot, "determinism.json"), determinism);
await writeJson(path.join(artifactRoot, "fault-schedules.json"), summaries);

const gates = [];
for (const [name, script] of [
  ["format", "format:check"],
  ["lint", "lint"],
  ["typecheck", "typecheck"],
  ["tests", "test"],
  ["build", "build"],
]) {
  const startedAt = Date.now();
  await runPnpm(script, {
    ...process.env,
    BUILD_DIR: path.join(artifactRoot, "build"),
    E0_T06_IMPLEMENTATION_COMMIT: implementationCommit,
    TEST_ARTIFACT_DIR: artifactRoot,
    TEST_RUN_ID: runId,
  });
  gates.push({
    command: `pnpm ${script}`,
    durationMs: Date.now() - startedAt,
    name,
    result: "PASS",
  });
}

const summary = {
  schemaVersion: 1,
  task: "E0-T06",
  runId,
  implementationCommit,
  implementationTreeCleanAtStart:
    process.env.PROMOTE_EVIDENCE === "1" ? true : null,
  result: "PASS",
  zeroSkippedSchedules: true,
  zeroSkippedInjectionPoints: true,
  gates,
  namedHooks: FAULT_HOOKS,
  scheduleCount: summaries.length,
  deterministicReruns: determinism,
  sensitivity,
  replay:
    "N/A (headless failure harness) + mitigation: deterministic schedules, process restarts, stream dumps, checkpoint proofs, and replay digests",
  replayUploadAttempted: false,
  schedules: summaries,
};
await writeJson(path.join(artifactRoot, "verification-summary.json"), summary);

if (process.env.PROMOTE_EVIDENCE === "1") {
  await mkdir(path.join(taskEvidenceDirectory, "schedules"), {
    recursive: true,
  });
  for (const name of [
    "determinism.json",
    "fault-schedules.json",
    "sensitivity.json",
    "verification-summary.json",
  ]) {
    await copyFile(
      path.join(artifactRoot, name),
      path.join(taskEvidenceDirectory, name),
    );
  }
  for (const schedule of FROZEN_FAULT_SCHEDULES) {
    await copyFile(
      path.join(scheduleDirectory, `${schedule.name}.json`),
      path.join(taskEvidenceDirectory, "schedules", `${schedule.name}.json`),
    );
  }
}

console.log(JSON.stringify(summary, null, 2));

function optionsFor(schedule) {
  return {
    seedCheckpoint:
      schedule.name === "checkpoint-corrupt" ||
      schedule.name === "seeded-combination",
  };
}

function comparableRun(result) {
  return {
    acceptedRefusedSequence: result.operations,
    digest: result.finalDigest,
    invalidCausalOrder: result.invalidCausalOrder,
    reader: result.reader,
    schedule: result.schedule,
  };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function runPnpm(script, env) {
  try {
    await execFileAsync("pnpm", [script], {
      cwd: root,
      env,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    process.stderr.write(error.stdout ?? "");
    process.stderr.write(error.stderr ?? "");
    throw new Error(`pnpm ${script} failed with code ${error.code}`);
  }
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

assert.equal(await pathExists(artifactRoot), true);
