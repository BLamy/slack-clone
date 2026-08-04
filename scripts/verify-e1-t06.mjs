import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseMentionCandidates,
  validateMentionFacts,
  ZERO_OFFSET,
} from "@stream-slack/protocol";
import {
  canonicalStateDigest,
  createInitialState,
  reduceEnvelope,
  replayRecords,
} from "@stream-slack/reducers";

import {
  createMentionAwareConversationDispatcher,
  prepareConversationEvent,
} from "../src/ledger/conversation-auth.mjs";
import {
  MentionResolutionError,
  resolveConversationMentions,
  resolveConversationMentionsStrict,
} from "../src/ledger/mentions.mjs";
import { createDispatchDoor } from "../src/ledger/dispatch.mjs";

const WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHANNEL_ID = "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const AUTHOR_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADA_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";
const AGENT_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_eeeeeeeeeeeeeeeeeeeeeeeeee";
const SERVICE_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_ffffffffffffffffffffffffff";
const DISABLED_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_gggggggggggggggggggggggggg";
const AMBIGUOUS_A_ID =
  "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_hhhhhhhhhhhhhhhhhhhhhhhhhh";
const AMBIGUOUS_B_ID =
  "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_jjjjjjjjjjjjjjjjjjjjjjjjjj";
const OUTSIDER_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_kkkkkkkkkkkkkkkkkkkkkkkkkk";
const FOREIGN_ID = "pr_bbbbbbbbbbbbbbbbbbbbbbbbbb_dddddddddddddddddddddddddd";

