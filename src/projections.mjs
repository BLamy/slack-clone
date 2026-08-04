import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import {
  createInitialState,
  reduceEnvelope,
  canonicalStateDigest,
} from "@stream-slack/reducers";
import { validateWorkspaceId } from "@stream-slack/protocol";

import { canonicalJson, canonicalSha256 } from "./ledger/canonical-json.mjs";
import {
  digestEventEnvelope,
  validateEventEnvelope,
} from "./ledger/envelope.mjs";
import { parseStreamName } from "./ledger/topology.mjs";

export const PROJECTION_SCHEMA_VERSION = 1;
export const PROJECTION_REDUCER_VERSION = "stream-slack-reducer-v1";

export const PROJECTION_ROW_KINDS = Object.freeze([
  "workspace",
  "directory",
  "principal",
  "membership",
  "channel",
  "channelMembership",
  "message",
  "thread",
  "reaction",
  "unread",
]);

export const PROJECTION_ERROR_CODES = Object.freeze({
  ACCESS_DENIED: "PROJECTION_ACCESS_DENIED",
  CHECKPOINT_INVALID: "PROJECTION_CHECKPOINT_INVALID",
  CHECKPOINT_MISMATCH: "PROJECTION_CHECKPOINT_MISMATCH",
  CORRUPT_ROW: "PROJECTION_CORRUPT_ROW",
  CRASH_AFTER_ROW_WRITE: "PROJECTION_CRASH_AFTER_ROW_WRITE",
  DUPLICATE_SOURCE: "PROJECTION_DUPLICATE_SOURCE",
  INVALID_QUERY: "PROJECTION_INVALID_QUERY",
  INVALID_SOURCE: "PROJECTION_INVALID_SOURCE",
  NOT_READY: "PROJECTION_NOT_READY",
  REDUCER_VERSION_MISMATCH: "PROJECTION_REDUCER_VERSION_MISMATCH",
  SOURCE_ORDER: "PROJECTION_SOURCE_ORDER",
});

const OFFSET_PATTERN = /^[0-9a-f]{16}_[0-9a-f]{16}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ROW_ID_PATTERN = /^.{1,512}$/su;

export class ProjectionError extends Error {
  constructor(code, detail, metadata = {}) {
    super(`${code}: ${detail}`);
    this.name = "ProjectionError";
    this.code = code;
    this.detail = detail;
    Object.assign(this, metadata);
  }

  toJSON() {
    return {
      code: this.code,
      detail: this.detail,
      sequence: this.sequence ?? null,
      stream: this.stream ?? null,
      offset: this.offset ?? null,
    };
  }
}

export function createProjectionStore({
  directory = null,
  projectionId,
  workspaceId,
}) {
  validateWorkspaceId(workspaceId);
  validateProjectionId(projectionId, workspaceId);
  if (directory !== null && (typeof directory !== "string" || !directory)) {
    throw new TypeError("projection directory must be a non-empty string");
  }
  if (directory) mkdirSync(directory, { recursive: true });

  let rows = emptyRows();
  let checkpoint = null;
  let rowsSequence = 0;

  function readState() {
    if (!directory) return { checkpoint, rows, rowsSequence };
    const metadata = readProjectionFile(directory, "metadata.json");
    if (metadata) {
      if (
        metadata.projectionId !== projectionId ||
        metadata.reducerVersion !== PROJECTION_REDUCER_VERSION ||
        metadata.schemaVersion !== PROJECTION_SCHEMA_VERSION ||
        metadata.workspaceId !== workspaceId
      ) {
        throw projectionError(
          PROJECTION_ERROR_CODES.CHECKPOINT_INVALID,
          "projection storage metadata is bound to a different projection",
        );
      }
    }
    const persistedRows =
      readProjectionFile(directory, "rows.json") ?? emptyRows();
    const persistedCheckpoint =
      readProjectionFile(directory, "checkpoint.json") ?? null;
    validateRows(persistedRows, { workspaceId });
    if (persistedCheckpoint) {
      validateProjectionCheckpoint(persistedCheckpoint, {
        projectionId,
        workspaceId,
      });
    }
    return {
      checkpoint: persistedCheckpoint,
      rows: persistedRows,
      rowsSequence:
        metadata?.rowsSequence ?? persistedCheckpoint?.sequence ?? 0,
    };
  }

  function writeStateFile(name, value) {
    if (!directory) return;
    writeProjectionFile(directory, name, value);
  }

  function snapshot() {
    const current = readState();
    const value = {
      checkpoint: clone(current.checkpoint),
      projectionId,
      projectionDigest: current.checkpoint
        ? projectionDigest({
            checkpoint: current.checkpoint,
            projectionId,
            reducerVersion: PROJECTION_REDUCER_VERSION,
            rows: current.rows,
            schemaVersion: PROJECTION_SCHEMA_VERSION,
            workspaceId,
          })
        : null,
      reducerVersion: PROJECTION_REDUCER_VERSION,
      rows: clone(current.rows),
      rowsSequence: current.rowsSequence,
      schemaVersion: PROJECTION_SCHEMA_VERSION,
      workspaceId,
    };
    return clone(value);
  }

  return Object.freeze({
    deleteAll() {
      if (directory) {
        for (const name of ["checkpoint.json", "metadata.json", "rows.json"])
          rmSync(`${directory}/${name}`, { force: true });
      } else {
        rows = emptyRows();
        checkpoint = null;
        rowsSequence = 0;
      }
    },
    read() {
      return snapshot();
    },
    writeCheckpoint(nextCheckpoint) {
      validateProjectionCheckpoint(nextCheckpoint, {
        projectionId,
        workspaceId,
      });
      const current = readState();
      if (nextCheckpoint.sequence !== current.rowsSequence) {
        throw projectionError(
          PROJECTION_ERROR_CODES.CHECKPOINT_MISMATCH,
          "checkpoint sequence does not match the most recent row write",
          { sequence: nextCheckpoint.sequence },
        );
      }
      if (
        current.checkpoint &&
        nextCheckpoint.sequence < current.checkpoint.sequence
      ) {
        throw projectionError(
          PROJECTION_ERROR_CODES.CHECKPOINT_MISMATCH,
          "checkpoint sequence regressed",
          { sequence: nextCheckpoint.sequence },
        );
      }
      if (directory) writeStateFile("checkpoint.json", nextCheckpoint);
      else checkpoint = clone(nextCheckpoint);
    },
    writeRows(nextRows, sequence) {
      validateRows(nextRows, { workspaceId });
      if (!Number.isSafeInteger(sequence) || sequence < 0) {
        throw projectionError(
          PROJECTION_ERROR_CODES.CORRUPT_ROW,
          "row sequence must be a non-negative safe integer",
        );
      }
      const current = readState();
      if (current.checkpoint && sequence < current.checkpoint.sequence) {
        throw projectionError(
          PROJECTION_ERROR_CODES.CHECKPOINT_MISMATCH,
          "row write would move before the durable checkpoint",
          { sequence },
        );
      }
      if (directory) {
        writeStateFile("rows.json", nextRows);
        writeStateFile("metadata.json", {
          projectionId,
          reducerVersion: PROJECTION_REDUCER_VERSION,
          rowsSequence: sequence,
          schemaVersion: PROJECTION_SCHEMA_VERSION,
          workspaceId,
        });
      } else {
        rows = clone(nextRows);
        rowsSequence = sequence;
      }
    },
  });
}

