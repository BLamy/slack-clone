export const LEDGER_ERROR_CODES = Object.freeze({
  EXTRA_KEY: "LEDGER_EXTRA_KEY",
  INVALID_EVENT_TYPE: "LEDGER_INVALID_EVENT_TYPE",
  INVALID_ID: "LEDGER_INVALID_ID",
  INVALID_JSON: "LEDGER_INVALID_JSON",
  INVALID_JSON_VALUE: "LEDGER_INVALID_JSON_VALUE",
  INVALID_SCHEMA_VERSION: "LEDGER_INVALID_SCHEMA_VERSION",
  INVALID_SOURCE_REFERENCE: "LEDGER_INVALID_SOURCE_REFERENCE",
  INVALID_STREAM_NAME: "LEDGER_INVALID_STREAM_NAME",
  INVALID_TIMESTAMP: "LEDGER_INVALID_TIMESTAMP",
  MISSING_FIELD: "LEDGER_MISSING_FIELD",
  TYPE_MISMATCH: "LEDGER_TYPE_MISMATCH",
  WORKSPACE_SCOPE_MISMATCH: "LEDGER_WORKSPACE_SCOPE_MISMATCH",
});

export class LedgerValidationError extends Error {
  constructor(code, path, detail) {
    super(`${code} at ${path}: ${detail}`);
    this.name = "LedgerValidationError";
    this.code = code;
    this.path = path;
    this.detail = detail;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      path: this.path,
      detail: this.detail,
    };
  }
}

export function fail(code, path, detail) {
  throw new LedgerValidationError(code, path, detail);
}

export function assertExactKeys(value, expectedKeys, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(LEDGER_ERROR_CODES.TYPE_MISMATCH, path, "expected an object");
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(LEDGER_ERROR_CODES.TYPE_MISMATCH, path, "expected a plain object");
  }

  const expected = new Set(expectedKeys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      fail(LEDGER_ERROR_CODES.EXTRA_KEY, path, "symbol fields are not allowed");
    }
    if (!expected.has(key)) {
      fail(LEDGER_ERROR_CODES.EXTRA_KEY, `${path}.${key}`, "field is not allowed");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fail(LEDGER_ERROR_CODES.TYPE_MISMATCH, `${path}.${key}`, "field must be an enumerable data value");
    }
  }

  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(LEDGER_ERROR_CODES.MISSING_FIELD, `${path}.${key}`, "field is required");
    }
  }
}
