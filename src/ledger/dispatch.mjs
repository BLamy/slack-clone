import { ZERO_OFFSET } from "@stream-slack/protocol";

import { canonicalJson, canonicalSha256 } from "./canonical-json.mjs";
import { assertExactKeys } from "./errors.mjs";
import { assertIdentifier } from "./identifiers.mjs";

export const DISPATCH_SCHEMA_VERSION = 1;
export const DEFAULT_IDEMPOTENCY_STREAM =
  "__stream_slack_dispatch_idempotency__";

export const DISPATCH_REFUSAL_CODES = Object.freeze({
  INVALID_REQUEST: "DISPATCH_INVALID_REQUEST",
  UNAUTHORIZED: "DISPATCH_UNAUTHORIZED",
  IDEMPOTENCY_CONFLICT: "DISPATCH_IDEMPOTENCY_CONFLICT",
  STALE_FENCE: "DISPATCH_STALE_FENCE",
  PRODUCER_FENCED: "DISPATCH_PRODUCER_FENCED",
  DURABILITY_GAP: "DISPATCH_DURABILITY_GAP",
});

const REQUEST_KEYS = [
  "actorId",
  "expectedHead",
  "idempotencyKey",
  "operation",
  "payload",
  "stream",
  "workspaceId",
];
const IDENTITY_KEYS = [
  "actorId",
  "idempotencyKey",
  "operation",
  "payload",
  "stream",
  "workspaceId",
];
const METADATA_KEYS = [
  "actorId",
  "expectedHead",
  "idempotencyKey",
  "operation",
  "requestDigest",
  "schemaVersion",
  "stream",
  "workspaceId",
];
const RECEIPT_KEYS = [
  "actorId",
  "eventDigest",
  "idempotencyKey",
  "nextOffset",
  "operation",
  "requestDigest",
  "status",
  "stream",
  "workspaceId",
];
const INDEX_RECORD_KEYS = ["kind", "receipt"];
const INDEX_RECORD_KIND = "dispatch.accepted";
const SAFE_OPERATION = /^[a-z][a-z0-9._:-]{0,127}$/u;
const SAFE_STREAM = /^[A-Za-z0-9:_-]{1,200}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const OPAQUE_CHECKPOINT_MAX_BYTES = 512;

export class DispatchRefusalError extends Error {
  constructor(code, detail, { requestDigest = null, statusCode = 409 } = {}) {
    super(`${code}: ${detail}`);
    this.name = "DispatchRefusalError";
    this.code = code;
    this.detail = detail;
    this.requestDigest = requestDigest;
    this.statusCode = statusCode;
  }

  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      requestDigest: this.requestDigest,
      statusCode: this.statusCode,
    };
  }
}

export function validateDispatchRequest(value) {
  try {
    assertExactKeys(value, REQUEST_KEYS, "$.request");
    assertIdentifier("workspace", value.workspaceId, {
      path: "$.request.workspaceId",
    });
    assertSafeString(value.actorId, "$.request.actorId", 256);
    assertSafeString(value.idempotencyKey, "$.request.idempotencyKey", 128);
    assertIdentifier("idempotency", value.idempotencyKey, {
      path: "$.request.idempotencyKey",
    });
    if (
      typeof value.operation !== "string" ||
      !SAFE_OPERATION.test(value.operation)
    ) {
      throw new Error("operation must be a lowercase operation name");
    }
    if (typeof value.stream !== "string" || !SAFE_STREAM.test(value.stream)) {
      throw new Error("stream must be a canonical opaque stream key");
    }
    assertOpaqueCheckpoint(value.expectedHead, "$.request.expectedHead");
    canonicalJson(value.payload, "$.request.payload");
    if (isPlainObject(value.payload) && "dispatch" in value.payload) {
      throw new Error("payload.dispatch is reserved for the dispatch door");
    }
    return value;
  } catch (error) {
    if (error instanceof DispatchRefusalError) throw error;
    throw new DispatchRefusalError(
      DISPATCH_REFUSAL_CODES.INVALID_REQUEST,
      error instanceof Error ? error.message : String(error),
      { statusCode: 400 },
    );
  }
}

export function dispatchRequestDigest(request) {
  validateDispatchRequest(request);
  const identity = Object.fromEntries(
    IDENTITY_KEYS.map((key) => [key, request[key]]),
  );
  return canonicalSha256(identity);
}

export function validateDispatchReceipt(value) {
  return validateStoredReceipt(value);
}

