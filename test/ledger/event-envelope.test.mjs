import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { appendIssuedEvent } from "../../src/ledger/append-boundary.mjs";
import { canonicalJson, canonicalSha256 } from "../../src/ledger/canonical-json.mjs";
import {
  decodeEventEnvelope,
  digestEventEnvelope,
  encodeEventEnvelope,
  encodeSourceReference,
  EVENT_TYPES_V1,
  issueEventEnvelope,
  validateEventEnvelope,
  validateSourceReference,
} from "../../src/ledger/envelope.mjs";
import { LedgerValidationError } from "../../src/ledger/errors.mjs";
import { parseStreamName, streamNames, STREAM_TOPOLOGY_V1 } from "../../src/ledger/topology.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const taskDir = path.join(
  rootDir,
  ".eforest/tasks/epic-0-the-ledger/E0-T01-versioned-event-envelope-and-stream-topology",
);
const validDir = path.join(taskDir, "fixtures/valid");
const invalidDir = path.join(taskDir, "fixtures/invalid");

const WORKSPACE_A = `ws_${"a".repeat(26)}`;
const WORKSPACE_B = `ws_${"z".repeat(26)}`;
const CHANNEL_A = `ch_${"a".repeat(26)}_${"c".repeat(26)}`;
const CHANNEL_B = `ch_${"z".repeat(26)}_${"c".repeat(26)}`;

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function expectLedgerError(operation, expected) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof LedgerValidationError);
    if (expected.code) assert.equal(error.code, expected.code);
    if (expected.path) assert.equal(error.path, expected.path);
    return true;
  });
}

test("golden event and source reference have stable canonical bytes and digests", async () => {
  const event = await readJson(path.join(validDir, "event-envelope.v1.json"));
  const source = await readJson(path.join(validDir, "source-reference.v1.json"));
  const manifest = await readJson(path.join(validDir, "manifest.json"));

  const reorderedEvent = Object.fromEntries(Object.entries(event).reverse());
  reorderedEvent.causation = Object.fromEntries(Object.entries(event.causation).reverse());
  reorderedEvent.data = Object.fromEntries(Object.entries(event.data).reverse());

  assert.equal(encodeEventEnvelope(event), encodeEventEnvelope(reorderedEvent));
  assert.equal(digestEventEnvelope(event), manifest["event-envelope.v1.json"].canonicalSha256);
  assert.equal(digestEventEnvelope(reorderedEvent), manifest["event-envelope.v1.json"].canonicalSha256);
  assert.equal(canonicalSha256(source), manifest["source-reference.v1.json"].canonicalSha256);
  assert.equal(encodeSourceReference(source, { expectedWorkspaceId: WORKSPACE_A }), canonicalJson(source));

  const { eventId, serverTimestamp, ...input } = event;
  const issued = issueEventEnvelope(input, {
    eventId,
    clock: () => new Date(serverTimestamp),
  });
  assert.equal(encodeEventEnvelope(issued), encodeEventEnvelope(event));
  assert.deepEqual(decodeEventEnvelope(Buffer.from(encodeEventEnvelope(event), "utf8")), event);

  let appendCalls = 0;
  const appendedDigest = await appendIssuedEvent({
    input,
    issuance: { eventId, clock: () => new Date(serverTimestamp) },
    append: (record) => {
      appendCalls += 1;
      return record.digest;
    },
  });
  assert.equal(appendCalls, 1);
  assert.equal(appendedDigest, digestEventEnvelope(event));
});

test("all invalid golden fixtures fail with stable typed errors before append", async () => {
  const fixtureNames = (await readdir(invalidDir)).filter((name) => name.endsWith(".json")).sort();
  assert.ok(fixtureNames.length >= 5);

  for (const fixtureName of fixtureNames) {
    const fixture = await readJson(path.join(invalidDir, fixtureName));
    const operation = fixture.mode === "issue"
      ? () => issueEventEnvelope(fixture.input, {
          eventId: `ev_${"c".repeat(26)}`,
          clock: () => new Date("2026-01-01T00:00:00.000Z"),
        })
      : () => validateEventEnvelope(fixture.value);
    expectLedgerError(operation, fixture.expectedError);
  }
});

