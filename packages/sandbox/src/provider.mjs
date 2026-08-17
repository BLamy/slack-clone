import { createHash } from "node:crypto";

import {
  discoverCapabilities,
  normalizeCapabilities,
} from "./capabilities.mjs";
import { SANDBOX_ERROR_CODES, sandboxError } from "./errors.mjs";

const ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const RUN_ID = /^rn_[A-Za-z0-9._:-]{1,120}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SECRET =
  /(?:private key|bearer\s+|api[_-]?key\s*[:=]|password\s*[:=]|secret\s*[:=]|token\s*[:=])/iu;
const MAX_COMMAND = 4096;
const MAX_ENV_KEYS = 32;

export class InMemorySandboxProvider {
  #capabilities;
  #sandboxes = new Map();
  #executions = new Map();
  #idempotency = new Map();
  #events = [];
  #nextSandbox = 1;
  #nextExecution = 1;

  constructor({ capabilities } = {}) {
    this.#capabilities = discoverCapabilities(
      capabilities ?? [
        "cancellation",
        "network-policy",
        "persistence",
        "resource-limit",
        "streaming-exec",
      ],
    );
  }

  discover() {
    return this.#capabilities;
  }

  events() {
    return structuredClone(this.#events);
  }

  sideEffects() {
    return {
      creates: this.#events.filter((event) => event.type === "sandbox.created")
        .length,
      executions: this.#events.filter((event) => event.type === "exec.started")
        .length,
      mutations: this.#events.filter((event) => event.mutating).length,
    };
  }

  async create(request) {
    const normalized = validateMutation(request, "create");
    validateSpec(normalized.spec, this.#capabilities);
    return this.#mutate("create", normalized, () => {
      const handle = `opaque-provider-handle-${this.#nextSandbox++}`;
      const sandbox = {
        sandboxId: `sb_${hash(`${normalized.runId}:${normalized.idempotencyKey}`).slice(0, 24)}`,
        runId: normalized.runId,
        invocationDigest: normalized.invocationDigest,
        lifecycle: "ready",
        fence: 1,
        spec: structuredClone(normalized.spec),
        handle,
      };
      this.#sandboxes.set(sandbox.sandboxId, sandbox);
      this.#append("sandbox.created", sandbox, true);
      return publicSandbox(sandbox);
    });
  }

  async inspect(request) {
    const sandbox = this.#sandbox(request);
    return publicSandbox(sandbox);
  }

  async exec(request) {
    const normalized = validateMutation(request, "exec");
    validateExecution(normalized.exec, this.#capabilities);
    return this.#mutate("exec", normalized, () => {
      const sandbox = this.#sandbox(normalized);
      assertFence(sandbox, normalized);
      if (sandbox.lifecycle !== "ready" && sandbox.lifecycle !== "running") {
        throw sandboxError(
          SANDBOX_ERROR_CODES.INVALID_LIFECYCLE,
          "sandbox is not executable",
          "$.sandboxId",
        );
      }
      const executionId = `ex_${hash(`${sandbox.sandboxId}:${normalized.idempotencyKey}`).slice(0, 24)}`;
      const execution = {
        executionId,
        sandboxId: sandbox.sandboxId,
        runId: sandbox.runId,
        command: normalized.exec.command,
        status: "running",
        handle: `opaque-execution-handle-${this.#nextExecution++}`,
      };
      sandbox.lifecycle = "running";
      sandbox.fence += 1;
      this.#executions.set(executionId, execution);
      this.#append("exec.started", execution, true);
      return { executionId, status: execution.status, fence: sandbox.fence };
    });
  }

  async cancel(request) {
    return this.#lifecycle("cancel", request, (sandbox) => {
      if (!this.#capabilities.cancellation) unsupported("cancellation");
      for (const execution of this.#executions.values()) {
        if (
          execution.sandboxId === sandbox.sandboxId &&
          execution.status === "running"
        ) {
          execution.status = "cancelled";
        }
      }
      sandbox.lifecycle = "ready";
    });
  }

  async suspend(request) {
    return this.#lifecycle("suspend", request, (sandbox) => {
      if (sandbox.lifecycle !== "ready") invalidLifecycle("suspend");
      sandbox.lifecycle = "suspended";
    });
  }

  async resume(request) {
    return this.#lifecycle("resume", request, (sandbox) => {
      if (sandbox.lifecycle !== "suspended") invalidLifecycle("resume");
      sandbox.lifecycle = "ready";
    });
  }

  async destroy(request) {
    return this.#lifecycle("destroy", request, (sandbox) => {
      if (sandbox.lifecycle === "destroyed") {
        throw sandboxError(
          SANDBOX_ERROR_CODES.ALREADY_DESTROYED,
          "sandbox is already destroyed",
        );
      }
      sandbox.lifecycle = "destroyed";
      sandbox.handle = null;
    });
  }

  #sandbox(request) {
    const sandboxId = request?.sandboxId;
    if (typeof sandboxId !== "string" || !ID.test(sandboxId)) {
      throw sandboxError(
        SANDBOX_ERROR_CODES.INVALID_HANDLE,
        "sandboxId is invalid",
        "$.sandboxId",
      );
    }
    const sandbox = this.#sandboxes.get(sandboxId);
    if (!sandbox)
      throw sandboxError(
        SANDBOX_ERROR_CODES.NOT_FOUND,
        "sandbox was not found",
      );
    if (
      request.runId !== sandbox.runId ||
      request.invocationDigest !== sandbox.invocationDigest
    ) {
      throw sandboxError(
        SANDBOX_ERROR_CODES.FENCE_MISMATCH,
        "request is outside the invocation fence",
      );
    }
    return sandbox;
  }

  async #lifecycle(operation, request, apply) {
    const normalized = validateMutation(request, operation);
    return this.#mutate(operation, normalized, () => {
      const sandbox = this.#sandbox(normalized);
      assertFence(sandbox, normalized);
      apply(sandbox);
      sandbox.fence += 1;
      this.#append(`sandbox.${operation}`, sandbox, true);
      return publicSandbox(sandbox);
    });
  }

  async #mutate(operation, request, apply) {
    const fingerprint = hash(canonical({ operation, ...request }));
    const prior = this.#idempotency.get(request.idempotencyKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw sandboxError(
          SANDBOX_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          "idempotency key has a different payload",
        );
      }
      return structuredClone(prior.result);
    }
    const result = apply();
    this.#idempotency.set(request.idempotencyKey, {
      fingerprint,
      result: structuredClone(result),
    });
    return result;
  }

  #append(type, value, mutating) {
    this.#events.push({ type, mutating, data: redact(value) });
  }
}

