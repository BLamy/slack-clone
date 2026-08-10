import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-3-the-dispatcher/E3-T08-mention-to-scripted-agent-reply",
);
const targetOrder = [
  "verify-E3-T01",
  "verify-E3-T02",
  "verify-E3-T03",
  "verify-E3-T04",
  "verify-E3-T05",
  "verify-E3-T06",
  "verify-E3-T07",
  "verify-E3-T08",
];
const runId =
  process.env.TEST_RUN_ID ??
  `composed-${process.pid}-${Date.now().toString(36)}`;
const rootHead = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const implementationCommit = String(
  process.env.E3_T08_IMPLEMENTATION_COMMIT ?? rootHead,
).trim();
const promote = process.env.PROMOTE_EVIDENCE === "1";
const targetImplementationCommits = Object.fromEntries(
  targetOrder.map((target) => [target, implementationCommit]),
);
const commands = [];
let failure = null;

for (const target of targetOrder) {
  const startedAt = Date.now();
  const targetEnv = {
    ...process.env,
    TEST_ARTIFACT_DIR: path.join(
      root,
      ".artifacts",
      "e3-composed",
      runId,
      target,
    ),
    TEST_RUN_ID: `${runId}-${target}`,
  };
  delete targetEnv.PROMOTE_EVIDENCE;
  if (target === "verify-E3-T08") {
    targetEnv.E3_T08_IMPLEMENTATION_COMMIT = implementationCommit;
    if (promote) targetEnv.PROMOTE_EVIDENCE = "1";
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
  .filter(([name, value]) => /^E3[-_]T\d+_SKIP_/u.test(name) && value === "1")
  .map(([name]) => name);
const transcript = {
  schemaVersion: 1,
  runId,
  command: `E3_T08_IMPLEMENTATION_COMMIT=${implementationCommit} TEST_RUN_ID=${runId} make verify-E3`,
  targetOrder,
  targetImplementationCommits,
  commands,
  zeroSkips: result === "PASS" && skipVariables.length === 0,
  skipVariables,
  result,
  failure,
};
const evidenceDirectory = promote
  ? path.join(taskDirectory, "evidence/e3-t08-final")
  : path.join(root, ".artifacts", "e3-composed", runId);
await mkdir(evidenceDirectory, { recursive: true });
await writeFile(
  path.join(evidenceDirectory, "composed-verify-transcript.json"),
  `${JSON.stringify(transcript, null, 2)}\n`,
);
console.log(
  `[composed-verify-e3] ${result} transcript=${path.join(
    evidenceDirectory,
    "composed-verify-transcript.json",
  )}`,
);
if (failure !== null) process.exitCode = failure.exitCode;
