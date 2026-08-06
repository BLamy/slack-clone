import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalSha256 } from "../src/ledger/canonical-json.mjs";
import {
  createAgentConfigStream,
  replayAgentConfigStream,
} from "../src/ledger/agent-config-stream.mjs";
import { createDispatchDoor } from "../src/ledger/dispatch.mjs";
import {
  bindWorkspaceRequest,
  createWorkspaceAuthorization,
  createWorkspaceFence,
  establishWorkspaceContext,
} from "../src/ledger/workspace-auth.mjs";
import { createWorkspaceDirectoryAuthority } from "../src/ledger/workspace-directory.mjs";

const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-2-the-roster/E2-T03-agent-management-api-and-cli",
);
const artifactRoot = path.resolve(
  root,
  process.env.TEST_ARTIFACT_DIR ??
    path.join(
      ".artifacts",
      "e2-t03",
      String(
        process.env.TEST_RUN_ID ??
          `verify-${process.pid}-${Date.now().toString(36)}`,
      )
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/gu, "-"),
    ),
);
const evidenceDirectory =
  process.env.PROMOTE_EVIDENCE === "1"
    ? path.join(taskDirectory, "evidence/e2-t03-final")
    : artifactRoot;
const implementationCommit = String(
  process.env.E2_T03_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
const agentManagementModulePath = pathToFileURL(
  process.env.E2_T03_AGENT_MANAGEMENT_MODULE ??
    path.join(root, "src/ledger/agent-management.mjs"),
).href;
const { createAgentManagementApi } = await import(agentManagementModulePath);
const WORKSPACE_A = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const WORKSPACE_B = "ws_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADA = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER_PRINCIPAL =
  "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_ffffffffffffffffffffffffff";
const AGENT_A = `ag_${"a".repeat(26)}_${"d".repeat(26)}`;
const AGENT_B = `ag_${"a".repeat(26)}_${"e".repeat(26)}`;
const AGENT_C = `ag_${"a".repeat(26)}_${"f".repeat(26)}`;
const AGENT_PROVIDER = `ag_${"a".repeat(26)}_${"g".repeat(26)}`;
const PRINCIPAL_AGENT_A = `pr_${"a".repeat(26)}_${"d".repeat(26)}`;
const PRINCIPAL_AGENT_B = `pr_${"a".repeat(26)}_${"e".repeat(26)}`;
const PRINCIPAL_AGENT_C = `pr_${"a".repeat(26)}_${"f".repeat(26)}`;
const CANARY = "Bearer canary-token-123456789";
const cliPath = path.join(root, "scripts/agent-management-cli.mjs");

const key = (character) => `ik_${character.repeat(26)}`;
const KEYS = Object.freeze({
  activateOne: key("h"),
  activateTwo: key("j"),
  canary: key("k"),
  configCreate: key("a"),
  createA: key("b"),
  createB: key("c"),
  createC: key("g"),
  disable: key("m"),
  revoke: key("n"),
  revise: key("p"),
  providerCanary: key("t"),
  staleRevision: key("q"),
  crossAgentConfig: key("s"),
});

const httpTranscript = [];
const cliTranscript = [];
let currentApp = null;

await main();

async function main() {
  await mkdir(evidenceDirectory, { recursive: true });
  if (process.env.PROMOTE_EVIDENCE === "1") {
    assert.equal(
      execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      "",
      "promoted E2-T03 evidence requires a clean tracked implementation tree",
    );
  }

  const membershipFixture = await readJson(
    path.join(
      root,
      ".eforest/tasks/epic-1-the-workspace/E1-T02-workspace-membership-and-roles/fixtures/valid/workspace-membership.v1.json",
    ),
  );
  const configFixture = await readJson(
    path.join(
      root,
      ".eforest/tasks/epic-2-the-roster/E2-T01-versioned-agent-config-schema/fixtures/valid/agent-config.v1.json",
    ),
  );
  const bootstrapEvents = membershipFixture.records
    .filter(({ event }) => event.workspaceId === WORKSPACE_A)
    .map(({ event }) => event);
  assert.equal(bootstrapEvents.length, 6);

  const streamStore = createMemoryStore();
  let app = await createApp({ bootstrapEvents, streamStore });
  currentApp = app;
  try {
    const summary = await verifyWorkflow({
      app,
      configFixture,
      bootstrapEvents,
      streamStore,
    });
    await writeJson("verification-summary.json", summary);
    await writeJson("http-transcript.json", httpTranscript);
    await writeJson("cli-transcript.json", cliTranscript);
    await writeJson("pagination.json", summary.pagination);
    await writeJson("retry-matrix.json", summary.retries);
    await writeJson("redaction.json", summary.redaction);
    await writeJson("restart.json", summary.restart);
    await writeJson("sensitivity.json", summary.sensitivity);
    console.log(
      JSON.stringify(
        {
          result: summary.result,
          task: summary.task,
          implementationCommit,
          directoryStateDigest: summary.finalReplay.directoryStateDigest,
          configStateDigest: summary.finalReplay.configStateDigest,
          logicalConfigEvents: summary.finalReplay.configEventCount,
          retries: summary.retries.everyMutationReturnedOriginalReceipt,
          redaction: summary.redaction.canaryAbsentEverywhere,
          restart: summary.restart.sameReceiptAfterRestart,
          sensitivity: summary.sensitivity.verifierDetectedMutant,
          skips: summary.skips,
        },
        null,
        2,
      ),
    );
  } finally {
    await currentApp.close();
  }
}

async function verifyWorkflow({
  app,
  configFixture,
  bootstrapEvents,
  streamStore,
}) {
  const createPath = `/api/workspaces/${WORKSPACE_A}/agents`;
  const agentPath = (agentId) => `${createPath}/${agentId}`;
  const configPath = (agentId, suffix = "config") =>
    `${agentPath(agentId)}/${suffix}`;
  const createBody = {
    agentId: AGENT_A,
    ownerPrincipalId: ADA,
    profile: {
      displayName: "Verifier Agent",
      email: "verifier@example.test",
      handle: "verifier-agent",
    },
  };
  const secondCreateBody = {
    agentId: AGENT_B,
    ownerPrincipalId: ADA,
    profile: {
      displayName: "Second Verifier Agent",
      email: "second-verifier@example.test",
      handle: "second-verifier-agent",
    },
  };
  const thirdCreateBody = {
    agentId: AGENT_C,
    ownerPrincipalId: ADA,
    profile: {
      displayName: "Third Verifier Agent",
      email: "third-verifier@example.test",
      handle: "third-verifier-agent",
    },
  };

  const missingKey = await request(app, createPath, {
    body: createBody,
    method: "POST",
  });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.payload.code, "AGENT_MANAGEMENT_INVALID_REQUEST");

  const unauthenticated = await request(app, createPath, {
    headers: { "x-test-unauthenticated": "1" },
  });
  assert.equal(unauthenticated.status, 401);

  const memberMutation = await request(app, createPath, {
    body: createBody,
    headers: { "x-test-principal": OTHER_PRINCIPAL },
    idempotencyKey: key("r"),
    method: "POST",
  });
  assert.equal(memberMutation.status, 404);

  const wrongWorkspace = await request(
    app,
    `/api/workspaces/${WORKSPACE_B}/agents/${AGENT_A}`,
  );
  assert.equal(wrongWorkspace.status, 404);

  const droppedCreate = await request(app, createPath, {
    body: createBody,
    dropResponse: true,
    idempotencyKey: KEYS.createA,
    method: "POST",
  });
  assert.equal(droppedCreate.dropped, true);
  const createRetry = await runCli([
    "create",
    "--workspace",
    WORKSPACE_A,
    "--idempotency-key",
    KEYS.createA,
    "--input-json",
    JSON.stringify(createBody),
  ]);
  assert.equal(createRetry.status, 0);
  const createReplay = await request(app, createPath, {
    body: createBody,
    idempotencyKey: KEYS.createA,
    method: "POST",
  });
  assert.equal(createReplay.status, 201);
  assert.deepEqual(
    createReplay.payload.receipt,
    createRetry.payload.receipt,
    "API and CLI must expose the same durable create receipt",
  );

  const conflictingCreate = await request(app, createPath, {
    body: {
      ...createBody,
      profile: { ...createBody.profile, displayName: "Changed Name" },
    },
    idempotencyKey: KEYS.createA,
    method: "POST",
  });
  assert.equal(conflictingCreate.status, 409);
  assert.equal(conflictingCreate.payload.code, "DISPATCH_IDEMPOTENCY_CONFLICT");

  const createSecond = await runCli([
    "create",
    "--workspace",
    WORKSPACE_A,
    "--idempotency-key",
    KEYS.createB,
    "--input-json",
    JSON.stringify(secondCreateBody),
  ]);
  assert.equal(createSecond.status, 0);
  assert.equal(createSecond.payload.agent.agentId, AGENT_B);
  assert.equal(createSecond.payload.agent.principalId, PRINCIPAL_AGENT_B);

  const firstList = await request(app, `${createPath}?limit=1`);
  assert.equal(firstList.status, 200);
  assert.deepEqual(
    firstList.payload.agents.map(({ principalId }) => principalId),
    [PRINCIPAL_AGENT_A],
  );
  assert.ok(firstList.payload.nextCursor);

  const createThird = await runCli([
    "create",
    "--workspace",
    WORKSPACE_A,
    "--idempotency-key",
    KEYS.createC,
    "--input-json",
    JSON.stringify(thirdCreateBody),
  ]);
  assert.equal(createThird.status, 0);
  assert.equal(createThird.payload.agent.agentId, AGENT_C);
  assert.equal(createThird.payload.agent.principalId, PRINCIPAL_AGENT_C);

  const secondList = await request(
    app,
    `${createPath}?limit=1&cursor=${firstList.payload.nextCursor}`,
  );
  assert.equal(secondList.status, 200);
  assert.deepEqual(
    secondList.payload.agents.map(({ principalId }) => principalId),
    [PRINCIPAL_AGENT_B],
  );
  const cliSecondList = await runCli([
    "list",
    "--workspace",
    WORKSPACE_A,
    "--limit",
    "1",
    "--cursor",
    firstList.payload.nextCursor,
  ]);
  assert.equal(cliSecondList.status, 0);
  assert.deepEqual(cliSecondList.payload, secondList.payload);
  const thirdList = await request(
    app,
    `${createPath}?limit=1&cursor=${secondList.payload.nextCursor}`,
  );
  assert.equal(thirdList.status, 200);
  assert.deepEqual(
    thirdList.payload.agents.map(({ principalId }) => principalId),
    [PRINCIPAL_AGENT_C],
  );

  const invalidListCursor = await request(
    app,
    `${createPath}?cursor=not-a-valid-cursor`,
  );
  assert.equal(invalidListCursor.status, 400);
  assert.equal(
    invalidListCursor.payload.code,
    "AGENT_MANAGEMENT_INVALID_CURSOR",
  );

  const getAgent = await request(app, agentPath(AGENT_A));
  assert.equal(getAgent.status, 200);
  assert.equal(getAgent.payload.agent.agentId, AGENT_A);
  assert.equal(getAgent.payload.agent.principalId, PRINCIPAL_AGENT_A);
  assert.equal(Object.hasOwn(getAgent.payload.agent, "subjectBinding"), false);

  const config = structuredClone(configFixture);
  const revisedConfig = structuredClone(config);
  revisedConfig.budgets.maxOutputTokens += 1;

  const droppedConfigCreate = await request(app, configPath(AGENT_A), {
    body: { config, expectedRevision: 0, expectedRevisionId: null },
    dropResponse: true,
    idempotencyKey: KEYS.configCreate,
    method: "POST",
  });
  assert.equal(droppedConfigCreate.dropped, true);
  const configCreateRetry = await runCli([
    "config-create",
    "--workspace",
    WORKSPACE_A,
    "--agent",
    AGENT_A,
    "--idempotency-key",
    KEYS.configCreate,
    "--input-json",
    JSON.stringify({ config, expectedRevision: 0, expectedRevisionId: null }),
  ]);
  assert.equal(configCreateRetry.status, 0);
  const configCreateReplay = await request(app, configPath(AGENT_A), {
    body: { config, expectedRevision: 0, expectedRevisionId: null },
    idempotencyKey: KEYS.configCreate,
    method: "POST",
  });
  assert.equal(configCreateReplay.status, 201);
  assert.deepEqual(
    configCreateReplay.payload.receipt,
    configCreateRetry.payload.receipt,
    "API and CLI must expose the same durable config-create receipt",
  );
  const crossAgentConfig = await request(app, configPath(AGENT_B), {
    body: { config, expectedRevision: 0, expectedRevisionId: null },
    idempotencyKey: KEYS.configCreate,
    method: "POST",
  });
  assert.equal(crossAgentConfig.status, 409);
  assert.equal(crossAgentConfig.payload.code, "DISPATCH_IDEMPOTENCY_CONFLICT");
  const revisionOneId = configCreateRetry.payload.configRevision.revisionId;
  assert.match(revisionOneId, /^acr_[0-9a-f]{64}$/u);

  const activateOneBody = {
    expectedRevision: 1,
    expectedRevisionId: revisionOneId,
    revisionId: revisionOneId,
  };
  const activateOne = await request(app, configPath(AGENT_A, "activate"), {
    body: activateOneBody,
    idempotencyKey: KEYS.activateOne,
    method: "POST",
  });
  assert.equal(activateOne.status, 200);
  assert.equal(activateOne.payload.configuration.status, "active");

  const reviseBody = {
    config: revisedConfig,
    expectedRevision: 1,
    expectedRevisionId: revisionOneId,
  };
  const droppedRevise = await request(app, configPath(AGENT_A, "revisions"), {
    body: reviseBody,
    dropResponse: true,
    idempotencyKey: KEYS.revise,
    method: "POST",
  });
  assert.equal(droppedRevise.dropped, true);
  const reviseRetry = await runCli([
    "revise",
    "--workspace",
    WORKSPACE_A,
    "--agent",
    AGENT_A,
    "--idempotency-key",
    KEYS.revise,
    "--input-json",
    JSON.stringify(reviseBody),
  ]);
  assert.equal(reviseRetry.status, 0);
  const reviseReplay = await request(app, configPath(AGENT_A, "revisions"), {
    body: reviseBody,
    idempotencyKey: KEYS.revise,
    method: "POST",
  });
  assert.equal(reviseReplay.status, 201);
  assert.deepEqual(
    reviseReplay.payload.receipt,
    reviseRetry.payload.receipt,
    "API and CLI must expose the same durable revise receipt",
  );
  const revisionTwoId = reviseRetry.payload.configRevision.revisionId;
  assert.notEqual(revisionOneId, revisionTwoId);

  const staleRevision = await request(app, configPath(AGENT_A, "revisions"), {
    body: reviseBody,
    idempotencyKey: KEYS.staleRevision,
    method: "POST",
  });
  assert.equal(staleRevision.status, 409);
  assert.equal(
    staleRevision.payload.code,
    "AGENT_CONFIG_STREAM_STALE_REVISION",
  );

  const historyBeforeAppend = await request(
    app,
    `${configPath(AGENT_A, "history")}?limit=2`,
  );
  assert.equal(historyBeforeAppend.status, 200);
  assert.equal(historyBeforeAppend.payload.entries.length, 2);
  assert.ok(historyBeforeAppend.payload.nextCursor);

  const disableBody = {
    expectedRevision: 2,
    expectedRevisionId: revisionTwoId,
  };
  const droppedDisable = await request(app, configPath(AGENT_A, "disable"), {
    body: disableBody,
    dropResponse: true,
    idempotencyKey: KEYS.disable,
    method: "POST",
  });
  assert.equal(droppedDisable.dropped, true);
  const disableRetry = await runCli([
    "disable",
    "--workspace",
    WORKSPACE_A,
    "--agent",
    AGENT_A,
    "--idempotency-key",
    KEYS.disable,
    "--input-json",
    JSON.stringify(disableBody),
  ]);
  assert.equal(disableRetry.status, 0);
  const disableReplay = await request(app, configPath(AGENT_A, "disable"), {
    body: disableBody,
    idempotencyKey: KEYS.disable,
    method: "POST",
  });
  assert.equal(disableReplay.status, 200);
  assert.deepEqual(
    disableReplay.payload.receipt,
    disableRetry.payload.receipt,
    "API and CLI must expose the same durable disable receipt",
  );

  const activateTwoBody = {
    expectedRevision: 2,
    expectedRevisionId: revisionTwoId,
    revisionId: revisionTwoId,
  };
  const activateTwo = await request(app, configPath(AGENT_A, "activate"), {
    body: activateTwoBody,
    idempotencyKey: KEYS.activateTwo,
    method: "POST",
  });
  assert.equal(activateTwo.status, 200);
  assert.equal(activateTwo.payload.configuration.status, "active");

  const revokeBody = {
    expectedRevision: 2,
    expectedRevisionId: revisionTwoId,
  };
  const droppedRevoke = await request(app, configPath(AGENT_A, "revoke"), {
    body: revokeBody,
    dropResponse: true,
    idempotencyKey: KEYS.revoke,
    method: "POST",
  });
  assert.equal(droppedRevoke.dropped, true);
  const revokeRetry = await runCli([
    "revoke",
    "--workspace",
    WORKSPACE_A,
    "--agent",
    AGENT_A,
    "--idempotency-key",
    KEYS.revoke,
    "--input-json",
    JSON.stringify(revokeBody),
  ]);
  assert.equal(revokeRetry.status, 0);
  const revokeReplay = await request(app, configPath(AGENT_A, "revoke"), {
    body: revokeBody,
    idempotencyKey: KEYS.revoke,
    method: "POST",
  });
  assert.equal(revokeReplay.status, 200);
  assert.deepEqual(
    revokeReplay.payload.receipt,
    revokeRetry.payload.receipt,
    "API and CLI must expose the same durable revoke receipt",
  );
  assert.equal(revokeRetry.payload.revoked, true);

  const historyEntries = [...historyBeforeAppend.payload.entries];
  let cursor = historyBeforeAppend.payload.nextCursor;
  const historyPages = [historyBeforeAppend.payload];
  while (cursor) {
    const page = await request(
      app,
      `${configPath(AGENT_A, "history")}?limit=2&cursor=${cursor}`,
    );
    assert.equal(page.status, 200);
    historyPages.push(page.payload);
    historyEntries.push(...page.payload.entries);
    cursor = page.payload.nextCursor;
  }
  const historyEventIds = historyEntries.map(({ eventId }) => eventId);
  assert.equal(new Set(historyEventIds).size, historyEventIds.length);
  assert.equal(historyEntries.length, 6);
  assert.deepEqual(
    historyEntries.map(({ kind }) => kind),
    [
      "revision",
      "lifecycle",
      "revision",
      "lifecycle",
      "lifecycle",
      "lifecycle",
    ],
  );
  const invalidHistoryCursor = await request(
    app,
    `${configPath(AGENT_A, "history")}?cursor=${encodeURIComponent(
      JSON.stringify({ index: 0, kind: "agents", version: 1 }),
    )}`,
  );
  assert.equal(invalidHistoryCursor.status, 400);
  assert.equal(
    invalidHistoryCursor.payload.code,
    "AGENT_MANAGEMENT_INVALID_CURSOR",
  );

  const badConfig = structuredClone(config);
  badConfig.instructions.system = CANARY;
  const canaryHttp = await request(app, configPath(AGENT_C), {
    body: {
      config: badConfig,
      expectedRevision: 0,
      expectedRevisionId: null,
    },
    idempotencyKey: KEYS.canary,
    method: "POST",
  });
  assert.equal(canaryHttp.status, 400);
  assert.doesNotMatch(
    JSON.stringify(canaryHttp.payload),
    new RegExp(CANARY, "u"),
  );
  const canaryCli = await runCli([
    "config-create",
    "--workspace",
    WORKSPACE_A,
    "--agent",
    AGENT_C,
    "--idempotency-key",
    KEYS.canary,
    "--input-json",
    JSON.stringify({
      config: badConfig,
      expectedRevision: 0,
      expectedRevisionId: null,
    }),
  ]);
  assert.equal(canaryCli.status, 2);
  assert.doesNotMatch(canaryCli.stdout, new RegExp(CANARY, "u"));
  assert.doesNotMatch(canaryCli.stderr, new RegExp(CANARY, "u"));

  const providerErrorApp = await createApp({
    bootstrapEvents,
    dispatchDoor: {
      async dispatch() {
        const error = new Error("provider double failed");
        error.code = "PROVIDER_DOUBLE_FAILURE";
        error.detail = CANARY;
        error.statusCode = 502;
        throw error;
      },
      async recover() {
        return null;
      },
      close() {},
    },
    streamStore,
  });
  const appBeforeProviderCanary = currentApp;
  currentApp = providerErrorApp;
  const providerCanaryBody = {
    ...createBody,
    agentId: AGENT_PROVIDER,
  };
  const providerCanaryHttp = await request(providerErrorApp, createPath, {
    body: providerCanaryBody,
    idempotencyKey: KEYS.providerCanary,
    method: "POST",
  });
  assert.equal(providerCanaryHttp.status, 502);
  assert.equal(providerCanaryHttp.payload.error, "[REDACTED]");
  const providerCanaryCli = await runCli([
    "create",
    "--workspace",
    WORKSPACE_A,
    "--idempotency-key",
    KEYS.providerCanary,
    "--input-json",
    JSON.stringify(providerCanaryBody),
  ]);
  assert.equal(providerCanaryCli.status, 5);
  assert.doesNotMatch(providerCanaryCli.stdout, new RegExp(CANARY, "u"));
  assert.doesNotMatch(providerCanaryCli.stderr, new RegExp(CANARY, "u"));
  currentApp = appBeforeProviderCanary;
  await providerErrorApp.close();

  const finalList = await request(app, `${createPath}?limit=100`);
  assert.equal(finalList.status, 200);
  assert.deepEqual(
    finalList.payload.agents.map(({ principalId }) => principalId),
    [PRINCIPAL_AGENT_A, PRINCIPAL_AGENT_B, PRINCIPAL_AGENT_C],
  );

  const finalGet = await request(app, agentPath(AGENT_A));
  assert.equal(finalGet.payload.configuration.status, "retired");
  assert.equal(finalGet.payload.configuration.runnable, false);

  const beforeRestart = await readReplayState({
    agentId: AGENT_A,
    streamStore,
    workspaceDirectory: app.workspaceDirectory,
  });
  const retryBeforeRestart = await runCli([
    "revoke",
    "--workspace",
    WORKSPACE_A,
    "--agent",
    AGENT_A,
    "--idempotency-key",
    KEYS.revoke,
    "--input-json",
    JSON.stringify(revokeBody),
  ]);
  assert.equal(retryBeforeRestart.status, 0);
  assert.deepEqual(
    retryBeforeRestart.payload.receipt,
    revokeRetry.payload.receipt,
  );

  const source = await readFile(
    path.join(root, "src/ledger/agent-management.mjs"),
    "utf8",
  );
  const sourceGuard =
    source.includes("dispatch: dispatchDoor.dispatch") &&
    !source.includes("dispatch: streamStore.append");
  assert.equal(sourceGuard, true);
  const sensitivityRun = await runSensitivityMutant({ source });
  const observedNonZeroExit =
    Number.isInteger(sensitivityRun.status) && sensitivityRun.status !== 0;
  const verifierDetectedMutant =
    observedNonZeroExit || sensitivityRun.signal !== null;
  assert.equal(verifierDetectedMutant, true);

  const firstDirectoryTargetCount = countDispatchTargets(
    streamStore.dump(app.workspaceDirectory.stream),
  );
  const configStream = createAgentConfigStream({
    agentId: AGENT_A,
    streamStore,
    workspaceId: WORKSPACE_A,
  });
  const configTargetCount = countDispatchTargets(
    streamStore.dump(configStream.stream),
  );
  const dispatchIndexCount = streamStore.dump(
    "__stream_slack_dispatch_idempotency__",
  ).length;
  assert.equal(
    streamStore.dump(app.workspaceDirectory.stream).length,
    bootstrapEvents.length + 3,
  );
  assert.equal(firstDirectoryTargetCount, 3);
  assert.equal(configTargetCount, 6);
  assert.equal(dispatchIndexCount, 9);

  const redactionSource = JSON.stringify({ httpTranscript, cliTranscript });
  assert.doesNotMatch(redactionSource, new RegExp(CANARY, "u"));
  assert.doesNotMatch(redactionSource, /canary-token-123456789/u);

  const retries = {
    attemptedMutations: [
      "agent create",
      "config create",
      "config revise",
      "config disable",
      "config revoke",
    ],
    duplicateDirectoryEvents: firstDirectoryTargetCount - 3,
    duplicateConfigEvents: configTargetCount - 6,
    everyMutationReturnedOriginalReceipt: true,
    lostAcknowledgements: 5,
    noDuplicateLogicalEffects: true,
    result: "PASS",
  };
  const pagination = {
    agentPages: 2,
    appendedAgentAfterFirstPage: true,
    historyPages: historyPages.length,
    historyRows: historyEntries.length,
    noDuplicateHistoryEventIds: true,
    noDuplicateListRows: true,
    invalidCursorCases: 2,
    result: "PASS",
  };
  const redaction = {
    canaryAbsentEverywhere: true,
    canaryRejectedByProtocol: canaryHttp.payload.code,
    httpBodiesRedacted: true,
    providerErrorRedacted: providerCanaryHttp.payload.error === "[REDACTED]",
    evidenceTranscriptsRedacted: true,
    cliOutputRedacted: true,
    providerCliOutputRedacted: providerCanaryCli.payload.error === "[REDACTED]",
    subjectBindingOmittedFromPublicAgent: true,
    result: "PASS",
  };
  const sensitivity = {
    mutation:
      "replace agent-management dispatch door with direct stream append",
    verifierDetectedMutant,
    directTargetAppendAbsent: sourceGuard,
    experiment: {
      command: "E2_T03_SKIP_GATES=1 node scripts/verify-e2-t03.mjs",
      isolatedMutantModule: true,
      exitCode: sensitivityRun.status,
      signal: sensitivityRun.signal,
      observedNonZeroExit,
    },
    result: "PASS",
  };

  // Close and reconstruct the API, directory, authorization, and dispatch door
  // after all source facts are durable. The caller replaces app before this
  // function returns so the replay check uses the restarted process surface.
  const oldApp = app;
  await oldApp.close();
  app = await createApp({ bootstrapEvents, streamStore });
  currentApp = app;
  const restartRetry = await runCli([
    "revoke",
    "--workspace",
    WORKSPACE_A,
    "--agent",
    AGENT_A,
    "--idempotency-key",
    KEYS.revoke,
    "--input-json",
    JSON.stringify(revokeBody),
  ]);
  assert.equal(restartRetry.status, 0);
  assert.deepEqual(restartRetry.payload.receipt, revokeRetry.payload.receipt);
  const afterRestart = await readReplayState({
    agentId: AGENT_A,
    streamStore,
    workspaceDirectory: app.workspaceDirectory,
  });
  assert.equal(
    afterRestart.directoryStateDigest,
    beforeRestart.directoryStateDigest,
  );
  assert.equal(afterRestart.configStateDigest, beforeRestart.configStateDigest);
  assert.deepEqual(afterRestart.historyEventIds, beforeRestart.historyEventIds);

  const restart = {
    sameReceiptAfterRestart: true,
    directoryStateDigest: afterRestart.directoryStateDigest,
    configStateDigest: afterRestart.configStateDigest,
    historyEventCount: afterRestart.historyEventIds.length,
    processStateRebuilt: true,
    result: "PASS",
  };
  const finalReplay = {
    directoryDigest: afterRestart.directoryDigest,
    directoryStateDigest: afterRestart.directoryStateDigest,
    configDigest: afterRestart.configDigest,
    configStateDigest: afterRestart.configStateDigest,
    configEventCount: afterRestart.configEventCount,
    directoryTargetEventCount: firstDirectoryTargetCount,
    dispatchIndexCount,
    historyEventIds: afterRestart.historyEventIds,
    finalStatus: afterRestart.status,
    replayedAfterRestart: true,
  };
  assert.equal(finalReplay.finalStatus, "retired");

  const gates = [];
  if (process.env.E2_T03_SKIP_GATES !== "1") {
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

  return {
    schemaVersion: 1,
    task: "E2-T03",
    runId: process.env.TEST_RUN_ID ?? null,
    implementationCommit,
    result: "PASS",
    replay:
      "Replay: N/A (server/CLI administration surface) + mitigation: real-HTTP/CLI transcripts, idempotent retry matrix, canary scan, and state replay",
    skips:
      process.env.E2_T03_SKIP_GATES === "1"
        ? ["format", "lint", "typecheck", "test", "build"]
        : [],
    gates,
    pagination,
    retries,
    redaction,
    restart,
    sensitivity,
    finalReplay,
  };
}

async function runSensitivityMutant({ source }) {
  const sensitivityRoot = await mkdtemp(
    path.join(taskDirectory, "work/sensitivity-"),
  );
  const mutantLedgerDirectory = path.join(sensitivityRoot, "src/ledger");
  try {
    await mkdir(mutantLedgerDirectory, { recursive: true });
    for (const filename of [
      "agent-config-stream.mjs",
      "append-boundary.mjs",
      "canonical-json.mjs",
      "envelope.mjs",
      "errors.mjs",
      "identifiers.mjs",
      "topology.mjs",
    ]) {
      await copyFile(
        path.join(root, "src/ledger", filename),
        path.join(mutantLedgerDirectory, filename),
      );
    }
    const mutantSource = source.replace(
      "dispatch: dispatchDoor.dispatch",
      "dispatch: streamStore.append",
    );
    assert.notEqual(
      mutantSource,
      source,
      "the sensitivity mutant must replace the dispatch door",
    );
    const mutantModule = path.join(
      mutantLedgerDirectory,
      "agent-management.mjs",
    );
    await writeFile(mutantModule, mutantSource);
    const childArtifactDirectory = path.join(sensitivityRoot, "artifacts");
    const child = spawn(process.execPath, ["scripts/verify-e2-t03.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        E2_T03_AGENT_MANAGEMENT_MODULE: mutantModule,
        E2_T03_COLD_CLONE: "0",
        E2_T03_SKIP_GATES: "1",
        PROMOTE_EVIDENCE: "0",
        TEST_ARTIFACT_DIR: childArtifactDirectory,
        TEST_RUN_ID: `${process.env.TEST_RUN_ID ?? "verify"}-sensitivity-mutant`,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ signal: "SIGKILL", status: null });
      }, 60_000);
      child.once("error", () => {
        clearTimeout(timer);
        resolve({ signal: null, status: null });
      });
      child.once("close", (status, signal) => {
        clearTimeout(timer);
        resolve({ signal, status });
      });
    });
    assert.doesNotMatch(stdout, new RegExp(CANARY, "u"));
    assert.doesNotMatch(stderr, new RegExp(CANARY, "u"));
    return result;
  } finally {
    await rm(sensitivityRoot, { recursive: true, force: true });
  }
}

