import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  AGENT_CONFIG_REVISION_EVENT_TYPES_V1,
  agentConfigDigest,
  agentConfigRevisionId,
  upgradeAgentConfig,
  validateAgentConfigRevisionEventData,
} from "@stream-slack/protocol";
import { REDUCER_ERROR_CODES } from "@stream-slack/reducers";

import {
  AgentConfigStreamError,
  AGENT_CONFIG_STREAM_ERROR_CODES,
  createAgentConfigStream,
} from "../src/ledger/agent-config-stream.mjs";
import { EVENT_TYPES_V1 } from "../src/ledger/envelope.mjs";
import { validateAndReplayDump } from "../src/ledger/replay.mjs";

const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-2-the-roster/E2-T02-agent-config-stream-and-revisions",
);
const fixtureDirectory = path.join(taskDirectory, "fixtures");
const validFixturePath = path.join(
  fixtureDirectory,
  "valid/agent-config-chain.v1.json",
);
const invalidLegacyFixturePath = path.join(
  fixtureDirectory,
  "invalid/legacy-revision-shadow.v1.json",
);
const runId = String(
  process.env.TEST_RUN_ID ?? `verify-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/gu, "-");
const implementationCommit = String(
  process.env.E2_T02_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
assert.match(
  implementationCommit,
  /^[0-9a-f]{40}$/u,
  "E2-T02 evidence requires an exact implementation commit",
);

const promoteEvidence = process.env.PROMOTE_EVIDENCE === "1";
if (promoteEvidence) {
  assert.equal(
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    "",
    "promoted E2-T02 evidence must start from a clean tracked implementation tree",
  );
}

const artifactRoot = path.resolve(
  root,
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e2-t02", runId),
);
const evidenceDirectory = promoteEvidence
  ? path.join(taskDirectory, "evidence/e2-t02-final")
  : artifactRoot;
await mkdir(artifactRoot, { recursive: true });
await mkdir(evidenceDirectory, { recursive: true });
await mkdir(path.join(taskDirectory, "work"), { recursive: true });

const fixture = await readJson(validFixturePath);
const invalidLegacyFixture = await readJson(invalidLegacyFixturePath);
const firstReplay = validateAndReplayDump(fixture);
const secondReplay = validateAndReplayDump(structuredClone(fixture));
const replayEvidence = verifyRevisionHistory(
  fixture,
  firstReplay,
  secondReplay,
);
const schemaEvidence = await verifySchemas();
const upgradeEvidence = await verifyUpgrade();
const refusalEvidence = verifyRefusals(fixture, invalidLegacyFixture);
const lifecycleEvidence = await verifyStreamLifecycle(fixture);
const raceEvidence = await verifyRevisionRace(fixture);
const canaryEvidence = await verifyCanaryBoundary(fixture);
const sensitivity = await verifySensitivity(validFixturePath);

const gates = [];
if (process.env.E2_T02_SKIP_GATES !== "1") {
  for (const [name, command, args] of [
    ["format", "pnpm", ["format:check"]],
    ["lint", "pnpm", ["lint"]],
    ["typecheck", "pnpm", ["typecheck"]],
    ["test", "pnpm", ["test"]],
    ["build", "pnpm", ["build"]],
  ]) {
    gates.push(runGate(name, command, args));
  }
}

const summary = {
  schemaVersion: 1,
  task: "E2-T02",
  runId,
  implementationCommit,
  result: "PASS",
  replay:
    "Replay: N/A (server config revision protocol) + mitigation: concurrent revision races, immutable manifests, canary scan, and replay digests",
  skips:
    process.env.E2_T02_SKIP_GATES === "1"
      ? ["format", "lint", "typecheck", "test", "build"]
      : [],
  gates,
  replayEvidence,
  schema: schemaEvidence,
  upgrade: upgradeEvidence,
  refusals: refusalEvidence,
  lifecycle: lifecycleEvidence,
  concurrency: raceEvidence,
  canaries: canaryEvidence,
  sensitivity,
};

await writeJson("verification-summary.json", summary);
await writeJson("revision-chain.json", replayEvidence);
await writeJson("schema-summary.json", schemaEvidence);
await writeJson("upgrade-matrix.json", upgradeEvidence);
await writeJson("refusals.json", refusalEvidence);
await writeJson("lifecycle-matrix.json", lifecycleEvidence);
await writeJson("concurrency-race.json", raceEvidence);
await writeJson("canary-scan.json", canaryEvidence);
await writeJson("sensitivity.json", sensitivity);

console.log(
  JSON.stringify(
    {
      result: summary.result,
      runId,
      implementationCommit,
      finalStateDigest: firstReplay.finalStateDigest,
      revisionCount: replayEvidence.revisions,
      refusalCases: refusalEvidence.length,
      race: raceEvidence.winnerCount,
      canaryCases: canaryEvidence.cases,
      gates: gates.map(({ name, exitCode }) => ({ name, exitCode })),
      sensitivity: sensitivity.verifierDetectedMutant,
      skips: summary.skips,
    },
    null,
    2,
  ),
);

function verifyRevisionHistory(dump, first, second) {
  assert.equal(
    first.finalStateJson,
    second.finalStateJson,
    "identical revision streams must replay to identical canonical bytes",
  );
  assert.deepEqual(
    first.prefixes.map(({ index, offset, stateDigest }) => ({
      index,
      offset,
      stateDigest,
    })),
    second.prefixes.map(({ index, offset, stateDigest }) => ({
      index,
      offset,
      stateDigest,
    })),
    "identical revision streams must replay to identical prefix digests",
  );

  const agentId = dump.records[0].event.data.agentId;
  const agent = first.finalState.entities.agents[agentId];
  assert.equal(agent.status, "retired");
  assert.equal(agent.runnable, false);
  assert.equal(agent.activeRevisionId, null);
  assert.equal(agent.revisions.length, 2);
  assert.equal(agent.transitions.length, dump.records.length);
  assert.equal(agent.revisions[0].revision, 1);
  assert.equal(agent.revisions[1].revision, 2);
  assert.equal(agent.revisions[0].sourceOffset, dump.records[0].offset);
  assert.equal(agent.revisions[1].sourceOffset, dump.records[2].offset);
  assert.deepEqual(
    agent.revisions[0],
    first.prefixes[0].state.entities.agents[agentId].revisions[0],
    "the first revision manifest must remain byte-identical after later events",
  );
  assert.notEqual(
    agent.revisions[0].configDigest,
    agent.revisions[1].configDigest,
    "the semantic revision mutation must change the config digest",
  );
  assert.deepEqual(
    agent.transitions.map(({ eventType }) => eventType),
    dump.records.map(({ event }) => event.eventType),
  );
  return {
    finalStateDigest: first.finalStateDigest,
    offsets: first.prefixes.map(({ offset }) => offset),
    perPrefixDigests: first.prefixes.map(({ index, offset, stateDigest }) => ({
      index,
      offset,
      stateDigest,
    })),
    records: dump.records.length,
    revisions: agent.revisions.length,
    historyManifest: agent.transitions,
    replayedTwiceWithIdenticalBytes: true,
    activeRevisionAfterRetire: agent.activeRevisionId,
    sourceOffsetsBound: true,
  };
}

async function verifySchemas() {
  const envelopeSchema = await readJson(
    path.join(root, "src/ledger/schemas/event-envelope.v1.schema.json"),
  );
  assert.deepEqual(envelopeSchema.properties.eventType.enum, EVENT_TYPES_V1);
  assert.deepEqual(AGENT_CONFIG_REVISION_EVENT_TYPES_V1, [
    "agent.config.created",
    "agent.config.revised",
    "agent.config.activated",
    "agent.config.disabled",
    "agent.config.retired",
  ]);
  const eventSchema = await readJson(
    path.join(
      root,
      "packages/protocol/src/schemas/agent-config-events.v1.schema.json",
    ),
  );
  assert.equal(eventSchema.oneOf.length, 5);
  assert.deepEqual(
    eventSchema.oneOf.map(({ title }) => title),
    [
      "Agent configuration created",
      "Agent configuration revised",
      "Agent configuration activated",
      "Agent configuration disabled",
      "Agent configuration retired",
    ],
  );
  return {
    envelopeEventTypes: EVENT_TYPES_V1,
    agentConfigEventTypes: AGENT_CONFIG_REVISION_EVENT_TYPES_V1,
    eventSchemaVariants: eventSchema.oneOf.length,
    strictRevisionData: true,
    result: "PASS",
  };
}

async function verifyUpgrade() {
  const legacy = await readJson(
    path.join(
      root,
      ".eforest/tasks/epic-2-the-roster/E2-T01-versioned-agent-config-schema/fixtures/valid/agent-config.v0.json",
    ),
  );
  const upgraded = upgradeAgentConfig(legacy);
  const digest = agentConfigDigest(upgraded);
  const agentId = "ag_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
  const revisionId = agentConfigRevisionId({
    agentId,
    configDigest: digest,
    revision: 1,
  });
  const data = validateAgentConfigRevisionEventData(
    "agent.config.created",
    {
      agentId,
      config: upgraded,
      configDigest: digest,
      expectedRevision: 0,
      expectedRevisionId: null,
      predecessorRevisionId: null,
      revision: 1,
      revisionId,
    },
    { expectedWorkspaceId: "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa" },
  );
  assert.equal(data.config.schemaVersion, 1);
  assert.deepEqual(data.config, upgradeAgentConfig(legacy));
  return {
    from: legacy.schemaVersion,
    to: data.config.schemaVersion,
    deterministic: true,
    securityDefaultsInvented: false,
    configDigest: digest,
    revisionId,
    result: "PASS",
  };
}

function verifyRefusals(dump, invalidLegacyFixture) {
  const refusalCases = [];
  const stale = structuredClone(dump);
  stale.records[2].event.data.expectedRevision = 0;
  stale.records[2].event.data.expectedRevisionId = null;
  stale.records[2].event.data.predecessorRevisionId = null;
  refusalCases.push(
    expectReplayRefusal(
      stale,
      REDUCER_ERROR_CODES.AGENT_CONFIG_INVALID_EVENT,
      "forged-predecessor",
    ),
  );

  const digestMismatch = structuredClone(dump);
  digestMismatch.records[2].event.data.configDigest = `sha256:${"0".repeat(64)}`;
  refusalCases.push(
    expectReplayRefusal(
      digestMismatch,
      REDUCER_ERROR_CODES.AGENT_CONFIG_INVALID_EVENT,
      "config-digest-mismatch",
    ),
  );

  const sibling = structuredClone(dump);
  sibling.records[0].event.data.agentId =
    "ag_bbbbbbbbbbbbbbbbbbbbbbbbbb_cccccccccccccccccccccccccc";
  refusalCases.push(
    expectReplayRefusal(
      sibling,
      REDUCER_ERROR_CODES.AGENT_CONFIG_INVALID_EVENT,
      "sibling-agent-scope",
    ),
  );

  const unknownTarget = structuredClone(dump);
  unknownTarget.records[3].event.data.revisionId = `acr_${"e".repeat(64)}`;
  refusalCases.push(
    expectReplayRefusal(
      unknownTarget,
      REDUCER_ERROR_CODES.AGENT_CONFIG_NOT_FOUND,
      "unknown-activation-target",
    ),
  );

  const activateRetired = structuredClone(dump);
  const lastEvent = structuredClone(activateRetired.records.at(-1).event);
  lastEvent.eventId = `ev_${"h".repeat(26)}`;
  lastEvent.idempotencyKey = `ik_${"s".repeat(26)}`;
  lastEvent.eventType = "agent.config.activated";
  lastEvent.data = {
    agentId: dump.records[0].event.data.agentId,
    expectedRevision: 2,
    expectedRevisionId: dump.records[2].event.data.revisionId,
    revisionId: dump.records[0].event.data.revisionId,
  };
  lastEvent.serverTimestamp = "2026-08-05T00:00:00.007Z";
  activateRetired.records.push({
    offset: "0000000000000000_0000000000000008",
    event: lastEvent,
  });
  refusalCases.push(
    expectReplayRefusal(
      activateRetired,
      REDUCER_ERROR_CODES.AGENT_CONFIG_IMMUTABLE,
      "activate-retired",
    ),
  );

  const legacyShadow = structuredClone(dump);
  const legacyEvent = structuredClone(legacyShadow.records.at(-1).event);
  legacyEvent.eventId = `ev_${"z".repeat(26)}`;
  legacyEvent.eventType = "agent.config.revised";
  legacyEvent.idempotencyKey = `ik_${"z".repeat(26)}`;
  legacyEvent.serverTimestamp = "2026-08-05T00:00:00.008Z";
  legacyEvent.data = {
    agentId: dump.records[0].event.data.agentId,
    config: { hijacked: true },
    revision: 99,
  };
  legacyShadow.records.push({
    offset: "0000000000000000_0000000000000008",
    event: legacyEvent,
  });
  refusalCases.push(
    expectReplayRefusal(
      legacyShadow,
      REDUCER_ERROR_CODES.AGENT_CONFIG_INVALID_EVENT,
      "legacy-revision-shadow",
    ),
  );
  refusalCases.push(
    expectReplayRefusal(
      invalidLegacyFixture,
      REDUCER_ERROR_CODES.AGENT_CONFIG_INVALID_EVENT,
      "legacy-revision-shadow-fixture",
    ),
  );

  return refusalCases;
}

async function verifyStreamLifecycle(dump) {
  const store = createMemoryStore();
  const agentId = dump.records[0].event.data.agentId;
  const workspaceId = dump.records[0].event.workspaceId;
  const configOne = dump.records[0].event.data.config;
  const configTwo = dump.records[2].event.data.config;
  const stream = createAgentConfigStream({
    agentId,
    streamStore: store,
    workspaceId,
  });
  const createResult = await stream.create(
    streamRequest(1, { config: configOne, expectedRevision: 0 }),
  );
  const activateOne = await stream.activate(
    streamRequest(2, {
      expectedRevision: 1,
      expectedRevisionId: createResult.revisionId,
      revisionId: createResult.revisionId,
    }),
  );
  const reviseResult = await stream.revise(
    streamRequest(3, {
      config: configTwo,
      expectedRevision: 1,
      expectedRevisionId: activateOne.revisionId,
    }),
  );
  await stream.disable(
    streamRequest(4, {
      expectedRevision: 2,
      expectedRevisionId: reviseResult.revisionId,
    }),
  );
  const disabled = await stream.read();
  assert.equal(disabled.state.entities.agents[agentId].status, "disabled");
  assert.equal(disabled.state.entities.agents[agentId].runnable, false);
  await stream.activate(
    streamRequest(5, {
      expectedRevision: 2,
      expectedRevisionId: reviseResult.revisionId,
      revisionId: reviseResult.revisionId,
    }),
  );
  await stream.retire(
    streamRequest(6, {
      expectedRevision: 2,
      expectedRevisionId: reviseResult.revisionId,
    }),
  );
  const final = await stream.read();
  const agent = final.state.entities.agents[agentId];
  assert.equal(agent.status, "retired");
  assert.equal(agent.runnable, false);
  assert.equal(agent.revisions.length, 2);
  const records = store.dump(stream.stream).map(({ offset, record }) => ({
    digest: record.digest,
    event: record.event,
    offset,
    stream: stream.stream,
  }));
  return {
    stream: stream.stream,
    records,
    disabledNotRunnable: true,
    retiredNotRunnable: true,
    replayedWithoutProjection: true,
    finalStatus: agent.status,
    finalRevisionId: agent.lastRevisionId,
    result: "PASS",
  };
}

async function verifyRevisionRace(dump) {
  const store = createMemoryStore();
  const agentId = dump.records[0].event.data.agentId;
  const workspaceId = dump.records[0].event.workspaceId;
  const firstDoor = createAgentConfigStream({
    agentId,
    streamStore: store,
    workspaceId,
  });
  const secondDoor = createAgentConfigStream({
    agentId,
    streamStore: store,
    workspaceId,
  });
  const baseRequest = {
    actorId: dump.records[0].event.actorId,
    causation: null,
    correlationId: dump.records[0].event.correlationId,
    expectedRevision: 0,
    expectedRevisionId: null,
  };
  const results = await Promise.allSettled([
    firstDoor.create(
      streamRequest(20, {
        ...baseRequest,
        config: dump.records[0].event.data.config,
      }),
    ),
    secondDoor.create(
      streamRequest(21, {
        ...baseRequest,
        config: dump.records[2].event.data.config,
      }),
    ),
  ]);
  const winners = results.filter(({ status }) => status === "fulfilled");
  const losers = results.filter(({ status }) => status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.ok(losers[0].reason instanceof AgentConfigStreamError);
  assert.equal(
    losers[0].reason.code,
    AGENT_CONFIG_STREAM_ERROR_CODES.STALE_REVISION,
  );
  assert.equal(store.dump(firstDoor.stream).length, 1);
  const winnerConfigDigest = store.dump(firstDoor.stream)[0].record.event.data
    .configDigest;
  assert.ok(
    [
      dump.records[0].event.data.configDigest,
      dump.records[2].event.data.configDigest,
    ].includes(winnerConfigDigest),
  );
  return {
    concurrentAttempts: 2,
    winnerCount: winners.length,
    staleRefusalCount: losers.length,
    refusalCode: losers[0].reason.code,
    finalLogicalEvents: store.dump(firstDoor.stream).length,
    losingPayloadAppended: false,
    winnerConfigDigest,
    result: "PASS",
  };
}

async function verifyCanaryBoundary(dump) {
  const cases = ["instructions.system", "instructions.task"];
  const results = [];
  for (const [index, location] of cases.entries()) {
    const store = createMemoryStore();
    const agentId = dump.records[0].event.data.agentId;
    const workspaceId = dump.records[0].event.workspaceId;
    const config = structuredClone(dump.records[0].event.data.config);
    config.instructions[location.split(".").at(-1)] =
      "Bearer canary-token-123456789";
    const stream = createAgentConfigStream({
      agentId,
      streamStore: store,
      workspaceId,
    });
    let error;
    try {
      await stream.create(
        streamRequest(30 + index, {
          config,
          expectedRevision: 0,
          expectedRevisionId: null,
        }),
      );
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, `${location} canary was accepted`);
    assert.equal(store.dump(stream.stream).length, 0);
    assert.match(error.code, /AGENT_CONFIG/iu);
    results.push({ location, code: error.code, persisted: false });
  }
  const serialized = JSON.stringify(dump);
  assert.equal(serialized.includes("canary-token-123456789"), false);
  return {
    cases: results.length,
    allRejected: results.every(({ persisted }) => !persisted),
    persistedCanary: false,
    locations: results,
    result: "PASS",
  };
}

async function verifySensitivity(fixturePath) {
  const parent = await mkdtemp(
    path.join(taskDirectory, "work", "stream-slack-e2-t02-mutant-"),
  );
  try {
    const modulePath = path.join(parent, "reducers.mjs");
    await cp(
      path.join(root, "packages/reducers/src/canonical-state.mjs"),
      path.join(parent, "canonical-state.mjs"),
    );
    const source = await readFile(
      path.join(root, "packages/reducers/src/index.mjs"),
      "utf8",
    );
    const guard = "revisions: [...existing.revisions, revision],";
    assert.equal(source.split(guard).length - 1, 1);
    await writeFile(
      modulePath,
      source.replace(guard, "revisions: [revision],"),
    );
    const probePath = path.join(parent, "probe.mjs");
    await writeFile(
      probePath,
      `import { readFile } from "node:fs/promises";
import { replayRecords } from ${JSON.stringify(pathToFileURL(modulePath).href)};
const dump = JSON.parse(await readFile(${JSON.stringify(fixturePath)}, "utf8"));
try {
  const replay = replayRecords(dump.records);
  const agent = replay.finalState.entities.agents[dump.records[0].event.data.agentId];
  if (agent.revisions.length !== 2 || agent.status !== "retired") process.exit(7);
  process.exit(0);
} catch {
  process.exit(7);
}
`,
    );
    const result = spawnSync(process.execPath, [probePath], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      7,
      `in-place history overwrite mutant was not detected: ${result.stderr}`,
    );
    return {
      mutation: "replace immutable revision append with in-place replacement",
      mutantExitCode: result.status,
      verifierDetectedMutant: true,
      result: "PASS",
    };
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function expectReplayRefusal(dump, expectedCode, name) {
  let error;
  try {
    validateAndReplayDump(dump);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `${name} was silently accepted`);
  assert.equal(error.code, expectedCode, name);
  return { name, code: error.code, offset: error.offset, result: "REFUSED" };
}

function streamRequest(number, overrides = {}) {
  const tokenAlphabet = "abcdefghjkmnpqrstvwxyz0123456789";
  const token = tokenAlphabet[number % tokenAlphabet.length].repeat(26);
  return {
    actorId: "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb",
    clock: () =>
      new Date(`2026-08-05T00:01:${String(number).padStart(2, "0")}.000Z`),
    correlationId: "cr_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    eventId: `ev_${token}`,
    idempotencyKey: `ik_${token}`,
    ...overrides,
  };
}

function createMemoryStore() {
  const streams = new Map();
  return {
    async append(stream, record, { streamSeq } = {}) {
      const entries = streams.get(stream) ?? [];
      const currentOffset = offsetFor(entries.length);
      if (streamSeq !== currentOffset) {
        const error = new Error("stale stream head");
        error.code = "APPEND_CONFLICT";
        error.status = 409;
        throw error;
      }
      const entry = {
        offset: offsetFor(entries.length + 1),
        record: structuredClone(record),
      };
      entries.push(entry);
      streams.set(stream, entries);
      return { nextOffset: entry.offset };
    },
    async read(stream) {
      const entries = streams.get(stream) ?? [];
      return {
        nextOffset: offsetFor(entries.length),
        records: entries.map(({ record }) => structuredClone(record)),
      };
    },
    dump(stream) {
      return structuredClone(streams.get(stream) ?? []);
    },
  };
}

function offsetFor(sequence) {
  return `0000000000000000_${String(sequence).padStart(16, "0")}`;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filename, value) {
  await writeFile(
    path.join(evidenceDirectory, filename),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function runGate(name, command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${name} gate failed with exit ${result.status}:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return {
    command: [command, ...args].join(" "),
    exitCode: result.status,
    name,
  };
}
