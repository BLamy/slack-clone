import assert from "node:assert/strict";
import test from "node:test";

import { createDurableStreamsStore } from "@stream-slack/durable-streams";
import {
  createEditedMessage,
  createMessageRecord,
  messageOwnedBy,
  normalizeRoomId,
} from "@stream-slack/protocol";
import { materializeMessages } from "@stream-slack/reducers";
import { createChatService } from "@stream-slack/services";

import {
  spawnLogged,
  stop,
  waitForExit,
} from "../../scripts/process-utils.mjs";
import { createRunContext } from "../../scripts/run-context.mjs";
import { startStack } from "../../scripts/test-stack.mjs";
import { analyzeModuleSource } from "../../tools/import-analysis.mjs";

const ada = {
  sub: "auth0|ada",
  name: "Ada Lovelace",
  email: "ada@example.test",
};

test("protocol functions are deterministic when ID and time are injected", () => {
  assert.equal(normalizeRoomId(" Team / Launch "), "team-launch");
  assert.equal(normalizeRoomId("///"), "durable-streams-demo");

  const message = createMessageRecord({
    roomId: " Team / Launch ",
    input: { text: "  hello  " },
    user: ada,
    id: "message-1",
    timestamp: "2026-08-01T00:00:00.000Z",
  });
  assert.deepEqual(message, {
    id: "message-1",
    room: "team-launch",
    actorId: "auth0|ada",
    user: "Ada Lovelace",
    email: "ada@example.test",
    text: "hello",
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  assert.equal(messageOwnedBy(message, ada), true);
  assert.equal(messageOwnedBy(message, { ...ada, sub: "auth0|linus" }), false);
  assert.equal(
    messageOwnedBy(
      { ...message, actorId: "", email: ada.email },
      { ...ada, sub: "different" },
    ),
    true,
  );
  assert.equal(
    messageOwnedBy({ ...message, actorId: "", email: "" }, ada),
    false,
  );

  assert.deepEqual(
    createEditedMessage({
      current: message,
      messageId: message.id,
      input: { text: " updated " },
      timestamp: "2026-08-01T00:01:00.000Z",
    }),
    {
      ...message,
      text: "updated",
      editedAt: "2026-08-01T00:01:00.000Z",
    },
  );
  assert.throws(
    () =>
      createMessageRecord({
        roomId: "demo",
        input: { text: " " },
        user: ada,
        id: "x",
        timestamp: "t",
      }),
    (error) =>
      error.statusCode === 400 && error.message === "Message text is required",
  );
});

test("message reducer keeps the latest record for each stable ID", () => {
  const records = [
    { id: "one", text: "before" },
    null,
    { ignored: true },
    { id: "two", text: "second" },
    { id: "one", text: "after", editedAt: "now" },
  ];
  assert.deepEqual(materializeMessages(records), [
    { id: "one", text: "after", editedAt: "now" },
    { id: "two", text: "second" },
  ]);
});

test("boundary parser catches formatter-ignored and ambient capabilities", () => {
  const analysis = analyzeModuleSource(`
// prettier-ignore
import"node:fs"; export { value } from "@stream-slack/http";
globalThis.fetch("https://invalid.test");
process["env"].TOKEN;
import("node:net");
`);
  assert.deepEqual(analysis.imports, [
    "node:fs",
    "@stream-slack/http",
    "node:net",
  ]);
  assert.deepEqual(analysis.ambientCapabilities.sort(), [
    "ambient global globalThis",
    "dynamic import",
    "environment",
  ]);
});

test("boundary parser catches aliased and computed ambient capabilities", () => {
  const analysis = analyzeModuleSource(`
const verifierGlobal = globalThis;
const verifierFetch = verifierGlobal?.["fe" + "tch"];
const processAlias = process;
const directFetchAlias = fetch;
const mathAlias = Math;
export function verifierCapabilityFixture(url) {
  processAlias["e" + "nv"];
  mathAlias.random();
  directFetchAlias;
  return verifierFetch?.(url);
}
`);
  assert.deepEqual(analysis.ambientCapabilities.sort(), [
    "ambient global globalThis",
    "dynamic property access",
    "environment",
    "network",
    "randomness",
  ]);
});

test("boundary parser permits injected names and deterministic globals", () => {
  const analysis = analyzeModuleSource(`
export function mapInjected(records, fetch, clock) {
  const byId = new Map(records.map((record) => [String(record.id), record]));
  return { byId, value: fetch(clock()) };
}
`);
  assert.deepEqual(analysis, { imports: [], ambientCapabilities: [] });
});

test("boundary parser rejects module metadata and unknown provider globals", () => {
  const analysis = analyzeModuleSource(`
export const moduleUrl = import.meta.url;
export const provider = workspaceProvider;
`);
  assert.deepEqual(analysis.ambientCapabilities.sort(), [
    "ambient global workspaceProvider",
    "module metadata",
  ]);
});

test("boundary parser rejects constructor and prototype reflection escapes", () => {
  const analysis = analyzeModuleSource(`
const capabilityFactory = (() => {}).constructor;
const computedFactory = (() => {})["con" + "structor"];
const reflected = Object.getPrototypeOf(() => {});
const reflectedAgain = Reflect.getPrototypeOf(() => {});
const proxied = new Proxy({}, {});
const sharedSymbol = Symbol.for("fixture");
export function latentResolver() {
  return capabilityFactory("return globalThis.fetch");
}
`);
  assert.deepEqual(analysis.ambientCapabilities.sort(), [
    "dynamic code",
    "dynamic property access",
    "metaprogramming",
    "process-wide state",
    "prototype reflection",
  ]);
});

test("boundary parser allows static data properties and numeric indices", () => {
  const analysis = analyzeModuleSource(`
export function selectRecord(records) {
  const first = records[0];
  return { id: first.id, text: first["text"] };
}
`);
  assert.deepEqual(analysis, { imports: [], ambientCapabilities: [] });
});

test("port leases prevent identical probe candidates from colliding", async () => {
  const contexts = [];
  try {
    contexts.push(
      ...(await Promise.all([
        createRunContext({
          env: { TEST_RUN_ID: "lease-race-a" },
          random: () => 0.25,
        }),
        createRunContext({
          env: { TEST_RUN_ID: "lease-race-b" },
          random: () => 0.25,
        }),
      ])),
    );
    const portsA = [
      contexts[0].emulatorPort,
      contexts[0].auth0Port,
      contexts[0].appPort,
    ];
    const portsB = [
      contexts[1].emulatorPort,
      contexts[1].auth0Port,
      contexts[1].appPort,
    ];
    assert.equal(
      portsA.some((port) => portsB.includes(port)),
      false,
    );
  } finally {
    await Promise.all(contexts.map((context) => context.releasePortLease()));
  }
});

test("port leases coordinate independent allocator processes", async () => {
  const runContextUrl = new URL(
    "../../scripts/run-context.mjs",
    import.meta.url,
  ).href;
  const childSource = `
import { createRunContext } from ${JSON.stringify(runContextUrl)};
const context = await createRunContext({
  env: { TEST_RUN_ID: process.env.LEASE_TEST_ID },
  random: () => 0.5,
});
console.log("LEASE_CONTEXT " + JSON.stringify({
  emulatorPort: context.emulatorPort,
  auth0Port: context.auth0Port,
  appPort: context.appPort,
}));
await new Promise((resolve) => setTimeout(resolve, 1500));
await context.releasePortLease();
`;
  const runAllocator = async (name) => {
    const child = spawnLogged(
      process.execPath,
      ["--input-type=module", "--eval", childSource],
      {
        name,
        env: { ...process.env, LEASE_TEST_ID: name },
      },
    );
    const result = await waitForExit(child);
    assert.equal(result.code, 0);
    const match = result.output.match(/LEASE_CONTEXT (\{[^\n]+\})/u);
    assert.ok(match, `missing lease context in ${result.output}`);
    return JSON.parse(match[1]);
  };
  const [contextA, contextB] = await Promise.all([
    runAllocator("lease-process-a"),
    runAllocator("lease-process-b"),
  ]);
  const portsA = Object.values(contextA);
  const portsB = Object.values(contextB);
  assert.equal(
    portsA.some((port) => portsB.includes(port)),
    false,
  );
});

test("Durable Streams adapter receives provider capabilities through injection", async () => {
  const requests = [];
  const responses = [
    new Response(null, { status: 201 }),
    new Response(JSON.stringify([{ id: "one", text: "hello" }]), {
      status: 200,
      headers: { "Stream-Next-Offset": "offset-1" },
    }),
  ];
  const store = createDurableStreamsStore({
    baseUrl: "http://streams.invalid",
    token: "fixture-token",
    digestRecords: (records) => `digest:${records.length}`,
    fetchFn: async (url, init) => {
      requests.push({ url, init });
      return responses.shift();
    },
  });

  const result = await store.read("Demo Room", "-1");
  assert.equal(
    requests[0].url,
    "http://streams.invalid/rooms/demo-room/messages",
  );
  assert.equal(requests[0].init.method, "PUT");
  assert.equal(
    requests[1].url,
    "http://streams.invalid/rooms/demo-room/messages?offset=-1",
  );
  assert.equal(requests[1].init.headers.Authorization, "Bearer fixture-token");
  assert.deepEqual(result.messages, [{ id: "one", text: "hello" }]);
  assert.equal(result.nextOffset, "offset-1");
  assert.equal(result.streamDigest, "digest:1");
});

test("chat service preserves append and owner-only edit behavior", async () => {
  const records = [];
  const appended = [];
  const streamStore = {
    ensure: async () => {},
    remove: async () => {},
    read: async () => ({ records, messages: materializeMessages(records) }),
    append: async (_room, record) => {
      records.push(record);
      appended.push(record);
      return { message: record, nextOffset: `offset-${appended.length}` };
    },
  };
  const timestamps = ["2026-08-01T00:00:00.000Z", "2026-08-01T00:01:00.000Z"];
  const service = createChatService({
    streamStore,
    randomId: () => "message-1",
    now: () => timestamps.shift(),
  });

  const created = await service.appendMessage("demo", { text: "before" }, ada);
  assert.equal(created.message.actorId, ada.sub);
  await assert.rejects(
    service.updateMessage(
      "demo",
      "message-1",
      { text: "attacker" },
      { ...ada, sub: "auth0|linus" },
    ),
    (error) => error.statusCode === 403,
  );
  const edited = await service.updateMessage(
    "demo",
    "message-1",
    { text: "after" },
    ada,
  );
  assert.equal(edited.message.text, "after");
  assert.equal(edited.message.editedAt, "2026-08-01T00:01:00.000Z");
});

for (const failingChild of ["emulator", "app"]) {
  test(`startup failure in ${failingChild} stops only its managed sibling`, async () => {
    const unrelated = spawnLogged(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { name: `unrelated-${failingChild}` },
    );
    let children;
    const failingSpec = {
      command: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(23), 40)"],
      name: `${failingChild}-failure-fixture`,
    };
    const waitingSpec = {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      name: `${failingChild}-sibling-fixture`,
    };
    const context = {
      appBaseUrl: "http://127.0.0.1:1",
      runId: `startup-${failingChild}`,
    };

    try {
      await assert.rejects(
        startStack(context, {
          emulatorSpec: failingChild === "emulator" ? failingSpec : waitingSpec,
          appSpec: failingChild === "app" ? failingSpec : waitingSpec,
          onSpawn: (spawned) => {
            children = spawned;
          },
          waitForReady: () => new Promise(() => {}),
        }),
        /exited unexpectedly with code 23/,
      );
      const sibling =
        failingChild === "emulator" ? children.app : children.emulator;
      const siblingExit = await waitForExit(sibling);
      assert.equal(siblingExit.signal, "SIGTERM");
      assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
    } finally {
      await stop(unrelated);
    }
  });
}