export function createProjectionWorker({
  projectionId,
  reducerVersion = PROJECTION_REDUCER_VERSION,
  store,
  workspaceId,
}) {
  if (!store || typeof store.read !== "function") {
    throw new TypeError("projection worker requires a projection store");
  }
  validateWorkspaceId(workspaceId);
  validateProjectionId(projectionId, workspaceId);
  if (reducerVersion !== PROJECTION_REDUCER_VERSION) {
    throw projectionError(
      PROJECTION_ERROR_CODES.REDUCER_VERSION_MISMATCH,
      `unsupported reducer version ${String(reducerVersion)}`,
    );
  }

  function rebuild(records, options = {}) {
    if (typeof store.deleteAll !== "function") {
      throw new TypeError("projection store cannot be rebuilt");
    }
    store.deleteAll();
    return catchUp(records, options);
  }

  function catchUp(records, { crashAfterRowsAt = null } = {}) {
    const normalized = normalizeSourceRecords(records, workspaceId);
    const current = store.read();
    if (current.reducerVersion !== PROJECTION_REDUCER_VERSION) {
      throw projectionError(
        PROJECTION_ERROR_CODES.REDUCER_VERSION_MISMATCH,
        "stored projection was produced by a different reducer version",
      );
    }
    const startSequence = current.checkpoint?.sequence ?? 0;
    if (startSequence > normalized.length) {
      throw projectionError(
        PROJECTION_ERROR_CODES.CHECKPOINT_MISMATCH,
        "checkpoint is ahead of the supplied source history",
        { sequence: startSequence },
      );
    }

    const prefix = replayPrefix(normalized, startSequence);
    if (current.checkpoint) {
      assertCheckpointMatchesPrefix(current.checkpoint, prefix, {
        projectionId,
        sourceHeads: sourceHeadsForPrefix(normalized, startSequence),
        workspaceId,
      });
      if (current.rowsSequence < current.checkpoint.sequence) {
        throw projectionError(
          PROJECTION_ERROR_CODES.CHECKPOINT_MISMATCH,
          "query rows are behind their durable checkpoint",
          { sequence: current.checkpoint.sequence },
        );
      }
    }

    let state = prefix.state;
    const sourceByRow = prefix.sourceByRow;
    let sourceHeads = sourceHeadsForPrefix(normalized, startSequence);
    for (let index = startSequence; index < normalized.length; index += 1) {
      const record = normalized[index];
      const sequence = index + 1;
      const replayOffset = projectionOffset(sequence);
      state = reduceEnvelope(state, record.event, { offset: replayOffset });
      markAffectedRows(sourceByRow, record, sequence);
      sourceHeads = updateSourceHead(sourceHeads, record);
      const stateDigest = canonicalStateDigest(state);
      const checkpoint = createProjectionCheckpoint({
        projectionId,
        reducerVersion,
        sequence,
        sourceHeads,
        stateDigest,
        workspaceId,
      });
      const nextRows = materializeRows({
        checkpoint,
        currentSource: sourceEntry(record, sequence),
        sourceByRow,
        state,
        workspaceId,
      });
      store.writeRows(nextRows, sequence);
      if (crashAfterRowsAt === sequence) {
        throw projectionError(
          PROJECTION_ERROR_CODES.CRASH_AFTER_ROW_WRITE,
          "injected crash after row write and before checkpoint persistence",
          { sequence },
        );
      }
      store.writeCheckpoint(checkpoint);
    }
    return store.read();
  }

  return Object.freeze({ catchUp, rebuild });
}

