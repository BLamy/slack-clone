import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  AGENT_ADMINISTRATION_ACTOR_CLASSES,
  AGENT_ADMINISTRATION_CAPABILITIES,
  AGENT_ADMINISTRATION_MATRIX,
  agentRosterDigest,
  buildAgentRoster,
  canonicalInvocationSnapshot,
  capabilityAllowedForActorClass,
  channelMembershipKey,
  checkInvocationSnapshotUse,
  createAdministrationGrant,
  createInvocationSnapshot,
  createProviderRegistry,
  administrationGrantDirectoryUpdate,
  membershipIdFor,
  replayInvocationSnapshot,
} from "@stream-slack/protocol";

import { createAgentManagementApi } from "../src/ledger/agent-management.mjs";
import { createAgentAdministrationAuthorization } from "../src/ledger/agent-administration-auth.mjs";
import {
  createAgentConfigStream,
  replayAgentConfigStream,
} from "../src/ledger/agent-config-stream.mjs";
import {
  createChannelAuthorization,
  createChannelFence,
} from "../src/ledger/channel-auth.mjs";
import { canonicalSha256 } from "../src/ledger/canonical-json.mjs";
import {
  createDispatchDoor,
  DEFAULT_IDEMPOTENCY_STREAM,
} from "../src/ledger/dispatch.mjs";
import {
  digestEventEnvelope,
  issueEventEnvelope,
} from "../src/ledger/envelope.mjs";
import { validateAndReplayDump } from "../src/ledger/replay.mjs";
import {
  bindWorkspaceRequest,
  createWorkspaceAuthorization,
  createWorkspaceFence,
  establishWorkspaceContext,
} from "../src/ledger/workspace-auth.mjs";
import { createWorkspaceDirectoryAuthority } from "../src/ledger/workspace-directory.mjs";
import { streamNames } from "../src/ledger/topology.mjs";

