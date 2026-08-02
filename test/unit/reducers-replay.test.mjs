import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  canonicalStateDigest,
  canonicalStateJson,
  createInitialState,
  REDUCER_ERROR_CODES,
  reduceEnvelope,
  replayRecords,
  ReducerError,
  sha256Hex,
} from "@stream-slack/reducers";

import {
  normalizeDump,
  ReplayError,
  validateAndReplayDump,
} from "../../src/ledger/replay.mjs";
import { analyzeModuleSource } from "../../tools/import-analysis.mjs";

const taskDirectory = path.resolve(
  ".eforest/tasks/epic-0-the-ledger/E0-T05-reducers-digests-and-replay-cli",
);
const validDirectory = path.join(taskDirectory, "fixtures/valid");
const invalidDirectory = path.join(taskDirectory, "fixtures/invalid");

const WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACTOR_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function makeEnvelope(overrides = {}) {
  return {
    actorId: ACTOR_ID,
    causation: null,
    correlationId: "cr_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    data: {
      fixtureId: "unit-fixture",
      value: "unit",
    },
    eventId: "ev_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    eventType: "ledger.fixture-recorded",
    idempotencyKey: "ik_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    schemaVersion: 1,
    serverTimestamp: "2026-04-01T00:00:00.000Z",
    workspaceId: WORKSPACE_ID,
    ...overrides,
  };
}

function expectFailure(operation, expected) {
  assert.throws(operation, (error) => {
    assert.equal(error.code, expected.code);
    assert.equal(error.offset, expected.offset);
    return true;
  });
}