export function createProjectionQueries(store) {
  if (!store || typeof store.read !== "function") {
    throw new TypeError("projection queries require a projection store");
  }

  function readySnapshot() {
    const snapshot = store.read();
    if (
      !snapshot.checkpoint ||
      snapshot.rowsSequence !== snapshot.checkpoint.sequence
    ) {
      throw projectionError(
        PROJECTION_ERROR_CODES.NOT_READY,
        "projection has no committed checkpoint",
      );
    }
    return snapshot;
  }

  function listChannels({ principalId, workspaceId }) {
    const snapshot = readySnapshot();
    assertWorkspaceMember(snapshot, workspaceId, principalId);
    const memberships = rowValues(snapshot, "channelMembership");
    return rowValues(snapshot, "channel")
      .filter((row) => row.value.status === "active")
      .filter(
        (row) =>
          row.value.kind === "public" ||
          activeChannelMembership(
            memberships,
            row.value.channelId,
            principalId,
          ),
      )
      .sort(compareRows)
      .map(publicRow);
  }

  function countChannels(args) {
    return listChannels(args).length;
  }

  function getChannel({ channelId, principalId, workspaceId }) {
    const snapshot = readySnapshot();
    assertChannelMember(snapshot, workspaceId, channelId, principalId);
    return publicRow(findRow(snapshot, "channel", channelId));
  }

  function listMessages({
    after = null,
    channelId,
    limit = 100,
    principalId,
    workspaceId,
  }) {
    const snapshot = readySnapshot();
    assertChannelMember(snapshot, workspaceId, channelId, principalId);
    const boundedLimit = queryLimit(limit);
    const messages = rowValues(snapshot, "message")
      .filter(
        (row) =>
          row.value.channelId === channelId && row.value.status === "active",
      )
      .sort(compareRows);
    const start = after === null ? 0 : cursorIndex(messages, after);
    const page = messages.slice(start, start + boundedLimit).map(publicRow);
    return {
      checkpoint: snapshot.checkpoint,
      messages: page,
      nextCursor:
        start + boundedLimit < messages.length
          ? (page.at(-1)?.source.offset ?? null)
          : null,
      projectionDigest: snapshot.projectionDigest,
    };
  }

  function listThreads({ channelId, principalId, workspaceId }) {
    const snapshot = readySnapshot();
    assertChannelMember(snapshot, workspaceId, channelId, principalId);
    const activeMessageIds = new Set(
      rowValues(snapshot, "message")
        .filter(
          (row) =>
            row.value.channelId === channelId && row.value.status === "active",
        )
        .map((row) => row.id),
    );
    return rowValues(snapshot, "thread")
      .filter(
        (row) =>
          row.value.channelId === channelId &&
          row.value.messageIds.some((messageId) =>
            activeMessageIds.has(messageId),
          ),
      )
      .sort(compareRows)
      .map(publicRow);
  }

  function listReactions({ messageId, principalId, workspaceId }) {
    const snapshot = readySnapshot();
    const message = findRow(snapshot, "message", messageId);
    assertChannelMember(
      snapshot,
      workspaceId,
      message?.value.channelId ?? null,
      principalId,
    );
    return rowValues(snapshot, "reaction")
      .filter(
        (row) =>
          row.value.messageId === messageId && row.value.status === "active",
      )
      .sort(compareRows)
      .map(publicRow);
  }

  function getUnread({ channelId, principalId, workspaceId }) {
    const snapshot = readySnapshot();
    assertChannelMember(snapshot, workspaceId, channelId, principalId);
    const row = rowValues(snapshot, "unread").find(
      (candidate) =>
        candidate.value.channelId === channelId &&
        candidate.value.principalId === principalId,
    );
    return row ? publicRow(row) : null;
  }

  return Object.freeze({
    countChannels,
    getChannel,
    getUnread,
    listChannels,
    listMessages,
    listReactions,
    listThreads,
  });
}

export function normalizeSourceRecords(records, workspaceId) {
  validateWorkspaceId(workspaceId);
  if (!Array.isArray(records)) {
    throw projectionError(
      PROJECTION_ERROR_CODES.INVALID_SOURCE,
      "source history must be an array",
    );
  }

  const bySource = new Map();
  const eventIds = new Map();
  const lastOffsets = new Map();
  const normalized = [];
  for (const [index, record] of records.entries()) {
    const stream = record?.stream;
    const offset = record?.offset;
    const event = record?.event ?? record?.envelope;
    if (typeof stream !== "string" || !OFFSET_PATTERN.test(String(offset))) {
      throw projectionError(
        PROJECTION_ERROR_CODES.INVALID_SOURCE,
        `source record ${index} has an invalid stream or offset`,
        { offset: String(offset), stream: String(stream) },
      );
    }
    try {
      parseStreamName(stream, { expectedWorkspaceId: workspaceId });
      validateEventEnvelope(event);
    } catch (error) {
      throw projectionError(
        PROJECTION_ERROR_CODES.INVALID_SOURCE,
        `source record ${index} is not a valid workspace event: ${error instanceof Error ? error.message : String(error)}`,
        { offset, stream },
      );
    }
    if (event.workspaceId !== workspaceId) {
      throw projectionError(
        PROJECTION_ERROR_CODES.INVALID_SOURCE,
        "source event belongs to a different workspace",
        { offset, stream },
      );
    }
    const digest = digestEventEnvelope(event);
    const sourceKey = `${stream}\u0000${offset}`;
    const existing = bySource.get(sourceKey);
    if (existing) {
      if (
        existing.digest !== digest ||
        existing.event.eventId !== event.eventId
      ) {
        throw projectionError(
          PROJECTION_ERROR_CODES.DUPLICATE_SOURCE,
          "same source checkpoint delivered with different event bytes",
          { offset, stream },
        );
      }
      continue;
    }
    const existingEvent = eventIds.get(event.eventId);
    if (existingEvent && existingEvent.sourceKey !== sourceKey) {
      throw projectionError(
        PROJECTION_ERROR_CODES.DUPLICATE_SOURCE,
        "event ID was delivered at two different source checkpoints",
        { offset, stream },
      );
    }
    const previousOffset = lastOffsets.get(stream);
    if (
      previousOffset !== undefined &&
      compareOffsets(offset, previousOffset) < 0
    ) {
      throw projectionError(
        PROJECTION_ERROR_CODES.SOURCE_ORDER,
        "source offsets must be non-decreasing within each stream",
        { offset, stream },
      );
    }
    const normalizedRecord = {
      digest,
      event: clone(event),
      offset,
      stream,
    };
    bySource.set(sourceKey, normalizedRecord);
    eventIds.set(event.eventId, { sourceKey });
    lastOffsets.set(stream, offset);
    normalized.push(normalizedRecord);
  }
  return normalized;
}

