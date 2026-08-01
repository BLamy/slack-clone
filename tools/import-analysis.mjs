import { Linter } from "eslint";

const NETWORK_GLOBALS = new Set(["EventSource", "WebSocket", "fetch"]);
const TIMER_GLOBALS = new Set(["queueMicrotask", "setInterval", "setTimeout"]);

export function analyzeModuleSource(source, filename = "module.mjs") {
  const imports = [];
  const ambientCapabilities = [];
  const captureRule = {
    meta: { type: "problem", schema: [] },
    create() {
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
        CallExpression(node) {
          captureCallCapability(node.callee, ambientCapabilities);
        },
        NewExpression(node) {
          captureCallCapability(node.callee, ambientCapabilities);
        },
        MemberExpression(node) {
          const path = memberPath(node);
          if (endsWith(path, ["process", "env"])) {
            ambientCapabilities.push("environment");
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

function captureCallCapability(callee, capabilities) {
  const path = memberPath(callee);
  const leaf = path.at(-1);
  if (
    path.length === 1 &&
    (NETWORK_GLOBALS.has(leaf) || TIMER_GLOBALS.has(leaf))
  ) {
    capabilities.push(NETWORK_GLOBALS.has(leaf) ? "network" : "timer");
  }
  if (
    path.length === 2 &&
    path[0] === "globalThis" &&
    (NETWORK_GLOBALS.has(leaf) || TIMER_GLOBALS.has(leaf))
  ) {
    capabilities.push(NETWORK_GLOBALS.has(leaf) ? "network" : "timer");
  }
  if (
    path.length === 1 &&
    ["Date", "EventSource", "WebSocket"].includes(leaf)
  ) {
    capabilities.push(leaf === "Date" ? "clock" : "network");
  }
  if (endsWith(path, ["Date", "now"])) capabilities.push("clock");
  if (endsWith(path, ["performance", "now"])) capabilities.push("clock");
  if (endsWith(path, ["Math", "random"])) capabilities.push("randomness");
  if (endsWith(path, ["crypto", "randomUUID"])) {
    capabilities.push("randomness");
  }
}

function memberPath(node) {
  if (!node) return [];
  if (node.type === "Identifier") return [node.name];
  if (node.type !== "MemberExpression") return [];
  const object = memberPath(node.object);
  const property = node.computed
    ? literalProperty(node.property)
    : node.property.type === "Identifier"
      ? node.property.name
      : null;
  return property === null ? [] : [...object, property];
}

function literalProperty(node) {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return null;
}

function endsWith(value, suffix) {
  return (
    value.length >= suffix.length &&
    suffix.every(
      (part, index) => value[value.length - suffix.length + index] === part,
    )
  );
}