export function createDispatchDoor({
  streamStore,
  authorize = () => true,
  producerId,
  producerEpoch = 0,
  idempotencyStream = DEFAULT_IDEMPOTENCY_STREAM,
}) {
  if (
    !streamStore ||
    typeof streamStore.read !== "function" ||
    typeof streamStore.append !== "function"
  ) {
    throw new TypeError(
      "dispatch requires a Durable Streams store with read and append",
    );
  }
  if (typeof authorize !== "function") {
    throw new TypeError("dispatch authorization must be a function");
  }
  assertSafeString(producerId, "$.producerId", 256);
  if (!Number.isSafeInteger(producerEpoch) || producerEpoch < 0) {
    throw new TypeError(
      "dispatch producerEpoch must be a non-negative safe integer",
    );
  }
  if (
    typeof idempotencyStream !== "string" ||
    !SAFE_STREAM.test(idempotencyStream)
  ) {
    throw new TypeError(
      "dispatch idempotencyStream must be a canonical opaque stream key",
    );
  }

  const streamTails = new Map();
  const keyTails = new Map();
  const producerSequences = new Map();

  function producerSequence(stream) {
    return producerSequences.get(stream) ?? 0;
  }

  async function dispatch(request, { signal } = {}) {
    validateDispatchRequest(request);
    const requestDigest = dispatchRequestDigest(request);
    const idempotencyKey = request.idempotencyKey;
    const authorization = await authorize(request);
    if (authorization !== true && authorization?.ok !== true) {
      throw new DispatchRefusalError(
        DISPATCH_REFUSAL_CODES.UNAUTHORIZED,
        authorization?.detail ?? "actor is not authorized for this dispatch",
        { requestDigest, statusCode: 403 },
      );
    }

    return serialize(keyTails, idempotencyKey, () =>
      serialize(streamTails, request.stream, () =>
        performDispatch({ request, requestDigest, signal }),
      ),
    );
  }

  async function performDispatch({ request, requestDigest, signal }) {
    const indexSnapshot = await readStream(idempotencyStream, signal);
    const indexed = findIndexedReceipt(
      indexSnapshot.records,
      request.idempotencyKey,
    );
    if (indexed) {
      assertReceiptMatchesRequest(indexed, request, requestDigest);
      const targetSnapshot = await readStream(request.stream, signal);
      const targetEvent = findTargetEvent(
        targetSnapshot.records,
        request.idempotencyKey,
      );
      if (!targetEvent) {
        throw durabilityGap(
          requestDigest,
          `receipt for ${request.idempotencyKey} has no target event`,
        );
      }
      assertMetadataMatchesRequest(
        targetEvent.dispatch,
        request,
        requestDigest,
      );
      return resultFromReceipt(indexed, targetSnapshot, targetEvent);
    }

    const targetSnapshot = await readStream(request.stream, signal);
    const recovered = findTargetEvent(
      targetSnapshot.records,
      request.idempotencyKey,
    );
    if (recovered) {
      assertMetadataMatchesRequest(recovered.dispatch, request, requestDigest);
      const receipt = createReceipt({
        request,
        requestDigest,
        eventDigest: canonicalSha256(recovered),
        nextOffset: targetSnapshot.nextOffset,
      });
      const persisted = await persistReceipt(receipt, signal);
      return resultFromReceipt(persisted, targetSnapshot, recovered);
    }

    if (targetSnapshot.nextOffset !== request.expectedHead) {
      throw new DispatchRefusalError(
        DISPATCH_REFUSAL_CODES.STALE_FENCE,
        `expected head ${request.expectedHead} was not current at ${targetSnapshot.nextOffset}`,
        { requestDigest },
      );
    }

    const event = attachMetadata(request.payload, {
      actorId: request.actorId,
      expectedHead: request.expectedHead,
      idempotencyKey: request.idempotencyKey,
      operation: request.operation,
      requestDigest,
      schemaVersion: DISPATCH_SCHEMA_VERSION,
      stream: request.stream,
      workspaceId: request.workspaceId,
    });
    const eventDigest = canonicalSha256(event);
    const producerSeq = producerSequence(request.stream);
    let appendResult;
    try {
      appendResult = await streamStore.append(request.stream, event, {
        signal,
        streamSeq: request.expectedHead,
        producer: {
          id: producerId,
          epoch: producerEpoch,
          seq: producerSeq,
        },
      });
      producerSequences.set(request.stream, producerSeq + 1);
    } catch (error) {
      throw mapAppendError(error, requestDigest);
    }

    const receipt = createReceipt({
      request,
      requestDigest,
      eventDigest,
      nextOffset: appendResult.nextOffset,
    });
    const persisted = await persistReceipt(receipt, signal);
    return resultFromReceipt(
      persisted,
      {
        records: [event],
        nextOffset: appendResult.nextOffset,
      },
      event,
    );
  }

  async function persistReceipt(receipt, signal) {
    return serialize(streamTails, idempotencyStream, async () => {
      const snapshot = await readStream(idempotencyStream, signal);
      const existing = findIndexedReceipt(
        snapshot.records,
        receipt.idempotencyKey,
      );
      if (existing) {
        assertReceiptMatchesRequest(
          existing,
          receiptRequest(receipt),
          receipt.requestDigest,
        );
        return existing;
      }

      const sequence = producerSequence(idempotencyStream);
      try {
        await streamStore.append(
          idempotencyStream,
          { kind: INDEX_RECORD_KIND, receipt },
          {
            signal,
            streamSeq: snapshot.nextOffset,
            producer: {
              id: producerId,
              epoch: producerEpoch,
              seq: sequence,
            },
          },
        );
        producerSequences.set(idempotencyStream, sequence + 1);
      } catch (error) {
        throw mapAppendError(error, receipt.requestDigest);
      }
      return receipt;
    });
  }

  async function readStream(stream, signal) {
    const result = await streamStore.read(stream, "-1", { signal });
    if (
      !Array.isArray(result.records) ||
      typeof result.nextOffset !== "string"
    ) {
      throw new Error(
        `dispatch store returned an invalid snapshot for ${stream}`,
      );
    }
    return result;
  }

  function close() {
    streamTails.clear();
    keyTails.clear();
    producerSequences.clear();
  }

  return Object.freeze({ close, dispatch });
}

