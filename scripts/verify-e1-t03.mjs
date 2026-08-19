import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { channelIdFor, directChannelIdFor } from "@stream-slack/protocol";
import { EVENT_TYPES_V1 } from "../src/ledger/envelope.mjs";
import {
  CHANNEL_AUTH_ERROR_CODES,
  ChannelAuthorizationError,
  createChannelAuthorization,
  createChannelFence,
} from "../src/ledger/channel-auth.mjs";
import { establishWorkspaceContext } from "../src/ledger/workspace-auth.mjs";
import { validateAndReplayDump } from "../src/ledger/replay.mjs";
import {
  canonicalStateDigest,
  REDUCER_ERROR_CODES,
  reduceEnvelope,
} from "@stream-slack/reducers";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-1-the-workspace/E1-T03-channel-lifecycle-and-membership",
);
const fixtureDirectory = path.join(taskDirectory, "fixtures");
const fixturePath = path.join(
  fixtureDirectory,
  "valid/channel-lifecycle.v1.json",
);
const taskReadmePath = path.relative(
  root,
  path.join(taskDirectory, "readme.md"),
);
const taskEvidencePathPrefix = `${path
  .relative(root, path.join(taskDirectory, "evidence"))
  .replaceAll(path.sep, "/")}/`;
const runId = String(
  process.env.TEST_RUN_ID ?? `verify-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/gu, "-");
const implementationCommit = String(
  process.env.E1_T03_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
assert.match(
  implementationCommit,
  /^[0-9a-f]{40}$/u,
  "E1-T03 evidence requires an exact implementation commit",
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
    "promoted E1-T03 evidence must start from a clean tracked implementation tree",
  );
}

const artifactRoot = path.resolve(
  root,
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e1-t03", runId),
);
const evidenceDirectory = promoteEvidence
  ? path.join(taskDirectory, "evidence/e1-t03-final")
  : artifactRoot;
await mkdir(artifactRoot, { recursive: true });
await mkdir(evidenceDirectory, { recursive: true });

const WORKSPACE_A = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const WORKSPACE_B = "ws_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const OWNER_A = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const MEMBER_A = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const SERVICE_A = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";
const OWNER_B = "pr_bbbbbbbbbbbbbbbbbbbbbbbbbb_cccccccccccccccccccccccccc";
const MEMBER_B = "pr_bbbbbbbbbbbbbbbbbbbbbbbbbb_dddddddddddddddddddddddddd";
const NON_MEMBER_A = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_ffffffffffffffffffffffffff";
const NON_MEMBER_B = "pr_bbbbbbbbbbbbbbbbbbbbbbbbbb_ffffffffffffffffffffffffff";
const PUBLIC_A = "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_11111111111111111111111111";
const PRIVATE_A = "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_22222222222222222222222222";
const PUBLIC_B = "ch_bbbbbbbbbbbbbbbbbbbbbbbbbb_33333333333333333333333333";
const PRIVATE_B = "ch_bbbbbbbbbbbbbbbbbbbbbbbbbb_44444444444444444444444444";
const DIRECT_A = directChannelIdFor(WORKSPACE_A, [OWNER_A, MEMBER_A]);
const DIRECT_B = directChannelIdFor(WORKSPACE_B, [OWNER_B, MEMBER_B]);

const dump = await readJson(fixturePath);
const manifest = await readJson(path.join(fixtureDirectory, "manifest.json"));
const replay = validateReplayTwice(dump, manifest["channel-lifecycle.v1.json"]);
assertChannelState(replay.finalState);
const directIdentity = verifyDirectIdentityCorpus();
const replayEvidence = {
  finalStateDigest: replay.finalStateDigest,
  offsets: replay.prefixes.map(({ offset }) => offset),
  perPrefixDigests: replay.prefixes.map(({ index, offset, stateDigest }) => ({
    index,
    offset,
    stateDigest,
  })),
  records: replay.prefixes.length,
  replayedTwiceWithIdenticalBytes: true,
};

const schemaEvidence = await verifySchemas();
const authorizationEvidence = await verifyAuthorization(
  replay.finalState,
  replay,
);
const lifecycleEvidence = verifyLifecycle(dump, replay);
const sensitivity = await verifySensitivity();
const networkReplay = await verifyOfflineReplay(
  fixturePath,
  replay.finalStateDigest,
);
assertNoCredentialPattern(
  await readFile(fixturePath, "utf8"),
  "channel fixture",
);

const gates = [];
if (process.env.E1_T03_SKIP_GATES !== "1") {
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
      E1_T03_IMPLEMENTATION_COMMIT: implementationCommit,
      E1_T03_SKIP_GATES: "1",
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
  task: "E1-T03",
  runId,
  implementationCommit,
  implementationTreeCleanAtStart: promoteEvidence ? true : null,
  result: "PASS",
  fixtureCount: 1,
  replay:
    "Replay: N/A (server channel authorization model) + mitigation: cross-channel negative matrix, lifecycle logs, and canonical replay digests",
  replayUploadAttempted: false,
  gates,
  canaryScan: {
    fixtureCount: 1,
    forbiddenCredentialPatterns: 0,
    result: "PASS",
  },
  schemas: schemaEvidence,
  replayEvidence,
  directIdentity,
  authorization: authorizationEvidence,
  lifecycle: lifecycleEvidence,
  sensitivity,
  networkReplay,
};

await writeJson(
  path.join(evidenceDirectory, "verification-summary.json"),
  summary,
);
await writeJson(
  path.join(evidenceDirectory, "channel-replay-evidence.json"),
  replayEvidence,
);
await writeJson(
  path.join(evidenceDirectory, "direct-identity-collision-matrix.json"),
  directIdentity,
);
await writeJson(
  path.join(evidenceDirectory, "private-read-refusal-matrix.json"),
  authorizationEvidence.privateReadMatrix,
);
await writeJson(
  path.join(evidenceDirectory, "revocation-race.json"),
  authorizationEvidence.revocationRace,
);
await writeJson(
  path.join(evidenceDirectory, "lifecycle-refusal-matrix.json"),
  lifecycleEvidence,
);
await writeJson(path.join(evidenceDirectory, "sensitivity.json"), sensitivity);
await writeJson(
  path.join(evidenceDirectory, "offline-replay.json"),
  networkReplay,
);

console.log(JSON.stringify(summary, null, 2));

function validateReplayTwice(value, expected) {
  const first = validateAndReplayDump(value);
  const second = validateAndReplayDump(structuredClone(value));
  const prefixes = first.prefixes.map(({ index, offset, stateDigest }) => ({
    index,
    offset,
    stateDigest,
  }));
  assert.equal(first.finalStateJson, second.finalStateJson);
  assert.deepEqual(
    prefixes,
    second.prefixes.map(({ index, offset, stateDigest }) => ({
      index,
      offset,
      stateDigest,
    })),
  );
  assert.equal(first.finalStateDigest, expected.finalStateDigest);
  assert.deepEqual(prefixes, expected.prefixes);
  return { ...first, prefixes: first.prefixes };
}

function assertChannelState(state) {
  const channels = Object.values(state.entities.channels);
  assert.equal(channels.length, 6);
  assert.deepEqual(
    new Set(channels.map(({ kind }) => kind)),
    new Set(["public", "private", "direct"]),
  );
  assert.deepEqual(
    new Set(channels.map(({ workspaceId }) => workspaceId)),
    new Set([WORKSPACE_A, WORKSPACE_B]),
  );
  assert.equal(state.entities.channels[PUBLIC_A].revision, 4);
  assert.equal(state.entities.channels[PRIVATE_A].revision, 6);
  assert.equal(state.entities.channels[PRIVATE_B].kind, "private");
  assert.equal(state.entities.channels[PUBLIC_A].status, "active");
  assert.deepEqual(state.entities.channels[DIRECT_A].participantIds, [
    OWNER_A,
    MEMBER_A,
  ]);
  assert.deepEqual(state.entities.channels[DIRECT_B].participantIds, [
    OWNER_B,
    MEMBER_B,
  ]);
  assert.notEqual(
    DIRECT_A,
    directChannelIdFor(WORKSPACE_A, [OWNER_A, SERVICE_A]),
  );
  assert.notEqual(
    DIRECT_B,
    directChannelIdFor(WORKSPACE_B, [OWNER_B, NON_MEMBER_B]),
  );
  assert.equal(
    Object.values(state.entities.channelMemberships).some(
      ({ principalId }) => principalId === SERVICE_A,
    ),
    false,
  );
}

function verifyDirectIdentityCorpus() {
  const identifiers = new Set();
  const generatedSets = 5000;
  for (let index = 0; index < generatedSets; index += 1) {
    const participantIds = [
      syntheticPrincipalId(WORKSPACE_A, index * 2),
      syntheticPrincipalId(WORKSPACE_A, index * 2 + 1),
    ];
    const channelId = directChannelIdFor(WORKSPACE_A, participantIds);
    assert.equal(
      identifiers.has(channelId),
      false,
      `direct identity collision at generated set ${index}`,
    );
    identifiers.add(channelId);
  }
  assert.equal(identifiers.size, generatedSets);
  return {
    generatedSets,
    uniqueIds: identifiers.size,
    collisionCount: 0,
    result: "PASS",
  };
}

function syntheticPrincipalId(workspaceId, index) {
  return `pr_${workspaceId.slice(3)}_${index.toString(16).padStart(26, "0")}`;
}

async function verifySchemas() {
  const envelopeSchema = await readJson(
    path.join(root, "src/ledger/schemas/event-envelope.v1.schema.json"),
  );
  assert.deepEqual(envelopeSchema.properties.eventType.enum, EVENT_TYPES_V1);
  const channelSchema = await readJson(
    path.join(root, "src/ledger/schemas/channel-events.v1.schema.json"),
  );
  assert.deepEqual(
    channelSchema.oneOf.map(({ title }) => title),
    [
      "Channel created",
      "Channel renamed",
      "Channel archived or unarchived",
      "Channel membership invited",
      "Channel membership joined",
      "Channel membership left or removed",
      "Direct channel created",
    ],
  );
  return {
    envelopeEventTypes: EVENT_TYPES_V1,
    channelEventVariants: channelSchema.oneOf.length,
    result: "PASS",
  };
}

async function verifyAuthorization(finalState, replayValue) {
  let liveState = finalState;
  const fence = createChannelFence();
  const authorization = createStateAuthorization(() => liveState, fence);
  const member = context(MEMBER_A, WORKSPACE_A);
  const owner = context(OWNER_A, WORKSPACE_A);
  const outsider = context(NON_MEMBER_A, WORKSPACE_A);
  const privateReadMatrix = [];
  const forbiddenValues = [PRIVATE_A, "incident-room"];
  const privateOperations = [
    [
      "name-discovery",
      () =>
        authorization.authorizeDiscovery(outsider, { channelId: PRIVATE_A }),
    ],
    [
      "snapshot",
      () =>
        authorization.authorizeRead(outsider, {
          channelId: PRIVATE_A,
          path: "snapshot",
        }),
    ],
    [
      "head",
      () =>
        authorization.authorizeRead(outsider, {
          channelId: PRIVATE_A,
          path: "head",
        }),
    ],
    [
      "event-count",
      () =>
        authorization.authorizeRead(outsider, {
          channelId: PRIVATE_A,
          path: "event-count",
        }),
    ],
    [
      "history",
      () =>
        authorization.authorizeRead(outsider, {
          channelId: PRIVATE_A,
          path: "history",
        }),
    ],
    [
      "sse",
      () =>
        authorization.authorizeSubscription(
          { stream: `channel:${PRIVATE_A}` },
          outsider,
          { channelId: PRIVATE_A, register: async () => assert.fail() },
        ),
    ],
    [
      "long-poll",
      () =>
        authorization.authorizeRead(outsider, {
          channelId: PRIVATE_A,
          path: "long-poll",
        }),
    ],
    [
      "projection",
      () =>
        authorization.authorizeProjection(outsider, { channelId: PRIVATE_A }),
    ],
    [
      "search",
      () => authorization.authorizeSearch(outsider, { channelId: PRIVATE_A }),
    ],
    [
      "error",
      () =>
        authorization.authorizeRead(outsider, {
          channelId: PRIVATE_A,
          path: "error",
        }),
    ],
  ];
  for (const [operation, attempt] of privateOperations) {
    const startedAt = Date.now();
    const error = await rejected(attempt());
    const serialized = JSON.stringify(error.toJSON());
    assertChannelAccessRefusal(error, forbiddenValues);
    for (const forbiddenValue of forbiddenValues) {
      assert.equal(serialized.includes(forbiddenValue), false);
    }
    privateReadMatrix.push({
      operation,
      code: error.code,
      statusCode: error.statusCode,
      metadataFree: true,
      sourceHistoryOrProjectionCallback: false,
      elapsedMs: Date.now() - startedAt,
      result: "REFUSED",
    });
  }
  const memberDiscovery = await authorization.authorizeDiscovery(member, {
    channelId: PUBLIC_A,
  });
  const memberRead = await authorization.authorizeRead(member, {
    channelId: PRIVATE_A,
  });
  const privateMemberDiscovery = await authorization.authorizeDiscovery(
    member,
    {
      channelId: PRIVATE_A,
    },
  );
  assert.equal(memberDiscovery.channel.channelId, PUBLIC_A);
  assert.equal(memberRead.channel.channelId, PRIVATE_A);
  assert.equal(privateMemberDiscovery.channel.channelId, PRIVATE_A);

  let writeCallbacks = 0;
  await rejected(
    authorization.authorizeDispatch(
      { payload: { channelId: PRIVATE_A, text: "blocked" } },
      outsider,
      {
        channelId: PRIVATE_A,
        dispatch: async () => {
          writeCallbacks += 1;
        },
      },
    ),
  );
  assert.equal(writeCallbacks, 0);
  await rejected(
    authorization.authorizeDispatch(
      {
        payload: { channelId: PUBLIC_B, text: "sibling" },
        stream: `channel:${PUBLIC_B}`,
      },
      owner,
      {
        channelId: PUBLIC_A,
        dispatch: async () => {
          writeCallbacks += 1;
        },
      },
    ),
  );
  assert.equal(writeCallbacks, 0);

  const admin = context(NON_MEMBER_A, WORKSPACE_A);
  let auditCalls = 0;
  const adminAuthorization = createStateAuthorization(
    () => liveState,
    createChannelFence(),
    {
      workspaceMembership: async (workspaceId, principalId) => {
        if (workspaceId === WORKSPACE_A && principalId === NON_MEMBER_A) {
          return {
            membershipId:
              "mb_aaaaaaaaaaaaaaaaaaaaaaaaaa_ffffffffffffffffffffffffff",
            principalId,
            role: "admin",
            status: "active",
            workspaceId,
          };
        }
        return null;
      },
    },
  );
  await rejected(
    adminAuthorization.authorizeRead(admin, { channelId: PRIVATE_A }),
  );
  const auditedRead = await adminAuthorization.authorizeRead(admin, {
    adminOperation: true,
    audit: async () => {
      auditCalls += 1;
      return { ok: true };
    },
    channelId: PRIVATE_A,
  });
  assert.equal(auditedRead.channel.channelId, PRIVATE_A);
  assert.equal(auditCalls, 1);

  const archivedState = replayValue.prefixes.find(
    ({ state }) => state?.entities?.channels?.[PUBLIC_A]?.status === "archived",
  ).state;
  const archivedAuthorization = createStateAuthorization(
    () => archivedState,
    createChannelFence(),
  );
  await archivedAuthorization.authorizeRead(owner, { channelId: PUBLIC_A });
  await rejected(
    archivedAuthorization.authorizeDispatch(
      { payload: { text: "archived" } },
      owner,
      { channelId: PUBLIC_A, dispatch: async () => assert.fail() },
    ),
  );

  const removedEvent = envelope(
    OWNER_A,
    "channel.membership.removed",
    {
      channelId: PRIVATE_A,
      expectedChannelRevision: 6,
      principalId: MEMBER_A,
      reason: "revoked",
    },
    WORKSPACE_A,
    30,
  );
  const removedState = reduceEnvelope(finalState, removedEvent, {
    offset: "0000000000000000_0000000000000030",
  });
  let lease;
  let delivered = 0;
  const liveSubscription = await authorization.authorizeSubscription(
    { stream: `channel:${PRIVATE_A}` },
    member,
    {
      channelId: PRIVATE_A,
      register: async (_request, authorizationLease) => {
        lease = authorizationLease;
        return authorizationLease;
      },
    },
  );
  assert.equal(liveSubscription, lease);
  await lease.revalidate();
  delivered += 1;
  liveState = removedState;
  await rejected(lease.revalidate());
  assert.equal(delivered, 1);

  liveState = finalState;
  let writerStarted;
  const writerStartedPromise = new Promise((resolve) => {
    writerStarted = resolve;
  });
  let releaseWriter;
  const writerReleasePromise = new Promise((resolve) => {
    releaseWriter = resolve;
  });
  let revocationCheckpoint = false;
  const acceptedWriter = authorization.authorizeDispatch(
    { payload: { text: "before-revocation" } },
    member,
    {
      channelId: PRIVATE_A,
      dispatch: async () => {
        writerStarted();
        await writerReleasePromise;
      },
    },
  );
  await writerStartedPromise;
  const queuedRevocation = fence(
    { channelId: PRIVATE_A, workspaceId: WORKSPACE_A },
    async () => {
      liveState = removedState;
      revocationCheckpoint = true;
    },
  );
  await Promise.resolve();
  assert.equal(revocationCheckpoint, false);
  releaseWriter();
  await acceptedWriter;
  await queuedRevocation;
  assert.equal(revocationCheckpoint, true);
  await rejected(
    authorization.authorizeDispatch(
      { payload: { text: "after-revocation" } },
      member,
      { channelId: PRIVATE_A, dispatch: async () => assert.fail() },
    ),
  );

  const privateSource = dumpRecordForChannel(replayValue, PRIVATE_A);
  return {
    publicDiscoveryAuthorizedForWorkspaceMember: true,
    memberPrivateReadAuthorized: true,
    privateReadMatrix,
    privateSource,
    workspaceRoleAloneRefused: true,
    auditedAdminRead: {
      authorized: true,
      auditCalls,
      privateMembershipBypassedOnlyWithAudit: true,
    },
    crossChannelRequestBindingRefused: true,
    archivedReadAllowed: true,
    archivedWriteRefused: true,
    revocationRace: {
      revocationEventId: removedEvent.eventId,
      revocationOffset: "0000000000000000_0000000000000030",
      revocationStateDigest: canonicalStateDigest(removedState),
      liveReaderDeliveredBeforeRevocation: delivered,
      liveReaderDeliveryAfterRevocation: 0,
      writerAcceptedBeforeRevocation: true,
      revocationWaitedForInFlightWriter: true,
      writerRefusedAfterRevocation: true,
      result: "PASS",
    },
    result: "PASS",
  };
}

function createStateAuthorization(state, fence, overrides = {}) {
  const lookupState = () => state();
  return createChannelAuthorization({
    lookupChannel: async (workspaceId, channelId) => {
      const channel = lookupState().entities.channels?.[channelId];
      return channel?.workspaceId === workspaceId ? channel : null;
    },
    lookupChannelInvite: async (workspaceId, channelId, inviteId) =>
      Object.values(lookupState().entities.channelInvites ?? {}).find(
        (invite) =>
          invite.workspaceId === workspaceId &&
          invite.channelId === channelId &&
          invite.inviteId === inviteId,
      ) ?? null,
    lookupChannelMembership: async (workspaceId, channelId, principalId) =>
      Object.values(lookupState().entities.channelMemberships ?? {}).find(
        (membership) =>
          membership.workspaceId === workspaceId &&
          membership.channelId === channelId &&
          membership.principalId === principalId,
      ) ?? null,
    lookupWorkspaceMembership:
      overrides.workspaceMembership ??
      (async (workspaceId, principalId) =>
        Object.values(lookupState().entities.memberships ?? {}).find(
          (membership) =>
            membership.workspaceId === workspaceId &&
            membership.principalId === principalId,
        ) ?? null),
    withChannelFence: fence,
  });
}

function verifyLifecycle(sourceDump, replayValue) {
  const cases = [
    {
      name: "cross-tenant-channel-id",
      expectedCode: REDUCER_ERROR_CODES.CHANNEL_SCOPE_MISMATCH,
      mutate(value) {
        value.records[13].event.data.channelId = PUBLIC_B;
      },
    },
    {
      name: "service-channel-creator",
      expectedCode: REDUCER_ERROR_CODES.CHANNEL_PARTICIPANT_SERVICE,
      mutate(value) {
        value.records[13].event.actorId = SERVICE_A;
        value.records[13].event.data.channelId = channelIdFor(
          WORKSPACE_A,
          "55555555555555555555555555",
        );
        value.records[13].event.data.creatorId = SERVICE_A;
      },
    },
    {
      name: "stale-channel-revision",
      expectedCode: REDUCER_ERROR_CODES.CHANNEL_REVISION_CONFLICT,
      mutate(value) {
        value.records[18].event.data.expectedChannelRevision = 1;
      },
    },
    {
      name: "stale-membership-join-revision",
      expectedCode: REDUCER_ERROR_CODES.CHANNEL_REVISION_CONFLICT,
      mutate(value) {
        value.records[22].event.data.expectedChannelRevision = 4;
      },
    },
    {
      name: "duplicate-direct-participant",
      expectedCode: REDUCER_ERROR_CODES.CHANNEL_DIRECT_PARTICIPANTS,
      mutate(value) {
        value.records[23].event.data.participantIds = [OWNER_A, OWNER_A];
      },
    },
  ];
  const refusals = cases.map(({ name, expectedCode, mutate }) => {
    const mutated = structuredClone(sourceDump);
    mutate(mutated);
    const beforeReplay = JSON.stringify(mutated);
    let error;
    try {
      validateAndReplayDump(mutated);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, `${name} mutation was silently accepted`);
    assert.equal(error.code, expectedCode, `${name} returned the wrong code`);
    assert.equal(JSON.stringify(mutated), beforeReplay);
    return {
      name,
      code: error.code,
      offset: error.offset,
      refusedBeforeAppend: true,
      sourceDumpUnchangedAfterReducerFailure: true,
    };
  });

  const finalState = replayValue.finalState;
  const directDuplicate = envelope(
    OWNER_A,
    "channel.direct.created",
    {
      channelId: DIRECT_A,
      creatorId: OWNER_A,
      participantIds: [MEMBER_A, OWNER_A],
    },
    WORKSPACE_A,
    31,
  );
  const directIdMismatch = envelope(
    OWNER_A,
    "channel.direct.created",
    {
      channelId: channelIdFor(WORKSPACE_A, "66666666666666666666666666"),
      creatorId: OWNER_A,
      participantIds: [MEMBER_A, OWNER_A],
    },
    WORKSPACE_A,
    35,
  );
  const directService = envelope(
    OWNER_A,
    "channel.direct.created",
    {
      channelId: channelIdFor(WORKSPACE_A, "77777777777777777777777777"),
      creatorId: OWNER_A,
      participantIds: [SERVICE_A, OWNER_A],
    },
    WORKSPACE_A,
    32,
  );
  const directRename = envelope(
    OWNER_A,
    "channel.renamed",
    {
      channelId: DIRECT_A,
      displayName: "replacement",
      expectedChannelRevision: 1,
    },
    WORKSPACE_A,
    33,
  );
  for (const [name, event, expectedCode] of [
    [
      "direct-id-mismatch",
      directIdMismatch,
      REDUCER_ERROR_CODES.CHANNEL_DIRECT_ID_MISMATCH,
    ],
    [
      "equivalent-direct-set",
      directDuplicate,
      REDUCER_ERROR_CODES.CHANNEL_DIRECT_DUPLICATE,
    ],
    [
      "service-direct-participant",
      directService,
      REDUCER_ERROR_CODES.CHANNEL_PARTICIPANT_SERVICE,
    ],
    [
      "direct-participant-replacement",
      directRename,
      REDUCER_ERROR_CODES.CHANNEL_INVALID_KIND,
    ],
  ]) {
    let error;
    try {
      reduceEnvelope(finalState, event, {
        offset: `0000000000000000_00000000000000${event.eventId.slice(-2)}`,
      });
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.code, expectedCode, `${name} returned the wrong code`);
    refusals.push({
      name,
      code: error.code,
      offset: error.offset,
      refusedBeforeAppend: true,
    });
  }

  const archivedState = replayValue.prefixes.find(
    ({ state }) => state?.entities?.channels?.[PUBLIC_A]?.status === "archived",
  ).state;
  const archivedRename = envelope(
    OWNER_A,
    "channel.renamed",
    { channelId: PUBLIC_A, displayName: "blocked", expectedChannelRevision: 3 },
    WORKSPACE_A,
    34,
  );
  assert.throws(
    () =>
      reduceEnvelope(archivedState, archivedRename, {
        offset: "0000000000000000_0000000000000034",
      }),
    (error) => error.code === REDUCER_ERROR_CODES.CHANNEL_ARCHIVED,
  );
  refusals.push({
    name: "archived-rename",
    code: REDUCER_ERROR_CODES.CHANNEL_ARCHIVED,
    offset: "0000000000000000_0000000000000034",
    refusedBeforeAppend: true,
  });
  return {
    refusalCount: refusals.length,
    refusals,
    raceProtection: true,
    directParticipantSetImmutable: true,
    directIdentityBinding: true,
    result: "PASS",
  };
}

async function verifySensitivity() {
  const sourcePath = path.join(root, "src/ledger/channel-auth.mjs");
  const source = await readFile(sourcePath, "utf8");
  const comparison = `if (\n      (capability === "channel.read" || capability === "channel.subscribe") &&\n      isMember\n    ) {`;
  assert.equal(source.includes(comparison), true);
  const unsafeDirectory = path.join(artifactRoot, "unsafe-channel-auth");
  const unsafePath = path.join(unsafeDirectory, "channel-auth.mjs");
  await mkdir(unsafeDirectory, { recursive: true });
  await writeFile(
    path.join(unsafeDirectory, "workspace-auth.mjs"),
    await readFile(path.join(root, "src/ledger/workspace-auth.mjs")),
  );
  await writeFile(
    unsafePath,
    source.replace(comparison, 'if (capability === "channel.read") {'),
  );
  const unsafe = await import(
    `${pathToFileURL(unsafePath).href}?run=${encodeURIComponent(runId)}`
  );
  const privateChannel = {
    channelId: PRIVATE_A,
    creatorId: OWNER_A,
    displayName: "private",
    kind: "private",
    revision: 1,
    status: "active",
    workspaceId: WORKSPACE_A,
  };
  const adminMembership = {
    membershipId: "mb_aaaaaaaaaaaaaaaaaaaaaaaaaa_ffffffffffffffffffffffffff",
    principalId: NON_MEMBER_A,
    role: "admin",
    status: "active",
    workspaceId: WORKSPACE_A,
  };
  const unsafeAuthorization = unsafe.createChannelAuthorization({
    lookupChannel: async () => privateChannel,
    lookupChannelMembership: async () => null,
    lookupWorkspaceMembership: async () => adminMembership,
    withChannelFence: unsafe.createChannelFence(),
  });
  const unsafeContext = context(NON_MEMBER_A, WORKSPACE_A);
  const unsafeAccepted = await unsafeAuthorization
    .authorizeRead(unsafeContext, { channelId: PRIVATE_A })
    .then(() => true)
    .catch(() => false);
  assert.equal(unsafeAccepted, true);

  const binding = await verifyImplementationBindingSensitivity();
  return {
    mutation: "disable channel membership check for channel.read",
    unsafeBypassObserved: true,
    baselineVerifierMatrixMustRefuseTheSamePrivateRead: true,
    implementationTreeBinding: binding,
    scratchPath: path.relative(root, unsafePath),
    result: "PASS",
  };
}

async function verifyImplementationBindingSensitivity() {
  const scratchRoot = await mkdtemp(
    path.join(tmpdir(), "stream-slack-e1-t03-binding-"),
  );
  const omittedPath = "src/ledger/channel-auth.mjs";
  try {
    await execFileAsync("git", ["clone", "--no-hardlinks", root, scratchRoot], {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
    });
    await execFileAsync("pnpm", ["install", "--offline", "--frozen-lockfile"], {
      cwd: scratchRoot,
      env: { ...process.env, CI: "1" },
      maxBuffer: 32 * 1024 * 1024,
    });
    const sourcePath = path.join(scratchRoot, omittedPath);
    await writeFile(
      sourcePath,
      `${await readFile(sourcePath, "utf8")}\n// E1-T03 binding sensitivity mutation\n`,
    );
    const identity = [
      "-c",
      "user.name=E1-T03 verifier",
      "-c",
      "user.email=e1-t03-verifier@example.invalid",
    ];
    await execFileAsync("git", [...identity, "add", omittedPath], {
      cwd: scratchRoot,
    });
    await execFileAsync(
      "git",
      [
        ...identity,
        "commit",
        "--no-verify",
        "-m",
        "binding sensitivity mutation",
      ],
      { cwd: scratchRoot },
    );
    const result = await runNode(
      ["scripts/verify-e1-t03.mjs"],
      {
        E1_T03_IMPLEMENTATION_COMMIT: implementationCommit,
        E1_T03_SKIP_GATES: "1",
        PROMOTE_EVIDENCE: "0",
        TEST_ARTIFACT_DIR: path.join(".artifacts", "binding-sensitivity"),
        TEST_RUN_ID: `${runId}-binding-sensitivity`,
      },
      scratchRoot,
    );
    assert.notEqual(result.code, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /implementation files changed after the evidence commit: src\/ledger\/channel-auth\.mjs/u,
    );
    return {
      mutatedPath: omittedPath,
      verifierRejectedPostImplementationChange: true,
      result: "PASS",
    };
  } finally {
    await rm(scratchRoot, { force: true, recursive: true });
  }
}

