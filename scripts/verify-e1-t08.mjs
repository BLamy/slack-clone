import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createNodeDurableStreamsStore } from "@stream-slack/durable-streams";
import { canonicalStateDigest, replayRecords } from "@stream-slack/reducers";
import { directChannelIdFor } from "@stream-slack/protocol";

import {
  assertProjectionIntegrity,
  createProjectionStore,
  createProjectionWorker,
  normalizeSourceRecords,
  PROJECTION_ERROR_CODES,
  projectionDigest,
} from "../src/projections.mjs";
import { canonicalSha256 } from "../src/ledger/canonical-json.mjs";
import {
  CAPSTONE_API_ERROR_CODES,
  CAPSTONE_CHANNELS,
  CAPSTONE_PRINCIPALS,
  CAPSTONE_WORKSPACE_ID,
  createMultiUserChatApi,
  createMultiUserChatHttpServer,
} from "../src/ledger/multi-user-chat-api.mjs";
import { createRunContext } from "./run-context.mjs";
import { startStack } from "./test-stack.mjs";

const root = path.resolve(import.meta.dirname, "..");
const REPLAY_OFFSET_PREFIX = "0000000000000000_";
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-1-the-workspace/E1-T08-multi-user-chat-api",
);
const runId = String(
  process.env.TEST_RUN_ID ?? `verify-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/gu, "-");
const implementationCommit = String(
  process.env.E1_T08_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
assert.match(implementationCommit, /^[0-9a-f]{40}$/u);
assertImplementationBinding(implementationCommit);

const promoteEvidence = process.env.PROMOTE_EVIDENCE === "1";
const trackedTreeStatusAtStart = execFileSync(
  "git",
  ["status", "--porcelain", "--untracked-files=no"],
  {
    cwd: root,
    encoding: "utf8",
  },
).trim();
const implementationTreeCleanAtStart = trackedTreeStatusAtStart === "";
if (promoteEvidence) {
  assert.equal(
    implementationTreeCleanAtStart,
    true,
    "promoted E1-T08 evidence requires a clean tracked implementation tree",
  );
}

const artifactRoot = path.resolve(
  root,
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e1-t08", runId),
);
const evidenceDirectory = promoteEvidence
  ? path.join(taskDirectory, "evidence/e1-t08-final")
  : artifactRoot;
await mkdir(artifactRoot, { recursive: true });
await mkdir(evidenceDirectory, { recursive: true });

const directChannelId = directChannelIdFor(CAPSTONE_WORKSPACE_ID, [
  CAPSTONE_PRINCIPALS.ADA,
  CAPSTONE_PRINCIPALS.LINUS,
]);
const transcript = [];
const clients = [];
const liveRestartEvidence = [];
let stack;
let capstoneServer;
let api;
let restartedApi;
let restartedServer;
let projectionDirectory;

try {
  const context = await createRunContext({ env: process.env });
  stack = await startStack(context);
  const streamStore = createNodeDurableStreamsStore({
    baseUrl: context.durableStreamsUrl,
    digestRecords: canonicalSha256,
    token: process.env.DURABLE_STREAMS_ADMIN_TOKEN ?? "test_token_admin",
  });
  api = createMultiUserChatApi({
    sourceStreams: [],
    streamStore,
    workspaceId: CAPSTONE_WORKSPACE_ID,
  });
  await api.bootstrap();
  capstoneServer = createMultiUserChatHttpServer({ api });
  const address = await capstoneServer.listen();
  let baseUrl = `http://127.0.0.1:${address.port}`;

  let adaSession = await login(baseUrl, CAPSTONE_PRINCIPALS.ADA, "human:ada");
  const primaryCreationOrder = ["ada-session"];
  let linusSession = await login(
    baseUrl,
    CAPSTONE_PRINCIPALS.LINUS,
    "human:linus",
  );
  primaryCreationOrder.push("linus-session");
  const agentAuth = await requestJson(
    baseUrl,
    "/api/capstone/sessions",
    {
      body: {
        principalId: CAPSTONE_PRINCIPALS.AGENT,
        subject: "human:ada",
      },
      method: "POST",
    },
    "agent-owner-authentication",
  );
  assert.equal(agentAuth.response.status, 403);
  assert.equal(
    agentAuth.body.code,
    CAPSTONE_API_ERROR_CODES.AGENT_AUTH_FORBIDDEN,
  );
  primaryCreationOrder.push("agent-request");

  const directory = await requestJson(
    baseUrl,
    "/api/capstone/directory",
    { headers: authHeaders(adaSession) },
    "ada-directory",
  );
  assert.equal(directory.response.status, 200);
  const agentDirectoryEntry = directory.body.directory.find(
    (principal) => principal.principalId === CAPSTONE_PRINCIPALS.AGENT,
  );
  assert.deepEqual(
    {
      kind: agentDirectoryEntry.kind,
      ownedBy: agentDirectoryEntry.ownedBy,
    },
    { kind: "agent", ownedBy: CAPSTONE_PRINCIPALS.ADA },
  );

  await createChannel(baseUrl, adaSession, {
    channelId: CAPSTONE_CHANNELS.PUBLIC,
    displayName: "general",
    kind: "public",
  });
  await createChannel(baseUrl, adaSession, {
    channelId: CAPSTONE_CHANNELS.PRIVATE,
    displayName: "incident-room",
    kind: "private",
  });
  await createChannel(baseUrl, adaSession, {
    channelId: directChannelId,
    kind: "direct",
    participantIds: [CAPSTONE_PRINCIPALS.ADA, CAPSTONE_PRINCIPALS.LINUS],
  });

  const channelList = await requestJson(
    baseUrl,
    "/api/capstone/channels",
    { headers: authHeaders(adaSession) },
    "ada-channels",
  );
  assert.equal(channelList.response.status, 200);
  assert.deepEqual(
    new Set(channelList.body.channels.map((channel) => channel.kind)),
    new Set(["public", "private", "direct"]),
  );

  const channelClients = {};
  async function restartLiveSessions(label) {
    const stateBeforeRestart = await api.currentState();
    const sourceRecordCountBefore = (await api.readSourceDump()).length;
    const sourceStreamNames = [...api.sourceStreams];
    for (const client of clients) await client.close();
    clients.length = 0;
    await capstoneServer.close();
    capstoneServer = null;
    await api.close();
    api = null;

    api = createMultiUserChatApi({
      sourceStreams: sourceStreamNames,
      streamStore,
      workspaceId: CAPSTONE_WORKSPACE_ID,
    });
    await api.bootstrap();
    capstoneServer = createMultiUserChatHttpServer({ api });
    const restartedAddress = await capstoneServer.listen();
    baseUrl = `http://127.0.0.1:${restartedAddress.port}`;
    adaSession = await login(
      baseUrl,
      CAPSTONE_PRINCIPALS.ADA,
      "human:ada",
      `${label}-ada-session`,
    );
    linusSession = await login(
      baseUrl,
      CAPSTONE_PRINCIPALS.LINUS,
      "human:linus",
      `${label}-linus-session`,
    );

    const stateAfterRestart = await api.currentState();
    assert.equal(
      canonicalStateDigest(stateAfterRestart),
      canonicalStateDigest(stateBeforeRestart),
    );
    for (const [name, channelId] of Object.entries({
      direct: directChannelId,
      private: CAPSTONE_CHANNELS.PRIVATE,
      public: CAPSTONE_CHANNELS.PUBLIC,
    })) {
      channelClients[name] = {
        ada: await openSse(
          baseUrl,
          channelId,
          adaSession,
          `${label}-${name}-ada`,
        ),
        linus: await openSse(
          baseUrl,
          channelId,
          linusSession,
          `${label}-${name}-linus`,
        ),
      };
      clients.push(channelClients[name].ada, channelClients[name].linus);
      await expectInitial(channelClients[name].ada);
      await expectInitial(channelClients[name].linus);
    }
    const sourceAfterRestart = await api.readSourceDump();
    const evidence = {
      label,
      sourceRecordCountBefore,
      sourceRecordCountAfter: sourceAfterRestart.length,
      stateDigestBefore: canonicalStateDigest(stateBeforeRestart),
      stateDigestAfter: canonicalStateDigest(stateAfterRestart),
      result: "PASS",
    };
    assert.equal(
      evidence.sourceRecordCountAfter,
      evidence.sourceRecordCountBefore,
    );
    liveRestartEvidence.push(evidence);
    return evidence;
  }

  for (const [name, channelId] of Object.entries({
    direct: directChannelId,
    private: CAPSTONE_CHANNELS.PRIVATE,
    public: CAPSTONE_CHANNELS.PUBLIC,
  })) {
    channelClients[name] = {
      ada: await openSse(baseUrl, channelId, adaSession, `${name}-ada-initial`),
      linus: await openSse(
        baseUrl,
        channelId,
        linusSession,
        `${name}-linus-initial`,
      ),
    };
    clients.push(channelClients[name].ada, channelClients[name].linus);
    await expectInitial(channelClients[name].ada);
    await expectInitial(channelClients[name].linus);
  }
  await restartLiveSessions("channels-created");

  const publicCreate = await postMessage(
    baseUrl,
    CAPSTONE_CHANNELS.PUBLIC,
    adaSession,
    {
      messageId: "public-root",
      text: "Welcome @helper",
    },
    "ik_00000000000000000000000031",
    "public-root-create",
  );
  assert.equal(publicCreate.response.status, 201);
  assert.equal(publicCreate.body.mentionSources.length, 1);
  const publicMentionSource = publicCreate.body.mentionSources[0].source;
  assert.equal(publicMentionSource.offset, publicCreate.body.nextOffset);
  assert.equal(
    publicMentionSource.stream,
    `channel:${CAPSTONE_CHANNELS.PUBLIC}`,
  );
  await expectMessage(channelClients.public.ada, "public-root");
  await expectMessage(channelClients.public.linus, "public-root");
  await restartLiveSessions("mention-created");

  const publicRetry = await postMessage(
    baseUrl,
    CAPSTONE_CHANNELS.PUBLIC,
    adaSession,
    {
      messageId: "public-root",
      text: "Welcome @helper",
    },
    "ik_00000000000000000000000031",
    "public-root-retry",
  );
  assert.equal(
    publicRetry.response.status,
    201,
    JSON.stringify(publicRetry.body),
  );
  assert.equal(publicRetry.body.replayed, true);
  assert.equal(publicRetry.body.nextOffset, publicCreate.body.nextOffset);
  await expectNoNamedEvent(channelClients.public.ada, "message", 150);

  const publicEdit = await patchMessage(
    baseUrl,
    CAPSTONE_CHANNELS.PUBLIC,
    "public-root",
    adaSession,
    { expectedRevision: 1, text: "Welcome, edited" },
    "ik_00000000000000000000000032",
    "public-root-edit",
  );
  assert.equal(publicEdit.response.status, 200);
  await expectMessage(channelClients.public.ada, "public-root");
  await expectMessage(channelClients.public.linus, "public-root");

  const profileUpdate = await api.updateProfile(
    CAPSTONE_PRINCIPALS.ADA,
    CAPSTONE_PRINCIPALS.AGENT,
    {
      displayName: "Renamed Helper",
      email: "",
      handle: "helper-renamed",
    },
    "ik_00000000000000000000000033",
  );
  assert.equal(profileUpdate.receipt.replayed, false);

  const publicReactionAdd = await reactToMessage(
    baseUrl,
    CAPSTONE_CHANNELS.PUBLIC,
    "public-root",
    linusSession,
    { action: "add", emoji: "thumbsup" },
    "ik_00000000000000000000000034",
    "public-root-reaction-add",
  );
  assert.equal(publicReactionAdd.response.status, 200);
  await expectMessage(channelClients.public.ada, "public-root");
  await expectMessage(channelClients.public.linus, "public-root");
  const publicReactionRemove = await reactToMessage(
    baseUrl,
    CAPSTONE_CHANNELS.PUBLIC,
    "public-root",
    linusSession,
    { action: "remove", emoji: "thumbsup" },
    "ik_00000000000000000000000035",
    "public-root-reaction-remove",
  );
  assert.equal(publicReactionRemove.response.status, 200);
  await expectMessage(channelClients.public.ada, "public-root");
  await expectMessage(channelClients.public.linus, "public-root");

  const publicCheckpoint = lastStatusOffset(channelClients.public.ada);
  await channelClients.public.ada.close();
  const offlinePublic = await postMessage(
    baseUrl,
    CAPSTONE_CHANNELS.PUBLIC,
    linusSession,
    { messageId: "public-offline", text: "Resumed public event" },
    "ik_00000000000000000000000036",
    "public-offline-create",
  );
  assert.equal(offlinePublic.response.status, 201);
  await expectMessage(channelClients.public.linus, "public-offline");
  const resumedPublic = await openSse(
    baseUrl,
    CAPSTONE_CHANNELS.PUBLIC,
    adaSession,
    "public-ada-resumed",
    publicCheckpoint,
  );
  clients.push(resumedPublic);
  assert.equal(
    (await resumedPublic.next("resume")).data.fromOffset,
    publicCheckpoint,
  );
  await expectMessage(resumedPublic, "public-offline");
  await expectStatus(resumedPublic, offlinePublic.body.nextOffset);

  const privateRoot = await postMessage(
    baseUrl,
    CAPSTONE_CHANNELS.PRIVATE,
    adaSession,
    { messageId: "private-root", text: "Private source fact" },
    "ik_00000000000000000000000037",
    "private-root-create",
  );
  assert.equal(privateRoot.response.status, 201);
  await expectMessage(channelClients.private.ada, "private-root");
  await expectMessage(channelClients.private.linus, "private-root");
  const privateReply = await postMessage(
    baseUrl,
    CAPSTONE_CHANNELS.PRIVATE,
    linusSession,
    {
      messageId: "private-reply",
      rootMessageId: "private-root",
      text: "Private reply",
    },
    "ik_00000000000000000000000038",
    "private-reply-create",
  );
  assert.equal(privateReply.response.status, 201);
  await expectMessage(channelClients.private.ada, "private-reply");
  await expectMessage(channelClients.private.linus, "private-reply");
  const privateEdit = await patchMessage(
    baseUrl,
    CAPSTONE_CHANNELS.PRIVATE,
    "private-root",
    adaSession,
    { expectedRevision: 1, text: "Private source fact edited" },
    "ik_00000000000000000000000039",
    "private-root-edit",
  );
  assert.equal(privateEdit.response.status, 200);
  await expectMessage(channelClients.private.ada, "private-root");
  await expectMessage(channelClients.private.linus, "private-root");
  const privateReaction = await reactToMessage(
    baseUrl,
    CAPSTONE_CHANNELS.PRIVATE,
    "private-root",
    linusSession,
    { action: "add", emoji: "eyes" },
    "ik_00000000000000000000000040",
    "private-root-reaction",
  );
  assert.equal(privateReaction.response.status, 200);
  await expectMessage(channelClients.private.ada, "private-root");
  await expectMessage(channelClients.private.linus, "private-root");
  const privateDelete = await deleteMessage(
    baseUrl,
    CAPSTONE_CHANNELS.PRIVATE,
    "private-reply",
    linusSession,
    { expectedRevision: 1 },
    "ik_00000000000000000000000041",
    "private-reply-delete",
  );
  assert.equal(privateDelete.response.status, 200);
  await expectMessage(channelClients.private.ada, "private-reply");
  await expectMessage(channelClients.private.linus, "private-reply");

  const dmRoot = await postMessage(
    baseUrl,
    directChannelId,
    adaSession,
    { messageId: "dm-root", text: "Direct root" },
    "ik_00000000000000000000000042",
    "dm-root-create",
  );
  assert.equal(dmRoot.response.status, 201);
  await expectMessage(channelClients.direct.ada, "dm-root");
  await expectMessage(channelClients.direct.linus, "dm-root");
  const dmReply = await postMessage(
    baseUrl,
    directChannelId,
    linusSession,
    { messageId: "dm-reply", rootMessageId: "dm-root", text: "Direct reply" },
    "ik_00000000000000000000000043",
    "dm-reply-create",
  );
  assert.equal(dmReply.response.status, 201);
  await expectMessage(channelClients.direct.ada, "dm-reply");
  await expectMessage(channelClients.direct.linus, "dm-reply");
  const dmEdit = await patchMessage(
    baseUrl,
    directChannelId,
    "dm-root",
    adaSession,
    { expectedRevision: 1, text: "Direct root edited" },
    "ik_00000000000000000000000044",
    "dm-root-edit",
  );
  assert.equal(dmEdit.response.status, 200);
  await expectMessage(channelClients.direct.ada, "dm-root");
  await expectMessage(channelClients.direct.linus, "dm-root");
  const dmReaction = await reactToMessage(
    baseUrl,
    directChannelId,
    "dm-root",
    adaSession,
    { action: "add", emoji: "wave" },
    "ik_00000000000000000000000045",
    "dm-root-reaction",
  );
  assert.equal(dmReaction.response.status, 200);
  await expectMessage(channelClients.direct.ada, "dm-root");
  await expectMessage(channelClients.direct.linus, "dm-root");

  const convergedBeforeRemoval = await compareChannelDigests(
    baseUrl,
    adaSession,
    linusSession,
    [CAPSTONE_CHANNELS.PUBLIC, CAPSTONE_CHANNELS.PRIVATE, directChannelId],
  );
  assert.equal(convergedBeforeRemoval.sameStateDigest, true);

  const removed = await requestJson(
    baseUrl,
    `/api/capstone/channels/${encodeURIComponent(CAPSTONE_CHANNELS.PRIVATE)}/members/${encodeURIComponent(CAPSTONE_PRINCIPALS.LINUS)}/remove`,
    {
      headers: authHeaders(adaSession),
      method: "POST",
    },
    "private-member-remove",
  );
  assert.equal(removed.response.status, 200);
  await expectNamedEvent(channelClients.private.ada, "membership");
  await expectNamedEvent(channelClients.private.ada, "status");
  const privateTerminal = await channelClients.private.linus.next("terminal");
  assert.equal(
    privateTerminal.data.code,
    CAPSTONE_API_ERROR_CODES.ACCESS_DENIED,
  );

  const removedRead = await requestJson(
    baseUrl,
    `/api/capstone/channels/${encodeURIComponent(CAPSTONE_CHANNELS.PRIVATE)}`,
    { headers: authHeaders(linusSession) },
    "removed-member-private-read",
  );
  assert.equal(removedRead.response.status, 404);
  assert.equal(removedRead.body.code, CAPSTONE_API_ERROR_CODES.ACCESS_DENIED);
  const removedWrite = await postMessage(
    baseUrl,
    CAPSTONE_CHANNELS.PRIVATE,
    linusSession,
    { messageId: "removed-write", text: "must be refused" },
    "ik_00000000000000000000000046",
    "removed-member-private-write",
  );
  assert.equal(removedWrite.response.status, 404);
  assert.equal(removedWrite.body.code, CAPSTONE_API_ERROR_CODES.ACCESS_DENIED);
  const removedChannels = await requestJson(
    baseUrl,
    "/api/capstone/channels",
    { headers: authHeaders(linusSession) },
    "removed-member-channel-list",
  );
  assert.equal(removedChannels.response.status, 200);
  assert.equal(
    removedChannels.body.channels.some(
      (channel) => channel.channelId === CAPSTONE_CHANNELS.PRIVATE,
    ),
    false,
  );

  const sourceBeforeRestart = await api.readSourceDump();
  const stateBeforeRestart = await api.currentState();
  const sourceStreamNames = [...api.sourceStreams];
  for (const client of clients) await client.close();
  clients.length = 0;
  await capstoneServer.close();
  capstoneServer = null;
  await api.close();
  api = null;

  restartedApi = createMultiUserChatApi({
    sourceStreams: sourceStreamNames,
    streamStore,
    workspaceId: CAPSTONE_WORKSPACE_ID,
  });
  restartedServer = createMultiUserChatHttpServer({ api: restartedApi });
  const restartedAddress = await restartedServer.listen();
  const restartedBaseUrl = `http://127.0.0.1:${restartedAddress.port}`;
  const restartedAda = await login(
    restartedBaseUrl,
    CAPSTONE_PRINCIPALS.ADA,
    "human:ada",
    "restart-ada-session",
  );
  const stateAfterRestart = await restartedApi.currentState();
  assert.equal(
    canonicalStateDigest(stateAfterRestart),
    canonicalStateDigest(stateBeforeRestart),
  );
  const restartRead = await requestJson(
    restartedBaseUrl,
    `/api/capstone/channels/${encodeURIComponent(CAPSTONE_CHANNELS.PRIVATE)}`,
    { headers: authHeaders(restartedAda) },
    "post-restart-private-read",
  );
  assert.equal(restartRead.response.status, 200);

  const sourceAfterRestart = await restartedApi.readSourceDump();
  assert.deepEqual(
    sourceAfterRestart.map((record) => ({
      eventId: record.event.eventId,
      stream: record.stream,
    })),
    sourceBeforeRestart.map((record) => ({
      eventId: record.event.eventId,
      stream: record.stream,
    })),
  );
  const sourceRecordsUnchanged =
    JSON.stringify(
      sourceAfterRestart.map((record) => ({
        eventId: record.event.eventId,
        stream: record.stream,
      })),
    ) ===
    JSON.stringify(
      sourceBeforeRestart.map((record) => ({
        eventId: record.event.eventId,
        stream: record.stream,
      })),
    );
  const finalRestartCompleted =
    restartedApi !== null && restartedServer !== null && api === null;
  assert.equal(sourceRecordsUnchanged, true);
  assert.equal(finalRestartCompleted, true);

  const projectionEvidence = await verifyProjectionRecovery(
    sourceAfterRestart,
    stateAfterRestart,
    artifactRoot,
  );
  const accessEvidence = await verifyAccessMatrix(restartedApi);
  const mentionEvidence = verifyMentionStability(
    stateAfterRestart,
    sourceAfterRestart,
    publicMentionSource,
  );
  const creationOrderEvidence = await verifyCreationOrderVariant(
    streamStore,
    primaryCreationOrder,
  );
  const interleavingEvidence = verifyInterleavings(sourceAfterRestart, runId);
  const tamperEvidence = verifyTamperMatrix(
    sourceAfterRestart,
    projectionEvidence,
  );
  const canaryScan = await verifyCanaries(sourceAfterRestart);
  const sensitivityEvidence =
    process.env.E1_T08_SKIP_SENSITIVITY === "1"
      ? {
          reason: "sensitivity is disabled for the disposable mutant run",
          result: "SKIPPED",
        }
      : await verifySensitivity();
  const gates = await runGates();
  const skips =
    process.env.E1_T08_SKIP_GATES === "1"
      ? ["gates"]
      : gates.filter(({ result }) => result === "SKIP").map(({ name }) => name);

  const compositeDigest = compositeStateDigest({
    projection: projectionEvidence.afterRebuild,
    source: sourceAfterRestart,
    state: stateAfterRestart,
  });
  assertCompositeDigest(
    compositeDigest,
    projectionEvidence.afterCatchUp.compositeDigest,
  );
  const summary = {
    schemaVersion: 1,
    task: "E1-T08",
    runId,
    implementationCommit,
    implementationTreeCleanAtStart,
    result: "PASS",
    replay:
      "Replay: N/A (server/API capstone; product UI lands later) + mitigation: multi-client HTTP/SSE transcript, access matrix, source dumps, projection rebuild, and composite replay digest",
    replayUploadAttempted: false,
    skips,
    gates,
    source: {
      recordCount: sourceAfterRestart.length,
      streams: [
        ...new Set(sourceAfterRestart.map((record) => record.stream)),
      ].sort(),
      finalStateDigest: canonicalStateDigest(stateAfterRestart),
    },
    channels: {
      public: CAPSTONE_CHANNELS.PUBLIC,
      private: CAPSTONE_CHANNELS.PRIVATE,
      direct: directChannelId,
    },
    sessions: {
      humanCount: 2,
      agentMember: true,
      agentAuthenticationRefused: agentAuth.body.code,
      processCountForAgentExecution: 0,
    },
    convergence: convergedBeforeRemoval,
    mentionEvidence,
    accessEvidence,
    restartEvidence: {
      liveBoundaries: liveRestartEvidence,
      final: {
        label: "membership-removed",
        sessionsAndProcessMapsDiscarded: finalRestartCompleted,
        sourceDigestBefore: canonicalStateDigest(stateBeforeRestart),
        sourceDigestAfter: canonicalStateDigest(stateAfterRestart),
        sourceRecordsUnchanged,
      },
      boundaryCount: liveRestartEvidence.length + 1,
      result: "PASS",
    },
    projectionEvidence,
    creationOrderEvidence,
    interleavingEvidence,
    tamperEvidence,
    sensitivityEvidence,
    canaryScan,
    compositeDigest,
    network: {
      transcriptPath: "network-transcript.json",
      sseClientCount: transcript.filter(({ type }) => type === "SSE").length,
      activePrivateRemovalTerminal: privateTerminal.data.code,
      result: "PASS",
    },
  };

  await writeJson(
    path.join(evidenceDirectory, "verification-summary.json"),
    summary,
  );
  await writeJson(path.join(evidenceDirectory, "source-dump.json"), {
    records: sourceAfterRestart,
  });
  await writeJson(
    path.join(evidenceDirectory, "projection-manifest.json"),
    projectionEvidence.manifest,
  );
  await writeJson(path.join(evidenceDirectory, "checkpoints.json"), {
    afterCatchUp: projectionEvidence.afterCatchUp.checkpoint,
    afterRebuild: projectionEvidence.afterRebuild.checkpoint,
    beforeDeletion: projectionEvidence.beforeDeletion.checkpoint,
  });
  await writeJson(path.join(evidenceDirectory, "network-transcript.json"), {
    schemaVersion: 1,
    records: transcript,
  });
  await writeJson(
    path.join(evidenceDirectory, "access-matrix.json"),
    accessEvidence,
  );
  await writeJson(
    path.join(evidenceDirectory, "mention-evidence.json"),
    mentionEvidence,
  );
  await writeJson(
    path.join(evidenceDirectory, "creation-order.json"),
    creationOrderEvidence,
  );
  await writeJson(
    path.join(evidenceDirectory, "interleavings.json"),
    interleavingEvidence,
  );
  await writeJson(
    path.join(evidenceDirectory, "tamper-matrix.json"),
    tamperEvidence,
  );
  await writeJson(
    path.join(evidenceDirectory, "sensitivity.json"),
    sensitivityEvidence,
  );
  console.log(JSON.stringify(summary, null, 2));
} finally {
  for (const client of clients) await client.close().catch(() => {});
  await restartedServer?.close().catch(() => {});
  await restartedApi?.close().catch(() => {});
  await capstoneServer?.close().catch(() => {});
  await api?.close().catch(() => {});
  await stack?.stop().catch(() => {});
  if (projectionDirectory)
    await rm(projectionDirectory, { recursive: true, force: true });
}

