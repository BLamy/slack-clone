import { ZERO_OFFSET } from "@stream-slack/protocol";

import { canonicalSha256 } from "./canonical-json.mjs";

export const E0_T07_CHECKPOINT_SCHEMA_VERSION = 1;
export const E0_T07_CHECKPOINT_ERROR = "E0_T07_CHECKPOINT_INVALID";

const CHECKPOINT_KEYS = [
  "checkpointDigest",
  "offset",
  "schemaVersion",
  "sourceStream",
];
const OFFSET_PATTERN = /^[0-9a-f]{16}_[0-9a-f]{16}$/u;
const STREAM_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export function createE0T07Checkpoint({ sourceStream, offset }) {
  assertSourceStream(sourceStream);
  assertOffset(offset);
  const body = {
    offset,
    schemaVersion: E0_T07_CHECKPOINT_SCHEMA_VERSION,
    sourceStream,
  };
  return {
    ...body,
    checkpointDigest: canonicalSha256(body),
  };
}

export function validateE0T07Checkpoint(value, { sourceStream } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw checkpointError("checkpoint must be an object");
  }
  if (
    CHECKPOINT_KEYS.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !CHECKPOINT_KEYS.includes(key))
  ) {
    throw checkpointError("checkpoint keys are not canonical");
  }
  if (value.schemaVersion !== E0_T07_CHECKPOINT_SCHEMA_VERSION) {
    throw checkpointError("checkpoint schema version is unsupported");
  }
  assertSourceStream(value.sourceStream);
  if (sourceStream !== undefined && value.sourceStream !== sourceStream) {
    throw checkpointError("checkpoint belongs to a different source stream");
  }
  assertOffset(value.offset);
  if (!DIGEST_PATTERN.test(value.checkpointDigest)) {
    throw checkpointError("checkpoint digest is malformed");
  }
  const expected = canonicalSha256({
    offset: value.offset,
    schemaVersion: value.schemaVersion,
    sourceStream: value.sourceStream,
  });
  if (value.checkpointDigest !== expected) {
    throw checkpointError("checkpoint digest does not match its source facts");
  }
  return value;
}

export function checkpointError(detail) {
  const error = new Error(`${E0_T07_CHECKPOINT_ERROR}: ${detail}`);
  error.code = E0_T07_CHECKPOINT_ERROR;
  return error;
}

function assertOffset(value) {
  if (value !== "-1" && value !== ZERO_OFFSET && !OFFSET_PATTERN.test(value)) {
    throw checkpointError(
      "checkpoint offset is not an opaque Durable Streams offset",
    );
  }
}

function assertSourceStream(value) {
  if (typeof value !== "string" || !STREAM_PATTERN.test(value)) {
    throw checkpointError("checkpoint source stream is malformed");
  }
}
