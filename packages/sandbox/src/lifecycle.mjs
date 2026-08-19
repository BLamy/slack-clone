import { createHash } from "node:crypto";

import { SANDBOX_ERROR_CODES, sandboxError } from "./errors.mjs";

const ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const RUN_ID = /^rn_[A-Za-z0-9._:-]{1,120}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const TOKEN = /^rt_[0-9a-f]{64}$/u;
const MODES = Object.freeze(["ephemeral", "persistent"]);
const EXCLUDED_ROOTS = new Set([
  ".cache",
  ".run",
  "broker",
  "cache",
  "credentials",
  "env",
  "proxy",
  "run",
  "runs",
  "sockets",
  "tmp",
  "tool-cache",
  "workspace-scratch",
]);
const SECRET =
  /(?:private key|bearer\s+|api[_-]?key\s*[:=]|password\s*[:=]|secret\s*[:=]|token\s*[:=])/iu;

export const LIFECYCLE_ERROR_CODES = Object.freeze({
  INVALID_POLICY: "SANDBOX_LIFECYCLE_POLICY_INVALID",
  LINEAGE_NOT_FOUND: "SANDBOX_LINEAGE_NOT_FOUND",
  LINEAGE_BUSY: "SANDBOX_LINEAGE_BUSY",
  LINEAGE_FENCE_MISMATCH: "SANDBOX_LINEAGE_FENCE_MISMATCH",
  LINEAGE_REVOKED: "SANDBOX_LINEAGE_REVOKED",
  TREE_DIGEST_MISMATCH: "SANDBOX_LINEAGE_TREE_DIGEST_MISMATCH",
  RETENTION_EXPIRED: "SANDBOX_LINEAGE_RETENTION_EXPIRED",
  RETAINED_SECRET: "SANDBOX_LINEAGE_RETAINED_SECRET",
  EPHEMERAL_RETAINED: "SANDBOX_EPHEMERAL_RETAINED",
});

export function compileLifecyclePolicy(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    lifecycleInvalid("lifecycle policy must be an object");
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1)
    lifecycleInvalid("lifecycle policy schemaVersion must be 1");
  const mode = input.mode ?? input.persistence;
  if (!MODES.includes(mode)) lifecycleInvalid("lifecycle mode is invalid");
  const agentId = normalizeId(input.agentId, "agentId");
  const lineageKey = normalizeId(
    input.lineageKey ?? "agent-default",
    "lineageKey",
  );
  const retentionMs =
    input.retentionMs ?? (mode === "persistent" ? 86_400_000 : 0);
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0)
    lifecycleInvalid("retentionMs is invalid");
  if (mode === "persistent" && retentionMs < 1)
    lifecycleInvalid("persistent retentionMs must be positive");
  if (mode === "ephemeral" && retentionMs !== 0)
    lifecycleInvalid("ephemeral retentionMs must be zero");
  const encryption = input.encryption ?? "provider-managed";
  if (encryption !== "provider-managed")
    lifecycleInvalid("lifecycle encryption must be provider-managed");
  const value = {
    schemaVersion: 1,
    mode,
    agentId,
    lineageKey,
    retentionMs,
    encryption,
  };
  return Object.freeze({ ...value, digest: digest(value) });
}

export class SandboxLifecycleManager {
  #clock;
  #lineages = new Map();
  #lineageGenerations = new Map();
  #tombstones = new Map();
  #idempotency = new Map();
  #events = [];

  constructor({ clock = () => Date.now() } = {}) {
    if (typeof clock !== "function")
      throw new TypeError("lifecycle clock must be a function");
    this.#clock = clock;
  }