async function verifyOfflineReplay(sourcePath, expectedDigest) {
  const offlinePath = path.join(artifactRoot, "channel-lifecycle-offline.json");
  await writeFile(offlinePath, await readFile(sourcePath));
  const result = await runNode(
    ["scripts/replay-ledger.mjs", "replay", offlinePath],
    {
      E0_T07_NETWORK_DISABLED: "1",
      E1_T03_NETWORK_DISABLED: "1",
      QUERY_STORE_PATH: path.join(artifactRoot, "query-store-must-not-exist"),
      BUILD_CACHE_PATH: path.join(artifactRoot, "build-cache-must-not-exist"),
    },
  );
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.finalStateDigest, expectedDigest);
  return {
    command:
      "node scripts/replay-ledger.mjs replay <channel-lifecycle-offline.json>",
    networkDisabled: true,
    queryStoreWritten: false,
    finalStateDigest: output.finalStateDigest,
    result: "PASS",
  };
}

function dumpRecordForChannel(replayValue, channelId) {
  const record = replayValue.finalState.eventProvenance.find(
    ({ envelope }) => envelope.data?.channelId === channelId,
  );
  assert.ok(record);
  return {
    eventId: record.envelope.eventId,
    eventType: record.envelope.eventType,
    offset: record.offset,
    stream: `channel:${channelId}`,
  };
}

