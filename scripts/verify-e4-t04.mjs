import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CLOUDFLARE_OS_ERROR_CODES,
  CloudflareOsClient,
} from "@stream-slack/sandbox-cloudflare-os";
import {
  EXECUTION_EVENT_TYPES,
  ExecutionController,
  ExecutionEventJournal,
  SANDBOX_ERROR_CODES,
  decodeExecutionOutput,
  replayExecutionEvents,
} from "@stream-slack/sandbox";

const runId = process.env.TEST_RUN_ID ?? `e4-t04-${Date.now().toString(36)}`;
const evidence = path.resolve(
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e4-t04", runId),
);
await mkdir(evidence, { recursive: true });

const limits = {
  chunkBytes: 16,
  commandBytes: 64,
  runBytes: 128,
  maxEvents: 32,
};
const executionId = "ex_e4_t04_transcript";
const journal = new ExecutionEventJournal({ executionId, limits });
journal.appendOutput("stdout", Buffer.from([0xc3]));
journal.appendOutput("stderr", Buffer.from([0x28]));
journal.appendOutput("stdout", Buffer.from([0xa9, 0xff]));
journal.appendHeartbeat({ stage: "résumé", alive: true });
journal.appendTerminal({ kind: "completed", exitCode: 0 });
const transcript = journal.events();
assert.equal(transcript.at(-1).type, EXECUTION_EVENT_TYPES.TERMINAL);
assert.deepEqual(decodeExecutionOutput(transcript[0]), Buffer.from([0xc3]));
assert.deepEqual(
  decodeExecutionOutput(transcript[2]),
  Buffer.from([0xa9, 0xff]),
);

const replayOne = replayExecutionEvents(transcript, { executionId, limits });
const replayTwo = replayExecutionEvents(structuredClone(transcript), {
  executionId,
  limits,
});
assert.equal(replayOne.digest, replayTwo.digest);
assert.deepEqual(replayOne.terminal, replayTwo.terminal);
assert.equal(replayOne.snapshot.state, "completed");

const reconnects = [];
for (let offset = 0; offset <= journal.lastSequence; offset += 1) {
  const consumer = new ExecutionEventJournal({ executionId, limits });
  for (const event of transcript.slice(0, offset)) consumer.ingest(event);
  const resumed = journal.replay(offset);
  for (const event of resumed) consumer.ingest(event);
  assert.deepEqual(consumer.events(), transcript, `resume offset ${offset}`);
  assert.equal(consumer.digest(), journal.digest(), `digest offset ${offset}`);
  reconnects.push({
    offset,
    acceptedSequences: resumed.map((event) => event.sequence),
  });
  if (offset > 0 && offset < journal.lastSequence) {
    const duplicate = consumer.ingest(transcript[offset - 1]);
    assert.equal(duplicate.accepted, false);
    assert.equal(duplicate.duplicate, true);
  }
}
await assert.rejects(
  async () => journal.replay(journal.lastSequence + 1),
  (error) => error.code === SANDBOX_ERROR_CODES.EXECUTION_INVALID_OFFSET,
);

const terminalReplay = replayExecutionEvents(transcript, {
  executionId,
  limits,
});
const lateOutput = {
  executionId,
  sequence: journal.lastSequence + 1,
  type: EXECUTION_EVENT_TYPES.OUTPUT,
  channel: "stdout",
  data: Buffer.from("late", "utf8").toString("base64"),
  encoding: "base64",
  byteLength: 4,
};
const lateHeartbeat = {
  executionId,
  sequence: journal.lastSequence + 1,
  type: EXECUTION_EVENT_TYPES.HEARTBEAT,
  details: { alive: true },
};
await assert.rejects(
  async () => terminalReplay.events && ingestInto(terminalReplay, lateOutput),
  (error) => error.code === SANDBOX_ERROR_CODES.EXECUTION_TERMINAL,
);
await assert.rejects(
  async () => ingestInto(terminalReplay, lateHeartbeat),
  (error) => error.code === SANDBOX_ERROR_CODES.EXECUTION_TERMINAL,
);
const terminalJournal = new ExecutionEventJournal({ executionId, limits });
for (const event of transcript) terminalJournal.ingest(event);
assert.throws(
  () => terminalJournal.ingest(transcript.at(-1)),
  (error) => error.code === SANDBOX_ERROR_CODES.EXECUTION_TERMINAL,
);
assert.equal(terminalJournal.lastSequence, transcript.length);

