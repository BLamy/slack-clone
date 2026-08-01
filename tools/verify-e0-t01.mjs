import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendEncodedEvent, appendIssuedEvent } from "../src/ledger/append-boundary.mjs";
import { canonicalJson, canonicalSha256 } from "../src/ledger/canonical-json.mjs";
import {
  decodeEventEnvelope,
  digestEventEnvelope,
  encodeEventEnvelope,
  encodeSourceReference,
  EVENT_TYPES_V1,
  issueEventEnvelope,
  validateEventEnvelope,
  validateSourceReference,
} from "../src/ledger/envelope.mjs";
import { LedgerValidationError } from "../src/ledger/errors.mjs";
import { parseStreamName, streamNames, STREAM_TOPOLOGY_V1 } from "../src/ledger/topology.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const taskDir = path.join(
  rootDir,
  ".eforest/tasks/epic-0-the-ledger/E0-T01-versioned-event-envelope-and-stream-topology",
);
const validDir = path.join(taskDir, "fixtures/valid");
const invalidDir = path.join(taskDir, "fixtures/invalid");
const evidenceDir = path.join(taskDir, "evidence");

const WORKSPACE_A = `ws_${"a".repeat(26)}`;
const WORKSPACE_B = `ws_${"z".repeat(26)}`;
const CHANNEL_A = `ch_${"a".repeat(26)}_${"c".repeat(26)}`;
const CHANNEL_B = `ch_${"z".repeat(26)}_${"c".repeat(26)}`;
const FIXED_ISSUANCE = Object.freeze({
  eventId: `ev_${"c".repeat(26)}`,
  clock: () => new Date("2026-01-01T00:00:00.000Z"),
});

const output = ["E0-T01 deterministic verifier", "runtime-contract=Node.js>=22"];
let checks = 0;
const evidence = {};

async function check(label, operation) {
  await operation();
  checks += 1;
  output.push(`PASS ${label}`);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function captureLedgerError(operation) {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof LedgerValidationError);
    return error;
  }
  assert.fail("expected a typed ledger refusal");
}

function reverseObject(value) {
  return Object.fromEntries(Object.entries(value).reverse());
}

await check("versioned schemas match the runtime registry", async () => {
  const envelopeSchema = await readJson(path.join(rootDir, "src/ledger/schemas/event-envelope.v1.schema.json"));
  const sourceSchema = await readJson(path.join(rootDir, "src/ledger/schemas/source-reference.v1.schema.json"));
  assert.equal(envelopeSchema.properties.schemaVersion.const, 1);
  assert.deepEqual(envelopeSchema.properties.eventType.enum, EVENT_TYPES_V1);
  assert.deepEqual(sourceSchema.required, ["digest", "offset", "stream"]);
  assert.equal(envelopeSchema.additionalProperties, false);
  assert.equal(sourceSchema.additionalProperties, false);
});

const goldenEvent = await readJson(path.join(validDir, "event-envelope.v1.json"));
const goldenSource = await readJson(path.join(validDir, "source-reference.v1.json"));
const goldenManifest = await readJson(path.join(validDir, "manifest.json"));

await check("canonical bytes and SHA-256 match golden parity values", async () => {
  const reordered = reverseObject(goldenEvent);
  reordered.causation = reverseObject(goldenEvent.causation);
  reordered.data = reverseObject(goldenEvent.data);

  const canonical = encodeEventEnvelope(goldenEvent);
  assert.equal(encodeEventEnvelope(reordered), canonical);
  assert.equal(digestEventEnvelope(goldenEvent), goldenManifest["event-envelope.v1.json"].canonicalSha256);
  assert.equal(digestEventEnvelope(reordered), goldenManifest["event-envelope.v1.json"].canonicalSha256);
  assert.equal(canonicalSha256(goldenSource), goldenManifest["source-reference.v1.json"].canonicalSha256);
  assert.equal(encodeSourceReference(goldenSource, { expectedWorkspaceId: WORKSPACE_A }), canonicalJson(goldenSource));

  const { eventId, serverTimestamp, ...input } = goldenEvent;
  const first = issueEventEnvelope(input, { eventId, clock: () => new Date(serverTimestamp) });
  const second = issueEventEnvelope(reverseObject(input), { eventId, clock: () => new Date(serverTimestamp) });
  assert.equal(encodeEventEnvelope(first), encodeEventEnvelope(second));

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
  assert.equal(appendedDigest, digestEventEnvelope(goldenEvent));

  evidence.canonicalParity = {
    schemaVersion: 1,
    canonicalJson: canonical,
    byteLength: Buffer.byteLength(canonical, "utf8"),
    canonicalSha256: digestEventEnvelope(goldenEvent),
    sourceReferenceSha256: canonicalSha256(goldenSource),
  };
});

