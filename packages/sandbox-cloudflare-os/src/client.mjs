import { setTimeout as delay } from "node:timers/promises";

import {
  CLOUDFLARE_OS_ERROR_CODES,
  CloudflareOsProviderError,
  cloudflareOsError,
  isRetryable,
  normalizeHttpError,
} from "./errors.mjs";

const MAX_BODY_BYTES = 32 * 1024;
const MAX_STREAM_EVENT_BYTES = 128 * 1024;
const EXECUTION_ID = /^ex_[A-Za-z0-9._:-]{1,160}$/u;
export class CloudflareOsClient {
  #baseUrl;
  #token;
  #fetch;
  #timeoutMs;
  #maxAttempts;
  #sleep;
  #audit = [];

  constructor({
    baseUrl,
    token,
    fetchImpl,
    timeoutMs = 250,
    maxAttempts = 3,
    sleep = delay,
  } = {}) {
    if (typeof baseUrl !== "string") throw new TypeError("baseUrl is required");
    const url = new URL(baseUrl);
    if (!/^https?:$/u.test(url.protocol))
      throw new TypeError("baseUrl must use HTTP(S)");
    if (url.username || url.password || url.search || url.hash)
      throw new TypeError(
        "baseUrl must not contain credentials or query material",
      );
    if (typeof token !== "string" || token.length === 0)
      throw new TypeError("token is required");
    if (typeof fetchImpl !== "function")
      throw new TypeError("fetchImpl is required");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      throw new TypeError("timeoutMs is invalid");
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)
      throw new TypeError("maxAttempts is invalid");
    this.#baseUrl = url.toString().replace(/\/$/u, "");
    this.#token = token;
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#maxAttempts = maxAttempts;
    this.#sleep = sleep;
  }

  publicConfig() {
    return { baseUrl: this.#baseUrl, authMode: "server-deployment-identity" };
  }

  audit() {
    return structuredClone(this.#audit);
  }

  create({ labels, spec, idempotencyKey }) {
    return this.#request("POST", "/v1/workspaces", {
      body: { labels, spec },
      idempotencyKey,
      operation: "create",
      retryOnTimeout: false,
    });
  }

  listByLabels(labels) {
    const query = new URLSearchParams();
    for (const key of Object.keys(labels).sort())
      query.set(`label.${key}`, labels[key]);
    return this.#request("GET", `/v1/workspaces?${query}`, {
      operation: "reconcile",
    });
  }

  inspect(reference, labels) {
    return this.#request("GET", resourcePath(reference), {
      operation: "inspect",
      labels,
    });
  }

  suspend(reference, labels, idempotencyKey) {
    return this.#mutate("suspend", reference, labels, idempotencyKey);
  }

  resume(reference, labels, idempotencyKey) {
    return this.#mutate("resume", reference, labels, idempotencyKey);
  }

  destroy(reference, labels, idempotencyKey) {
    return this.#mutate("destroy", reference, labels, idempotencyKey);
  }

  cancel(reference, labels, idempotencyKey) {
    return this.#mutate("cancel", reference, labels, idempotencyKey);
  }

  exec(reference, labels, exec, idempotencyKey) {
    return this.#request("POST", `${resourcePath(reference)}/exec`, {
      body: { exec, labels },
      idempotencyKey,
      operation: "exec",
    });
  }

  configureNetworkPolicy(reference, labels, policy, idempotencyKey) {
    return this.#request("POST", `${resourcePath(reference)}/network-policy`, {
      body: { labels, policy },
      idempotencyKey,
      operation: "network-policy",
    });
  }

  cancelExecution(reference, labels, executionId, idempotencyKey) {
    assertExecutionId(executionId);
    return this.#request(
      "POST",
      `${resourcePath(reference)}/exec/${encodeURIComponent(executionId)}/cancel`,
      {
        body: { executionId, labels },
        idempotencyKey,
        operation: "exec-cancel",
      },
    );
  }

  /**
   * Follow a provider execution as newline-delimited events. The after
   * sequence is sent to the provider on every reconnect; the caller owns the
   * durable journal and therefore decides which offset is safe to resume.
   */
  async *streamExec(
    reference,
    labels,
    executionId,
    { afterSequence = 0, signal } = {},
  ) {
    assertExecutionId(executionId);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
      throw cloudflareOsError(
        CLOUDFLARE_OS_ERROR_CODES.INVALID_REQUEST,
        "execution stream offset is invalid",
        { operation: "exec-stream" },
      );
    const query = new URLSearchParams({ after: String(afterSequence) });
    for (const key of Object.keys(labels ?? {}).sort())
      query.set(`label.${key}`, labels[key]);
    const path = `${resourcePath(reference)}/exec/${encodeURIComponent(executionId)}/events?${query}`;
    const url = `${this.#baseUrl}${path}`;
    let response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: {
          accept: "application/x-ndjson",
          authorization: `Bearer ${this.#token}`,
        },
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      throw cloudflareOsError(
        CLOUDFLARE_OS_ERROR_CODES.TIMEOUT,
        "Cloudflare OS execution stream was interrupted",
        { operation: "exec-stream", retryable: true },
      );
    }
    this.#audit.push({
      method: "GET",
      operation: "exec-stream",
      path,
      status: response.status,
      afterSequence,
      ...(labels === undefined ? {} : { labels: structuredClone(labels) }),
    });
    if (!response.ok) throw normalizeHttpError(response.status, "exec-stream");
    const contentType = response.headers.get("content-type") ?? "";
    if (
      contentType &&
      !/application\/(?:x-ndjson|json-seq)(?:;|$)/iu.test(contentType)
    )
      throw cloudflareOsError(
        CLOUDFLARE_OS_ERROR_CODES.PROTOCOL,
        "Cloudflare OS execution stream has an invalid content type",
        { operation: "exec-stream" },
      );
    if (!response.body)
      throw cloudflareOsError(
        CLOUDFLARE_OS_ERROR_CODES.PROTOCOL,
        "Cloudflare OS execution stream has no body",
        { operation: "exec-stream" },
      );
    yield* parseNdjson(response.body);
  }

  streamExecution(reference, labels, executionId, options = {}) {
    return this.streamExec(reference, labels, executionId, options);
  }

  #mutate(operation, reference, labels, idempotencyKey) {
    return this.#request("POST", `${resourcePath(reference)}/${operation}`, {
      body: { labels },
      idempotencyKey,
      operation,
    });
  }

  async #request(
    method,
    path,
    {
      body,
      idempotencyKey,
      operation,
      labels,
      retryOnTimeout = method === "GET",
    } = {},
  ) {
    const url = `${this.#baseUrl}${path}`;
    let lastError;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
      try {
        const headers = {
          accept: "application/json",
          authorization: `Bearer ${this.#token}`,
        };
        if (body !== undefined) headers["content-type"] = "application/json";
        if (idempotencyKey !== undefined)
          headers["idempotency-key"] = idempotencyKey;
        const response = await this.#fetch(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        });
        const payload = await readJson(response);
        this.#audit.push({
          attempt,
          method,
          operation,
          path,
          status: response.status,
          ...(labels === undefined ? {} : { labels: structuredClone(labels) }),
        });
        if (response.ok) return payload;
        throw normalizeHttpError(response.status, operation);
      } catch (error) {
        lastError =
          error instanceof CloudflareOsProviderError
            ? error
            : cloudflareOsError(
                CLOUDFLARE_OS_ERROR_CODES.TIMEOUT,
                "Cloudflare OS request timed out",
                { operation, retryable: true },
              );
        if (
          !isRetryable(lastError) ||
          (lastError.code === CLOUDFLARE_OS_ERROR_CODES.TIMEOUT &&
            !retryOnTimeout) ||
          attempt === this.#maxAttempts
        )
          throw lastError;
        await this.#sleep(Math.min(25 * 2 ** (attempt - 1), 200));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }
}