async function createApp({
  bootstrapEvents,
  dispatchDoor: injectedDispatchDoor = null,
  streamStore,
}) {
  const workspaceDirectory = createWorkspaceDirectoryAuthority({
    bootstrapEvents,
    streamStore,
    workspaceId: WORKSPACE_A,
  });
  const authorizationCore = createWorkspaceAuthorization({
    lookupMembership: workspaceDirectory.lookupMembership,
    withWorkspaceFence: createWorkspaceFence(),
  });
  const workspaceAuthorization = Object.freeze({
    async contextForRequest({ request, url, user }) {
      const context = establishWorkspaceContext({
        authenticatedPrincipalId: user?.sub,
        clientHost: request.headers.host,
        trustedHost: request.headers.host,
        trustedWorkspaceId: WORKSPACE_A,
      });
      bindWorkspaceRequest(
        {
          headers: request.headers,
          path: request.url ?? url.pathname,
          query: Object.fromEntries(url.searchParams.entries()),
        },
        context.workspaceId,
      );
      return context;
    },
    authorizeDispatch: authorizationCore.authorizeDispatch,
    authorizeRead: authorizationCore.authorizeRead,
  });
  const dispatchDoor =
    injectedDispatchDoor ??
    createDispatchDoor({
      authorize: () => true,
      producerId: `verify-e2-t03-${Date.now()}-${Math.random()}`,
      streamStore,
    });
  const api = createAgentManagementApi({
    dispatchDoor,
    sessionUser: (request) => {
      if (request.headers["x-test-unauthenticated"]) return null;
      return { sub: request.headers["x-test-principal"] ?? ADA };
    },
    streamStore,
    workspaceAuthorization,
    workspaceDirectory,
    workspaceId: WORKSPACE_A,
  });
  const dropResponseKeys = new Set();
  const server = createServer(async (request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "127.0.0.1"}`,
    );
    const idempotencyKey = request.headers["idempotency-key"];
    if (idempotencyKey && dropResponseKeys.delete(idempotencyKey)) {
      response.end = () => {
        response.destroy();
        return response;
      };
    }
    try {
      if (await api.handleApi(request, response, url)) return;
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: false, code: "NOT_FOUND" }));
      }
    } catch {
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: false, code: "INTERNAL" }));
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    api,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      dispatchDoor.close?.();
      await new Promise((resolve) => {
        server.close(resolve);
      });
    },
    dispatchDoor,
    dropResponseKeys,
    server,
    workspaceDirectory,
  };
}

async function request(
  app,
  pathname,
  {
    body = null,
    dropResponse = false,
    headers = {},
    idempotencyKey = null,
    method = "GET",
  } = {},
) {
  if (dropResponse && idempotencyKey) {
    app.dropResponseKeys.add(idempotencyKey);
  }
  const requestHeaders = { Accept: "application/json", ...headers };
  if (body !== null) requestHeaders["Content-Type"] = "application/json";
  if (idempotencyKey) requestHeaders["Idempotency-Key"] = idempotencyKey;
  try {
    const response = await fetch(new URL(pathname, app.baseUrl), {
      body: body === null ? undefined : JSON.stringify(body),
      headers: requestHeaders,
      method,
    });
    const text = await response.text();
    assert.doesNotMatch(text, new RegExp(CANARY, "u"));
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`HTTP response was not JSON for ${method} ${pathname}`);
    }
    httpTranscript.push({
      method,
      path: pathname,
      requestBody: body === null ? false : "redacted-json",
      status: response.status,
      response: payload,
    });
    return { payload, status: response.status };
  } catch (error) {
    if (dropResponse) {
      httpTranscript.push({
        droppedResponse: true,
        method,
        path: pathname,
        requestBody: body === null ? false : "redacted-json",
      });
      return { dropped: true };
    }
    throw error;
  }
}

async function runCli(args) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: root,
    env: {
      ...process.env,
      STREAM_SLACK_COOKIE: "",
      STREAM_SLACK_URL: currentApp.baseUrl,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ signal: "SIGKILL", status: null });
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ error, signal: null, status: null });
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ signal, status });
    });
  });
  assert.doesNotMatch(stdout, new RegExp(CANARY, "u"));
  assert.doesNotMatch(stderr, new RegExp(CANARY, "u"));
  let payload = null;
  if (stdout.trim()) payload = JSON.parse(stdout.trim());
  cliTranscript.push({
    args: redactArgs(args),
    exitCode: result.status,
    signal: result.signal,
    stderr: redactText(stderr),
    stdout: payload,
  });
  return { payload, status: result.status, stderr, stdout };
}

function redactArgs(args) {
  return args.map((value, index) =>
    args[index - 1] === "--input-json" ? "[JSON]" : redactText(value),
  );
}

function redactText(value) {
  return String(value)
    .replace(
      /(?:bearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}|-----BEGIN [^-]*PRIVATE KEY-----)/giu,
      "[REDACTED]",
    )
    .slice(0, 2_000);
}

async function readReplayState({ agentId, streamStore, workspaceDirectory }) {
  const directory = await workspaceDirectory.read();
  const config = createAgentConfigStream({
    agentId,
    streamStore,
    workspaceId: WORKSPACE_A,
  });
  const snapshot = await config.read();
  const state = snapshot.state.entities.agents[agentId];
  assert.ok(state);
  const replay = replayAgentConfigStream(snapshot.records);
  assert.equal(replay.finalStateDigest, snapshot.stateDigest);
  return {
    directoryDigest: directory.streamDigest,
    directoryStateDigest: directory.stateDigest,
    configDigest: snapshot.streamDigest,
    configStateDigest: snapshot.stateDigest,
    configEventCount: snapshot.records.length,
    historyEventIds: [
      ...state.revisions.map(({ eventId }) => eventId),
      ...state.transitions.map(({ eventId }) => eventId),
    ],
    status: state.status,
  };
}

function countDispatchTargets(entries) {
  return entries.filter((entry) => entry.record?.dispatch).length;
}

function createMemoryStore() {
  const streams = new Map();
  return {
    async append(stream, record, { streamSeq } = {}) {
      const entries = streams.get(stream) ?? [];
      const expected = offsetFor(entries.length);
      if (streamSeq !== expected) {
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
    async ensure(stream) {
      if (!streams.has(stream)) streams.set(stream, []);
    },
    async read(stream) {
      const entries = streams.get(stream) ?? [];
      const records = entries.map(({ record }) => structuredClone(record));
      return {
        nextOffset: offsetFor(entries.length),
        records,
        streamDigest: canonicalSha256(records),
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
  const text = `${JSON.stringify(value, null, 2)}\n`;
  assert.doesNotMatch(text, new RegExp(CANARY, "u"));
  assert.doesNotMatch(text, /canary-token-123456789/u);
  await writeFile(path.join(evidenceDirectory, filename), text);
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
  return { command: [command, ...args].join(" "), exitCode: 0, name };
}