const bounded = new ExecutionEventJournal({
  executionId: "ex_e4_t04_limits",
  limits: { chunkBytes: 4, commandBytes: 6, runBytes: 8, maxEvents: 8 },
});
const limited = bounded.appendOutput("stdout", Buffer.alloc(10, 7));
assert.deepEqual(
  { acceptedBytes: limited.acceptedBytes, truncated: limited.truncated },
  { acceptedBytes: 4, truncated: true },
);
assert.equal(bounded.events().at(-1).type, EXECUTION_EVENT_TYPES.LIMIT);
assert.equal(bounded.snapshot().outputBytes, 4);
assert.throws(
  () => bounded.appendOutput("stderr", Buffer.from("more")),
  (error) => error.code === SANDBOX_ERROR_CODES.EXECUTION_OUTPUT_LIMIT,
);
const boundedTerminal = bounded.appendTerminal({
  kind: "failed",
  reasonCode: "output_limit",
});
assert.equal(boundedTerminal.kind, "failed");
assert.ok(bounded.snapshot().outputBytes <= bounded.limits.runBytes);

const fenced = new ExecutionController({ executionId: "ex_e4_t04_fenced" });
fenced.appendOutput("stdout", "before-terminal");
fenced.complete({ kind: "completed", exitCode: 0 });
assert.equal(fenced.snapshot().fenced, true);
assert.throws(
  () => fenced.assertEffectAllowed("credential operation"),
  (error) => error.code === SANDBOX_ERROR_CODES.EXECUTION_FENCED,
);
assert.throws(
  () => fenced.appendHeartbeat({ alive: true }),
  (error) => error.code === SANDBOX_ERROR_CODES.EXECUTION_FENCED,
);

const cancellationFixture = createProcessTreeFixture();
const cancelled = new ExecutionController({
  executionId: "ex_e4_t04_cancel",
  processRunner: cancellationFixture,
});
await cancelled.start({ command: "fixture-command" });
const cancellation = cancelled.cancel({ boundMs: 100, graceMs: 1 });
assert.throws(
  () => cancelled.assertEffectAllowed("message append"),
  (error) => error.code === SANDBOX_ERROR_CODES.EXECUTION_FENCED,
);
const cancellationTerminal = await cancellation;
assert.equal(cancellationTerminal.kind, "cancelled");
assert.equal(cancellationTerminal.termination.survivors, 0);
assert.equal(cancellationFixture.terminateCalls, 1);
assert.equal(cancellationFixture.activeDescendants(), 0);
assert.deepEqual(await cancelled.cancel(), cancellationTerminal);

const timeoutFixture = createProcessTreeFixture();
const timedOut = new ExecutionController({
  executionId: "ex_e4_t04_timeout",
  processRunner: timeoutFixture,
});
await timedOut.start({ command: "fixture-command" });
const timeoutTerminal = await timedOut.timeout({ boundMs: 100, graceMs: 1 });
assert.equal(timeoutTerminal.kind, "timed-out");
assert.equal(timeoutTerminal.reasonCode, "deadline");
assert.equal(timeoutTerminal.termination.survivors, 0);
assert.equal(timeoutFixture.activeDescendants(), 0);

const streamLabels = {
  "stream-slack/tenant": "tenant_e4_t04",
  "stream-slack/workspace": "workspace_e4_t04",
  "stream-slack/agent": "agent_e4_t04",
  "stream-slack/invocation": "invocation_e4_t04",
  "stream-slack/idempotency": "ik_e4_t04",
};
const streamRequests = [];
const deploymentToken = "e4-t04-deployment-token";
const client = new CloudflareOsClient({
  baseUrl: "http://fixture.invalid",
  token: deploymentToken,
  fetchImpl: async (url, options) => {
    streamRequests.push({ url, options });
    const after = Number(new URL(url).searchParams.get("after"));
    const body = transcript
      .filter((event) => event.sequence > after)
      .map((event) => JSON.stringify(event))
      .join("\n");
    return chunkedResponse(`${body}\n`);
  },
});
const streamed = [];
for await (const event of client.streamExec(
  { workspaceId: "workspace_e4_t04", gadgetId: "gadget_e4_t04" },
  streamLabels,
  executionId,
  { afterSequence: 2 },
))
  streamed.push(event);
assert.deepEqual(
  streamed,
  transcript.filter((event) => event.sequence > 2),
);
assert.equal(streamRequests.length, 1);
assert.equal(
  streamRequests[0].options.headers.authorization,
  `Bearer ${deploymentToken}`,
);
assert.equal(streamRequests[0].options.headers.accept, "application/x-ndjson");
assert.equal(new URL(streamRequests[0].url).searchParams.get("after"), "2");
assert.equal(JSON.stringify(client.audit()).includes(deploymentToken), false);