  create({ agentId, runId, invocationDigest, policy, idempotencyKey } = {}) {
    const normalized = normalizeRunRequest({
      agentId,
      runId,
      invocationDigest,
      idempotencyKey,
    });
    const compiled = compileLifecyclePolicy({ ...policy, agentId });
    return this.#mutate(
      "create",
      { ...normalized, policyDigest: compiled.digest, mode: compiled.mode },
      () => {
        const lineageId = lineageIdFor(compiled, normalized.agentId);
        if (this.#lineages.has(lineageId))
          throw lifecycleError(
            LIFECYCLE_ERROR_CODES.LINEAGE_BUSY,
            "configured agent lineage is already retained",
          );
        const state = this.#newState({
          lineageId,
          compiled,
          generation: (this.#lineageGenerations.get(lineageId) ?? 0) + 1,
          runId: normalized.runId,
          invocationDigest: normalized.invocationDigest,
        });
        this.#lineageGenerations.set(lineageId, state.generation);
        this.#lineages.set(lineageId, state);
        this.#tombstones.delete(lineageId);
        this.#append("create", state, {
          policyDigest: compiled.digest,
          treeDigest: null,
        });
        return publicHandle(state, { baseTreeDigest: null });
      },
    );
  }

  suspend({
    agentId,
    lineageId,
    runId,
    expectedFence,
    resumeToken,
    treeDigest,
    entries = [],
    idempotencyKey,
  } = {}) {
    const normalized = normalizeHandleRequest({
      agentId,
      lineageId,
      runId,
      expectedFence,
      resumeToken,
      idempotencyKey,
    });
    return this.#mutate("suspend", normalized, () => {
      const state = this.#get(lineageId);
      this.#assertActiveHandle(state, normalized);
      const retained = retainEntries(entries);
      const computedTreeDigest = retainedTreeDigest(retained);
      if (treeDigest !== undefined && treeDigest !== computedTreeDigest)
        throw lifecycleError(
          LIFECYCLE_ERROR_CODES.TREE_DIGEST_MISMATCH,
          "suspend tree digest does not match retained workspace bytes",
        );
      if (state.mode === "ephemeral") {
        const baseTreeDigest = state.treeDigest;
        state.fence += 1;
        state.status = "destroyed";
        state.entries = [];
        state.treeDigest = null;
        this.#lineages.delete(state.lineageId);
        this.#tombstones.set(state.lineageId, "destroyed");
        const result = {
          lineageId: state.lineageId,
          mode: state.mode,
          destroyed: true,
          retainedTreeDigest: null,
          fence: state.fence,
        };
        this.#append("destroy", state, {
          reasonCode: "ephemeral_terminal_cleanup",
          baseTreeDigest,
          newTreeDigest: null,
          treeDigest: null,
        });
        return result;
      }
      const baseTreeDigest = state.treeDigest;
      state.status = "suspended";
      state.fence += 1;
      state.entries = retained;
      state.treeDigest = computedTreeDigest;
      state.retentionExpiresAt = this.#clock() + state.retentionMs;
      rotateToken(state);
      this.#append("suspend", state, {
        baseTreeDigest,
        newTreeDigest: computedTreeDigest,
        treeDigest: computedTreeDigest,
        retentionExpiresAt: state.retentionExpiresAt,
      });
      return publicHandle(state, { baseTreeDigest });
    });
  }

  resume({
    agentId,
    lineageId,
    runId,
    invocationDigest,
    expectedFence,
    resumeToken,
    expectedTreeDigest,
    idempotencyKey,
  } = {}) {
    const normalized = normalizeHandleRequest({
      agentId,
      lineageId,
      runId,
      expectedFence,
      resumeToken,
      idempotencyKey,
    });
    if (!DIGEST.test(invocationDigest))
      lifecycleInvalid("invocationDigest is invalid");
    return this.#mutate(
      "resume",
      { ...normalized, invocationDigest, expectedTreeDigest },
      () => {
        const state = this.#get(lineageId);
        if (state.status === "active")
          throw lifecycleError(
            LIFECYCLE_ERROR_CODES.LINEAGE_BUSY,
            "lineage is already resumed by another run",
          );
        if (state.status !== "suspended")
          throw lifecycleError(
            LIFECYCLE_ERROR_CODES.LINEAGE_REVOKED,
            "lineage cannot be resumed",
          );
        if (
          state.retentionExpiresAt !== null &&
          this.#clock() >= state.retentionExpiresAt
        ) {
          this.#destroyState(state, "retention_expired");
          throw lifecycleError(
            LIFECYCLE_ERROR_CODES.RETENTION_EXPIRED,
            "retained lineage expired before resume",
          );
        }
        this.#assertTokenAndFence(state, normalized, { matchRun: false });
        if (expectedTreeDigest !== state.treeDigest)
          throw lifecycleError(
            LIFECYCLE_ERROR_CODES.TREE_DIGEST_MISMATCH,
            "resume tree digest does not match the retained manifest",
          );
        const baseTreeDigest = state.treeDigest;
        state.status = "active";
        state.fence += 1;
        state.runId = normalized.runId;
        state.invocationDigest = invocationDigest;
        state.retentionExpiresAt = null;
        rotateToken(state);
        this.#append("resume", state, {
          baseTreeDigest,
          newTreeDigest: state.treeDigest,
        });
        return publicHandle(state, { baseTreeDigest: state.treeDigest });
      },
    );
  }

  reset({
    agentId,
    lineageId,
    runId,
    expectedFence,
    resumeToken,
    idempotencyKey,
  } = {}) {
    const normalized = normalizeHandleRequest({
      agentId,
      lineageId,
      runId,
      expectedFence,
      resumeToken,
      idempotencyKey,
    });
    return this.#mutate("reset", normalized, () => {
      const state = this.#get(lineageId);
      this.#assertActiveHandle(state, normalized);
      if (state.mode !== "persistent")
        throw lifecycleError(
          LIFECYCLE_ERROR_CODES.EPHEMERAL_RETAINED,
          "ephemeral lineages cannot be reset or retained",
        );
      const baseTreeDigest = state.treeDigest;
      state.entries = [];
      state.treeDigest = null;
      state.fence += 1;
      rotateToken(state);
      this.#append("reset", state, {
        baseTreeDigest,
        newTreeDigest: null,
      });
      return publicHandle(state, { baseTreeDigest: null });
    });
  }

  revoke({
    agentId,
    lineageId,
    runId,
    expectedFence,
    resumeToken,
    idempotencyKey,
  } = {}) {
    const normalized = normalizeHandleRequest({
      agentId,
      lineageId,
      runId,
      expectedFence,
      resumeToken,
      idempotencyKey,
    });
    return this.#mutate("revoke", normalized, () => {
      const state = this.#get(lineageId);
      this.#assertActiveHandle(state, normalized);
      this.#destroyState(state, "revoked");
      this.#tombstones.set(state.lineageId, "revoked");
      return { lineageId: state.lineageId, revoked: true, fence: state.fence };
    });
  }

  destroy({
    agentId,
    lineageId,
    runId,
    expectedFence,
    resumeToken,
    idempotencyKey,
  } = {}) {
    const normalized = normalizeHandleRequest({
      agentId,
      lineageId,
      runId,
      expectedFence,
      resumeToken,
      idempotencyKey,
    });
    return this.#mutate("destroy", normalized, () => {
      const state = this.#get(lineageId);
      this.#assertActiveHandle(state, normalized);
      this.#destroyState(state, "requested");
      this.#tombstones.set(state.lineageId, "destroyed");
      return {
        lineageId: state.lineageId,
        destroyed: true,
        fence: state.fence,
      };
    });
  }

  expire(now = this.#clock()) {
    if (!Number.isSafeInteger(now)) lifecycleInvalid("expiry clock is invalid");
    const expired = [];
    for (const state of this.#lineages.values()) {
      if (
        state.mode === "persistent" &&
        state.status === "suspended" &&
        state.retentionExpiresAt !== null &&
        now >= state.retentionExpiresAt
      ) {
        this.#destroyState(state, "retention_expired");
        this.#tombstones.set(state.lineageId, "expired");
        expired.push(state.lineageId);
      }
    }
    return expired;
  }

  inventory({ agentId } = {}) {
    if (agentId !== undefined) normalizeId(agentId, "agentId");
    return [...this.#lineages.values()]
      .filter((state) => agentId === undefined || state.agentId === agentId)
      .map((state) => publicState(state));
  }

  retainedManifest(lineageId) {
    const state = this.#get(lineageId);
    return state.entries.map(({ path, byteLength, digest }) => ({
      path,
      byteLength,
      digest,
    }));
  }

  events() {
    return structuredClone(this.#events);
  }

  digest() {
    return digest(this.#events);
  }

  #newState({ lineageId, compiled, generation, runId, invocationDigest }) {
    const state = {
      agentId: compiled.agentId,
      lineageId,
      generation,
      mode: compiled.mode,
      lineageKey: compiled.lineageKey,
      retentionMs: compiled.retentionMs,
      policyDigest: compiled.digest,
      encryption: compiled.encryption,
      status: "active",
      fence: 1,
      tokenDigest: null,
      rotation: 0,
      runId,
      invocationDigest,
      treeDigest: null,
      entries: [],
      retentionExpiresAt: null,
      createdAt: this.#clock(),
    };
    rotateToken(state);
    return state;
  }

  #get(lineageId) {
    if (typeof lineageId !== "string" || !ID.test(lineageId))
      lifecycleInvalid("lineageId is invalid");
    const state = this.#lineages.get(lineageId);
    if (state) return state;
    const tombstone = this.#tombstones.get(lineageId);
    if (tombstone === "expired")
      throw lifecycleError(
        LIFECYCLE_ERROR_CODES.RETENTION_EXPIRED,
        "lineage retention has expired",
      );
    if (tombstone)
      throw lifecycleError(
        LIFECYCLE_ERROR_CODES.LINEAGE_REVOKED,
        `lineage is no longer available: ${tombstone}`,
      );
    throw lifecycleError(
      LIFECYCLE_ERROR_CODES.LINEAGE_NOT_FOUND,
      "lineage was not found",
    );
  }

  #assertActiveHandle(state, request) {
    if (state.status !== "active")
      throw lifecycleError(
        LIFECYCLE_ERROR_CODES.LINEAGE_BUSY,
        "lineage is not active for this operation",
      );
    this.#assertTokenAndFence(state, request);
  }

  #assertTokenAndFence(state, request, { matchRun = true } = {}) {
    if (
      state.agentId !== request.agentId ||
      (matchRun && state.runId !== request.runId)
    )
      throw lifecycleError(
        LIFECYCLE_ERROR_CODES.LINEAGE_FENCE_MISMATCH,
        "lineage owner or run does not match",
      );
    if (state.fence !== request.expectedFence)
      throw lifecycleError(
        LIFECYCLE_ERROR_CODES.LINEAGE_FENCE_MISMATCH,
        "lineage fence is stale",
      );
    if (hash(request.resumeToken) !== state.tokenDigest)
      throw lifecycleError(
        LIFECYCLE_ERROR_CODES.LINEAGE_FENCE_MISMATCH,
        "resume token is stale",
      );
  }

  #destroyState(state, reasonCode) {
    state.status = "destroyed";
    state.fence += 1;
    state.entries = [];
    state.treeDigest = null;
    state.retentionExpiresAt = null;
    this.#lineages.delete(state.lineageId);
    this.#append("destroy", state, { reasonCode, treeDigest: null });
  }

  #append(operation, state, extra = {}) {
    this.#events.push({
      sequence: this.#events.length + 1,
      operation,
      lineageId: state.lineageId,
      agentId: state.agentId,
      mode: state.mode,
      status: state.status,
      fence: state.fence,
      ...extra,
    });
  }

  #mutate(operation, request, apply) {
    const key = request.idempotencyKey;
    const fingerprint = digest({ operation, ...request });
    const prior = this.#idempotency.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw lifecycleError(
          SANDBOX_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          "lifecycle idempotency key has a different payload",
        );
      return structuredClone(prior.result);
    }
    const result = apply();
    this.#idempotency.set(key, {
      fingerprint,
      result: structuredClone(result),
    });
    return result;
  }
}

