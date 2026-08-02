import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { createDurableStreamsStore } from "@stream-slack/durable-streams";

import { canonicalSha256 } from "../src/ledger/canonical-json.mjs";
import {
  assertIdleWindowRequestConstant,
  observeHttpIdleWindow,
} from "../test/support/http-idle-probe.mjs";
import { SOURCE_AUDIT_CASES } from "../test/support/source-audit-fixtures.mjs";
import {
  analyzeDurableStreamsAccess,
  auditDurableStreamsAccess,
} from "../tools/audit-durable-streams-access.mjs";
import { createRunContext } from "./run-context.mjs";
import { startStack } from "./test-stack.mjs";

const taskEvidenceDirectory = path.resolve(
  ".eforest/tasks/epic-0-the-ledger/E0-T03-official-durable-streams-adapter/evidence",
);
const runId = safeRunId(
  process.env.TEST_RUN_ID ??
    `e0-t03-conformance-${process.pid}-${Date.now().toString(36)}`,
);
const implementationCommit = String(
  process.env.E0_T03_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }),
).trim();
assert.match(
  implementationCommit,
  /^[0-9a-f]{40}$/u,
  "E0-T03 evidence requires an exact implementation commit",
);
const artifactRoot = path.resolve(
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e0-t03", runId),
);
const context = await createRunContext({
  env: {
    ...process.env,
    TEST_ARTIFACT_DIR: artifactRoot,
    TEST_RUN_ID: runId,
  },
});
const canary = `e0t03:${crypto.randomBytes(24).toString("base64url")}/canary`;
const transcript = [];
const browserAndApiPayloads = [];
const environmentManifest = {
  schemaVersion: 1,
  task: "E0-T03",
  runId,
  implementationCommit,
  variables: {
    AUTH0_EMULATOR_URL: context.auth0EmulatorUrl,
    DURABLE_STREAMS_ADMIN_TOKEN: "[REDACTED]",
    DURABLE_STREAMS_URL: context.durableStreamsUrl,
    HOST: context.host,
    PORT: String(context.appPort),
  },
};

await mkdir(artifactRoot, { recursive: true });
await writeArtifact("environment-manifest.json", environmentManifest);

const stack = await startStack(context, {
  appSpec: {
    command: "node",
    args: ["src/server.mjs"],
    name: `app:${runId}`,
    env: {
      ...process.env,
      AUTH0_CLIENT_ID: "slack-clone-auth0",
      AUTH0_CLIENT_SECRET: "slack-clone-secret",
      AUTH0_EMULATOR_URL: context.auth0EmulatorUrl,
      AUTH0_REALM: "Username-Password-Authentication",
      DURABLE_STREAMS_ADMIN_TOKEN: canary,
      DURABLE_STREAMS_URL: context.durableStreamsUrl,
      HOST: context.host,
      PORT: String(context.appPort),
    },
  },
});

const countedFetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = String(init.method ?? "GET").toUpperCase();
  const sequence = transcript.length + 1;
  const startedAt = Date.now();
  const response = await fetch(input, init);
  transcript.push({
    sequence,
    method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    status: response.status,
    contentType: response.headers.get("content-type"),
    nextOffset: response.headers.get("stream-next-offset"),
    streamClosed: response.headers.get("stream-closed"),
    durationMs: Date.now() - startedAt,
  });
  return response;
};

const store = createDurableStreamsStore({
  baseUrl: context.durableStreamsUrl,
  token: canary,
  fetchFn: countedFetch,
  digestRecords: canonicalSha256,
});