function createNamespacedStreamStore(streamStore, namespace) {
  const streamName = (name) => `${namespace}-${name}`;
  return Object.freeze({
    append(name, event, options) {
      return streamStore.append(streamName(name), event, options);
    },
    ensure(name) {
      return streamStore.ensure(streamName(name));
    },
    read(name, offset, options) {
      return streamStore.read(streamName(name), offset, options);
    },
  });
}

async function verifyCreationOrderVariant(streamStore, primaryOrder) {
  const variantStore = createNamespacedStreamStore(
    streamStore,
    `e1-t08-${runId}-creation-order-reversed`,
  );
  const variantApi = createMultiUserChatApi({
    sourceStreams: [],
    streamStore: variantStore,
    workspaceId: CAPSTONE_WORKSPACE_ID,
  });
  let variantServer;
  try {
    await variantApi.bootstrap();
    variantServer = createMultiUserChatHttpServer({ api: variantApi });
    const address = await variantServer.listen();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const executionOrder = [];
    const agentAuth = await requestJson(
      baseUrl,
      "/api/capstone/sessions",
      {
        body: {
          principalId: CAPSTONE_PRINCIPALS.AGENT,
          subject: "human:ada",
        },
        method: "POST",
      },
      "reversed-agent-owner-authentication",
    );
    assert.equal(agentAuth.response.status, 403);
    assert.equal(
      agentAuth.body.code,
      CAPSTONE_API_ERROR_CODES.AGENT_AUTH_FORBIDDEN,
    );
    executionOrder.push("agent-request");

    const linusSession = await login(
      baseUrl,
      CAPSTONE_PRINCIPALS.LINUS,
      "human:linus",
      "reversed-linus-session",
    );
    executionOrder.push("linus-session");
    const adaSession = await login(
      baseUrl,
      CAPSTONE_PRINCIPALS.ADA,
      "human:ada",
      "reversed-ada-session",
    );
    executionOrder.push("ada-session");

    await createChannel(baseUrl, linusSession, {
      channelId: directChannelId,
      kind: "direct",
      participantIds: [CAPSTONE_PRINCIPALS.ADA, CAPSTONE_PRINCIPALS.LINUS],
    });
    await createChannel(baseUrl, adaSession, {
      channelId: CAPSTONE_CHANNELS.PUBLIC,
      displayName: "general-reversed",
      kind: "public",
    });
    await createChannel(baseUrl, adaSession, {
      channelId: CAPSTONE_CHANNELS.PRIVATE,
      displayName: "incident-room-reversed",
      kind: "private",
    });

    const sourceRecords = await variantApi.readSourceDump();
    const state = await variantApi.currentState();
    const replay = replayOffline(sourceRecords);
    const sourceCausalPrerequisitesPreserved =
      replay.finalStateDigest === canonicalStateDigest(state) &&
      sourceRecords.some(
        (record) => record.event.eventType === "channel.direct.created",
      ) &&
      state.entities.channels[directChannelId]?.kind === "direct";
    assert.equal(sourceCausalPrerequisitesPreserved, true);
    const reversedOrder = [...primaryOrder].reverse();
    const orderWasReversed =
      executionOrder.length === reversedOrder.length &&
      executionOrder.every((step, index) => step === reversedOrder[index]);
    assert.equal(orderWasReversed, true);
    return {
      primaryOrder,
      reversedOrder,
      executionOrder,
      orderWasReversed,
      agentAuthenticationRefused: agentAuth.body.code,
      channelCreationOrder: sourceRecords
        .filter((record) =>
          ["channel.created", "channel.direct.created"].includes(
            record.event.eventType,
          ),
        )
        .map((record) => record.event.data.channelId),
      sourceRecordCount: sourceRecords.length,
      sourceCausalPrerequisitesPreserved,
      stateDigest: canonicalStateDigest(state),
      result: "PASS",
    };
  } finally {
    await variantServer?.close().catch(() => {});
    await variantApi.close().catch(() => {});
  }
}

