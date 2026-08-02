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
  const networkContainerIdentifiers = new Set(["globalThis", "self", "window"]);
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
          captureAliases(node.id, node.init, node);
        },
        AssignmentExpression(node) {
          if (node.operator === "=") {
            captureAliases(node.left, node.right, node);
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

      function captureAliases(pattern, value, expression) {
        if (!value) return;
        if (referencesProvider(expression, sourceCode, providerIdentifiers)) {
          for (const identifier of patternIdentifiers(pattern)) {
            providerIdentifiers.add(identifier);
          }
        }
        captureNetworkContainerAliases(
          pattern,
          value,
          networkContainerIdentifiers,
        );
        captureNetworkAliases(
          pattern,
          value,
          sourceCode,
          networkIdentifiers,
          networkContainerIdentifiers,
        );
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
  if (callee.type === "ChainExpression") {
    return isNetworkCall(callee.expression, sourceCode, networkIdentifiers);
  }
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

function isNetworkReference(
  node,
  sourceCode,
  networkIdentifiers,
  networkContainerIdentifiers,
) {
  if (node.type === "ChainExpression") {
    return isNetworkReference(
      node.expression,
      sourceCode,
      networkIdentifiers,
      networkContainerIdentifiers,
    );
  }
  if (node.type === "AwaitExpression") {
    return isNetworkReference(
      node.argument,
      sourceCode,
      networkIdentifiers,
      networkContainerIdentifiers,
    );
  }
  if (node.type === "SequenceExpression") {
    return node.expressions.some((expression) =>
      isNetworkReference(
        expression,
        sourceCode,
        networkIdentifiers,
        networkContainerIdentifiers,
      ),
    );
  }
  if (node.type === "ConditionalExpression") {
    return (
      isNetworkReference(
        node.consequent,
        sourceCode,
        networkIdentifiers,
        networkContainerIdentifiers,
      ) ||
      isNetworkReference(
        node.alternate,
        sourceCode,
        networkIdentifiers,
        networkContainerIdentifiers,
      )
    );
  }
  if (node.type === "LogicalExpression") {
    return (
      isNetworkReference(
        node.left,
        sourceCode,
        networkIdentifiers,
        networkContainerIdentifiers,
      ) ||
      isNetworkReference(
        node.right,
        sourceCode,
        networkIdentifiers,
        networkContainerIdentifiers,
      )
    );
  }
  if (node.type === "CallExpression") {
    const callee =
      node.callee.type === "ChainExpression"
        ? node.callee.expression
        : node.callee;
    return (
      callee.type === "MemberExpression" &&
      memberPropertyName(callee) === "bind" &&
      isNetworkReference(
        callee.object,
        sourceCode,
        networkIdentifiers,
        networkContainerIdentifiers,
      )
    );
  }
  if (node.type === "Identifier") {
    return (
      networkIdentifiers.has(node.name) || /(?:fetch|request)/iu.test(node.name)
    );
  }
  if (node.type !== "MemberExpression") return false;
  const property = memberPropertyName(node);
  return (
    typeof property === "string" &&
    /^(?:fetch|request)$/iu.test(property) &&
    (isNetworkContainerReference(node.object, networkContainerIdentifiers) ||
      /(?:axios|client|fetch|globalThis|http|request|undici)/iu.test(
        sourceCode.getText(node.object),
      ))
  );
}

function captureNetworkAliases(
  pattern,
  value,
  sourceCode,
  networkIdentifiers,
  networkContainerIdentifiers,
) {
  if (pattern.type === "Identifier") {
    if (
      isNetworkReference(
        value,
        sourceCode,
        networkIdentifiers,
        networkContainerIdentifiers,
      )
    ) {
      networkIdentifiers.add(pattern.name);
    }
    return;
  }
  if (pattern.type === "AssignmentPattern") {
    captureNetworkAliases(
      pattern.left,
      value,
      sourceCode,
      networkIdentifiers,
      networkContainerIdentifiers,
    );
    return;
  }
  if (pattern.type !== "ObjectPattern") return;

  const networkContainer =
    isNetworkContainerReference(value, networkContainerIdentifiers) ||
    /(?:axios|client|fetch|globalThis|http|request|self|undici|window)/iu.test(
      sourceCode.getText(value),
    );
  for (const property of pattern.properties) {
    if (property.type !== "Property") continue;
    const propertyName = patternPropertyName(property);
    if (
      typeof propertyName !== "string" ||
      (!/^(?:fetch|request)$/iu.test(propertyName) &&
        !(networkContainer && NETWORK_METHODS.has(propertyName.toLowerCase())))
    ) {
      continue;
    }
    for (const identifier of patternIdentifiers(property.value)) {
      networkIdentifiers.add(identifier);
    }
  }
}

function captureNetworkContainerAliases(
  pattern,
  value,
  networkContainerIdentifiers,
) {
  if (pattern.type === "Identifier") {
    if (isNetworkContainerReference(value, networkContainerIdentifiers)) {
      networkContainerIdentifiers.add(pattern.name);
    }
    return;
  }
  if (pattern.type === "AssignmentPattern") {
    captureNetworkContainerAliases(
      pattern.left,
      value,
      networkContainerIdentifiers,
    );
    return;
  }
  if (
    pattern.type !== "ObjectPattern" ||
    !isNetworkContainerReference(value, networkContainerIdentifiers)
  ) {
    return;
  }
  for (const property of pattern.properties) {
    if (property.type !== "Property") continue;
    if (!/^(?:globalThis|self|window)$/u.test(patternPropertyName(property))) {
      continue;
    }
    for (const identifier of patternIdentifiers(property.value)) {
      networkContainerIdentifiers.add(identifier);
    }
  }
}

function isNetworkContainerReference(node, networkContainerIdentifiers) {
  if (node.type === "ChainExpression") {
    return isNetworkContainerReference(
      node.expression,
      networkContainerIdentifiers,
    );
  }
  if (node.type === "AwaitExpression") {
    return isNetworkContainerReference(
      node.argument,
      networkContainerIdentifiers,
    );
  }
  if (node.type === "SequenceExpression") {
    return node.expressions.some((expression) =>
      isNetworkContainerReference(expression, networkContainerIdentifiers),
    );
  }
  if (node.type === "ConditionalExpression") {
    return (
      isNetworkContainerReference(
        node.consequent,
        networkContainerIdentifiers,
      ) ||
      isNetworkContainerReference(node.alternate, networkContainerIdentifiers)
    );
  }
  if (node.type === "LogicalExpression") {
    return (
      isNetworkContainerReference(node.left, networkContainerIdentifiers) ||
      isNetworkContainerReference(node.right, networkContainerIdentifiers)
    );
  }
  if (node.type === "Identifier") {
    return networkContainerIdentifiers.has(node.name);
  }
  if (node.type !== "MemberExpression") return false;
  const property = memberPropertyName(node);
  return (
    typeof property === "string" &&
    /^(?:globalThis|self|window)$/u.test(property) &&
    isNetworkContainerReference(node.object, networkContainerIdentifiers)
  );
}

function patternIdentifiers(pattern) {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "AssignmentPattern") {
    return patternIdentifiers(pattern.left);
  }
  if (pattern.type === "RestElement") {
    return patternIdentifiers(pattern.argument);
  }
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.flatMap((property) =>
      property.type === "Property"
        ? patternIdentifiers(property.value)
        : patternIdentifiers(property.argument),
    );
  }
  if (pattern.type === "ArrayPattern") {
    return pattern.elements.flatMap((element) => patternIdentifiers(element));
  }
  return [];
}

function patternPropertyName(property) {
  if (!property.computed && property.key.type === "Identifier") {
    return property.key.name;
  }
  if (property.key.type === "Literal") return property.key.value;
  return null;
}

function memberPropertyName(member) {
  if (!member.computed && member.property.type === "Identifier") {
    return member.property.name;
  }
  if (member.property.type === "Literal") return member.property.value;
  return null;
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
