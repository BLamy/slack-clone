import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Linter } from "eslint";

const root = path.resolve(import.meta.dirname, "..");
const OFFICIAL_CLIENT = "@durable-streams/client";
const ALLOWED_NETWORK_PATHS = [
  "packages/durable-streams/",
  "scripts/verify-e0-t03-conformance.mjs",
];
const PROVIDER_REFERENCE =
  /(?:DURABLE_STREAMS|durableStreams|durable-streams|streamOrigin|streamUrl|\/rooms\/[^\s"'`]*\/messages)/u;
const BROWSER_SECRET_REFERENCE =
  /(?:DURABLE_STREAMS_ADMIN_TOKEN|EMULATE_TOKEN|test_token_admin|Authorization\s*:\s*["'`]Bearer)/u;
const NETWORK_METHODS = new Set([
  "delete",
  "fetch",
  "get",
  "head",
  "patch",
  "post",
  "put",
  "request",
]);

export function analyzeDurableStreamsAccess(source, filename = "module.mjs") {
  const violations = [];
  const providerIdentifiers = new Set();
  const networkIdentifiers = new Set(["fetch"]);
  let sourceCode;
  const captureRule = {
    meta: { type: "problem", schema: [] },
    create(context) {
      sourceCode = context.sourceCode;
      return {
        ImportDeclaration(node) {
          captureOfficialClientImport(node.source, node.loc.start.line);
        },
        ExportNamedDeclaration(node) {
          if (node.source) {
            captureOfficialClientImport(node.source, node.loc.start.line);
          }
        },
        ExportAllDeclaration(node) {
          captureOfficialClientImport(node.source, node.loc.start.line);
        },
        ImportExpression(node) {
          captureOfficialClientImport(node.source, node.loc.start.line);
        },
        VariableDeclarator(node) {
          if (
            node.id.type === "Identifier" &&
            node.init &&
            referencesProvider(node.init, sourceCode, providerIdentifiers)
          ) {
            providerIdentifiers.add(node.id.name);
          }
          if (
            node.id.type === "Identifier" &&
            node.init &&
            isNetworkReference(node.init, sourceCode, networkIdentifiers)
          ) {
            networkIdentifiers.add(node.id.name);
          }
        },
        CallExpression(node) {
          if (!isNetworkCall(node.callee, sourceCode, networkIdentifiers)) {
            return;
          }
          const target = node.arguments[0];
          if (
            target &&
            referencesProvider(target, sourceCode, providerIdentifiers) &&
            !isApplicationApiReference(target, sourceCode)
          ) {
            violations.push({
              kind: "direct-provider-network",
              line: node.loc.start.line,
              message: `calls Durable Streams directly via ${sourceCode.getText(node.callee)}`,
            });
          }
        },
      };

      function captureOfficialClientImport(node, line) {
        if (node.type !== "Literal" || node.value !== OFFICIAL_CLIENT) return;
        violations.push({
          kind: "official-client-import",
          line,
          message: `imports ${OFFICIAL_CLIENT}`,
        });
      }
    },
  };
  const linter = new Linter({ configType: "flat" });
  const messages = linter.verify(
    source,
    [
      {
        languageOptions: {
          ecmaVersion: "latest",
          sourceType: "module",
        },
        plugins: { streams: { rules: { capture: captureRule } } },
        rules: { "streams/capture": "error" },
      },
    ],
    { filename },
  );
  const parseError = messages.find((message) => message.fatal);
  if (parseError) {
    throw new SyntaxError(
      `${filename}:${parseError.line}:${parseError.column} ${parseError.message}`,
    );
  }
  return violations;
}

export async function auditDurableStreamsAccess({
  repositoryRoot = root,
} = {}) {
  const failures = [];
  const roots = [
    "src",
    "packages",
    "scripts",
    "tools",
    "test",
    "tests",
    "public",
  ];
  const modules = [];
  for (const directory of roots) {
    modules.push(
      ...(await listFiles(
        path.join(repositoryRoot, directory),
        (file) => file.endsWith(".mjs") || file.endsWith(".js"),
      )),
    );
  }

  for (const file of modules.sort()) {
    const relative = slash(path.relative(repositoryRoot, file));
    const allowed = ALLOWED_NETWORK_PATHS.some(
      (entry) => relative === entry || relative.startsWith(entry),
    );
    if (allowed) continue;
    const source = await readFile(file, "utf8");
    for (const violation of analyzeDurableStreamsAccess(source, relative)) {
      failures.push(`${relative}:${violation.line} ${violation.message}`);
    }
  }

  const manifests = await listFiles(
    path.join(repositoryRoot, "packages"),
    (file) => path.basename(file) === "package.json",
  );
  for (const file of manifests) {
    const relative = slash(path.relative(repositoryRoot, file));
    if (relative === "packages/durable-streams/package.json") continue;
    const source = await readFile(file, "utf8");
    if (source.includes(OFFICIAL_CLIENT)) {
      failures.push(`${relative} declares forbidden ${OFFICIAL_CLIENT}`);
    }
  }

  const publicFiles = await listFiles(
    path.join(repositoryRoot, "public"),
    () => true,
  );
  for (const file of publicFiles) {
    const source = await readFile(file, "utf8");
    if (BROWSER_SECRET_REFERENCE.test(source)) {
      failures.push(
        `${slash(path.relative(repositoryRoot, file))} references a server credential`,
      );
    }
  }

  return {
    filesScanned: modules.length + manifests.length + publicFiles.length,
    failures,
  };
}

function referencesProvider(node, sourceCode, providerIdentifiers) {
  const text = sourceCode.getText(node);
  if (PROVIDER_REFERENCE.test(text)) return true;
  return [...providerIdentifiers].some((identifier) =>
    new RegExp(`\\b${escapeRegExp(identifier)}\\b`, "u").test(text),
  );
}

function isApplicationApiReference(node, sourceCode) {
  const text = sourceCode.getText(node);
  return /["'`]\/api\/rooms\//u.test(text);
}

function isNetworkCall(callee, sourceCode, networkIdentifiers) {
  if (callee.type === "Identifier") {
    return (
      networkIdentifiers.has(callee.name) ||
      /(?:fetch|request)/iu.test(callee.name)
    );
  }
  if (callee.type !== "MemberExpression") return false;
  const property = callee.computed
    ? callee.property.type === "Literal"
      ? callee.property.value
      : null
    : callee.property.type === "Identifier"
      ? callee.property.name
      : null;
  if (typeof property !== "string" || !NETWORK_METHODS.has(property)) {
    return false;
  }
  if (property === "fetch" || property === "request") return true;
  return /(?:axios|client|fetch|http|request)/iu.test(
    sourceCode.getText(callee.object),
  );
}

function isNetworkReference(node, sourceCode, networkIdentifiers) {
  if (node.type === "Identifier") {
    return (
      networkIdentifiers.has(node.name) || /(?:fetch|request)/iu.test(node.name)
    );
  }
  if (node.type !== "MemberExpression") return false;
  const property = node.computed
    ? node.property.type === "Literal"
      ? node.property.value
      : null
    : node.property.type === "Identifier"
      ? node.property.name
      : null;
  return (
    typeof property === "string" &&
    /^(?:fetch|request)$/iu.test(property) &&
    /(?:axios|client|fetch|globalThis|http|request|undici)/iu.test(
      sourceCode.getText(node.object),
    )
  );
}

async function listFiles(directory, include) {
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
    if (entry.isDirectory())
      found.push(...(await listFiles(entryPath, include)));
    else if (include(entryPath)) found.push(entryPath);
  }
  return found;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function slash(value) {
  return value.split(path.sep).join("/");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await auditDurableStreamsAccess();
  if (result.failures.length > 0) {
    console.error("Durable Streams access violations:");
    for (const failure of result.failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(
      `PASS Durable Streams adapter-only access files=${result.filesScanned} violations=0`,
    );
  }
}
