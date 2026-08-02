import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Linter } from "eslint";

const root = path.resolve(import.meta.dirname, "..");
const OFFICIAL_CLIENT = "@durable-streams/client";
const RUNTIME_ROOTS = ["src", "packages", "public"];
const PROVIDER_REFERENCE =
  /(?:DURABLE_STREAMS|durableStreams|streamOrigin|streams\.invalid|https?:\/\/[^\s"'`]+\/rooms\/)/u;
const BROWSER_SECRET_REFERENCE =
  /(?:DURABLE_STREAMS_ADMIN_TOKEN|EMULATE_TOKEN|test_token_admin|Authorization\s*:\s*["'`]Bearer)/u;
const AMBIENT_NETWORK_GLOBALS = new Set([
  "EventSource",
  "Function",
  "WebSocket",
  "XMLHttpRequest",
  "eval",
  "fetch",
]);
const GLOBAL_CONTAINERS = new Set(["globalThis", "self", "window"]);
const NETWORK_MEMBER_NAMES = new Set([
  "EventSource",
  "WebSocket",
  "XMLHttpRequest",
  "fetch",
]);
const GLOBAL_ESCAPE_MEMBER_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const NETWORK_MODULE_PATTERN =
  /^(?:node:)?(?:dgram|http|http2|https|net|tls)$|^(?:axios|eventsource|got|ky|node-fetch|superagent|undici|ws)(?:\/|$)/u;
const NON_PROVIDER_DOOR_IMPORTS = new Set([
  "./auth0-client.mjs",
  "./application-api.js",
  "/application-api.js",
]);

const NETWORK_DOORS = Object.freeze([
  Object.freeze({
    prefix: "packages/durable-streams/",
    allowAmbient: true,
    allowOfficialClient: true,
    provider: true,
  }),
  Object.freeze({
    exact: "scripts/verify-e0-t03-conformance.mjs",
    allowAmbient: true,
    allowOfficialClient: false,
    provider: true,
  }),
  Object.freeze({
    exact: "src/auth0-client.mjs",
    allowAmbient: true,
    allowOfficialClient: false,
    provider: false,
  }),
  Object.freeze({
    exact: "public/application-api.js",
    allowAmbient: true,
    allowOfficialClient: false,
    provider: false,
  }),
]);

const FILE_POLICIES = Object.freeze([
  Object.freeze({
    exact: "src/http-server.mjs",
    allowedNetworkImports: new Map([["node:http", new Set(["createServer"])]]),
  }),
]);

/**
 * Enforce the architecture boundary rather than attempting unsound whole-program
 * target tainting. A module outside a declared transport door may not acquire an
 * ambient network capability. The doors export bounded operations, never raw fetch.
 */
export function analyzeDurableStreamsAccess(source, filename = "module.mjs") {
  const relative = slash(filename);
  const door = doorFor(relative);
  const filePolicy = filePolicyFor(relative);
  const violations = [];
  const seen = new Set();
  const rawCapabilityBindings = new Set();
  const exportedBindings = new Set();
  let importsNonProviderDoor = false;
  let importsProviderDoor = false;
  let sourceCode;

  function report(kind, line, message) {
    const key = new Set([
      "direct-provider-network",
      "network-capability-export",
    ]).has(kind)
      ? kind
      : `${kind}:${line}:${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ kind, line, message });
  }

  function inspectModuleSource(node, { declaration, exported = false } = {}) {
    if (node?.type !== "Literal" || typeof node.value !== "string") return;
    const specifier = node.value;
    if (specifier === OFFICIAL_CLIENT && !door?.allowOfficialClient) {
      report(
        "official-client-import",
        node.loc.start.line,
        `imports ${OFFICIAL_CLIENT} outside the Durable Streams adapter`,
      );
    }
    if (NON_PROVIDER_DOOR_IMPORTS.has(specifier)) {
      importsNonProviderDoor = true;
    }
    if (specifier === "@stream-slack/durable-streams") {
      importsProviderDoor = true;
    }
    const allowedImports = filePolicy.allowedNetworkImports.get(specifier);
    if (
      NETWORK_MODULE_PATTERN.test(specifier) &&
      !door?.allowAmbient &&
      !allowedImports
    ) {
      report(
        "direct-provider-network",
        node.loc.start.line,
        `imports outbound network module ${specifier} outside a declared transport door`,
      );
    }
    if (allowedImports && declaration?.type === "ImportDeclaration") {
      for (const imported of declaration.specifiers) {
        const name =
          imported.type === "ImportSpecifier"
            ? imported.imported.name
            : imported.type === "ImportDefaultSpecifier"
              ? "default"
              : "*";
        if (!allowedImports.has(name)) {
          report(
            "direct-provider-network",
            imported.loc.start.line,
            `imports outbound network capability ${name} from ${specifier}`,
          );
        }
      }
    }
    if (exported && NETWORK_MODULE_PATTERN.test(specifier)) {
      report(
        "network-capability-export",
        node.loc.start.line,
        `re-exports outbound network module ${specifier}`,
      );
    }
  }

  const captureRule = {
    meta: { type: "problem", schema: [] },
    create(context) {
      sourceCode = context.sourceCode;
      return {
        ImportDeclaration(node) {
          inspectModuleSource(node.source, { declaration: node });
        },
        ExportNamedDeclaration(node) {
          if (node.source) inspectModuleSource(node.source, { exported: true });
          if (node.declaration?.type === "VariableDeclaration") {
            for (const declaration of node.declaration.declarations) {
              for (const name of patternIdentifiers(declaration.id)) {
                exportedBindings.add(name);
              }
            }
          }
          for (const specifier of node.specifiers ?? []) {
            if (specifier.local?.type === "Identifier") {
              exportedBindings.add(specifier.local.name);
            }
          }
        },
        ExportAllDeclaration(node) {
          inspectModuleSource(node.source, { exported: true });
        },
        ExportDefaultDeclaration(node) {
          if (
            !isFunctionOrClass(node.declaration) &&
            containsAmbientAcquisition(node.declaration)
          ) {
            report(
              "network-capability-export",
              node.loc.start.line,
              "exports an ambient network capability",
            );
          }
        },
        ImportExpression(node) {
          inspectModuleSource(node.source);
          if (!door?.allowAmbient && node.source.type !== "Literal") {
            report(
              "direct-provider-network",
              node.loc.start.line,
              "uses a dynamic module specifier outside a declared transport door",
            );
          }
        },
        Identifier(node) {
          if (
            !door?.allowAmbient &&
            GLOBAL_CONTAINERS.has(node.name) &&
            globalContainerEscapes(node)
          ) {
            report(
              "direct-provider-network",
              node.loc.start.line,
              `allows ambient global container ${node.name} to escape static member access`,
            );
          }
        },
        VariableDeclarator(node) {
          if (containsAmbientAcquisition(node.init)) {
            for (const name of patternIdentifiers(node.id)) {
              rawCapabilityBindings.add(name);
            }
          }
        },
        CallExpression(node) {
          if (
            node.callee.type === "Identifier" &&
            node.callee.name === "require" &&
            node.arguments.length === 1
          ) {
            inspectModuleSource(node.arguments[0]);
            if (!door?.allowAmbient && node.arguments[0].type !== "Literal") {
              report(
                "direct-provider-network",
                node.loc.start.line,
                "uses a dynamic require specifier outside a declared transport door",
              );
            }
          }
          if (
            !door?.allowAmbient &&
            node.callee.type === "MemberExpression" &&
            memberReference(node.callee) === "process.getBuiltinModule"
          ) {
            report(
              "direct-provider-network",
              node.loc.start.line,
              "acquires a runtime built-in module outside a declared transport door",
            );
          }
        },
        MemberExpression(node) {
          if (door?.allowAmbient) return;
          const object = unwrapChain(node.object);
          if (
            object.type === "Identifier" &&
            GLOBAL_CONTAINERS.has(object.name) &&
            (node.computed ||
              NETWORK_MEMBER_NAMES.has(memberPropertyName(node)) ||
              GLOBAL_ESCAPE_MEMBER_NAMES.has(memberPropertyName(node)))
          ) {
            report(
              "direct-provider-network",
              node.loc.start.line,
              `acquires ambient network capability through ${sourceCode.getText(node)}`,
            );
          }
          if (
            object.type === "Identifier" &&
            object.name === "navigator" &&
            memberPropertyName(node) === "sendBeacon"
          ) {
            report(
              "direct-provider-network",
              node.loc.start.line,
              "acquires ambient network capability navigator.sendBeacon",
            );
          }
        },
        "Program:exit"(node) {
          if (!door?.allowAmbient) {
            for (const reference of sourceCode.scopeManager.globalScope
              .through) {
              const identifier = reference.identifier;
              if (AMBIENT_NETWORK_GLOBALS.has(identifier.name)) {
                report(
                  "direct-provider-network",
                  identifier.loc.start.line,
                  `acquires ambient network capability ${identifier.name} outside a declared transport door`,
                );
              }
            }
          }

          if (door?.allowAmbient) {
            for (const name of exportedBindings) {
              if (!rawCapabilityBindings.has(name)) continue;
              report(
                "network-capability-export",
                node.loc.start.line,
                `exports raw network capability ${name} from a transport door`,
              );
            }
          }

          if (door && !door.provider && PROVIDER_REFERENCE.test(source)) {
            report(
              "direct-provider-network",
              1,
              "non-provider transport door references the Durable Streams provider",
            );
          }
          if (
            !door &&
            importsNonProviderDoor &&
            !importsProviderDoor &&
            PROVIDER_REFERENCE.test(source)
          ) {
            report(
              "direct-provider-network",
              1,
              "routes a Durable Streams provider target through a non-provider transport door",
            );
          }
        },
      };
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
    { filename: relative },
  );
  const parseError = messages.find((message) => message.fatal);
  if (parseError) {
    throw new SyntaxError(
      `${relative}:${parseError.line}:${parseError.column} ${parseError.message}`,
    );
  }
  return violations.sort(
    (left, right) =>
      left.line - right.line || left.kind.localeCompare(right.kind),
  );
}

export async function auditDurableStreamsAccess({
  repositoryRoot = root,
} = {}) {
  const failures = [];
  const modules = [];
  for (const directory of RUNTIME_ROOTS) {
    modules.push(
      ...(await listFiles(
        path.join(repositoryRoot, directory),
        (file) => file.endsWith(".mjs") || file.endsWith(".js"),
      )),
    );
  }

  const conformanceHarness = path.join(
    repositoryRoot,
    "scripts/verify-e0-t03-conformance.mjs",
  );
  try {
    await readFile(conformanceHarness, "utf8");
    modules.push(conformanceHarness);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  for (const file of [...new Set(modules)].sort()) {
    const relative = slash(path.relative(repositoryRoot, file));
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

function doorFor(filename) {
  return NETWORK_DOORS.find(
    (door) =>
      filename === door.exact ||
      (door.prefix !== undefined && filename.startsWith(door.prefix)),
  );
}

function filePolicyFor(filename) {
  const policy = FILE_POLICIES.find(
    (candidate) => candidate.exact === filename,
  );
  return {
    allowedNetworkImports: policy?.allowedNetworkImports ?? new Map(),
  };
}

function containsAmbientAcquisition(node) {
  if (!node || typeof node !== "object") return false;
  const expression = unwrapChain(node);
  if (
    expression.type === "Identifier" &&
    AMBIENT_NETWORK_GLOBALS.has(expression.name)
  ) {
    return true;
  }
  if (expression.type === "MemberExpression") {
    const object = unwrapChain(expression.object);
    if (
      object.type === "Identifier" &&
      GLOBAL_CONTAINERS.has(object.name) &&
      (expression.computed ||
        NETWORK_MEMBER_NAMES.has(memberPropertyName(expression)) ||
        GLOBAL_ESCAPE_MEMBER_NAMES.has(memberPropertyName(expression)))
    ) {
      return true;
    }
  }
  for (const [key, value] of Object.entries(expression)) {
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
      if (value.some((item) => containsAmbientAcquisition(item))) return true;
    } else if (containsAmbientAcquisition(value)) {
      return true;
    }
  }
  return false;
}

function globalContainerEscapes(identifier) {
  const parent = identifier.parent;
  if (parent?.type === "MemberExpression" && parent.object === identifier) {
    return false;
  }
  return true;
}

function memberPropertyName(node) {
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  if (
    node.property.type === "Literal" &&
    typeof node.property.value === "string"
  ) {
    return node.property.value;
  }
  if (
    node.property.type === "TemplateLiteral" &&
    node.property.expressions.length === 0
  ) {
    return node.property.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

function memberReference(node) {
  const parts = [];
  let current = unwrapChain(node);
  while (current.type === "MemberExpression") {
    const property = memberPropertyName(current);
    if (property === null) return null;
    parts.unshift(property);
    current = unwrapChain(current.object);
  }
  if (current.type !== "Identifier") return null;
  parts.unshift(current.name);
  return parts.join(".");
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

function isFunctionOrClass(node) {
  return new Set([
    "ArrowFunctionExpression",
    "ClassDeclaration",
    "ClassExpression",
    "FunctionDeclaration",
    "FunctionExpression",
  ]).has(node?.type);
}

function unwrapChain(node) {
  return node?.type === "ChainExpression" ? node.expression : node;
}

async function listFiles(directory, accept) {
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
    if (entry.isDirectory())
      files.push(...(await listFiles(entryPath, accept)));
    else if (entry.isFile() && accept(entryPath)) files.push(entryPath);
  }
  return files;
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