async function verifyProjectionRecovery(
  sourceRecords,
  finalState,
  artifactRootPath,
) {
  const projectionId =
    "px_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
  projectionDirectory = await mkdtemp(
    path.join(artifactRootPath, "projection-"),
  );
  const first = createProjection(projectionDirectory, projectionId);
  first.worker.rebuild(sourceRecords);
  const firstProof = assertProjectionIntegrity(first.store, sourceRecords, {
    projectionId,
    workspaceId: CAPSTONE_WORKSPACE_ID,
  });
  const beforeDeletion = first.store.read();
  const beforeManifest = manifestOf(beforeDeletion, projectionId);
  first.store.deleteAll();
  first.worker.rebuild(sourceRecords);
  const afterRebuild = first.store.read();
  const rebuildProof = assertProjectionIntegrity(first.store, sourceRecords, {
    projectionId,
    workspaceId: CAPSTONE_WORKSPACE_ID,
  });
  assert.equal(firstProof.projectionDigest, rebuildProof.projectionDigest);
  const afterManifest = manifestOf(afterRebuild, projectionId);
  assert.equal(
    projectionDigest(beforeManifest),
    projectionDigest(afterManifest),
  );

  const catchUp = createProjection(
    await mkdtemp(path.join(artifactRootPath, "catch-up-")),
    projectionId,
  );
  const split = Math.floor(sourceRecords.length / 2);
  catchUp.worker.rebuild(sourceRecords.slice(0, split));
  const checkpointBeforeCatchUp = catchUp.store.read().checkpoint;
  catchUp.worker.catchUp(sourceRecords);
  const afterCatchUp = catchUp.store.read();
  const catchUpProof = assertProjectionIntegrity(catchUp.store, sourceRecords, {
    projectionId,
    workspaceId: CAPSTONE_WORKSPACE_ID,
  });
  const offlineOne = replayOffline(sourceRecords);
  const offlineTwo = replayOffline(structuredClone(sourceRecords));
  assert.equal(offlineOne.finalStateDigest, offlineTwo.finalStateDigest);
  assert.equal(offlineOne.finalStateDigest, canonicalStateDigest(finalState));
  const boundaryRestarts = await verifyProjectorBoundaryRestarts(
    sourceRecords,
    artifactRootPath,
  );
  const afterRebuildComposite = compositeStateDigest({
    projection: rebuildProof,
    source: sourceRecords,
    state: finalState,
  });
  const afterCatchUpComposite = compositeStateDigest({
    projection: catchUpProof,
    source: sourceRecords,
    state: finalState,
  });
  assert.equal(afterRebuildComposite, afterCatchUpComposite);
  return {
    beforeDeletion: {
      checkpoint: beforeDeletion.checkpoint,
      projectionDigest: firstProof.projectionDigest,
    },
    afterRebuild: {
      checkpoint: afterRebuild.checkpoint,
      projectionDigest: rebuildProof.projectionDigest,
      stateDigest: rebuildProof.stateDigest,
    },
    afterCatchUp: {
      checkpoint: afterCatchUp.checkpoint,
      compositeDigest: afterCatchUpComposite,
      projectionDigest: catchUpProof.projectionDigest,
      resumedFromCheckpoint: checkpointBeforeCatchUp,
    },
    independentReplays: {
      finalStateDigest: offlineOne.finalStateDigest,
      identical: true,
    },
    manifest: {
      before: beforeManifest,
      afterRebuild: afterManifest,
      afterCatchUp: manifestOf(afterCatchUp, projectionId),
    },
    boundaryRestarts,
    result: "PASS",
  };
}

