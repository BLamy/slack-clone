import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const commit = String(
  process.env.E4_T04_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
if (!/^[0-9a-f]{40}$/u.test(commit))
  throw new Error("E4-T04 requires an exact implementation commit");
const runId = process.env.TEST_RUN_ID ?? `cold-${Date.now().toString(36)}`;
const artifactDir = path.resolve(
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e4-t04", runId),
);
const task = path.join(
  root,
  ".eforest/tasks/epic-4-the-cloudflare-os/E4-T04-streaming-exec-and-cancellation",
);
const work = path.join(task, "work");
await mkdir(work, { recursive: true });
const parent = await mkdtemp(path.join(work, "cold-clone-"));
const checkout = path.join(parent, "checkout");
let added = false;
try {
  await mkdir(artifactDir, { recursive: true });
  execFileSync("git", ["worktree", "add", "--detach", checkout, commit], {
    cwd: root,
    stdio: "ignore",
  });
  added = true;
  execFileSync("git", ["submodule", "update", "--init", "--recursive"], {
    cwd: checkout,
    stdio: "ignore",
  });
  execFileSync("pnpm", ["install", "--frozen-lockfile"], {
    cwd: checkout,
    stdio: "inherit",
  });
  execFileSync("node", ["scripts/verify-e4-t04.mjs"], {
    cwd: checkout,
    env: {
      ...process.env,
      E4_T04_IMPLEMENTATION_COMMIT: commit,
      TEST_ARTIFACT_DIR: artifactDir,
      TEST_RUN_ID: runId,
    },
    stdio: "inherit",
  });
  execFileSync("pnpm", ["format:check"], { cwd: checkout, stdio: "inherit" });
  execFileSync("pnpm", ["lint"], { cwd: checkout, stdio: "inherit" });
  execFileSync("pnpm", ["typecheck"], { cwd: checkout, stdio: "inherit" });
  execFileSync("pnpm", ["test:unit"], { cwd: checkout, stdio: "inherit" });
  execFileSync("pnpm", ["build"], { cwd: checkout, stdio: "inherit" });
  await writeFile(
    path.join(artifactDir, "cold-verification-transcript.json"),
    `${JSON.stringify({ implementationCommit: commit, result: "PASS", runId, gates: ["format:check", "lint", "typecheck", "test:unit", "build"] }, null, 2)}\n`,
  );
  console.log(
    JSON.stringify(
      { implementationCommit: commit, result: "PASS", runId },
      null,
      2,
    ),
  );
} finally {
  if (added)
    execFileSync("git", ["worktree", "remove", "--force", checkout], {
      cwd: root,
      stdio: "ignore",
    });
  await rm(parent, { recursive: true, force: true });
}