export function redact(value) {
  if (typeof value === "string")
    return SECRET.test(value) ? "<redacted>" : value;
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key === "handle" ? "providerHandle" : key] =
      key === "handle" ? "<redacted>" : redact(child);
  }
  return result;
}

function validateMutation(request, operation) {
  if (!request || typeof request !== "object" || Array.isArray(request))
    invalid(`${operation} request`);
  for (const key of ["runId", "invocationDigest", "idempotencyKey"]) {
    if (typeof request[key] !== "string" || !ID.test(request[key]))
      invalid(`${key} is invalid`, `$.${key}`);
  }
  if (!RUN_ID.test(request.runId)) invalid("runId is invalid", "$.runId");
  if (!DIGEST.test(request.invocationDigest))
    invalid("invocationDigest is invalid", "$.invocationDigest");
  if (!Number.isSafeInteger(request.expectedFence) || request.expectedFence < 0)
    invalid("expectedFence is invalid", "$.expectedFence");
  if (SECRET.test(JSON.stringify(request)))
    throw sandboxError(
      SANDBOX_ERROR_CODES.SECRET_VALUE,
      "request contains forbidden credential-shaped material",
    );
  return request;
}

function validateSpec(spec, capabilities) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec))
    invalid("spec is required", "$.spec");
  const required = normalizeCapabilities(
    spec.requiredCapabilities ?? [],
    "$.spec.requiredCapabilities",
  );
  for (const capability of required)
    if (!capabilities.capabilities.includes(capability))
      unsupported(capability);
  if (
    spec.networkPolicy !== undefined &&
    typeof spec.networkPolicy !== "object"
  )
    invalid("networkPolicy must be an object", "$.spec.networkPolicy");
  if (
    spec.resourceLimit !== undefined &&
    typeof spec.resourceLimit !== "object"
  )
    invalid("resourceLimit must be an object", "$.spec.resourceLimit");
}

function validateExecution(exec, capabilities) {
  if (
    !exec ||
    typeof exec.command !== "string" ||
    exec.command.length === 0 ||
    exec.command.length > MAX_COMMAND
  )
    invalid("command is invalid", "$.exec.command");
  if (
    exec.env &&
    (typeof exec.env !== "object" ||
      Object.keys(exec.env).length > MAX_ENV_KEYS)
  )
    invalid("env is invalid", "$.exec.env");
  if (exec.stream && !capabilities.streamingExec) unsupported("streaming-exec");
  if (SECRET.test(JSON.stringify(exec)))
    throw sandboxError(
      SANDBOX_ERROR_CODES.SECRET_VALUE,
      "execution contains forbidden credential-shaped material",
    );
}

function assertFence(sandbox, request) {
  if (request.expectedFence !== sandbox.fence)
    throw sandboxError(
      SANDBOX_ERROR_CODES.FENCE_MISMATCH,
      "expected lifecycle fence is stale",
      "$.expectedFence",
    );
}

function publicSandbox(sandbox) {
  return {
    sandboxId: sandbox.sandboxId,
    runId: sandbox.runId,
    invocationDigest: sandbox.invocationDigest,
    lifecycle: sandbox.lifecycle,
    fence: sandbox.fence,
    spec: structuredClone(sandbox.spec),
  };
}

function unsupported(capability) {
  throw sandboxError(
    SANDBOX_ERROR_CODES.UNSUPPORTED_CAPABILITY,
    `capability is not supported: ${capability}`,
    "$.requiredCapabilities",
  );
}
function invalid(detail, path) {
  throw sandboxError(SANDBOX_ERROR_CODES.INVALID_REQUEST, detail, path);
}
function invalidLifecycle(operation) {
  throw sandboxError(
    SANDBOX_ERROR_CODES.INVALID_LIFECYCLE,
    `cannot ${operation} sandbox in its current lifecycle`,
  );
}
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