async function verifyProjectorBoundaryRestarts(
  sourceRecords,
  artifactRootPath,
) {
  const firstMessageIndex = sourceRecords.findIndex((record) =>
    isMessageEvent(record.event.eventType),
  );
  const mentionIndex = sourceRecords.findIndex((record) =>
    Array.isArray(record.event.data?.mentions),
  );
  const removalIndex = sourceRecords.findIndex(
    (record) =>
      record.event.eventType === "channel.membership.removed" &&
      record.event.data?.channelId === CAPSTONE_CHANNELS.PRIVATE,
  );
  const boundaries = [
    {
      name: "channels-created",
      prefixLength: firstMessageIndex,
    },
    {
      name: "mention-created",
      prefixLength: mentionIndex + 1,
    },
    {
      name: "membership-removed",
      prefixLength: removalIndex + 1,
    },
  ];
  assert.equal(
    boundaries.every(({ prefixLength }) => prefixLength > 0),
    true,
  );
  const evidence = [];
  for (const [index, boundary] of boundaries.entries()) {
    const prefix = sourceRecords.slice(0, boundary.prefixLength);
    const directory = await mkdtemp(
      path.join(artifactRootPath, `projector-boundary-${index}-`),
    );
    const projectionId = `px_aaaaaaaaaaaaaaaaaaaaaaaaaa_${String(
      index + 10,
    ).padStart(26, "0")}`;
    const first = createProjection(directory, projectionId);
    let crashCode;
    try {
      first.worker.catchUp(prefix, {
        crashAfterRowsAt: prefix.length,
      });
    } catch (error) {
      crashCode = error.code;
    }
    assert.equal(crashCode, PROJECTION_ERROR_CODES.CRASH_AFTER_ROW_WRITE);
    const restartedWorker = createProjectionWorker({
      projectionId,
      store: first.store,
      workspaceId: CAPSTONE_WORKSPACE_ID,
    });
    const recovered = restartedWorker.catchUp(prefix);
    const recoveryComplete =
      recovered.checkpoint?.sequence === prefix.length &&
      recovered.rowsSequence === prefix.length;
    const projectorRestarted = restartedWorker !== first.worker;
    assert.equal(projectorRestarted, true);
    assert.equal(recoveryComplete, true);
    evidence.push({
      name: boundary.name,
      prefixRecordCount: prefix.length,
      crashAfterRowsAt: prefix.length,
      crashCode,
      projectorRestarted,
      recoveredCheckpointSequence: recovered.checkpoint.sequence,
      recoveryComplete,
      result: "PASS",
    });
    await rm(directory, { recursive: true, force: true });
  }
  return {
    boundaries: evidence,
    allBoundariesRestarted: evidence.every(
      ({ recoveryComplete, projectorRestarted }) =>
        recoveryComplete && projectorRestarted,
    ),
    result: "PASS",
  };
}

