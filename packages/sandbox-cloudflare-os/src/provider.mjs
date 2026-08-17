import {
  DEFAULT_NETWORK_POLICY,
  compileNetworkPolicy,
  discoverCapabilities,
  SANDBOX_ERROR_CODES,
} from "@stream-slack/sandbox";
import { createHash } from "node:crypto";

import { CloudflareOsClient } from "./client.mjs";
import { CLOUDFLARE_OS_ERROR_CODES, cloudflareOsError } from "./errors.mjs";
import {
  canonical,
  labelsEqual,
  mapResource,
  resourceLabels,
} from "./mapping.mjs";

const ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const RUN_ID = /^rn_[A-Za-z0-9._:-]{1,120}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SECRET =
  /(?:private key|bearer\s+|api[_-]?key\s*[:=]|password\s*[:=]|secret\s*[:=]|token\s*[:=])/iu;

export class CloudflareOsSandboxProvider {
  #client;
  #capabilities;
  #records = new Map();
  #idempotency = new Map();
  #events = [];
  #workspaceDigests = new Map();
  #executionRecords = new Map();

  constructor({ client, capabilities } = {}) {
    if (!(client instanceof CloudflareOsClient))
      throw new TypeError(
        "CloudflareOsSandboxProvider requires CloudflareOsClient",
      );
    this.#client = client;
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

  publicConfig() {
    return this.#client.publicConfig();
  }

  async create(request) {
    const normalized = validateMutation(request, "create");
    const labels = resourceLabels(normalized);
    validateSpec(normalized.spec, this.#capabilities);
    return this.#mutate("create", normalized, async () => {
      let remote;
      try {
        remote = await this.#client.create({
          labels,
          spec: publicSpec(normalized.spec),
          idempotencyKey: normalized.idempotencyKey,
        });
      } catch (error) {
        if (error.code !== CLOUDFLARE_OS_ERROR_CODES.TIMEOUT) throw error;
        remote = await this.#reconcile(labels);
      }
      const mapped = this.#remember(remote, { labels, ...normalized });
      this.#append("create", mapped.sandbox, normalized.idempotencyKey);
      return mapped.sandbox;
    });
  }

  async inspect(request) {
    const normalized = validateLookup(request, "inspect");
    const resolved = await this.#resolve(normalized);
    this.#assertFence(resolved.sandbox, normalized);
    return resolved.sandbox;
  }

  async suspend(request) {
    return this.#lifecycle("suspend", request);
  }

  async resume(request) {
    return this.#lifecycle("resume", request);
  }

  async destroy(request) {
    return this.#lifecycle("destroy", request);
  }

  async materializeWorkspace(request, manifest, { materializer } = {}) {
    const normalized = validateMutation(request, "materialize");
    if (
      typeof normalized.sandboxId !== "string" ||
      !ID.test(normalized.sandboxId)
    )
      invalid("sandboxId is invalid");
    if (!DIGEST.test(normalized.workspaceDigest))
      invalid("workspaceDigest is invalid");
    if (!materializer || typeof materializer.materialize !== "function")
      invalid("workspace materializer is required");
    const labels = resourceLabels(normalized);
    return this.#mutate("materialize", normalized, async () => {
      const resolved = await this.#resolve({ ...normalized, labels });
      this.#assertFence(resolved.sandbox, normalized);
      const result = await materializer.materialize(manifest, {
        expectedDigest: normalized.workspaceDigest,
      });
      if (result?.digest !== normalized.workspaceDigest)
        throw cloudflareOsError(
          CLOUDFLARE_OS_ERROR_CODES.WORKSPACE_DIGEST_MISMATCH,
          "materializer returned a digest different from the invocation expectation",
          { operation: "materialize" },
        );
      this.#workspaceDigests.set(resolved.sandbox.sandboxId, result.digest);
      this.#events.push({
        idempotencyKey: normalized.idempotencyKey,
        operation: "materialize",
        sandboxId: resolved.sandbox.sandboxId,
        workspaceDigest: result.digest,
      });
      return structuredClone(result);
    });
  }

  async cancel(request) {
    return this.#lifecycle("cancel", request);
  }

  async configureNetworkPolicy(request, policy = DEFAULT_NETWORK_POLICY) {
    const normalized = validateMutation(request, "network-policy");
    if (
      typeof normalized.sandboxId !== "string" ||
      !ID.test(normalized.sandboxId)
    )
      invalid("sandboxId is invalid");
    const compiled = compileNetworkPolicy(policy);
    const labels = resourceLabels(normalized);
    return this.#mutate(
      "network-policy",
      { ...normalized, policyDigest: compiled.digest },
      async () => {
        const resolved = await this.#resolve({ ...normalized, labels });
        this.#assertFence(resolved.sandbox, normalized);
        const remote = await this.#client.configureNetworkPolicy(
          resolved.reference,
          labels,
          publicPolicy(compiled),
          normalized.idempotencyKey,
        );
        const mapped = this.#remember(remote, { labels, ...normalized });
        this.#append(
          "network-policy",
          mapped.sandbox,
          normalized.idempotencyKey,
        );
        return {
          sandbox: mapped.sandbox,
          policyDigest: compiled.digest,
        };
      },
    );
  }

  async exec(request) {
    const normalized = validateMutation(request, "exec");
    const labels = resourceLabels(normalized);
    validateExec(normalized.exec, this.#capabilities);
    return this.#mutate("exec", normalized, async () => {
      const resolved = await this.#resolve({ ...normalized, labels });
      this.#assertFence(resolved.sandbox, normalized);
      const materializedDigest = this.#workspaceDigests.get(
        resolved.sandbox.sandboxId,
      );
      if (
        !DIGEST.test(normalized.workspaceDigest) ||
        materializedDigest !== normalized.workspaceDigest
      )
        throw cloudflareOsError(
          CLOUDFLARE_OS_ERROR_CODES.WORKSPACE_DIGEST_MISMATCH,
          "execution is blocked until the published workspace matches the invocation digest",
          { operation: "exec" },
        );
      const remote = await this.#client.exec(
        resolved.reference,
        labels,
        normalized.exec,
        normalized.idempotencyKey,
      );
      const mapped = this.#remember(remote, { labels, ...normalized });
      const executionId = remote.executionId ?? remote.execution?.id;
      if (typeof executionId === "string" && ID.test(executionId))
        this.#executionRecords.set(executionId, {
          executionId,
          sandboxId: mapped.sandbox.sandboxId,
          runId: normalized.runId,
          invocationDigest: normalized.invocationDigest,
          expectedFence: mapped.sandbox.fence,
          reference: mapped.reference,
          labels: structuredClone(labels),
        });
      this.#append("exec", mapped.sandbox, normalized.idempotencyKey);
      return {
        executionId: remote.executionId ?? remote.execution?.id,
        status: remote.status ?? remote.execution?.status ?? "running",
        fence: mapped.sandbox.fence,
      };
    });
  }

  async *streamExecution(request, { afterSequence = 0, signal } = {}) {
    const normalized = validateExecutionLookup(request, "exec-stream");
    const labels = resourceLabels(normalized);
    const record = this.#executionRecords.get(normalized.executionId);
    if (!record) notFound("execution");
    if (
      record.runId !== normalized.runId ||
      record.invocationDigest !== normalized.invocationDigest ||
      record.sandboxId !== normalized.sandboxId
    )
      throw cloudflareOsError(
        SANDBOX_ERROR_CODES.FENCE_MISMATCH,
        "execution stream is outside its invocation fence",
        { operation: "exec-stream" },
      );
    const resolved = await this.#resolve({ ...normalized, labels });
    this.#assertFence(resolved.sandbox, normalized);
    for await (const event of this.#client.streamExec(
      record.reference,
      record.labels,
      normalized.executionId,
      { afterSequence, signal },
    ))
      yield event;
  }

  async cancelExecution(request) {
    const normalized = validateExecutionMutation(request, "exec-cancel");
    const labels = resourceLabels(normalized);
    const record = this.#executionRecords.get(normalized.executionId);
    if (!record) notFound("execution");
    if (
      record.runId !== normalized.runId ||
      record.invocationDigest !== normalized.invocationDigest ||
      record.sandboxId !== normalized.sandboxId
    )
      throw cloudflareOsError(
        SANDBOX_ERROR_CODES.FENCE_MISMATCH,
        "execution cancellation is outside its invocation fence",
        { operation: "exec-cancel" },
      );
    return this.#mutate("exec-cancel", normalized, async () => {
      const resolved = await this.#resolve({ ...normalized, labels });
      this.#assertFence(resolved.sandbox, normalized);
      const remote = await this.#client.cancelExecution(
        record.reference,
        labels,
        normalized.executionId,
        normalized.idempotencyKey,
      );
      const mapped = this.#remember(remote, { labels, ...normalized });
      record.expectedFence = mapped.sandbox.fence;
      this.#append("exec-cancel", mapped.sandbox, normalized.idempotencyKey);
      return mapped.sandbox;
    });
  }

  async reconcile(request) {
    const normalized = validateLookup(request, "reconcile");
    const labels = resourceLabels(normalized);
    const response = await this.#client.listByLabels(labels);
    const resources = resourceList(response);
    const matches = resources.filter((resource) =>
      labelsEqual(resource.labels, labels),
    );
    if (matches.length > 1)
      conflict("multiple resources share immutable labels", "reconcile");
    if (matches.length === 0) return null;
    return this.#remember(matches[0].raw, { labels, ...normalized }).sandbox;
  }

  async #lifecycle(operation, request) {
    const normalized = validateMutation(request, operation);
    const labels = resourceLabels(normalized);
    return this.#mutate(operation, normalized, async () => {
      const resolved = await this.#resolve({ ...normalized, labels });
      this.#assertFence(resolved.sandbox, normalized);
      if (operation === "cancel" && !this.#capabilities.cancellation)
        unsupported("cancellation");
      const remote =
        operation === "cancel"
          ? await this.#client.cancel(
              resolved.reference,
              labels,
              normalized.idempotencyKey,
            )
          : await this.#client[operation](
              resolved.reference,
              labels,
              normalized.idempotencyKey,
            );
      const mapped = this.#remember(remote, { labels, ...normalized });
      this.#append(operation, mapped.sandbox, normalized.idempotencyKey);
      return mapped.sandbox;
    });
  }

  async #reconcile(labels) {
    const response = await this.#client.listByLabels(labels);
    const resources = resourceList(response);
    const matches = resources.filter((resource) =>
      labelsEqual(resource.labels, labels),
    );
    if (matches.length > 1)
      conflict("multiple resources share immutable labels", "create");
    if (matches.length === 0)
      throw cloudflareOsError(
        CLOUDFLARE_OS_ERROR_CODES.TIMEOUT,
        "Cloudflare OS create timed out before reconciliation found the resource",
        { operation: "create", retryable: false },
      );
    return matches[0].raw;
  }

  async #resolve(request) {
    const labels = resourceLabels(request);
    const local = this.#records.get(request.sandboxId);
    if (local && labelsEqual(local.labels, labels)) {
      const remote = await this.#client.inspect(local.reference, labels);
      return this.#remember(remote, { labels, ...request });
    }
    const response = await this.#client.listByLabels(labels);
    const resources = resourceList(response);
    const matches = resources.filter((resource) =>
      labelsEqual(resource.labels, labels),
    );
    if (matches.length > 1)
      conflict("multiple resources share immutable labels", "resolve");
    if (matches.length === 0)
      throw cloudflareOsError(
        CLOUDFLARE_OS_ERROR_CODES.NOT_FOUND,
        "Cloudflare OS resource was not found",
        { operation: "resolve", status: 404 },
      );
    const mapped = this.#remember(matches[0].raw, { labels, ...request });
    if (request.sandboxId !== mapped.sandbox.sandboxId)
      throw cloudflareOsError(
        SANDBOX_ERROR_CODES.INVALID_HANDLE,
        "sandboxId does not match immutable Cloudflare OS resource identity",
        { operation: "resolve" },
      );
    return mapped;
  }

  #remember(remote, expected) {
    const mapped = mapResource(remote, expected);
    const existing = this.#records.get(mapped.sandbox.sandboxId);
    if (existing && !labelsEqual(existing.labels, mapped.labels))
      conflict(
        "public sandbox identity is already bound to different labels",
        "map",
      );
    const record = { ...mapped, sandbox: structuredClone(mapped.sandbox) };
    this.#records.set(mapped.sandbox.sandboxId, record);
    return record;
  }

  #assertFence(sandbox, request) {
    if (
      sandbox.runId !== request.runId ||
      sandbox.invocationDigest !== request.invocationDigest
    )
      throw cloudflareOsError(
        SANDBOX_ERROR_CODES.FENCE_MISMATCH,
        "request is outside the invocation fence",
        { operation: "fence" },
      );
    if (request.expectedFence !== sandbox.fence)
      throw cloudflareOsError(
        SANDBOX_ERROR_CODES.FENCE_MISMATCH,
        "expected lifecycle fence is stale",
        { operation: "fence" },
      );
  }

  async #mutate(operation, request, apply) {
    const fingerprint = hash(canonical({ operation, ...request }));
    const prior = this.#idempotency.get(request.idempotencyKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        conflict("idempotency key has a different payload", operation);
      return structuredClone(await prior.promise);
    }
    const promise = apply();
    this.#idempotency.set(request.idempotencyKey, {
      fingerprint,
      promise,
    });
    try {
      const result = await promise;
      this.#idempotency.set(request.idempotencyKey, {
        fingerprint,
        promise: Promise.resolve(structuredClone(result)),
      });
      return result;
    } catch (error) {
      const current = this.#idempotency.get(request.idempotencyKey);
      if (current?.promise === promise)
        this.#idempotency.delete(request.idempotencyKey);
      throw error;
    }
  }

  #append(operation, sandbox, idempotencyKey) {
    this.#events.push({
      idempotencyKey,
      operation,
      sandbox: structuredClone(sandbox),
    });
  }
}