let protocolConformance;
let requestBudget;
let canaryScan;
try {
  const room = `${context.roomPrefix}-adapter`;
  await Promise.all([store.ensure(room), store.ensure(room)]);
  await store.ensure(room);

  const accepted = [
    { id: "record-1", room, text: "first accepted record" },
    { id: "record-2", room, text: "second accepted record" },
    { id: "record-3", room, text: "third accepted record" },
  ];
  const appendResults = [];
  for (const record of accepted) {
    appendResults.push(await store.append(room, record));
  }
  const offsets = appendResults.map((result) => result.nextOffset);
  assert.equal(new Set(offsets).size, offsets.length);

  const followed = [];
  const follow = await store.follow(room, offsets.at(-1), {
    live: "sse",
    onBatch(batch) {
      followed.push(...batch.records.map((record) => record.id));
    },
  });
  await eventually(() => store.diagnostics().pendingIdleWaiters === 1);
  const diagnosticsAtIdle = store.diagnostics();
  const requestCountAtIdle = transcript.length;
  await settleMicrotasks();
  const requestCountAfterIdleSettle = transcript.length;
  assert.equal(requestCountAfterIdleSettle, requestCountAtIdle);
  assert.ok(diagnosticsAtIdle.sseRequests <= 2);
  assert.equal(diagnosticsAtIdle.longPollRequests, 0);

  const liveRecord = {
    id: "record-live",
    room,
    text: "record accepted after the idle live reader",
  };
  const liveAppend = await store.append(room, liveRecord);
  await eventually(() => followed.includes(liveRecord.id));
  assert.equal(followed.filter((id) => id === liveRecord.id).length, 1);
  assert.equal(follow.currentOffset, liveAppend.nextOffset);
  await eventually(() => store.diagnostics().pendingIdleWaiters === 1);

  const secondLiveRecord = {
    id: "record-live-2",
    room,
    text: "second record accepted by the same live reader",
  };
  const secondLiveAppend = await store.append(room, secondLiveRecord);
  await eventually(() => followed.includes(secondLiveRecord.id));
  assert.equal(followed.filter((id) => id === secondLiveRecord.id).length, 1);
  assert.equal(follow.currentOffset, secondLiveAppend.nextOffset);
  await eventually(() => store.diagnostics().pendingIdleWaiters === 1);
  follow.cancel("conformance complete");
  follow.cancel("idempotent second cancellation");
  await follow.closed;
  await eventually(() => store.diagnostics().activeFollowers === 0);
  const requestsAtCancel = transcript.length;
  await settleMicrotasks();
  const requestsAfterCancellationSettled = transcript.length;
  assert.equal(requestsAfterCancellationSettled, requestsAtCancel);
  const diagnosticsAfterCancel = store.diagnostics();
  assert.equal(diagnosticsAfterCancel.pendingIdleWaiters, 0);

  const idleWindow = await observeHttpIdleWindow();
  assertIdleWindowRequestConstant(idleWindow);
  const pollingPositiveControl = await observeHttpIdleWindow({
    pollingMutationMs: 350,
  });
  assert.throws(
    () => assertIdleWindowRequestConstant(pollingPositiveControl),
    /additional Durable Streams adapter calls/u,
  );
  assert.equal(pollingPositiveControl.pollingTimerExecutions, 2_571);
  const malformedRetryAfter = await verifyMalformedRetryAfter();
  const redirectBoundary = await verifyRedirectBoundary();
  const wrongLiveMedia = await verifyWrongLiveMedia();

  const allAccepted = [...accepted, liveRecord, secondLiveRecord];
  const allOffsets = [
    ...offsets,
    liveAppend.nextOffset,
    secondLiveAppend.nextOffset,
  ];
  const resumeMatrix = [];
  const checkpoints = ["-1", ...allOffsets];
  for (const [index, checkpoint] of checkpoints.entries()) {
    const result = await store.read(room, checkpoint);
    const observedIds = result.records.map((record) => record.id);
    const expectedIds = allAccepted.slice(index).map((record) => record.id);
    assert.deepEqual(observedIds, expectedIds);
    assert.equal(new Set(observedIds).size, observedIds.length);
    resumeMatrix.push({
      checkpoint,
      expectedIds,
      observedIds,
      nextOffset: result.nextOffset,
      streamDigest: result.streamDigest,
    });
  }

  const createRequests = transcript.filter(
    (request) => request.method === "PUT" && request.path.includes(room),
  );
  assert.equal(createRequests.length, 1);
  const sseRequests = transcript.filter(
    (request) => request.query.live === "sse",
  );
  assert.ok(sseRequests.length <= 6);

  protocolConformance = {
    schemaVersion: 1,
    task: "E0-T03",
    runId,
    implementationCommit,
    result: "PASS",
    room,
    officialClient: "@durable-streams/client@0.2.6",
    createOnce: {
      ensureCalls: 3,
      createRequests: createRequests.length,
    },
    acceptedIds: allAccepted.map((record) => record.id),
    capturedOffsets: allOffsets,
    resumeMatrix,
    liveFollow: {
      mode: "sse",
      deliveredIds: followed,
      finalOffset: follow.currentOffset,
    },
    cancellation: {
      repeatedCancelSafe: true,
      activeFollowers: diagnosticsAfterCancel.activeFollowers,
      pendingIdleWaiters: diagnosticsAfterCancel.pendingIdleWaiters,
    },
    strictTransport: {
      malformedRetryAfter,
      redirectBoundary,
      wrongLiveMedia,
    },
    requestTranscript: transcript,
  };
  requestBudget = {
    schemaVersion: 1,
    task: "E0-T03",
    runId,
    implementationCommit,
    result: "PASS",
    requestCounter: idleWindow.boundary,
    logicalIdleDurationMs: idleWindow.logicalIdleDurationMs,
    requestsBeforeLogicalAdvance: idleWindow.callsBeforeLogicalAdvance,
    requestsAfterLogicalAdvance: idleWindow.callsAfterLogicalAdvance,
    requestDeltaWhileIdle: idleWindow.callDeltaWhileIdle,
    frozenTotalRequestCap: 24,
    totalRequests: transcript.length,
    createRequests: createRequests.length,
    sseRequests: sseRequests.length,
    requestsAtCancel,
    requestsAfterCancellationSettled,
    realEmulatorIdleObservation: {
      requestsWhenOfficialFollowParked: requestCountAtIdle,
      requestsAfterMicrotaskSettle: requestCountAfterIdleSettle,
    },
    idleWindow,
    pollingPositiveControl: {
      detectorRejected: true,
      logicalIdleDurationMs: pollingPositiveControl.logicalIdleDurationMs,
      pollingMutationMs: pollingPositiveControl.pollingMutationMs,
      pollingTimerExecutions: pollingPositiveControl.pollingTimerExecutions,
      requestDeltaWhileIdle: pollingPositiveControl.callDeltaWhileIdle,
    },
    diagnosticsAtIdle,
    diagnosticsAfterCancel,
  };
  assert.ok(requestBudget.totalRequests < requestBudget.frozenTotalRequestCap);
  await writeEvidence("protocol-conformance.json", protocolConformance);
  await writeEvidence("request-budget.json", requestBudget);

  await collectBrowserAndApiPayloads(room);
  const sourceAudit = await auditDurableStreamsAccess();
  assert.deepEqual(sourceAudit.failures, []);
  const sourceAuditSensitivity = verifySourceAuditSensitivity();
  await writeEvidence("source-access-audit.json", {
    schemaVersion: 1,
    task: "E0-T03",
    runId,
    implementationCommit,
    result: "PASS",
    ...sourceAudit,
    sensitivity: sourceAuditSensitivity,
  });
} finally {
  store.close();
  await stack.stop();
}