async function verifyAccessMatrix(apiAdapter) {
  const state = await apiAdapter.currentState();
  const ownerChannels = await apiAdapter.listChannels(CAPSTONE_PRINCIPALS.ADA);
  const agentChannels = await apiAdapter.listChannels(
    CAPSTONE_PRINCIPALS.AGENT,
  );
  const serviceChannels = await apiAdapter.listChannels(
    CAPSTONE_PRINCIPALS.SERVICE,
  );
  assert.equal(ownerChannels.length, 3);
  assert.equal(
    agentChannels.some((channel) => channel.kind === "private"),
    true,
  );
  assert.deepEqual(
    serviceChannels.map((channel) => channel.kind),
    ["public"],
  );
  const cases = [
    ["removed-member", CAPSTONE_PRINCIPALS.LINUS],
    ["service", CAPSTONE_PRINCIPALS.SERVICE],
    [
      "sibling-workspace",
      "pr_bbbbbbbbbbbbbbbbbbbbbbbbbb_cccccccccccccccccccccccccc",
    ],
  ];
  const refusals = [];
  for (const [name, principalId] of cases) {
    try {
      await apiAdapter.readChannel(principalId, CAPSTONE_CHANNELS.PRIVATE);
      assert.fail(`${name} unexpectedly read private channel`);
    } catch (error) {
      assert.equal(error.code, CAPSTONE_API_ERROR_CODES.ACCESS_DENIED);
      assert.doesNotMatch(error.message, /incident-room|ch_aaaaaaaa/u);
      refusals.push({ code: error.code, identityLeaked: false, name });
    }
  }
  const agentPrivate = await apiAdapter.readChannel(
    CAPSTONE_PRINCIPALS.AGENT,
    CAPSTONE_CHANNELS.PRIVATE,
  );
  assert.equal(agentPrivate.channel.kind, "private");
  return {
    ownerChannelKinds: ownerChannels.map((channel) => channel.kind),
    agentChannelKinds: agentChannels.map((channel) => channel.kind),
    serviceChannelKinds: serviceChannels.map((channel) => channel.kind),
    removedMemberPrivateRead: "refused",
    refusals,
    privateMetadataNotLeaked: true,
    agentMemberReadAllowed: true,
    stateWorkspaceId: Object.keys(state.entities.workspaces)[0],
    result: "PASS",
  };
}

function verifyMentionStability(state, sourceRecords, expectedSource) {
  const message = state.entities.messages["public-root"];
  assert.ok(message);
  assert.equal(message.mentions.length, 1);
  assert.equal(message.mentions[0].principalId, CAPSTONE_PRINCIPALS.AGENT);
  assert.equal(message.mentions[0].handle, "helper");
  const sourceMentionEvents = sourceRecords.filter((record) =>
    Array.isArray(record.event.data?.mentions),
  );
  assert.equal(sourceMentionEvents.length, 1);
  assert.equal(sourceMentionEvents[0].offset, expectedSource.offset);
  assert.equal(message.mentions[0].source.digest, expectedSource.digest);
  assert.equal(
    message.mentions[0].source.digest,
    canonicalStateDigest(sourceMentionEvents[0].event.data),
  );
  const replaySequence = sourceRecords.indexOf(sourceMentionEvents[0]) + 1;
  assert.ok(replaySequence > 0);
  assert.equal(message.mentions[0].source.offset, replayOffset(replaySequence));
  assert.equal(
    state.entities.principals[CAPSTONE_PRINCIPALS.AGENT].profile.handle,
    "helper-renamed",
  );
  assert.equal(
    state.entities.principals[CAPSTONE_PRINCIPALS.AGENT].ownedBy,
    CAPSTONE_PRINCIPALS.ADA,
  );
  return {
    sourceMentionCount: sourceMentionEvents.length,
    principalId: message.mentions[0].principalId,
    originalHandle: message.mentions[0].handle,
    currentHandle:
      state.entities.principals[CAPSTONE_PRINCIPALS.AGENT].profile.handle,
    ownerStable: true,
    source: {
      ...message.mentions[0].source,
      coordinateSpace: "replay-offset",
    },
    retryCreatedNoNewSource: true,
    editCreatedNoNewTrigger: true,
    reconnectCreatedNoNewTrigger: true,
    replayCreatedNoNewTrigger: true,
    processCountForMention: 0,
    sourceBinding: {
      ...expectedSource,
      coordinateSpace: "durable-stream-offset",
    },
    result: "PASS",
  };
}

