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
  const network = {
    containers: new Set(["globalThis", "self", "window"]),
    identifiers: new Set(["fetch"]),
    members: new Set(),
  };
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
        FunctionDeclaration(node) {
          if (node.id && isNetworkReference(node, sourceCode, network)) {
            network.identifiers.add(node.id.name);
          }
        },
        AssignmentExpression(node) {
          if (node.operator === "=") {
            captureAliases(node.left, node.right, node);
          }
        },
        CallExpression(node) {
          const invocation = describeNetworkCall(node, sourceCode, network);
          if (!invocation) return;
          for (const target of networkCallTargets(node, invocation)) {
            if (
              referencesProvider(target, sourceCode, providerIdentifiers) &&
              !isApplicationApiReference(target, sourceCode)
            ) {
              violations.push({
                kind: "direct-provider-network",
                line: node.loc.start.line,
                message: `calls Durable Streams directly via ${sourceCode.getText(node.callee)}`,
              });
              break;
            }
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
        captureNetworkContainerAliases(pattern, value, network.containers);
        captureNetworkAliases(pattern, value, sourceCode, network);
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

function describeNetworkCall(node, sourceCode, network) {
  const callee = unwrapChain(node.callee);
  if (
    callee.type === "MemberExpression" &&
    memberReference(callee) === "Reflect.apply" &&
    node.arguments[0] &&
    isNetworkReference(node.arguments[0], sourceCode, network)
  ) {
    return "reflect-apply";
  }
  if (callee.type === "MemberExpression") {
    const method = memberPropertyName(callee);
    if (
      (method === "call" || method === "apply") &&
      isNetworkReference(callee.object, sourceCode, network)
    ) {
      return method;
    }
  }
  return isNetworkReference(callee, sourceCode, network) ? "direct" : null;
}

function networkCallTargets(node, invocation) {
  if (invocation === "call") {
    return node.arguments[1] ? [node.arguments[1]] : [];
  }
  if (invocation === "apply") {
    return appliedTargets(node.arguments[1]);
  }
  if (invocation === "reflect-apply") {
    return appliedTargets(node.arguments[2]);
  }
  return node.arguments[0] ? [node.arguments[0]] : [];
}

function appliedTargets(argument) {
  if (!argument) return [];
  if (argument.type !== "ArrayExpression") return [argument];
  return argument.elements[0] ? [argument.elements[0]] : [];
}

function isNetworkReference(node, sourceCode, network) {
  const expression = unwrapChain(node);
  if (expression.type === "AwaitExpression") {
    return isNetworkReference(expression.argument, sourceCode, network);
  }
  if (expression.type === "SequenceExpression") {
    return expression.expressions.some((item) =>
      isNetworkReference(item, sourceCode, network),
    );
  }
  if (expression.type === "ConditionalExpression") {
    return (
      isNetworkReference(expression.consequent, sourceCode, network) ||
      isNetworkReference(expression.alternate, sourceCode, network)
    );
  }
  if (expression.type === "LogicalExpression") {
    return (
      isNetworkReference(expression.left, sourceCode, network) ||
      isNetworkReference(expression.right, sourceCode, network)
    );
  }
  if (
    expression.type === "ArrowFunctionExpression" ||
    expression.type === "FunctionExpression" ||
    expression.type === "FunctionDeclaration"
  ) {
    return containsNetworkInvocation(expression.body, sourceCode, network);
  }
  if (expression.type === "CallExpression") {
    const callee = unwrapChain(expression.callee);
    return (
      callee.type === "MemberExpression" &&
      memberPropertyName(callee) === "bind" &&
      isNetworkReference(callee.object, sourceCode, network)
    );
  }
  if (expression.type === "Identifier") {
    return (
      network.identifiers.has(expression.name) ||
      /(?:fetch|request)/iu.test(expression.name)
    );
  }
  if (expression.type !== "MemberExpression") return false;
  const reference = memberReference(expression);
  if (reference && network.members.has(reference)) return true;
  const property = memberPropertyName(expression);
  return (
    typeof property === "string" &&
    /^(?:fetch|request)$/iu.test(property) &&
    (isNetworkContainerReference(expression.object, network.containers) ||
      /(?:axios|client|fetch|globalThis|http|request|undici)/iu.test(
        sourceCode.getText(expression.object),
      ))
  );
}

function containsNetworkInvocation(node, sourceCode, network) {
  if (!node || typeof node !== "object") return false;
  if (
    node.type === "CallExpression" &&
    describeNetworkCall(node, sourceCode, network)
  ) {
    return true;
  }
  for (const [key, value] of Object.entries(node)) {
    if (
      key === "parent" ||
      key === "loc" ||
      key === "range" ||
      key === "tokens" ||
      key === "comments"
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      if (
        value.some((item) =>
          containsNetworkInvocation(item, sourceCode, network),
        )
      ) {
        return true;
      }
    } else if (containsNetworkInvocation(value, sourceCode, network)) {
      return true;
    }
  }
  return false;
}

function captureNetworkAliases(pattern, value, sourceCode, network) {
  const target = unwrapChain(pattern);
  if (target.type === "Identifier") {
    captureObjectNetworkMembers(target.name, value, sourceCode, network);
    if (isNetworkReference(value, sourceCode, network)) {
      network.identifiers.add(target.name);
    }
    return;
  }
  if (target.type === "MemberExpression") {
    const reference = memberReference(target);
    if (reference && isNetworkReference(value, sourceCode, network)) {
      network.members.add(reference);
    }
    return;
  }
  if (target.type === "AssignmentPattern") {
    captureNetworkAliases(target.left, value, sourceCode, network);
    return;
  }
  if (target.type !== "ObjectPattern") return;

  const networkContainer =
    isNetworkContainerReference(value, network.containers) ||
    /(?:axios|client|fetch|globalThis|http|request|self|undici|window)/iu.test(
      sourceCode.getText(value),
    );
  for (const property of target.properties) {
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
      network.identifiers.add(identifier);
    }
  }
}

function captureObjectNetworkMembers(name, value, sourceCode, network) {
  if (value.type !== "ObjectExpression") return;
  for (const property of value.properties) {
    if (property.type !== "Property") continue;
    const propertyName = patternPropertyName(property);
    if (
      typeof propertyName === "string" &&
      isNetworkReference(property.value, sourceCode, network)
    ) {
      network.members.add(`${name}.${propertyName}`);
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
  return staticStringValue(property.key);
}

function memberPropertyName(member) {
  if (!member.computed && member.property.type === "Identifier") {
    return member.property.name;
  }
  return staticStringValue(member.property);
}

function staticStringValue(node) {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  }
  return null;
}

function memberReference(node) {
  const expression = unwrapChain(node);
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "ThisExpression") return "this";
  if (expression.type !== "MemberExpression") return null;
  const object = memberReference(expression.object);
  const property = memberPropertyName(expression);
  return object && typeof property === "string"
    ? `${object}.${property}`
    : null;
}

function unwrapChain(node) {
  return node.type === "ChainExpression" ? node.expression : node;
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
