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

import {
  AGENT_ADMINISTRATION_ACTOR_CLASSES,
  AGENT_ADMINISTRATION_CAPABILITIES,
  AGENT_ADMINISTRATION_MATRIX,
  administrationGrantDirectoryUpdate,
  createAdministrationGrant,
  membershipIdFor,
  revokeAdministrationGrant,
} from "@stream-slack/protocol";

import { createAgentManagementApi } from "../src/ledger/agent-management.mjs";
import { createAgentAdministrationAuthorization } from "../src/ledger/agent-administration-auth.mjs";
import { canonicalSha256 } from "../src/ledger/canonical-json.mjs";
import {
  createDispatchDoor,
  DEFAULT_IDEMPOTENCY_STREAM,
} from "../src/ledger/dispatch.mjs";
import {
  digestEventEnvelope,
  issueEventEnvelope,
} from "../src/ledger/envelope.mjs";
import {
  bindWorkspaceRequest,
  createWorkspaceAuthorization,
  createWorkspaceFence,
  establishWorkspaceContext,
} from "../src/ledger/workspace-auth.mjs";
import { createWorkspaceDirectoryAuthority } from "../src/ledger/workspace-directory.mjs";
import { replayAgentConfigStream } from "../src/ledger/agent-config-stream.mjs";
import { streamNames } from "../src/ledger/topology.mjs";

