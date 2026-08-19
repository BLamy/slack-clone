import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { run } from "./process-utils.mjs";

const root = path.resolve(import.meta.dirname, "..");
const runId =
  process.env.TEST_RUN_ID ?? `cold-${process.pid}-${Date.now().toString(36)}`;
const implementationCommit = String(
  process.env.E2_T08_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
if (!/^[0-9a-f]{40}$/u.test(implementationCommit)) {
  throw new Error(
    "E2-T08 cold verification requires an exact implementation commit",
  );
}

const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-2-the-roster/E2-T08-configure-reconfigure-revoke-agent",
);
const promotedDirectory = path.join(taskDirectory, "evidence/e2-t08-final");
const artifactDirectory = process.env.TEST_ARTIFACT_DIR
  ? path.resolve(root, process.env.TEST_ARTIFACT_DIR)
  : path.join(root, ".artifacts", "e2-t08", runId);
const CANARY = "Bearer e2-t08-agent-control-canary-123456789";
await mkdir(artifactDirectory, { recursive: true });
if (process.env.PROMOTE_EVIDENCE === "1") {
  await mkdir(promotedDirectory, { recursive: true });
}

const workDirectory = path.join(taskDirectory, "work");
await mkdir(workDirectory, { recursive: true });
const disposableParent = await mkdtemp(path.join(workDirectory, "cold-clone-"));
const checkout = path.join(disposableParent, "checkout");
const transcript = {
  schemaVersion: 1,
  runId,
  implementationCommit,
  entrypoint: {
    command:
      process.env.E2_T08_ENTRYPOINT ?? "node scripts/cold-verify-e2-t08.mjs",
    delegatedTo: "node scripts/verify-e2-t08.mjs",
  },
  checkout: "disposable git worktree at the implementation commit",
  commands: [],
};
let worktreeAdded = false;

try {
  const worktree = await run(
    "git",
    ["worktree", "add", "--detach", checkout, implementationCommit],
    { name: "cold-worktree", cwd: root },
  );
  worktreeAdded = true;
  transcript.commands.push({
    command: `git worktree add --detach <checkout> ${implementationCommit}`,
    exitCode: worktree.code,
  });

  const submodule = await run(
    "git",
    ["submodule", "update", "--init", "--recursive"],
    { name: "cold-submodule", cwd: checkout },
  );
  transcript.commands.push({
    command: "git submodule update --init --recursive",
    exitCode: submodule.code,
  });
  const cleanCheckout = await run(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { name: "cold-checkout-status", cwd: checkout },
  );
  if (cleanCheckout.output.trim() !== "") {
    throw new Error(
      `disposable checkout is not clean before install: ${cleanCheckout.output.trim()}`,
    );
  }
  transcript.cleanCheckoutBeforeInstall = true;
  transcript.commands.push({
    command: "git status --porcelain --untracked-files=all",
    exitCode: cleanCheckout.code,
  });

  const install = await run("pnpm", ["install", "--frozen-lockfile"], {
    name: "cold-root-install",
    cwd: checkout,
  });
  transcript.commands.push({
    command: "pnpm install --frozen-lockfile",
    exitCode: install.code,
  });
  const emulatorBuild = await run("pnpm", ["setup:emulate"], {
    name: "cold-emulator-build",
    cwd: checkout,
  });
  transcript.commands.push({
    command: "pnpm setup:emulate",
    exitCode: emulatorBuild.code,
  });

  const childEnv = { ...process.env };
  delete childEnv.PROMOTE_EVIDENCE;
  const verifier = await run("node", ["scripts/verify-e2-t08.mjs"], {
    name: "verify-E2-T08",
    cwd: checkout,
    env: {
      ...childEnv,
      E2_T08_COLD_CLONE: "1",
      E2_T08_IMPLEMENTATION_COMMIT: implementationCommit,
      TEST_ARTIFACT_DIR: artifactDirectory,
      TEST_RUN_ID: runId,
    },
  });
  transcript.commands.push({
    command: "node scripts/verify-e2-t08.mjs",
    exitCode: verifier.code,
  });
  if (verifier.code !== 0) {
    throw new Error(`E2-T08 verifier failed: ${verifier.output}`);
  }
  transcript.result = "PASS";
} finally {
  if (worktreeAdded) {
    await run("git", ["worktree", "remove", "--force", checkout], {
      name: "cold-worktree-remove",
      cwd: root,
    });
  }
  await rm(disposableParent, { recursive: true, force: true });
}

const destination =
  process.env.PROMOTE_EVIDENCE === "1" ? promotedDirectory : artifactDirectory;
if (destination !== artifactDirectory) {
  for (const filename of [
    "verification-summary.json",
    "http-transcript.json",
    "cli-transcript.json",
    "source-dumps.json",
    "snapshot-manifests.json",
    "role-matrix.json",
    "roster.json",
    "revocation-races.json",
    "replay-composite.json",
    "tamper-matrix.json",
    "sensitivity.json",
    "canary-scan.json",
  ]) {
    await copyFile(
      path.join(artifactDirectory, filename),
      path.join(destination, filename),
    );
  }
}

await writeFile(
  path.join(destination, "cold-clone-transcript.json"),
  `${JSON.stringify(transcript, null, 2)}\n`,
);
const finalEvidenceFiles = (await readdir(destination, { withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort();
for (const filename of finalEvidenceFiles) {
  const contents = await readFile(path.join(destination, filename), "utf8");
  if (contents.includes(CANARY)) {
    throw new Error(`E2-T08 evidence contains the canary: ${filename}`);
  }
}
const canaryScanPath = path.join(destination, "canary-scan.json");
const canaryScan = JSON.parse(await readFile(canaryScanPath, "utf8"));
canaryScan.evidenceFiles = finalEvidenceFiles;
canaryScan.postVerifierTranscriptChecked = true;
canaryScan.publishedEvidenceLeaked = false;
await writeFile(canaryScanPath, `${JSON.stringify(canaryScan, null, 2)}\n`);
const summaryPath = path.join(destination, "verification-summary.json");
const summary = JSON.parse(await readFile(summaryPath, "utf8"));
summary.canaryScan = canaryScan;
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

console.log(
  JSON.stringify(
    { result: transcript.result, runId, implementationCommit },
    null,
    2,
  ),
);