export function createCloudflareOsProvider(options) {
  const client = options?.client ?? new CloudflareOsClient(options);
  return new CloudflareOsSandboxProvider({ ...options, client });
}

function validateMutation(request, operation) {
  if (!request || typeof request !== "object" || Array.isArray(request))
    invalid(`${operation} request`);
  for (const key of ["runId", "invocationDigest", "idempotencyKey"]) {
    if (typeof request[key] !== "string" || !ID.test(request[key]))
      invalid(`${key} is invalid`);
  }
  if (!RUN_ID.test(request.runId)) invalid("runId is invalid");
  if (!DIGEST.test(request.invocationDigest))
    invalid("invocationDigest is invalid");
  if (!Number.isSafeInteger(request.expectedFence) || request.expectedFence < 0)
    invalid("expectedFence is invalid");
  if (SECRET.test(JSON.stringify(request)))
    invalid("request contains forbidden credential-shaped material");
  return request;
}

function validateLookup(request, operation) {
  if (!request || typeof request !== "object" || Array.isArray(request))
    invalid(`${operation} request`);
  for (const key of ["runId", "invocationDigest"]) {
    if (typeof request[key] !== "string" || !ID.test(request[key]))
      invalid(`${key} is invalid`);
  }
  if (!RUN_ID.test(request.runId)) invalid("runId is invalid");
  if (!DIGEST.test(request.invocationDigest))
    invalid("invocationDigest is invalid");
  if (!Number.isSafeInteger(request.expectedFence) || request.expectedFence < 0)
    invalid("expectedFence is invalid");
  if (
    request.idempotencyKey !== undefined &&
    (typeof request.idempotencyKey !== "string" ||
      !ID.test(request.idempotencyKey))
  )
    invalid("idempotencyKey is invalid");
  if (SECRET.test(JSON.stringify(request)))
    invalid("request contains forbidden credential-shaped material");
  const normalized = request;
  if (
    typeof normalized.sandboxId !== "string" ||
    !ID.test(normalized.sandboxId)
  )
    invalid("sandboxId is invalid");
  return normalized;
}

