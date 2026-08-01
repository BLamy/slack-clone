import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const roots = ["src", "packages", "scripts", "tools", "test", "tests"];
const files = [];
for (const directory of roots)
  files.push(...(await listModules(path.join(root, directory))));
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
console.log(`PASS static syntax analysis files=${files.length}`);

async function listModules(directory) {
  const found = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return found;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await listModules(entryPath)));
    else if (entry.name.endsWith(".mjs")) found.push(entryPath);
  }
  return found;
}
