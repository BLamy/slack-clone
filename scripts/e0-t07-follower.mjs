import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { createDurableStreamsStore } from "@stream-slack/durable-streams";
import { canonicalStateJson, replayRecords } from "@stream-slack/reducers";

import { canonicalSha256 } from "../src/ledger/canonical-json.mjs";
import { validateDispatchReceipt } from "../src/ledger/dispatch.mjs";
import {
  createE0T07Checkpoint,
  validateE0T07Checkpoint,
} from "../src/ledger/e0-t07-protocol.mjs";

const options = parseOptions(process.argv.slice(2));
const host = options.host ?? process.env.E0_T07_HOST ?? "127.0.0.1";
const port = parsePort(options.port ?? process.env.E0_T07_PORT, "port");
const baseUrl = options.baseUrl ?? process.env.E0_T07_BASE_URL;
const token = options.token ?? process.env.E0_T07_TOKEN;
const sourceStream = options.sourceStream ?? process.env.E0_T07_SOURCE_STREAM;
const receiptStream =
  options.receiptStream ?? process.env.E0_T07_RECEIPT_STREAM;
const checkpointFile =
  options.checkpointFile ?? process.env.E0_T07_CHECKPOINT_FILE;

if (!baseUrl || !token || !sourceStream || !receiptStream || !checkpointFile) {
  throw new Error(
    "follower requires baseUrl, token, sourceStream, receiptStream, and checkpointFile",
  );
}

const store = createDurableStreamsStore({
  baseUrl,
  digestRecords: canonicalSha256,
  fetchFn: globalThis.fetch,
  token,
});
const observedEventIds = [];
const observedEventIdSet = new Set();
const metrics = {
  batches: 0,
  externalHeadPolls: 0,
  followReconnects: 0,
  followRecords: 0,
  sourceReplayRecords: 0,
};
let checkpoint = await readCheckpoint();
let followSession = null;
let closing = false;
let ready = false;

await bootstrap();
const server = createServer((request, response) => {
  void handleRequest(request, response);
});
await listen(server, host, port);
ready = true;
console.log(
  JSON.stringify({
    checkpoint,
    pid: process.pid,
    ready,
    role: "e0-t07-follower",
    sourceStream,
    stateAuthority: "durable-streams",
  }),
);

process.once("SIGTERM", () => {
  void shutdown();
});
process.once("SIGINT", () => {
  void shutdown();
});

async function bootstrap() {
  const sourceSnapshot = await store.read(sourceStream, "-1");
  metrics.sourceReplayRecords = sourceSnapshot.records.length;
  observeRecords(sourceSnapshot.records);

  followSession = await store.follow(sourceStream, checkpoint.offset, {
    live: "sse",
    onBatch: async ({ records, nextOffset }) => {
      metrics.batches += 1;
      metrics.followRecords += records.length;
      observeRecords(records);
      checkpoint = createE0T07Checkpoint({
        offset: nextOffset,
        sourceStream,
      });
      await persistCheckpoint(checkpoint);
    },
  });
  void monitorExternalProgress();
}

async function monitorExternalProgress() {
  while (true) {
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    if (closing) return;
    if (!followSession) continue;
    const session = followSession;
    const sourceSnapshot = await store.read(sourceStream, "-1");
    metrics.externalHeadPolls += 1;
    if (sourceSnapshot.nextOffset === checkpoint.offset) continue;
    metrics.followReconnects += 1;
    session.cancel("external durable append observed");
    try {
      await session.closed;
    } catch {
      // The adapter reports cancellation through the closed promise.
    }
    if (closing || followSession !== session) continue;
    followSession = await store.follow(sourceStream, checkpoint.offset, {
      live: "sse",
      onBatch: async ({ records, nextOffset }) => {
        metrics.batches += 1;
        metrics.followRecords += records.length;
        observeRecords(records);
        checkpoint = createE0T07Checkpoint({
          offset: nextOffset,
          sourceStream,
        });
        await persistCheckpoint(checkpoint);
      },
    });
  }
}

