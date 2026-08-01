import { Linter } from "eslint";

const SAFE_PURE_GLOBALS = new Set([
  "AggregateError",
  "Array",
  "ArrayBuffer",
  "BigInt",
  "BigInt64Array",
  "BigUint64Array",
  "Boolean",
  "DataView",
  "decodeURI",
  "decodeURIComponent",
  "DisposableStack",
  "encodeURI",
  "encodeURIComponent",
  "Error",
  "EvalError",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "Infinity",
  "isFinite",
  "isNaN",
  "Iterator",
  "JSON",
  "Map",
  "NaN",
  "Number",
  "parseFloat",
  "parseInt",
  "Promise",
  "RangeError",
  "ReferenceError",
  "RegExp",
  "Set",
  "String",
  "structuredClone",
  "SuppressedError",
  "SyntaxError",
  "TextDecoder",
  "TextEncoder",
  "TypeError",
  "Uint16Array",
  "Uint32Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "undefined",
  "URIError",
  "URL",
  "URLSearchParams",
  "WeakMap",
  "WeakSet",
]);
const GLOBAL_CAPABILITY_KINDS = new Map([
  ["Date", "clock"],
  ["Temporal", "clock"],
  ["performance", "clock"],
  ["Math", "randomness"],
  ["crypto", "randomness"],
  ["EventSource", "network"],
  ["fetch", "network"],
  ["navigator", "network"],
  ["WebSocket", "network"],
  ["XMLHttpRequest", "network"],
  ["queueMicrotask", "timer"],
  ["requestAnimationFrame", "timer"],
  ["setImmediate", "timer"],
  ["setInterval", "timer"],
  ["setTimeout", "timer"],
  ["Bun", "environment"],
  ["Deno", "environment"],
  ["Intl", "environment"],
  ["location", "environment"],
  ["process", "environment"],
  ["Object", "prototype reflection"],
  ["Reflect", "prototype reflection"],
  ["Proxy", "metaprogramming"],
  ["Symbol", "process-wide state"],
  ["Function", "dynamic code"],
  ["eval", "dynamic code"],
  ["require", "dynamic import"],
]);
const FORBIDDEN_PROPERTY_CAPABILITIES = new Map([
  ["constructor", "dynamic code"],
  ["__proto__", "prototype reflection"],
  ["__defineGetter__", "prototype reflection"],
  ["__defineSetter__", "prototype reflection"],
  ["__lookupGetter__", "prototype reflection"],
  ["__lookupSetter__", "prototype reflection"],
  ["prototype", "prototype reflection"],
  ["getPrototypeOf", "prototype reflection"],
  ["setPrototypeOf", "prototype reflection"],
  ["getOwnPropertyDescriptor", "prototype reflection"],
  ["getOwnPropertyDescriptors", "prototype reflection"],
  ["caller", "call-stack reflection"],
  ["callee", "call-stack reflection"],
  ["arguments", "call-stack reflection"],
  ["stack", "environment"],
  ["captureStackTrace", "environment"],
  ["prepareStackTrace", "environment"],
  ["stackTraceLimit", "environment"],
]);

export function analyzeModuleSource(source, filename = "module.mjs") {
  const imports = [];
  const ambientCapabilities = [];
  const captureRule = {
    meta: { type: "problem", schema: [] },
    create(context) {
      return {
        ImportDeclaration(node) {
          imports.push(node.source.value);
        },
        ExportNamedDeclaration(node) {
          if (node.source) imports.push(node.source.value);
        },
        ExportAllDeclaration(node) {
          imports.push(node.source.value);
        },
        ImportExpression(node) {
          ambientCapabilities.push("dynamic import");
          if (typeof node.source.value === "string") {
            imports.push(node.source.value);
          }
        },
        MetaProperty() {
          ambientCapabilities.push("module metadata");
        },
        MemberExpression(node) {
          capturePropertyCapability(
            node.property,
            node.computed,
            ambientCapabilities,
          );
        },
        Property(node) {
          capturePropertyCapability(
            node.key,
            node.computed,
            ambientCapabilities,
          );
        },
        MethodDefinition(node) {
          capturePropertyCapability(
            node.key,
            node.computed,
            ambientCapabilities,
          );
        },
        PropertyDefinition(node) {
          capturePropertyCapability(
            node.key,
            node.computed,
            ambientCapabilities,
          );
        },
        "Program:exit"() {
          captureAmbientGlobalReferences(context, ambientCapabilities);
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
        plugins: {
          boundaries: { rules: { capture: captureRule } },
        },
        rules: { "boundaries/capture": "error" },
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
  return {
    imports,
    ambientCapabilities: [...new Set(ambientCapabilities)],
  };
}

function capturePropertyCapability(property, computed, capabilities) {
  const name = staticPropertyName(property, computed);
  if (computed && name === null) {
    capabilities.push("dynamic property access");
    return;
  }
  const capability = FORBIDDEN_PROPERTY_CAPABILITIES.get(name);
  if (capability) capabilities.push(capability);
}

function staticPropertyName(property, computed) {
  if (!computed && property.type === "Identifier") return property.name;
  if (
    property.type === "Literal" &&
    (typeof property.value === "string" || typeof property.value === "number")
  ) {
    return String(property.value);
  }
  return null;
}

function captureAmbientGlobalReferences(context, capabilities) {
  const moduleScope = context.sourceCode.scopeManager.scopes.find(
    (scope) => scope.type === "module",
  );
  for (const reference of moduleScope?.through ?? []) {
    const name = reference.identifier.name;
    if (SAFE_PURE_GLOBALS.has(name)) continue;
    capabilities.push(
      GLOBAL_CAPABILITY_KINDS.get(name) ?? `ambient global ${name}`,
    );
  }
}
