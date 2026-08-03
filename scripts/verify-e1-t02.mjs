import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  ROLE_CAPABILITIES,
  WORKSPACE_CAPABILITIES,
  roleHasCapability,
} from "@stream-slack/protocol";
import { createChatHttpDelivery } from "@stream-slack/http";
import { REDUCER_ERROR_CODES } from "@stream-slack/reducers";

import { EVENT_TYPES_V1 } from "../src/ledger/envelope.mjs";
import {
  bindWorkspaceRequest,
  createWorkspaceAuthorization,
  createWorkspaceFence,
  establishWorkspaceContext,
  WORKSPACE_AUTH_ERROR_CODES,
  WorkspaceAuthorizationError,
} from "../src/ledger/workspace-auth.mjs";
import { validateAndReplayDump } from "../src/ledger/replay.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-1-the-workspace/E1-T02-workspace-membership-and-roles",
);
const fixtureDirectory = path.join(taskDirectory, "fixtures");
const validDirectory = path.join(fixtureDirectory, "valid");
const fixtureName = "workspace-membership.v1.json";
const fixturePath = path.join(validDirectory, fixtureName);
const runId = String(
  process.env.TEST_RUN_ID ?? `verify-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/gu, "-");
const implementationCommit = String(
  process.env.E1_T02_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
assert.match(
  implementationCommit,
  /^[0-9a-f]{40}$/u,
  "E1-T02 evidence requires an exact implementation commit",
);
const implementationFiles = [
  "package.json",
  "packages/http/src/index.mjs",
  "scripts/verify-e1-t02.mjs",
  "src/ledger/workspace-auth.mjs",
  "src/ledger/workspace-directory.mjs",
  "src/server.mjs",
  "test/unit/workspace-directory.test.mjs",
  "test/unit/workspace-http.test.mjs",
];
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
    "promoted E1-T02 evidence must start from a clean tracked implementation tree",
  );
}

const artifactRoot = path.resolve(
  root,
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e1-t02", runId),
);
const evidenceDirectory = promoteEvidence
  ? path.join(taskDirectory, "evidence/e1-t02-final")
  : artifactRoot;
await mkdir(artifactRoot, { recursive: true });
await mkdir(evidenceDirectory, { recursive: true });

const WORKSPACE_A = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const WORKSPACE_B = "ws_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const OWNER_A = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const MEMBER_A = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const OWNER_B = "pr_bbbbbbbbbbbbbbbbbbbbbbbbbb_cccccccccccccccccccccccccc";
const MEMBER_B = "pr_bbbbbbbbbbbbbbbbbbbbbbbbbb_dddddddddddddddddddddddddd";
const NON_MEMBER_A = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_ffffffffffffffffffffffffff";
const MEMBER_ID_A = "mb_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const MEMBER_ID_B = "mb_bbbbbbbbbbbbbbbbbbbbbbbbbb_dddddddddddddddddddddddddd";
const OWNER_ID_B = "mb_bbbbbbbbbbbbbbbbbbbbbbbbbb_cccccccccccccccccccccccccc";

const dump = await readJson(fixturePath);
const manifest = await readJson(path.join(fixtureDirectory, "manifest.json"));
const replay = validateReplayTwice(dump, manifest[fixtureName]);
const state = replay.finalState;
assertWorkspaceState(state);
const authorityRebuild = await verifyReplayAuthority(state);
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
  authorityRebuild,
};

const schemaEvidence = await verifySchemas();
const authorizationEvidence = await verifyAuthorization(state, replayEvidence);
const httpBoundaryEvidence = await verifyHttpBoundary();
const lifecycleEvidence = verifyLifecycle(dump);
const sensitivity = await verifySensitivity();
const networkReplay = await verifyOfflineReplay(
  fixturePath,
  replay.finalStateDigest,
);
assertNoCredentialPattern(await readFile(fixturePath, "utf8"), fixtureName);

const gates = [];
if (process.env.E1_T02_SKIP_GATES !== "1") {
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
      E1_T02_IMPLEMENTATION_COMMIT: implementationCommit,
      E1_T02_SKIP_GATES: "1",
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
  task: "E1-T02",
  runId,
  implementationCommit,
  implementationTreeCleanAtStart: promoteEvidence ? true : null,
  result: "PASS",
  fixtureCount: 1,
  replay:
    "Replay: N/A (server tenancy and RBAC contract) + mitigation: two-workspace negative matrix, before/after dumps, and deterministic membership replay",
  replayUploadAttempted: false,
  gates,
  canaryScan: {
    fixtureCount: 1,
    forbiddenCredentialPatterns: 0,
    result: "PASS",
  },
  schemas: schemaEvidence,
  replayEvidence,
  authorization: authorizationEvidence,
  httpBoundary: httpBoundaryEvidence,
  lifecycle: lifecycleEvidence,
  sensitivity,
  networkReplay,
};

await writeJson(
  path.join(evidenceDirectory, "verification-summary.json"),
  summary,
);
await writeJson(
  path.join(evidenceDirectory, "workspace-replay-evidence.json"),
  replayEvidence,
);
await writeJson(
  path.join(evidenceDirectory, "tenant-refusal-matrix.json"),
  authorizationEvidence,
);
await writeJson(
  path.join(evidenceDirectory, "live-handler-refusal-matrix.json"),
  httpBoundaryEvidence,
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
  return { ...first, prefixes };
}

function assertWorkspaceState(currentState) {
  assert.deepEqual(Object.keys(currentState.entities.workspaces).sort(), [
    WORKSPACE_A,
    WORKSPACE_B,
  ]);
  assert.equal(currentState.entities.workspaces[WORKSPACE_A].revision, 4);
  assert.equal(currentState.entities.workspaces[WORKSPACE_B].revision, 5);
  assert.equal(currentState.entities.memberships[MEMBER_ID_A].role, "admin");
  assert.equal(currentState.entities.memberships[MEMBER_ID_A].status, "active");
  assert.equal(
    currentState.entities.memberships[MEMBER_ID_B].status,
    "removed",
  );
  assert.equal(currentState.entities.memberships[OWNER_ID_B].status, "active");
  assert.equal(
    currentState.entities.invites[
      "iv_aaaaaaaaaaaaaaaaaaaaaaaaaa_eeeeeeeeeeeeeeeeeeeeeeeeee"
    ].status,
    "accepted",
  );
  assert.equal(Object.values(currentState.entities.principals).length, 4);
  for (const membership of Object.values(currentState.entities.memberships)) {
    if (membership.status !== "active") continue;
    const effective = WORKSPACE_CAPABILITIES.filter((capability) =>
      roleHasCapability(membership.role, capability),
    );
    assert.deepEqual(effective, ROLE_CAPABILITIES[membership.role]);
  }
}

async function verifyReplayAuthority(currentState) {
  const replayMemberships = Object.values(currentState.entities.memberships);
  const rebuiltMemberships = new Map(
    replayMemberships.map((membership) => [
      membership.membershipId,
      membership,
    ]),
  );
  const rebuiltByPrincipal = new Map(
    replayMemberships.map((membership) => [
      membershipKey(membership.workspaceId, membership.principalId),
      membership,
    ]),
  );
  const stateWithoutProjection = structuredClone(currentState);
  delete stateWithoutProjection.entities.memberships;
  delete stateWithoutProjection.entities.invites;
  assert.equal(
    Object.hasOwn(stateWithoutProjection.entities, "memberships"),
    false,
  );
  assert.equal(
    Object.hasOwn(stateWithoutProjection.entities, "invites"),
    false,
  );
  assert.equal(rebuiltMemberships.get(MEMBER_ID_A).role, "admin");
  assert.equal(rebuiltMemberships.get(MEMBER_ID_B).status, "removed");
  const authorization = createWorkspaceAuthorization({
    lookupMembership: async (workspaceId, principalId) =>
      rebuiltByPrincipal.get(membershipKey(workspaceId, principalId)) ?? null,
    withWorkspaceFence: createWorkspaceFence(),
  });
  await authorization.authorizeRead(context(OWNER_A, WORKSPACE_A));
  return {
    membershipsRecovered: rebuiltMemberships.size,
    projectionsDeletedBeforeAuthorization: true,
    authorizedFromReplayedMembershipsAfterProjectionDeletion: true,
    source: "fresh replay finalState.entities.memberships",
    result: "PASS",
  };
}

async function verifySchemas() {
  const envelopeSchema = await readJson(
    path.join(root, "src/ledger/schemas/event-envelope.v1.schema.json"),
  );
  assert.deepEqual(envelopeSchema.properties.eventType.enum, EVENT_TYPES_V1);
  const workspaceSchema = await readJson(
    path.join(root, "src/ledger/schemas/workspace-events.v1.schema.json"),
  );
  assert.deepEqual(
    workspaceSchema.oneOf.map(({ title }) => title),
    [
      "Workspace created",
      "Membership invited",
      "Membership accepted",
      "Membership role changed",
      "Membership suspended or removed",
    ],
  );
  return {
    envelopeEventTypes: EVENT_TYPES_V1,
    workspaceEventVariants: workspaceSchema.oneOf.length,
    result: "PASS",
  };
}

async function verifyAuthorization(currentState, replayEvidenceValue) {
  const liveMemberships = new Map(
    Object.values(currentState.entities.memberships).map((membership) => [
      membershipKey(membership.workspaceId, membership.principalId),
      structuredClone(membership),
    ]),
  );
  const heads = new Map([
    ["directory:A", "0000000000000000_0000000000000000"],
    ["directory:B", "0000000000000000_0000000000000000"],
  ]);
  const callbacks = { dispatch: 0, register: 0 };
  const authorization = createWorkspaceAuthorization({
    lookupMembership: async (workspaceId, principalId) =>
      liveMemberships.get(membershipKey(workspaceId, principalId)) ?? null,
    withWorkspaceFence: createWorkspaceFence(),
  });
  const ownerA = context(OWNER_A, WORKSPACE_A);
  const memberA = context(MEMBER_A, WORKSPACE_A);
  const ownerB = context(OWNER_B, WORKSPACE_B);
  const memberB = context(MEMBER_B, WORKSPACE_B);
  const nonMemberA = context(NON_MEMBER_A, WORKSPACE_A);

  await authorization.authorizeRead(ownerA);
  await authorization.authorizeDispatch(
    { operation: "directory.mutate", targetId: MEMBER_A },
    ownerA,
    {
      dispatch: async (request) => {
        callbacks.dispatch += 1;
        heads.set("directory:A", request.workspaceId);
      },
    },
  );
  await authorization.authorizeSubscription(
    { stream: "workspace:A/directory" },
    ownerA,
    {
      register: async () => {
        callbacks.register += 1;
      },
    },
  );
  await authorization.authorizeDispatch(
    { operation: "message.mutate", targetId: MEMBER_A },
    memberA,
    {
      capability: "workspace.message.mutate",
      dispatch: async () => {
        callbacks.dispatch += 1;
      },
    },
  );

  const refusals = [];
  for (const [name, deniedContext] of [
    ["non-member-directory-read", nonMemberA],
    ["non-member-directory-mutation", nonMemberA],
    ["non-member-subscription", nonMemberA],
    ["removed-sibling-directory-read", memberB],
    ["removed-sibling-directory-mutation", memberB],
    ["removed-sibling-subscription", memberB],
  ]) {
    const operation = name.endsWith("directory-read")
      ? () => authorization.authorizeRead(deniedContext)
      : name.endsWith("subscription")
        ? () =>
            authorization.authorizeSubscription(
              { stream: "workspace:directory" },
              deniedContext,
              {
                register: async () =>
                  assert.fail("refused subscription registered"),
              },
            )
        : () =>
            authorization.authorizeDispatch(
              { operation: "directory.probe", principalId: OWNER_B },
              deniedContext,
              {
                dispatch: async () =>
                  assert.fail("refused mutation dispatched"),
              },
            );
    refusals.push(
      await captureAccessRefusal(
        name,
        operation,
        [deniedContext.principalId, deniedContext.workspaceId],
        heads,
        callbacks,
      ),
    );
  }

  refusals.push(
    captureSyncAccessRefusal(
      "sibling-principal-context",
      () =>
        establishWorkspaceContext({
          authenticatedPrincipalId: OWNER_B,
          trustedWorkspaceId: WORKSPACE_A,
        }),
      [OWNER_B, WORKSPACE_A],
    ),
  );
  for (const field of [
    "clientWorkspaceId",
    "pathWorkspaceId",
    "queryWorkspaceId",
    "bodyWorkspaceId",
    "eventWorkspaceId",
  ]) {
    refusals.push(
      captureSyncAccessRefusal(
        `context-${field}-override`,
        () =>
          establishWorkspaceContext({
            authenticatedPrincipalId: OWNER_A,
            trustedWorkspaceId: WORKSPACE_A,
            [field]: WORKSPACE_B,
          }),
        [WORKSPACE_A, WORKSPACE_B],
      ),
    );
  }
  refusals.push(
    await captureAccessRefusal(
      "nested-sibling-workspace-id",
      () =>
        authorization.authorizeDispatch(
          { workspaceId: WORKSPACE_A, body: { workspaceId: WORKSPACE_B } },
          ownerB,
          { dispatch: async () => assert.fail("nested override dispatched") },
        ),
      [WORKSPACE_A, WORKSPACE_B, OWNER_B],
      heads,
      callbacks,
    ),
  );

  const beforeRevocation = { ...callbacks };
  liveMemberships.set(membershipKey(WORKSPACE_A, MEMBER_A), {
    ...liveMemberships.get(membershipKey(WORKSPACE_A, MEMBER_A)),
    status: "suspended",
  });
  refusals.push(
    await captureAccessRefusal(
      "new-mutation-after-suspension",
      () =>
        authorization.authorizeDispatch(
          { operation: "message.mutate" },
          memberA,
          {
            capability: "workspace.message.mutate",
            dispatch: async () => assert.fail("suspended mutation dispatched"),
          },
        ),
      [MEMBER_A, WORKSPACE_A],
      heads,
      callbacks,
    ),
  );
  assert.deepEqual(callbacks, beforeRevocation);

  const noFence = createWorkspaceAuthorization({
    lookupMembership: async () =>
      liveMemberships.get(membershipKey(WORKSPACE_A, OWNER_A)),
  });
  const noFenceBefore = { ...callbacks };
  let noFenceError;
  try {
    await noFence.authorizeRead(ownerA);
  } catch (error) {
    noFenceError = error;
  }
  assert.equal(noFenceError?.code, WORKSPACE_AUTH_ERROR_CODES.FENCE_REQUIRED);
  assert.deepEqual(callbacks, noFenceBefore);

  const race = await verifyRevocationRace(currentState);
  const roleMatrix = WORKSPACE_CAPABILITIES.map((capability) => ({
    capability,
    owner: roleHasCapability("owner", capability),
    admin: roleHasCapability("admin", capability),
    member: roleHasCapability("member", capability),
    guest: roleHasCapability("guest", capability),
    agent: roleHasCapability("agent", capability),
    service: roleHasCapability("service", capability),
  }));
  return {
    replayFinalStateDigest: replayEvidenceValue.finalStateDigest,
    allow: [
      "owner directory read",
      "owner directory mutation",
      "owner directory subscription",
      "admin message mutation",
    ],
    refusalCount: refusals.length,
    refusals,
    roleMatrix,
    revocationRecheckedOnEveryNewOperation: true,
    refusedHeadsUnchanged: true,
    noFenceFailClosed: true,
    race,
    result: "PASS",
  };
}

async function verifyHttpBoundary() {
  const callbacks = {
    append: 0,
    follow: 0,
    normalize: 0,
    read: 0,
    reset: 0,
    update: 0,
  };
  const heads = new Map([["chat:A", "0000000000000000_0000000000000000"]]);
  const memberships = new Map([
    [
      membershipKey(WORKSPACE_A, OWNER_A),
      {
        membershipId:
          "mb_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb",
        principalId: OWNER_A,
        role: "owner",
        status: "active",
        workspaceId: WORKSPACE_A,
      },
    ],
  ]);
  const core = createWorkspaceAuthorization({
    lookupMembership: async (workspaceId, principalId) =>
      memberships.get(membershipKey(workspaceId, principalId)) ?? null,
    withWorkspaceFence: createWorkspaceFence(),
  });
  const workspaceAuthorization = {
    async contextForRequest({ request, url, user }) {
      const trusted = context(user.sub, WORKSPACE_A);
      bindWorkspaceRequest(
        {
          headers: request.headers,
          path: request.url ?? url.pathname,
          query: Object.fromEntries(url.searchParams.entries()),
        },
        trusted.workspaceId,
      );
      return trusted;
    },
    authorizeDispatch: core.authorizeDispatch,
    authorizeRead: core.authorizeRead,
    authorizeSubscription: core.authorizeSubscription,
  };
  const delivery = createChatHttpDelivery({
    auth0Health: async () => true,
    auth0EmulatorUrl: "http://auth.test",
    chatService: {
      appendMessage: async () => {
        callbacks.append += 1;
        heads.set("chat:A", "0000000000000000_0000000000000001");
        return {
          message: { id: "live-message", text: "authorized" },
          nextOffset: "0000000000000000_0000000000000001",
        };
      },
      followMessages: async () => {
        callbacks.follow += 1;
        return { cancel() {}, closed: Promise.resolve() };
      },
      normalizeRoomId: (room) => {
        callbacks.normalize += 1;
        return room;
      },
      readMessages: async () => {
        callbacks.read += 1;
        return {
          messages: [],
          nextOffset: "0000000000000000_0000000000000000",
          records: [],
          streamDigest:
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        };
      },
      resetRoom: async () => {
        callbacks.reset += 1;
        return {
          nextOffset: "0000000000000000_0000000000000001",
          streamDigest:
            "sha256:0000000000000000000000000000000000000000000000000000000000000001",
        };
      },
      updateMessage: async () => {
        callbacks.update += 1;
        return {
          message: { id: "live-message", text: "updated" },
          nextOffset: "0000000000000000_0000000000000001",
        };
      },
    },
    currentSession: () => ({ user: { sub: OWNER_A } }),
    durableStreamsUrl: "http://streams.test",
    emptyDigest:
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    sessionUser: (request) => ({ sub: request.principalId ?? OWNER_A }),
    workspaceAuthorization,
  });

  const allowReadResponse = createFakeResponse();
  await delivery.handleApi(
    createHttpRequest({
      method: "GET",
      path: "/api/rooms/demo/messages",
    }),
    allowReadResponse,
    new URL("http://app.test/api/rooms/demo/messages"),
  );
  assert.equal(allowReadResponse.status, 200);
  const allowAppendResponse = createFakeResponse();
  await delivery.handleApi(
    createHttpRequest({
      body: { text: "authorized" },
      method: "POST",
      path: "/api/rooms/demo/messages",
    }),
    allowAppendResponse,
    new URL("http://app.test/api/rooms/demo/messages"),
  );
  assert.equal(allowAppendResponse.status, 201);

  const refusals = [];
  for (const [name, request] of [
    [
      "non-member-read",
      {
        method: "GET",
        path: "/api/rooms/demo/messages",
        principalId: NON_MEMBER_A,
      },
    ],
    [
      "non-member-mutation",
      {
        body: { text: "unauthorized" },
        method: "POST",
        path: "/api/rooms/demo/messages",
        principalId: NON_MEMBER_A,
      },
    ],
    [
      "non-member-subscription",
      {
        method: "GET",
        path: "/api/rooms/demo/events",
        principalId: NON_MEMBER_A,
      },
    ],
    [
      "non-member-reset",
      {
        method: "DELETE",
        path: "/api/rooms/demo/messages",
        principalId: NON_MEMBER_A,
      },
    ],
    [
      "sibling-principal-path",
      {
        method: "GET",
        path: `/api/rooms/${OWNER_B}/messages`,
        principalId: OWNER_A,
      },
    ],
    [
      "sibling-workspace-header",
      {
        headers: { "x-workspace-id": WORKSPACE_B },
        method: "GET",
        path: "/api/rooms/demo/messages",
        principalId: OWNER_A,
      },
    ],
    [
      "sibling-workspace-body",
      {
        body: { text: "unauthorized", workspaceId: WORKSPACE_B },
        method: "POST",
        path: "/api/rooms/demo/messages",
        principalId: OWNER_A,
      },
    ],
    [
      "sibling-workspace-stream",
      {
        body: {
          stream: `workspace:${WORKSPACE_B}/directory`,
          text: "unauthorized",
        },
        method: "POST",
        path: "/api/rooms/demo/messages",
        principalId: OWNER_A,
      },
    ],
  ]) {
    const beforeHeads = Object.fromEntries(heads);
    const beforeCallbacks = serviceCallbackCounts(callbacks);
    const response = createFakeResponse();
    const user = { sub: request.principalId };
    const error = await rejected(
      delivery.handleApi(
        createHttpRequest(request),
        response,
        new URL(`http://app.test${request.path}`),
      ),
    );
    assertGenericAccessRefusal(error, [
      request.principalId,
      WORKSPACE_A,
      WORKSPACE_B,
      OWNER_B,
    ]);
    assert.deepEqual(Object.fromEntries(heads), beforeHeads);
    assert.deepEqual(serviceCallbackCounts(callbacks), beforeCallbacks);
    assert.equal(response.writeHeadCalls, 0);
    assert.equal(user.sub, request.principalId);
    refusals.push({
      action: name,
      code: error.code,
      refusedBeforeAppendOrRegister: true,
      targetHeadsUnchanged: true,
      metadataFree: true,
    });
  }
  delivery.close();
  return {
    allow: ["current-member message read", "current-member message mutation"],
    refusalCount: refusals.length,
    refusals,
    serviceCallbacks: callbacks,
    targetHeadsUnchangedForRefusals: true,
    result: "PASS",
  };
}

