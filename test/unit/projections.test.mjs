import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import test from "node:test";

import {
  assertProjectionIntegrity,
  createProjectionQueries,
  createProjectionStore,
  createProjectionWorker,
  PROJECTION_ERROR_CODES,
} from "../../src/projections.mjs";

const WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const SERVICE_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";
const CHANNEL_ID = "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const PROJECTION_ID =
  "px_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";

const conversationFixturePath =
  ".eforest/tasks/epic-1-the-workspace/E1-T04-message-thread-reaction-contract/fixtures/valid/conversation.v1.json";
const channelFixturePath =
  ".eforest/tasks/epic-1-the-workspace/E1-T03-channel-lifecycle-and-membership/fixtures/valid/channel-lifecycle.v1.json";

async function readFixture(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function sourceRecords(fixture, { workspaceId = WORKSPACE_ID } = {}) {
  let directorySequence = 0;
  let channelSequence = 0;
  const directoryEvents = new Set([
    "principal.created",
    "workspace.created",
    "workspace.membership.invited",
    "workspace.membership.accepted",
    "workspace.membership.role.changed",
    "workspace.membership.suspended",
    "workspace.membership.removed",
  ]);
  return fixture.records
    .filter((record) => record.event.workspaceId === workspaceId)
    .map((record) => {
      const isDirectory = directoryEvents.has(record.event.eventType);
      const sequence = isDirectory ? ++directorySequence : ++channelSequence;
      return {
        event: record.event,
        offset: `0000000000000000_${sequence.toString(16).padStart(16, "0")}`,
        stream: isDirectory
          ? `workspace:${workspaceId}/directory`
          : `channel:${record.event.data.channelId ?? CHANNEL_ID}`,
      };
    });
}

function newProjection(records) {
  const store = createProjectionStore({
    projectionId: PROJECTION_ID,
    workspaceId: WORKSPACE_ID,
  });
  const worker = createProjectionWorker({
    projectionId: PROJECTION_ID,
    store,
    workspaceId: WORKSPACE_ID,
  });
  return { records, store, worker };
}

test("projection deletion and full rebuild preserve the canonical manifest", async () => {
  const fixture = await readFixture(conversationFixturePath);
  const records = sourceRecords(fixture);
  const { store, worker } = newProjection(records);

  worker.rebuild(records);
  const first = assertProjectionIntegrity(store, records);
  const firstSnapshot = store.read();

  store.deleteAll();
  assert.equal(store.read().checkpoint, null);
  worker.rebuild(records);
  const second = assertProjectionIntegrity(store, records);

  assert.equal(second.projectionDigest, first.projectionDigest);
  assert.equal(second.stateDigest, first.stateDigest);
  assert.deepEqual(store.read().rows, firstSnapshot.rows);
});

test("duplicate delivery and a crash after row write converge on one checkpoint", async () => {
  const fixture = await readFixture(conversationFixturePath);
  const records = sourceRecords(fixture);
  const duplicateDelivery = [
    ...records.slice(0, 12),
    records[11],
    ...records.slice(12),
  ];
  const { store, worker } = newProjection(duplicateDelivery);

  assert.throws(
    () => worker.rebuild(duplicateDelivery, { crashAfterRowsAt: 12 }),
    (error) => error.code === PROJECTION_ERROR_CODES.CRASH_AFTER_ROW_WRITE,
  );
  assert.equal(store.read().rowsSequence, 12);
  assert.equal(store.read().checkpoint.sequence, 11);

  worker.catchUp(duplicateDelivery);
  const proof = assertProjectionIntegrity(store, records);
  assert.equal(store.read().checkpoint.sequence, records.length);
  assert.equal(proof.rowCount, 20);
});

test("source provenance, checkpoint corruption, and row corruption fail closed", async () => {
  const fixture = await readFixture(conversationFixturePath);
  const records = sourceRecords(fixture);
  const { store, worker } = newProjection(records);
  worker.rebuild(records);

  const snapshot = store.read();
  const corruptedRows = structuredClone(snapshot.rows);
  corruptedRows.message[0].source.digest =
    "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  store.writeRows(corruptedRows, snapshot.checkpoint.sequence);
  assert.throws(
    () => assertProjectionIntegrity(store, records),
    (error) =>
      error.code === PROJECTION_ERROR_CODES.CORRUPT_ROW &&
      error.detail.includes("unknown source reference"),
  );

  store.deleteAll();
  worker.rebuild(records);
  const checkpoint = store.read().checkpoint;
  assert.throws(
    () =>
      store.writeCheckpoint({
        ...checkpoint,
        stateDigest: checkpoint.checkpointDigest,
      }),
    (error) => error.code === PROJECTION_ERROR_CODES.CHECKPOINT_INVALID,
  );

  const reducerVersionRows = structuredClone(store.read().rows);
  reducerVersionRows.message[0].reducerVersion = "stream-slack-reducer-v0";
  assert.throws(
    () =>
      assertProjectionIntegrity(
        { read: () => ({ ...store.read(), rows: reducerVersionRows }) },
        records,
      ),
    (error) =>
      error.code === PROJECTION_ERROR_CODES.REDUCER_VERSION_MISMATCH &&
      error.detail.includes("unsupported reducer"),
  );
});

test("filesystem projection storage survives a worker restart and deletes completely", async () => {
  const fixture = await readFixture(conversationFixturePath);
  const records = sourceRecords(fixture);
  const directory = await mkdtemp("/tmp/stream-slack-projection-");
  try {
    const first = createProjectionStore({
      directory,
      projectionId: PROJECTION_ID,
      workspaceId: WORKSPACE_ID,
    });
    const worker = createProjectionWorker({
      projectionId: PROJECTION_ID,
      store: first,
      workspaceId: WORKSPACE_ID,
    });
    worker.rebuild(records);
    const expected = first.read();

    const restarted = createProjectionStore({
      directory,
      projectionId: PROJECTION_ID,
      workspaceId: WORKSPACE_ID,
    });
    assert.deepEqual(restarted.read(), expected);
    restarted.deleteAll();
    assert.equal(restarted.read().checkpoint, null);
    assert.equal(restarted.read().rowsSequence, 0);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("private and direct rows are filtered by current membership at query time", async () => {
  const fixture = await readFixture(channelFixturePath);
  const records = sourceRecords(fixture);
  const { store, worker } = newProjection(records);
  worker.rebuild(records);
  const queries = createProjectionQueries(store);

  const ownerChannels = queries.listChannels({
    principalId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
  });
  assert.ok(ownerChannels.some((row) => row.value.kind === "private"));
  assert.ok(ownerChannels.some((row) => row.value.kind === "direct"));
  assert.throws(
    () =>
      queries.getChannel({
        channelId: "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_22222222222222222222222222",
        principalId: SERVICE_ID,
        workspaceId: WORKSPACE_ID,
      }),
    (error) => error.code === PROJECTION_ERROR_CODES.ACCESS_DENIED,
  );
  assert.throws(
    () =>
      queries.listChannels({
        principalId: "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_ffffffffffffffffffffffffff",
        workspaceId: WORKSPACE_ID,
      }),
    (error) => error.code === PROJECTION_ERROR_CODES.ACCESS_DENIED,
  );
  assert.throws(
    () =>
      queries.listMessages({
        channelId: "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_22222222222222222222222222",
        principalId: SERVICE_ID,
        workspaceId: WORKSPACE_ID,
      }),
    (error) => error.code === PROJECTION_ERROR_CODES.ACCESS_DENIED,
  );
});