export function replayProjectionPrefixes(
  records,
  workspaceId,
  projectionId = null,
) {
  const normalized = normalizeSourceRecords(records, workspaceId);
  const prefixes = [];
  for (let sequence = 1; sequence <= normalized.length; sequence += 1) {
    const prefix = replayPrefix(normalized, sequence);
    const checkpoint = createProjectionCheckpoint({
      projectionId,
      reducerVersion: PROJECTION_REDUCER_VERSION,
      sequence,
      sourceHeads: sourceHeadsForPrefix(normalized, sequence),
      stateDigest: canonicalStateDigest(prefix.state),
      workspaceId,
    });
    const rows = materializeRows({
      checkpoint,
      currentSource: sourceEntry(normalized[sequence - 1], sequence),
      sourceByRow: prefix.sourceByRow,
      state: prefix.state,
      workspaceId,
    });
    prefixes.push({
      checkpoint,
      projectionDigest: projectionDigest({
        checkpoint,
        projectionId,
        reducerVersion: PROJECTION_REDUCER_VERSION,
        rows,
        schemaVersion: PROJECTION_SCHEMA_VERSION,
        workspaceId,
      }),
      rows,
      sequence,
      stateDigest: checkpoint.stateDigest,
    });
  }
  return prefixes;
}

export function assertProjectionIntegrity(
  store,
  records,
  { projectionId, workspaceId } = {},
) {
  const snapshot = store.read();
  const expectedProjectionId = projectionId ?? snapshot.projectionId;
  const expectedWorkspaceId = workspaceId ?? snapshot.workspaceId;
  validateWorkspaceId(expectedWorkspaceId);
  validateProjectionId(expectedProjectionId, expectedWorkspaceId);
  const normalized = normalizeSourceRecords(records, expectedWorkspaceId);
  if (!snapshot.checkpoint) {
    throw projectionError(
      PROJECTION_ERROR_CODES.NOT_READY,
      "projection has no checkpoint",
    );
  }
  validateProjectionCheckpoint(snapshot.checkpoint, {
    projectionId: expectedProjectionId,
    workspaceId: expectedWorkspaceId,
  });
  if (snapshot.rowsSequence !== snapshot.checkpoint.sequence) {
    throw projectionError(
      PROJECTION_ERROR_CODES.NOT_READY,
      "projection rows and checkpoint are not at the same sequence",
    );
  }
  const prefix = replayPrefix(normalized, snapshot.checkpoint.sequence);
  assertCheckpointMatchesPrefix(snapshot.checkpoint, prefix, {
    projectionId: expectedProjectionId,
    sourceHeads: sourceHeadsForPrefix(normalized, snapshot.checkpoint.sequence),
    workspaceId: expectedWorkspaceId,
  });
  assertRowProvenance(snapshot.rows, normalized, {
    checkpointDigest: snapshot.checkpoint.checkpointDigest,
    workspaceId: expectedWorkspaceId,
  });
  const expectedRows = materializeRows({
    checkpoint: snapshot.checkpoint,
    currentSource: normalized.at(snapshot.checkpoint.sequence - 1)
      ? sourceEntry(
          normalized.at(snapshot.checkpoint.sequence - 1),
          snapshot.checkpoint.sequence,
        )
      : null,
    sourceByRow: prefix.sourceByRow,
    state: prefix.state,
    workspaceId: expectedWorkspaceId,
  });
  const expectedManifest = projectionManifest({
    checkpoint: snapshot.checkpoint,
    projectionId: expectedProjectionId,
    reducerVersion: PROJECTION_REDUCER_VERSION,
    rows: expectedRows,
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    workspaceId: expectedWorkspaceId,
  });
  const actualManifest = projectionManifest({
    checkpoint: snapshot.checkpoint,
    projectionId: expectedProjectionId,
    reducerVersion: snapshot.reducerVersion,
    rows: snapshot.rows,
    schemaVersion: snapshot.schemaVersion,
    workspaceId: snapshot.workspaceId,
  });
  if (canonicalJson(actualManifest) !== canonicalJson(expectedManifest)) {
    throw projectionError(
      PROJECTION_ERROR_CODES.CORRUPT_ROW,
      "projection row manifest differs from independent source replay",
    );
  }
  return {
    checkpoint: clone(snapshot.checkpoint),
    projectionDigest: projectionDigest(actualManifest),
    rowCount: allRows(snapshot.rows).length,
    stateDigest: snapshot.checkpoint.stateDigest,
  };
}