canaryScan = await scanForCanary({
  canary,
  artifactRoot,
  browserAndApiPayloads,
  logs: `${stack.app.outputText()}\n${stack.emulator.outputText()}`,
});
await writeEvidence("canary-scan.json", canaryScan);

const summary = {
  schemaVersion: 1,
  task: "E0-T03",
  runId,
  implementationCommit,
  result: "PASS",
  protocolConformance,
  requestBudget,
  canaryScan,
};
await writeArtifact("e0-t03-conformance-summary.json", summary);
console.log(
  `PASS E0-T03 conformance requests=${transcript.length} offsets=${protocolConformance.capturedOffsets.length} canaryMatches=0`,
);

async function verifyMalformedRetryAfter() {
  const checkpoint = "opaque-retry-checkpoint";
  const invalidCases = [];
  for (const [name, retryAfter] of [
    ["non-date", "conformance-not-a-delay"],
    ["impossible-imf-date", "Mon, 31 Feb 2026 00:00:00 GMT"],
  ]) {
    let getAttempts = 0;
    const retryStore = createRetryStore({
      checkpoint,
      retryAfter,
      onGet: () => {
        getAttempts += 1;
        return getAttempts;
      },
    });
    try {
      let observed;
      try {
        await retryStore.read(`strict-retry-${name}`, "-1");
      } catch (error) {
        observed = error;
      }
      assert.equal(observed?.code, "INVALID_RETRY_AFTER");
      assert.equal(observed?.status, 503);
      assert.equal(getAttempts, 1);
      invalidCases.push({
        name,
        retryAfter,
        rejectionCode: observed.code,
        responseStatus: observed.status,
        getAttempts,
        silentlyRetried: false,
      });
    } finally {
      retryStore.close();
    }
  }

  let validGetAttempts = 0;
  const validStore = createRetryStore({
    checkpoint,
    retryAfter: "Thu, 01 Jan 1970 00:00:00 GMT",
    onGet: () => {
      validGetAttempts += 1;
      return validGetAttempts;
    },
  });
  try {
    const result = await validStore.read("strict-retry-valid-date", "-1");
    assert.deepEqual(result.records, []);
    assert.equal(validGetAttempts, 2);
  } finally {
    validStore.close();
  }

  return {
    malformedValue: "[MALFORMED]",
    rejectionCode: invalidCases[0].rejectionCode,
    responseStatus: invalidCases[0].responseStatus,
    getAttempts: invalidCases[0].getAttempts,
    silentlyRetried: false,
    invalidCases,
    canonicalHttpDate: {
      retryAfter: "Thu, 01 Jan 1970 00:00:00 GMT",
      accepted: true,
      getAttempts: validGetAttempts,
    },
  };
}

