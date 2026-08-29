import { sha256Digest } from "@stream-slack/protocol";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function canonicalJson(value) {
  return encodeCanonical(value, "$", new Set());
}

export function canonicalSha256(value) {
  const bytes = sha256Digest(
    typeof value === "string" ? value : canonicalJson(value),
  );
  return (
    "sha256:" +
    [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  );
}

export function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, cloneJson(nested)]),
    );
  }
  return value;
}

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function encodeCanonical(value, path, ancestors) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(path + " must be finite");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError(path + " exceeds the safe integer range");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(path + " contains an unsupported value");
  }
  if (ancestors.has(value)) throw new TypeError(path + " is cyclic");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) {
        throw new TypeError(path + " is sparse or has custom properties");
      }
      return (
        "[" +
        value
          .map((item, index) =>
            encodeCanonical(item, path + "[" + index + "]", ancestors),
          )
          .join(",") +
        "]"
      );
    }
    return (
      "{" +
      Object.entries(value)
        .sort(([left], [right]) => compareKeys(left, right))
        .map(([key, nested]) => {
          if (FORBIDDEN_KEYS.has(key)) {
            throw new TypeError(path + "." + key + " is not a safe object key");
          }
          return (
            JSON.stringify(key) +
            ":" +
            encodeCanonical(nested, path + "." + key, ancestors)
          );
        })
        .join(",") +
      "}"
    );
  } finally {
    ancestors.delete(value);
  }
}

function compareKeys(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
