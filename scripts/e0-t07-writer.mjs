import { createServer } from "node:http";

import { createDurableStreamsStore } from "@stream-slack/durable-streams";

import { canonicalSha256 } from "../src/ledger/canonical-json.mjs";
import { createDispatchDoor } from "../src/ledger/dispatch.mjs";

const options = parseOptions(process.argv.slice(2));
const host = options.host ?? process.env.E0_T07_HOST ?? "127.0.0.1";
const port = parsePort(options.port ?? process.env.E0_T07_PORT, "port");
const baseUrl = options.baseUrl ?? process.env.E0_T07_BASE_URL;
const token = options.token ?? process.env.E0_T07_TOKEN;
const producerId = options.producerId ?? process.env.E0_T07_PRODUCER_ID;
const idempotencyStream =
  options.idempotencyStream ?? process.env.E0_T07_IDEMPOTENCY_STREAM;
const producerEpoch = Number(
  options.producerEpoch ?? process.env.E0_T07_PRODUCER_EPOCH ?? 0,
);

if (!baseUrl || !token || !producerId || !idempotencyStream) {
  throw new Error(
    "writer requires baseUrl, token, producerId, and idempotencyStream",
  );
}
if (!Number.isSafeInteger(producerEpoch) || producerEpoch < 0) {
  throw new Error("producerEpoch must be a non-negative integer");
}

const store = createDurableStreamsStore({
  baseUrl,
  digestRecords: canonicalSha256,
  fetchFn: globalThis.fetch,
  token,
});
const door = createDispatchDoor({
  idempotencyStream,
  producerEpoch,
  producerId,
  streamStore: store,
});
const server = createServer((request, response) => {
  void handleRequest(request, response);
});
let closing = false;

await listen(server, host, port);
console.log(
  JSON.stringify({
    idempotencyStream,
    pid: process.pid,
    producerEpoch,
    producerId,
    ready: true,
  }),
);

process.once("SIGTERM", () => {
  void shutdown();
});
process.once("SIGINT", () => {
  void shutdown();
});

async function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        idempotencyStream,
        pid: process.pid,
        producerEpoch,
        producerId,
        ready: !closing,
        role: "e0-t07-writer",
        stateAuthority: "durable-streams",
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/dispatch") {
      const requestBody = await readJsonBody(request);
      try {
        const result = await door.dispatch(requestBody);
        sendJson(response, 200, {
          ok: true,
          ...result,
          request: requestBody,
          writer: producerId,
        });
      } catch (error) {
        if (String(error?.code ?? "").startsWith("DISPATCH_")) {
          sendJson(response, error.statusCode ?? 409, {
            ok: false,
            refusal: error.toJSON?.() ?? {
              code: error.code,
              detail: error.message,
            },
            request: requestBody,
            writer: producerId,
          });
          return;
        }
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : String(error),
          ok: false,
          request: requestBody,
          writer: producerId,
        });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/stop") {
      sendJson(response, 200, { ok: true });
      void shutdown();
      return;
    }
    sendJson(response, 404, { error: "not_found", ok: false });
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    });
  }
}

async function shutdown() {
  if (closing) return;
  closing = true;
  door.close();
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

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