test("every envelope field, extra keys, overflow, and invalid UTF-8 fail closed", async () => {
  const event = await readJson(path.join(validDir, "event-envelope.v1.json"));
  const fieldMutations = {
    actorId: 42,
    causation: [],
    correlationId: {},
    data: "not-an-object",
    eventId: null,
    eventType: "channel.message.future",
    idempotencyKey: [],
    schemaVersion: "1",
    serverTimestamp: "2026-01-01T00:00:00Z",
    workspaceId: "WS_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  };

  for (const [field, replacement] of Object.entries(fieldMutations)) {
    expectLedgerError(() => validateEventEnvelope({ ...event, [field]: replacement }), {});
  }

  expectLedgerError(() => validateEventEnvelope({ ...event, unexpected: true }), {
    code: "LEDGER_EXTRA_KEY",
    path: "$.unexpected",
  });
  expectLedgerError(
    () => validateEventEnvelope({ ...event, data: { unsafe: Number.MAX_SAFE_INTEGER + 1 } }),
    { code: "LEDGER_INVALID_JSON_VALUE", path: "$.data.unsafe" },
  );
  expectLedgerError(() => validateEventEnvelope({ ...event, data: { broken: "\ud800" } }), {
    code: "LEDGER_INVALID_JSON_VALUE",
    path: "$.data.broken",
  });
  expectLedgerError(() => decodeEventEnvelope(Uint8Array.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d])), {
    code: "LEDGER_INVALID_JSON",
    path: "$",
  });
});

test("stream builders reject traversal, normalization, confusables, and sibling scope", () => {
  const streams = [
    streamNames.workspaceDirectory(WORKSPACE_A),
    streamNames.channel(WORKSPACE_A, CHANNEL_A),
    streamNames.agentConfig(WORKSPACE_A, `ag_${"a".repeat(26)}_${"d".repeat(26)}`),
    streamNames.workspaceInvocations(WORKSPACE_A),
    streamNames.run(WORKSPACE_A, `rn_${"a".repeat(26)}_${"e".repeat(26)}`),
    streamNames.connectionConfig(WORKSPACE_A, `cn_${"a".repeat(26)}_${"f".repeat(26)}`),
    streamNames.workspaceAudit(WORKSPACE_A),
    streamNames.projection(WORKSPACE_A, `px_${"a".repeat(26)}_${"g".repeat(26)}`),
  ];
  assert.equal(streams.length, Object.keys(STREAM_TOPOLOGY_V1).length);
  for (const stream of streams) {
    assert.equal(parseStreamName(stream, { expectedWorkspaceId: WORKSPACE_A }).workspaceId, WORKSPACE_A);
  }

  const invalidWorkspaceIds = [
    WORKSPACE_A.toUpperCase(),
    "ws_../aaaaaaaaaaaaaaaaaaaaaa",
    `ws_${"a".repeat(25)}/`,
    `ws_${"а"}${"a".repeat(25)}`,
    `ws_%2e%2e${"a".repeat(20)}`,
  ];
  for (const workspaceId of invalidWorkspaceIds) {
    expectLedgerError(() => streamNames.workspaceDirectory(workspaceId), {
      code: "LEDGER_INVALID_ID",
    });
  }

  expectLedgerError(() => streamNames.channel(WORKSPACE_A, CHANNEL_B), {
    code: "LEDGER_WORKSPACE_SCOPE_MISMATCH",
    path: "$.channelId",
  });
  expectLedgerError(() => parseStreamName(`channel:${CHANNEL_A}`, { expectedWorkspaceId: WORKSPACE_B }), {
    code: "LEDGER_WORKSPACE_SCOPE_MISMATCH",
    path: "$.stream",
  });
  expectLedgerError(() => parseStreamName("channel:../channel"), {
    code: "LEDGER_INVALID_STREAM_NAME",
    path: "$.stream",
  });
});

test("source offsets and one-byte golden mutations are sensitive", async () => {
  const event = await readJson(path.join(validDir, "event-envelope.v1.json"));
  const source = await readJson(path.join(validDir, "source-reference.v1.json"));

  expectLedgerError(() => validateSourceReference({ ...source, offset: "000000000000000A_0000000000000002" }), {
    code: "LEDGER_INVALID_SOURCE_REFERENCE",
    path: "$.causation.offset",
  });

  const canonical = encodeEventEnvelope(event);
  const mutated = canonical.replace("hello from", "jello from");
  assert.notEqual(mutated, canonical);
  const mutatedEvent = decodeEventEnvelope(mutated);
  assert.notEqual(digestEventEnvelope(mutatedEvent), digestEventEnvelope(event));
});

test("JSON schemas and runtime registry describe the same v1 event types", async () => {
  const envelopeSchema = await readJson(path.join(rootDir, "src/ledger/schemas/event-envelope.v1.schema.json"));
  const sourceSchema = await readJson(path.join(rootDir, "src/ledger/schemas/source-reference.v1.schema.json"));

  assert.equal(envelopeSchema.properties.schemaVersion.const, 1);
  assert.deepEqual(envelopeSchema.properties.eventType.enum, EVENT_TYPES_V1);
  assert.deepEqual(sourceSchema.required, ["digest", "offset", "stream"]);
  assert.equal(sourceSchema.additionalProperties, false);
});