const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-2-the-roster/E2-T04-agent-administration-authz",
);
const artifactRoot = path.resolve(
  root,
  process.env.TEST_ARTIFACT_DIR ??
    path.join(
      ".artifacts",
      "e2-t04",
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
    ? path.join(taskDirectory, "evidence/e2-t04-final")
    : artifactRoot;
const implementationCommit = String(
  process.env.E2_T04_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();

const WORKSPACE_A = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const WORKSPACE_B = "ws_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADA = principal(WORKSPACE_A, "b");
const LINUS = principal(WORKSPACE_A, "c");
const ORDINARY_MEMBER = principal(WORKSPACE_A, "d");
const ORDINARY_VIEWER = principal(WORKSPACE_A, "q");
const AGENT_MANAGER = principal(WORKSPACE_A, "e");
const CONNECTION_MANAGER = principal(WORKSPACE_A, "f");
const CHANNEL_MANAGER = principal(WORKSPACE_A, "g");
const CROSS_WORKSPACE_ADMIN = principal(WORKSPACE_B, "c");
const AGENT_A = agent(WORKSPACE_A, "h");
const AGENT_B = agent(WORKSPACE_A, "j");
const CROSS_WORKSPACE_AGENT = agent(WORKSPACE_B, "d");
const CHANNEL_A = `ch_${WORKSPACE_A.slice(3)}_${"m".repeat(26)}`;
const CHANNEL_B = `ch_${WORKSPACE_B.slice(3)}_${"m".repeat(26)}`;
const CONNECTION_A = `cn_${WORKSPACE_A.slice(3)}_${"n".repeat(26)}`;
const CONNECTION_B = `cn_${WORKSPACE_B.slice(3)}_${"n".repeat(26)}`;
const AGENT_PRINCIPAL_A = `pr_${AGENT_A.slice(3)}`;
const CANARY = "Bearer e2-t04-canary-123456789";
const CONFIG_FIXTURE = path.join(
  root,
  ".eforest/tasks/epic-2-the-roster/E2-T01-versioned-agent-config-schema/fixtures/valid/agent-config.v1.json",
);
const MATRIX_OPERATIONS = Object.freeze([...AGENT_ADMINISTRATION_CAPABILITIES]);
const API_NEGATIVE_OPERATIONS = Object.freeze([
  "agent.create",
  "agent.history.read",
  "agent.config.create",
  "agent.config.revise",
  "agent.lifecycle.activate",
  "agent.lifecycle.disable",
  "agent.lifecycle.revoke",
]);
const HTTP_TRANSCRIPT = [];
let currentApp = null;
let eventSequence = 0;
let negativeKeyCounter = 0;

await main();

async function main() {
  await mkdir(evidenceDirectory, { recursive: true });
  if (process.env.E2_T04_SENSITIVITY_MUTANT === "1") {
    await runSensitivityProbe();
    return;
  }

  const bootstrapEvents = await buildBootstrapEvents();
  const streamStore = createMemoryStore();
  const app = await createApp({ bootstrapEvents, streamStore });
  currentApp = app;
  try {
    const summary = await verifyWorkflow({
      app,
      bootstrapEvents,
      streamStore,
    });
    await writeJson("verification-summary.json", summary);
    await writeJson("matrix.json", summary.matrix);
    await writeJson("http-transcript.json", HTTP_TRANSCRIPT);
    await writeJson("source-heads.json", summary.sourceHeads);
    await writeJson("revocation-races.json", summary.revocationRaces);
    await writeJson("sensitivity.json", summary.sensitivity);
    console.log(
      JSON.stringify(
        {
          result: summary.result,
          task: summary.task,
          implementationCommit,
          matrixRows: summary.matrix.rows.length,
          refusedRows: summary.matrix.refusedRows,
          replay: summary.replay,
          revocationRaces: summary.revocationRaces.everyRaceRefused,
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

async function verifyWorkflow({ app, bootstrapEvents, streamStore }) {
  const createPath = `/api/workspaces/${WORKSPACE_A}/agents`;
  const agentPath = (agentId) => `${createPath}/${agentId}`;
  const configPath = (agentId, suffix = "config") =>
    `${agentPath(agentId)}/${suffix}`;
  const config = JSON.parse(await readFile(CONFIG_FIXTURE, "utf8"));
  const createBody = {
    agentId: AGENT_A,
    ownerPrincipalId: ORDINARY_MEMBER,
    profile: {
      displayName: "Authorization Matrix Agent",
      email: "matrix-agent@example.test",
      handle: "authorization-matrix-agent",
    },
  };

  const createResponse = await request(app, createPath, {
    body: createBody,
    headers: { "x-test-principal": AGENT_MANAGER },
    idempotencyKey: key("a"),
    method: "POST",
  });
  assert.equal(createResponse.status, 201);

  const configCreateResponse = await request(app, configPath(AGENT_A), {
    body: {
      config,
      expectedRevision: 0,
      expectedRevisionId: null,
    },
    headers: { "x-test-principal": AGENT_MANAGER },
    idempotencyKey: key("b"),
    method: "POST",
  });
  assert.equal(configCreateResponse.status, 201);
  const firstRevisionId =
    configCreateResponse.payload.configRevision.revisionId;

  const ordinaryProfile = await request(app, agentPath(AGENT_A), {
    headers: { "x-test-principal": ORDINARY_MEMBER },
  });
  assert.equal(ordinaryProfile.status, 200);
  assert.equal(ordinaryProfile.payload.configuration, null);
  assert.equal(
    ordinaryProfile.payload.agent.profile.handle,
    "authorization-matrix-agent",
  );

  const managerProfile = await request(app, agentPath(AGENT_A), {
    headers: { "x-test-principal": AGENT_MANAGER },
  });
  assert.equal(managerProfile.status, 200);
  assert.equal(managerProfile.payload.configuration.headRevision, 1);

  const managerRevision = await request(app, configPath(AGENT_A, "revisions"), {
    body: {
      config: {
        ...config,
        instructions: { ...config.instructions, task: "revised" },
      },
      expectedRevision: 1,
      expectedRevisionId: firstRevisionId,
    },
    headers: { "x-test-principal": AGENT_MANAGER },
    idempotencyKey: key("c"),
    method: "POST",
  });
  assert.equal(managerRevision.status, 201);
  const currentRevisionId = managerRevision.payload.configRevision.revisionId;
  const currentRevision = managerRevision.payload.configRevision.revision;

  const contexts = new Map(
    [
      ["workspace-admin", ADA],
      ["workspace-admin", LINUS],
      ["ordinary-member", ORDINARY_VIEWER],
      ["agent-owner", ORDINARY_MEMBER],
      ["agent-manager", AGENT_MANAGER],
      ["connection-manager", CONNECTION_MANAGER],
      ["channel-manager", CHANNEL_MANAGER],
      ["agent-principal", AGENT_PRINCIPAL_A],
    ].map(([label, principalId]) => [label, establishContext(principalId)]),
  );
  const matrix = await collectMatrix(app, contexts);
  const refusedRows = matrix.filter((row) => !row.allowed);
  assert.ok(refusedRows.length > 0);

  const negativeApiRows = [];
  for (const row of matrix) {
    if (!API_NEGATIVE_OPERATIONS.includes(row.operation) || row.allowed)
      continue;
    const result = await assertNegativeApiOperation({
      agentPath,
      app,
      configPath,
      operation: row.operation,
      principalId: row.actorId,
      sourceAgentId: AGENT_A,
      workspacePath: createPath,
    });
    negativeApiRows.push({ ...row, ...result });
  }
  assert.ok(negativeApiRows.length >= 20);

  const crossScope = await verifyCrossScope({
    app,
    createPath,
    agentPath,
  });
  const privacy = await verifyPrivacy({ app, agentPath });

  const roleRevocation = await verifyRoleRevocation({
    app,
    currentRevision,
    currentRevisionId,
    streamStore,
    configPath,
  });
  const grantRevocation = await verifyGrantRevocation({
    app,
    currentRevision,
    currentRevisionId,
    streamStore,
    configPath,
  });
  const ownershipRevocation = await verifyOwnershipRevocation({
    app,
    agentPath,
  });
  const sensitivity = await runSensitivity();

  const finalReplay = await readReplayState({
    app,
    agentId: AGENT_A,
    streamStore,
  });
  const sourceHeads = await sourceHeadsFor({
    app,
    agentId: AGENT_A,
    streamStore,
  });
  const gates = [];
  if (process.env.E2_T04_SKIP_GATES !== "1") {
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
    task: "E2-T04",
    runId: process.env.TEST_RUN_ID ?? null,
    implementationCommit,
    result: "PASS",
    replayDescription:
      "Replay: N/A (server authorization matrix) + mitigation: real HTTP transcripts, durable grant/membership replay, source-head invariants, privacy checks, and sensitivity mutation",
    skips:
      process.env.E2_T04_SKIP_GATES === "1"
        ? ["format", "lint", "typecheck", "test", "build"]
        : [],
    gates,
    bootstrap: {
      eventCount: bootstrapEvents.length,
      directoryStream: app.workspaceDirectory.stream,
    },
    matrix: {
      actorClasses: AGENT_ADMINISTRATION_ACTOR_CLASSES,
      capabilities: AGENT_ADMINISTRATION_CAPABILITIES,
      policy: AGENT_ADMINISTRATION_MATRIX,
      rows: [...matrix, ...negativeApiRows],
      refusedRows: refusedRows.length,
      negativeApiRows: negativeApiRows.length,
      result: "PASS",
    },
    crossScope,
    privacy,
    revocationRaces: {
      role: roleRevocation,
      grant: grantRevocation,
      ownership: ownershipRevocation,
      everyRaceRefused:
        roleRevocation.refused &&
        grantRevocation.refused &&
        ownershipRevocation.refused,
      result: "PASS",
    },
    sensitivity,
    sourceHeads,
    replay: finalReplay,
  };
}

async function collectMatrix(app, contexts) {
  const rows = [];
  for (const [actorClass, context] of contexts) {
    for (const operation of MATRIX_OPERATIONS) {
      const target = targetForOperation(operation);
      let decision;
      try {
        decision = await app.administrationAuthorization.explain({
          agentId: target.agentId,
          context,
          operations: [operation],
          resourceId: target.resourceId,
          resourceType: target.resourceType,
        });
      } catch (error) {
        decision = {
          actorClasses: [],
          allowed: false,
          allowedOperations: [],
          errorCode: error.code ?? "UNKNOWN",
        };
      }
      const expected =
        AGENT_ADMINISTRATION_MATRIX[actorClass].includes(operation);
      const effectiveAllowed = decision.allowed === true;
      if (actorClass === "workspace-admin" || actorClass === "agent-manager") {
        if (expected && operation.startsWith("agent.")) {
          assert.equal(effectiveAllowed, true, `${actorClass} ${operation}`);
        }
      }
      if (actorClass === "agent-owner" && operation === "agent.config.revise") {
        assert.equal(effectiveAllowed, false);
      }
      rows.push({
        actorClass,
        actorId: context.principalId,
        allowed: effectiveAllowed,
        allowedOperations: decision.allowedOperations ?? [],
        expected,
        operation,
        resourceId: target.resourceId,
        resourceType: target.resourceType,
        source: decision.source ?? null,
      });
    }
  }
  return rows;
}

async function assertNegativeApiOperation({
  agentPath,
  app,
  configPath,
  operation,
  principalId,
  sourceAgentId,
  workspacePath,
}) {
  const before = await sourceHeadsFor({ app, agentId: sourceAgentId });
  const readOperation = operation.endsWith(".read");
  const result = await request(
    app,
    operation === "agent.create"
      ? workspacePath
      : operation === "agent.history.read"
        ? `${agentPath(sourceAgentId)}/history`
        : configPath(sourceAgentId, mutationSuffix(operation)),
    {
      body: readOperation ? null : bodyForOperation(operation),
      headers: { "x-test-principal": principalId },
      idempotencyKey: key(`n${negativeKeyCounter++}`),
      method: readOperation ? "GET" : "POST",
    },
  );
  const after = await sourceHeadsFor({ app, agentId: sourceAgentId });
  assert.equal(result.status, 404, `${principalId} ${operation}`);
  assert.deepEqual(
    after,
    before,
    `${principalId} ${operation} changed a source head`,
  );
  return {
    after,
    before,
    apiStatus: result.status,
    sourceHeadsUnchanged: true,
  };
}

async function verifyCrossScope({ app, createPath, agentPath }) {
  const before = await sourceHeadsFor({ app, agentId: AGENT_A });
  const siblingAgent = await request(app, agentPath(CROSS_WORKSPACE_AGENT), {
    headers: { "x-test-principal": ADA },
  });
  assert.equal(siblingAgent.status, 404);
  const foreignOwner = await request(app, createPath, {
    body: {
      agentId: AGENT_B,
      ownerPrincipalId: CROSS_WORKSPACE_ADMIN,
      profile: {
        displayName: "Foreign owner",
        email: "foreign@example.test",
        handle: "foreign-owner",
      },
    },
    headers: { "x-test-principal": ADA },
    idempotencyKey: key("x"),
    method: "POST",
  });
  assert.equal(foreignOwner.status, 404);
  const after = await sourceHeadsFor({ app, agentId: AGENT_A });
  assert.deepEqual(after.config, before.config);
  assert.deepEqual(after.audit, before.audit);
  const crossChannelDecision = await app.administrationAuthorization.explain({
    context: establishContext(CHANNEL_MANAGER),
    operations: ["channel.membership.manage"],
    resourceId: CHANNEL_B,
    resourceType: "channel",
  });
  const crossConnectionDecision = await app.administrationAuthorization.explain(
    {
      context: establishContext(CONNECTION_MANAGER),
      operations: ["connection.reference.bind"],
      resourceId: CONNECTION_B,
      resourceType: "connection",
    },
  );
  assert.equal(crossChannelDecision.allowed, false);
  assert.equal(crossConnectionDecision.allowed, false);
  return {
    siblingAgentStatus: siblingAgent.status,
    foreignOwnerStatus: foreignOwner.status,
    siblingChannelAllowed: crossChannelDecision.allowed,
    siblingConnectionAllowed: crossConnectionDecision.allowed,
    sourceHeadsUnchangedForRefusals: true,
    result: "PASS",
  };
}

async function verifyPrivacy({ app, agentPath }) {
  const nonexistent = `ag_${WORKSPACE_A.slice(3)}_${"z".repeat(26)}`;
  const ownerDenied = await request(app, `${agentPath(AGENT_A)}/history`, {
    headers: { "x-test-principal": ORDINARY_MEMBER },
  });
  const missingDenied = await request(
    app,
    `${agentPath(nonexistent)}/history`,
    {
      headers: { "x-test-principal": ORDINARY_MEMBER },
    },
  );
  assert.equal(ownerDenied.status, 404);
  assert.equal(missingDenied.status, 404);
  assert.equal(ownerDenied.payload.code, missingDenied.payload.code);
  assert.equal(ownerDenied.payload.error, missingDenied.payload.error);
  return {
    deniedStatus: ownerDenied.status,
    stableCode: ownerDenied.payload.code,
    stableError: ownerDenied.payload.error,
    noExistenceOracle: true,
    result: "PASS",
  };
}

async function verifyRoleRevocation({
  app,
  configPath,
  currentRevision,
  currentRevisionId,
  streamStore,
}) {
  const context = establishContext(LINUS);
  const stale = await app.administrationAuthorization.explain({
    agentId: AGENT_A,
    context,
    operations: ["agent.config.revise"],
  });
  assert.equal(stale.allowed, true);
  const membership = await app.workspaceDirectory.lookupMembership(
    WORKSPACE_A,
    LINUS,
  );
  const directory = await app.workspaceDirectory.read();
  await appendDirectoryEvent({
    actorId: ADA,
    app,
    data: {
      expectedMembershipRevision: membership.revision,
      expectedWorkspaceRevision:
        directory.state.entities.workspaces[WORKSPACE_A].revision,
      membershipId: membershipIdFor(WORKSPACE_A, LINUS),
      role: "member",
    },
    eventType: "workspace.membership.role.changed",
    idempotencyKey: key("r"),
    operation: "workspace.membership.role.changed",
  });
  const before = await sourceHeadsFor({ app, agentId: AGENT_A, streamStore });
  const refused = await request(app, configPath(AGENT_A, "revisions"), {
    body: {
      config: { instructions: { task: "role-revocation-race" } },
      expectedRevision: currentRevision,
      expectedRevisionId: currentRevisionId,
    },
    headers: { "x-test-principal": LINUS },
    idempotencyKey: key("s"),
    method: "POST",
  });
  const after = await sourceHeadsFor({ app, agentId: AGENT_A, streamStore });
  assert.equal(refused.status, 404);
  assert.deepEqual(after.config, before.config);
  return {
    staleDecisionAllowedBeforeRevocation: stale.allowed,
    refusalStatus: refused.status,
    refused: true,
    configHeadBefore: before.config.nextOffset,
    configHeadAfter: after.config.nextOffset,
    result: "PASS",
  };
}

async function verifyGrantRevocation({
  app,
  configPath,
  currentRevision,
  currentRevisionId,
  streamStore,
}) {
  const context = establishContext(AGENT_MANAGER);
  const stale = await app.administrationAuthorization.explain({
    agentId: AGENT_A,
    context,
    operations: ["agent.config.revise"],
  });
  assert.equal(stale.allowed, true);
  const directory = await app.workspaceDirectory.read();
  const grant = directory.state.entities.directory[managerGrantId()];
  assert.ok(grant?.value);
  const revoked = revokeAdministrationGrant(grant.value);
  await appendDirectoryEvent({
    actorId: ADA,
    app,
    data: administrationGrantDirectoryUpdate(revoked),
    eventType: "workspace.directory.updated",
    idempotencyKey: key("t"),
    operation: "administration.grant.revoked",
  });
  const before = await sourceHeadsFor({ app, agentId: AGENT_A, streamStore });
  const refused = await request(app, configPath(AGENT_A, "revisions"), {
    body: {
      config: { instructions: { task: "grant-revocation-race" } },
      expectedRevision: currentRevision,
      expectedRevisionId: currentRevisionId,
    },
    headers: { "x-test-principal": AGENT_MANAGER },
    idempotencyKey: key("v"),
    method: "POST",
  });
  const after = await sourceHeadsFor({ app, agentId: AGENT_A, streamStore });
  assert.equal(refused.status, 404);
  assert.deepEqual(after.config, before.config);
  return {
    staleDecisionAllowedBeforeRevocation: stale.allowed,
    grantStatusAfter: revoked.status,
    refusalStatus: refused.status,
    refused: true,
    configHeadBefore: before.config.nextOffset,
    configHeadAfter: after.config.nextOffset,
    result: "PASS",
  };
}

async function verifyOwnershipRevocation({ app, agentPath }) {
  const context = establishContext(ORDINARY_MEMBER);
  const stale = await app.administrationAuthorization.explain({
    agentId: AGENT_A,
    context,
    operations: ["agent.profile.read"],
  });
  assert.equal(stale.allowed, true);
  const before = await sourceHeadsFor({ app, agentId: AGENT_A });
  await appendDirectoryEvent({
    actorId: ADA,
    app,
    data: { principalId: ORDINARY_MEMBER, reason: "owner revoked" },
    eventType: "principal.deactivated",
    idempotencyKey: key("w"),
    operation: "principal.deactivated",
  });
  const refused = await request(app, agentPath(AGENT_A), {
    headers: { "x-test-principal": ORDINARY_MEMBER },
  });
  const after = await sourceHeadsFor({ app, agentId: AGENT_A });
  assert.equal(refused.status, 404);
  assert.deepEqual(after.config, before.config);
  return {
    staleDecisionAllowedBeforeRevocation: stale.allowed,
    refusalStatus: refused.status,
    refused: true,
    configHeadBefore: before.config.nextOffset,
    configHeadAfter: after.config.nextOffset,
    result: "PASS",
  };
}

async function runSensitivity() {
  await mkdir(path.join(taskDirectory, "work"), { recursive: true });
  const sensitivityRoot = await mkdtemp(
    path.join(taskDirectory, "work/sensitivity-"),
  );
  const mutantModule = path.join(
    sensitivityRoot,
    "agent-administration-auth.mjs",
  );
  const mutantWorkspaceAuth = path.join(sensitivityRoot, "workspace-auth.mjs");
  try {
    const source = await readFile(
      path.join(root, "src/ledger/agent-administration-auth.mjs"),
      "utf8",
    );
    const needle =
      "if (!decision.allowedOperations.includes(operation)) throw accessDenied();";
    assert.ok(source.includes(needle));
    await writeFile(
      mutantModule,
      source.replace(needle, "if (false) throw accessDenied();"),
    );
    await copyFile(
      path.join(root, "src/ledger/workspace-auth.mjs"),
      mutantWorkspaceAuth,
    );
    const child = spawn(
      process.execPath,
      [path.join(root, "scripts/verify-e2-t04.mjs")],
      {
        cwd: root,
        env: {
          ...process.env,
          E2_T04_AUTH_MODULE: mutantModule,
          E2_T04_COLD_CLONE: "0",
          E2_T04_SENSITIVITY_MUTANT: "1",
          E2_T04_SKIP_GATES: "1",
          PROMOTE_EVIDENCE: "0",
          TEST_RUN_ID: `${process.env.TEST_RUN_ID ?? "verify"}-sensitivity-mutant`,
        },
      },
    );
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
    assert.notEqual(
      result.status,
      0,
      "mutant must make the negative probe fail",
    );
    return {
      mutation: "remove authorizeMutation capability check",
      isolatedMutantModule: true,
      observedNonZeroExit: result.status !== 0 || result.signal !== null,
      exitCode: result.status,
      signal: result.signal,
      verifierDetectedMutant: true,
      result: "PASS",
    };
  } finally {
    await rm(sensitivityRoot, { recursive: true, force: true });
  }
}

async function runSensitivityProbe() {
  const bootstrapEvents = await buildBootstrapEvents();
  const streamStore = createMemoryStore();
  const app = await createApp({ bootstrapEvents, streamStore });
  currentApp = app;
  try {
    const createPath = `/api/workspaces/${WORKSPACE_A}/agents`;
    const targetPath = `${createPath}/${AGENT_A}`;
    const configPath = `${targetPath}/config`;
    const config = JSON.parse(await readFile(CONFIG_FIXTURE, "utf8"));
    const created = await request(app, createPath, {
      body: {
        agentId: AGENT_A,
        ownerPrincipalId: ORDINARY_MEMBER,
        profile: {
          displayName: "Mutant target",
          email: "mutant@example.test",
          handle: "mutant-target",
        },
      },
      headers: { "x-test-principal": AGENT_MANAGER },
      idempotencyKey: key("z"),
      method: "POST",
    });
    assert.equal(created.status, 201);
    const configured = await request(app, configPath, {
      body: { config, expectedRevision: 0, expectedRevisionId: null },
      headers: { "x-test-principal": AGENT_MANAGER },
      idempotencyKey: key("2"),
      method: "POST",
    });
    assert.equal(configured.status, 201);
    const denied = await request(app, `${targetPath}/revisions`, {
      body: {
        config,
        expectedRevision: 1,
        expectedRevisionId: configured.payload.configRevision.revisionId,
      },
      headers: { "x-test-principal": ORDINARY_MEMBER },
      idempotencyKey: key("3"),
      method: "POST",
    });
    assert.equal(
      denied.status,
      404,
      "the capability matrix must refuse an ordinary member revision",
    );
  } finally {
    await currentApp.close();
  }
}

async function appendDirectoryEvent({
  actorId,
  app,
  data,
  eventType,
  idempotencyKey,
  operation,
}) {
  const directory = await app.workspaceDirectory.read();
  const context = establishContext(actorId);
  const envelope = issueEventEnvelope(
    {
      actorId,
      causation: null,
      correlationId: `cr_${idempotencyKey.slice(3)}`,
      data,
      eventType,
      idempotencyKey,
      schemaVersion: 1,
      workspaceId: WORKSPACE_A,
    },
    {
      clock: () => new Date("2026-08-06T00:00:00.000Z"),
      eventId: `ev_${idempotencyKey.slice(3)}`,
    },
  );
  const digest = digestEventEnvelope(envelope);
  return app.dispatchDoor.dispatch(
    {
      actorId,
      expectedHead: directory.nextOffset,
      idempotencyKey,
      operation,
      payload: { digest, event: envelope },
      stream: app.workspaceDirectory.stream,
      workspaceId: WORKSPACE_A,
    },
    { context },
  );
}

async function createApp({ bootstrapEvents, streamStore }) {
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
  const authModule = process.env.E2_T04_AUTH_MODULE
    ? await import(pathToFileURL(process.env.E2_T04_AUTH_MODULE).href)
    : { createAgentAdministrationAuthorization };
  const administrationAuthorization =
    authModule.createAgentAdministrationAuthorization({
      readDirectory: workspaceDirectory.read,
      workspaceId: WORKSPACE_A,
    });
  const dispatchDoor = createDispatchDoor({
    authorize: () => true,
    producerId: `verify-e2-t04-${Date.now()}-${Math.random()}`,
    streamStore,
  });
  const api = createAgentManagementApi({
    agentAdministrationAuthorization: administrationAuthorization,
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
  const server = createServer(async (request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "127.0.0.1"}`,
    );
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
    administrationAuthorization,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      dispatchDoor.close?.();
      await new Promise((resolve) => {
        server.close(resolve);
      });
    },
    dispatchDoor,
    server,
    streamStore,
    workspaceDirectory,
  };
}

async function request(
  app,
  pathname,
  { body = null, headers = {}, idempotencyKey = null, method = "GET" } = {},
) {
  const requestHeaders = {
    Accept: "application/json",
    Connection: "close",
    ...headers,
  };
  if (body !== null) requestHeaders["Content-Type"] = "application/json";
  if (idempotencyKey) requestHeaders["Idempotency-Key"] = idempotencyKey;
  let response;
  try {
    response = await fetch(new URL(pathname, app.baseUrl), {
      body: body === null ? undefined : JSON.stringify(body),
      headers: requestHeaders,
      method,
    });
  } catch (error) {
    throw new Error(
      `request failed for ${method} ${pathname}: ${error.message}`,
      {
        cause: error,
      },
    );
  }
  const text = await response.text();
  assert.doesNotMatch(text, new RegExp(CANARY, "u"));
  const payload = JSON.parse(text);
  HTTP_TRANSCRIPT.push({
    method,
    path: pathname,
    requestBody: body === null ? false : "redacted-json",
    response: payload,
    status: response.status,
  });
  return { payload, status: response.status };
}

async function sourceHeadsFor({ app, agentId, streamStore = app.streamStore }) {
  const directory = await app.workspaceDirectory.read();
  const config = await streamStore.read(
    streamNames.agentConfig(WORKSPACE_A, agentId),
    "-1",
  );
  const audit = await streamStore.read(
    streamNames.workspaceAudit(WORKSPACE_A),
    "-1",
  );
  const dispatch = await streamStore.read(DEFAULT_IDEMPOTENCY_STREAM, "-1");
  return {
    audit: { nextOffset: audit.nextOffset, streamDigest: audit.streamDigest },
    config: {
      nextOffset: config.nextOffset,
      streamDigest: config.streamDigest,
    },
    directory: {
      nextOffset: directory.nextOffset,
      stateDigest: directory.stateDigest,
      streamDigest: directory.streamDigest,
    },
    dispatch: {
      nextOffset: dispatch.nextOffset,
      streamDigest: dispatch.streamDigest,
    },
  };
}

async function readReplayState({ app, agentId, streamStore }) {
  const directory = await app.workspaceDirectory.read();
  const configSnapshot = await streamStore.read(
    streamNames.agentConfig(WORKSPACE_A, agentId),
    "-1",
  );
  const replay = replayAgentConfigStream(configSnapshot.records);
  return {
    directoryStateDigest: directory.stateDigest,
    directoryStreamDigest: directory.streamDigest,
    configStateDigest: replay.finalStateDigest,
    configStreamDigest: configSnapshot.streamDigest,
    configStatus: replay.finalState.entities.agents?.[agentId]?.status ?? null,
    directoryHead: directory.nextOffset,
    configHead: configSnapshot.nextOffset,
    result: "PASS",
  };
}

async function buildBootstrapEvents() {
  const fixture = JSON.parse(
    await readFile(
      path.join(
        root,
        ".eforest/tasks/epic-1-the-workspace/E1-T02-workspace-membership-and-roles/fixtures/valid/workspace-membership.v1.json",
      ),
      "utf8",
    ),
  );
  const events = fixture.records
    .filter(({ event }) => event.workspaceId === WORKSPACE_A)
    .map(({ event }) => event);
  const extraPrincipals = [
    [ORDINARY_MEMBER, "d", "Ordinary Member", "ordinary-member"],
    [ORDINARY_VIEWER, "q", "Ordinary Viewer", "ordinary-viewer"],
    [AGENT_MANAGER, "e", "Agent Manager", "agent-manager"],
    [CONNECTION_MANAGER, "f", "Connection Manager", "connection-manager"],
    [CHANNEL_MANAGER, "g", "Channel Manager", "channel-manager"],
  ];
  for (const [principalId, token, displayName, handle] of extraPrincipals) {
    events.push(
      bootstrapEvent("principal.created", ADA, {
        kind: "human",
        ownedBy: null,
        principalId,
        profile: {
          displayName,
          email: `${handle}@a.example`,
          handle,
        },
        subjectBinding: {
          audience: "stream-slack",
          issuer: "auth0",
          subject: `workspace-a-${token}`,
        },
      }),
    );
  }
  let expectedWorkspaceRevision = 4;
  for (const [index, principalId] of [
    ORDINARY_MEMBER,
    ORDINARY_VIEWER,
    AGENT_MANAGER,
    CONNECTION_MANAGER,
    CHANNEL_MANAGER,
  ].entries()) {
    const inviteId = `iv_${WORKSPACE_A.slice(3)}_${["h", "j", "k", "m", "v"][index].repeat(26)}`;
    events.push(
      bootstrapEvent("workspace.membership.invited", ADA, {
        expectedWorkspaceRevision,
        inviteId,
        principalId,
        role: "member",
      }),
    );
    expectedWorkspaceRevision += 1;
    events.push(
      bootstrapEvent("workspace.membership.accepted", principalId, {
        expectedWorkspaceRevision,
        inviteId,
        principalId,
      }),
    );
    expectedWorkspaceRevision += 1;
  }
  const grants = [
    createAdministrationGrant({
      capability: "agent.manager",
      principalId: AGENT_MANAGER,
      resourceId: WORKSPACE_A,
      resourceType: "workspace",
      workspaceId: WORKSPACE_A,
    }),
    createAdministrationGrant({
      capability: "connection.manager",
      principalId: CONNECTION_MANAGER,
      resourceId: CONNECTION_A,
      resourceType: "connection",
      workspaceId: WORKSPACE_A,
    }),
    createAdministrationGrant({
      capability: "channel.manager",
      principalId: CHANNEL_MANAGER,
      resourceId: CHANNEL_A,
      resourceType: "channel",
      workspaceId: WORKSPACE_A,
    }),
  ];
  for (const grant of grants) {
    events.push(
      bootstrapEvent(
        "workspace.directory.updated",
        ADA,
        administrationGrantDirectoryUpdate(grant),
      ),
    );
  }
  return events;
}

function bootstrapEvent(eventType, actorId, data) {
  eventSequence += 1;
  const token = String(900 + eventSequence).padStart(26, "0");
  const idempotencyKey = `ik_${token}`;
  return issueEventEnvelope(
    {
      actorId,
      causation: null,
      correlationId: `cr_${token}`,
      data,
      eventType,
      idempotencyKey,
      schemaVersion: 1,
      workspaceId: WORKSPACE_A,
    },
    {
      clock: () => new Date("2026-08-06T00:00:00.000Z"),
      eventId: `ev_${token}`,
    },
  );
}

function establishContext(principalId) {
  return establishWorkspaceContext({
    authenticatedPrincipalId: principalId,
    clientHost: "verify",
    trustedHost: "verify",
    trustedWorkspaceId: WORKSPACE_A,
  });
}

function targetForOperation(operation) {
  if (operation.startsWith("agent.")) {
    if (operation === "agent.create" || operation === "agent.roster.read") {
      return {
        agentId: null,
        resourceId: WORKSPACE_A,
        resourceType: "workspace",
      };
    }
    return { agentId: AGENT_A, resourceId: AGENT_A, resourceType: "agent" };
  }
  if (operation.startsWith("channel.")) {
    return { agentId: null, resourceId: CHANNEL_A, resourceType: "channel" };
  }
  if (operation.startsWith("connection.")) {
    return {
      agentId: null,
      resourceId: CONNECTION_A,
      resourceType: "connection",
    };
  }
  return { agentId: null, resourceId: WORKSPACE_A, resourceType: "workspace" };
}

function mutationSuffix(operation) {
  return {
    "agent.config.create": "config",
    "agent.config.revise": "revisions",
    "agent.lifecycle.activate": "activate",
    "agent.lifecycle.disable": "disable",
    "agent.lifecycle.revoke": "revoke",
  }[operation];
}

function bodyForOperation(operation) {
  if (operation === "agent.create") {
    return {
      agentId: AGENT_B,
      ownerPrincipalId: ORDINARY_MEMBER,
      profile: {
        displayName: "Denied agent",
        email: "denied@example.test",
        handle: "denied-agent",
      },
    };
  }
  if (operation === "agent.config.create") {
    return { config: {}, expectedRevision: 0, expectedRevisionId: null };
  }
  if (operation === "agent.config.revise") {
    return {
      config: {},
      expectedRevision: 2,
      expectedRevisionId:
        "acr_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    };
  }
  if (operation === "agent.lifecycle.activate") {
    return {
      expectedRevision: 2,
      expectedRevisionId:
        "acr_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      revisionId:
        "acr_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    };
  }
  return {
    expectedRevision: 2,
    expectedRevisionId:
      "acr_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  };
}

function principal(workspaceId, suffix) {
  return `pr_${workspaceId.slice(3)}_${suffix.repeat(26)}`;
}

function agent(workspaceId, suffix) {
  return `ag_${workspaceId.slice(3)}_${suffix.repeat(26)}`;
}

function managerGrantId() {
  return `grant:${AGENT_MANAGER}:agent.manager:workspace:${WORKSPACE_A}`;
}

function key(suffix) {
  const token = String(suffix).replace(/[^0-9a-hjkmnp-tv-z]/gu, "z");
  return `ik_${token.repeat(26).slice(0, 26)}`;
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
  };
}

function offsetFor(sequence) {
  return `0000000000000000_${String(sequence).padStart(16, "0")}`;
}

async function writeJson(filename, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  assert.doesNotMatch(text, new RegExp(CANARY, "u"));
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
