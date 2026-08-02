import {
  REDUCER_ERROR_CODES,
  ReducerError,
  replayRecords,
} from "@stream-slack/reducers";

import { validateEventEnvelope } from "./envelope.mjs";

export const REPLAY_ERROR_CODES = Object.freeze({
  INVALID_DUMP: "REPLAY_INVALID_DUMP",
  INVALID_ENVELOPE: "REPLAY_INVALID_ENVELOPE",
});

export class ReplayError extends Error {
  constructor(code, detail, { offset = null, path = "$" } = {}) {
    super(`${code} at ${offset ?? "<unknown-offset>"} ${path}: ${detail}`);
    this.name = "ReplayError";
    this.code = code;
    this.detail = detail;
    this.offset = offset;
    this.path = path;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      detail: this.detail,
      offset: this.offset,
      path: this.path,
    };
  }
}

export function validateAndReplayDump(value) {
  const records = normalizeDump(value);
  return replayRecords(records);
}

export function normalizeDump(value) {
  const records = Array.isArray(value) ? value : value?.records;
  if (!Array.isArray(records)) {
    throw new ReplayError(
      REPLAY_ERROR_CODES.INVALID_DUMP,
      "dump must be an array or an object with a records array",
      { path: "$.records" },
    );
  }

  return records.map((record, index) => {
    const offset = Array.isArray(value) ? `index:${index}` : record?.offset;
    if (typeof offset !== "string" || offset.length === 0) {
      throw new ReplayError(
        REPLAY_ERROR_CODES.INVALID_DUMP,
        "record offset must be a non-empty string",
        { offset: String(offset), path: `$.records[${index}].offset` },
      );
    }
    const envelope = Array.isArray(value)
      ? record
      : (record?.event ?? record?.envelope);
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      throw new ReplayError(
        REPLAY_ERROR_CODES.INVALID_DUMP,
        "record must contain an event envelope",
        { offset, path: `$.records[${index}].event` },
      );
    }
    try {
      validateEventEnvelope(envelope);
    } catch (error) {
      throw new ReplayError(
        REPLAY_ERROR_CODES.INVALID_ENVELOPE,
        error instanceof Error ? error.message : String(error),
        { offset, path: `$.records[${index}].event` },
      );
    }
    return { event: envelope, offset };
  });
}

export function isReplayFailure(error) {
  return error instanceof ReplayError || error instanceof ReducerError;
}

export { REDUCER_ERROR_CODES };