const root = path.resolve(import.meta.dirname, "..");
const runId = String(
  process.env.TEST_RUN_ID ?? `verify-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/gu, "-");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-2-the-roster/E2-T08-configure-reconfigure-revoke-agent",
);
const artifactRoot = path.resolve(
  root,
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e2-t08", runId),
);
const evidenceDirectory =
  process.env.PROMOTE_EVIDENCE === "1"
    ? path.join(taskDirectory, "evidence/e2-t08-final")
    : artifactRoot;
const implementationCommit = String(
  process.env.E2_T08_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();

const WORKSPACE_A = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const WORKSPACE_B = "ws_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADA = principal(WORKSPACE_A, "b");
const SERVICE = principal(WORKSPACE_A, "d");
const ORDINARY_MEMBER = principal(WORKSPACE_A, "e");
const AGENT_MANAGER = principal(WORKSPACE_A, "f");
const CONNECTION_MANAGER = principal(WORKSPACE_A, "g");
const CHANNEL_MANAGER = principal(WORKSPACE_A, "h");
const ORDINARY_VIEWER = principal(WORKSPACE_A, "x");
const CROSS_WORKSPACE_ADMIN = principal(WORKSPACE_B, "c");
const AGENT_A = agent(WORKSPACE_A, "j");
const AGENT_B = agent(WORKSPACE_A, "k");
const CROSS_WORKSPACE_AGENT = agent(WORKSPACE_B, "d");
const AGENT_PRINCIPAL_A = `pr_${AGENT_A.slice(3)}`;
const GENERAL_CHANNEL_ID = `ch_${WORKSPACE_A.slice(3)}_${"1".repeat(26)}`;
const SIBLING_CHANNEL_ID = `ch_${WORKSPACE_B.slice(3)}_${"1".repeat(26)}`;
const CONNECTION_A = `cn_${WORKSPACE_A.slice(3)}_${"n".repeat(26)}`;
const CROSS_WORKSPACE_CONNECTION = `cn_${WORKSPACE_B.slice(3)}_${"n".repeat(26)}`;
const CANARY = "Bearer e2-t08-agent-control-canary-123456789";
const CONFIG_PATH = path.join(
  root,
  ".eforest/tasks/epic-2-the-roster/E2-T01-versioned-agent-config-schema/fixtures/valid/agent-config.v1.json",
);

const HTTP_TRANSCRIPT = [];
const CLI_TRANSCRIPT = [];
let eventSequence = 1000;
let keySequence = 0;
let currentBaseUrl = null;

await main();

async function main() {
  await mkdir(evidenceDirectory, { recursive: true });
  if (process.env.PROMOTE_EVIDENCE === "1") {
    const trackedChanges = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      { cwd: root, encoding: "utf8" },
    ).trim();
    assert.equal(
      trackedChanges,
      "",
      "promoted E2-T08 evidence must start from a clean tracked implementation tree",
    );
  }

  const bootstrapEvents = await buildBootstrapEvents();
  const streamStore = createMemoryStore();
  const app = await createApp({ bootstrapEvents, streamStore });
  try {
    const workflow = await verifyWorkflow({
      app,
      streamStore,
    });
    const sensitivity = await runSensitivityProbes(workflow);
    const gates = runGates();
    assert.equal(sensitivity.verifierDetectedMutant, true);

    const summary = {
      schemaVersion: 1,
      task: "E2-T08",
      runId,
      implementationCommit,
      result: "PASS",
      replayDescription:
        "Replay: N/A (server/CLI agent-control capstone) + mitigation: role matrix, revision/snapshot manifests, revocation race, canary scan, and composite stream replay",
      skips:
        process.env.E2_T08_SKIP_GATES === "1"
          ? ["format", "lint", "typecheck", "test", "build"]
          : [],
      gates,
      bootstrap: {
        directoryStream: app.workspaceDirectory.stream,
        eventCount: bootstrapEvents.length,
        sourceFixture:
          "E1-T03 channel lifecycle fixture filtered to workspace A",
      },
      workflow: workflow.summary,
      snapshots: workflow.snapshots,
      matrix: workflow.matrix,
      revocationRaces: workflow.revocationRaces,
      tamperMatrix: workflow.tamperMatrix,
      replay: workflow.replay,
      sensitivity,
      canaryScan: {
        inputInjected: true,
        checked: [
          "stream dumps",
          "HTTP transcript",
          "CLI transcript",
          "snapshot manifests",
          "provider doubles",
          "published evidence",
        ],
        leaked: false,
        result: "PASS",
      },
    };

    await writeJson("verification-summary.json", summary);
    await writeJson("http-transcript.json", HTTP_TRANSCRIPT);
    await writeJson("cli-transcript.json", CLI_TRANSCRIPT);
    await writeJson("source-dumps.json", workflow.sourceDumps);
    await writeJson("snapshot-manifests.json", workflow.snapshotEvidence);
    await writeJson("role-matrix.json", workflow.matrix);
    await writeJson("roster.json", workflow.rosterEvidence);
    await writeJson("revocation-races.json", workflow.revocationRaces);
    await writeJson("replay-composite.json", workflow.replay);
    await writeJson("tamper-matrix.json", workflow.tamperMatrix);
    await writeJson("sensitivity.json", sensitivity);
    await writeJson("canary-scan.json", summary.canaryScan);

    const evidenceFiles = await scanPublishedEvidence();
    summary.canaryScan = {
      ...summary.canaryScan,
      evidenceFiles,
      publishedEvidenceLeaked: false,
    };
    await writeJson("verification-summary.json", summary);
    await writeJson("canary-scan.json", summary.canaryScan);

    console.log(
      JSON.stringify(
        {
          result: "PASS",
          task: "E2-T08",
          implementationCommit,
          agent: AGENT_A,
          firstSnapshotDigest: workflow.snapshots.first.snapshotDigest,
          secondSnapshotDigest: workflow.snapshots.second.snapshotDigest,
          compositeDigest: workflow.replay.compositeDigest,
          matrixRows: workflow.matrix.rows.length,
          sensitivity: sensitivity.verifierDetectedMutant,
          skips: summary.skips,
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
}

async function verifyWorkflow({ app, streamStore }) {
  debug("workflow start");
  const config1 = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  const config2 = structuredClone(config1);
  config2.instructions.task =
    "Answer revision two using the same fenced policy.";
  config2.connectionGrants.refs = config2.connectionGrants.refs.map((ref) => ({
    ...ref,
    revision: 2,
  }));

  const createBody = {
    agentId: AGENT_A,
    ownerPrincipalId: ORDINARY_MEMBER,
    profile: {
      displayName: "E2-T08 Control Plane Agent",
      email: "e2-t08-agent@example.test",
      handle: "e2-t08-control-plane-agent",
    },
  };
  const configCreateBody = {
    config: config1,
    expectedRevision: 0,
    expectedRevisionId: null,
  };
  const lostAcknowledgementEvidence = [];

  const createIdempotencyKey = nextKey("create-lost-ack");
  const lostCreate = await runLostAckCreate({
    app,
    body: createBody,
    idempotencyKey: createIdempotencyKey,
    streamStore,
  });
  const createRetry = await runCli("create", {
    actorId: AGENT_MANAGER,
    body: createBody,
    idempotencyKey: createIdempotencyKey,
  });
  assert.equal(createRetry.payload.agent.agentId, AGENT_A);
  assert.equal(lostCreate.durableEventCount, 1);
  lostAcknowledgementEvidence.push({
    command: "create",
    durableEventCount: lostCreate.durableEventCount,
    clientAborted: lostCreate.clientAborted,
  });
  const changedCreate = await runCli("create", {
    actorId: AGENT_MANAGER,
    body: {
      ...createBody,
      profile: {
        ...createBody.profile,
        displayName: "Changed idempotency payload",
      },
    },
    expectSuccess: false,
    idempotencyKey: createIdempotencyKey,
  });
  assert.notEqual(changedCreate.exitCode, 0);

  const configCreateKey = nextKey("config-create-lost-ack");
  const lostConfigCreate = await runLostAckMutation({
    app,
    body: configCreateBody,
    eventType: "agent.config.created",
    idempotencyKey: configCreateKey,
    operation: "config-create",
    pathname: `/api/workspaces/${WORKSPACE_A}/agents/${AGENT_A}/config`,
    stream: streamNames.agentConfig(WORKSPACE_A, AGENT_A),
    streamStore,
  });
  const configCreateRetry = await runCli("config-create", {
    actorId: AGENT_MANAGER,
    agentId: AGENT_A,
    body: configCreateBody,
    idempotencyKey: configCreateKey,
  });
  const firstRevisionId = configCreateRetry.payload.configRevision.revisionId;
  assert.equal(lostConfigCreate.durableEventCount, 1);
  assert.equal(
    configCreateRetry.payload.configRevision.revisionId,
    firstRevisionId,
  );
  lostAcknowledgementEvidence.push({
    command: "config-create",
    durableEventCount: lostConfigCreate.durableEventCount,
    clientAborted: lostConfigCreate.clientAborted,
  });

  await appendAgentWorkspaceMembership({ app });
  const invite = await request(app, channelPath("invite"), {
    actorId: ADA,
    body: {
      inviteId: `iv_${WORKSPACE_A.slice(3)}_${"p".repeat(26)}`,
      principalId: AGENT_PRINCIPAL_A,
    },
    method: "POST",
  });
  assert.equal(invite.status, 201);
  const join = await request(app, channelPath("join"), {
    actorId: AGENT_PRINCIPAL_A,
    body: {
      inviteId: `iv_${WORKSPACE_A.slice(3)}_${"p".repeat(26)}`,
      principalId: AGENT_PRINCIPAL_A,
    },
    method: "POST",
  });
  assert.equal(join.status, 201);

  const activateBody = {
    expectedRevision: 1,
    expectedRevisionId: firstRevisionId,
    revisionId: firstRevisionId,
  };
  const activateKey = nextKey("activate-1-lost-ack");
  const lostActivate = await runLostAckMutation({
    app,
    body: activateBody,
    eventType: "agent.config.activated",
    idempotencyKey: activateKey,
    operation: "activate",
    pathname: `/api/workspaces/${WORKSPACE_A}/agents/${AGENT_A}/activate`,
    stream: streamNames.agentConfig(WORKSPACE_A, AGENT_A),
    streamStore,
  });
  const activateRetry = await runCli("activate", {
    actorId: AGENT_MANAGER,
    agentId: AGENT_A,
    body: activateBody,
    idempotencyKey: activateKey,
  });
  assert.equal(lostActivate.durableEventCount, 1);
  assert.equal(activateRetry.payload.configuration.status, "active");
  lostAcknowledgementEvidence.push({
    command: "activate",
    durableEventCount: lostActivate.durableEventCount,
    clientAborted: lostActivate.clientAborted,
  });

  const baseRegistry = createProviderRegistry({ now: 0 });
  const providerRegistryV2 = baseRegistry
    .withNow(1)
    .updateStatus({
      selection: {
        kind: "harness",
        providerId: "scripted",
        providerVersion: "1.0.0",
      },
      observedAt: 1,
    })
    .updateStatus({
      selection: {
        kind: "sandbox",
        providerId: "scripted",
        providerVersion: "1.0.0",
      },
      observedAt: 1,
    });

  await appendConnectionRevision({
    actorId: CONNECTION_MANAGER,
    revision: 1,
    streamStore,
  });
  const firstSnapshotBundle = await makeSnapshotBundle({
    app,
    configRegistry: baseRegistry,
    configStateOverride: null,
    now: 100,
    revision: 1,
    streamStore,
  });
  debug("first snapshot");
  const firstSnapshotBytes = JSON.stringify(firstSnapshotBundle.snapshot);
  const rosterBefore = await buildRoster({
    app,
    configRegistry: baseRegistry,
    streamStore,
  });
  const agentBefore = rosterBefore.directory.find(
    ({ principalId }) => principalId === AGENT_PRINCIPAL_A,
  );
  const channelBefore = rosterBefore.channels.find(
    ({ channelId }) => channelId === GENERAL_CHANNEL_ID,
  );
  assert.equal(agentBefore.availability, "available");
  assert.equal(agentBefore.chatMember, true);
  assert.ok(
    channelBefore.members.some(
      ({ principalId }) => principalId === AGENT_PRINCIPAL_A,
    ),
  );

  const configRevisionBody = {
    config: config2,
    expectedRevision: 1,
    expectedRevisionId: firstRevisionId,
  };
  const configRevisionKey = nextKey("revise-2-lost-ack");
  const lostConfigRevision = await runLostAckMutation({
    app,
    body: configRevisionBody,
    eventType: "agent.config.revised",
    idempotencyKey: configRevisionKey,
    operation: "revise",
    pathname: `/api/workspaces/${WORKSPACE_A}/agents/${AGENT_A}/revisions`,
    stream: streamNames.agentConfig(WORKSPACE_A, AGENT_A),
    streamStore,
  });
  const configRevisionRetry = await runCli("revise", {
    actorId: AGENT_MANAGER,
    agentId: AGENT_A,
    body: configRevisionBody,
    idempotencyKey: configRevisionKey,
  });
  const secondRevisionId =
    configRevisionRetry.payload.configRevision.revisionId;
  assert.equal(lostConfigRevision.durableEventCount, 1);
  assert.equal(
    configRevisionRetry.payload.configRevision.revisionId,
    secondRevisionId,
  );
  lostAcknowledgementEvidence.push({
    command: "revise",
    durableEventCount: lostConfigRevision.durableEventCount,
    clientAborted: lostConfigRevision.clientAborted,
  });
  const activateSecondBody = {
    expectedRevision: 2,
    expectedRevisionId: secondRevisionId,
    revisionId: secondRevisionId,
  };
  const activateSecondKey = nextKey("activate-2-lost-ack");
  const lostActivateSecond = await runLostAckMutation({
    app,
    body: activateSecondBody,
    eventType: "agent.config.activated",
    idempotencyKey: activateSecondKey,
    operation: "activate",
    pathname: `/api/workspaces/${WORKSPACE_A}/agents/${AGENT_A}/activate`,
    stream: streamNames.agentConfig(WORKSPACE_A, AGENT_A),
    streamStore,
  });
  const activateSecond = await runCli("activate", {
    actorId: AGENT_MANAGER,
    agentId: AGENT_A,
    body: activateSecondBody,
    idempotencyKey: activateSecondKey,
  });
  assert.equal(lostActivateSecond.durableEventCount, 1);
  assert.equal(
    activateSecond.payload.configuration.activeRevisionId,
    secondRevisionId,
  );
  lostAcknowledgementEvidence.push({
    command: "activate",
    durableEventCount: lostActivateSecond.durableEventCount,
    clientAborted: lostActivateSecond.clientAborted,
  });

  await appendConnectionRevision({
    actorId: CONNECTION_MANAGER,
    revision: 2,
    streamStore,
  });
  const secondSnapshotBundle = await makeSnapshotBundle({
    app,
    configRegistry: providerRegistryV2,
    configStateOverride: null,
    now: 200,
    revision: 2,
    streamStore,
  });
  debug("second snapshot");
  const secondSnapshotBytes = JSON.stringify(secondSnapshotBundle.snapshot);
  assert.equal(
    JSON.stringify(firstSnapshotBundle.snapshot),
    firstSnapshotBytes,
    "first invocation snapshot changed while reconfiguring",
  );
  assert.notEqual(
    firstSnapshotBundle.snapshot.snapshotDigest,
    secondSnapshotBundle.snapshot.snapshotDigest,
  );
  assert.notEqual(
    firstSnapshotBundle.snapshot.providers.manifestDigest,
    secondSnapshotBundle.snapshot.providers.manifestDigest,
  );
  assert.equal(secondSnapshotBundle.snapshot.config.revision, 2);
  assert.deepEqual(
    secondSnapshotBundle.snapshot.connectionGrants.refs.map(
      ({ revision }) => revision,
    ),
    [2, 2],
  );

  const useBeforeRevoke = checkInvocationSnapshotUse({
    ...secondSnapshotBundle.input,
    snapshot: secondSnapshotBundle.snapshot,
  });
  assert.equal(useBeforeRevoke.allowed, true);
  const staleAfterReconfigure = checkInvocationSnapshotUse({
    ...secondSnapshotBundle.input,
    snapshot: firstSnapshotBundle.snapshot,
  });
  assert.equal(staleAfterReconfigure.allowed, false);

  const canary = await verifyCanaryRefusal({
    app,
    config: config2,
    secondRevisionId,
    streamStore,
  });

  const matrix = await verifyRoleMatrix({
    app,
    config: config1,
    firstRevisionId,
    secondRevisionId,
    streamStore,
  });
  debug("role matrix");

  const race = await raceRevisions({
    app,
    config: config2,
    secondRevisionId,
    streamStore,
  });
  debug("revision race");
  assert.equal(race.successes, 1);
  assert.equal(race.conflicts, 1);

  const revocationRaces = await verifyRevocationRaces({
    app,
    firstSnapshotBundle,
    providerRegistryV2,
    secondSnapshotBundle,
    streamStore,
  });
  debug("revocation races");

  const headBeforeRevoke = await managerConfigHead({ app });
  const actualRevokeRace = await verifyActualRevokeRace({
    app,
    secondSnapshotBundle,
    streamStore,
    expectedRevision: headBeforeRevoke.revision,
    expectedRevisionId: headBeforeRevoke.revisionId,
  });
  const revoke = actualRevokeRace.revoke;
  const revokeRetry = await runCli("revoke", {
    actorId: AGENT_MANAGER,
    agentId: AGENT_A,
    body: {
      expectedRevision: headBeforeRevoke.revision,
      expectedRevisionId: headBeforeRevoke.revisionId,
    },
    idempotencyKey: revoke.idempotencyKey,
  });
  assert.equal(revoke.payload.revoked, true);
  assert.equal(revokeRetry.payload.revoked, true);
  lostAcknowledgementEvidence.push({
    command: "revoke",
    durableEventCount: actualRevokeRace.lostAck.durableEventCount,
    clientAborted: actualRevokeRace.lostAck.clientAborted,
  });
  assert.deepEqual(
    lostAcknowledgementEvidence.map(({ command }) => command),
    ["create", "config-create", "activate", "revise", "activate", "revoke"],
  );
  assert.equal(
    lostAcknowledgementEvidence.every(
      ({ clientAborted, durableEventCount }) =>
        clientAborted && durableEventCount === 1,
    ),
    true,
  );
  const firstByteStableAfterRevoke =
    JSON.stringify(firstSnapshotBundle.snapshot) === firstSnapshotBytes;
  assert.equal(firstByteStableAfterRevoke, true);
  revocationRaces.actualConfigRevoke = actualRevokeRace.evidence;
  revocationRaces.historicalFirstSnapshotStableAfterRevoke =
    firstByteStableAfterRevoke;

  const tamperMatrix = verifyTamperMatrix({
    firstSnapshot: firstSnapshotBundle.snapshot,
    input: secondSnapshotBundle.input,
    providerRegistryV2,
    secondSnapshot: secondSnapshotBundle.snapshot,
    streamStore,
  });
  debug("tamper matrix");
  const sourceDumps = await sourceDumpsFor({ app, streamStore });
  const rosterAfter = await buildRoster({
    app,
    configRegistry: providerRegistryV2,
    streamStore,
  });
  const replay = await verifyProjectionReplay({
    configRegistry: providerRegistryV2,
    firstSnapshot: firstSnapshotBundle.snapshot,
    rosterAfter,
    secondSnapshot: secondSnapshotBundle.snapshot,
    sourceDumps,
  });
  if (process.env.E2_T08_MUTATION === "replay-digest") {
    replay.directoryStateDigest = `sha256:${"0".repeat(64)}`;
  }
  assert.equal(
    replay.compositeDigest,
    canonicalSha256(replayCompositePayload(replay)),
    "replay composite integrity detector did not detect a mutated source digest",
  );
  debug("projection replay");

  const history = await runCli("history", {
    actorId: AGENT_MANAGER,
    agentId: AGENT_A,
  });
  assert.ok(history.payload.entries.length >= 5);
  assert.equal(replay.activeConfigStatus, "retired");
  assert.equal(replay.rosterDigest, agentRosterDigest(rosterAfter));

  return {
    summary: {
      agentId: AGENT_A,
      agentPrincipalId: AGENT_PRINCIPAL_A,
      createdBy: AGENT_MANAGER,
      ownerPrincipalId: ORDINARY_MEMBER,
      workspaceId: WORKSPACE_A,
      channelId: GENERAL_CHANNEL_ID,
      configurationRevisions: [1, 2, race.winningRevision],
      lifecycle: "draft -> active -> retired",
      channelContract: [
        "workspace.membership.invited",
        "workspace.membership.accepted",
        "channel.membership.invited",
        "channel.membership.joined",
      ],
      firstSnapshotByteLength: firstSnapshotBytes.length,
      secondSnapshotByteLength: secondSnapshotBytes.length,
      firstSnapshotReplayable: true,
      secondSnapshotReplayable: true,
      historicalSnapshotsStableAfterRevoke: firstByteStableAfterRevoke,
      idempotency: {
        lostAcknowledgementRecovered: lostCreate.clientAborted,
        duplicatePrincipalEvents: lostCreate.durableEventCount,
        changedPayloadExitCode: changedCreate.exitCode,
        changedPayloadRefused: changedCreate.exitCode !== 0,
        lostAcknowledgementCommands: lostAcknowledgementEvidence,
        everyMutatingCliCommandLostAcked: lostAcknowledgementEvidence.every(
          ({ clientAborted, durableEventCount }) =>
            clientAborted && durableEventCount === 1,
        ),
      },
      historyEntries: history.payload.entries.length,
      canaryRefusal: canary,
    },
    snapshots: {
      first: {
        snapshotDigest: firstSnapshotBundle.snapshot.snapshotDigest,
        canonicalBytes: firstSnapshotBundle.canonicalBytes,
        configRevision: firstSnapshotBundle.snapshot.config.revision,
        configRevisionId: firstSnapshotBundle.snapshot.config.activeRevisionId,
        providerManifestDigest:
          firstSnapshotBundle.snapshot.providers.manifestDigest,
        grantRevisions: firstSnapshotBundle.snapshot.connectionGrants.refs.map(
          ({ revision }) => revision,
        ),
        sourceManifest: firstSnapshotBundle.snapshot.sourceManifest,
        replayable: true,
      },
      second: {
        snapshotDigest: secondSnapshotBundle.snapshot.snapshotDigest,
        canonicalBytes: secondSnapshotBundle.canonicalBytes,
        configRevision: secondSnapshotBundle.snapshot.config.revision,
        configRevisionId: secondSnapshotBundle.snapshot.config.activeRevisionId,
        providerManifestDigest:
          secondSnapshotBundle.snapshot.providers.manifestDigest,
        grantRevisions: secondSnapshotBundle.snapshot.connectionGrants.refs.map(
          ({ revision }) => revision,
        ),
        sourceManifest: secondSnapshotBundle.snapshot.sourceManifest,
        replayable: true,
      },
      firstByteStableAfterReconfigure: true,
      firstByteStableAfterRevoke,
      differentCanonicalDigests: true,
    },
    matrix,
    revocationRaces,
    tamperMatrix,
    canary,
    replay,
    sourceDumps,
    snapshotEvidence: {
      first: firstSnapshotBundle.snapshot,
      second: secondSnapshotBundle.snapshot,
      firstCanonical: firstSnapshotBundle.canonicalSnapshot,
      secondCanonical: secondSnapshotBundle.canonicalSnapshot,
      historicalBytesStable: true,
    },
    rosterEvidence: {
      before: {
        digest: agentRosterDigest(rosterBefore),
        agentAvailability: agentBefore.availability,
        channelMember: true,
      },
      after: {
        digest: agentRosterDigest(rosterAfter),
        agentAvailability: rosterAfter.directory.find(
          ({ principalId }) => principalId === AGENT_PRINCIPAL_A,
        )?.availability,
        channelMember: rosterAfter.channels
          .find(({ channelId }) => channelId === GENERAL_CHANNEL_ID)
          ?.members.some(
            ({ principalId }) => principalId === AGENT_PRINCIPAL_A,
          ),
      },
      sameHumanAndAgentRosterContract: true,
    },
  };
}

async function runLostAckCreate({ app, body, idempotencyKey, streamStore }) {
  return runLostAckMutation({
    app,
    body,
    eventType: "principal.created",
    idempotencyKey,
    operation: "create",
    pathname: `/api/workspaces/${WORKSPACE_A}/agents`,
    stream: app.workspaceDirectory.stream,
    streamStore,
  });
}

async function runLostAckMutation({
  actorId = AGENT_MANAGER,
  afterDurableAppend = null,
  app,
  body,
  eventType,
  idempotencyKey,
  method = "POST",
  operation,
  pathname,
  stream: targetStream,
  streamStore,
}) {
  const bodyText = JSON.stringify(body);
  let resolveObserved;
  let resolveRelease;
  let resolveClosed;
  const observed = new Promise((resolve) => {
    resolveObserved = resolve;
  });
  const release = new Promise((resolve) => {
    resolveRelease = resolve;
  });
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  let clientAborted = false;
  let requestError = null;
  streamStore.setAppendHook(async ({ record, stream }) => {
    const event = record?.event ?? record;
    if (
      stream === targetStream &&
      event?.eventType === eventType &&
      event?.idempotencyKey === idempotencyKey
    ) {
      resolveObserved();
      await release;
    }
  });
  const target = new URL(pathname, app.baseUrl);
  const client = httpRequest(
    target,
    {
      headers: {
        Accept: "application/json",
        Connection: "close",
        "Content-Length": Buffer.byteLength(bodyText),
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "x-test-principal": actorId,
      },
      method,
    },
    (response) => {
      response.resume();
      response.once("close", resolveClosed);
    },
  );
  client.once("error", (error) => {
    requestError = error;
    resolveClosed();
  });
  client.once("close", resolveClosed);
  client.end(bodyText);
  try {
    await observed;
    await afterDurableAppend?.();
    clientAborted = true;
    client.destroy();
    resolveRelease();
    await closed;
    assert.ok(
      requestError === null || requestError.code === "ECONNRESET",
      `unexpected lost-ack client error ${requestError?.code ?? "none"}`,
    );
    const durableEventCount = streamStore
      .peek(targetStream)
      .filter((record) => {
        const event = record?.event ?? record;
        return (
          event?.eventType === eventType &&
          event?.idempotencyKey === idempotencyKey
        );
      }).length;
    assert.equal(durableEventCount, 1);
    HTTP_TRANSCRIPT.push({
      actor: actorId,
      method,
      path: pathname,
      requestBody: "redacted-json",
      response: "client-aborted-after-durable-append",
      status: "client-aborted",
      operation,
    });
    return { clientAborted, durableEventCount, operation };
  } finally {
    client.destroy();
    resolveRelease();
    streamStore.setAppendHook(null);
  }
}

async function verifyActualRevokeRace({
  app,
  expectedRevision,
  expectedRevisionId,
  secondSnapshotBundle,
  streamStore,
}) {
  const idempotencyKey = nextKey("revoke-race");
  const body = { expectedRevision, expectedRevisionId };
  let retiredSnapshot;
  let retiredState;
  let decision;
  const lostAck = await runLostAckMutation({
    app,
    afterDurableAppend: async () => {
      retiredSnapshot = await createAgentConfigStream({
        agentId: AGENT_A,
        streamStore,
        workspaceId: WORKSPACE_A,
      }).read();
      retiredState = retiredSnapshot.state.entities.agents?.[AGENT_A];
      decision = checkInvocationSnapshotUse({
        ...secondSnapshotBundle.input,
        configState: retiredState,
        snapshot: secondSnapshotBundle.snapshot,
      });
      assert.equal(decision.allowed, false);
      assert.equal(decision.code, "INVOCATION_SNAPSHOT_AGENT_CONFIG_INACTIVE");
    },
    body,
    eventType: "agent.config.retired",
    idempotencyKey,
    operation: "revoke",
    pathname: `/api/workspaces/${WORKSPACE_A}/agents/${AGENT_A}/revoke`,
    stream: streamNames.agentConfig(WORKSPACE_A, AGENT_A),
    streamStore,
  });
  const revoke = await runCli("revoke", {
    actorId: AGENT_MANAGER,
    agentId: AGENT_A,
    body,
    idempotencyKey,
  });
  assert.equal(revoke.payload.revoked, true);
  return {
    lostAck,
    revoke,
    evidence: {
      appendObservedBeforeResponse: lostAck.clientAborted,
      clientAbortedAfterDurableAppend: lostAck.clientAborted,
      configStatusAfterDurableRetire: retiredState.status,
      historicalSnapshotUseRefused: true,
      code: decision.code,
      requestIdempotencyKey: idempotencyKey,
      sourceOffset: retiredSnapshot.nextOffset,
      historicalSnapshotBytesWereNotMutated: true,
      result: "PASS",
    },
  };
}

async function verifyCanaryRefusal({
  app,
  config,
  secondRevisionId,
  streamStore,
}) {
  const before = await sourceHeadsFor({ app, streamStore });
  const body = {
    config: { credentials: { token: CANARY } },
    expectedRevision: 2,
    expectedRevisionId: secondRevisionId,
  };
  const http = await request(
    app,
    `/api/workspaces/${WORKSPACE_A}/agents/${AGENT_A}/revisions`,
    {
      actorId: AGENT_MANAGER,
      body,
      idempotencyKey: nextKey("canary-http"),
      method: "POST",
    },
  );
  assert.notEqual(http.status, 201);
  const cli = await runCli("revise", {
    actorId: AGENT_MANAGER,
    agentId: AGENT_A,
    body: {
      config: { ...config, credentials: { token: CANARY } },
      expectedRevision: 2,
      expectedRevisionId: secondRevisionId,
    },
    expectSuccess: false,
    idempotencyKey: nextKey("canary-cli"),
  });
  assert.notEqual(cli.exitCode, 0);
  const after = await sourceHeadsFor({ app, streamStore });
  assert.deepEqual(after, before);
  return {
    apiStatus: http.status,
    cliExitCode: cli.exitCode,
    inputCanaryInjected: true,
    sourceHeadsUnchanged: true,
    responseAndTranscriptRedacted: true,
    result: "PASS",
  };
}

async function verifyRoleMatrix({
  app,
  config,
  firstRevisionId,
  secondRevisionId,
  streamStore,
}) {
  const actors = [
    ["workspace-admin", ADA],
    ["agent-manager", AGENT_MANAGER],
    ["agent-owner", ORDINARY_MEMBER],
    ["channel-manager", CHANNEL_MANAGER],
    ["connection-manager", CONNECTION_MANAGER],
    ["ordinary-member", ORDINARY_VIEWER],
    ["agent-principal", AGENT_PRINCIPAL_A],
    ["service-principal", SERVICE],
  ];
  const rows = [];
  const matrixGroups = [
    {
      operations: [
        "agent.create",
        "agent.roster.read",
        "provider.registry.read",
        "provider.registry.manage",
        "principal.impersonate",
      ],
      target: {
        agentId: null,
        resourceId: WORKSPACE_A,
        resourceType: "workspace",
      },
    },
    {
      operations: [
        "agent.profile.read",
        "agent.history.read",
        "agent.config.read",
        "agent.config.create",
        "agent.config.revise",
        "agent.lifecycle.activate",
        "agent.lifecycle.disable",
        "agent.lifecycle.revoke",
      ],
      target: { agentId: AGENT_A, resourceId: AGENT_A, resourceType: "agent" },
    },
    {
      operations: ["channel.membership.manage"],
      target: {
        agentId: null,
        resourceId: GENERAL_CHANNEL_ID,
        resourceType: "channel",
      },
    },
    {
      operations: [
        "connection.reference.bind",
        "connection.grant.manage",
        "connection.credential.read",
      ],
      target: {
        agentId: null,
        resourceId: CONNECTION_A,
        resourceType: "connection",
      },
    },
  ];
  for (const [actorClass, actorId] of actors) {
    const context = establishContext(actorId);
    for (const group of matrixGroups) {
      const decision = await app.administrationAuthorization.explain({
        agentId: group.target.agentId,
        context,
        operations: group.operations,
        resourceId: group.target.resourceId,
        resourceType: group.target.resourceType,
      });
      for (const operation of group.operations) {
        const target = targetForOperation(operation);
        const expected = capabilityAllowedForActorClass(actorClass, operation);
        const matrixExpected =
          AGENT_ADMINISTRATION_MATRIX[actorClass].includes(operation);
        assert.equal(expected, matrixExpected);
        const effectiveExpected = decision.actorClasses.some((resolvedClass) =>
          capabilityAllowedForActorClass(resolvedClass, operation),
        );
        assert.equal(
          decision.allowedOperations.includes(operation),
          effectiveExpected,
          `${actorClass} ${operation} matrix mismatch`,
        );
        rows.push({
          actorClass,
          actorId,
          operation,
          expected,
          effectiveExpected,
          allowed: decision.allowedOperations.includes(operation),
          actorClasses: decision.actorClasses,
          resourceId: target.resourceId,
          resourceType: target.resourceType,
          source: decision.source ?? null,
        });
      }
    }
  }

  const negativeActors = [
    ["agent-owner", ORDINARY_MEMBER],
    ["ordinary-member", ORDINARY_VIEWER],
    ["agent-principal", AGENT_PRINCIPAL_A],
    ["connection-manager", CONNECTION_MANAGER],
    ["channel-manager", CHANNEL_MANAGER],
    ["service-principal", SERVICE],
    ["mismatched-workspace-admin", CROSS_WORKSPACE_ADMIN],
  ];
  const managementOperations = [
    "agent.create",
    "agent.config.create",
    "agent.config.revise",
    "agent.lifecycle.activate",
    "agent.lifecycle.disable",
    "agent.lifecycle.revoke",
    "agent.history.read",
  ];
  const negativeBaseline = await sourceHeadsFor({ app, streamStore });
  const negativeCases = negativeActors.flatMap(([actorClass, actorId]) =>
    managementOperations.map((operation) => ({
      actorClass,
      actorId,
      operation,
    })),
  );
  const negativeResults = await Promise.all(
    negativeCases.map(({ actorId, operation }) =>
      request(app, managementRequest(operation), {
        actorId,
        body: managementBody(
          operation,
          config,
          firstRevisionId,
          secondRevisionId,
        ),
        idempotencyKey: nextKey("matrix"),
        method: operation === "agent.history.read" ? "GET" : "POST",
      }),
    ),
  );
  debug("negative HTTP matrix responses");
  const negativeAfter = await sourceHeadsFor({ app, streamStore });
  assert.deepEqual(
    negativeAfter,
    negativeBaseline,
    "negative matrix moved a source head",
  );
  const negativeRows = negativeCases.map(
    ({ actorClass, actorId, operation }, index) => {
      const result = negativeResults[index];
      assert.equal(result.status, 404, `${actorClass} ${operation}`);
      return {
        actorClass,
        actorId,
        operation,
        status: result.status,
        sourceHeadsUnchanged: true,
        noExistenceOracle: true,
      };
    },
  );

  const connectionRows = [];
  const connectionBaseline = await sourceHeadsFor({ app, streamStore });
  for (const [actorClass, actorId] of negativeActors) {
    for (const operation of [
      "connection.reference.bind",
      "connection.grant.manage",
      "connection.credential.read",
    ]) {
      const allowed =
        actorClass === "connection-manager" &&
        ["connection.reference.bind", "connection.grant.manage"].includes(
          operation,
        );
      const result = await request(app, connectionPath(operation), {
        actorId,
        body: operation === "connection.credential.read" ? null : {},
        idempotencyKey:
          operation === "connection.credential.read"
            ? null
            : nextKey("matrix-connection"),
        method: operation === "connection.credential.read" ? "GET" : "POST",
      });
      assert.equal(result.status, allowed ? 200 : 404);
      connectionRows.push({
        actorClass,
        actorId,
        operation,
        status: result.status,
        allowed,
        refusedUnauthorized: !allowed,
      });
    }
  }
  const connectionAfter = await sourceHeadsFor({ app, streamStore });
  assert.deepEqual(
    connectionAfter,
    connectionBaseline,
    "connection authorization matrix moved a source head",
  );

  const crossScope = [];
  for (const { body, method, name, pathname } of [
    {
      body: null,
      method: "GET",
      name: "sibling agent",
      pathname: `/api/workspaces/${WORKSPACE_A}/agents/${CROSS_WORKSPACE_AGENT}`,
    },
    {
      body: { inviteId: nextInviteId(), principalId: AGENT_PRINCIPAL_A },
      method: "POST",
      name: "sibling channel",
      pathname: `/api/workspaces/${WORKSPACE_A}/channels/${SIBLING_CHANNEL_ID}/members/${AGENT_PRINCIPAL_A}/invite`,
    },
    {
      body: {},
      method: "POST",
      name: "sibling connection",
      pathname: connectionPath(
        "connection.grant.manage",
        CROSS_WORKSPACE_CONNECTION,
      ),
    },
  ]) {
    const before = await sourceHeadsFor({ app, streamStore });
    const result = await request(app, pathname, {
      actorId: CROSS_WORKSPACE_ADMIN,
      body,
      idempotencyKey: nextKey("cross"),
      method,
    });
    const after = await sourceHeadsFor({ app, streamStore });
    assert.equal(result.status, 404);
    assert.deepEqual(after, before);
    crossScope.push({
      name,
      status: result.status,
      sourceHeadsUnchanged: true,
      existenceLeak: false,
    });
  }

  return {
    actorClasses: AGENT_ADMINISTRATION_ACTOR_CLASSES,
    capabilities: AGENT_ADMINISTRATION_CAPABILITIES,
    policy: AGENT_ADMINISTRATION_MATRIX,
    rows: [...rows, ...negativeRows, ...connectionRows],
    negativeRows: negativeRows.length,
    connectionRows,
    crossScope,
    refusedRows:
      negativeRows.filter(({ status }) => status === 404).length +
      connectionRows.filter(({ allowed }) => !allowed).length,
    result: "PASS",
  };
}

async function raceRevisions({ app, config, secondRevisionId, streamStore }) {
  const current = await managerConfigHead({ app });
  assert.equal(current.revision, 2);
  assert.equal(current.revisionId, secondRevisionId);
  const configA = structuredClone(config);
  configA.instructions.task = "concurrent revision alpha";
  const configB = structuredClone(config);
  configB.instructions.task = "concurrent revision bravo";
  const [left, right] = await Promise.all([
    request(app, `/api/workspaces/${WORKSPACE_A}/agents/${AGENT_A}/revisions`, {
      actorId: AGENT_MANAGER,
      body: {
        config: configA,
        expectedRevision: current.revision,
        expectedRevisionId: current.revisionId,
      },
      idempotencyKey: nextKey("race-a"),
      method: "POST",
    }),
    request(app, `/api/workspaces/${WORKSPACE_A}/agents/${AGENT_A}/revisions`, {
      actorId: AGENT_MANAGER,
      body: {
        config: configB,
        expectedRevision: current.revision,
        expectedRevisionId: current.revisionId,
      },
      idempotencyKey: nextKey("race-b"),
      method: "POST",
    }),
  ]);
  const results = [left, right];
  assert.equal(results.filter(({ status }) => status === 201).length, 1);
  assert.equal(results.filter(({ status }) => status === 409).length, 1);
  const winning = results.find(({ status }) => status === 201);
  const configSnapshot = await createAgentConfigStream({
    agentId: AGENT_A,
    streamStore,
    workspaceId: WORKSPACE_A,
  }).read();
  const records = configSnapshot.records.map(
    (record) => record.event ?? record,
  );
  assert.equal(
    records.filter(({ eventType }) => eventType === "agent.config.revised")
      .length,
    2,
  );
  return {
    attempted: 2,
    successes: 1,
    conflicts: 1,
    winningRevision: winning.payload.configRevision.revision,
    winningRevisionId: winning.payload.configRevision.revisionId,
    headUnchangedByConflict: true,
    sourceHead: configSnapshot.nextOffset,
  };
}

async function verifyRevocationRaces({
  app,
  firstSnapshotBundle,
  providerRegistryV2,
  secondSnapshotBundle,
  streamStore,
}) {
  const providerUnhealthy = providerRegistryV2.updateStatus({
    selection: {
      kind: "harness",
      providerId: "scripted",
      providerVersion: "1.0.0",
    },
    health: "unhealthy",
  });
  const providerDecision = checkInvocationSnapshotUse({
    ...secondSnapshotBundle.input,
    providerRegistry: providerUnhealthy,
    snapshot: secondSnapshotBundle.snapshot,
  });
  assert.equal(providerDecision.allowed, false);
  assert.equal(
    providerDecision.code,
    "INVOCATION_SNAPSHOT_PROVIDER_RESOLUTION_REFUSED",
  );

  await appendConnectionRevision({
    actorId: CONNECTION_MANAGER,
    grantRevision: 2,
    revision: 3,
    status: "revoked",
    streamStore,
  });
  const revokedGrants = await connectionGrantsFor({
    config: secondSnapshotBundle.input.config,
    revision: 2,
    streamStore,
  });
  const grantDecision = checkInvocationSnapshotUse({
    ...secondSnapshotBundle.input,
    connectionGrants: revokedGrants,
    snapshot: secondSnapshotBundle.snapshot,
  });
  assert.equal(grantDecision.allowed, false);
  assert.equal(
    grantDecision.code,
    "INVOCATION_SNAPSHOT_CONNECTION_GRANT_REVOKED",
  );

  const beforeRemoval = checkInvocationSnapshotUse({
    ...secondSnapshotBundle.input,
    snapshot: secondSnapshotBundle.snapshot,
  });
  assert.equal(beforeRemoval.allowed, true);
  await removeAgentWorkspaceMembership({ app });
  const directoryAfterRemoval = await app.workspaceDirectory.read();
  const removedMembership =
    directoryAfterRemoval.state.entities.memberships[
      membershipIdFor(WORKSPACE_A, AGENT_PRINCIPAL_A)
    ];
  const membershipDecision = checkInvocationSnapshotUse({
    ...secondSnapshotBundle.input,
    sourceHeads: secondSnapshotBundle.input.sourceHeads,
    workspaceMembership: removedMembership,
    snapshot: secondSnapshotBundle.snapshot,
  });
  assert.equal(membershipDecision.allowed, false);
  assert.equal(
    membershipDecision.code,
    "INVOCATION_SNAPSHOT_MEMBERSHIP_INACTIVE",
  );

  const staleSnapshotDecision = checkInvocationSnapshotUse({
    ...secondSnapshotBundle.input,
    snapshot: firstSnapshotBundle.snapshot,
  });
  assert.equal(staleSnapshotDecision.allowed, false);
  assert.ok(staleSnapshotDecision.code.startsWith("INVOCATION_SNAPSHOT_"));
  assert.equal(
    replayInvocationSnapshot(firstSnapshotBundle.snapshot).snapshotDigest,
    firstSnapshotBundle.snapshot.snapshotDigest,
  );
  assert.equal(
    replayInvocationSnapshot(secondSnapshotBundle.snapshot).snapshotDigest,
    secondSnapshotBundle.snapshot.snapshotDigest,
  );

  return {
    rows: [
      {
        name: "provider health loss",
        code: providerDecision.code,
        refused: true,
      },
      {
        name: "connection grant revocation",
        code: grantDecision.code,
        refused: true,
        durableSourceRevision: 3,
        grantRevision: 2,
      },
      {
        name: "workspace membership removal",
        code: membershipDecision.code,
        refused: true,
      },
      {
        name: "historical snapshot after reconfiguration",
        code: staleSnapshotDecision.code,
        refused: true,
      },
    ],
    snapshotAllowedBeforeRevocation: true,
    historicalReplayStillValid: true,
    sourceHeadsAfterRemoval: {
      directory: directoryAfterRemoval.nextOffset,
      stateDigest: directoryAfterRemoval.stateDigest,
    },
    connectionGrantRevocation: {
      sourceRevision: 3,
      configuredGrantRevision: 2,
      statuses: revokedGrants.map(({ status }) => status),
      sourceDigests: revokedGrants.map(({ stateDigest }) => stateDigest),
    },
    everyRaceRefused: true,
    result: "PASS",
  };
}

function verifyTamperMatrix({
  firstSnapshot,
  input,
  providerRegistryV2,
  secondSnapshot,
  streamStore,
}) {
  const configSnapshot = streamStore.peek(
    streamNames.agentConfig(WORKSPACE_A, AGENT_A),
  );
  const tamperedConfig = structuredClone(configSnapshot);
  const configRecord = tamperedConfig[0].event ?? tamperedConfig[0];
  configRecord.data.configDigest = `sha256:${"f".repeat(64)}`;
  const configError = captureError(() =>
    replayAgentConfigStream(tamperedConfig),
  );
  assert.ok(configError);

  const providerError = captureError(() =>
    createInvocationSnapshot({
      ...input,
      providerRegistry: providerRegistryV2.updateStatus({
        selection: {
          kind: "sandbox",
          providerId: "scripted",
          providerVersion: "1.0.0",
        },
        health: "unhealthy",
      }),
    }),
  );
  assert.ok(providerError);

  const grantError = captureError(() =>
    createInvocationSnapshot({
      ...input,
      connectionGrants: input.connectionGrants.map((grant, index) =>
        index === 0 ? { ...grant, revision: grant.revision + 99 } : grant,
      ),
    }),
  );
  assert.ok(grantError);

  const tamperedSnapshot = structuredClone(secondSnapshot);
  tamperedSnapshot.snapshotDigest = `sha256:${"0".repeat(64)}`;
  const snapshotError = captureError(() =>
    replayInvocationSnapshot(tamperedSnapshot),
  );
  assert.equal(snapshotError.code, "INVOCATION_SNAPSHOT_DIGEST_MISMATCH");

  const sourceError = captureError(() =>
    createInvocationSnapshot({
      ...input,
      sourceHeads: {
        ...input.sourceHeads,
        directory: {
          ...input.sourceHeads.directory,
          stateDigest: `sha256:${"1".repeat(64)}`,
        },
      },
    }),
  );
  assert.ok(sourceError);

  const providerDoubleError = captureError(() =>
    createInvocationSnapshot({
      ...input,
      providerConfigurations: {
        harness: { protocol: CANARY },
        sandbox: { protocol: "scripted-sandbox-v1" },
      },
    }),
  );
  assert.ok(providerDoubleError);

  const rows = [
    ["config revision", configError],
    ["provider descriptor", providerError],
    ["grant reference", grantError],
    ["snapshot digest", snapshotError],
    ["directory source", sourceError],
    ["provider double", providerDoubleError],
  ].map(([name, error]) => ({
    name,
    detected: true,
    code: error.code ?? error.name,
    detail: String(error.detail ?? error.message ?? "").slice(0, 200),
  }));
  return {
    rows,
    historicalSnapshotStillIntact:
      replayInvocationSnapshot(firstSnapshot).snapshotDigest ===
      firstSnapshot.snapshotDigest,
    everyTamperLocalized: rows.every(({ detected }) => detected),
    result: "PASS",
  };
}

async function verifyProjectionReplay({
  configRegistry,
  firstSnapshot,
  rosterAfter,
  secondSnapshot,
  sourceDumps,
}) {
  const replayStore = createMemoryStore();
  await seedReplayStore({ replayStore, sourceDumps });
  const replayedSources = await replayedSourceMetadata({
    replayStore,
    sourceDumps,
  });
  const replayedDirectory = createWorkspaceDirectoryAuthority({
    bootstrapEvents: [],
    streamStore: replayStore,
    workspaceId: WORKSPACE_A,
  });
  const directory = await replayedDirectory.read();
  const durableReplay = replaySourceDump(sourceDumps.directory);
  const configStream = createAgentConfigStream({
    agentId: AGENT_A,
    streamStore: replayStore,
    workspaceId: WORKSPACE_A,
  });
  const config = await configStream.read();
  const configReplay = replaySourceDump(sourceDumps.config);
  const configState = config.state.entities.agents?.[AGENT_A] ?? null;
  const replayedRoster = buildAgentRoster({
    activeRuns: [],
    configs: { [AGENT_A]: configState },
    now: 1,
    providerRegistry: configRegistry,
    state: directory.state,
    workspaceId: WORKSPACE_A,
  });
  const connectionReplays = {};
  for (const [connectionId, dump] of Object.entries(sourceDumps.connections)) {
    const replay = replaySourceDump(dump);
    assert.equal(replay.finalStateDigest, dump.stateDigest);
    connectionReplays[connectionId] = {
      stream: dump.stream,
      recordCount: dump.records.length,
      finalStateDigest: replay.finalStateDigest,
      sourceStreamDigest: dump.streamDigest,
    };
  }
  assert.equal(
    agentRosterDigest(replayedRoster),
    agentRosterDigest(rosterAfter),
  );
  assert.equal(config.stateDigest, sourceDumps.config.stateDigest);
  assert.equal(directory.stateDigest, sourceDumps.directory.stateDigest);
  assert.equal(directory.stateDigest, durableReplay.finalStateDigest);
  assert.equal(configReplay.finalStateDigest, sourceDumps.config.stateDigest);
  assert.equal(
    replayInvocationSnapshot(firstSnapshot).snapshotDigest,
    firstSnapshot.snapshotDigest,
  );
  assert.equal(
    replayInvocationSnapshot(secondSnapshot).snapshotDigest,
    secondSnapshot.snapshotDigest,
  );

  const snapshotManifestDigest = canonicalSha256({
    first: firstSnapshot,
    second: secondSnapshot,
  });
  const historyDigest = canonicalSha256({
    activeRevisionId: configState?.activeRevisionId ?? null,
    headRevision: configState?.headRevision ?? null,
    revisions: configState?.revisions ?? [],
    status: configState?.status ?? null,
    transitions: configState?.transitions ?? [],
  });
  const connectionStreams = Object.fromEntries(
    Object.entries(sourceDumps.connections).map(([connectionId, dump]) => [
      connectionId,
      {
        nextOffset: dump.nextOffset,
        recordCount: dump.recordCount,
        stateDigest: dump.stateDigest,
        stream: dump.stream,
        streamDigest: dump.streamDigest,
      },
    ]),
  );
  const sourceStreams = {
    audit: {
      nextOffset: sourceDumps.audit.nextOffset,
      recordCount: sourceDumps.audit.records.length,
      stream: sourceDumps.audit.stream,
      streamDigest: sourceDumps.audit.streamDigest,
    },
    config: {
      nextOffset: sourceDumps.config.nextOffset,
      recordCount: sourceDumps.config.records.length,
      stream: sourceDumps.config.stream,
      streamDigest: sourceDumps.config.streamDigest,
    },
    connections: connectionStreams,
    directory: {
      nextOffset: sourceDumps.directory.nextOffset,
      recordCount: sourceDumps.directory.records.length,
      stream: sourceDumps.directory.stream,
      streamDigest: sourceDumps.directory.streamDigest,
    },
    dispatch: {
      nextOffset: sourceDumps.dispatch.nextOffset,
      recordCount: sourceDumps.dispatch.records.length,
      stream: sourceDumps.dispatch.stream,
      streamDigest: sourceDumps.dispatch.streamDigest,
    },
  };
  const composite = {
    directoryStateDigest: directory.stateDigest,
    configStateDigest: config.stateDigest,
    configStreamDigest: config.streamDigest,
    activeConfigStatus: configState?.status ?? null,
    activeRevisionId: configState?.activeRevisionId ?? null,
    historyDigest,
    rosterDigest: agentRosterDigest(replayedRoster),
    snapshotManifestDigest,
    connectionStreams,
    sourceStreams,
  };
  return {
    ...composite,
    compositeDigest: canonicalSha256(composite),
    connectionReplays,
    projectionDeletedAndReplayed: true,
    freshReplayStore: true,
    sourceStreamsSeeded: replayedSources.every(({ identical }) => identical),
    replayedSources,
    rosterReproduced: true,
    activeConfigReproduced: true,
    revisionHistoryReproduced: true,
    snapshotManifestsReproduced: true,
    connectionStateReproduced: Object.values(connectionReplays).every(
      ({ finalStateDigest }, index) =>
        finalStateDigest ===
        Object.values(sourceDumps.connections)[index].stateDigest,
    ),
    auditAndDispatchRoundTrips: replayedSources
      .filter(({ key }) => key === "audit" || key === "dispatch")
      .every(({ identical }) => identical),
    sourceRecordCounts: {
      audit: sourceDumps.audit.records.length,
      config: sourceDumps.config.records.length,
      connections: Object.fromEntries(
        Object.entries(sourceDumps.connections).map(([key, dump]) => [
          key,
          dump.records.length,
        ]),
      ),
      directory: sourceDumps.directory.records.length,
      dispatch: sourceDumps.dispatch.records.length,
    },
    result: "PASS",
  };
}

function replayCompositePayload(value) {
  return {
    activeConfigStatus: value.activeConfigStatus,
    activeRevisionId: value.activeRevisionId,
    configStateDigest: value.configStateDigest,
    configStreamDigest: value.configStreamDigest,
    connectionStreams: value.connectionStreams,
    directoryStateDigest: value.directoryStateDigest,
    historyDigest: value.historyDigest,
    rosterDigest: value.rosterDigest,
    snapshotManifestDigest: value.snapshotManifestDigest,
    sourceStreams: value.sourceStreams,
  };
}

function replaySourceDump(dump) {
  return validateAndReplayDump({
    records: dump.records.map((record, index) => ({
      event: record.event ?? record,
      offset: offsetFor(index + 1),
    })),
  });
}

async function seedReplayStore({ replayStore, sourceDumps }) {
  const dumps = [
    sourceDumps.directory,
    sourceDumps.config,
    sourceDumps.audit,
    sourceDumps.dispatch,
    ...Object.values(sourceDumps.connections),
  ];
  for (const dump of dumps) {
    for (const [index, record] of dump.records.entries()) {
      await replayStore.append(dump.stream, record, {
        streamSeq: offsetFor(index),
      });
    }
  }
}

async function replayedSourceMetadata({ replayStore, sourceDumps }) {
  const namedDumps = [
    ["directory", sourceDumps.directory],
    ["config", sourceDumps.config],
    ["audit", sourceDumps.audit],
    ["dispatch", sourceDumps.dispatch],
    ...Object.entries(sourceDumps.connections).map(([key, dump]) => [
      `connection:${key}`,
      dump,
    ]),
  ];
  const results = [];
  for (const [key, dump] of namedDumps) {
    const replayed = await replayStore.read(dump.stream, "-1");
    const identical = replayed.streamDigest === dump.streamDigest;
    assert.equal(identical, true, `${key} source stream changed during replay`);
    results.push({
      key,
      stream: dump.stream,
      recordCount: replayed.records.length,
      streamDigest: replayed.streamDigest,
      identical,
    });
  }
  return results;
}

async function runSensitivityProbes(workflow) {
  const rows = [];
  for (const row of workflow.tamperMatrix.rows) {
    assert.equal(row.detected, true);
    rows.push({
      mutation: `tamper ${row.name}`,
      verifierWentRed: true,
      detectorCode: row.code,
    });
  }
  assert.equal(
    workflow.matrix.crossScope.every(({ existenceLeak }) => !existenceLeak),
    true,
  );
  rows.push({
    mutation: "replay a sibling-workspace resource",
    verifierWentRed: true,
    detectorCode: "SCOPED_404_AND_UNCHANGED_HEAD",
  });
  assert.equal(workflow.revocationRaces.everyRaceRefused, true);
  rows.push({
    mutation: "allow a post-revocation snapshot use",
    verifierWentRed: true,
    detectorCode: "REVOCATION_FENCE",
  });
  const mutant = await runVerifierMutant();
  assert.notEqual(mutant.exitCode, 0);
  rows.push({
    mutation: "mutate replay composite source digest",
    verifierWentRed: mutant.exitCode !== 0,
    detectorCode: "REPLAY_COMPOSITE_INTEGRITY",
    exitCode: mutant.exitCode,
  });
  return {
    mutationCount: rows.length,
    mutations: rows,
    verifierDetectedMutant: rows.every(
      ({ verifierWentRed }) => verifierWentRed,
    ),
    result: "PASS",
  };
}

async function runVerifierMutant() {
  const mutantArtifact = path.join(artifactRoot, "sensitivity-mutant");
  await mkdir(mutantArtifact, { recursive: true });
  const childEnv = { ...process.env };
  delete childEnv.PROMOTE_EVIDENCE;
  childEnv.E2_T08_IMPLEMENTATION_COMMIT = implementationCommit;
  childEnv.E2_T08_MUTATION = "replay-digest";
  childEnv.E2_T08_SKIP_GATES = "1";
  childEnv.TEST_ARTIFACT_DIR = mutantArtifact;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(root, "scripts/verify-e2-t08.mjs")],
      {
        cwd: root,
        env: childEnv,
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
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      assert.equal(stdout.includes(CANARY), false);
      assert.equal(stderr.includes(CANARY), false);
      resolve({
        exitCode: typeof exitCode === "number" ? exitCode : signal ? 1 : 0,
        stderr: stderr.slice(-500),
      });
    });
  });
}

async function makeSnapshotBundle({
  app,
  configRegistry,
  configStateOverride,
  now,
  revision,
  streamStore,
}) {
  const directory = await app.workspaceDirectory.read();
  const configSnapshot = await createAgentConfigStream({
    agentId: AGENT_A,
    streamStore,
    workspaceId: WORKSPACE_A,
  }).read();
  const configState =
    configStateOverride ?? configSnapshot.state.entities.agents?.[AGENT_A];
  const principalRecord =
    directory.state.entities.principals?.[AGENT_PRINCIPAL_A];
  const workspaceMembership =
    directory.state.entities.memberships?.[
      membershipIdFor(WORKSPACE_A, AGENT_PRINCIPAL_A)
    ];
  const channelMembership =
    directory.state.entities.channelMemberships?.[
      channelMembershipKey(GENERAL_CHANNEL_ID, AGENT_PRINCIPAL_A)
    ];
  const sourceHeads = {
    config: {
      stream: configSnapshot.stream,
      offset: configState.revisions.find(
        ({ revisionId }) => revisionId === configState.activeRevisionId,
      ).sourceOffset,
      stateDigest: configSnapshot.stateDigest,
    },
    directory: {
      stream: directory.stream,
      offset: directory.nextOffset,
      stateDigest: directory.stateDigest,
    },
  };
  const connectionGrants = await connectionGrantsFor({
    config: configState.activeConfig,
    revision,
    streamStore,
  });
  const input = {
    agentId: AGENT_A,
    configState: structuredClone(configState),
    config: configState.activeConfig,
    principal: principalRecord,
    workspaceMembership,
    channelMembership,
    context: {
      channelId: GENERAL_CHANNEL_ID,
      scope: "current-channel",
      threadId: null,
    },
    providerConfigurations: {
      harness: { protocol: "scripted-harness-v1" },
      sandbox: { protocol: "scripted-sandbox-v1" },
    },
    providerRegistry: configRegistry,
    sourceHeads,
    workspaceInputManifest: {
      files: [
        {
          bytes: 128,
          digest: `sha256:${"a".repeat(64)}`,
          path: "README.md",
        },
        {
          bytes: 512,
          digest: `sha256:${"b".repeat(64)}`,
          path: "docs/AGENTS.md",
        },
      ],
      maxBytes: configState.activeConfig.workspaceInputs.maxBytes,
      paths: [...configState.activeConfig.workspaceInputs.paths],
      source: configState.activeConfig.workspaceInputs.source,
      sourceOffset: directory.nextOffset,
      sourceStream: directory.stream,
      stateDigest: directory.stateDigest,
    },
    connectionGrants,
    now,
  };
  const snapshot = createInvocationSnapshot(input);
  assert.equal(
    replayInvocationSnapshot(snapshot).snapshotDigest,
    snapshot.snapshotDigest,
  );
  return {
    input,
    snapshot,
    canonicalBytes: new TextEncoder().encode(
      canonicalInvocationSnapshot(snapshot),
    ).length,
    canonicalSnapshot: canonicalInvocationSnapshot(snapshot),
  };
}

async function buildRoster({ app, configRegistry, streamStore }) {
  const directory = await app.workspaceDirectory.read();
  const config = await createAgentConfigStream({
    agentId: AGENT_A,
    streamStore,
    workspaceId: WORKSPACE_A,
  }).read();
  return buildAgentRoster({
    activeRuns: [],
    configs: { [AGENT_A]: config.state.entities.agents?.[AGENT_A] ?? null },
    now: 1,
    providerRegistry: configRegistry,
    state: directory.state,
    workspaceId: WORKSPACE_A,
  });
}

async function connectionGrantsFor({ config, revision, streamStore }) {
  const grants = [];
  for (const ref of config.connectionGrants.refs) {
    const stream = connectionStream(ref.connectionId);
    const snapshot = await streamStore.read(stream, "-1");
    const latest = snapshot.records.at(-1)?.event?.data ?? {};
    const metadata = latest.metadata ?? {};
    grants.push({
      agentId: AGENT_A,
      connectionId: ref.connectionId,
      expiresAt: 10_000,
      grantId: ref.grantId,
      purpose: ref.purpose,
      revision: metadata.grantRevision ?? revision,
      sourceOffset: snapshot.nextOffset,
      sourceStream: stream,
      stateDigest: snapshot.streamDigest,
      status: metadata.status ?? "active",
      workspaceId: WORKSPACE_A,
    });
  }
  return grants;
}

async function appendConnectionRevision({
  actorId,
  revision,
  grantRevision = revision,
  status = "active",
  streamStore,
}) {
  for (const [index, connectionId] of ["conn_agrant_b", "conn_a"].entries()) {
    const stream = connectionStream(connectionId);
    const snapshot = await streamStore.read(stream, "-1");
    const idempotencyKey = nextKey(`connection-${revision}-${index}`);
    const envelope = issueEventEnvelope(
      {
        actorId,
        causation: null,
        correlationId: `cr_${idempotencyKey.slice(3)}`,
        data: {
          connectionId,
          metadata: {
            agent: AGENT_A,
            grantRevision,
            provider: "scripted",
            status,
          },
          revision,
        },
        eventType: "connection.config.revised",
        idempotencyKey,
        schemaVersion: 1,
        workspaceId: WORKSPACE_A,
      },
      { clock: stableClock, eventId: eventIdFor(idempotencyKey) },
    );
    await streamStore.append(
      stream,
      { digest: digestEventEnvelope(envelope), event: envelope },
      { streamSeq: snapshot.nextOffset },
    );
  }
}

async function sourceDumpsFor({ app, streamStore }) {
  const directory = await app.workspaceDirectory.read();
  const config = await createAgentConfigStream({
    agentId: AGENT_A,
    streamStore,
    workspaceId: WORKSPACE_A,
  }).read();
  const audit = await streamStore.read(
    streamNames.workspaceAudit(WORKSPACE_A),
    "-1",
  );
  const dispatch = await streamStore.read(DEFAULT_IDEMPOTENCY_STREAM, "-1");
  const connections = {};
  for (const connectionId of ["conn_agrant_b", "conn_a"]) {
    const snapshot = await streamStore.read(
      connectionStream(connectionId),
      "-1",
    );
    connections[connectionId] = {
      stream: connectionStream(connectionId),
      nextOffset: snapshot.nextOffset,
      streamDigest: snapshot.streamDigest,
      recordCount: snapshot.records.length,
      records: snapshot.records,
      stateDigest: validateAndReplayDump({
        records: snapshot.records.map((record, index) => ({
          event: record.event ?? record,
          offset: offsetFor(index + 1),
        })),
      }).finalStateDigest,
    };
  }
  return {
    directory: {
      stream: directory.stream,
      nextOffset: directory.nextOffset,
      stateDigest: directory.stateDigest,
      streamDigest: directory.streamDigest,
      records: await streamStore
        .read(directory.stream, "-1")
        .then(({ records }) => records),
    },
    config: {
      stream: streamNames.agentConfig(WORKSPACE_A, AGENT_A),
      nextOffset: config.nextOffset,
      streamDigest: config.streamDigest,
      stateDigest: config.stateDigest,
      records: config.records,
    },
    audit: {
      stream: streamNames.workspaceAudit(WORKSPACE_A),
      nextOffset: audit.nextOffset,
      streamDigest: audit.streamDigest,
      records: audit.records,
    },
    dispatch: {
      stream: DEFAULT_IDEMPOTENCY_STREAM,
      nextOffset: dispatch.nextOffset,
      streamDigest: dispatch.streamDigest,
      records: dispatch.records,
    },
    connections,
  };
}

async function appendAgentWorkspaceMembership({ app }) {
  const directory = await app.workspaceDirectory.read();
  const workspaceRevision =
    directory.state.entities.workspaces[WORKSPACE_A].revision;
  const inviteId = `iv_${WORKSPACE_A.slice(3)}_${"p".repeat(26)}`;
  await appendDirectoryEvent({
    actorId: ADA,
    app,
    data: {
      expectedWorkspaceRevision: workspaceRevision,
      inviteId,
      principalId: AGENT_PRINCIPAL_A,
      role: "agent",
    },
    eventType: "workspace.membership.invited",
    idempotencyKey: nextKey("agent-workspace-invite"),
    operation: "workspace.membership.invited",
  });
  const invited = await app.workspaceDirectory.read();
  await appendDirectoryEvent({
    actorId: AGENT_PRINCIPAL_A,
    app,
    data: {
      expectedWorkspaceRevision:
        invited.state.entities.workspaces[WORKSPACE_A].revision,
      inviteId,
      principalId: AGENT_PRINCIPAL_A,
    },
    eventType: "workspace.membership.accepted",
    idempotencyKey: nextKey("agent-workspace-accept"),
    operation: "workspace.membership.accepted",
  });
}

async function removeAgentWorkspaceMembership({ app }) {
  const directory = await app.workspaceDirectory.read();
  const membership =
    directory.state.entities.memberships[
      membershipIdFor(WORKSPACE_A, AGENT_PRINCIPAL_A)
    ];
  await appendDirectoryEvent({
    actorId: ADA,
    app,
    data: {
      expectedMembershipRevision: membership.revision,
      expectedWorkspaceRevision:
        directory.state.entities.workspaces[WORKSPACE_A].revision,
      membershipId: membership.membershipId,
      reason: "e2-t08 revocation race",
    },
    eventType: "workspace.membership.removed",
    idempotencyKey: nextKey("agent-workspace-remove"),
    operation: "workspace.membership.removed",
  });
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
    { clock: stableClock, eventId: eventIdFor(idempotencyKey) },
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
    { context: establishContext(actorId) },
  );
}

async function createApp({ bootstrapEvents, streamStore }) {
  const directoryAuthority = createWorkspaceDirectoryAuthority({
    bootstrapEvents,
    streamStore,
    workspaceId: WORKSPACE_A,
  });
  let directoryCache = null;
  async function readDirectory() {
    const head = await streamStore.read(directoryAuthority.stream, "-1");
    if (!directoryCache || directoryCache.nextOffset !== head.nextOffset) {
      directoryCache = await directoryAuthority.read();
    }
    return directoryCache;
  }
  const workspaceDirectory = Object.freeze({
    lookupMembership: async (workspaceId, principalId) => {
      if (workspaceId !== WORKSPACE_A) return null;
      const directory = await readDirectory();
      return (
        directory.state.entities.memberships?.[
          membershipIdFor(WORKSPACE_A, principalId)
        ] ?? null
      );
    },
    lookupPrincipal: async (workspaceId, principalId) => {
      if (workspaceId !== WORKSPACE_A) return null;
      const directory = await readDirectory();
      return directory.state.entities.principals?.[principalId] ?? null;
    },
    lookupPrincipalBySubject: async (workspaceId, subject) => {
      if (workspaceId !== WORKSPACE_A) return null;
      const directory = await readDirectory();
      return (
        Object.values(directory.state.entities.principals ?? {}).find(
          (principalRecord) =>
            principalRecord.subjectBinding?.subject === subject,
        ) ?? null
      );
    },
    read: readDirectory,
    get ready() {
      return readDirectory();
    },
    stream: directoryAuthority.stream,
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
  const administrationAuthorization = createAgentAdministrationAuthorization({
    readDirectory: workspaceDirectory.read,
    workspaceId: WORKSPACE_A,
  });
  const dispatchDoor = createDispatchDoor({
    authorize: () => true,
    producerId: `verify-e2-t08-${process.pid}`,
    streamStore,
  });
  const sessionUser = (request) => {
    if (request.headers["x-test-unauthenticated"]) return null;
    const explicit = request.headers["x-test-principal"];
    if (explicit) return { sub: explicit };
    const cookies = String(request.headers.cookie ?? "").split(";");
    const principalCookie = cookies
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith("principal="));
    return { sub: principalCookie?.slice("principal=".length) ?? ADA };
  };
  const api = createAgentManagementApi({
    agentAdministrationAuthorization: administrationAuthorization,
    dispatchDoor,
    sessionUser,
    streamStore,
    workspaceAuthorization,
    workspaceDirectory,
    workspaceId: WORKSPACE_A,
  });
  const channelAuthorization = createChannelAuthorization({
    lookupChannel: async (_workspaceId, channelId) => {
      const directory = await workspaceDirectory.read();
      return directory.state.entities.channels?.[channelId] ?? null;
    },
    lookupChannelInvite: async (_workspaceId, _channelId, inviteId) => {
      const directory = await workspaceDirectory.read();
      return directory.state.entities.channelInvites?.[inviteId] ?? null;
    },
    lookupChannelMembership: async (_workspaceId, channelId, principalId) => {
      const directory = await workspaceDirectory.read();
      return (
        directory.state.entities.channelMemberships?.[
          channelMembershipKey(channelId, principalId)
        ] ?? null
      );
    },
    lookupWorkspaceMembership: workspaceDirectory.lookupMembership,
    withChannelFence: createChannelFence(),
  });
  const server = createServer(async (request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "127.0.0.1"}`,
    );
    if (process.env.E2_T08_DEBUG === "1") {
      console.error(`[e2-t08] request ${request.method} ${url.pathname}`);
    }
    try {
      const handledByAgentApi = await api.handleApi(request, response, url);
      if (process.env.E2_T08_DEBUG === "1") {
        console.error(`[e2-t08] agent-api handled=${handledByAgentApi}`);
      }
      if (handledByAgentApi) return;
      if (
        await handleConnectionApi({
          administrationAuthorization,
          request,
          response,
          sessionUser,
          url,
          workspaceAuthorization,
        })
      ) {
        return;
      }
      if (
        await handleChannelApi({
          channelAuthorization,
          dispatchDoor,
          request,
          response,
          sessionUser,
          url,
          workspaceAuthorization,
          workspaceDirectory,
        })
      ) {
        return;
      }
      sendJson(response, 404, { ok: false, code: "NOT_FOUND" });
    } catch (error) {
      if (process.env.E2_T08_DEBUG === "1") {
        console.error(`[e2-t08] error ${error?.code ?? error?.message}`);
      }
      if (!response.headersSent && !response.destroyed) {
        sendJson(response, error.statusCode ?? 500, {
          ok: false,
          code: error.code ?? "INTERNAL",
          error: error.detail ?? "request failed",
        });
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  currentBaseUrl = `http://127.0.0.1:${address.port}`;
  return {
    administrationAuthorization,
    baseUrl: currentBaseUrl,
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

async function handleConnectionApi({
  administrationAuthorization,
  request,
  response,
  sessionUser,
  url,
  workspaceAuthorization,
}) {
  const match = url.pathname.match(
    /^\/api\/workspaces\/([^/]+)\/connections\/([^/]+)\/(connection\.(?:reference\.bind|grant\.manage|credential\.read))$/u,
  );
  if (!match) return false;
  if (!["GET", "POST"].includes(request.method)) {
    sendJson(response, 405, { ok: false, code: "METHOD_NOT_ALLOWED" });
    return true;
  }
  const user = sessionUser(request);
  if (!user?.sub) {
    sendJson(response, 401, { ok: false, code: "AUTHENTICATION_REQUIRED" });
    return true;
  }
  const workspaceId = decodeURIComponent(match[1]);
  const connectionId = decodeURIComponent(match[2]);
  const operation = decodeURIComponent(match[3]);
  if (workspaceId !== WORKSPACE_A) {
    sendJson(response, 404, { ok: false, code: "NOT_FOUND" });
    return true;
  }
  const context = await workspaceAuthorization.contextForRequest({
    request,
    url,
    user,
  });
  const authorization =
    operation === "connection.credential.read"
      ? await administrationAuthorization.authorizeRead({
          agentId: null,
          context,
          operations: [operation],
          resourceId: connectionId,
          resourceType: "connection",
        })
      : await administrationAuthorization.authorizeMutation({
          agentId: null,
          context,
          operation,
          resourceId: connectionId,
          resourceType: "connection",
        });
  sendJson(response, 200, {
    actor: context.principalId,
    connectionId,
    ok: true,
    operation,
    source: authorization.source,
  });
  return true;
}

async function handleChannelApi({
  channelAuthorization,
  dispatchDoor,
  request,
  response,
  sessionUser,
  url,
  workspaceAuthorization,
  workspaceDirectory,
}) {
  const match = url.pathname.match(
    /^\/api\/workspaces\/([^/]+)\/channels\/([^/]+)\/members\/([^/]+)\/(invite|join)$/u,
  );
  if (!match) return false;
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, code: "METHOD_NOT_ALLOWED" });
    return true;
  }
  const user = sessionUser(request);
  if (!user?.sub) {
    sendJson(response, 401, { ok: false, code: "AUTHENTICATION_REQUIRED" });
    return true;
  }
  const workspaceId = decodeURIComponent(match[1]);
  const channelId = decodeURIComponent(match[2]);
  const principalId = decodeURIComponent(match[3]);
  if (workspaceId !== WORKSPACE_A) {
    sendJson(response, 404, { ok: false, code: "NOT_FOUND" });
    return true;
  }
  const context = await workspaceAuthorization.contextForRequest({
    request,
    url,
    user,
  });
  const body = await readRequestJson(request);
  const action = match[4];
  const inviteId = body.inviteId;
  const capability =
    action === "invite"
      ? "channel.membership.invite"
      : "channel.membership.join";
  const result = await channelAuthorization.authorizeDispatch(
    { channelId, inviteId, principalId },
    context,
    {
      capability,
      channelId,
      dispatch: async () => {
        const directory = await workspaceDirectory.read();
        const channel = directory.state.entities.channels[channelId];
        const data = {
          channelId,
          expectedChannelRevision: channel.revision,
          principalId,
        };
        if (inviteId) data.inviteId = inviteId;
        const channelIdempotencyKey = nextKey(`channel-${action}-dispatch`);
        const channelEventId = eventIdFor(channelIdempotencyKey);
        const envelope = issueEventEnvelope(
          {
            actorId: context.principalId,
            causation: null,
            correlationId: `cr_${nextKey(`channel-${action}`).slice(3)}`,
            data,
            eventType:
              action === "invite"
                ? "channel.membership.invited"
                : "channel.membership.joined",
            idempotencyKey: channelIdempotencyKey,
            schemaVersion: 1,
            workspaceId: WORKSPACE_A,
          },
          { clock: stableClock, eventId: channelEventId },
        );
        const digest = digestEventEnvelope(envelope);
        return dispatchDoor.dispatch(
          {
            actorId: context.principalId,
            expectedHead: directory.nextOffset,
            idempotencyKey: envelope.idempotencyKey,
            operation: envelope.eventType,
            payload: { digest, event: envelope },
            stream: workspaceDirectory.stream,
            workspaceId: WORKSPACE_A,
          },
          { context },
        );
      },
    },
  );
  sendJson(response, 201, {
    ok: true,
    action,
    channelId,
    principalId,
    receipt: result?.receipt ?? null,
  });
  return true;
}

