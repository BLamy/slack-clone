import { createHash } from "node:crypto";

import { LEDGER_ERROR_CODES, fail } from "./errors.mjs";

const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function assertValidUnicode(value, path = "$") {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail(LEDGER_ERROR_CODES.INVALID_JSON_VALUE, path, "string contains an unpaired high surrogate");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail(LEDGER_ERROR_CODES.INVALID_JSON_VALUE, path, "string contains an unpaired low surrogate");
    }
  }
}

export function canonicalJson(value, path = "$") {
  return encodeCanonical(value, path, new Set());
}

export function canonicalJsonBytes(value, path = "$") {
  return Buffer.from(canonicalJson(value, path), "utf8");
}

export function canonicalSha256(value, path = "$") {
  return `sha256:${createHash("sha256").update(canonicalJsonBytes(value, path)).digest("hex")}`;
}

function encodeCanonical(value, path, ancestors) {
  if (value === null) return "null";

  if (typeof value === "string") {
    assertValidUnicode(value, path);
    return JSON.stringify(value);
  }

  if (typeof value === "boolean") return value ? "true" : "false";

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(LEDGER_ERROR_CODES.INVALID_JSON_VALUE, path, "number must be finite");
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      fail(LEDGER_ERROR_CODES.INVALID_JSON_VALUE, path, "integer exceeds the safe JSON range");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }

  if (typeof value !== "object") {
    fail(LEDGER_ERROR_CODES.INVALID_JSON_VALUE, path, `unsupported JSON value type ${typeof value}`);
  }

  if (ancestors.has(value)) {
    fail(LEDGER_ERROR_CODES.INVALID_JSON_VALUE, path, "cyclic values are not valid JSON");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          fail(LEDGER_ERROR_CODES.INVALID_JSON_VALUE, `${path}[${index}]`, "sparse arrays are not allowed");
        }
      }
      if (ownKeys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)))) {
        fail(LEDGER_ERROR_CODES.INVALID_JSON_VALUE, path, "arrays may not have custom properties");
      }
      return `[${value.map((item, index) => encodeCanonical(item, `${path}[${index}]`, ancestors)).join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(LEDGER_ERROR_CODES.INVALID_JSON_VALUE, path, "object must have a plain prototype");
    }

    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      fail(LEDGER_ERROR_CODES.INVALID_JSON_VALUE, path, "symbol keys are not valid JSON");
    }

    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        fail(LEDGER_ERROR_CODES.INVALID_JSON_VALUE, `${path}.${key}`, "properties must be enumerable data values");
      }
      assertValidUnicode(key, `${path}.${key}`);
      if (FORBIDDEN_OBJECT_KEYS.has(key)) {
        fail(LEDGER_ERROR_CODES.INVALID_JSON_VALUE, `${path}.${key}`, "prototype-sensitive keys are forbidden");
      }
    }

    keys.sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${encodeCanonical(value[key], `${path}.${key}`, ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
