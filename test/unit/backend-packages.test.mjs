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
import { startStack } from "../../scripts/test-stack.mjs";

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