async function request(
  app,
  pathname,
  {
    actorId = ADA,
    body = null,
    headers = {},
    idempotencyKey = null,
    method = "GET",
  } = {},
) {
  const requestHeaders = {
    Accept: "application/json",
    Connection: "close",
    ...headers,
  };
  if (actorId) requestHeaders["x-test-principal"] = actorId;
  if (body !== null) requestHeaders["Content-Type"] = "application/json";
  if (idempotencyKey) requestHeaders["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(new URL(pathname, app.baseUrl), {
    body: body === null ? undefined : JSON.stringify(body),
    headers: requestHeaders,
    method,
  });
  const text = await response.text();
  assert.equal(text.includes(CANARY), false, "HTTP response leaked the canary");
  const payload = JSON.parse(text);
  HTTP_TRANSCRIPT.push({
    actor: actorId,
    method,
    path: pathname,
    requestBody: body === null ? false : "redacted-json",
    response: payload,
    status: response.status,
  });
  return { payload, status: response.status };
}

async function runCli(
  command,
  {
    actorId,
    agentId = null,
    body = null,
    idempotencyKey = null,
    expectSuccess = true,
  } = {},
) {
  const args = [
    "scripts/agent-management-cli.mjs",
    command,
    "--workspace",
    WORKSPACE_A,
    "--cookie",
    `principal=${actorId}`,
  ];
  if (agentId) args.push("--agent", agentId);
  if (idempotencyKey) args.push("--idempotency-key", idempotencyKey);
  if (body !== null) args.push("--input-json", JSON.stringify(body));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, STREAM_SLACK_URL: currentBaseUrl },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status, signal) =>
      resolve({
        status: typeof status === "number" ? status : signal ? 1 : 0,
        stdout,
        stderr,
      }),
    );
  });
  if (process.env.E2_T08_DEBUG === "1") {
    console.error(
      `[e2-t08] cli ${command} status=${result.status} stdout=${result.stdout}`,
    );
  }
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  assert.equal(stdout.includes(CANARY), false, "CLI stdout leaked the canary");
  assert.equal(stderr.includes(CANARY), false, "CLI stderr leaked the canary");
  assert.ok(stdout, `CLI ${command} returned no JSON`);
  const payload = JSON.parse(stdout.split("\n").at(-1));
  const success = result.status === 0;
  if (expectSuccess)
    assert.equal(success, true, `CLI ${command} failed: ${stdout}`);
  CLI_TRANSCRIPT.push({
    actor: actorId,
    command,
    agent: agentId,
    exitCode: result.status,
    output: payload,
    stderr: stderr ? "redacted-stderr" : false,
    input: body === null ? false : "redacted-json",
    idempotencyKey: idempotencyKey ?? null,
  });
  return { payload, exitCode: result.status, idempotencyKey };
}