function assertRowProvenance(
  rows,
  normalized,
  { checkpointDigest, workspaceId },
) {
  const sourceIndex = new Map(
    normalized.map((record) => [
      `${record.stream}\u0000${record.offset}`,
      record,
    ]),
  );
  for (const row of allRows(rows)) {
    if (row.workspaceId !== workspaceId) {
      throw projectionError(
        PROJECTION_ERROR_CODES.CORRUPT_ROW,
        `row ${row.kind}:${row.id} has the wrong workspace scope`,
      );
    }
    if (row.reducerVersion !== PROJECTION_REDUCER_VERSION) {
      throw projectionError(
        PROJECTION_ERROR_CODES.REDUCER_VERSION_MISMATCH,
        `row ${row.kind}:${row.id} has an unsupported reducer version`,
      );
    }
    if (row.checkpointDigest !== checkpointDigest) {
      throw projectionError(
        PROJECTION_ERROR_CODES.CORRUPT_ROW,
        `row ${row.kind}:${row.id} has a stale projection checkpoint`,
      );
    }
    const source = sourceIndex.get(
      `${row.source?.stream}\u0000${row.source?.offset}`,
    );
    if (!source || source.digest !== row.source?.digest) {
      throw projectionError(
        PROJECTION_ERROR_CODES.CORRUPT_ROW,
        `row ${row.kind}:${row.id} has an unknown source reference`,
        { stream: row.source?.stream, offset: row.source?.offset },
      );
    }
  }
}

export function projectionManifest(value) {
  return {
    checkpoint: clone(value.checkpoint),
    projectionId: value.projectionId,
    reducerVersion: value.reducerVersion,
    rows: clone(value.rows),
    schemaVersion: value.schemaVersion,
    workspaceId: value.workspaceId,
  };
}

export function projectionDigest(value) {
  return canonicalSha256(projectionManifest(value));
}

export function createProjectionCheckpoint({
  projectionId,
  reducerVersion,
  sequence,
  sourceHeads,
  stateDigest,
  workspaceId,
}) {
  validateWorkspaceId(workspaceId);
  if (projectionId !== null) validateProjectionId(projectionId, workspaceId);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw projectionError(
      PROJECTION_ERROR_CODES.CHECKPOINT_INVALID,
      "checkpoint sequence must be a non-negative safe integer",
    );
  }
  if (reducerVersion !== PROJECTION_REDUCER_VERSION) {
    throw projectionError(
      PROJECTION_ERROR_CODES.REDUCER_VERSION_MISMATCH,
      "checkpoint reducer version is unsupported",
    );
  }
  if (!DIGEST_PATTERN.test(stateDigest)) {
    throw projectionError(
      PROJECTION_ERROR_CODES.CHECKPOINT_INVALID,
      "checkpoint state digest must be sha256",
    );
  }
  const normalizedHeads = normalizeSourceHeads(sourceHeads, workspaceId);
  const body = {
    projectionId,
    reducerVersion,
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    sequence,
    sourceHeads: normalizedHeads,
    stateDigest,
    workspaceId,
  };
  return {
    ...body,
    checkpointDigest: canonicalSha256(body),
  };
}

export function validateProjectionCheckpoint(
  value,
  { projectionId, workspaceId } = {},
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw projectionError(
      PROJECTION_ERROR_CODES.CHECKPOINT_INVALID,
      "checkpoint must be an object",
    );
  }
  const keys = Object.keys(value).sort();
  const expected = [
    "checkpointDigest",
    "projectionId",
    "reducerVersion",
    "schemaVersion",
    "sequence",
    "sourceHeads",
    "stateDigest",
    "workspaceId",
  ].sort();
  if (canonicalJson(keys) !== canonicalJson(expected)) {
    throw projectionError(
      PROJECTION_ERROR_CODES.CHECKPOINT_INVALID,
      "checkpoint keys are not canonical",
    );
  }
  validateWorkspaceId(value.workspaceId);
  if (workspaceId !== undefined && value.workspaceId !== workspaceId) {
    throw projectionError(
      PROJECTION_ERROR_CODES.CHECKPOINT_INVALID,
      "checkpoint belongs to a different workspace",
    );
  }
  if (projectionId !== undefined && value.projectionId !== projectionId) {
    throw projectionError(
      PROJECTION_ERROR_CODES.CHECKPOINT_INVALID,
      "checkpoint belongs to a different projection",
    );
  }
  const expectedCheckpoint = createProjectionCheckpoint({
    projectionId: value.projectionId,
    reducerVersion: value.reducerVersion,
    sequence: value.sequence,
    sourceHeads: value.sourceHeads,
    stateDigest: value.stateDigest,
    workspaceId: value.workspaceId,
  });
  if (value.checkpointDigest !== expectedCheckpoint.checkpointDigest) {
    throw projectionError(
      PROJECTION_ERROR_CODES.CHECKPOINT_INVALID,
      "checkpoint digest does not match its source heads and state digest",
    );
  }
  return value;
}

function replayPrefix(records, sequence) {
  let state = createInitialState();
  const sourceByRow = new Map();
  for (let index = 0; index < sequence; index += 1) {
    const record = records[index];
    state = reduceEnvelope(state, record.event, {
      offset: projectionOffset(index + 1),
    });
    markAffectedRows(sourceByRow, record, index + 1);
  }
  return { sourceByRow, state };
}