await check("invalid golden fixtures are refused before the append callback", async () => {
  const names = (await readdir(invalidDir)).filter((name) => name.endsWith(".json")).sort();
  const refusalDumps = [];

  for (const name of names) {
    const fixture = await readJson(path.join(invalidDir, name));
    const records = [Buffer.from('{"seed":"unchanged"}\n', "utf8")];
    let appendCalls = 0;
    const append = ({ canonicalJson: encoded }) => {
      appendCalls += 1;
      records.push(Buffer.from(`${encoded}\n`, "utf8"));
    };
    const dump = () => Buffer.concat(records);
    const before = dump();

    let error;
    try {
      if (fixture.mode === "issue") {
        await appendIssuedEvent({ input: fixture.input, issuance: FIXED_ISSUANCE, append });
      } else {
        await appendEncodedEvent({ encoded: JSON.stringify(fixture.value), append });
      }
      assert.fail(`${name} unexpectedly reached append`);
    } catch (caught) {
      assert.ok(caught instanceof LedgerValidationError);
      error = caught;
    }

    const after = dump();
    assert.equal(error.code, fixture.expectedError.code);
    assert.equal(error.path, fixture.expectedError.path);
    assert.equal(appendCalls, 0);
    assert.deepEqual(after, before);
    refusalDumps.push({
      fixture: name,
      error: error.toJSON(),
      appendCalls,
      beforeBase64: before.toString("base64"),
      afterBase64: after.toString("base64"),
      beforeSha256: sha256Bytes(before),
      afterSha256: sha256Bytes(after),
      byteIdentical: true,
    });
  }

  assert.ok(refusalDumps.length >= 5);
  evidence.refusalDumps = refusalDumps;
});