export function retainEntries(entries) {
  if (!Array.isArray(entries) || entries.length > 4096)
    lifecycleInvalid("retained entries are invalid");
  const retained = [];
  const paths = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      lifecycleInvalid("retained entry is invalid");
    const normalizedPath = normalizeRetainedPath(entry.path);
    if (isExcludedPath(normalizedPath)) continue;
    if (paths.has(normalizedPath))
      lifecycleInvalid("retained paths must be unique");
    paths.add(normalizedPath);
    const bytes = entry.bytes ?? entry.content ?? "";
    const buffer = toBytes(bytes);
    if (SECRET.test(buffer.toString("utf8")))
      throw lifecycleError(
        LIFECYCLE_ERROR_CODES.RETAINED_SECRET,
        "credential-shaped material cannot enter retained state",
      );
    retained.push({
      path: normalizedPath,
      byteLength: buffer.byteLength,
      bytes: buffer.toString("base64"),
      digest: `sha256:${createHash("sha256").update(buffer).digest("hex")}`,
    });
  }
  retained.sort((left, right) => left.path.localeCompare(right.path));
  return retained;
}

export function retainedTreeDigest(entries) {
  const normalized = Array.isArray(entries)
    ? entries.every(isNormalizedEntry)
      ? entries
      : retainEntries(entries)
    : entries;
  return digest(
    normalized.map(({ path, byteLength, bytes, digest: entryDigest }) => ({
      path,
      byteLength,
      bytes,
      digest: entryDigest,
    })),
  );
}