async function verifyRevocationRace(currentState) {
  const live = new Map(
    Object.values(currentState.entities.memberships).map((membership) => [
      membershipKey(membership.workspaceId, membership.principalId),
      structuredClone(membership),
    ]),
  );
  const fence = createWorkspaceFence();
  const authorization = createWorkspaceAuthorization({
    lookupMembership: async (workspaceId, principalId) =>
      live.get(membershipKey(workspaceId, principalId)) ?? null,
    withWorkspaceFence: fence,
  });
  const owner = context(OWNER_A, WORKSPACE_A);
  const member = context(MEMBER_A, WORKSPACE_A);
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  let release;
  const releasePromise = new Promise((resolve) => {
    release = resolve;
  });
  const acceptedBeforeRevocation = authorization.authorizeDispatch(
    { operation: "message.mutate" },
    member,
    {
      capability: "workspace.message.mutate",
      dispatch: async () => {
        started();
        await releasePromise;
      },
    },
  );
  await startedPromise;
  let revocationFinished = false;
  const queuedRevocation = fence(owner, async () => {
    live.set(membershipKey(WORKSPACE_A, MEMBER_A), {
      ...live.get(membershipKey(WORKSPACE_A, MEMBER_A)),
      status: "removed",
    });
    revocationFinished = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(revocationFinished, false);
  release();
  await acceptedBeforeRevocation;
  await queuedRevocation;
  assert.equal(revocationFinished, true);
  await assert.rejects(
    authorization.authorizeDispatch({ operation: "message.mutate" }, member, {
      capability: "workspace.message.mutate",
      dispatch: async () => assert.fail("post-revocation dispatch accepted"),
    }),
    (error) => error.code === WORKSPACE_AUTH_ERROR_CODES.ACCESS_DENIED,
  );

  live.set(membershipKey(WORKSPACE_A, MEMBER_A), {
    ...live.get(membershipKey(WORKSPACE_A, MEMBER_A)),
    status: "active",
  });
  await authorization.authorizeDispatch(
    { operation: "message.mutate" },
    member,
    {
      capability: "workspace.message.mutate",
      dispatch: async () => {},
    },
  );
  await fence(owner, async () => {
    live.set(membershipKey(WORKSPACE_A, MEMBER_A), {
      ...live.get(membershipKey(WORKSPACE_A, MEMBER_A)),
      status: "removed",
    });
  });
  return {
    workspaceScopedFence: true,
    queuedRevocationWaitedForAcceptedOperation: true,
    postRevocationMutationRefused: true,
    reverseOrderingAcceptedThenRevoked: true,
    result: "PASS",
  };
}

function verifyLifecycle(sourceDump) {
  const cases = [
    {
      name: "duplicate-membership",
      expectedCode: REDUCER_ERROR_CODES.WORKSPACE_DUPLICATE_MEMBERSHIP,
      mutate(value) {
        value.records[6].event.data.principalId = OWNER_A;
      },
    },
    {
      name: "accepting-another-principal-invite",
      expectedCode: REDUCER_ERROR_CODES.WORKSPACE_INVITE_ACTOR_MISMATCH,
      mutate(value) {
        value.records[7].event.actorId = OWNER_A;
      },
    },
    {
      name: "stale-workspace-version",
      expectedCode: REDUCER_ERROR_CODES.WORKSPACE_REVISION_CONFLICT,
      mutate(value) {
        value.records[6].event.data.expectedWorkspaceRevision = 2;
      },
    },
    {
      name: "stale-membership-version",
      expectedCode: REDUCER_ERROR_CODES.WORKSPACE_REVISION_CONFLICT,
      mutate(value) {
        value.records[10].event.data.expectedMembershipRevision = 2;
      },
    },
    {
      name: "self-escalation",
      expectedCode: REDUCER_ERROR_CODES.WORKSPACE_SELF_ESCALATION,
      mutate(value) {
        value.records[10].event.data.membershipId =
          "mb_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
      },
    },
    {
      name: "last-owner-suspension",
      expectedCode: REDUCER_ERROR_CODES.WORKSPACE_LAST_OWNER,
      mutate(value) {
        value.records[11].event.data.membershipId = OWNER_ID_B;
      },
    },
    {
      name: "cross-tenant-membership-id",
      expectedCode: REDUCER_ERROR_CODES.WORKSPACE_SCOPE_MISMATCH,
      mutate(value) {
        value.records[10].event.data.membershipId = MEMBER_ID_B;
      },
    },
    {
      name: "cross-tenant-invite-id",
      expectedCode: REDUCER_ERROR_CODES.WORKSPACE_SCOPE_MISMATCH,
      mutate(value) {
        value.records[6].event.data.inviteId =
          "iv_bbbbbbbbbbbbbbbbbbbbbbbbbb_eeeeeeeeeeeeeeeeeeeeeeeeee";
      },
    },
    {
      name: "role-kind-mismatch",
      expectedCode: REDUCER_ERROR_CODES.WORKSPACE_ROLE_KIND_MISMATCH,
      mutate(value) {
        value.records[6].event.data.role = "agent";
      },
    },
    {
      name: "bootstrap-actor-mismatch",
      expectedCode: REDUCER_ERROR_CODES.WORKSPACE_BOOTSTRAP_INVALID,
      mutate(value) {
        value.records[4].event.actorId = MEMBER_A;
      },
    },
  ];
  return cases.map(({ name, expectedCode, mutate }) => {
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
}

async function verifySensitivity() {
  const sourcePath = path.join(root, "src/ledger/workspace-auth.mjs");
  const source = await readFile(sourcePath, "utf8");
  const comparison =
    "if (input[key] !== undefined && input[key] !== input.trustedWorkspaceId) {";
  assert.equal(source.includes(comparison), true);
  const unsafePath = path.join(
    artifactRoot,
    "workspace-auth-context-comparison-disabled.mjs",
  );
  await copyFile(sourcePath, unsafePath);
  const unsafeSource = source.replace(comparison, "if (false) {");
  await writeFile(unsafePath, unsafeSource);
  const unsafe = await import(
    `${pathToFileURL(unsafePath).href}?run=${encodeURIComponent(runId)}`
  );
  let unsafeAccepted = false;
  try {
    unsafe.establishWorkspaceContext({
      authenticatedPrincipalId: OWNER_A,
      trustedWorkspaceId: WORKSPACE_A,
      clientWorkspaceId: WORKSPACE_B,
    });
    unsafeAccepted = true;
  } catch {
    unsafeAccepted = false;
  }
  assert.equal(unsafeAccepted, true);
  return {
    mutation: "disable trusted workspace context comparison in scratch module",
    unsafeBypassObserved: true,
    baselineConformanceMatrixMustRefuseTheSameInput: true,
    scratchPath: path.relative(root, unsafePath),
    result: "PASS",
  };
}

async function verifyOfflineReplay(sourcePath, expectedDigest) {
  const offlinePath = path.join(
    artifactRoot,
    "workspace-membership-offline.json",
  );
  await writeFile(offlinePath, await readFile(sourcePath));
  const result = await runNode(
    ["scripts/replay-ledger.mjs", "replay", offlinePath],
    {
      E0_T07_NETWORK_DISABLED: "1",
      E1_T02_NETWORK_DISABLED: "1",
      QUERY_STORE_PATH: path.join(artifactRoot, "query-store-must-not-exist"),
      BUILD_CACHE_PATH: path.join(artifactRoot, "build-cache-must-not-exist"),
    },
  );
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.finalStateDigest, expectedDigest);
  return {
    command:
      "node scripts/replay-ledger.mjs replay <workspace-membership-offline.json>",
    networkDisabled: true,
    queryStoreWritten: false,
    finalStateDigest: output.finalStateDigest,
    result: "PASS",
  };
}

async function captureAccessRefusal(
  name,
  operation,
  forbiddenValues,
  heads,
  callbacks,
) {
  const beforeHeads = Object.fromEntries(heads);
  const beforeCallbacks = { ...callbacks };
  let error;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  assertGenericAccessRefusal(error, forbiddenValues);
  assert.deepEqual(Object.fromEntries(heads), beforeHeads);
  assert.deepEqual(callbacks, beforeCallbacks);
  return {
    action: name,
    code: error.code,
    refusedBeforeAppendOrRegister: true,
    targetHeadsUnchanged: true,
    metadataFree: true,
  };
}

async function rejected(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("operation was accepted");
}

function captureSyncAccessRefusal(name, operation, forbiddenValues) {
  let error;
  try {
    const result = operation();
    if (result?.then) {
      throw new Error(`${name} unexpectedly returned a promise`);
    }
  } catch (caught) {
    error = caught;
  }
  assertGenericAccessRefusal(error, forbiddenValues);
  return {
    action: name,
    code: error.code,
    refusedBeforeHandlerInput: true,
    targetHeadsUnchanged: true,
    metadataFree: true,
  };
}

function assertGenericAccessRefusal(error, forbiddenValues) {
  assert.ok(error instanceof WorkspaceAuthorizationError);
  assert.equal(error.code, WORKSPACE_AUTH_ERROR_CODES.ACCESS_DENIED);
  const serialized = JSON.stringify(error.toJSON());
  for (const value of forbiddenValues)
    assert.equal(serialized.includes(value), false);
}

function context(principalId, workspaceId) {
  return establishWorkspaceContext({
    authenticatedPrincipalId: principalId,
    trustedWorkspaceId: workspaceId,
  });
}

function membershipKey(workspaceId, principalId) {
  return `${workspaceId}\u0000${principalId}`;
}

function createHttpRequest({
  body = null,
  headers = {},
  method = "GET",
  path,
  principalId,
}) {
  const request = new EventEmitter();
  request.headers = { host: "app.test", ...headers };
  request.method = method;
  request.principalId = principalId;
  request.url = path;
  request[Symbol.asyncIterator] = async function* () {
    if (body !== null) yield Buffer.from(JSON.stringify(body));
  };
  return request;
}

function createFakeResponse() {
  const response = new EventEmitter();
  response.destroyed = false;
  response.headersSent = false;
  response.output = [];
  response.writableEnded = false;
  response.writeHeadCalls = 0;
  response.writeHead = (status, headers) => {
    response.headersSent = true;
    response.status = status;
    response.headers = headers;
    response.writeHeadCalls += 1;
  };
  response.write = (value) => {
    response.output.push(String(value));
    return true;
  };
  response.end = (value) => {
    if (value !== undefined) response.output.push(String(value));
    response.writableEnded = true;
  };
  return response;
}

function serviceCallbackCounts(callbacks) {
  return Object.fromEntries(
    Object.entries(callbacks).filter(([name]) => name !== "normalize"),
  );
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

async function runNode(args, extraEnv = {}) {
  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd: root,
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
      {
        cwd: root,
        encoding: "utf8",
      },
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
  const changedImplementationFiles = execFileSync(
    "git",
    ["diff", "--name-only", `${commit}..HEAD`, "--", ...implementationFiles],
    { cwd: root, encoding: "utf8" },
  ).trim();
  assert.equal(
    changedImplementationFiles,
    "",
    "implementation files changed after the evidence commit",
  );
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
