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
  const providerReferences = new Set();
  const network = {
    containers: new Set(["globalThis", "self", "window"]),
    identifiers: new Set(["fetch"]),
    invokers: new Set(["Reflect.apply"]),
    members: new Set(),
    taintedContainers: new Set(),
  };
  let sourceCode;
  const captureRule = {
    meta: { type: "problem", schema: [] },
    create(context) {
      sourceCode = context.sourceCode;
      const aliases = [];
      const calls = [];
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
          aliases.push({
            pattern: node.id,
            value: node.init,
            expression: node,
          });
        },
        FunctionDeclaration(node) {
          if (node.id) {
            aliases.push({ pattern: node.id, value: node, expression: node });
          }
        },
        ClassDeclaration(node) {
          if (node.id) {
            aliases.push({ pattern: node.id, value: node, expression: node });
          }
        },
        AssignmentExpression(node) {
          if (node.operator === "=") {
            aliases.push({
              pattern: node.left,
              value: node.right,
              expression: node,
            });
          }
        },
        CallExpression(node) {
          calls.push(node);
        },
        "Program:exit"() {
          let previousFactCount = -1;
          while (previousFactCount !== factCount()) {
            previousFactCount = factCount();
            for (const { pattern, value, expression } of aliases) {
              captureAliases(pattern, value, expression);
            }
          }

          for (const node of calls) {
            const invocation = describeNetworkCall(node, sourceCode, network);
            if (!invocation) continue;
            for (const target of networkCallTargets(node, invocation)) {
              if (
                referencesProvider(target, sourceCode, providerReferences) &&
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
        if (referencesProvider(expression, sourceCode, providerReferences)) {
          captureProviderAliases(pattern, providerReferences);
        }
        captureNetworkContainerAliases(pattern, value, network.containers);
        captureNetworkAliases(pattern, value, sourceCode, network);
      }

      function factCount() {
        return (
          providerReferences.size +
          network.containers.size +
          network.identifiers.size +
          network.invokers.size +
          network.members.size +
          network.taintedContainers.size
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

function captureProviderAliases(pattern, providerReferences) {
  for (const identifier of patternIdentifiers(pattern)) {
    providerReferences.add(identifier);
  }
  const target = unwrapChain(pattern);
  if (target.type !== "MemberExpression") return;
  const reference = memberReference(target);
  const container = memberReference(target.object);
  if (reference) providerReferences.add(reference);
  if (container) providerReferences.add(container);
}

function referencesProvider(node, sourceCode, providerReferences) {
  const text = sourceCode.getText(node);
  if (PROVIDER_REFERENCE.test(text)) return true;
  return [...providerReferences].some((reference) =>
    new RegExp(`\\b${escapeRegExp(reference)}\\b`, "u").test(text),
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
  if (isNetworkInvokerReference(callee, sourceCode, network)) {
    return "indirect";
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
  if (invocation === "indirect") {
    return node.arguments;
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
    expression.type === "FunctionDeclaration" ||
    expression.type === "ClassExpression" ||
    expression.type === "ClassDeclaration"
  ) {
    return containsProviderCapableNetworkUse(
      expression.body,
      sourceCode,
      network,
    );
  }
  if (expression.type === "CallExpression") {
    const callee = unwrapChain(expression.callee);
    if (
      callee.type === "MemberExpression" &&
      memberPropertyName(callee) === "bind" &&
      isNetworkReference(callee.object, sourceCode, network)
    ) {
      return true;
    }
    return (
      expression.arguments.some((argument) =>
        isNetworkReference(argument, sourceCode, network),
      ) ||
      (expression.arguments.length === 0 &&
        isNetworkReference(callee, sourceCode, network))
    );
  }
  if (expression.type === "NewExpression") {
    return (
      isNetworkReference(expression.callee, sourceCode, network) ||
      expression.arguments.some((argument) =>
        isNetworkReference(argument, sourceCode, network),
      )
    );
  }
  if (
    expression.type === "ObjectExpression" ||
    expression.type === "ArrayExpression"
  ) {
    return containsNetworkReference(expression, sourceCode, network);
  }
  if (expression.type === "Identifier") {
    return (
      network.identifiers.has(expression.name) ||
      /(?:fetch|request)/iu.test(expression.name)
    );
  }
  if (expression.type !== "MemberExpression") return false;
  const reference = memberReference(expression);
  if (
    reference &&
    (network.members.has(reference) || network.invokers.has(reference))
  ) {
    return true;
  }
  const property = memberPropertyName(expression);
  if (isTaintedNetworkContainer(expression.object, network)) return true;
  if (
    (property === "bind" || property === "call" || property === "apply") &&
    isNetworkReference(expression.object, sourceCode, network)
  ) {
    return true;
  }
  return (
    ((typeof property === "string" && /^(?:fetch|request)$/iu.test(property)) ||
      (expression.computed && property === null)) &&
    (isNetworkContainerReference(expression.object, network.containers) ||
      /(?:axios|client|fetch|globalThis|http|request|undici)/iu.test(
        sourceCode.getText(expression.object),
      ))
  );
}

function containsNetworkReference(node, sourceCode, network) {
  if (!node || typeof node !== "object") return false;
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
        value.some(
          (item) =>
            item &&
            (isNetworkReference(item, sourceCode, network) ||
              containsNetworkReference(item, sourceCode, network)),
        )
      ) {
        return true;
      }
    } else if (
      value &&
      typeof value === "object" &&
      (isNetworkReference(value, sourceCode, network) ||
        containsNetworkReference(value, sourceCode, network))
    ) {
      return true;
    }
  }
  return false;
}

function containsProviderCapableNetworkUse(node, sourceCode, network) {
  if (!node || typeof node !== "object") return false;
  if (
    (node.type === "Identifier" || node.type === "MemberExpression") &&
    isNetworkReference(node, sourceCode, network)
  ) {
    return true;
  }
  if (node.type === "CallExpression") {
    const invocation = describeNetworkCall(node, sourceCode, network);
    if (invocation) {
      const targets = networkCallTargets(node, invocation);
      return (
        targets.length === 0 ||
        targets.some((target) => !isApplicationApiReference(target, sourceCode))
      );
    }
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
          containsProviderCapableNetworkUse(item, sourceCode, network),
        )
      ) {
        return true;
      }
    } else if (
      value &&
      typeof value === "object" &&
      containsProviderCapableNetworkUse(value, sourceCode, network)
    ) {
      return true;
    }
  }
  return false;
}

function isNetworkInvokerReference(node, sourceCode, network) {
  const expression = unwrapChain(node);
  if (expression.type === "AwaitExpression") {
    return isNetworkInvokerReference(expression.argument, sourceCode, network);
  }
  if (expression.type === "SequenceExpression") {
    return expression.expressions.some((item) =>
      isNetworkInvokerReference(item, sourceCode, network),
    );
  }
  if (expression.type === "ConditionalExpression") {
    return (
      isNetworkInvokerReference(expression.consequent, sourceCode, network) ||
      isNetworkInvokerReference(expression.alternate, sourceCode, network)
    );
  }
  if (expression.type === "LogicalExpression") {
    return (
      isNetworkInvokerReference(expression.left, sourceCode, network) ||
      isNetworkInvokerReference(expression.right, sourceCode, network)
    );
  }
  if (expression.type === "CallExpression") {
    const callee = unwrapChain(expression.callee);
    return (
      callee.type === "MemberExpression" &&
      memberPropertyName(callee) === "bind" &&
      isNetworkInvokerReference(callee.object, sourceCode, network)
    );
  }
  const reference = memberReference(expression);
  if (reference && network.invokers.has(reference)) return true;
  if (expression.type === "Identifier") {
    return network.invokers.has(expression.name);
  }
  if (expression.type !== "MemberExpression") return false;
  const method = memberPropertyName(expression);
  return (
    (method === "call" || method === "apply") &&
    isNetworkReference(expression.object, sourceCode, network)
  );
}

function captureNetworkAliases(pattern, value, sourceCode, network) {
  const target = unwrapChain(pattern);
  const networkValue = isNetworkReference(value, sourceCode, network);
  const invokerValue = isNetworkInvokerReference(value, sourceCode, network);
  const containerValue = isNetworkContainerValue(value, sourceCode, network);
  if (target.type === "Identifier") {
    captureObjectNetworkMembers(target.name, value, sourceCode, network);
    if (networkValue) {
      network.identifiers.add(target.name);
    }
    if (invokerValue) network.invokers.add(target.name);
    if (containerValue) {
      network.containers.add(target.name);
      network.taintedContainers.add(target.name);
    }
    if (network.taintedContainers.has(target.name)) {
      const sourceContainer = memberReference(value);
      if (sourceContainer) {
        network.containers.add(sourceContainer);
        network.taintedContainers.add(sourceContainer);
        if (value.type === "Identifier") {
          network.identifiers.add(value.name);
        }
      }
    }
    return;
  }
  if (target.type === "MemberExpression") {
    const reference = memberReference(target);
    const container = memberReference(target.object);
    if (reference && networkValue) {
      network.members.add(reference);
    }
    if (reference && invokerValue) network.invokers.add(reference);
    if (container && (networkValue || containerValue)) {
      network.containers.add(container);
      network.taintedContainers.add(container);
    }
    return;
  }
  if (target.type === "AssignmentPattern") {
    captureNetworkAliases(target.left, value, sourceCode, network);
    return;
  }
  if (
    (target.type === "ObjectPattern" || target.type === "ArrayPattern") &&
    (networkValue || containerValue)
  ) {
    for (const identifier of patternIdentifiers(target)) {
      network.identifiers.add(identifier);
      if (containerValue) {
        network.containers.add(identifier);
        network.taintedContainers.add(identifier);
      }
      if (invokerValue) network.invokers.add(identifier);
    }
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

function isNetworkContainerValue(node, sourceCode, network) {
  const expression = unwrapChain(node);
  if (
    expression.type === "ObjectExpression" ||
    expression.type === "ArrayExpression" ||
    expression.type === "ClassExpression" ||
    expression.type === "ClassDeclaration"
  ) {
    return isNetworkReference(expression, sourceCode, network);
  }
  if (expression.type === "NewExpression") {
    return isTaintedNetworkContainer(expression.callee, network);
  }
  return isTaintedNetworkContainer(expression, network);
}

function isTaintedNetworkContainer(node, network) {
  const reference = memberReference(node);
  if (!reference) return false;
  for (const container of network.taintedContainers) {
    if (reference === container || reference.startsWith(`${container}.`)) {
      return true;
    }
  }
  return false;
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