async function readJson(response) {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw cloudflareOsError(
      CLOUDFLARE_OS_ERROR_CODES.PROTOCOL,
      "Cloudflare OS response body exceeded the bounded limit",
      { operation: "response" },
    );
  }
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw cloudflareOsError(
      CLOUDFLARE_OS_ERROR_CODES.PROTOCOL,
      "Cloudflare OS returned malformed JSON",
      { operation: "response" },
    );
  }
}

function resourcePath(reference) {
  return `/v1/workspaces/${encodeURIComponent(reference.workspaceId)}/gadgets/${encodeURIComponent(reference.gadgetId)}`;
}

function assertExecutionId(executionId) {
  if (typeof executionId !== "string" || !EXECUTION_ID.test(executionId))
    throw cloudflareOsError(
      CLOUDFLARE_OS_ERROR_CODES.INVALID_REQUEST,
      "executionId is invalid",
      { operation: "exec-stream" },
    );
}

async function* parseNdjson(body) {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of bodyChunks(body)) {
    pending += decoder.decode(chunk, { stream: true });
    if (new TextEncoder().encode(pending).byteLength > MAX_STREAM_EVENT_BYTES)
      throw cloudflareOsError(
        CLOUDFLARE_OS_ERROR_CODES.PROTOCOL,
        "Cloudflare OS execution event exceeded the bounded transport limit",
        { operation: "exec-stream" },
      );
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/u, "");
      pending = pending.slice(newline + 1);
      if (line.length === 0) continue;
      yield parseStreamLine(line);
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) yield parseStreamLine(pending);
}

async function* bodyChunks(body) {
  if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) yield chunk;
    return;
  }
  const reader = body.getReader?.();
  if (!reader) throw new TypeError("execution stream body is not readable");
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    reader.releaseLock?.();
  }
}

function parseStreamLine(line) {
  try {
    const event = JSON.parse(line);
    if (!event || typeof event !== "object" || Array.isArray(event))
      throw new Error("not an object");
    return event;
  } catch {
    throw cloudflareOsError(
      CLOUDFLARE_OS_ERROR_CODES.PROTOCOL,
      "Cloudflare OS execution stream contained malformed JSON",
      { operation: "exec-stream" },
    );
  }
}
