export const CONNECTION_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: "CONNECTION_INVALID_REQUEST",
  INVALID_SECRET_REF: "CONNECTION_INVALID_SECRET_REF",
  CREDENTIAL_MATERIAL: "CONNECTION_CREDENTIAL_MATERIAL",
  INVALID_EVENT: "CONNECTION_INVALID_EVENT",
  INVALID_STATE: "CONNECTION_INVALID_STATE",
  NOT_FOUND: "CONNECTION_NOT_FOUND",
  FORBIDDEN: "CONNECTION_FORBIDDEN",
  SCOPE_MISMATCH: "CONNECTION_SCOPE_MISMATCH",
  REVISION_CONFLICT: "CONNECTION_REVISION_CONFLICT",
  SEQUENCE_CONFLICT: "CONNECTION_SEQUENCE_CONFLICT",
  DUPLICATE_EVENT: "CONNECTION_DUPLICATE_EVENT",
  INVALID_TRANSITION: "CONNECTION_INVALID_TRANSITION",
  NOT_ACTIVE: "CONNECTION_NOT_ACTIVE",
  IDEMPOTENCY_CONFLICT: "CONNECTION_IDEMPOTENCY_CONFLICT",
});

export class ConnectionError extends Error {
  constructor(
    code,
    detail,
    { path = null, statusCode = defaultStatusCode(code) } = {},
  ) {
    super(code + ": " + detail);
    this.name = "ConnectionError";
    this.code = code;
    this.detail = detail;
    this.path = path;
    this.statusCode = statusCode;
  }

  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      name: this.name,
      path: this.path,
      statusCode: this.statusCode,
    };
  }
}

export function connectionError(code, detail, options) {
  return new ConnectionError(code, detail, options);
}

export function connectionNotFound() {
  return connectionError(
    CONNECTION_ERROR_CODES.NOT_FOUND,
    "connection was not found",
    { statusCode: 404 },
  );
}

function defaultStatusCode(code) {
  if (code === CONNECTION_ERROR_CODES.NOT_FOUND) return 404;
  if (code === CONNECTION_ERROR_CODES.FORBIDDEN) return 403;
  if (
    code === CONNECTION_ERROR_CODES.REVISION_CONFLICT ||
    code === CONNECTION_ERROR_CODES.SEQUENCE_CONFLICT ||
    code === CONNECTION_ERROR_CODES.DUPLICATE_EVENT ||
    code === CONNECTION_ERROR_CODES.INVALID_TRANSITION ||
    code === CONNECTION_ERROR_CODES.NOT_ACTIVE ||
    code === CONNECTION_ERROR_CODES.IDEMPOTENCY_CONFLICT
  ) {
    return 409;
  }
  return 400;
}
