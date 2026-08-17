export const CLOUDFLARE_OS_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: "CLOUDFLARE_OS_INVALID_REQUEST",
  AUTHENTICATION: "CLOUDFLARE_OS_AUTHENTICATION",
  AUTHORIZATION: "CLOUDFLARE_OS_AUTHORIZATION",
  QUOTA: "CLOUDFLARE_OS_QUOTA",
  TIMEOUT: "CLOUDFLARE_OS_TIMEOUT",
  UNAVAILABLE: "CLOUDFLARE_OS_UNAVAILABLE",
  NOT_FOUND: "CLOUDFLARE_OS_NOT_FOUND",
  CONFLICT: "CLOUDFLARE_OS_CONFLICT",
  PROTOCOL: "CLOUDFLARE_OS_PROTOCOL",
  REMOTE_REJECTED: "CLOUDFLARE_OS_REMOTE_REJECTED",
  INVALID_TREE: "CLOUDFLARE_OS_INVALID_TREE",
  PATH_REJECTED: "CLOUDFLARE_OS_PATH_REJECTED",
  ARCHIVE_REJECTED: "CLOUDFLARE_OS_ARCHIVE_REJECTED",
  WORKSPACE_DIGEST_MISMATCH: "CLOUDFLARE_OS_WORKSPACE_DIGEST_MISMATCH",
  PUBLISH_FAILED: "CLOUDFLARE_OS_PUBLISH_FAILED",
});

export class CloudflareOsProviderError extends Error {
  constructor(
    code,
    detail,
    { operation = "unknown", status, retryable = false } = {},
  ) {
    super(detail);
    this.name = "CloudflareOsProviderError";
    this.code = code;
    this.detail = detail;
    this.operation = operation;
    this.status = status;
    this.retryable = retryable;
  }

  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      name: this.name,
      operation: this.operation,
      retryable: this.retryable,
      ...(this.status === undefined ? {} : { status: this.status }),
    };
  }
}

export function cloudflareOsError(code, detail, options) {
  return new CloudflareOsProviderError(code, detail, options);
}

export function normalizeHttpError(status, operation) {
  let code = CLOUDFLARE_OS_ERROR_CODES.REMOTE_REJECTED;
  let detail = "Cloudflare OS rejected the request";
  let retryable = false;
  if (status === 401) {
    code = CLOUDFLARE_OS_ERROR_CODES.AUTHENTICATION;
    detail = "Cloudflare OS authentication failed";
  } else if (status === 403) {
    code = CLOUDFLARE_OS_ERROR_CODES.AUTHORIZATION;
    detail = "Cloudflare OS authorization failed";
  } else if (status === 404) {
    code = CLOUDFLARE_OS_ERROR_CODES.NOT_FOUND;
    detail = "Cloudflare OS resource was not found";
  } else if (status === 408 || status === 504) {
    code = CLOUDFLARE_OS_ERROR_CODES.TIMEOUT;
    detail = "Cloudflare OS request timed out";
    retryable = true;
  } else if (status === 409) {
    code = CLOUDFLARE_OS_ERROR_CODES.CONFLICT;
    detail = "Cloudflare OS resource identity conflicts with the request";
  } else if (status === 429) {
    code = CLOUDFLARE_OS_ERROR_CODES.QUOTA;
    detail = "Cloudflare OS quota or rate limit was exceeded";
    retryable = true;
  } else if ([425, 500, 502, 503].includes(status)) {
    code = CLOUDFLARE_OS_ERROR_CODES.UNAVAILABLE;
    detail = "Cloudflare OS is temporarily unavailable";
    retryable = true;
  }
  return cloudflareOsError(code, detail, { operation, status, retryable });
}

export function isRetryable(error) {
  return error instanceof CloudflareOsProviderError && error.retryable;
}
