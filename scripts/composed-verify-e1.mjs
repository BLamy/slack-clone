import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-1-the-workspace/E1-T08-multi-user-chat-api",
);
const targetOrder = [
  "verify-E1-T01",
  "verify-E1-T02",
  "verify-E1-T03",
  "verify-E1-T04",
  "verify-E1-T05",
  "verify-E1-T06",
  "verify-E1-T07",
  "verify-E1-T08",
];
const runId =
  process.env.TEST_RUN_ID ??
  `composed-${process.pid}-${Date.now().toString(36)}`;
const implementationCommit = String(
  process.env.E1_T08_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
const rootHead = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const rootCheckoutCleanBeforeRun =
  execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: root,
    encoding: "utf8",
  }).trim() === "";
const targetImplementationCommits = Object.fromEntries(
  targetOrder.map((target) => [
    target,
    target === "verify-E1-T08" ? implementationCommit : rootHead,
  ]),
);
const commands = [];
let failure = null;

for (const target of targetOrder) {
  const startedAt = Date.now();
  const targetEnv = {
    ...process.env,
    TEST_RUN_ID: runId,
  };
  delete targetEnv.PROMOTE_EVIDENCE;
  if (target === "verify-E1-T08") {
    targetEnv.E1_T08_IMPLEMENTATION_COMMIT = implementationCommit;
  }
  try {
    execFileSync("make", [target], {
      cwd: root,
      env: targetEnv,
      stdio: "inherit",
    });
    commands.push({
      command: `make ${target}`,
      durationMs: Date.now() - startedAt,
      exitCode: 0,
      target,
    });
  } catch (error) {
    const exitCode = typeof error.status === "number" ? error.status : 1;
    commands.push({
      command: `make ${target}`,
      durationMs: Date.now() - startedAt,
      exitCode,
      target,
    });
    failure = { exitCode, target };
    break;
  }
}

const result = failure === null ? "PASS" : "FAIL";
const skipVariables = Object.entries(process.env)
  .filter(
    ([name, value]) => /^E1[-_]T?0?[1-8]_SKIP_/u.test(name) && value === "1",
  )
  .map(([name]) => name);
const transcript = {
  schemaVersion: 1,
  runId,
  command: `E1_T08_IMPLEMENTATION_COMMIT=${implementationCommit} TEST_RUN_ID=${runId} make verify-E1`,
  rootCheckoutCleanBeforeRun,
  targetOrder,
  targetImplementationCommits,
  commands,
  zeroSkips: result === "PASS" && skipVariables.length === 0,
  skipVariables,
  result,
  failure,
};
const evidenceDirectory =
  process.env.PROMOTE_EVIDENCE === "1"
    ? path.join(taskDirectory, "evidence/e1-t08-final")
    : path.resolve(
        root,
        process.env.TEST_ARTIFACT_DIR ??
          path.join(".artifacts", "e1-composed", runId),
      );
await mkdir(evidenceDirectory, { recursive: true });
const transcriptPath = path.join(
  evidenceDirectory,
  "composed-verify-transcript.json",
);
await writeFile(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`);
console.log(`[composed-verify-e1] ${result} transcript=${transcriptPath}`);
if (failure !== null) process.exitCode = failure.exitCode;