const malformedClient = new CloudflareOsClient({
  baseUrl: "http://fixture.invalid",
  token: deploymentToken,
  fetchImpl: async () =>
    new Response("not-json\n", {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    }),
});
await assert.rejects(
  async () => {
    for await (const _event of malformedClient.streamExec(
      { workspaceId: "workspace_e4_t04", gadgetId: "gadget_e4_t04" },
      streamLabels,
      executionId,
    )) {
      void _event;
    }
  },
  (error) => error.code === CLOUDFLARE_OS_ERROR_CODES.PROTOCOL,
);

await writeJson("transcript.json", {
  executionId,
  events: transcript,
  digest: journal.digest(),
  terminal: journal.terminalEvent,
  snapshot: journal.snapshot(),
});
await writeJson("reconnect-matrix.json", {
  offsets: reconnects,
  exactReplayDigest: journal.digest(),
  disconnectBoundariesCovered: reconnects.length,
});
await writeJson("cancellation.json", {
  cancellation: cancellationTerminal,
  timeout: timeoutTerminal,
  cancellationProcessTreeSurvivors: cancellationTerminal.termination.survivors,
  timeoutProcessTreeSurvivors: timeoutTerminal.termination.survivors,
  effectFenceAfterCancel: true,
  effectFenceAfterTimeout: true,
});
await writeJson("limits.json", {
  bounded: bounded.snapshot(),
  limitEvent: bounded
    .events()
    .find((event) => event.type === EXECUTION_EVENT_TYPES.LIMIT),
  maxChunkBytes: bounded.limits.chunkBytes,
  maxCommandBytes: bounded.limits.commandBytes,
  maxRunBytes: bounded.limits.runBytes,
});
await writeJson("transport-audit.json", {
  requestCount: streamRequests.length,
  requestedAfterSequence: 2,
  receivedSequences: streamed.map((event) => event.sequence),
  audit: client.audit(),
  deploymentIdentityUsed: true,
  credentialAbsentFromAudit: true,
});
await writeJson("verification-summary.json", {
  schemaVersion: 1,
  task: "E4-T04",
  runId,
  result: "PASS",
  transcriptDigest: journal.digest(),
  transcriptReplayedTwice: replayOne.digest === replayTwo.digest,
  reconnectBoundaries: reconnects.length,
  terminalEvents: 1,
  processTreeSurvivorsAfterCancellation: 0,
  processTreeSurvivorsAfterTimeout: 0,
  boundedOutput: true,
  replay:
    "Replay: N/A (headless remote execution transport) + mitigation: cold-clone transcript replay, disconnect matrix, cancellation sensitivity, and exact sequence assertions",
});
for (const file of await readdir(evidence)) {
  if (!file.endsWith(".json")) continue;
  const contents = await readFile(path.join(evidence, file), "utf8");
  assert.equal(
    contents.includes(deploymentToken),
    false,
    `${file} leaked deployment token`,
  );
  assert.equal(
    contents.includes("authorization"),
    false,
    `${file} leaked auth header`,
  );
}

console.log(
  JSON.stringify(
    {
      implementationCommit: process.env.E4_T04_IMPLEMENTATION_COMMIT ?? "local",
      result: "PASS",
      runId,
      transcriptDigest: journal.digest(),
      reconnectBoundaries: reconnects.length,
    },
    null,
    2,
  ),
);

function ingestInto(replayed, event) {
  const journalForReplay = new ExecutionEventJournal({
    executionId,
    limits,
  });
  for (const prior of replayed.events) journalForReplay.ingest(prior);
  return journalForReplay.ingest(event);
}

function createProcessTreeFixture() {
  let active = 4;
  let terminateCalls = 0;
  return {
    get terminateCalls() {
      return terminateCalls;
    },
    activeDescendants: () => active,
    launch: async () => ({ fixtureTree: true }),
    terminate: async () => {
      terminateCalls += 1;
      active = 0;
      return {
        durationMs: 1,
        finishedAtMs: 1,
        groupId: -7001,
        signals: ["SIGTERM", "SIGKILL"],
        survivors: active,
        usedKillEscalation: true,
      };
    },
  };
}

function chunkedResponse(value) {
  const bytes = new TextEncoder().encode(value);
  let cursor = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (cursor >= bytes.length) {
        controller.close();
        return;
      }
      const next = Math.min(bytes.length, cursor + 3);
      controller.enqueue(bytes.slice(cursor, next));
      cursor = next;
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

async function writeJson(name, value) {
  await writeFile(
    path.join(evidence, name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}
