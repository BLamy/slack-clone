import { spawnSync } from "node:child_process";
import path from "node:path";

import { ANALYSIS_ROOTS, listExecutableFiles } from "./runtime-files.mjs";

const root = path.resolve(import.meta.dirname, "..");
const files = [];
files.push(...(await listExecutableFiles(root, ANALYSIS_ROOTS)));
for (const file of [
  "playwright.config.mjs",
  "replay.playwright.config.mjs",
  "isolation.playwright.config.mjs",
  "eslint.config.mjs",
]) {
  files.push(path.join(root, file));
}

for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
}

const boundary = spawnSync(
  process.execPath,
  [path.join(root, "tools/check-boundaries.mjs")],
  {
    cwd: root,
    encoding: "utf8",
  },
);
process.stdout.write(boundary.stdout);
process.stderr.write(boundary.stderr);
if (boundary.status !== 0) process.exit(boundary.status ?? 1);

const streamAccessAudit = spawnSync(
  process.execPath,
  [path.join(root, "tools/audit-durable-streams-access.mjs")],
  {
    cwd: root,
    encoding: "utf8",
  },
);
process.stdout.write(streamAccessAudit.stdout);
process.stderr.write(streamAccessAudit.stderr);
if (streamAccessAudit.status !== 0) {
  process.exit(streamAccessAudit.status ?? 1);
}
console.log(`PASS static syntax analysis files=${files.length}`);