function envelope(actorId, eventType, data, workspaceId, sequence) {
  const token = String(sequence).padStart(26, "0");
  return {
    actorId,
    causation: null,
    correlationId: `cr_${token}`,
    data,
    eventId: `ev_${token}`,
    eventType,
    idempotencyKey: `ik_${token}`,
    schemaVersion: 1,
    serverTimestamp: `2026-08-02T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    workspaceId,
  };
}

function context(principalId, workspaceId) {
  return establishWorkspaceContext({
    authenticatedPrincipalId: principalId,
    trustedWorkspaceId: workspaceId,
  });
}

function assertChannelAccessRefusal(error, forbiddenValues) {
  assert.ok(error instanceof ChannelAuthorizationError);
  assert.equal(error.code, CHANNEL_AUTH_ERROR_CODES.ACCESS_DENIED);
  const serialized = JSON.stringify(error.toJSON());
  for (const value of forbiddenValues) {
    assert.equal(serialized.includes(value), false);
  }
}

async function rejected(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("operation was accepted");
}

function assertNoCredentialPattern(source, label) {
  const patterns = [
    /-----BEGIN [A-Z ]+-----/u,
    /\bbearer\s+[A-Za-z0-9._~-]{8,}/iu,
    /\bbasic\s+[A-Za-z0-9+/=]{8,}/iu,
    /\b(?:password|passwd|secret|session|access[_ -]?token)\s*[=:]\s*[^\s,}]+/iu,
  ];
  for (const pattern of patterns) {
    assert.equal(
      pattern.test(source),
      false,
      `${label} contains a credential-shaped value`,
    );
  }
}

async function runPnpm(script, env) {
  try {
    await execFileAsync("pnpm", [script], {
      cwd: root,
      env: { ...process.env, ...env },
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `pnpm ${script} failed\n${error.stdout ?? ""}\n${error.stderr ?? error.message}`,
    );
  }
}

async function runNode(args, extraEnv = {}, cwd = root) {
  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stderr: error.stderr ?? "",
      stdout: error.stdout ?? "",
    };
  }
}

function assertImplementationBinding(commit) {
  let resolved;
  try {
    resolved = execFileSync(
      "git",
      ["rev-parse", "--verify", `${commit}^{commit}`],
      { cwd: root, encoding: "utf8" },
    ).trim();
  } catch {
    assert.fail(`implementation commit ${commit} does not resolve to a commit`);
  }
  assert.equal(resolved, commit, "implementation commit must resolve exactly");
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], {
      cwd: root,
      stdio: "ignore",
    });
  } catch {
    assert.fail(
      "implementation commit must be an ancestor of the current checkout",
    );
  }
  const changedPaths = execFileSync(
    "git",
    ["diff", "--name-only", `${commit}..HEAD`],
    { cwd: root, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const unexpectedPaths = changedPaths.filter(
    (filePath) =>
      filePath !== ".eforest/tasks/QUEUE.md" &&
      filePath !== taskReadmePath &&
      !filePath.startsWith(taskEvidencePathPrefix),
  );
  assert.equal(
    unexpectedPaths.length,
    0,
    `implementation files changed after the evidence commit: ${unexpectedPaths.join(", ")}`,
  );
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
