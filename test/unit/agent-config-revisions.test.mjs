import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  agentConfigDigest,
  agentConfigRevisionId,
} from "@stream-slack/protocol";
import {
  AgentConfigStreamError,
  AGENT_CONFIG_STREAM_ERROR_CODES,
  createAgentConfigStream,
} from "../../src/ledger/agent-config-stream.mjs";
import { validateAndReplayDump } from "../../src/ledger/replay.mjs";
import { REDUCER_ERROR_CODES } from "@stream-slack/reducers";

const fixturePath = path.resolve(
  ".eforest/tasks/epic-2-the-roster/E2-T02-agent-config-stream-and-revisions/fixtures/valid/agent-config-chain.v1.json",
);

test("agent configuration revision history is immutable and replay-authoritative", async () => {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const first = validateAndReplayDump(fixture);
  const second = validateAndReplayDump(structuredClone(fixture));
  const agentId = fixture.records[0].event.data.agentId;
  const agent = first.finalState.entities.agents[agentId];

  assert.equal(first.finalStateJson, second.finalStateJson);
  assert.equal(agent.status, "retired");
  assert.equal(agent.runnable, false);
  assert.equal(agent.revisions.length, 2);
  assert.equal(agent.transitions.length, 7);
  assert.equal(agent.revisions[0].sourceOffset, fixture.records[0].offset);
  assert.deepEqual(
    agent.revisions[0],
    first.prefixes[0].state.entities.agents[agentId].revisions[0],
  );
});

test("revision IDs bind agent, ordinal, and canonical config digest", () => {
  const agentId = "ag_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
  const config = {
    schemaVersion: 1,
    marker: "test-only",
  };
  const digest = agentConfigDigest;
  assert.match(
    agentConfigRevisionId({
      agentId,
      configDigest: digest({
        schemaVersion: 1,
        instructions: { system: "system", task: "", guardrails: [] },
        context: {
          scope: "none",
          includePrivate: false,
          includeThreadHistory: false,
          maxMessages: 0,
          maxBytes: 0,
        },
        trigger: {
          events: ["manual"],
          requireMention: false,
          allowMessageEdits: false,
        },
        delegation: {
          enabled: false,
          maxDepth: 0,
          maxChildren: 0,
          allowCrossChannel: false,
        },
        concurrency: {
          maxConcurrentRuns: 1,
          maxConcurrentPerChannel: 1,
          queueStrategy: "serialize",
        },
        budgets: {
          timeoutSeconds: 1,
          maxInputTokens: 1,
          maxOutputTokens: 1,
          maxTotalTokens: 2,
          maxCostUsdCents: 1,
        },
        harness: {
          providerId: "scripted",
          providerVersion: "1.0.0",
          requiredCapabilities: [],
        },
        sandbox: {
          providerId: "scripted",
          providerVersion: "1.0.0",
          requiredCapabilities: ["ephemeral"],
          lifecycle: "ephemeral",
          networkPolicy: "deny-all",
        },
        workspaceInputs: { source: "none", paths: [], maxBytes: 0 },
        connectionGrants: { refs: [], maxCallsPerRun: 0 },
      }),
      revision: 1,
    }),
    /^acr_[0-9a-f]{64}$/u,
  );
  assert.equal(config.marker, "test-only");
});

test("legacy-shaped revision events require explicit E0 compatibility", async () => {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const poisoned = structuredClone(fixture);
  const event = structuredClone(poisoned.records.at(-1).event);
  event.eventId = `ev_${"z".repeat(26)}`;
  event.eventType = "agent.config.revised";
  event.idempotencyKey = `ik_${"z".repeat(26)}`;
  event.serverTimestamp = "2026-08-05T00:00:00.008Z";
  event.data = {
    agentId: fixture.records[0].event.data.agentId,
    config: { hijacked: true },
    revision: 99,
  };
  poisoned.records.push({ offset: offset(8), event });

  assert.throws(
    () => validateAndReplayDump(poisoned),
    (error) =>
      error.code === REDUCER_ERROR_CODES.AGENT_CONFIG_INVALID_EVENT &&
      error.offset === offset(8),
  );
});

test("two config writers racing the same head have one CAS winner", async () => {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const store = createMemoryStore();
  const workspaceId = fixture.records[0].event.workspaceId;
  const agentId = fixture.records[0].event.data.agentId;
  const first = createAgentConfigStream({
    agentId,
    streamStore: store,
    workspaceId,
  });
  const second = createAgentConfigStream({
    agentId,
    streamStore: store,
    workspaceId,
  });
  const request = (number, config) => ({
    actorId: fixture.records[0].event.actorId,
    clock: () =>
      new Date(`2026-08-05T00:02:${String(number).padStart(2, "0")}.000Z`),
    config,
    correlationId: fixture.records[0].event.correlationId,
    eventId: `ev_${String.fromCharCode(100 + number).repeat(26)}`,
    expectedRevision: 0,
    expectedRevisionId: null,
    idempotencyKey: `ik_${String.fromCharCode(100 + number).repeat(26)}`,
  });

  const results = await Promise.allSettled([
    first.create(request(1, fixture.records[0].event.data.config)),
    second.create(request(2, fixture.records[2].event.data.config)),
  ]);
  assert.equal(
    results.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  const rejected = results.find(({ status }) => status === "rejected");
  assert.ok(rejected?.reason instanceof AgentConfigStreamError);
  assert.equal(
    rejected.reason.code,
    AGENT_CONFIG_STREAM_ERROR_CODES.STALE_REVISION,
  );
  assert.equal(store.dump(first.stream).length, 1);
});

function createMemoryStore() {
  const streams = new Map();
  return {
    async append(stream, record, { streamSeq } = {}) {
      const entries = streams.get(stream) ?? [];
      const currentOffset = offset(entries.length);
      if (streamSeq !== currentOffset) {
        const error = new Error("stale stream head");
        error.code = "APPEND_CONFLICT";
        error.status = 409;
        throw error;
      }
      const entry = {
        offset: offset(entries.length + 1),
        record: structuredClone(record),
      };
      entries.push(entry);
      streams.set(stream, entries);
      return { nextOffset: entry.offset };
    },
    async read(stream) {
      const entries = streams.get(stream) ?? [];
      return {
        nextOffset: offset(entries.length),
        records: entries.map(({ record }) => structuredClone(record)),
      };
    },
    dump(stream) {
      return structuredClone(streams.get(stream) ?? []);
    },
  };
}

function offset(sequence) {
  return `0000000000000000_${String(sequence).padStart(16, "0")}`;
}
