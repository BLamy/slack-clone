import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const artifactBase = path.join(root, ".artifacts");
const runId = String(process.env.TEST_RUN_ID ?? `build-${process.pid}`)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/g, "-");
const output = path.resolve(
  process.env.BUILD_DIR ?? path.join(artifactBase, "e0-t02", runId, "build"),
);
if (!output.startsWith(`${artifactBase}${path.sep}`)) {
  throw new Error(`BUILD_DIR must remain inside ${artifactBase}`);
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const directory of ["docs", "packages", "public", "src"]) {
  await cp(path.join(root, directory), path.join(output, directory), {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`),
  });
}
for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
  await cp(path.join(root, file), path.join(output, file));
}

const files = await listFiles(output);
const manifest = {
  schemaVersion: 1,
  runId,
  entrypoint: "src/server.mjs",
  files: [],
};
for (const file of files) {
  const bytes = await readFile(file);
  manifest.files.push({
    path: path.relative(output, file),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
await writeFile(
  path.join(output, "build-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(`PASS build output=${output} files=${manifest.files.length}`);

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(entryPath)));
    else if ((await stat(entryPath)).isFile()) files.push(entryPath);
  }
  return files.sort();
}