function validateExecutionLookup(request, operation) {
  const normalized = validateLookup(request, operation);
  if (
    typeof normalized.executionId !== "string" ||
    !/^ex_[A-Za-z0-9._:-]{1,160}$/u.test(normalized.executionId)
  )
    invalid("executionId is invalid");
  return normalized;
}

function validateExecutionMutation(request, operation) {
  const normalized = validateMutation(request, operation);
  if (
    typeof normalized.sandboxId !== "string" ||
    !ID.test(normalized.sandboxId)
  )
    invalid("sandboxId is invalid");
  if (
    typeof normalized.executionId !== "string" ||
    !/^ex_[A-Za-z0-9._:-]{1,160}$/u.test(normalized.executionId)
  )
    invalid("executionId is invalid");
  return normalized;
}

function validateSpec(spec, capabilities) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec))
    invalid("spec is required");
  const required = spec.requiredCapabilities ?? [];
  if (!Array.isArray(required)) invalid("requiredCapabilities is invalid");
  for (const capability of required) {
    if (!capabilities.capabilities.includes(capability))
      unsupported(capability);
  }
  compileNetworkPolicy(spec.networkPolicy ?? DEFAULT_NETWORK_POLICY);
}

function validateExec(exec, capabilities) {
  if (!exec || typeof exec.command !== "string" || exec.command.length === 0)
    invalid("command is invalid");
  if (exec.stream && !capabilities.streamingExec) unsupported("streaming-exec");
  if (SECRET.test(JSON.stringify(exec)))
    invalid("execution contains forbidden credential-shaped material");
}