const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-1-the-workspace/E1-T06-canonical-structured-mentions",
);
const fixtureDirectory = path.join(taskDirectory, "fixtures");
const runId = String(
  process.env.TEST_RUN_ID ?? `verify-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/gu, "-");
const implementationCommit = String(
  process.env.E1_T06_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
assert.match(implementationCommit, /^[0-9a-f]{40}$/u);
assertImplementationBinding(implementationCommit);

const promoteEvidence = process.env.PROMOTE_EVIDENCE === "1";
if (promoteEvidence) {
  assert.equal(
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    "",
    "promoted E1-T06 evidence requires a clean tracked implementation tree",
  );
}

const artifactRoot = path.resolve(
  root,
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e1-t06", runId),
);
const evidenceDirectory = promoteEvidence
  ? path.join(taskDirectory, "evidence/e1-t06-final")
  : artifactRoot;
await mkdir(evidenceDirectory, { recursive: true });

const corpus = await readJson(
  path.join(fixtureDirectory, "mention-corpus.v1.json"),
);
const invalidFacts = await readJson(
  path.join(fixtureDirectory, "invalid/mention-facts.v1.json"),
);
const baseState = mentionState();

assert.equal(corpus.policyVersion, 1);
const parserEvidence = verifyParserCorpus(corpus);
const resolutionEvidence = verifyResolutionCorpus(corpus, baseState);
const refusalEvidence = verifyInvalidFacts(invalidFacts, baseState);
const preparedEvidence = verifyPreparation(baseState);
const dispatchEvidence = await verifyDispatchRetry(baseState);
const replayEvidence = verifyReplay(baseState);
const sensitivityEvidence = verifySensitivity(corpus);
const canaryScan = await verifyCanaryFiles();

const gates = [];
if (process.env.E1_T06_SKIP_GATES !== "1") {
  for (const [name, script] of [
    ["format", "format:check"],
    ["lint", "lint"],
    ["typecheck", "typecheck"],
    ["tests", "test"],
    ["build", "build"],
  ]) {
    const startedAt = Date.now();
    runPnpm(script, {
      ...process.env,
      BUILD_DIR: path.join(artifactRoot, "build"),
      E1_T06_IMPLEMENTATION_COMMIT: implementationCommit,
      E1_T06_SKIP_GATES: "1",
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
  task: "E1-T06",
  runId,
  implementationCommit,
  implementationTreeCleanAtStart: promoteEvidence,
  result: "PASS",
  replay:
    "Replay: N/A (server mention parsing and source binding) + mitigation: parser corpus, typed refusal matrix, retry/edit matrix, source-offset evidence, replay digest, and sensitivity proof",
  replayUploadAttempted: false,
  gates,
  canaryScan,
  parserEvidence,
  resolutionEvidence,
  refusalEvidence,
  preparedEvidence,
  dispatchEvidence,
  replayEvidence,
  sensitivityEvidence,
};

await writeJson(
  path.join(evidenceDirectory, "verification-summary.json"),
  summary,
);
await writeJson(
  path.join(evidenceDirectory, "parser-corpus.json"),
  parserEvidence,
);
await writeJson(
  path.join(evidenceDirectory, "resolution-refusal-matrix.json"),
  { ...resolutionEvidence, ...refusalEvidence },
);
await writeJson(
  path.join(evidenceDirectory, "dispatch-retry.json"),
  dispatchEvidence,
);
await writeJson(
  path.join(evidenceDirectory, "mention-replay-evidence.json"),
  replayEvidence,
);
await writeJson(
  path.join(evidenceDirectory, "sensitivity.json"),
  sensitivityEvidence,
);

console.log(JSON.stringify(summary, null, 2));

function verifyParserCorpus(corpus) {
  const observed = corpus.parserCases.map((fixture) => {
    const candidates = parseMentionCandidates(fixture.text);
    assert.deepEqual(
      candidates.map((candidate) => candidate.handle),
      fixture.handles,
      fixture.name,
    );
    return {
      handles: candidates.map((candidate) => candidate.handle),
      name: fixture.name,
      spans: candidates.map((candidate) => candidate.span),
      text: fixture.text,
    };
  });
  const invalid = (corpus.invalidParserCases ?? []).map((fixture) => {
    let observedCode;
    try {
      parseMentionCandidates(fixture.text);
    } catch (error) {
      observedCode = error.code;
    }
    assert.equal(observedCode, fixture.code, fixture.name);
    return { code: observedCode, name: fixture.name, result: "REFUSED" };
  });
  return {
    policyVersion: corpus.policyVersion,
    cases: observed,
    invalidCases: invalid,
    result: "PASS",
  };
}

function verifyResolutionCorpus(corpus, state) {
  const observed = [];
  for (const fixture of corpus.resolutionCases) {
    const input = {
      channelId: CHANNEL_ID,
      state,
      text: `@${fixture.handle}`,
      workspaceId: WORKSPACE_ID,
    };
    const plainText = resolveConversationMentions(input);
    if (fixture.result === "accepted") {
      assert.equal(plainText.mentions.length, 1, fixture.handle);
      assert.equal(plainText.mentions[0].kind, fixture.kind, fixture.handle);
      observed.push({
        code: null,
        handle: fixture.handle,
        kind: plainText.mentions[0].kind,
        principalId: plainText.mentions[0].principalId,
        result: "accepted",
      });
      continue;
    }
    assert.equal(plainText.mentions.length, 0, fixture.handle);
    assert.equal(plainText.refusals[0].code, fixture.code, fixture.handle);
    assert.throws(
      () => resolveConversationMentionsStrict(input),
      (error) =>
        error instanceof MentionResolutionError && error.code === fixture.code,
    );
    observed.push({
      code: plainText.refusals[0].code,
      handle: fixture.handle,
      identityLeaked: JSON.stringify(plainText.refusals).includes("pr_"),
      result: "plain-text",
    });
    assert.equal(observed.at(-1).identityLeaked, false);
  }
  return { cases: observed, result: "PASS" };
}

function verifyInvalidFacts(fixtures, state) {
  const observed = [];
  for (const fixture of fixtures.invalidFactCases) {
    let observedCode;
    try {
      if (fixture.facts) {
        validateMentionFacts(fixture.facts, fixture.text ?? "@ada", {
          expectedWorkspaceId: WORKSPACE_ID,
        });
      } else if (fixture.name === "forged-kind") {
        reduceEnvelope(
          state,
          messageEvent("a", {
            authorId: AUTHOR_ID,
            channelId: CHANNEL_ID,
            contentType: "text/plain",
            messageId: "invalid-kind",
            mentions: [fixture.fact],
            rootMessageId: null,
            text: "hello @ada",
          }),
          { offset: offset(1) },
        );
      } else {
        validateMentionFacts([fixture.fact], "hello @ada", {
          expectedWorkspaceId: WORKSPACE_ID,
        });
      }
    } catch (error) {
      observedCode = error.code;
    }
    assert.equal(observedCode, fixture.code, fixture.name);
    observed.push({
      code: observedCode,
      name: fixture.name,
      result: "REFUSED",
    });
  }
  return { cases: observed, result: "PASS" };
}

function verifyPreparation(state) {
  const prepared = prepareConversationEvent({
    actorId: AUTHOR_ID,
    operation: "channel.message.create",
    payload: {
      channelId: CHANNEL_ID,
      contentType: "text/plain",
      messageId: "prepared-message",
      rootMessageId: null,
      text: "hello @ada @helper",
    },
    state,
    workspaceId: WORKSPACE_ID,
  });
  assert.equal(prepared.data.mentions.length, 2);
  assert.equal(prepared.data.mentions[0].principalId, ADA_ID);
  assert.equal(prepared.data.mentions[1].principalId, AGENT_ID);
  return {
    mentionCount: prepared.data.mentions.length,
    sourceBoundBeforeAppend: false,
    result: "PASS",
  };
}

async function verifyDispatchRetry(state) {
  const stream = `channel:${CHANNEL_ID}`;
  const store = createMemoryStore();
  const door = createDispatchDoor({
    producerEpoch: 0,
    producerId: "e1-t06-verifier",
    streamStore: store,
  });
  const dispatch = createMentionAwareConversationDispatcher({
    dispatch: door.dispatch,
    lookupState: async () => state,
    withChannelFence: async (_context, operation) => operation(),
  });
  const request = {
    actorId: AUTHOR_ID,
    expectedHead: ZERO_OFFSET,
    idempotencyKey: "ik_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    operation: "channel.message.create",
    payload: {
      channelId: CHANNEL_ID,
      contentType: "text/plain",
      messageId: "retry-message",
      rootMessageId: null,
      text: "retry @ada",
    },
    stream,
    workspaceId: WORKSPACE_ID,
  };
  const first = await dispatch(request);
  const second = await dispatch(structuredClone(request));
  assert.deepEqual(first.event.mentions, second.event.mentions);
  assert.equal(first.receipt.eventDigest, second.receipt.eventDigest);
  assert.equal(first.receipt.nextOffset, second.receipt.nextOffset);
  assert.equal(store.dump(stream).length, 1);
  assert.equal(first.event.mentions[0].source.offset, first.receipt.nextOffset);

  const beforeRefused = store.dump(`channel:${CHANNEL_ID}:refusal`);
  assert.throws(
    () =>
      prepareConversationEvent({
        actorId: AUTHOR_ID,
        mentionMode: "refuse",
        operation: "channel.message.create",
        payload: {
          channelId: CHANNEL_ID,
          contentType: "text/plain",
          messageId: "refused-message",
          rootMessageId: null,
          text: "no @outsider",
        },
        state,
        workspaceId: WORKSPACE_ID,
      }),
    (error) => error instanceof MentionResolutionError,
  );
  assert.deepEqual(store.dump(`channel:${CHANNEL_ID}:refusal`), beforeRefused);
  door.close();
  return {
    firstSource: first.event.mentions[0].source,
    replayedSource: second.event.mentions[0].source,
    targetEventCountAfterRetry: store.dump(stream).length,
    refusalLeavesTargetUnchanged: true,
    result: "PASS",
  };
}

function verifyReplay(state) {
  const text = "hello @ada";
  const mention = resolveConversationMentions({
    channelId: CHANNEL_ID,
    state,
    text,
    workspaceId: WORKSPACE_ID,
  }).mentions[0];
  const created = messageEvent("a", {
    authorId: AUTHOR_ID,
    channelId: CHANNEL_ID,
    contentType: "text/plain",
    messageId: "replayed-message",
    mentions: [mention],
    rootMessageId: null,
    text,
  });
  const profile = event("principal.profile.updated", AUTHOR_ID, "b", {
    principalId: ADA_ID,
    profile: {
      displayName: "Ada Renamed",
      email: "ada@example.test",
      handle: "ada-renamed",
    },
    revision: 2,
  });
  const edit = event("channel.message.edited", AUTHOR_ID, "c", {
    channelId: CHANNEL_ID,
    contentType: "text/plain",
    expectedRevision: 1,
    messageId: "replayed-message",
    text: "edited without a new trigger",
  });
  const records = [
    { event: created, offset: offset(1) },
    { event: profile, offset: offset(2) },
    { event: edit, offset: offset(3) },
  ];
  const first = replayRecords(records, {
    initialState: structuredClone(state),
  });
  const second = replayRecords(structuredClone(records), {
    initialState: structuredClone(state),
  });
  assert.equal(first.finalStateDigest, second.finalStateDigest);
  const message = first.finalState.entities.messages["replayed-message"];
  assert.equal(message.mentions.length, 1);
  assert.equal(message.mentions[0].principalId, ADA_ID);
  assert.equal(message.mentions[0].handle, "ada");
  assert.equal(message.mentions[0].source.offset, offset(1));
  assert.equal(
    message.mentions[0].source.digest,
    canonicalStateDigest(created),
  );
  assert.equal(
    first.finalState.eventProvenance.filter(({ envelope }) =>
      ["channel.message.created", "channel.message.replied"].includes(
        envelope.eventType,
      ),
    ).length,
    1,
  );
  return {
    finalStateDigest: first.finalStateDigest,
    handleAfterProfileChange:
      first.finalState.entities.principals[ADA_ID].profile.handle,
    mentionStateDigest: canonicalStateDigest(message.mentions),
    perPrefixDigests: first.prefixes.map(
      ({ offset: itemOffset, stateDigest }) => ({
        offset: itemOffset,
        stateDigest,
      }),
    ),
    replayedTwiceWithIdenticalDigest: true,
    source: message.mentions[0].source,
    triggerFactCountAfterEdit: message.mentions.length,
    result: "PASS",
  };
}

function verifySensitivity(corpus) {
  const fenced = corpus.parserCases.find(
    (fixture) => fixture.name === "fenced-code",
  );
  const safe = parseMentionCandidates(fenced.text).map(({ handle }) => handle);
  const unsafePositiveControl = [
    ...fenced.text.matchAll(/@([a-z0-9][a-z0-9._-]{0,63})/gu),
  ].map((match) => match[1]);
  assert.deepEqual(safe, ["helper"]);
  assert.deepEqual(unsafePositiveControl, ["ada", "helper"]);
  return {
    codeFenceExclusion: "baseline rejects unsafe positive control",
    unsafePositiveControl,
    result: "PASS",
  };
}

async function verifyCanaryFiles() {
  const files = [
    path.join(fixtureDirectory, "mention-corpus.v1.json"),
    path.join(fixtureDirectory, "invalid/mention-facts.v1.json"),
  ];
  const patterns = [
    /bearer\s+[A-Za-z0-9._-]+/iu,
    /password\s*[=:]/iu,
    /api[_-]?key\s*[=:]/iu,
    /-----BEGIN [A-Z ]+-----/u,
  ];
  let matches = 0;
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const pattern of patterns) if (pattern.test(content)) matches += 1;
  }
  assert.equal(matches, 0);
  return {
    files: files.map((file) => path.relative(root, file)),
    forbiddenPatterns: 0,
    result: "PASS",
  };
}

function messageEvent(token, data) {
  return event("channel.message.created", AUTHOR_ID, token, data);
}

function event(eventType, actorId, token, data) {
  return {
    actorId,
    causation: null,
    correlationId: "cr_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    data,
    eventId: `ev_${token.repeat(26)}`,
    eventType,
    idempotencyKey: `ik_${token.repeat(26)}`,
    schemaVersion: 1,
    serverTimestamp: "2026-08-04T00:00:00.000Z",
    workspaceId: WORKSPACE_ID,
  };
}

function mentionState() {
  const state = createInitialState();
  state.entities.principals = {
    [AUTHOR_ID]: principal(AUTHOR_ID, "author", "human"),
    [ADA_ID]: principal(ADA_ID, "ada", "human"),
    [AGENT_ID]: principal(AGENT_ID, "helper", "agent", AUTHOR_ID),
    [SERVICE_ID]: principal(SERVICE_ID, "service", "service"),
    [DISABLED_ID]: principal(
      DISABLED_ID,
      "disabled",
      "human",
      null,
      "suspended",
    ),
    [AMBIGUOUS_A_ID]: principal(AMBIGUOUS_A_ID, "ambiguous", "human"),
    [AMBIGUOUS_B_ID]: principal(AMBIGUOUS_B_ID, "ambiguous", "human"),
    [OUTSIDER_ID]: principal(OUTSIDER_ID, "outsider", "human"),
    [FOREIGN_ID]: principal(FOREIGN_ID, "foreign", "human"),
  };
  state.entities.channels = {
    [CHANNEL_ID]: {
      channelId: CHANNEL_ID,
      creatorId: AUTHOR_ID,
      status: "active",
      workspaceId: WORKSPACE_ID,
    },
  };
  state.entities.memberships = {};
  state.entities.channelMemberships = {};
  for (const principalId of [
    AUTHOR_ID,
    ADA_ID,
    AGENT_ID,
    SERVICE_ID,
    DISABLED_ID,
    AMBIGUOUS_A_ID,
    AMBIGUOUS_B_ID,
  ]) {
    state.entities.memberships[membershipId(principalId)] = {
      principalId,
      status: "active",
      workspaceId: WORKSPACE_ID,
    };
    state.entities.channelMemberships[`${CHANNEL_ID}\u0000${principalId}`] = {
      channelId: CHANNEL_ID,
      principalId,
      status: "active",
      workspaceId: WORKSPACE_ID,
    };
  }
  return state;
}

function principal(
  principalId,
  handle,
  kind,
  ownedBy = null,
  status = "active",
) {
  return {
    kind,
    ownedBy,
    principalId,
    profile: {
      displayName: handle,
      email: kind === "service" ? "" : `${handle}@example.test`,
      handle,
    },
    profileRevision: 1,
    status,
    subjectBinding: {
      audience: "stream-slack",
      issuer: "auth0",
      subject: principalId,
    },
  };
}

function membershipId(principalId) {
  return `mb_${principalId.slice(3)}`;
}

function offset(sequence) {
  return `0000000000000000_${sequence.toString(16).padStart(16, "0")}`;
}

function createMemoryStore() {
  const streams = new Map();
  return {
    async append(stream, record, { streamSeq }) {
      const records = streams.get(stream) ?? [];
      const currentOffset = offset(records.length);
      if (streamSeq !== currentOffset) {
        const error = new Error("stale stream head");
        error.status = 409;
        throw error;
      }
      records.push(record);
      streams.set(stream, records);
      return { nextOffset: offset(records.length) };
    },
    async read(stream) {
      const records = streams.get(stream) ?? [];
      return { nextOffset: offset(records.length), records: [...records] };
    },
    dump(stream) {
      return [...(streams.get(stream) ?? [])];
    },
  };
}

function runPnpm(script, env) {
  execFileSync("pnpm", [script], {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
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
  const allowed = new Set([
    ".eforest/project.json",
    ".eforest/tasks/QUEUE.md",
    taskReadmePath,
  ]);
  const unexpected = changedPaths.filter(
    (filePath) =>
      !allowed.has(filePath) && !filePath.startsWith(evidencePrefix),
  );
  assert.deepEqual(
    unexpected,
    [],
    "implementation commit must bind the exact diff",
  );
}