function createReceipt({ request, requestDigest, eventDigest, nextOffset }) {
  assertOpaqueCheckpoint(nextOffset, "$.receipt.nextOffset");
  const receipt = {
    actorId: request.actorId,
    eventDigest,
    idempotencyKey: request.idempotencyKey,
    nextOffset,
    operation: request.operation,
    requestDigest,
    status: "accepted",
    stream: request.stream,
    workspaceId: request.workspaceId,
  };
  assertExactKeys(receipt, RECEIPT_KEYS, "$.receipt");
  return receipt;
}

function resultFromReceipt(receipt, snapshot, recoveredEvent) {
  const event =
    recoveredEvent ??
    snapshot.records.find(
      (record) =>
        record?.dispatch?.idempotencyKey === receipt.idempotencyKey &&
        record.dispatch.requestDigest === receipt.requestDigest,
    );
  if (!event) {
    throw durabilityGap(
      receipt.requestDigest,
      `accepted receipt for ${receipt.idempotencyKey} has no target event`,
    );
  }
  if (canonicalSha256(event) !== receipt.eventDigest) {
    throw durabilityGap(
      receipt.requestDigest,
      `target event for ${receipt.idempotencyKey} does not match its receipt`,
    );
  }
  return Object.freeze({
    event: event ?? null,
    receipt,
  });
}

function receiptRequest(receipt) {
  return {
    actorId: receipt.actorId,
    expectedHead: ZERO_OFFSET,
    idempotencyKey: receipt.idempotencyKey,
    operation: receipt.operation,
    payload: null,
    stream: receipt.stream,
    workspaceId: receipt.workspaceId,
  };
}

function findIndexedReceipt(records, idempotencyKey) {
  let found = null;
  for (const record of records) {
    if (record?.kind !== INDEX_RECORD_KIND) continue;
    assertExactKeys(record, INDEX_RECORD_KEYS, "$.index");
    if (record.receipt?.idempotencyKey !== idempotencyKey) continue;
    if (found) {
      throw new Error(
        `duplicate durable idempotency receipt for ${idempotencyKey}`,
      );
    }
    found = validateStoredReceipt(record.receipt);
  }
  return found;
}

function validateStoredReceipt(receipt) {
  assertExactKeys(receipt, RECEIPT_KEYS, "$.index.receipt");
  if (receipt.status !== "accepted") {
    throw new Error("durable dispatch receipt has an unknown status");
  }
  assertSafeString(receipt.actorId, "$.index.receipt.actorId", 256);
  assertIdentifier("workspace", receipt.workspaceId, {
    path: "$.index.receipt.workspaceId",
  });
  assertIdentifier("idempotency", receipt.idempotencyKey, {
    path: "$.index.receipt.idempotencyKey",
  });
  if (
    !DIGEST_PATTERN.test(receipt.eventDigest) ||
    !DIGEST_PATTERN.test(receipt.requestDigest)
  ) {
    throw new Error("durable dispatch receipt contains an invalid digest");
  }
  if (
    !SAFE_OPERATION.test(receipt.operation) ||
    !SAFE_STREAM.test(receipt.stream)
  ) {
    throw new Error(
      "durable dispatch receipt has an invalid operation or stream",
    );
  }
  assertOpaqueCheckpoint(receipt.nextOffset, "$.index.receipt.nextOffset");
  return receipt;
}