function publicSpec(spec) {
  return {
    ...structuredClone(spec),
    networkPolicy: publicPolicy(
      compileNetworkPolicy(spec.networkPolicy ?? DEFAULT_NETWORK_POLICY),
    ),
  };
}

function publicPolicy(policy) {
  return {
    schemaVersion: policy.schemaVersion,
    defaultEgress: policy.defaultEgress,
    defaultInbound: policy.defaultInbound,
    allow: structuredClone(policy.allow),
    inbound: structuredClone(policy.inbound),
    digest: policy.digest,
  };
}

function resourceList(response) {
  const resources = response?.resources ?? response?.items ?? response;
  if (!Array.isArray(resources))
    throw cloudflareOsError(
      CLOUDFLARE_OS_ERROR_CODES.PROTOCOL,
      "Cloudflare OS reconciliation response is not a resource list",
      { operation: "reconcile" },
    );
  return resources.map((raw) => ({
    raw,
    labels: raw?.labels ?? raw?.workspace?.labels ?? raw?.gadget?.labels,
  }));
}

function invalid(detail) {
  throw cloudflareOsError(CLOUDFLARE_OS_ERROR_CODES.INVALID_REQUEST, detail, {
    operation: "validate",
  });
}

function unsupported(capability) {
  throw cloudflareOsError(
    SANDBOX_ERROR_CODES.UNSUPPORTED_CAPABILITY,
    `capability is not supported: ${capability}`,
    { operation: "validate" },
  );
}

function conflict(detail, operation) {
  throw cloudflareOsError(CLOUDFLARE_OS_ERROR_CODES.CONFLICT, detail, {
    operation,
  });
}

function notFound(subject) {
  throw cloudflareOsError(
    CLOUDFLARE_OS_ERROR_CODES.NOT_FOUND,
    `${subject} was not found`,
    { operation: "resolve" },
  );
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
