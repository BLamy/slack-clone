import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { run } from "./process-utils.mjs";

const root = path.resolve(import.meta.dirname, "..");
const runId =
  process.env.TEST_RUN_ID ?? `cold-${process.pid}-${Date.now().toString(36)}`;
const implementationCommit = String(
  process.env.E2_T05_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
if (!/^[0-9a-f]{40}$/u.test(implementationCommit)) {
  throw new Error(
    "E2-T05 cold verification requires an exact implementation commit",
  );
}

const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-2-the-roster/E2-T05-provider-registry-and-capabilities",
);
const evidenceDirectory = path.join(taskDirectory, "evidence/e2-t05-final");
await mkdir(evidenceDirectory, { recursive: true });
const workDirectory = path.join(taskDirectory, "work");
await mkdir(workDirectory, { recursive: true });
const disposableParent = await mkdtemp(path.join(workDirectory, "cold-clone-"));
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

  const artifactDirectory = process.env.TEST_ARTIFACT_DIR
    ? path.isAbsolute(process.env.TEST_ARTIFACT_DIR)
      ? process.env.TEST_ARTIFACT_DIR
      : path.resolve(checkout, process.env.TEST_ARTIFACT_DIR)
    : path.join(checkout, ".artifacts", "e2-t05", runId);
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
  const verifier = await run("node", ["scripts/verify-e2-t05.mjs"], {
    name: "verify-E2-T05",
    cwd: checkout,
    env: {
      ...process.env,
      E2_T05_COLD_CLONE: "1",
      E2_T05_IMPLEMENTATION_COMMIT: implementationCommit,
      TEST_ARTIFACT_DIR: artifactDirectory,
      TEST_RUN_ID: runId,
    },
  });
  transcript.commands.push({
    command: "node scripts/verify-e2-t05.mjs",
    exitCode: verifier.code,
  });
  if (verifier.code !== 0) {
    throw new Error(`E2-T05 verifier failed: ${verifier.output}`);
  }

  if (process.env.PROMOTE_EVIDENCE === "1") {
    for (const filename of [
      "verification-summary.json",
      "registry-manifest.json",
      "compatibility-matrix.json",
      "refusals.json",
      "resolved-provider-digests.json",
      "conformance.json",
      "sensitivity.json",
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

console.log(
  JSON.stringify(
    {
      result: transcript.result,
      runId,
      implementationCommit,
    },
    null,
    2,
  ),
);