function findTargetEvent(records, idempotencyKey) {
  let found = null;
  for (const record of records) {
    if (record?.dispatch?.idempotencyKey !== idempotencyKey) continue;
    if (found)
      throw new Error(`duplicate durable dispatch event for ${idempotencyKey}`);
    found = record;
  }
  return found;
}

function assertReceiptMatchesRequest(receipt, request, requestDigest) {
  if (
    receipt.requestDigest !== requestDigest ||
    receipt.actorId !== request.actorId ||
    receipt.workspaceId !== request.workspaceId ||
    receipt.operation !== request.operation ||
    receipt.stream !== request.stream
  ) {
    throw new DispatchRefusalError(
      DISPATCH_REFUSAL_CODES.IDEMPOTENCY_CONFLICT,
      "idempotency key is already bound to a different request scope or payload",
      { requestDigest },
    );
  }
}

function assertMetadataMatchesRequest(metadata, request, requestDigest) {
  try {
    assertExactKeys(metadata, METADATA_KEYS, "$.event.dispatch");
  } catch (error) {
    throw new Error(`durable dispatch metadata is invalid: ${error.message}`);
  }
  if (
    metadata.schemaVersion !== DISPATCH_SCHEMA_VERSION ||
    metadata.requestDigest !== requestDigest ||
    metadata.actorId !== request.actorId ||
    metadata.workspaceId !== request.workspaceId ||
    metadata.operation !== request.operation ||
    metadata.stream !== request.stream ||
    metadata.idempotencyKey !== request.idempotencyKey
  ) {
    throw new DispatchRefusalError(
      DISPATCH_REFUSAL_CODES.IDEMPOTENCY_CONFLICT,
      "durable event is bound to a different request scope or payload",
      { requestDigest },
    );
  }
}

function attachMetadata(payload, metadata) {
  if (isPlainObject(payload)) return { ...payload, dispatch: metadata };
  return { dispatch: metadata, payload };
}

function mapAppendError(error, requestDigest) {
  if (error instanceof DispatchRefusalError) return error;
  if (error?.status === 403 || error?.code === "PRODUCER_FENCED") {
    return new DispatchRefusalError(
      DISPATCH_REFUSAL_CODES.PRODUCER_FENCED,
      "producer epoch or sequence was fenced by the Durable Streams provider",
      { requestDigest },
    );
  }
  if (error?.status === 409 || error?.code === "APPEND_CONFLICT") {
    return new DispatchRefusalError(
      DISPATCH_REFUSAL_CODES.STALE_FENCE,
      "expected stream head or producer sequence was no longer current",
      { requestDigest },
    );
  }
  return error;
}

function durabilityGap(requestDigest, detail) {
  return new DispatchRefusalError(
    DISPATCH_REFUSAL_CODES.DURABILITY_GAP,
    detail,
    { requestDigest, statusCode: 503 },
  );
}

function serialize(tails, key, operation) {
  const prior = tails.get(key) ?? Promise.resolve();
  const result = prior.then(operation, operation);
  const settled = result.then(
    (value) => {
      if (tails.get(key) === settled) tails.delete(key);
      return value;
    },
    (_error) => {
      if (tails.get(key) === settled) tails.delete(key);
      return undefined;
    },
  );
  tails.set(key, settled);
  return result;
}

function assertSafeString(value, path, maxLength) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    hasControlCharacter(value)
  ) {
    throw new Error(
      `${path} must be a non-empty bounded string without control characters`,
    );
  }
}

function hasControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

function assertOpaqueCheckpoint(value, path) {
  assertSafeString(value, path, OPAQUE_CHECKPOINT_MAX_BYTES);
  if (Buffer.byteLength(value, "utf8") > OPAQUE_CHECKPOINT_MAX_BYTES) {
    throw new Error(`${path} exceeds the opaque checkpoint byte limit`);
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  // canonicalJson has already rejected non-plain objects before this helper runs.
  return true;
}