function createRetryStore({ checkpoint, retryAfter, onGet }) {
  return createDurableStreamsStore({
    baseUrl: "http://streams.invalid",
    token: "protocol-double-token",
    digestRecords: canonicalSha256,
    backoffOptions: {
      initialDelay: 0,
      maxDelay: 0,
      multiplier: 1,
      maxRetries: 2,
    },
    fetchFn: async (_input, init = {}) => {
      if (init.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "Stream-Next-Offset": checkpoint },
        });
      }
      if (onGet() === 1) {
        return new Response("busy", {
          status: 503,
          headers: { "Retry-After": retryAfter },
        });
      }
      return new Response("[]", {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Stream-Next-Offset": checkpoint,
          "Stream-Up-To-Date": "true",
        },
      });
    },
  });
}

async function verifyWrongLiveMedia() {
  const checkpoint = "opaque-live-media-checkpoint";
  let liveRequests = 0;
  const liveResponse = new Response("event: control\ndata: {}\n\n", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  const mediaStore = createDurableStreamsStore({
    baseUrl: "http://streams.invalid",
    token: "protocol-double-token",
    digestRecords: canonicalSha256,
    backoffOptions: {
      initialDelay: 0,
      maxDelay: 0,
      multiplier: 1,
      maxRetries: 0,
    },
    fetchFn: async (input, init = {}) => {
      if (init.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "Stream-Next-Offset": checkpoint },
        });
      }
      const url = new URL(String(input));
      if (url.searchParams.get("live") !== "sse") {
        return new Response("[]", {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Stream-Next-Offset": checkpoint,
            "Stream-Up-To-Date": "true",
          },
        });
      }
      liveRequests += 1;
      return liveResponse.clone();
    },
  });
  let timeout;
  try {
    const follow = await mediaStore.follow("strict-live-media", checkpoint, {
      onBatch() {},
    });
    let observed;
    try {
      await Promise.race([
        follow.closed,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("follow.closed did not settle")),
            1_000,
          );
        }),
      ]);
    } catch (error) {
      observed = error;
    }
    assert.equal(observed?.code, "CONTENT_TYPE_MISMATCH");
    assert.equal(observed?.status, 200);
    assert.equal(liveRequests, 1);
    return {
      responseContentType: "application/json",
      rejectionCode: observed.code,
      responseStatus: observed.status,
      liveRequests,
      closedSettled: true,
    };
  } finally {
    clearTimeout(timeout);
    mediaStore.close();
    await liveResponse.body?.cancel();
  }
}