function isNormalizedEntry(entry) {
  return (
    entry &&
    typeof entry === "object" &&
    typeof entry.path === "string" &&
    Number.isSafeInteger(entry.byteLength) &&
    typeof entry.bytes === "string" &&
    typeof entry.digest === "string"
  );
}

function publicHandle(state, { baseTreeDigest }) {
  return {
    lineageId: state.lineageId,
    agentId: state.agentId,
    mode: state.mode,
    lineageGeneration: state.generation,
    policyDigest: state.policyDigest,
    encryption: state.encryption,
    fence: state.fence,
    resumeToken: tokenFor(state),
    baseTreeDigest,
    treeDigest: state.treeDigest,
    status: state.status,
  };
}

function publicState(state) {
  return {
    lineageId: state.lineageId,
    agentId: state.agentId,
    mode: state.mode,
    lineageKey: state.lineageKey,
    lineageGeneration: state.generation,
    policyDigest: state.policyDigest,
    encryption: state.encryption,
    status: state.status,
    fence: state.fence,
    runId: state.runId,
    treeDigest: state.treeDigest,
    retentionExpiresAt: state.retentionExpiresAt,
  };
}

function rotateToken(state) {
  state.rotation += 1;
  state.tokenDigest = hash(tokenFor(state));
}

function tokenFor(state) {
  return `rt_${createHash("sha256")
    .update(
      canonical({
        lineageId: state.lineageId,
        generation: state.generation,
        fence: state.fence,
        rotation: state.rotation,
      }),
    )
    .digest("hex")}`;
}

