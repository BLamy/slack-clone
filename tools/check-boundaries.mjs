import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const config = JSON.parse(
  await readFile(path.join(root, "tools/package-boundaries.json"), "utf8"),
);
const packageToLayer = new Map(
  Object.keys(config.layers).map((layer) => [`@stream-slack/${layer}`, layer]),
);
const failures = [];
const forbiddenPurePatterns = [
  ["environment", /\bprocess\s*\.\s*env\b/u],
  ["network", /\b(?:fetch|WebSocket|EventSource)\s*\(/u],
  ["clock", /\b(?:Date(?:\.now)?|performance\.now)\s*\(/u],
  ["timer", /\b(?:setTimeout|setInterval|queueMicrotask)\s*\(/u],
  ["randomness", /\b(?:Math\.random|crypto\.randomUUID)\s*\(/u],
  ["dynamic import", /\bimport\s*\(/u],
];

for (const [layer, policy] of Object.entries(config.layers)) {
  const packageRoot = path.join(root, policy.path);
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  );
  assert.equal(
    manifest.name,
    `@stream-slack/${layer}`,
    `${layer} package name must match its layer`,
  );
  const declaredInternal = Object.keys(manifest.dependencies ?? {})
    .filter((name) => name.startsWith("@stream-slack/"))
    .map((name) => packageToLayer.get(name))
    .sort();
  const allowed = [...policy.mayImport].sort();
  if (JSON.stringify(declaredInternal) !== JSON.stringify(allowed)) {
    failures.push(
      `${layer} manifest declares [${declaredInternal.join(", ")}] but policy allows [${allowed.join(", ")}]`,
    );
  }

  for (const file of await listModules(path.join(packageRoot, "src"))) {
    const source = await readFile(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      const targetLayer = packageToLayer.get(specifier);
      if (targetLayer && !policy.mayImport.includes(targetLayer)) {
        failures.push(
          `${relative(file)} imports forbidden layer ${targetLayer}`,
        );
      }
      if (policy.pure && isCapabilityImport(specifier)) {
        failures.push(
          `${relative(file)} imports capability module ${specifier}`,
        );
      }
    }
    if (policy.pure) {
      for (const [name, pattern] of forbiddenPurePatterns) {
        if (pattern.test(source))
          failures.push(`${relative(file)} reads forbidden ${name} capability`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error("Backend package boundary violations:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    "PASS backend package dependency direction and pure-leaf capability boundary",
  );
  console.log(`layers=${Object.keys(config.layers).length} violations=0`);
}

function isCapabilityImport(specifier) {
  return (
    specifier.startsWith("node:") ||
    /(?:^|\/)(?:http|https|fs|net|tls|dns|dgram|child_process|worker_threads)(?:\/|$)/u.test(
      specifier,
    ) ||
    [
      "@stream-slack/durable-streams",
      "@stream-slack/http",
      "@stream-slack/services",
    ].includes(specifier)
  );
}

function importSpecifiers(source) {
  const matches = source.matchAll(
    /(?:^|\n)\s*(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu,
  );
  return [...matches].map((match) => match[1]);
}

async function listModules(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listModules(entryPath)));
    else if (entry.name.endsWith(".mjs")) files.push(entryPath);
  }
  return files.sort();
}

function relative(file) {
  return path.relative(root, file);
}