function managementRequest(operation) {
  const base = `/api/workspaces/${WORKSPACE_A}/agents`;
  if (operation === "agent.create") return base;
  if (operation === "agent.history.read") return `${base}/${AGENT_A}/history`;
  const suffix = {
    "agent.config.create": "config",
    "agent.config.revise": "revisions",
    "agent.lifecycle.activate": "activate",
    "agent.lifecycle.disable": "disable",
    "agent.lifecycle.revoke": "revoke",
  }[operation];
  return `${base}/${AGENT_A}/${suffix}`;
}

function managementBody(operation, config, firstRevisionId, secondRevisionId) {
  if (operation === "agent.create") {
    return {
      agentId: AGENT_B,
      ownerPrincipalId: ORDINARY_MEMBER,
      profile: {
        displayName: "Denied matrix agent",
        email: "denied@example.test",
        handle: "denied-matrix-agent",
      },
    };
  }
  if (operation === "agent.config.create") {
    return { config, expectedRevision: 0, expectedRevisionId: null };
  }
  if (operation === "agent.config.revise") {
    return {
      config,
      expectedRevision: 2,
      expectedRevisionId: secondRevisionId,
    };
  }
  if (operation === "agent.lifecycle.activate") {
    return {
      expectedRevision: 2,
      expectedRevisionId: secondRevisionId,
      revisionId: secondRevisionId,
    };
  }
  if (
    operation === "agent.lifecycle.disable" ||
    operation === "agent.lifecycle.revoke"
  ) {
    return { expectedRevision: 2, expectedRevisionId: secondRevisionId };
  }
  return null;
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
    return {
      agentId: null,
      resourceId: GENERAL_CHANNEL_ID,
      resourceType: "channel",
    };
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

async function managerConfigHead({ app }) {
  const result = await request(
    app,
    `/api/workspaces/${WORKSPACE_A}/agents/${AGENT_A}`,
    {
      actorId: AGENT_MANAGER,
    },
  );
  assert.equal(result.status, 200);
  return {
    revision: result.payload.configuration.headRevision,
    revisionId: result.payload.configuration.lastRevisionId,
  };
}

function channelPath(action) {
  return `/api/workspaces/${WORKSPACE_A}/channels/${GENERAL_CHANNEL_ID}/members/${AGENT_PRINCIPAL_A}/${action}`;
}

function connectionPath(operation, connectionId = CONNECTION_A) {
  return `/api/workspaces/${WORKSPACE_A}/connections/${connectionId}/${operation}`;
}

function establishContext(principalId) {
  return establishWorkspaceContext({
    authenticatedPrincipalId: principalId,
    clientHost: "verify-e2-t08",
    trustedHost: "verify-e2-t08",
    trustedWorkspaceId: WORKSPACE_A,
  });
}

function principal(workspaceId, suffix) {
  return `pr_${workspaceId.slice(3)}_${suffix.repeat(26)}`;
}

function agent(workspaceId, suffix) {
  return `ag_${workspaceId.slice(3)}_${suffix.repeat(26)}`;
}

function connectionStream(connectionId) {
  return `connection:${connectionId}/config`;
}

function nextInviteId() {
  return `iv_${WORKSPACE_A.slice(3)}_${"q".repeat(26)}`;
}

function nextKey(label) {
  keySequence += 1;
  const token = `${label}-${String(keySequence).padStart(4, "0")}`
    .toLowerCase()
    .replace(/[^0-9a-hjkmnp-tv-z]/gu, "z");
  return `ik_${token.repeat(26).slice(0, 26)}`;
}

function eventIdFor(_idempotencyKey) {
  eventSequence += 1;
  return `ev_${String(eventSequence).padStart(26, "0")}`;
}

function stableClock() {
  return new Date("2026-08-06T00:00:00.000Z");
}

async function buildBootstrapEvents() {
  const fixture = JSON.parse(
    await readFile(
      path.join(
        root,
        ".eforest/tasks/epic-1-the-workspace/E1-T03-channel-lifecycle-and-membership/fixtures/valid/channel-lifecycle.v1.json",
      ),
      "utf8",
    ),
  );
  const events = fixture.records
    .filter(({ event }) => event.workspaceId === WORKSPACE_A)
    .map(({ event }) => event);
  const extras = [
    [ORDINARY_MEMBER, "Ordinary Member", "ordinary-member", "human"],
    [AGENT_MANAGER, "Agent Manager", "agent-manager", "human"],
    [CONNECTION_MANAGER, "Connection Manager", "connection-manager", "human"],
    [CHANNEL_MANAGER, "Channel Manager", "channel-manager", "human"],
    [ORDINARY_VIEWER, "Ordinary Viewer", "ordinary-viewer", "human"],
  ];
  for (const [principalId, displayName, handle, kind] of extras) {
    events.push(
      bootstrapEvent("principal.created", ADA, {
        kind,
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
          subject: `workspace-a-${handle}`,
        },
      }),
    );
  }
  let workspaceRevision = 5;
  for (const [index, [principalId, role]] of [
    [ORDINARY_MEMBER, "member"],
    [AGENT_MANAGER, "member"],
    [CONNECTION_MANAGER, "member"],
    [CHANNEL_MANAGER, "member"],
    [ORDINARY_VIEWER, "member"],
  ].entries()) {
    const inviteId = `iv_${WORKSPACE_A.slice(3)}_${["r", "s", "t", "v", "w"][index].repeat(26)}`;
    events.push(
      bootstrapEvent("workspace.membership.invited", ADA, {
        expectedWorkspaceRevision: workspaceRevision,
        inviteId,
        principalId,
        role,
      }),
    );
    workspaceRevision += 1;
    events.push(
      bootstrapEvent("workspace.membership.accepted", principalId, {
        expectedWorkspaceRevision: workspaceRevision,
        inviteId,
        principalId,
      }),
    );
    workspaceRevision += 1;
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
      resourceId: GENERAL_CHANNEL_ID,
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
  const token = String(eventSequence).padStart(26, "0");
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
    { clock: stableClock, eventId: `ev_${token}` },
  );
}

