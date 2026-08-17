export const SANDBOX_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: "SANDBOX_INVALID_REQUEST",
  UNKNOWN_CAPABILITY: "SANDBOX_UNKNOWN_CAPABILITY",
  UNSUPPORTED_CAPABILITY: "SANDBOX_UNSUPPORTED_CAPABILITY",
  INVALID_HANDLE: "SANDBOX_INVALID_HANDLE",
  NOT_FOUND: "SANDBOX_NOT_FOUND",
  FENCE_MISMATCH: "SANDBOX_FENCE_MISMATCH",
  IDEMPOTENCY_CONFLICT: "SANDBOX_IDEMPOTENCY_CONFLICT",
  INVALID_LIFECYCLE: "SANDBOX_INVALID_LIFECYCLE",
  EXECUTION_NOT_FOUND: "SANDBOX_EXECUTION_NOT_FOUND",
  ALREADY_DESTROYED: "SANDBOX_ALREADY_DESTROYED",
  SECRET_VALUE: "SANDBOX_SECRET_VALUE",
});

export class SandboxProviderError extends Error {
  constructor(code, detail, path = "$") {
    super(detail);
    this.name = "SandboxProviderError";
    this.code = code;
    this.detail = detail;
    this.path = path;
  }

  toJSON() {
    return {
      code: this.code,
      name: this.name,
      path: this.path,
      detail: this.detail,
    };
  }
}

export function sandboxError(code, detail, path) {
  return new SandboxProviderError(code, detail, path);
}