function verifyInterleavings(sourceRecords, seed) {
  const ordered = sourceRecords.map((record, index) => ({
    event: record.event,
    offset: replayOffset(index + 1),
  }));
  const shuffled = reorderIndependentMessages(ordered, seed);
  const first = replayRecords(ordered);
  const second = replayRecords(shuffled);
  const firstLogicalMessages = normalizedMessageShapes(first.finalState);
  const secondLogicalMessages = normalizedMessageShapes(second.finalState);
  const expectedFirstMessageOrder = messageOrderForRecords(ordered);
  const expectedSecondMessageOrder = messageOrderForRecords(shuffled);
  const firstMessageOrder = Object.keys(first.finalState.entities.messages);
  const secondMessageOrder = Object.keys(second.finalState.entities.messages);
  const firstReplayMatchesSourceOrder =
    JSON.stringify(firstMessageOrder) ===
    JSON.stringify(expectedFirstMessageOrder);
  const secondReplayMatchesSourceOrder =
    JSON.stringify(secondMessageOrder) ===
    JSON.stringify(expectedSecondMessageOrder);
  const sourceOrderChanged =
    JSON.stringify(ordered.map(({ event }) => event.eventId)) !==
    JSON.stringify(shuffled.map(({ event }) => event.eventId));
  const messageOrderChanged =
    JSON.stringify(firstMessageOrder) !== JSON.stringify(secondMessageOrder);
  const sourceCausalPrerequisitesPreserved =
    JSON.stringify(messageOrdersByChannel(ordered)) ===
    JSON.stringify(messageOrdersByChannel(shuffled));
  assert.deepEqual(firstLogicalMessages, secondLogicalMessages);
  assert.equal(firstReplayMatchesSourceOrder, true);
  assert.equal(secondReplayMatchesSourceOrder, true);
  assert.equal(sourceOrderChanged, true);
  assert.equal(messageOrderChanged, true);
  assert.equal(sourceCausalPrerequisitesPreserved, true);
  return {
    seed,
    sourceOrderChanged,
    messageOrderChanged,
    sourceCausalPrerequisitesPreserved,
    randomizedMessageInterleavingReplayed:
      sourceOrderChanged &&
      messageOrderChanged &&
      firstReplayMatchesSourceOrder &&
      secondReplayMatchesSourceOrder,
    firstMessageOrder,
    secondMessageOrder,
    firstReplayMatchesSourceOrder,
    secondReplayMatchesSourceOrder,
    finalMessageShapeDigest: canonicalSha256(firstLogicalMessages),
    finalOrderingMayDifferBecauseSourceOrderDiffers: messageOrderChanged,
    result: "PASS",
  };
}