function lineageIdFor(policy, agentId) {
  return `ln_${createHash("sha256")
    .update(canonical({ agentId, lineageKey: policy.lineageKey }))
    .digest("hex")
    .slice(0, 32)}`;
}

function normalizeRunRequest({
  agentId,
  runId,
  invocationDigest,
  idempotencyKey,
}) {
  normalizeId(agentId, "agentId");
  if (typeof runId !== "string" || !RUN_ID.test(runId))
    lifecycleInvalid("runId is invalid");
  if (!DIGEST.test(invocationDigest))
    lifecycleInvalid("invocationDigest is invalid");
  return {
    agentId,
    runId,
    invocationDigest,
    idempotencyKey: normalizeId(idempotencyKey, "idempotencyKey"),
  };
}

function normalizeHandleRequest({
  agentId,
  lineageId,
  runId,
  expectedFence,
  resumeToken,
  idempotencyKey,
}) {
  normalizeId(agentId, "agentId");
  normalizeId(lineageId, "lineageId");
  if (typeof runId !== "string" || !RUN_ID.test(runId))
    lifecycleInvalid("runId is invalid");
  if (!Number.isSafeInteger(expectedFence) || expectedFence < 1)
    lifecycleInvalid("expectedFence is invalid");
  if (typeof resumeToken !== "string" || !TOKEN.test(resumeToken))
    lifecycleInvalid("resumeToken is invalid");
  return {
    agentId,
    lineageId,
    runId,
    expectedFence,
    resumeToken,
    idempotencyKey: normalizeId(idempotencyKey, "idempotencyKey"),
  };
}

function normalizeRetainedPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value !== value.normalize("NFC") ||
    value.includes("\0")
  )
    lifecycleInvalid("retained path is invalid");
  if (
    value.startsWith("/") ||
    value.split("/").some((part) => part === ".." || part === "")
  )
    lifecycleInvalid("retained path escapes the workspace");
  if (!value.startsWith("workspace/"))
    lifecycleInvalid("retained path must be under workspace/");
  return value;
}

function isExcludedPath(value) {
  const parts = value.split("/").slice(1);
  return parts.some(
    (part) =>
      EXCLUDED_ROOTS.has(part) ||
      part.startsWith(".run-") ||
      part.startsWith("tmp-"),
  );
}

function toBytes(value) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  lifecycleInvalid("retained entry bytes are invalid");
}

function normalizeId(value, name) {
  if (typeof value !== "string" || !ID.test(value))
    lifecycleInvalid(`${name} is invalid`);
  return value;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function lifecycleInvalid(detail) {
  throw sandboxError(LIFECYCLE_ERROR_CODES.INVALID_POLICY, detail);
}

function lifecycleError(code, detail) {
  return sandboxError(code, detail);
}