async function verifyRedirectBoundary() {
  let sourceRequests = 0;
  let targetRequests = 0;
  const target = await listenOnLoopback((_request, response) => {
    targetRequests += 1;
    response.writeHead(200, {
      "Stream-Next-Offset": "opaque-redirect-target",
    });
    response.end();
  });
  const source = await listenOnLoopback((_request, response) => {
    sourceRequests += 1;
    response.writeHead(307, {
      Connection: "close",
      Location: `${target.origin}/redirect-target`,
    });
    response.end();
  });
  const redirectStore = createDurableStreamsStore({
    baseUrl: source.origin,
    token: "protocol-double-token",
    fetchFn: fetch,
    digestRecords: canonicalSha256,
  });
  try {
    let observed;
    try {
      await redirectStore.ensure("redirect-boundary");
    } catch (error) {
      observed = error;
    }
    assert.equal(observed?.code, "ORIGIN_VIOLATION");
    assert.equal(observed?.status, 307);
    assert.equal(sourceRequests, 1);
    assert.equal(targetRequests, 0);
    return {
      configuredOriginRequests: sourceRequests,
      redirectedOriginRequests: targetRequests,
      rejectionCode: observed.code,
      responseStatus: observed.status,
      targetReceivedRequest: false,
    };
  } finally {
    redirectStore.close();
    await Promise.all([source.close(), target.close()]);
  }
}

