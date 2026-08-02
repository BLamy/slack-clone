import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { analyzeModuleSource } from "./import-analysis.mjs";
import { listFiles } from "./runtime-files.mjs";

const root = path.resolve(import.meta.dirname, "..");
const config = JSON.parse(
  await readFile(path.join(root, "tools/package-boundaries.json"), "utf8"),
);
const packageToLayer = new Map(
  Object.keys(config.layers).map((layer) => [`@stream-slack/${layer}`, layer]),
);
const failures = [];
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
  const declaredDependencies = Object.keys(manifest.dependencies ?? {});
  const declaredInternal = declaredDependencies
    .filter((name) => name.startsWith("@stream-slack/"))
    .map((name) => packageToLayer.get(name))
    .sort();
  const allowed = [...policy.mayImport].sort();
  if (JSON.stringify(declaredInternal) !== JSON.stringify(allowed)) {
    failures.push(
      `${layer} manifest declares [${declaredInternal.join(", ")}] but policy allows [${allowed.join(", ")}]`,
    );
  }
  const declaredExternal = declaredDependencies.filter(
    (name) => !name.startsWith("@stream-slack/"),
  );
  if (policy.pure && declaredExternal.length > 0) {
    failures.push(
      `${layer} pure-package manifest declares external dependencies [${declaredExternal.join(", ")}]`,
    );
  }

  for (const file of await listModules(path.join(packageRoot, "src"))) {
    const source = await readFile(file, "utf8");
    const analysis = analyzeModuleSource(source, relative(file));
    for (const specifier of analysis.imports) {
      const targetLayer = internalLayerFor(specifier);
      if (targetLayer && !policy.mayImport.includes(targetLayer)) {
        failures.push(
          `${relative(file)} imports forbidden layer ${targetLayer}`,
        );
      }
      if (
        isRelativeSpecifier(specifier) &&
        escapesPackage(file, specifier, packageRoot)
      ) {
        failures.push(
          `${relative(file)} imports a relative path outside package ${layer}: ${specifier}`,
        );
      }
      if (policy.pure && isCapabilityImport(specifier)) {
        failures.push(
          `${relative(file)} imports capability module ${specifier}`,
        );
      }
      if (policy.pure && isBareSpecifier(specifier)) {
        failures.push(
          `${relative(file)} imports non-local module ${specifier} from a pure package`,
        );
      }
    }
    if (policy.pure) {
      for (const capability of analysis.ambientCapabilities) {
        failures.push(
          `${relative(file)} reads forbidden ${capability} capability`,
        );
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

function isBareSpecifier(specifier) {
  return !isRelativeSpecifier(specifier);
}

function isRelativeSpecifier(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function internalLayerFor(specifier) {
  for (const [packageName, layer] of packageToLayer) {
    if (specifier === packageName || specifier.startsWith(`${packageName}/`)) {
      return layer;
    }
  }
  return undefined;
}

function escapesPackage(file, specifier, packageRoot) {
  const target = path.resolve(
    path.dirname(file),
    specifier.split(/[?#]/u, 1)[0],
  );
  const relativeTarget = path.relative(packageRoot, target);
  return (
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTarget)
  );
}

async function listModules(directory) {
  return listFiles(
    directory,
    (file) =>
      file.endsWith(".mjs") || file.endsWith(".js") || file.endsWith(".cjs"),
  );
}

function relative(file) {
  return path.relative(root, file);
}
