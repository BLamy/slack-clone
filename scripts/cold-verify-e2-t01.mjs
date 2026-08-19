import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { run } from "./process-utils.mjs";

const root = path.resolve(import.meta.dirname, "..");
const runId =
  process.env.TEST_RUN_ID ?? `cold-${process.pid}-${Date.now().toString(36)}`;
const implementationCommit = String(
  process.env.E2_T01_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-2-the-roster/E2-T01-versioned-agent-config-schema",
);
const promoteEvidence = process.env.PROMOTE_EVIDENCE === "1";
const evidenceDirectory = promoteEvidence
  ? path.join(taskDirectory, "evidence/e2-t01-final")
  : path.resolve(
      process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e2-t01", runId),
    );
await mkdir(evidenceDirectory, { recursive: true });

const taskWorkDirectory = path.join(taskDirectory, "work");
await mkdir(taskWorkDirectory, { recursive: true });
const disposableParent = await mkdtemp(
  path.join(taskWorkDirectory, "cold-clone-"),
);
const checkout = path.join(disposableParent, "checkout");
const transcript = {
  schemaVersion: 1,
  runId,
  implementationCommit,
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

  const artifactDirectory = path.join(checkout, ".artifacts", "e2-t01", runId);
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

  const verifier = await run("node", ["scripts/verify-e2-t01.mjs"], {
    name: "verify-E2-T01",
    cwd: checkout,
    env: {
      ...process.env,
      E2_T01_COLD_CLONE: "1",
      E2_T01_IMPLEMENTATION_COMMIT: implementationCommit,
      PROMOTE_EVIDENCE: promoteEvidence ? "1" : "0",
      TEST_ARTIFACT_DIR: artifactDirectory,
      TEST_RUN_ID: runId,
    },
  });
  transcript.commands.push({
    command: "node scripts/verify-e2-t01.mjs",
    exitCode: verifier.code,
  });
  if (verifier.code !== 0) {
    throw new Error(`E2-T01 verifier failed: ${verifier.output}`);
  }

  if (promoteEvidence) {
    for (const filename of [
      "verification-summary.json",
      "canonical-fixtures.json",
      "refusals.json",
      "upgrade-matrix.json",
      "canary-matrix.json",
      "sensitivity.json",
      "schema-summary.json",
    ]) {
      await copyFile(
        path.join(checkout, path.relative(root, evidenceDirectory), filename),
        path.join(evidenceDirectory, filename),
      );
    }
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

await writeFile(
  path.join(evidenceDirectory, "cold-clone-transcript.json"),
  `${JSON.stringify(transcript, null, 2)}\n`,
);
console.log(JSON.stringify(transcript, null, 2));