function verifySourceAuditSensitivity() {
  const fixtures = {
    direct: `
      const durableStreamsUrl = "http://streams.invalid";
      fetch(durableStreamsUrl + "/rooms/direct/messages");
    `,
    destructured: `
      const { fetch: send } = globalThis;
      const durableStreamsUrl = "http://streams.invalid";
      send(durableStreamsUrl + "/rooms/destructured/messages");
    `,
    assigned: `
      let send;
      ({ fetch: send } = globalThis);
      const config = { durableStreamsUrl: "http://streams.invalid" };
      const { durableStreamsUrl: provider } = config;
      send(provider + "/rooms/assigned/messages");
    `,
    bound: `
      const send = globalThis.fetch.bind(globalThis);
      const streamOrigin = "http://streams.invalid";
      send(streamOrigin + "/rooms/bound/messages");
    `,
    twoStepGlobal: `
      const runtime = globalThis;
      const dispatch = runtime.fetch;
      const streamOrigin = "http://streams.invalid";
      dispatch(streamOrigin + "/rooms/two-step/messages");
    `,
    fetchCall: `
      const durableStreamsUrl = "http://streams.invalid";
      globalThis.fetch.call(
        globalThis,
        durableStreamsUrl + "/rooms/fetch-call/messages",
      );
    `,
    fetchApply: `
      const streamOrigin = "http://streams.invalid";
      globalThis.fetch.apply(globalThis, [
        streamOrigin + "/rooms/fetch-apply/messages",
      ]);
    `,
    reflectApply: `
      const streamOrigin = "http://streams.invalid";
      Reflect.apply(globalThis.fetch, globalThis, [
        streamOrigin + "/rooms/reflect-apply/messages",
      ]);
    `,
    wrapperFunction: `
      const send = (...args) => globalThis.fetch(...args);
      const durableStreamsUrl = "http://streams.invalid";
      send(durableStreamsUrl + "/rooms/wrapper/messages");
    `,
    objectPropertyAssignment: `
      const transport = {};
      transport.send = globalThis.fetch;
      const durableStreamsUrl = "http://streams.invalid";
      transport.send(durableStreamsUrl + "/rooms/member/messages");
    `,
    templateComputed: `
      const runtime = globalThis;
      const send = runtime[\`fetch\`];
      const durableStreamsUrl = "http://streams.invalid";
      send(durableStreamsUrl + "/rooms/template/messages");
    `,
    reflectApplyAlias: `
      const invoke = Reflect.apply;
      const streamOrigin = "http://streams.invalid";
      invoke(globalThis.fetch, globalThis, [
        streamOrigin + "/rooms/reflect-alias/messages",
      ]);
    `,
    boundReflectApplyAlias: `
      const invoke = Reflect.apply.bind(Reflect);
      const streamOrigin = "http://streams.invalid";
      invoke(globalThis.fetch, globalThis, [
        streamOrigin + "/rooms/bound-reflect/messages",
      ]);
    `,
    callAlias: `
      const invoke = Function.prototype.call.bind(globalThis.fetch);
      const streamOrigin = "http://streams.invalid";
      invoke(streamOrigin + "/rooms/call-alias/messages");
    `,
    applyAlias: `
      const invoke = Function.prototype.apply.bind(
        globalThis.fetch,
        globalThis,
      );
      const streamOrigin = "http://streams.invalid";
      invoke([streamOrigin + "/rooms/apply-alias/messages"]);
    `,
    forwardNestedWrapper: `
      function send(...args) {
        return nested(...args);
      }
      function nested(...args) {
        return globalThis.fetch(...args);
      }
      const streamOrigin = "http://streams.invalid";
      send(streamOrigin + "/rooms/forward-wrapper/messages");
    `,
    higherOrderWrapper: `
      const wrap = (callable) => (...args) => callable(...args);
      const send = wrap(globalThis.fetch);
      const streamOrigin = "http://streams.invalid";
      send(streamOrigin + "/rooms/higher-order/messages");
    `,
    aliasedMemberContainer: `
      const transport = { send: globalThis.fetch };
      const alias = transport;
      const streamOrigin = "http://streams.invalid";
      alias.send(streamOrigin + "/rooms/aliased-member/messages");
    `,
    reverseAliasedMemberContainer: `
      const transport = {};
      const alias = transport;
      alias.send = globalThis.fetch;
      const streamOrigin = "http://streams.invalid";
      transport.send(streamOrigin + "/rooms/reverse-alias/messages");
    `,
    nestedObjectMember: `
      const transport = { nested: { send: globalThis.fetch } };
      const streamOrigin = "http://streams.invalid";
      transport.nested.send(streamOrigin + "/rooms/nested-member/messages");
    `,
    arrayMember: `
      const transports = [globalThis.fetch];
      const streamOrigin = "http://streams.invalid";
      transports[0](streamOrigin + "/rooms/array-member/messages");
    `,
    arrayDestructuring: `
      const transports = [globalThis.fetch];
      const [send] = transports;
      const streamOrigin = "http://streams.invalid";
      send(streamOrigin + "/rooms/array-destructuring/messages");
    `,
    objectDestructuring: `
      const transport = { send: globalThis.fetch };
      const { send } = transport;
      const streamOrigin = "http://streams.invalid";
      send(streamOrigin + "/rooms/object-destructuring/messages");
    `,
    classStaticField: `
      class Transport {
        static send = globalThis.fetch;
      }
      const streamOrigin = "http://streams.invalid";
      Transport.send(streamOrigin + "/rooms/static-field/messages");
    `,
    classStaticMethod: `
      class Transport {
        static send(...args) {
          return globalThis.fetch(...args);
        }
      }
      const streamOrigin = "http://streams.invalid";
      Transport.send(streamOrigin + "/rooms/static-method/messages");
    `,
    classInstanceField: `
      class Transport {
        send = globalThis.fetch;
      }
      const transport = new Transport();
      const streamOrigin = "http://streams.invalid";
      transport.send(streamOrigin + "/rooms/instance-field/messages");
    `,
    dynamicComputedFetch: `
      const method = Math.random() > -1 ? "fetch" : "request";
      const streamOrigin = "http://streams.invalid";
      globalThis[method](streamOrigin + "/rooms/dynamic-fetch/messages");
    `,
    dynamicComputedProvider: `
      const config = {
        endpoint: "http://streams.invalid/rooms/dynamic-provider/messages",
      };
      const key = "endpoint";
      globalThis.fetch(config[key]);
    `,
  };
  const detections = Object.fromEntries(
    Object.entries(fixtures).map(([name, source]) => [
      name,
      analyzeDurableStreamsAccess(source, `${name}-sensitivity.mjs`).map(
        (violation) => violation.kind,
      ),
    ]),
  );
  for (const result of Object.values(detections)) {
    assert.deepEqual(result, ["direct-provider-network"]);
  }
  const interproceduralDetections = Object.fromEntries(
    SOURCE_AUDIT_CASES.map(({ name, source, expectedKinds }) => {
      const observed = analyzeDurableStreamsAccess(
        source,
        `${name}-sensitivity.mjs`,
      ).map((violation) => violation.kind);
      assert.deepEqual(observed, expectedKinds, name);
      return [name, observed];
    }),
  );
  return {
    result: "PASS",
    fixtures: [
      ...Object.keys(fixtures),
      ...SOURCE_AUDIT_CASES.map(({ name }) => name),
    ],
    detections: { ...detections, ...interproceduralDetections },
  };
}

