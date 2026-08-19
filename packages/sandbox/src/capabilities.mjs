export const SANDBOX_CAPABILITIES = Object.freeze([
  "persistence",
  "network-policy",
  "resource-limit",
  "cancellation",
  "streaming-exec",
]);

export const SANDBOX_LIFECYCLES = Object.freeze([
  "creating",
  "ready",
  "running",
  "suspended",
  "destroyed",
]);

export function normalizeCapabilities(value, path = "$.capabilities") {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  const unique = new Set();
  for (const capability of value) {
    if (!SANDBOX_CAPABILITIES.includes(capability)) {
      throw new TypeError(`${path} contains an unknown capability`);
    }
    if (unique.has(capability)) {
      throw new TypeError(`${path} contains a duplicate capability`);
    }
    unique.add(capability);
  }
  return [...unique].sort();
}

export function discoverCapabilities(capabilities = SANDBOX_CAPABILITIES) {
  return Object.freeze({
    schemaVersion: 1,
    capabilities: Object.freeze(normalizeCapabilities(capabilities)),
    persistence: capabilities.includes("persistence"),
    networkPolicy: capabilities.includes("network-policy"),
    resourceLimit: capabilities.includes("resource-limit"),
    cancellation: capabilities.includes("cancellation"),
    streamingExec: capabilities.includes("streaming-exec"),
  });
}