function assertCheckpointMatchesPrefix(
  checkpoint,
  prefix,
  { projectionId, sourceHeads, workspaceId },
) {
  const expectedStateDigest = canonicalStateDigest(prefix.state);
  if (checkpoint.stateDigest !== expectedStateDigest) {
    throw projectionError(
      PROJECTION_ERROR_CODES.CHECKPOINT_MISMATCH,
      "checkpoint state digest does not match source replay",
      { sequence: checkpoint.sequence },
    );
  }
  const expectedHeads = sourceHeads ?? [];
  if (canonicalJson(checkpoint.sourceHeads) !== canonicalJson(expectedHeads)) {
    throw projectionError(
      PROJECTION_ERROR_CODES.CHECKPOINT_MISMATCH,
      "checkpoint source heads do not match source replay",
      { sequence: checkpoint.sequence },
    );
  }
  validateProjectionCheckpoint(checkpoint, { projectionId, workspaceId });
}

function sourceHeadsForPrefix(records, sequence) {
  const heads = new Map();
  for (let index = 0; index < sequence; index += 1) {
    const record = records[index];
    heads.set(record.stream, record);
  }
  return normalizeSourceHeads(
    [...heads.values()].map(({ digest, offset, stream }) => ({
      digest,
      offset,
      stream,
    })),
    records[0]?.event.workspaceId ?? records[0]?.workspaceId,
  );
}

function updateSourceHead(heads, record) {
  const next = heads.filter((head) => head.stream !== record.stream);
  next.push({
    digest: record.digest,
    offset: record.offset,
    stream: record.stream,
  });
  return next.sort((left, right) => left.stream.localeCompare(right.stream));
}

function normalizeSourceHeads(value, workspaceId) {
  if (!Array.isArray(value)) {
    throw projectionError(
      PROJECTION_ERROR_CODES.CHECKPOINT_INVALID,
      "source heads must be an array",
    );
  }
  const seen = new Set();
  const normalized = value.map((head) => {
    if (!head || typeof head !== "object") {
      throw projectionError(
        PROJECTION_ERROR_CODES.CHECKPOINT_INVALID,
        "source head must be an object",
      );
    }
    const keys = Object.keys(head).sort();
    if (canonicalJson(keys) !== canonicalJson(["digest", "offset", "stream"])) {
      throw projectionError(
        PROJECTION_ERROR_CODES.CHECKPOINT_INVALID,
        "source head keys are not canonical",
      );
    }
    if (
      !OFFSET_PATTERN.test(head.offset) ||
      !DIGEST_PATTERN.test(head.digest)
    ) {
      throw projectionError(
        PROJECTION_ERROR_CODES.CHECKPOINT_INVALID,
        "source head digest or offset is malformed",
      );
    }
    try {
      parseStreamName(head.stream, { expectedWorkspaceId: workspaceId });
    } catch {
      throw projectionError(
        PROJECTION_ERROR_CODES.CHECKPOINT_INVALID,
        "source head belongs to a different or malformed stream",
      );
    }
    if (seen.has(head.stream)) {
      throw projectionError(
        PROJECTION_ERROR_CODES.CHECKPOINT_INVALID,
        "checkpoint contains duplicate source streams",
      );
    }
    seen.add(head.stream);
    return { digest: head.digest, offset: head.offset, stream: head.stream };
  });
  normalized.sort((left, right) => left.stream.localeCompare(right.stream));
  return normalized;
}

function materializeRows({
  checkpoint,
  currentSource,
  sourceByRow,
  state,
  workspaceId,
}) {
  const rows = emptyRows();
  addMapRows(
    rows,
    "workspace",
    state.entities.workspaces,
    sourceByRow,
    currentSource,
    workspaceId,
    checkpoint,
  );
  addMapRows(
    rows,
    "directory",
    state.entities.directory,
    sourceByRow,
    currentSource,
    workspaceId,
    checkpoint,
  );
  addMapRows(
    rows,
    "principal",
    state.entities.principals,
    sourceByRow,
    currentSource,
    workspaceId,
    checkpoint,
  );
  addMapRows(
    rows,
    "membership",
    state.entities.memberships,
    sourceByRow,
    currentSource,
    workspaceId,
    checkpoint,
  );
  addMapRows(
    rows,
    "channel",
    state.entities.channels,
    sourceByRow,
    currentSource,
    workspaceId,
    checkpoint,
  );
  addMapRows(
    rows,
    "channelMembership",
    state.entities.channelMemberships,
    sourceByRow,
    currentSource,
    workspaceId,
    checkpoint,
  );
  addMapRows(
    rows,
    "message",
    state.entities.messages,
    sourceByRow,
    currentSource,
    workspaceId,
    checkpoint,
  );
  addMapRows(
    rows,
    "reaction",
    state.entities.reactions,
    sourceByRow,
    currentSource,
    workspaceId,
    checkpoint,
  );

  const messages = Object.values(state.entities.messages ?? {});
  const threads = new Map();
  for (const message of messages) {
    const rootMessageId = message.rootMessageId ?? message.messageId;
    if (!threads.has(rootMessageId)) {
      threads.set(rootMessageId, {
        channelId: message.channelId,
        messageIds: [],
        rootMessageId,
      });
    }
    threads.get(rootMessageId).messageIds.push(message.messageId);
  }
  for (const thread of threads.values()) {
    thread.messageIds.sort();
    const source =
      thread.messageIds
        .map((messageId) => sourceByRow.get(`message:${messageId}`))
        .filter(Boolean)
        .sort((left, right) => left.sequence - right.sequence)
        .at(-1) ?? currentSource;
    addRow(
      rows,
      "thread",
      thread.rootMessageId,
      thread,
      source,
      workspaceId,
      checkpoint,
    );
  }

  const memberships = Object.values(state.entities.memberships ?? {}).filter(
    (membership) =>
      membership.workspaceId === workspaceId && membership.status === "active",
  );
  const channels = Object.values(state.entities.channels ?? {}).filter(
    (channel) =>
      channel.workspaceId === workspaceId && channel.status === "active",
  );
  for (const membership of memberships) {
    for (const channel of channels) {
      const channelMembership =
        state.entities.channelMemberships?.[
          `${channel.channelId}\u0000${membership.principalId}`
        ];
      if (channel.kind !== "public" && channelMembership?.status !== "active")
        continue;
      const unreadMessages = messages.filter(
        (message) =>
          message.channelId === channel.channelId &&
          message.status !== "deleted" &&
          message.authorId !== membership.principalId,
      );
      const source =
        unreadMessages
          .map((message) => sourceByRow.get(`message:${message.messageId}`))
          .filter(Boolean)
          .sort((left, right) => left.sequence - right.sequence)
          .at(-1) ??
        sourceByRow.get(`channel:${channel.channelId}`) ??
        currentSource;
      addRow(
        rows,
        "unread",
        `${channel.channelId}\u0000${membership.principalId}`,
        {
          channelId: channel.channelId,
          count: unreadMessages.length,
          principalId: membership.principalId,
        },
        source,
        workspaceId,
        checkpoint,
      );
    }
  }

  for (const kind of PROJECTION_ROW_KINDS) {
    rows[kind].sort(compareRows);
  }
  return rows;
}