async function listenOnLoopback(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}

async function collectBrowserAndApiPayloads(room) {
  for (const pathname of [
    "/",
    "/app.js",
    "/application-api.js",
    "/styles.css",
    "/api/health",
  ]) {
    const response = await fetch(`${context.appBaseUrl}${pathname}`);
    const body = await response.text();
    assert.ok(response.ok);
    browserAndApiPayloads.push({ pathname, body });
  }

  const login = await fetch(`${context.appBaseUrl}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: "ada@example.test",
      password: "DemoPass123",
      returnTo: `/app?room=${room}`,
    }),
  });
  assert.equal(login.status, 302);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  for (const pathname of [
    "/api/session",
    `/api/rooms/${encodeURIComponent(room)}/messages`,
  ]) {
    const response = await fetch(`${context.appBaseUrl}${pathname}`, {
      headers: { Cookie: cookie },
    });
    const body = await response.text();
    assert.ok(response.ok);
    browserAndApiPayloads.push({ pathname, body });
  }
}

async function scanForCanary({
  canary: secret,
  artifactRoot: artifacts,
  browserAndApiPayloads: payloads,
  logs,
}) {
  const variants = [
    secret,
    encodeURIComponent(secret),
    Buffer.from(secret).toString("base64"),
  ];
  const positiveControlDetections = variants.map((variant) =>
    countVariantMatches(`planted-browser-fixture=${variant}`, variants),
  );
  assert.ok(
    positiveControlDetections.every((matches) => matches > 0),
    "token canary scanner did not detect its positive controls",
  );
  const categories = {
    browserAssetsAndApi: payloads.map(({ pathname, body }) => ({
      label: pathname,
      value: body,
    })),
    logs: [{ label: "app-and-emulator-logs", value: logs }],
    environmentManifests: [
      {
        label: "environment-manifest.json",
        value: await readFile(
          path.join(artifacts, "environment-manifest.json"),
          "utf8",
        ),
      },
    ],
    runArtifacts: await readArtifactPayloads(artifacts),
  };
  const results = {};
  let totalMatches = 0;
  for (const [category, entries] of Object.entries(categories)) {
    let bytesScanned = 0;
    let matches = 0;
    for (const entry of entries) {
      bytesScanned += Buffer.byteLength(entry.value);
      matches += countVariantMatches(entry.value, variants);
    }
    totalMatches += matches;
    results[category] = { entries: entries.length, bytesScanned, matches };
  }
  assert.equal(totalMatches, 0, "Durable Streams token canary leaked");
  return {
    schemaVersion: 1,
    task: "E0-T03",
    runId,
    implementationCommit,
    result: "PASS",
    canarySha256: crypto.createHash("sha256").update(secret).digest("hex"),
    encodingsScanned: ["raw", "url-encoded", "base64"],
    positiveControlDetections,
    totalMatches,
    categories: results,
  };
}

function countVariantMatches(value, variants) {
  let matches = 0;
  for (const variant of new Set(variants)) {
    if (value.includes(variant)) matches += 1;
  }
  return matches;
}

async function readArtifactPayloads(directory) {
  const entries = [];
  for (const file of await listFiles(directory)) {
    if (file.endsWith("canary-scan.json")) continue;
    entries.push({
      label: path.relative(directory, file),
      value: await readFile(file, "utf8"),
    });
  }
  return entries;
}

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(entryPath)));
    else files.push(entryPath);
  }
  return files.sort();
}

async function writeEvidence(name, value) {
  await writeArtifact(name, value);
  if (process.env.PROMOTE_EVIDENCE !== "1") return;
  await mkdir(taskEvidenceDirectory, { recursive: true });
  await writeFile(
    path.join(taskEvidenceDirectory, name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

async function writeArtifact(name, value) {
  await writeFile(
    path.join(artifactRoot, name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

async function eventually(predicate, attempts = 300) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  assert.fail("condition did not become true");
}

async function settleMicrotasks() {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

function safeRunId(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}
