import { TextDecoder } from "node:util";

import { canonicalJson, canonicalSha256 } from "./canonical-json.mjs";
import {
  assertExactKeys,
  LEDGER_ERROR_CODES,
  LedgerValidationError,
  fail,
} from "./errors.mjs";
import { assertIdentifier } from "./identifiers.mjs";
import { parseStreamName } from "./topology.mjs";

export const EVENT_ENVELOPE_SCHEMA_VERSION = 1;

export const EVENT_TYPES_V1 = Object.freeze([
  "ledger.fixture-recorded",
  "workspace.directory.updated",
  "channel.message.created",
  "agent.config.revised",
  "workspace.invocation.requested",
  "run.lifecycle.changed",
  "connection.config.revised",
  "workspace.audit.recorded",
  "projection.checkpointed",
  "principal.created",
  "principal.profile.updated",
  "principal.suspended",
  "principal.deactivated",
  "channel.created",
  "channel.renamed",
  "channel.archived",
  "channel.unarchived",
  "channel.membership.invited",
  "channel.membership.joined",
  "channel.membership.left",
  "channel.membership.removed",
  "channel.direct.created",
  "workspace.created",
  "workspace.membership.invited",
  "workspace.membership.accepted",
  "workspace.membership.role.changed",
  "workspace.membership.suspended",
  "workspace.membership.removed",
]);

const EVENT_TYPE_SET = new Set(EVENT_TYPES_V1);
const OFFSET_PATTERN = /^[0-9a-f]{16}_[0-9a-f]{16}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const SOURCE_REFERENCE_KEYS = ["digest", "offset", "stream"];
const ENVELOPE_KEYS = [
  "actorId",
  "causation",
  "correlationId",
  "data",
  "eventId",
  "eventType",
  "idempotencyKey",
  "schemaVersion",
  "serverTimestamp",
  "workspaceId",
];
const APPEND_INPUT_KEYS = ENVELOPE_KEYS.filter(
  (key) => key !== "eventId" && key !== "serverTimestamp",
);
const ISSUANCE_KEYS = ["clock", "eventId"];

export function validateSourceReference(
  value,
  { expectedWorkspaceId, path = "$.causation" } = {},
) {
  assertExactKeys(value, SOURCE_REFERENCE_KEYS, path);
  parseStreamName(value.stream, {
    expectedWorkspaceId,
    path: `${path}.stream`,
  });

  if (typeof value.offset !== "string" || !OFFSET_PATTERN.test(value.offset)) {
    fail(
      LEDGER_ERROR_CODES.INVALID_SOURCE_REFERENCE,
      `${path}.offset`,
      "offset must be two lowercase 64-bit hex words",
    );
  }
  if (typeof value.digest !== "string" || !DIGEST_PATTERN.test(value.digest)) {
    fail(
      LEDGER_ERROR_CODES.INVALID_SOURCE_REFERENCE,
      `${path}.digest`,
      "digest must be a lowercase sha256 reference",
    );
  }

  return value;
}

export function encodeSourceReference(value, options) {
  validateSourceReference(value, options);
  return canonicalJson(value);
}

export function validateEventEnvelope(value) {
  assertExactKeys(value, ENVELOPE_KEYS, "$");

  if (value.schemaVersion !== EVENT_ENVELOPE_SCHEMA_VERSION) {
    fail(
      LEDGER_ERROR_CODES.INVALID_SCHEMA_VERSION,
      "$.schemaVersion",
      `supported version is ${EVENT_ENVELOPE_SCHEMA_VERSION}`,
    );
  }
  if (
    typeof value.eventType !== "string" ||
    !EVENT_TYPE_SET.has(value.eventType)
  ) {
    fail(
      LEDGER_ERROR_CODES.INVALID_EVENT_TYPE,
      "$.eventType",
      "event type is not registered for v1",
    );
  }

  assertIdentifier("workspace", value.workspaceId, { path: "$.workspaceId" });
  assertIdentifier("event", value.eventId, { path: "$.eventId" });
  assertIdentifier("principal", value.actorId, {
    path: "$.actorId",
    workspaceId: value.workspaceId,
  });
  assertIdentifier("correlation", value.correlationId, {
    path: "$.correlationId",
  });
  assertIdentifier("idempotency", value.idempotencyKey, {
    path: "$.idempotencyKey",
  });

  validateTimestamp(value.serverTimestamp);
  if (value.causation !== null) {
    validateSourceReference(value.causation, {
      expectedWorkspaceId: value.workspaceId,
    });
  }

  if (
    !value.data ||
    typeof value.data !== "object" ||
    Array.isArray(value.data)
  ) {
    fail(
      LEDGER_ERROR_CODES.TYPE_MISMATCH,
      "$.data",
      "event data must be an object",
    );
  }
  canonicalJson(value.data, "$.data");
  return value;
}

export function issueEventEnvelope(input, issuance) {
  assertExactKeys(input, APPEND_INPUT_KEYS, "$.input");
  assertExactKeys(issuance, ISSUANCE_KEYS, "$.issuance");

  if (input.schemaVersion !== EVENT_ENVELOPE_SCHEMA_VERSION) {
    fail(
      LEDGER_ERROR_CODES.INVALID_SCHEMA_VERSION,
      "$.input.schemaVersion",
      `supported version is ${EVENT_ENVELOPE_SCHEMA_VERSION}`,
    );
  }
  if (typeof issuance.clock !== "function") {
    fail(
      LEDGER_ERROR_CODES.TYPE_MISMATCH,
      "$.issuance.clock",
      "clock must be a function",
    );
  }

  const issuedAt = issuance.clock();
  if (!(issuedAt instanceof Date) || Number.isNaN(issuedAt.getTime())) {
    fail(
      LEDGER_ERROR_CODES.INVALID_TIMESTAMP,
      "$.issuance.clock",
      "clock returned an invalid Date",
    );
  }

  const envelope = {
    ...input,
    eventId: issuance.eventId,
    serverTimestamp: issuedAt.toISOString(),
  };
  return validateEventEnvelope(envelope);
}

export function encodeEventEnvelope(value) {
  validateEventEnvelope(value);
  return canonicalJson(value);
}

export function digestEventEnvelope(value) {
  validateEventEnvelope(value);
  return canonicalSha256(value);
}

export function decodeEventEnvelope(encoded) {
  let text;
  try {
    if (typeof encoded === "string") {
      text = encoded;
    } else if (encoded instanceof Uint8Array) {
      text = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
    } else {
      fail(
        LEDGER_ERROR_CODES.INVALID_JSON,
        "$",
        "encoded envelope must be text or UTF-8 bytes",
      );
    }
  } catch (error) {
    if (error instanceof LedgerValidationError) throw error;
    fail(
      LEDGER_ERROR_CODES.INVALID_JSON,
      "$",
      "encoded envelope is not valid UTF-8",
    );
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(
      LEDGER_ERROR_CODES.INVALID_JSON,
      "$",
      "encoded envelope is not valid JSON",
    );
  }
  return validateEventEnvelope(value);
}

function validateTimestamp(value) {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    fail(
      LEDGER_ERROR_CODES.INVALID_TIMESTAMP,
      "$.serverTimestamp",
      "timestamp must be canonical UTC with millisecond precision",
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(
      LEDGER_ERROR_CODES.INVALID_TIMESTAMP,
      "$.serverTimestamp",
      "timestamp is not a real UTC instant",
    );
  }
}