await check("field mutations, overflow, extra keys, and invalid UTF-8 fail closed", () => {
  const mutations = {
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
  const attackMatrix = [];

  for (const [field, replacement] of Object.entries(mutations)) {
    const error = captureLedgerError(() => validateEventEnvelope({ ...goldenEvent, [field]: replacement }));
    attackMatrix.push({ attack: `type-confusion:${field}`, result: "refused", error: error.toJSON() });
  }

  const extra = captureLedgerError(() => validateEventEnvelope({ ...goldenEvent, unexpected: true }));
  attackMatrix.push({ attack: "extra-envelope-key", result: "refused", error: extra.toJSON() });

  const overflow = captureLedgerError(() => validateEventEnvelope({
    ...goldenEvent,
    data: { unsafe: Number.MAX_SAFE_INTEGER + 1 },
  }));
  attackMatrix.push({ attack: "unsafe-integer", result: "refused", error: overflow.toJSON() });

  const surrogate = captureLedgerError(() => validateEventEnvelope({
    ...goldenEvent,
    data: { invalidUnicode: "\ud800" },
  }));
  attackMatrix.push({ attack: "invalid-unicode", result: "refused", error: surrogate.toJSON() });

  const invalidUtf8 = captureLedgerError(() => decodeEventEnvelope(
    Uint8Array.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
  ));
  attackMatrix.push({ attack: "invalid-utf8", result: "refused", error: invalidUtf8.toJSON() });

  evidence.attackMatrix = attackMatrix;
});

await check("topology builders preserve workspace isolation without normalization", () => {
  const streams = {
    workspaceDirectory: streamNames.workspaceDirectory(WORKSPACE_A),
    channel: streamNames.channel(WORKSPACE_A, CHANNEL_A),
    agentConfig: streamNames.agentConfig(WORKSPACE_A, `ag_${"a".repeat(26)}_${"d".repeat(26)}`),
    workspaceInvocations: streamNames.workspaceInvocations(WORKSPACE_A),
    run: streamNames.run(WORKSPACE_A, `rn_${"a".repeat(26)}_${"e".repeat(26)}`),
    connectionConfig: streamNames.connectionConfig(WORKSPACE_A, `cn_${"a".repeat(26)}_${"f".repeat(26)}`),
    workspaceAudit: streamNames.workspaceAudit(WORKSPACE_A),
    projection: streamNames.projection(WORKSPACE_A, `px_${"a".repeat(26)}_${"g".repeat(26)}`),
  };
  assert.deepEqual(Object.keys(streams), Object.keys(STREAM_TOPOLOGY_V1));
  for (const stream of Object.values(streams)) {
    assert.equal(parseStreamName(stream, { expectedWorkspaceId: WORKSPACE_A }).workspaceId, WORKSPACE_A);
  }

  const attacks = [
    { name: "case", operation: () => streamNames.workspaceDirectory(WORKSPACE_A.toUpperCase()) },
    { name: "traversal", operation: () => streamNames.workspaceDirectory("ws_../aaaaaaaaaaaaaaaaaaaaaa") },
    { name: "separator", operation: () => streamNames.workspaceDirectory(`ws_${"a".repeat(25)}/`) },
    { name: "unicode-confusable", operation: () => streamNames.workspaceDirectory(`ws_${"а"}${"a".repeat(25)}`) },
    { name: "percent-encoding", operation: () => streamNames.workspaceDirectory(`ws_%2e%2e${"a".repeat(20)}`) },
    { name: "sibling-resource", operation: () => streamNames.channel(WORKSPACE_A, CHANNEL_B) },
    { name: "sibling-source", operation: () => parseStreamName(`channel:${CHANNEL_A}`, { expectedWorkspaceId: WORKSPACE_B }) },
  ].map(({ name, operation }) => {
    const error = captureLedgerError(operation);
    return { attack: name, result: "refused", error: error.toJSON() };
  });

  evidence.topology = { topologyVersion: 1, streams, attacks };
});

await check("source references require canonical complete offsets and digests", () => {
  validateSourceReference(goldenSource, { expectedWorkspaceId: WORKSPACE_A });
  const attacks = [
    { ...goldenSource, offset: "000000000000000A_0000000000000002" },
    { ...goldenSource, offset: "-1" },
    { ...goldenSource, digest: "sha256:ABC" },
    { offset: goldenSource.offset, stream: goldenSource.stream },
  ].map((value) => captureLedgerError(() => validateSourceReference(value, {
    expectedWorkspaceId: WORKSPACE_A,
  })).toJSON());
  assert.equal(attacks.length, 4);
  evidence.sourceRefusals = attacks;
});

await check("one-byte golden mutations change the digest or fail decoding", () => {
  const canonical = encodeEventEnvelope(goldenEvent);
  const mutated = canonical.replace("hello from", "jello from");
  assert.equal(Buffer.byteLength(mutated), Buffer.byteLength(canonical));
  const decoded = decodeEventEnvelope(mutated);
  const originalDigest = digestEventEnvelope(goldenEvent);
  const mutatedDigest = digestEventEnvelope(decoded);
  assert.notEqual(mutatedDigest, originalDigest);
  evidence.sensitivity = {
    mutation: "one UTF-8 byte h->j in valid golden payload",
    originalDigest,
    mutatedDigest,
    detectorSensitive: true,
  };
});

await check("topology documentation declares authority, rebuilds, and idempotent sagas", async () => {
  const topologyDocument = await readFile(path.join(rootDir, "docs/stream-topology.md"), "utf8");
  for (const phrase of [
    "Durable Streams are the authority",
    "replay from offset `-1`",
    "idempotent saga",
    "Unknown envelope versions and event types stop reduction",
  ]) {
    assert.ok(topologyDocument.includes(phrase), `missing topology contract phrase: ${phrase}`);
  }
  assert.match(topologyDocument, /Rebuild means delete\s+the index/);
});

await mkdir(evidenceDir, { recursive: true });
await writeFile(
  path.join(evidenceDir, "canonical-parity.json"),
  `${JSON.stringify(evidence.canonicalParity, null, 2)}\n`,
);
await writeFile(
  path.join(evidenceDir, "refusal-stream-dumps.json"),
  `${JSON.stringify(evidence.refusalDumps, null, 2)}\n`,
);
await writeFile(
  path.join(evidenceDir, "attack-matrix.json"),
  `${JSON.stringify(evidence.attackMatrix, null, 2)}\n`,
);
await writeFile(
  path.join(evidenceDir, "topology-streams.json"),
  `${JSON.stringify(evidence.topology, null, 2)}\n`,
);
await writeFile(
  path.join(evidenceDir, "source-refusals.json"),
  `${JSON.stringify(evidence.sourceRefusals, null, 2)}\n`,
);
await writeFile(
  path.join(evidenceDir, "digest-sensitivity.json"),
  `${JSON.stringify(evidence.sensitivity, null, 2)}\n`,
);

checks += 1;
output.push("PASS deterministic evidence artifacts written");
output.push(`checks=${checks} skipped=0`);
output.push(
  "Replay: N/A (server/CLI schema contract) + mitigation: canonical fixtures, refusal dumps, digest parity, and cold-clone verification",
);
output.push("RESULT PASS");

const commandOutput = `${output.join("\n")}\n`;
await writeFile(path.join(evidenceDir, "verify-output.txt"), commandOutput);
process.stdout.write(commandOutput);