function addMapRows(
  rows,
  kind,
  values,
  sourceByRow,
  currentSource,
  workspaceId,
  checkpoint,
) {
  for (const [id, value] of Object.entries(values ?? {})) {
    if (value?.workspaceId !== undefined && value.workspaceId !== workspaceId)
      continue;
    addRow(
      rows,
      kind,
      id,
      value,
      sourceByRow.get(`${kind}:${id}`) ?? currentSource,
      workspaceId,
      checkpoint,
    );
  }
}

function addRow(rows, kind, id, value, source, workspaceId, checkpoint) {
  if (!ROW_ID_PATTERN.test(String(id)) || !source) return;
  rows[kind].push({
    checkpointDigest: checkpoint?.checkpointDigest ?? null,
    id,
    kind,
    reducerVersion: PROJECTION_REDUCER_VERSION,
    source: {
      digest: source.digest,
      offset: source.offset,
      stream: source.stream,
    },
    value: clone(value),
    workspaceId,
  });
}

function markAffectedRows(sourceByRow, record, sequence) {
  const source = sourceEntry(record, sequence);
  for (const key of affectedRowKeys(record.event)) sourceByRow.set(key, source);
}

function affectedRowKeys(event) {
  const data = event.data ?? {};
  const keys = [];
  const push = (kind, id) => {
    if (id !== undefined && id !== null) keys.push(`${kind}:${id}`);
  };
  switch (event.eventType) {
    case "principal.created":
    case "principal.profile.updated":
    case "principal.suspended":
    case "principal.deactivated":
      push("principal", data.principalId);
      break;
    case "workspace.created":
      push("workspace", data.workspaceId);
      push("membership", membershipIdForPrincipal(data.ownerPrincipalId));
      break;
    case "workspace.directory.updated":
      push("directory", data.id);
      break;
    case "workspace.membership.invited":
      push("workspace", event.workspaceId);
      push("membership", membershipIdForPrincipal(data.principalId));
      break;
    case "workspace.membership.accepted":
    case "workspace.membership.role.changed":
    case "workspace.membership.suspended":
    case "workspace.membership.removed":
      push("workspace", event.workspaceId);
      push(
        "membership",
        data.membershipId ?? membershipIdForPrincipal(data.principalId),
      );
      break;
    case "channel.created":
    case "channel.direct.created":
      push("channel", data.channelId);
      for (const principalId of data.participantIds ?? [data.creatorId]) {
        push("channelMembership", `${data.channelId}\u0000${principalId}`);
      }
      break;
    case "channel.renamed":
    case "channel.archived":
    case "channel.unarchived":
      push("channel", data.channelId);
      break;
    case "channel.membership.invited":
    case "channel.membership.joined":
    case "channel.membership.left":
    case "channel.membership.removed":
      push("channel", data.channelId);
      push("channelMembership", `${data.channelId}\u0000${data.principalId}`);
      break;
    case "channel.message.created":
    case "channel.message.replied":
    case "channel.message.edited":
    case "channel.message.deleted":
      push("message", data.messageId);
      push("thread", data.rootMessageId ?? data.messageId);
      break;
    case "channel.message.reaction.added":
    case "channel.message.reaction.removed":
      push(
        "reaction",
        `${data.messageId}\u0000${event.actorId}\u0000${data.emoji}`,
      );
      break;
    default:
      break;
  }
  return keys;
}

function sourceEntry(record, sequence) {
  return {
    digest: record.digest,
    offset: record.offset,
    sequence,
    stream: record.stream,
  };
}

