import {
  decodeEventEnvelope,
  digestEventEnvelope,
  encodeEventEnvelope,
  issueEventEnvelope,
} from "./envelope.mjs";
import { LEDGER_ERROR_CODES, fail } from "./errors.mjs";

export async function appendIssuedEvent({ input, issuance, append }) {
  assertAppend(append);

  const envelope = issueEventEnvelope(input, issuance);
  return appendValidatedEnvelope(envelope, append);
}

export async function appendEncodedEvent({ encoded, append }) {
  assertAppend(append);
  const envelope = decodeEventEnvelope(encoded);
  return appendValidatedEnvelope(envelope, append);
}

function appendValidatedEnvelope(envelope, append) {
  const canonicalJson = encodeEventEnvelope(envelope);
  const digest = digestEventEnvelope(envelope);
  return append({ envelope, canonicalJson, digest });
}

function assertAppend(append) {
  if (typeof append !== "function") {
    fail(LEDGER_ERROR_CODES.TYPE_MISMATCH, "$.append", "append must be a function");
  }
}
