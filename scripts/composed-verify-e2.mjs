import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-2-the-roster/E2-T08-configure-reconfigure-revoke-agent",
);
const targetOrder = [
  "verify-E2-T01",
  "verify-E2-T02",
  "verify-E2-T03",
  "verify-E2-T04",
  "verify-E2-T05",
  "verify-E2-T06",
  "verify-E2-T07",
  "verify-E2-T08",
];
const runId =
  process.env.TEST_RUN_ID ??
  `composed-${process.pid}-${Date.now().toString(36)}`;
const implementationCommit = String(
  process.env.E2_T08_IMPLEMENTATION_COMMIT ??
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
    target === "verify-E2-T08" ? implementationCommit : rootHead,
  ]),
);
const commands = [];
let failure = null;
const promote = process.env.PROMOTE_EVIDENCE === "1";

for (const target of targetOrder) {
  const startedAt = Date.now();
  const targetEnv = {
    ...process.env,
    TEST_ARTIFACT_DIR: path.join(
      root,
      ".artifacts",
      "e2-composed",
      runId,
      target,
    ),
    TEST_RUN_ID: runId,
  };
  delete targetEnv.PROMOTE_EVIDENCE;
  if (target === "verify-E2-T08") {
    targetEnv.E2_T08_IMPLEMENTATION_COMMIT = implementationCommit;
    if (promote) targetEnv.PROMOTE_EVIDENCE = "1";
  }
  const command =
    target === "verify-E2-T08"
      ? "node scripts/verify-e2-t08.mjs"
      : `make ${target}`;
  try {
    if (target === "verify-E2-T08") {
      execFileSync("node", ["scripts/verify-e2-t08.mjs"], {
        cwd: root,
        env: targetEnv,
        stdio: "inherit",
      });
    } else {
      execFileSync("make", [target], {
        cwd: root,
        env: targetEnv,
        stdio: "inherit",
      });
    }
    commands.push({
      command,
      durationMs: Date.now() - startedAt,
      exitCode: 0,
      target,
    });
  } catch (error) {
    const exitCode = typeof error.status === "number" ? error.status : 1;
    commands.push({
      command,
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
  .filter(([name, value]) => /^E2[-_]T\d+_SKIP_/u.test(name) && value === "1")
  .map(([name]) => name);
const transcript = {
  schemaVersion: 1,
  runId,
  command: `E2_T08_IMPLEMENTATION_COMMIT=${implementationCommit} TEST_RUN_ID=${runId} make verify-E2`,
  rootCheckoutCleanBeforeRun,
  targetOrder,
  targetImplementationCommits,
  commands,
  zeroSkips: result === "PASS" && skipVariables.length === 0,
  skipVariables,
  result,
  failure,
};
const evidenceDirectory = promote
  ? path.join(taskDirectory, "evidence/e2-t08-final")
  : path.join(root, ".artifacts", "e2-composed", runId);
await mkdir(evidenceDirectory, { recursive: true });
await writeFile(
  path.join(evidenceDirectory, "composed-verify-transcript.json"),
  `${JSON.stringify(transcript, null, 2)}\n`,
);
console.log(
  `[composed-verify-e2] ${result} transcript=${path.join(
    evidenceDirectory,
    "composed-verify-transcript.json",
  )}`,
);
if (failure !== null) process.exitCode = failure.exitCode;