function validateRows(rows, { workspaceId }) {
  if (!rows || typeof rows !== "object") {
    throw projectionError(
      PROJECTION_ERROR_CODES.CORRUPT_ROW,
      "rows must be an object",
    );
  }
  for (const kind of PROJECTION_ROW_KINDS) {
    if (!Array.isArray(rows[kind])) {
      throw projectionError(
        PROJECTION_ERROR_CODES.CORRUPT_ROW,
        `rows.${kind} must be an array`,
      );
    }
    const ids = new Set();
    for (const row of rows[kind]) {
      if (!row || row.kind !== kind || ids.has(row.id)) {
        throw projectionError(
          PROJECTION_ERROR_CODES.CORRUPT_ROW,
          `rows.${kind} contains a duplicate or malformed row`,
        );
      }
      ids.add(row.id);
      if (
        row.workspaceId !== workspaceId ||
        row.reducerVersion !== PROJECTION_REDUCER_VERSION
      ) {
        throw projectionError(
          PROJECTION_ERROR_CODES.CORRUPT_ROW,
          `row ${kind}:${row.id} has invalid scope or reducer version`,
        );
      }
      if (
        !row.source ||
        !OFFSET_PATTERN.test(row.source.offset) ||
        !DIGEST_PATTERN.test(row.source.digest)
      ) {
        throw projectionError(
          PROJECTION_ERROR_CODES.CORRUPT_ROW,
          `row ${kind}:${row.id} has invalid source provenance`,
        );
      }
    }
  }
}

function assertWorkspaceMember(snapshot, workspaceId, principalId) {
  if (workspaceId !== snapshot.workspaceId || typeof principalId !== "string") {
    throw accessDenied();
  }
  const membership = rowValues(snapshot, "membership").find(
    (row) =>
      row.value.workspaceId === workspaceId &&
      row.value.principalId === principalId &&
      row.value.status === "active",
  );
  if (!membership) throw accessDenied();
  return membership;
}

function assertChannelMember(snapshot, workspaceId, channelId, principalId) {
  const workspaceMembership = assertWorkspaceMember(
    snapshot,
    workspaceId,
    principalId,
  );
  const channel = findRow(snapshot, "channel", channelId);
  if (
    !channel ||
    channel.value.workspaceId !== workspaceId ||
    channel.value.status !== "active"
  ) {
    throw accessDenied();
  }
  if (channel.value.kind === "public") return { channel, workspaceMembership };
  const membership = rowValues(snapshot, "channelMembership").find(
    (row) =>
      row.value.channelId === channelId &&
      row.value.principalId === principalId &&
      row.value.status === "active",
  );
  if (!membership) throw accessDenied();
  return { channel, membership, workspaceMembership };
}

function activeChannelMembership(rows, channelId, principalId) {
  return rows.some(
    (row) =>
      row.value.channelId === channelId &&
      row.value.principalId === principalId &&
      row.value.status === "active",
  );
}

function findRow(snapshot, kind, id) {
  return rowValues(snapshot, kind).find((row) => row.id === id) ?? null;
}

function rowValues(snapshot, kind) {
  return snapshot.rows[kind] ?? [];
}

function publicRow(row) {
  if (!row) throw accessDenied();
  return clone(row);
}

function cursorIndex(rows, cursor) {
  if (typeof cursor !== "string") throw invalidQuery("cursor must be a string");
  const index = rows.findIndex((row) => row.source.offset === cursor);
  if (index === -1)
    throw invalidQuery("cursor is not present in this projection");
  return index + 1;
}

function queryLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) {
    throw invalidQuery("limit must be an integer from 1 to 200");
  }
  return value;
}

function compareRows(left, right) {
  const offsetOrder = compareOffsets(left.source.offset, right.source.offset);
  return offsetOrder || left.id.localeCompare(right.id);
}

function compareOffsets(left, right) {
  const [leftHigh, leftLow] = left
    .split("_")
    .map((part) => BigInt(`0x${part}`));
  const [rightHigh, rightLow] = right
    .split("_")
    .map((part) => BigInt(`0x${part}`));
  return leftHigh < rightHigh || (leftHigh === rightHigh && leftLow < rightLow)
    ? -1
    : leftHigh > rightHigh || (leftHigh === rightHigh && leftLow > rightLow)
      ? 1
      : 0;
}

function projectionOffset(sequence) {
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    sequence > Number.MAX_SAFE_INTEGER
  ) {
    throw projectionError(
      PROJECTION_ERROR_CODES.INVALID_SOURCE,
      "projection sequence exceeds offset capacity",
    );
  }
  return `0000000000000000_${sequence.toString(16).padStart(16, "0")}`;
}

function validateProjectionId(value, workspaceId) {
  try {
    const stream = `projection:${value}`;
    parseStreamName(stream, { expectedWorkspaceId: workspaceId });
  } catch {
    throw projectionError(
      PROJECTION_ERROR_CODES.INVALID_QUERY,
      "projection id is not a workspace-scoped projection identifier",
    );
  }
}

function membershipIdForPrincipal(principalId) {
  return `mb_${principalId.slice(3)}`;
}

function emptyRows() {
  return Object.fromEntries(PROJECTION_ROW_KINDS.map((kind) => [kind, []]));
}

function allRows(rows) {
  return PROJECTION_ROW_KINDS.flatMap((kind) => rows[kind] ?? []);
}

function accessDenied() {
  return projectionError(
    PROJECTION_ERROR_CODES.ACCESS_DENIED,
    "projection row is not available",
  );
}

function invalidQuery(detail) {
  return projectionError(PROJECTION_ERROR_CODES.INVALID_QUERY, detail);
}

function projectionError(code, detail, metadata) {
  return new ProjectionError(code, detail, metadata);
}

function readProjectionFile(directory, name) {
  const filePath = `${directory}/${name}`;
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw projectionError(
      PROJECTION_ERROR_CODES.CHECKPOINT_INVALID,
      `projection storage file ${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function writeProjectionFile(directory, name, value) {
  const filePath = `${directory}/${name}`;
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`);
  renameSync(temporaryPath, filePath);
}

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}
