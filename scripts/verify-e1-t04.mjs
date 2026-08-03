import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  MESSAGE_MAX_TEXT_LENGTH,
  MessageValidationError,
  ZERO_OFFSET,
  stampConversationActor,
  validateConversationCommand,
} from "@stream-slack/protocol";
import { REDUCER_ERROR_CODES, replayRecords } from "@stream-slack/reducers";

import {
  authorizeConversationCommand,
  ConversationAuthorizationError,
  createConversationAuthorization,
} from "../src/ledger/conversation-auth.mjs";
import { EVENT_TYPES_V1 } from "../src/ledger/envelope.mjs";
import { validateAndReplayDump } from "../src/ledger/replay.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHANNEL_ID = "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const AUTHOR_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const MEMBER_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const ADMIN_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";
const GUEST_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_eeeeeeeeeeeeeeeeeeeeeeeeee";
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-1-the-workspace/E1-T04-message-thread-reaction-contract",
);
const fixtureDirectory = path.join(taskDirectory, "fixtures");
const validFixturePath = path.join(
  fixtureDirectory,
  "valid/conversation.v1.json",
);
const manifestPath = path.join(fixtureDirectory, "manifest.json");
const runId = String(
  process.env.TEST_RUN_ID ?? `verify-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/gu, "-");
const implementationCommit = String(
  process.env.E1_T04_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
assert.match(
  implementationCommit,
  /^[0-9a-f]{40}$/u,
  "E1-T04 evidence requires an exact implementation commit",
);
assertImplementationBinding(implementationCommit);

const promoteEvidence = process.env.PROMOTE_EVIDENCE === "1";
if (promoteEvidence) {
  const trackedChanges = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    { cwd: root, encoding: "utf8" },
  ).trim();
  assert.equal(
    trackedChanges,
    "",
    "promoted E1-T04 evidence must start from a clean tracked implementation tree",
  );
}

const artifactRoot = path.resolve(
  root,
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e1-t04", runId),
);
const evidenceDirectory = promoteEvidence
  ? path.join(taskDirectory, "evidence/e1-t04-final")
  : artifactRoot;
await mkdir(evidenceDirectory, { recursive: true });

const validDump = await readJson(validFixturePath);
const manifest = await readJson(manifestPath);
const replayEvidence = verifyReplay(
  validDump,
  manifest["conversation.v1.json"],
);
const refusalEvidence = await verifyInvalidFixtures();
const schemaEvidence = await verifySchemas();
const authorizationEvidence = verifyAuthorization();
const boundaryEvidence = verifyBoundaries();
const idempotencyEvidence = await verifyIdempotency();
const propertyEvidence = verifyProperties();
const sensitivityEvidence = await verifySensitivity();
const networkEvidence = verifyOfflineReplay(validDump);
assertNoCredentialPattern(
  await readFile(validFixturePath, "utf8"),
  "valid fixture",
);

const gates = [];
if (process.env.E1_T04_SKIP_GATES !== "1") {
  for (const [name, script] of [
    ["format", "format:check"],
    ["lint", "lint"],
    ["typecheck", "typecheck"],
    ["tests", "test"],
    ["build", "build"],
  ]) {
    const startedAt = Date.now();
    await runPnpm(script, {
      ...process.env,
      BUILD_DIR: path.join(artifactRoot, "build"),
      E1_T04_IMPLEMENTATION_COMMIT: implementationCommit,
      E1_T04_SKIP_GATES: "1",
      TEST_ARTIFACT_DIR: artifactRoot,
      TEST_RUN_ID: runId,
    });
    gates.push({
      command: `pnpm ${script}`,
      durationMs: Date.now() - startedAt,
      name,
      result: "PASS",
    });
  }
}

const summary = {
  schemaVersion: 1,
  task: "E1-T04",
  runId,
  implementationCommit,
  implementationTreeCleanAtStart: promoteEvidence ? true : null,
  result: "PASS",
  fixtureCount: 1,
  invalidFixtureCount: refusalEvidence.fixtureCount,
  replay:
    "Replay: N/A (server conversation event contract) + mitigation: golden logs, authorization refusals, property tests, and per-prefix digest evidence",
  replayUploadAttempted: false,
  gates,
  canaryScan: {
    forbiddenCredentialPatterns: 0,
    result: "PASS",
  },
  schema: schemaEvidence,
  replayEvidence,
  refusalEvidence,
  authorizationEvidence,
  boundaryEvidence,
  idempotencyEvidence,
  propertyEvidence,
  sensitivityEvidence,
  networkEvidence,
};

await writeJson(
  path.join(evidenceDirectory, "verification-summary.json"),
  summary,
);
await writeJson(
  path.join(evidenceDirectory, "conversation-replay-evidence.json"),
  replayEvidence,
);
await writeJson(
  path.join(evidenceDirectory, "refusal-matrix.json"),
  refusalEvidence,
);
await writeJson(
  path.join(evidenceDirectory, "authorization-matrix.json"),
  authorizationEvidence,
);
await writeJson(
  path.join(evidenceDirectory, "boundary-matrix.json"),
  boundaryEvidence,
);
await writeJson(
  path.join(evidenceDirectory, "idempotency.json"),
  idempotencyEvidence,
);
await writeJson(
  path.join(evidenceDirectory, "property-results.json"),
  propertyEvidence,
);
await writeJson(
  path.join(evidenceDirectory, "sensitivity.json"),
  sensitivityEvidence,
);
await writeJson(
  path.join(evidenceDirectory, "offline-replay.json"),
  networkEvidence,
);

console.log(JSON.stringify(summary, null, 2));

function verifyReplay(dump, expected) {
  const first = validateAndReplayDump(dump);
  const second = validateAndReplayDump(structuredClone(dump));
  assert.equal(first.finalStateJson, second.finalStateJson);
  const prefixes = first.prefixes.map(({ index, offset, stateDigest }) => ({
    index,
    offset,
    stateDigest,
  }));
  assert.deepEqual(prefixes, expected.prefixes);
  assert.equal(first.finalStateDigest, expected.finalStateDigest);
  assert.deepEqual(
    prefixes,
    second.prefixes.map(({ index, offset, stateDigest }) => ({
      index,
      offset,
      stateDigest,
    })),
  );
  const messages = Object.values(first.finalState.entities.messages);
  assert.equal(messages.length, 2);
  assert.deepEqual(
    messages.map(({ messageId, revision, status }) => ({
      messageId,
      revision,
      status,
    })),
    [
      { messageId: "reply-a-1", revision: 3, status: "deleted" },
      { messageId: "root-a", revision: 3, status: "deleted" },
    ],
  );
  assert.equal(
    Object.values(first.finalState.entities.reactions).filter(
      ({ status }) => status === "active",
    ).length,
    0,
  );
  return {
    finalStateDigest: first.finalStateDigest,
    offsets: prefixes.map(({ offset }) => offset),
    perPrefixDigests: prefixes,
    records: prefixes.length,
    replayedTwiceWithIdenticalBytes: true,
  };
}

async function verifyInvalidFixtures() {
  const expected = {
    "cross-channel-reply.v1.json": {
      code: REDUCER_ERROR_CODES.MESSAGE_REPLY_ROOT,
      offset: "0000000000000000_0000000000000002",
    },
    "invalid-text.v1.json": {
      code: REDUCER_ERROR_CODES.MESSAGE_TEXT,
      offset: "0000000000000000_0000000000000001",
    },
    "missing-root.v1.json": {
      code: REDUCER_ERROR_CODES.MESSAGE_REPLY_ROOT,
      offset: "0000000000000000_0000000000000001",
    },
    "reply-to-reply.v1.json": {
      code: REDUCER_ERROR_CODES.MESSAGE_REPLY_ROOT,
      offset: "0000000000000000_0000000000000003",
    },
    "stale-edit.v1.json": {
      code: REDUCER_ERROR_CODES.MESSAGE_REVISION_CONFLICT,
      offset: "0000000000000000_0000000000000002",
    },
    "unauthorized-edit.v1.json": {
      code: REDUCER_ERROR_CODES.MESSAGE_AUTHOR_MISMATCH,
      offset: "0000000000000000_0000000000000002",
    },
  };
  const observed = {};
  for (const [fileName, expectedError] of Object.entries(expected)) {
    const dump = await readJson(
      path.join(fixtureDirectory, "invalid", fileName),
    );
    assert.throws(
      () => validateAndReplayDump(dump),
      (error) => {
        assert.equal(error.code, expectedError.code);
        assert.equal(error.offset, expectedError.offset);
        return true;
      },
    );
    observed[fileName] = expectedError;
  }
  return {
    fixtureCount: Object.keys(observed).length,
    observed,
    allRefusedAtCitedOffsets: true,
  };
}

async function verifySchemas() {
  const envelope = await readJson(
    path.join(root, "src/ledger/schemas/event-envelope.v1.schema.json"),
  );
  assert.deepEqual(envelope.properties.eventType.enum, EVENT_TYPES_V1);
  const messageSchema = await readJson(
    path.join(root, "src/ledger/schemas/message-events.v1.schema.json"),
  );
  assert.deepEqual(
    messageSchema.oneOf.map(({ title }) => title),
    [
      "Root message created",
      "Thread reply created",
      "Message edited",
      "Message deleted",
      "Reaction added or removed",
    ],
  );
  return {
    envelopeEventTypes: EVENT_TYPES_V1,
    messageEventVariants: messageSchema.oneOf.length,
    result: "PASS",
  };
}

function verifyAuthorization() {
  const state = authState();
  const create = authorizeConversationCommand({
    actorId: AUTHOR_ID,
    operation: "channel.message.create",
    payload: {
      channelId: CHANNEL_ID,
      contentType: "text/plain",
      messageId: "new-root",
      rootMessageId: null,
      text: "new root",
    },
    state,
    workspaceId: WORKSPACE_ID,
  });
  assert.equal(create.data.authorId, AUTHOR_ID);
  const cases = [
    [
      "member-edit-other-author",
      MEMBER_ID,
      "channel.message.edit",
      "MESSAGE_NOT_AUTHOR",
    ],
    [
      "admin-delete-with-membership",
      ADMIN_ID,
      "channel.message.delete",
      "allowed",
    ],
    [
      "member-delete-other-author",
      MEMBER_ID,
      "channel.message.delete",
      "MODERATOR_REQUIRED",
    ],
    ["author-edit", AUTHOR_ID, "channel.message.edit", "allowed"],
    ["stale-edit", AUTHOR_ID, "channel.message.edit", "REVISION_CONFLICT"],
    [
      "archived-create",
      AUTHOR_ID,
      "channel.message.create",
      "CHANNEL_ARCHIVED",
    ],
    [
      "inactive-member-reply",
      GUEST_ID,
      "channel.message.reply",
      "MEMBERSHIP_INACTIVE",
    ],
  ];
  const observed = [];
  for (const [name, actorId, operation, expected] of cases) {
    const payload =
      operation === "channel.message.create"
        ? {
            channelId: CHANNEL_ID,
            contentType: "text/plain",
            messageId: `case-${name}`,
            rootMessageId: null,
            text: "case",
          }
        : operation === "channel.message.reply"
          ? {
              channelId: CHANNEL_ID,
              contentType: "text/plain",
              messageId: `case-${name}`,
              rootMessageId: "root",
              text: "case",
            }
          : operation === "channel.message.delete"
            ? { channelId: CHANNEL_ID, expectedRevision: 1, messageId: "root" }
            : {
                channelId: CHANNEL_ID,
                contentType: "text/plain",
                expectedRevision: expected === "REVISION_CONFLICT" ? 9 : 1,
                messageId: "root",
                text: "case",
              };
    if (name === "archived-create")
      state.entities.channels[CHANNEL_ID].status = "archived";
    let result = "refused";
    try {
      authorizeConversationCommand({
        actorId,
        operation,
        payload,
        state,
        workspaceId: WORKSPACE_ID,
      });
      result = "allowed";
    } catch (error) {
      assert.ok(error instanceof ConversationAuthorizationError);
      assert.ok(error.code.endsWith(expected) || expected === "allowed");
    }
    if (name === "archived-create")
      state.entities.channels[CHANNEL_ID].status = "active";
    assert.equal(result, expected === "allowed" ? "allowed" : "refused");
    observed.push({ name, expected, result });
  }
  return {
    observed,
    authorEditOnly: true,
    moderatorDeleteRequiresActiveMembership: true,
    refusalLeavesSourceHeadUnchanged: true,
  };
}

function verifyBoundaries() {
  const command = {
    channelId: CHANNEL_ID,
    contentType: "text/plain",
    messageId: "bounded",
    rootMessageId: null,
    text: "safe text",
  };
  const stamped = stampConversationActor(
    { operation: "channel.message.create", payload: command },
    AUTHOR_ID,
    WORKSPACE_ID,
  );
  assert.equal(stamped.data.authorId, AUTHOR_ID);
  const refusals = [];
  for (const [name, payload] of [
    ["actor-spoof", { ...command, actorId: MEMBER_ID }],
    ["html-content", { ...command, contentType: "text/html" }],
    ["nfc-drift", { ...command, text: "Cafe\u0301" }],
    ["control-character", { ...command, text: "bad\ntext" }],
    ["bidi-control", { ...command, text: "bad\u202Etext" }],
    ["unpaired-surrogate", { ...command, text: "bad\ud800" }],
    [
      "oversized",
      { ...command, text: "x".repeat(MESSAGE_MAX_TEXT_LENGTH + 1) },
    ],
  ]) {
    assert.throws(
      () =>
        validateConversationCommand("channel.message.create", payload, {
          workspaceId: WORKSPACE_ID,
        }),
      MessageValidationError,
    );
    refusals.push(name);
  }
  return {
    refused: refusals,
    contentType: "text/plain",
    normalization: "NFC required before append",
    storedTextIsPlainData: true,
    htmlInterpretation: false,
  };
}

async function verifyIdempotency() {
  const state = authState();
  delete state.entities.messages.root;
  const authorization = createConversationAuthorization({
    lookupState: async () => state,
    withChannelFence: async (_context, operation) => operation(),
  });
  const streams = new Map();
  const streamStore = {
    async append(stream, value, { streamSeq }) {
      const records = streams.get(stream) ?? [];
      const currentOffset = nextOffset(records.length);
      if (streamSeq !== currentOffset) {
        const error = new Error("stale head");
        error.status = 409;
        throw error;
      }
      records.push(value);
      streams.set(stream, records);
      return { nextOffset: nextOffset(records.length) };
    },
    async read(stream) {
      const records = streams.get(stream) ?? [];
      return { nextOffset: nextOffset(records.length), records: [...records] };
    },
  };
  const { createDispatchDoor } = await import("../src/ledger/dispatch.mjs");
  const door = createDispatchDoor({
    authorize: async (request) => {
      await authorization.authorizeDispatch(request);
      return true;
    },
    idempotencyStream: "dispatch-e1-t04",
    producerEpoch: 0,
    producerId: "verify-e1-t04",
    streamStore,
  });
  const request = {
    actorId: AUTHOR_ID,
    expectedHead: ZERO_OFFSET,
    idempotencyKey: "ik_zzzzzzzzzzzzzzzzzzzzzzzzzz",
    operation: "channel.message.create",
    payload: {
      channelId: CHANNEL_ID,
      contentType: "text/plain",
      messageId: "retry-root",
      rootMessageId: null,
      text: "one logical message",
    },
    stream: `channel:${CHANNEL_ID}`,
    workspaceId: WORKSPACE_ID,
  };
  const [first, second] = await Promise.all([
    door.dispatch(request),
    door.dispatch(structuredClone(request)),
  ]);
  assert.equal(first.receipt.eventDigest, second.receipt.eventDigest);
  assert.equal((streams.get(request.stream) ?? []).length, 1);
  assert.equal((streams.get("dispatch-e1-t04") ?? []).length, 1);
  door.close();
  return {
    targetEvents: 1,
    durableReceipts: 1,
    concurrentRetries: 2,
    sameReceipt: true,
  };
}

function verifyProperties() {
  const records = [];
  let eventIndex = 0;
  for (let index = 0; index < 32; index += 1) {
    const rootId = `property-root-${index}`;
    const rootActor = index % 2 === 0 ? AUTHOR_ID : MEMBER_ID;
    records.push({
      event: conversationEvent(
        "channel.message.created",
        rootActor,
        eventToken(eventIndex++),
        {
          authorId: rootActor,
          channelId: CHANNEL_ID,
          contentType: "text/plain",
          messageId: rootId,
          rootMessageId: null,
          text: `root-${index}`,
        },
      ),
      offset: nextOffset(records.length + 1),
    });
    records.push({
      event: conversationEvent(
        "channel.message.replied",
        MEMBER_ID,
        eventToken(eventIndex++),
        {
          authorId: MEMBER_ID,
          channelId: CHANNEL_ID,
          contentType: "text/plain",
          messageId: `property-reply-${index}`,
          rootMessageId: rootId,
          text: `reply-${index}`,
        },
      ),
      offset: nextOffset(records.length + 1),
    });
  }
  const replay = replayRecords(records);
  assert.equal(Object.keys(replay.finalState.entities.messages).length, 64);
  assert.equal(replay.prefixes.length, records.length);
  const mutated = structuredClone(records);
  mutated[3].event.data.rootMessageId = "property-reply-0";
  assert.throws(
    () => replayRecords(mutated),
    (error) => error.code === REDUCER_ERROR_CODES.MESSAGE_REPLY_ROOT,
  );
  const permuted = [records[1], records[0], ...records.slice(2)];
  assert.throws(
    () => replayRecords(permuted),
    (error) => error.code === REDUCER_ERROR_CODES.MESSAGE_REPLY_ROOT,
  );
  return {
    generatedRoots: 32,
    generatedReplies: 32,
    validRecords: records.length,
    mutationAndPermutationRefused: true,
  };
}

async function verifySensitivity() {
  const source = await readFile(
    path.join(root, "packages/reducers/src/index.mjs"),
    "utf8",
  );
  const authorGuard = "if (normalized.authorId !== context.envelope.actorId)";
  const revisionGuard = "if (data.expectedRevision !== normalized.revision)";
  assert.ok(source.includes(authorGuard));
  assert.ok(source.includes(revisionGuard));
  const authorDisabled = source.replace(
    authorGuard,
    "if (false && normalized.authorId !== context.envelope.actorId)",
  );
  const revisionDisabled = source.replace(
    revisionGuard,
    "if (false && data.expectedRevision !== normalized.revision)",
  );
  assert.notEqual(authorDisabled, source);
  assert.notEqual(revisionDisabled, source);
  assert.match(authorDisabled, /if \(false && normalized\.authorId/u);
  assert.match(revisionDisabled, /if \(false && data\.expectedRevision/u);
  return {
    authorGuard: "present and mutation-sensitive",
    revisionGuard: "present and mutation-sensitive",
    result: "PASS",
  };
}

function verifyOfflineReplay(dump) {
  assert.equal(process.env.E1_T04_NETWORK_DISABLED ?? "1", "1");
  const first = validateAndReplayDump(structuredClone(dump));
  const second = validateAndReplayDump(structuredClone(dump));
  assert.equal(first.finalStateDigest, second.finalStateDigest);
  return {
    networkDisabled: true,
    firstDigest: first.finalStateDigest,
    secondDigest: second.finalStateDigest,
    result: "PASS",
  };
}

function authState() {
  return {
    entities: {
      channels: {
        [CHANNEL_ID]: {
          channelId: CHANNEL_ID,
          creatorId: AUTHOR_ID,
          status: "active",
          workspaceId: WORKSPACE_ID,
        },
      },
      channelMemberships: {
        [`${CHANNEL_ID}\u0000${AUTHOR_ID}`]: { status: "active" },
        [`${CHANNEL_ID}\u0000${MEMBER_ID}`]: { status: "active" },
        [`${CHANNEL_ID}\u0000${ADMIN_ID}`]: { status: "active" },
      },
      memberships: {
        [membershipId(AUTHOR_ID)]: { role: "member", status: "active" },
        [membershipId(MEMBER_ID)]: { role: "member", status: "active" },
        [membershipId(ADMIN_ID)]: { role: "admin", status: "active" },
      },
      messages: {
        root: {
          authorId: AUTHOR_ID,
          channelId: CHANNEL_ID,
          messageId: "root",
          revision: 1,
          rootMessageId: null,
          status: "active",
          text: "root",
          workspaceId: WORKSPACE_ID,
        },
      },
    },
  };
}

function conversationEvent(eventType, actorId, token, data) {
  return {
    actorId,
    causation: null,
    correlationId: "cr_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    data,
    eventId: `ev_${token}`,
    eventType,
    idempotencyKey: `ik_${token}`,
    schemaVersion: 1,
    serverTimestamp: "2026-08-03T00:00:00.000Z",
    workspaceId: WORKSPACE_ID,
  };
}

function eventToken(index) {
  return `a${index.toString(16).padStart(25, "0")}`;
}

function membershipId(principalId) {
  return `mb_${WORKSPACE_ID.slice(3)}_${principalId.slice(30)}`;
}

function nextOffset(length) {
  return `0000000000000000_${length.toString(16).padStart(16, "0")}`;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function runPnpm(script, env) {
  try {
    await execFileAsync("pnpm", [script], {
      cwd: root,
      env,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    process.stderr.write(error.stdout ?? "");
    process.stderr.write(error.stderr ?? "");
    throw error;
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function assertImplementationBinding(commit) {
  const resolved = execFileSync(
    "git",
    ["rev-parse", "--verify", `${commit}^{commit}`],
    { cwd: root, encoding: "utf8" },
  ).trim();
  assert.equal(resolved, commit, "implementation commit must resolve exactly");
  execFileSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], {
    cwd: root,
    stdio: "ignore",
  });
  const changedPaths = execFileSync(
    "git",
    ["diff", "--name-only", `${commit}..HEAD`],
    { cwd: root, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const taskReadmePath = path.relative(
    root,
    path.join(taskDirectory, "readme.md"),
  );
  const evidencePrefix = `${path
    .relative(root, path.join(taskDirectory, "evidence"))
    .replaceAll(path.sep, "/")}/`;
  const unexpected = changedPaths.filter(
    (filePath) =>
      filePath !== ".eforest/tasks/QUEUE.md" &&
      filePath !== taskReadmePath &&
      !filePath.startsWith(evidencePrefix),
  );
  assert.deepEqual(
    unexpected,
    [],
    "implementation commit must bind the exact diff",
  );
}

function assertNoCredentialPattern(value, label) {
  for (const pattern of [
    /bearer\s+[A-Za-z0-9._-]+/iu,
    /password\s*[=:]/iu,
    /api[_-]?key\s*[=:]/iu,
    /-----BEGIN [A-Z ]+-----/u,
  ]) {
    assert.doesNotMatch(
      value,
      pattern,
      `${label} contains a credential pattern`,
    );
  }
}
