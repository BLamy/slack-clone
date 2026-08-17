import { createHash } from "node:crypto";

import { CLOUDFLARE_OS_ERROR_CODES, cloudflareOsError } from "./errors.mjs";

const ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const SECRET =
  /(?:private key|bearer\s+|api[_-]?key\s*[:=]|password\s*[:=]|secret\s*[:=]|token\s*[:=])/iu;

export const RESOURCE_LABEL_KEYS = Object.freeze([
  "stream-slack/tenant",
  "stream-slack/workspace",
  "stream-slack/agent",
  "stream-slack/invocation",
  "stream-slack/idempotency",
]);

const STATE_MAP = Object.freeze({
  creating: "creating",
  provisioning: "creating",
  ready: "ready",
  active: "ready",
  running: "running",
  suspended: "suspended",
  paused: "suspended",
  destroyed: "destroyed",
  deleted: "destroyed",
});

export function resourceLabels(request) {
  assertObject(request, "request");
  const source =
    request.resourceIdentity ?? request.labels ?? request.controlPlane;
  assertObject(source, "resourceIdentity");
  const labels = {
    "stream-slack/tenant": source.tenantId ?? source.tenant,
    "stream-slack/workspace": source.workspaceId ?? source.workspace,
    "stream-slack/agent": source.agentId ?? source.agent,
    "stream-slack/invocation": source.invocationId ?? source.invocation,
    "stream-slack/idempotency":
      source.idempotencyKey ??
      request.resourceIdempotencyKey ??
      request.idempotencyKey,
  };
  for (const key of RESOURCE_LABEL_KEYS) {
    if (typeof labels[key] !== "string" || !ID.test(labels[key])) {
      throw cloudflareOsError(
        CLOUDFLARE_OS_ERROR_CODES.INVALID_REQUEST,
        `${key} label is invalid`,
        { operation: "labels" },
      );
    }
  }
  if (SECRET.test(JSON.stringify(labels))) {
    throw cloudflareOsError(
      CLOUDFLARE_OS_ERROR_CODES.INVALID_REQUEST,
      "resource labels contain forbidden credential-shaped material",
      { operation: "labels" },
    );
  }
  return Object.freeze(labels);
}

export function labelsEqual(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual))
    return false;
  return RESOURCE_LABEL_KEYS.every((key) => actual[key] === expected[key]);
}

export function publicSandboxId(labels, workspaceId, gadgetId) {
  return `sb_${hash(canonical({ gadgetId, labels, workspaceId })).slice(0, 24)}`;
}

export function mapResource(remote, expected) {
  const record = unwrapResource(remote);
  const labels =
    record.labels ?? record.workspace?.labels ?? record.gadget?.labels;
  if (!labelsEqual(labels, expected.labels)) {
    throw cloudflareOsError(
      CLOUDFLARE_OS_ERROR_CODES.CONFLICT,
      "Cloudflare OS returned conflicting immutable resource labels",
      { operation: "map" },
    );
  }
  const workspaceId =
    record.workspaceId ?? record.workspace?.id ?? record.workspace?.workspaceId;
  const gadgetId =
    record.gadgetId ?? record.gadget?.id ?? record.gadget?.gadgetId;
  if (typeof workspaceId !== "string" || !ID.test(workspaceId))
    protocol("workspace id");
  if (typeof gadgetId !== "string" || !ID.test(gadgetId)) protocol("gadget id");
  const lifecycle =
    STATE_MAP[record.state ?? record.status ?? record.lifecycle];
  if (!lifecycle) protocol("lifecycle state");
  const fence = record.fence ?? record.revision;
  if (!Number.isSafeInteger(fence) || fence < 1) protocol("lifecycle fence");
  return {
    sandbox: {
      sandboxId: publicSandboxId(labels, workspaceId, gadgetId),
      runId: expected.runId,
      invocationDigest: expected.invocationDigest,
      lifecycle,
      fence,
      spec: structuredClone(expected.spec ?? record.spec ?? {}),
    },
    reference: { gadgetId, workspaceId },
    labels: structuredClone(labels),
  };
}

export function unwrapResource(remote) {
  if (!remote || typeof remote !== "object" || Array.isArray(remote))
    protocol("resource response");
  const record = remote.resource ?? remote.workspace ?? remote;
  if (!record || typeof record !== "object" || Array.isArray(record))
    protocol("resource response");
  return record;
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw cloudflareOsError(
      CLOUDFLARE_OS_ERROR_CODES.INVALID_REQUEST,
      `${name} must be an object`,
      { operation: "validate" },
    );
}

function protocol(subject) {
  throw cloudflareOsError(
    CLOUDFLARE_OS_ERROR_CODES.PROTOCOL,
    `Cloudflare OS response has an invalid ${subject}`,
    { operation: "map" },
  );
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