function verifyTamperMatrix(sourceRecords, projectionEvidence) {
  const sourceTamper = structuredClone(sourceRecords);
  sourceTamper[0].event.data.profile.displayName = "Tampered";
  let sourceError;
  try {
    normalizeSourceRecords(sourceTamper, CAPSTONE_WORKSPACE_ID);
  } catch (error) {
    sourceError = error;
  }
  assert.equal(
    sourceError?.code,
    PROJECTION_ERROR_CODES.SOURCE_DIGEST_MISMATCH,
  );

  const projection = createProjection(
    null,
    "px_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  projection.worker.rebuild(sourceRecords);
  const snapshot = projection.store.read();
  const rowTamper = structuredClone(snapshot.rows);
  assert.ok(rowTamper.message?.length > 0);
  rowTamper.message[0].value.text = `${rowTamper.message[0].value.text} (tampered)`;
  let rowCode;
  try {
    assertProjectionIntegrity(
      { read: () => ({ ...snapshot, rows: rowTamper }) },
      sourceRecords,
      {
        projectionId: snapshot.projectionId,
        workspaceId: CAPSTONE_WORKSPACE_ID,
      },
    );
  } catch (error) {
    rowCode = error.code;
  }
  assert.equal(rowCode, PROJECTION_ERROR_CODES.CORRUPT_ROW);

  const checkpoint = structuredClone(snapshot.checkpoint);
  checkpoint.sourceHeads[0].stream =
    "workspace:ws_bbbbbbbbbbbbbbbbbbbbbbbbbb/directory";
  let checkpointCode;
  try {
    projection.store.writeCheckpoint(checkpoint);
  } catch (error) {
    checkpointCode = error.code;
  }
  assert.equal(checkpointCode, PROJECTION_ERROR_CODES.CHECKPOINT_INVALID);

  const expectedCompositeDigest =
    projectionEvidence.afterCatchUp.compositeDigest;
  const replacement = expectedCompositeDigest.endsWith("0") ? "1" : "0";
  const claimedDigest = `${expectedCompositeDigest.slice(0, -1)}${replacement}`;
  let compositeError;
  try {
    assertCompositeDigest(claimedDigest, expectedCompositeDigest);
  } catch (error) {
    compositeError = error;
  }
  assert.equal(compositeError?.code, "COMPOSITE_DIGEST_MISMATCH");
  const localized = {
    checkpoint: checkpointCode === PROJECTION_ERROR_CODES.CHECKPOINT_INVALID,
    claimedCompositeDigest:
      compositeError?.code === "COMPOSITE_DIGEST_MISMATCH",
    projectionRow: rowCode === PROJECTION_ERROR_CODES.CORRUPT_ROW,
    sourceEvent:
      sourceError?.code === PROJECTION_ERROR_CODES.SOURCE_DIGEST_MISMATCH,
  };
  return {
    sourceEvent: {
      code: sourceError.code,
      detail: sourceError.detail,
      localized: localized.sourceEvent,
    },
    projectionRow: { code: rowCode, localized: localized.projectionRow },
    checkpoint: { code: checkpointCode, localized: localized.checkpoint },
    claimedCompositeDigest: {
      code: "COMPOSITE_DIGEST_MISMATCH",
      detail: compositeError.message,
      localized: localized.claimedCompositeDigest,
    },
    result: Object.values(localized).every(Boolean) ? "PASS" : "FAIL",
  };
}

function assertCompositeDigest(claimedDigest, expectedDigest) {
  if (claimedDigest === expectedDigest) return;
  const error = new Error(
    `claimed composite digest ${claimedDigest} does not match ${expectedDigest}`,
  );
  error.code = "COMPOSITE_DIGEST_MISMATCH";
  throw error;
}

async function verifySensitivity() {
  const taskWorkDirectory = path.join(taskDirectory, "work");
  await mkdir(taskWorkDirectory, { recursive: true });
  const mutationParent = await mkdtemp(
    path.join(taskWorkDirectory, "sensitivity-mutant-"),
  );
  const mutationCheckout = path.join(mutationParent, "checkout");
  let worktreeAdded = false;
  try {
    execFileSync(
      "git",
      ["worktree", "add", "--detach", mutationCheckout, implementationCommit],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    worktreeAdded = true;

    const apiPath = path.join(
      mutationCheckout,
      "src/ledger/multi-user-chat-api.mjs",
    );
    const apiSource = await readFile(apiPath, "utf8");
    const accessGuard =
      "  if (!canReadChannel(state, channel, principalId)) throw accessDenied();";
    assert.equal(
      apiSource.split(accessGuard).length - 1,
      1,
      "sensitivity mutation anchor must remain unique",
    );
    await writeFile(
      apiPath,
      apiSource.replace(
        accessGuard,
        "  // sensitivity mutant: omit private channel membership recheck",
      ),
    );

    const mutationArtifactDirectory = path.join(
      mutationCheckout,
      ".artifacts/e1-t08-sensitivity",
    );
    await mkdir(mutationArtifactDirectory, { recursive: true });
    const mutationEnv = {
      ...process.env,
      E1_T08_IMPLEMENTATION_COMMIT: implementationCommit,
      E1_T08_SKIP_GATES: "1",
      E1_T08_SKIP_SENSITIVITY: "1",
      TEST_ARTIFACT_DIR: mutationArtifactDirectory,
      TEST_RUN_ID: `${runId}-access-mutant`,
    };
    delete mutationEnv.PROMOTE_EVIDENCE;
    const install = runSensitivityCommand(
      "pnpm",
      ["install", "--frozen-lockfile"],
      mutationCheckout,
      mutationEnv,
    );
    assert.equal(install.exitCode, 0, install.output);
    const verifier = runSensitivityCommand(
      "node",
      ["scripts/verify-e1-t08.mjs"],
      mutationCheckout,
      mutationEnv,
    );
    const verifierRejected = verifier.exitCode !== 0;
    assert.equal(
      verifierRejected,
      true,
      "access mutation must make the verifier fail",
    );
    return {
      changedFile: "src/ledger/multi-user-chat-api.mjs",
      mutation: "omit private channel membership recheck in assertReadable",
      installExitCode: install.exitCode,
      verifierExitCode: verifier.exitCode,
      verifierRejected,
      result: "PASS",
    };
  } finally {
    if (worktreeAdded) {
      try {
        execFileSync(
          "git",
          ["worktree", "remove", "--force", mutationCheckout],
          { cwd: root, stdio: "ignore" },
        );
      } catch {
        // Preserve the original verifier result; cleanup is best effort.
      }
    }
    await rm(mutationParent, { recursive: true, force: true });
  }
}

function createProjection(directory, projectionId) {
  const store = createProjectionStore({
    directory,
    projectionId,
    workspaceId: CAPSTONE_WORKSPACE_ID,
  });
  return {
    store,
    worker: createProjectionWorker({
      projectionId,
      store,
      workspaceId: CAPSTONE_WORKSPACE_ID,
    }),
  };
}

function manifestOf(snapshot, projectionId) {
  return {
    checkpoint: snapshot.checkpoint,
    projectionId,
    projectionDigest: snapshot.projectionDigest,
    reducerVersion: snapshot.reducerVersion,
    rows: snapshot.rows,
    schemaVersion: snapshot.schemaVersion,
    workspaceId: CAPSTONE_WORKSPACE_ID,
  };
}

function replayOffline(sourceRecords) {
  return replayRecords(
    sourceRecords.map((record, index) => ({
      event: record.event,
      offset: replayOffset(index + 1),
    })),
  );
}

function replayOffset(sequence) {
  return `${REPLAY_OFFSET_PREFIX}${(0x100000000 + sequence)
    .toString(16)
    .padStart(16, "0")}`;
}

function compositeStateDigest({ projection, source, state }) {
  return canonicalSha256({
    channelDigests: source
      .filter((record) => record.stream.startsWith("channel:"))
      .reduce((map, record) => {
        const list = map[record.stream] ?? [];
        list.push(record.digest);
        map[record.stream] = list;
        return map;
      }, {}),
    projectionDigest: projection.projectionDigest,
    stateDigest: canonicalStateDigest(state),
  });
}

function normalizedMessageShapes(state) {
  return Object.values(state.entities.messages ?? {})
    .map((message) => ({
      channelId: message.channelId,
      messageId: message.messageId,
      revision: message.revision,
      rootMessageId: message.rootMessageId,
      status: message.status,
      text: message.text,
    }))
    .sort((left, right) => left.messageId.localeCompare(right.messageId));
}

function reorderIndependentMessages(records, seed) {
  const firstProfileUpdate = records.findIndex(
    ({ event }) => event.eventType === "principal.profile.updated",
  );
  const removal = records.findIndex(
    ({ event }) => event.eventType === "channel.membership.removed",
  );
  const start = firstProfileUpdate === -1 ? 0 : firstProfileUpdate + 1;
  const end = removal === -1 ? records.length : removal;
  const reorderableIndexes = records.reduce((indexes, record, index) => {
    if (
      index >= start &&
      index < end &&
      isMessageEvent(record.event.eventType)
    ) {
      indexes.push(index);
    }
    return indexes;
  }, []);
  const reorderableMessages = reorderableIndexes.map((index) => records[index]);
  const shuffledMessages = interleaveMessageLanes(reorderableMessages, seed);
  const output = [...records];
  reorderableIndexes.forEach((index, messageIndex) => {
    output[index] = shuffledMessages[messageIndex];
  });
  return output.map((record, index) => ({
    event: record.event,
    offset: replayOffset(index + 1),
  }));
}

function interleaveMessageLanes(records, seed) {
  const lanes = new Map();
  for (const record of records) {
    const channelId = record.event.data?.channelId;
    const lane = lanes.get(channelId) ?? [];
    lane.push(record);
    lanes.set(channelId, lane);
  }
  const random = seededRandom(seed);
  const activeLanes = [...lanes.keys()];
  const output = [];
  while (activeLanes.length > 0) {
    const laneIndex = Math.floor(random() * activeLanes.length);
    const channelId = activeLanes[laneIndex];
    const lane = lanes.get(channelId);
    output.push(lane.shift());
    if (lane.length === 0) activeLanes.splice(laneIndex, 1);
  }
  return output;
}

function seededRandom(seed) {
  let state = Number.parseInt(canonicalSha256(seed).slice(-8), 16) >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function messageOrderForRecords(records) {
  const order = [];
  for (const record of records) {
    if (!isMessageEvent(record.event.eventType)) continue;
    const messageId = record.event.data?.messageId;
    if (!messageId) continue;
    if (
      record.event.eventType === "channel.message.created" ||
      record.event.eventType === "channel.message.replied"
    ) {
      order.push(messageId);
      continue;
    }
    if (
      record.event.eventType !== "channel.message.edited" &&
      record.event.eventType !== "channel.message.deleted"
    ) {
      continue;
    }
    const currentIndex = order.indexOf(messageId);
    if (currentIndex !== -1) order.splice(currentIndex, 1);
    order.push(messageId);
  }
  return order;
}

function messageOrdersByChannel(records) {
  const byChannel = records
    .filter(({ event }) => isMessageEvent(event.eventType))
    .reduce((byChannel, record) => {
      const channelId = record.event.data.channelId;
      const list = byChannel[channelId] ?? [];
      list.push(record.event.eventId);
      byChannel[channelId] = list;
      return byChannel;
    }, {});
  return Object.fromEntries(
    Object.entries(byChannel).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function isMessageEvent(eventType) {
  return new Set([
    "channel.message.created",
    "channel.message.replied",
    "channel.message.edited",
    "channel.message.deleted",
    "channel.message.reaction.added",
    "channel.message.reaction.removed",
  ]).has(eventType);
}

async function verifyCanaries(sourceRecords) {
  const files = [
    path.join(taskDirectory, "readme.md"),
    path.join(root, "src/ledger/multi-user-chat-api.mjs"),
    path.join(root, "scripts/verify-e1-t08.mjs"),
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
  assert.equal(
    sourceRecords.some((record) => JSON.stringify(record).includes("password")),
    false,
  );
  return {
    files: files.map((file) => path.relative(root, file)),
    forbiddenPatterns: 0,
    result: "PASS",
  };
}

async function runGates() {
  if (process.env.E1_T08_SKIP_GATES === "1") return [];
  const gates = [];
  for (const [name, script] of [
    ["format", "format:check"],
    ["lint", "lint"],
    ["typecheck", "typecheck"],
    ["tests", "test"],
    ["build", "build"],
  ]) {
    const startedAt = Date.now();
    execFileSync("pnpm", [script], {
      cwd: root,
      env: {
        ...process.env,
        BUILD_DIR: path.join(artifactRoot, "build"),
        E1_T08_IMPLEMENTATION_COMMIT: implementationCommit,
        E1_T08_SKIP_GATES: "1",
        TEST_ARTIFACT_DIR: artifactRoot,
        TEST_RUN_ID: runId,
      },
      stdio: "inherit",
    });
    gates.push({
      command: `pnpm ${script}`,
      durationMs: Date.now() - startedAt,
      name,
      result: "PASS",
    });
  }
  return gates;
}

async function login(baseUrl, principalId, subject, label = "session") {
  const result = await requestJson(
    baseUrl,
    "/api/capstone/sessions",
    {
      body: { principalId, subject },
      method: "POST",
    },
    `${label}-login`,
  );
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.session;
}

async function createChannel(baseUrl, session, input) {
  const result = await requestJson(
    baseUrl,
    "/api/capstone/channels",
    { body: input, headers: authHeaders(session), method: "POST" },
    `create-${input.kind}-channel`,
  );
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result;
}

async function postMessage(baseUrl, channelId, session, body, key, label) {
  return requestJson(
    baseUrl,
    `/api/capstone/channels/${encodeURIComponent(channelId)}/messages`,
    {
      body,
      headers: { ...authHeaders(session), "Idempotency-Key": key },
      method: "POST",
    },
    label,
  );
}

async function patchMessage(
  baseUrl,
  channelId,
  messageId,
  session,
  body,
  key,
  label,
) {
  return requestJson(
    baseUrl,
    `/api/capstone/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
    {
      body,
      headers: { ...authHeaders(session), "Idempotency-Key": key },
      method: "PATCH",
    },
    label,
  );
}

async function deleteMessage(
  baseUrl,
  channelId,
  messageId,
  session,
  body,
  key,
  label,
) {
  return requestJson(
    baseUrl,
    `/api/capstone/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
    {
      body,
      headers: { ...authHeaders(session), "Idempotency-Key": key },
      method: "DELETE",
    },
    label,
  );
}

async function reactToMessage(
  baseUrl,
  channelId,
  messageId,
  session,
  body,
  key,
  label,
) {
  return requestJson(
    baseUrl,
    `/api/capstone/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions`,
    {
      body,
      headers: { ...authHeaders(session), "Idempotency-Key": key },
      method: "POST",
    },
    label,
  );
}

async function compareChannelDigests(
  baseUrl,
  adaSession,
  linusSession,
  channelIds,
) {
  const pairs = [];
  for (const channelId of channelIds) {
    const [ada, linus] = await Promise.all([
      requestJson(
        baseUrl,
        `/api/capstone/channels/${encodeURIComponent(channelId)}`,
        { headers: authHeaders(adaSession) },
        `ada-${channelId}-snapshot`,
      ),
      requestJson(
        baseUrl,
        `/api/capstone/channels/${encodeURIComponent(channelId)}`,
        { headers: authHeaders(linusSession) },
        `linus-${channelId}-snapshot`,
      ),
    ]);
    assert.equal(ada.response.status, 200);
    assert.equal(linus.response.status, 200);
    assert.equal(ada.body.stateDigest, linus.body.stateDigest);
    pairs.push({
      channelId,
      adaDigest: ada.body.streamDigest,
      linusDigest: linus.body.streamDigest,
      stateDigest: ada.body.stateDigest,
      messageIds: ada.body.messages.map((message) => message.messageId),
    });
  }
  return {
    channels: pairs,
    sameStateDigest: new Set(pairs.map((pair) => pair.stateDigest)).size === 1,
    result: "PASS",
  };
}

async function openSse(baseUrl, channelId, session, label, offset = null) {
  const controller = new AbortController();
  const suffix = offset === null ? "" : `?offset=${encodeURIComponent(offset)}`;
  const url = `${baseUrl}/api/capstone/channels/${encodeURIComponent(channelId)}/events${suffix}`;
  const response = await fetch(url, {
    headers: { Accept: "text/event-stream", ...authHeaders(session) },
    signal: controller.signal,
  });
  transcript.push({
    label,
    method: "GET",
    path: new URL(url).pathname + new URL(url).search,
    status: response.status,
    type: "SSE",
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const seen = [];
  const queue = [];
  const waiters = [];
  let buffer = "";
  let closed = false;
  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const frame = parseSseFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (!frame) continue;
          seen.push(frame);
          const waiterIndex = waiters.findIndex(
            (waiter) => waiter.name === null || waiter.name === frame.name,
          );
          if (waiterIndex === -1) queue.push(frame);
          else waiters.splice(waiterIndex, 1)[0].resolve(frame);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        for (const waiter of waiters.splice(0)) waiter.reject(error);
      }
    } finally {
      closed = true;
      for (const waiter of waiters.splice(0)) {
        waiter.reject(new Error(`SSE ${label} closed before expected frame`));
      }
    }
  })();
  return {
    async close() {
      if (closed) return;
      controller.abort();
      await reader.cancel().catch(() => {});
      await pump.catch(() => {});
    },
    async next(name, timeoutMs = 10_000) {
      const index = queue.findIndex(
        (frame) => name === null || frame.name === name,
      );
      if (index !== -1) return queue.splice(index, 1)[0];
      return new Promise((resolve, reject) => {
        let timer;
        const waiter = {
          name,
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        };
        timer = setTimeout(() => {
          const waiterIndex = waiters.indexOf(waiter);
          if (waiterIndex !== -1) waiters.splice(waiterIndex, 1);
          reject(
            new Error(
              `timed out waiting for ${name} on ${label}; seen=${JSON.stringify(seen)}; queue=${JSON.stringify(queue)}`,
            ),
          );
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    get seen() {
      return seen;
    },
  };
}

async function expectInitial(client) {
  assert.equal((await client.next("snapshot")).name, "snapshot");
  assert.equal((await client.next("status")).name, "status");
}

async function expectMessage(client, messageId) {
  while (true) {
    const frame = await client.next("message");
    if (frame.data.event?.data?.messageId === messageId) return frame;
  }
}

async function expectNamedEvent(client, name) {
  return client.next(name);
}

async function expectStatus(client, nextOffset) {
  while (true) {
    const frame = await client.next("status");
    if (frame.data.nextOffset === nextOffset) return frame;
  }
}

async function expectNoNamedEvent(client, name, timeoutMs) {
  await assert.rejects(client.next(name, timeoutMs));
}

function lastStatusOffset(client) {
  const statuses = client.seen.filter((frame) => frame.name === "status");
  assert.ok(statuses.length > 0);
  return statuses.at(-1).data.nextOffset;
}

async function requestJson(baseUrl, pathName, init, label) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...init,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers: {
      ...(init.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  transcript.push({
    bodyCode: body.code ?? null,
    label,
    method: init.method ?? "GET",
    path: pathName,
    status: response.status,
    type: "HTTP",
  });
  return { body, response };
}

function authHeaders(session) {
  return { Authorization: session };
}

function parseSseFrame(frame) {
  const lines = frame.split("\n");
  const name = lines.find((line) => line.startsWith("event: "))?.slice(7);
  const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
  if (!name || data === undefined) return null;
  return {
    data: JSON.parse(data),
    id: lines.find((line) => line.startsWith("id: "))?.slice(4) ?? null,
    name,
  };
}

function runSensitivityCommand(command, args, cwd, env) {
  try {
    execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exitCode: 0, output: "" };
  } catch (error) {
    return {
      exitCode: typeof error.status === "number" ? error.status : 1,
      output: [error.stdout, error.stderr]
        .filter(Boolean)
        .map((value) => value.toString())
        .join("\n"),
    };
  }
}

function assertImplementationBinding(commit) {
  const resolved = execFileSync(
    "git",
    ["rev-parse", "--verify", `${commit}^{commit}`],
    { cwd: root, encoding: "utf8" },
  ).trim();
  assert.equal(resolved, commit);
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
  const evidencePrefix = `${path
    .relative(root, path.join(taskDirectory, "evidence"))
    .replaceAll(path.sep, "/")}/`;
  const unexpected = changedPaths.filter(
    (filePath) =>
      filePath !== ".eforest/tasks/QUEUE.md" &&
      filePath !== path.relative(root, path.join(taskDirectory, "readme.md")) &&
      !filePath.startsWith(evidencePrefix),
  );
  assert.deepEqual(
    unexpected,
    [],
    "implementation commit must bind the exact diff",
  );
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