async function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, healthPayload());
      return;
    }
    if (request.method === "GET" && url.pathname === "/checkpoint") {
      sendJson(response, 200, { checkpoint });
      return;
    }
    if (request.method === "GET" && url.pathname === "/state") {
      sendJson(response, 200, await statePayload());
      return;
    }
    if (request.method === "POST" && url.pathname === "/stop") {
      sendJson(response, 200, { ok: true });
      void shutdown();
      return;
    }
    sendJson(response, 404, { error: "not_found", ok: false });
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    });
  }
}

async function statePayload() {
  const sourceSnapshot = await store.read(sourceStream, "-1");
  const receiptSnapshot = await store.read(receiptStream, "-1");
  const receipts = new Map();
  for (const record of receiptSnapshot.records) {
    if (record?.kind !== "dispatch.accepted") continue;
    const receipt = validateDispatchReceipt(record.receipt);
    receipts.set(receipt.idempotencyKey, receipt);
  }

  const offsetRecords = [];
  const missingReceipts = [];
  for (const record of sourceSnapshot.records) {
    const idempotencyKey = record?.dispatch?.idempotencyKey;
    const receipt = receipts.get(idempotencyKey);
    if (!receipt) {
      missingReceipts.push(idempotencyKey ?? null);
      continue;
    }
    offsetRecords.push({ event: record.event, offset: receipt.nextOffset });
  }

  const result = {
    checkpoint,
    checkpointDigest: checkpoint.checkpointDigest,
    observedCount: observedEventIds.length,
    observedEventIds: [...observedEventIds],
    receiptCount: receipts.size,
    sourceHead: sourceSnapshot.nextOffset,
    sourceRecordCount: sourceSnapshot.records.length,
    stateAuthority: "durable-streams",
  };
  if (missingReceipts.length > 0) {
    return {
      ...result,
      missingReceipts,
      status: "pending-receipts",
    };
  }

  const replay = replayRecords(offsetRecords);
  return {
    ...result,
    finalState: replay.finalState,
    finalStateJson: canonicalStateJson(replay.finalState),
    finalStateDigest: replay.finalStateDigest,
    offsetRecords,
    prefixes: replay.prefixes.map(({ index, offset, stateDigest }) => ({
      index,
      offset,
      stateDigest,
    })),
    status: "ready",
  };
}

function healthPayload() {
  return {
    checkpoint,
    metrics: { ...metrics },
    observedCount: observedEventIds.length,
    pid: process.pid,
    ready,
    role: "e0-t07-follower",
    sourceStream,
    stateAuthority: "durable-streams",
  };
}

function observeRecords(records) {
  for (const record of records) {
    const eventId = record?.event?.eventId;
    if (typeof eventId !== "string" || observedEventIdSet.has(eventId))
      continue;
    observedEventIdSet.add(eventId);
    observedEventIds.push(eventId);
  }
}

async function readCheckpoint() {
  try {
    const value = JSON.parse(await readFile(checkpointFile, "utf8"));
    return validateE0T07Checkpoint(value, { sourceStream });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return createE0T07Checkpoint({ sourceStream, offset: "-1" });
    }
    throw error;
  }
}

async function persistCheckpoint(value) {
  await mkdir(path.dirname(checkpointFile), { recursive: true });
  const temporaryFile = `${checkpointFile}.${process.pid}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(value)}\n`, "utf8");
  await rename(temporaryFile, checkpointFile);
}

async function shutdown() {
  if (closing) return;
  closing = true;
  followSession?.cancel("follower shutdown");
  try {
    await followSession?.closed;
  } catch {
    // Cancellation is the expected close path.
  }
  store.close();
  await new Promise((resolve) => {
    server.close(resolve);
  });
}

function parseOptions(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--"))
      throw new Error(`unknown argument ${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    result[toCamel(argument.slice(2))] = value;
    index += 1;
  }
  return result;
}

function toCamel(value) {
  return value.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

function parsePort(value, label) {
  const portNumber = Number(value);
  if (
    !Number.isInteger(portNumber) ||
    portNumber < 1024 ||
    portNumber > 65535
  ) {
    throw new Error(`${label} must be an integer port from 1024 through 65535`);
  }
  return portNumber;
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function listen(serverToStart, listenHost, listenPort) {
  return new Promise((resolve, reject) => {
    serverToStart.once("error", reject);
    serverToStart.listen(listenPort, listenHost, resolve);
  });
}