test("canonical state encoding is insertion-order independent and has a known SHA-256", () => {
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(canonicalStateJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(canonicalStateJson({ a: 1, b: 2 }), '{"a":1,"b":2}');
  assert.equal(
    canonicalStateDigest({ b: 2, a: 1 }),
    "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
  );
  assert.equal(
    canonicalStateJson({ "z-key": 1, "a-key": 2 }),
    '{"a-key":2,"z-key":1}',
  );
  assert.throws(() => canonicalStateJson({ value: Number.NaN }), TypeError);
  assert.throws(
    () => canonicalStateJson(JSON.parse('{"__proto__":"blocked"}')),
    TypeError,
  );
});

test("every valid golden log replays with stable per-prefix state", async () => {
  const fixtureNames = (await readdir(validDirectory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert.deepEqual(fixtureNames, [
    "ledger-log.v1.json",
    "message-and-run-log.v1.json",
  ]);

  for (const fixtureName of fixtureNames) {
    const result = validateAndReplayDump(
      await readJson(path.join(validDirectory, fixtureName)),
    );
    assert.ok(result.prefixes.length > 0);
    assert.equal(result.finalStateJson, canonicalStateJson(result.finalState));
    assert.equal(
      result.finalStateDigest,
      canonicalStateDigest(result.finalState),
    );
    for (const prefix of result.prefixes) {
      assert.equal(prefix.stateJson, canonicalStateJson(prefix.state));
      assert.equal(prefix.stateDigest, canonicalStateDigest(prefix.state));
    }
  }
});

test("replay is invariant across chunk boundaries", async () => {
  const dump = await readJson(path.join(validDirectory, "ledger-log.v1.json"));
  const normalized = normalizeDump(dump);
  const expected = replayRecords(normalized);
  let state = createInitialState();
  const chunkedPrefixes = [];

  for (let index = 0; index < normalized.length; index += 1) {
    state = reduceEnvelope(state, normalized.at(index).event, {
      offset: normalized.at(index).offset,
    });
    chunkedPrefixes.push({
      offset: normalized.at(index).offset,
      stateDigest: canonicalStateDigest(state),
    });
  }

  assert.deepEqual(
    chunkedPrefixes,
    expected.prefixes.map(({ offset, stateDigest }) => ({
      offset,
      stateDigest,
    })),
  );
  assert.equal(canonicalStateDigest(state), expected.finalStateDigest);
});

test("invalid golden logs fail at the offending offset with stable typed errors", async () => {
  const expectations = {
    "duplicate-logical-id.json": {
      code: REDUCER_ERROR_CODES.DUPLICATE_LOGICAL_ID,
      offset: "0000000000000002_0000000000000006",
    },
    "invalid-offset.json": {
      code: REDUCER_ERROR_CODES.INVALID_OFFSET,
      offset: "not-an-offset",
    },
    "illegal-transition.json": {
      code: REDUCER_ERROR_CODES.ILLEGAL_TRANSITION,
      offset: "0000000000000002_0000000000000004",
    },
    "malformed-envelope.json": {
      code: "REPLAY_INVALID_ENVELOPE",
      offset: "0000000000000002_0000000000000002",
    },
    "unknown-event-type.json": {
      code: "REPLAY_INVALID_ENVELOPE",
      offset: "0000000000000002_0000000000000001",
    },
  };

  for (const [fixtureName, expected] of Object.entries(expectations)) {
    const dump = await readJson(path.join(invalidDirectory, fixtureName));
    expectFailure(() => validateAndReplayDump(dump), expected);
  }
});

test("reducer rejects duplicate events and reused offsets", () => {
  const first = makeEnvelope();
  const second = makeEnvelope({
    data: { fixtureId: "second", value: "second" },
    eventId: "ev_bbbbbbbbbbbbbbbbbbbbbbbbbb",
    idempotencyKey: "ik_bbbbbbbbbbbbbbbbbbbbbbbbbb",
  });

  expectFailure(
    () =>
      reduceEnvelope(
        reduceEnvelope(createInitialState(), first, {
          offset: "0000000000000003_0000000000000001",
        }),
        first,
        { offset: "0000000000000003_0000000000000002" },
      ),
    {
      code: REDUCER_ERROR_CODES.DUPLICATE_EVENT_ID,
      offset: "0000000000000003_0000000000000002",
    },
  );
  expectFailure(
    () =>
      replayRecords([
        { offset: "0000000000000004_0000000000000001", event: first },
        { offset: "0000000000000004_0000000000000001", event: second },
      ]),
    {
      code: REDUCER_ERROR_CODES.OFFSET_REUSED,
      offset: "0000000000000004_0000000000000001",
    },
  );
  expectFailure(
    () => replayRecords([{ offset: "not-an-offset", event: first }]),
    {
      code: REDUCER_ERROR_CODES.INVALID_OFFSET,
      offset: "not-an-offset",
    },
  );
});

test("unknown reducer registry entries fail before state mutation", () => {
  expectFailure(
    () =>
      reduceEnvelope(
        createInitialState(),
        makeEnvelope({ eventType: "future.event" }),
        {
          offset: "0000000000000003_0000000000000001",
        },
      ),
    {
      code: REDUCER_ERROR_CODES.UNKNOWN_EVENT_TYPE,
      offset: "0000000000000003_0000000000000001",
    },
  );
});

test("semantic fixture mutations change the affected prefix and final digest", async () => {
  const fixtureNames = ["ledger-log.v1.json", "message-and-run-log.v1.json"];
  for (const fixtureName of fixtureNames) {
    const originalDump = await readJson(path.join(validDirectory, fixtureName));
    const mutatedDump = structuredClone(originalDump);
    const data = mutatedDump.records.at(0).event.data;
    if (typeof data.text === "string") data.text += "-mutated";
    else data.value = `${data.value}-mutated`;

    const original = validateAndReplayDump(originalDump);
    const mutated = validateAndReplayDump(mutatedDump);
    assert.notEqual(
      mutated.prefixes.at(0).stateDigest,
      original.prefixes.at(0).stateDigest,
    );
    assert.notEqual(mutated.finalStateDigest, original.finalStateDigest);
  }
});

test("envelope provenance and source-reference mutations change replay digests", async () => {
  const originalDump = await readJson(
    path.join(validDirectory, "ledger-log.v1.json"),
  );
  const original = validateAndReplayDump(originalDump);
  const mutations = [
    [
      "serverTimestamp",
      (event) => {
        event.serverTimestamp = "2026-01-01T00:00:00.010Z";
      },
    ],
    [
      "correlationId",
      (event) => {
        event.correlationId = "cr_bbbbbbbbbbbbbbbbbbbbbbbbbb";
      },
    ],
    [
      "idempotencyKey",
      (event) => {
        event.idempotencyKey = "ik_bbbbbbbbbbbbbbbbbbbbbbbbbb";
      },
    ],
    [
      "actorId",
      (event) => {
        event.actorId =
          "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
      },
    ],
    [
      "offset",
      (...args) => {
        args.at(1).records.at(0).offset = "0000000000000000_000000000000000a";
      },
    ],
    [
      "causation.digest",
      (event) => {
        event.causation = {
          digest:
            "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          offset: "0000000000000000_0000000000000001",
          stream:
            "channel:ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc",
        };
      },
    ],
  ];

  for (const [name, mutate] of mutations) {
    const mutatedDump = structuredClone(originalDump);
    mutate(mutatedDump.records.at(0).event, mutatedDump);
    const mutated = validateAndReplayDump(mutatedDump);
    assert.notEqual(
      mutated.prefixes.at(0).stateDigest,
      original.prefixes.at(0).stateDigest,
      `${name} mutation was accepted without changing the prefix digest`,
    );
    assert.notEqual(
      mutated.finalStateDigest,
      original.finalStateDigest,
      `${name} mutation was accepted without changing the final digest`,
    );
  }
});

test("reducer and canonicalizer dependency inspection finds no ambient capabilities", async () => {
  const sourceFiles = [
    "packages/reducers/src/index.mjs",
    "packages/reducers/src/canonical-state.mjs",
  ];
  for (const sourceFile of sourceFiles) {
    const source = await readFile(path.resolve(sourceFile), "utf8");
    const analysis = analyzeModuleSource(source, sourceFile);
    assert.deepEqual(analysis.ambientCapabilities, []);
    assert.ok(analysis.imports.every((specifier) => specifier.startsWith(".")));
  }

  const forbiddenFixture = analyzeModuleSource(
    "export function impure() { return Date.now() + Math.random() + Intl.DateTimeFormat(); }",
  );
  assert.deepEqual(forbiddenFixture.ambientCapabilities.sort(), [
    "clock",
    "environment",
    "randomness",
  ]);
});

test("replay errors remain typed for malformed input", () => {
  assert.throws(
    () => validateAndReplayDump({ records: [{ offset: "x", event: null }] }),
    (error) =>
      error instanceof ReplayError && error.code === "REPLAY_INVALID_DUMP",
  );
  assert.throws(
    () => reduceEnvelope(createInitialState(), null, { offset: "x" }),
    (error) =>
      error instanceof ReducerError &&
      error.code === REDUCER_ERROR_CODES.MALFORMED_ENVELOPE,
  );
});
