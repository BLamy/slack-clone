import { readdir } from "node:fs/promises";
import path from "node:path";

export const RUNTIME_ROOTS = Object.freeze(["src", "packages", "public"]);
export const ANALYSIS_ROOTS = Object.freeze([
  "src",
  "packages",
  "public",
  "scripts",
  "tools",
  "test",
  "tests",
]);
export const EXECUTABLE_EXTENSIONS = Object.freeze(
  new Set([".cjs", ".js", ".mjs"]),
);

export function isExecutableFile(file) {
  return EXECUTABLE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

export async function listExecutableFiles(
  repositoryRoot,
  roots = RUNTIME_ROOTS,
) {
  const files = [];
  for (const directory of roots) {
    files.push(
      ...(await listFiles(
        path.join(repositoryRoot, directory),
        isExecutableFile,
      )),
    );
  }
  return [...new Set(files)].sort();
}

export async function listFiles(directory, accept = () => true) {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath, accept)));
    } else if (entry.isFile() && accept(entryPath)) {
      files.push(entryPath);
    }
  }
  return files.sort();
}