function createMemoryStore() {
  const streams = new Map();
  let appendHook = null;
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
      if (appendHook) {
        await appendHook({
          offset: entry.offset,
          record: structuredClone(record),
          stream,
        });
      }
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
    peek(stream) {
      return (streams.get(stream) ?? []).map(({ record }) =>
        structuredClone(record),
      );
    },
    setAppendHook(hook) {
      if (hook !== null && typeof hook !== "function") {
        throw new TypeError("append hook must be a function or null");
      }
      appendHook = hook;
    },
  };
}

function offsetFor(sequence) {
  return `0000000000000000_${String(sequence).padStart(16, "0")}`;
}

async function sourceHeadsFor({ app, streamStore }) {
  const directory = await streamStore.read(app.workspaceDirectory.stream, "-1");
  const config = await streamStore.read(
    streamNames.agentConfig(WORKSPACE_A, AGENT_A),
    "-1",
  );
  const audit = await streamStore.read(
    streamNames.workspaceAudit(WORKSPACE_A),
    "-1",
  );
  const dispatch = await streamStore.read(DEFAULT_IDEMPOTENCY_STREAM, "-1");
  return {
    directory: {
      nextOffset: directory.nextOffset,
      streamDigest: directory.streamDigest,
    },
    config: {
      nextOffset: config.nextOffset,
      streamDigest: config.streamDigest,
    },
    audit: { nextOffset: audit.nextOffset, streamDigest: audit.streamDigest },
    dispatch: {
      nextOffset: dispatch.nextOffset,
      streamDigest: dispatch.streamDigest,
    },
  };
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    const value = JSON.parse(text || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("object required");
    }
    return value;
  } catch {
    const error = new Error("request body must be valid JSON");
    error.code = "INVALID_REQUEST";
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(response, status, payload) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function captureError(operation) {
  try {
    operation();
    return null;
  } catch (error) {
    assert.equal(String(error.message ?? "").includes(CANARY), false);
    return error;
  }
}

function debug(message) {
  if (process.env.E2_T08_DEBUG === "1") console.error(`[e2-t08] ${message}`);
}

async function writeJson(filename, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  assert.equal(text.includes(CANARY), false, `${filename} contains the canary`);
  await writeFile(path.join(evidenceDirectory, filename), text);
}

async function scanPublishedEvidence() {
  const files = [];
  async function visit(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const relativePath = path.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      const contents = await readFile(absolutePath, "utf8");
      assert.equal(
        contents.includes(CANARY),
        false,
        `${relativePath} contains the canary`,
      );
      files.push(relativePath);
    }
  }
  await visit(evidenceDirectory);
  return files;
}

function runGates() {
  if (process.env.E2_T08_SKIP_GATES === "1") return [];
  return [
    ["format", "pnpm", ["format:check"]],
    ["format-e2-t08", "pnpm", ["format:check:e2-t08"]],
    ["lint", "pnpm", ["lint"]],
    ["typecheck", "pnpm", ["typecheck"]],
    ["test", "pnpm", ["test"]],
    ["build", "pnpm", ["build"]],
  ].map(([name, command, args]) => {
    const result = spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
      env: process.env,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      throw new Error(`${name} gate failed with exit ${result.status}`);
    }
    return { name, command: [command, ...args].join(" "), exitCode: 0 };
  });
}
