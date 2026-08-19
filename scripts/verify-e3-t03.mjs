import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  createQueueProof,
  deriveInvocationCorrelationId,
  deriveRunQueueId,
  policyDigest,
} from "@stream-slack/protocol";
import { replayRecords } from "@stream-slack/reducers";

import {
  createRunLeaseCoordinator,
  projectEligibleQueue,
  replayRunLeaseEvents,
} from "../src/ledger/run-queue.mjs";
import { canonicalSha256 } from "../src/ledger/canonical-json.mjs";
import {
  digestEventEnvelope,
  issueEventEnvelope,
} from "../src/ledger/envelope.mjs";

const WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHANNEL_ID = "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const ACTOR_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const AGENT_ID = "ag_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const CHANNEL_STREAM = `channel:${CHANNEL_ID}`;
const CONFIG_STREAM = `agent:${AGENT_ID}/config`;
const OTHER_AGENT_ID =
  "ag_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";
const OTHER_ACTOR_ID =
  "pr_bbbbbbbbbbbbbbbbbbbbbbbbbb_cccccccccccccccccccccccccc";
const OTHER_WORKSPACE_ID = "ws_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const NOW = new Date("2026-08-07T00:00:00.000Z");

const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-3-the-dispatcher/E3-T03-durable-run-queue-and-leases",
);
const runId = String(
  process.env.TEST_RUN_ID ?? `verify-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/gu, "-");
const implementationCommit = String(
  process.env.E3_T03_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
assert.match(implementationCommit, /^[0-9a-f]{40}$/u);
const promoteEvidence = process.env.PROMOTE_EVIDENCE === "1";
if (promoteEvidence) {
  assert.equal(
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    "",
    "promoted E3-T03 evidence requires a clean tracked implementation tree",
  );
}
const artifactDirectory = path.resolve(
  root,
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e3-t03", runId),
);
const evidenceDirectory = promoteEvidence
  ? path.join(taskDirectory, "evidence/e3-t03-final")
  : artifactDirectory;
await mkdir(evidenceDirectory, { recursive: true });

const fixture = buildStreamFixture(3);
const queueEvidence = await verifyQueueRebuild(fixture);
const raceEvidence = await verifyWorkerRace(fixture);
const leaseEvidence = await verifyLeaseSchedules(fixture);
const authorityEvidence = await verifyAuthorityFences(fixture);
const capabilityEvidence = await verifyCapabilityScopes(fixture);
const replayEvidence = verifyLeaseReplay(fixture, leaseEvidence.journal);
const reducerEvidence = verifyReducerIntegration(
  fixture,
  leaseEvidence.journal,
);
const sensitivityEvidence =
  process.env.E3_T03_SKIP_SENSITIVITY === "1"
    ? { result: "SKIPPED", reason: "nested mutation verifier" }
    : await verifySensitivity();

const gates = [];
if (process.env.E3_T03_SKIP_GATES !== "1") {
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
        E3_T03_IMPLEMENTATION_COMMIT: implementationCommit,
        E3_T03_SKIP_GATES: "1",
        E3_T03_SKIP_SENSITIVITY: "1",
        TEST_ARTIFACT_DIR: artifactDirectory,
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
}

const summary = {
  schemaVersion: 1,
  task: "E3-T03",
  runId,
  implementationCommit,
  implementationTreeCleanAtStart: promoteEvidence,
  result: "PASS",
  replay:
    "Replay: N/A (server queue and lease protocol) + mitigation: hundred-worker race, partition/supersession schedules, queue rebuild, and stream digests",
  replayUploadAttempted: false,
  gates,
  queue: queueEvidence,
  race: raceEvidence,
  leases: leaseEvidence,
  authority: authorityEvidence,
  capabilities: capabilityEvidence,
  replayEvidence,
  reducer: reducerEvidence,
  sensitivity: sensitivityEvidence,
};

await writeJson(
  path.join(evidenceDirectory, "queue-proof.json"),
  queueEvidence,
);
await writeJson(path.join(evidenceDirectory, "worker-race.json"), raceEvidence);
await writeJson(
  path.join(evidenceDirectory, "lease-schedules.json"),
  leaseEvidence,
);
await writeJson(
  path.join(evidenceDirectory, "authority-fences.json"),
  authorityEvidence,
);
await writeJson(
  path.join(evidenceDirectory, "capability-scopes.json"),
  capabilityEvidence,
);
await writeJson(
  path.join(evidenceDirectory, "replay-digests.json"),
  replayEvidence,
);
await writeJson(
  path.join(evidenceDirectory, "reducer-integration.json"),
  reducerEvidence,
);
await writeJson(
  path.join(evidenceDirectory, "sensitivity.json"),
  sensitivityEvidence,
);
await writeJson(
  path.join(evidenceDirectory, "verification-summary.json"),
  summary,
);

const canaryScan = await scanEvidence(evidenceDirectory);
await writeJson(path.join(evidenceDirectory, "canary-scan.json"), canaryScan);
summary.canaryScan = canaryScan;
await writeJson(
  path.join(evidenceDirectory, "verification-summary.json"),
  summary,
);
const finalCanaryScan = await scanEvidence(evidenceDirectory);
assert.equal(finalCanaryScan.leaked, false);
assert.equal(
  finalCanaryScan.evidenceFiles.includes("verification-summary.json"),
  true,
);
summary.canaryScan = finalCanaryScan;
await writeJson(
  path.join(evidenceDirectory, "canary-scan.json"),
  finalCanaryScan,
);
await writeJson(
  path.join(evidenceDirectory, "verification-summary.json"),
  summary,
);

console.log(JSON.stringify(summary, null, 2));

async function verifyQueueRebuild(fixture) {
  const first = projectEligibleQueue(fixture);
  const rebuilt = projectEligibleQueue({
    ...fixture,
    invocationRecords: [...fixture.invocationRecords].reverse(),
    runRecords: [...fixture.runRecords].reverse(),
  });
  assert.equal(first.queueDigest, rebuilt.queueDigest);
  assert.deepEqual(first.proof, rebuilt.proof);
  assert.equal(first.entries.length, 3);
  assert.deepEqual(
    first.entries.map(({ invocationId, priority }) => ({
      invocationId,
      priority,
    })),
    [
      { invocationId: fixture.ids[2].invocationId, priority: 20 },
      { invocationId: fixture.ids[1].invocationId, priority: 10 },
      { invocationId: fixture.ids[0].invocationId, priority: 0 },
    ],
  );
  const changedSource = projectEligibleQueue({
    ...fixture,
    runRecords: fixture.runRecords.map((record, index) =>
      index === 1
        ? {
            ...record,
            digest: canonicalSha256({ changed: true }),
          }
        : record,
    ),
  });
  assert.notEqual(first.queueDigest, changedSource.queueDigest);

  const coordinator = createRunLeaseCoordinator({
    actorId: ACTOR_ID,
    clock: () => NOW,
    queueProjection: first,
    tokenFactory: () => `rcap_${"q".repeat(43)}`,
    workspaceId: WORKSPACE_ID,
  });
  const forgedProof = {
    ...first.proof,
    invocationStreamDigest: canonicalSha256({ forged: true }),
  };
  forgedProof.queueDigest = queueDigestForProof(forgedProof);
  await assert.rejects(
    coordinator.acquire({
      entry: first.entries[0],
      queueProof: forgedProof,
      workerId: "proof-attacker",
    }),
    (error) => error.code === "RUN_QUEUE_QUEUE_CHANGED",
  );
  return {
    rebuiltQueueDigest: rebuilt.queueDigest,
    eligibleOrder: first.entries.map(({ invocationId }) => invocationId),
    entryDigests: first.proof.entryDigests,
    invocationStreamDigest: first.invocationStreamDigest,
    runStreamDigest: first.runStreamDigest,
    queueDigest: first.queueDigest,
    forgedProofRefused: true,
    result: "PASS",
  };
}

async function verifyWorkerRace(fixture) {
  const queue = projectEligibleQueue(fixture);
  let tokenIndex = 0;
  const coordinator = createRunLeaseCoordinator({
    actorId: ACTOR_ID,
    clock: () => NOW,
    leaseTtlMs: 10_000,
    queueProjection: queue,
    tokenFactory: () =>
      `rcap_${String(tokenIndex++).padStart(43, "r").slice(-43)}`,
    workspaceId: WORKSPACE_ID,
  });
  const results = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      coordinator
        .acquire({
          entry: queue.entries[0],
          queueProof: queue.proof,
          workerId: `race-worker-${index}`,
        })
        .then(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error }),
        ),
    ),
  );
  const winners = results.filter(({ ok }) => ok);
  const losers = results.filter(({ ok }) => !ok);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 99);
  assert.ok(losers.every(({ error }) => error.code === "RUN_QUEUE_LEASE_HELD"));
  assert.equal(coordinator.getJournal().length, 1);
  return {
    acceptedLeaseGeneration: winners[0].value.lease.leaseGeneration,
    acceptedWorker: winners[0].value.lease.workerId,
    capabilityDigest: winners[0].value.lease.capabilityDigest,
    effectiveLeaseEvents: coordinator.getJournal().length,
    loserCodes: [...new Set(losers.map(({ error }) => error.code))],
    workerCount: results.length,
    result: "PASS",
  };
}

async function verifyLeaseSchedules(fixture) {
  const queue = projectEligibleQueue(fixture);
  let tokenIndex = 0;
  const coordinator = createRunLeaseCoordinator({
    actorId: ACTOR_ID,
    clock: () => NOW,
    leaseTtlMs: 1000,
    queueProjection: queue,
    tokenFactory: () =>
      `rcap_${String(tokenIndex++).padStart(43, "s").slice(-43)}`,
    workspaceId: WORKSPACE_ID,
  });
  const entry = queue.entries[0];
  const first = await coordinator.acquire({
    entry,
    queueProof: queue.proof,
    workerId: "partitioned-worker",
  });
  await coordinator.heartbeat({
    capability: first.capability,
    now: new Date("2026-08-07T00:00:00.500Z"),
    runId: entry.runId,
  });
  let mutationCalls = 0;
  const accepted = await coordinator.mutate({
    capability: first.capability,
    mutate: ({ leaseGeneration }) => {
      mutationCalls += 1;
      return leaseGeneration;
    },
    runId: entry.runId,
  });
  assert.equal(accepted.result, 1);
  assert.equal(mutationCalls, 1);
  const expired = await coordinator.expire({
    now: new Date("2026-08-07T00:00:02.000Z"),
  });
  assert.equal(expired.length, 1);
  for (const method of ["heartbeat", "release", "mutate"]) {
    const input =
      method === "mutate"
        ? {
            capability: first.capability,
            mutate: () => "stale",
            runId: entry.runId,
          }
        : {
            capability: first.capability,
            now: new Date("2026-08-07T00:00:02.100Z"),
            runId: entry.runId,
          };
    await assert.rejects(
      coordinator[method](input),
      (error) => error.code === "RUN_QUEUE_CAPABILITY_INVALID",
    );
  }
  const second = await coordinator.acquire({
    entry,
    now: new Date("2026-08-07T00:00:02.100Z"),
    queueProof: queue.proof,
    workerId: "replacement-worker",
  });
  assert.equal(second.lease.leaseGeneration, 2);
  const journal = coordinator.getJournal();
  assert.deepEqual(
    journal.map(({ event }) => event.eventType),
    [
      "run.lease.acquired",
      "run.lease.heartbeat",
      "run.lease.expired",
      "run.lease.acquired",
    ],
  );
  assert.equal(JSON.stringify(journal).includes(first.capability), false);
  return {
    firstGeneration: first.lease.leaseGeneration,
    secondGeneration: second.lease.leaseGeneration,
    heartbeatCount: 1,
    expiredCount: expired.length,
    staleWorkerRefusals: 3,
    staleWorkerErrorCodes: [
      "RUN_QUEUE_CAPABILITY_INVALID",
      "RUN_QUEUE_CAPABILITY_INVALID",
      "RUN_QUEUE_CAPABILITY_INVALID",
    ],
    journal,
    result: "PASS",
  };
}

async function verifyAuthorityFences(fixture) {
  const queue = projectEligibleQueue(fixture);
  let agentStatus = "active";
  let workspaceStatus = "active";
  let tokenIndex = 0;
  const coordinator = createRunLeaseCoordinator({
    actorId: ACTOR_ID,
    clock: () => NOW,
    leaseTtlMs: 10_000,
    queueProjection: queue,
    resolveAuthority: () => ({
      agentStatus,
      invocationStatus: "requested",
      workspaceStatus,
    }),
    tokenFactory: () =>
      `rcap_${String(tokenIndex++).padStart(43, "t").slice(-43)}`,
    workspaceId: WORKSPACE_ID,
  });
  const entry = queue.entries[0];
  const first = await coordinator.acquire({
    entry,
    queueProof: queue.proof,
    workerId: "authority-worker",
  });
  agentStatus = "revoked";
  let callbackCalls = 0;
  await assert.rejects(
    coordinator.mutate({
      capability: first.capability,
      mutate: () => {
        callbackCalls += 1;
      },
      runId: entry.runId,
    }),
    (error) => error.code === "RUN_QUEUE_AUTHORITY_REVOKED",
  );
  assert.equal(callbackCalls, 0);
  agentStatus = "active";
  const second = await coordinator.acquire({
    entry,
    queueProof: queue.proof,
    workerId: "agent-replacement",
  });
  workspaceStatus = "suspended";
  await assert.rejects(
    coordinator.mutate({
      capability: second.capability,
      mutate: () => {
        callbackCalls += 1;
      },
      runId: entry.runId,
    }),
    (error) => error.code === "RUN_QUEUE_WORKSPACE_SUSPENDED",
  );
  assert.equal(callbackCalls, 0);
  assert.equal(coordinator.getState().leases[entry.runId], undefined);
  return {
    agentRevocationFenced: true,
    workspaceSuspensionFenced: true,
    callbackCalls,
    finalFenceGeneration: coordinator.getState().fenceGenerations[entry.runId],
    result: "PASS",
  };
}

async function verifyCapabilityScopes(fixture) {
  const queue = projectEligibleQueue(fixture);
  let tokenIndex = 0;
  const coordinator = createRunLeaseCoordinator({
    actorId: ACTOR_ID,
    clock: () => NOW,
    maxActiveLeasesPerAgent: 3,
    queueProjection: queue,
    tokenFactory: () =>
      `rcap_${String(tokenIndex++).padStart(43, "u").slice(-43)}`,
    workspaceId: WORKSPACE_ID,
  });
  const lease = await coordinator.acquire({
    entry: queue.entries[0],
    queueProof: queue.proof,
    workerId: "scope-worker",
  });
  const foreignRun = await coordinator.acquire({
    entry: queue.entries[1],
    queueProof: queue.proof,
    workerId: "foreign-run-worker",
  });
  const otherAgentQueue = queueForAgent(queue, OTHER_AGENT_ID);
  const otherAgentCoordinator = createRunLeaseCoordinator({
    actorId: ACTOR_ID,
    clock: () => NOW,
    queueProjection: otherAgentQueue,
    tokenFactory: () =>
      `rcap_${String(tokenIndex++).padStart(43, "v").slice(-43)}`,
    workspaceId: WORKSPACE_ID,
  });
  await otherAgentCoordinator.acquire({
    entry: otherAgentQueue.entries[0],
    queueProof: otherAgentQueue.proof,
    workerId: "other-agent-worker",
  });
  const otherWorkspaceCoordinator = createRunLeaseCoordinator({
    actorId: OTHER_ACTOR_ID,
    workspaceId: OTHER_WORKSPACE_ID,
  });
  const calls = [];
  await assert.rejects(
    coordinator.mutate({
      capability: lease.capability,
      endpoint: "credentials.read",
      mutate: () => calls.push("endpoint"),
      runId: queue.entries[0].runId,
    }),
    (error) => error.code === "RUN_QUEUE_CAPABILITY_SCOPE",
  );
  await assert.rejects(
    coordinator.mutate({
      capability: lease.capability,
      mutate: () => calls.push("worker"),
      runId: queue.entries[0].runId,
      workerId: "other-worker",
    }),
    (error) => error.code === "RUN_QUEUE_CAPABILITY_SCOPE",
  );
  await assert.rejects(
    coordinator.mutate({
      capability: lease.capability,
      mutate: () => calls.push("run"),
      runId: foreignRun.lease.runId,
    }),
    (error) => error.code === "RUN_QUEUE_CAPABILITY_SCOPE",
  );
  await assert.rejects(
    otherAgentCoordinator.mutate({
      capability: lease.capability,
      mutate: () => calls.push("agent"),
      runId: otherAgentQueue.entries[0].runId,
    }),
    (error) => error.code === "RUN_QUEUE_CAPABILITY_INVALID",
  );
  await assert.rejects(
    otherWorkspaceCoordinator.mutate({
      capability: lease.capability,
      mutate: () => calls.push("workspace"),
      runId: queue.entries[0].runId,
    }),
    (error) => error.code === "RUN_QUEUE_CAPABILITY_INVALID",
  );
  await assert.rejects(
    coordinator.mutate({
      capability: `${lease.capability.slice(0, -1)}b`,
      mutate: () => calls.push("forged"),
      runId: queue.entries[0].runId,
    }),
    (error) => error.code === "RUN_QUEUE_CAPABILITY_INVALID",
  );
  await coordinator.expire({ now: new Date("2026-08-07T00:01:00.000Z") });
  await assert.rejects(
    coordinator.mutate({
      capability: lease.capability,
      mutate: () => calls.push("post-expiry"),
      runId: queue.entries[0].runId,
    }),
    (error) => error.code === "RUN_QUEUE_CAPABILITY_INVALID",
  );
  const reacquired = await coordinator.acquire({
    entry: queue.entries[0],
    now: new Date("2026-08-07T00:01:00.100Z"),
    queueProof: queue.proof,
    workerId: "generation-two-worker",
  });
  assert.equal(reacquired.lease.leaseGeneration, 2);
  assert.notEqual(reacquired.lease.attemptId, lease.lease.attemptId);
  await assert.rejects(
    coordinator.mutate({
      capability: lease.capability,
      mutate: () => calls.push("generation"),
      runId: queue.entries[0].runId,
    }),
    (error) => error.code === "RUN_QUEUE_CAPABILITY_INVALID",
  );
  assert.deepEqual(calls, []);
  return {
    attemptedScopes: [
      "endpoint",
      "worker",
      "active-foreign-run",
      "foreign-agent-coordinator",
      "foreign-workspace-coordinator",
      "post-expiry",
      "generation-two",
      "forged-token",
    ],
    callbackCalls: calls.length,
    storedCapabilityDigest: lease.lease.capabilityDigest,
    reacquiredAttemptId: reacquired.lease.attemptId,
    reacquiredGeneration: reacquired.lease.leaseGeneration,
    bearerPersisted: false,
    result: "PASS",
  };
}

function verifyLeaseReplay(fixture, journal) {
  const first = replayRunLeaseEvents(journal, { workspaceId: WORKSPACE_ID });
  const second = replayRunLeaseEvents(structuredClone(journal), {
    workspaceId: WORKSPACE_ID,
  });
  assert.equal(first.finalStateDigest, second.finalStateDigest);
  assert.deepEqual(first.prefixes, second.prefixes);
  assert.equal(JSON.stringify(journal).includes("rcap_"), false);
  const staleGenerationEvent = issueEventEnvelope(
    {
      actorId: journal[0].event.actorId,
      causation: journal[0].event.causation,
      correlationId: journal[0].event.correlationId,
      data: structuredClone(journal[0].event.data),
      eventType: "run.lease.acquired",
      idempotencyKey: deriveRunQueueId("ik", {
        kind: "stale-generation",
        runId: journal[0].event.data.runId,
      }),
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
    },
    {
      clock: () => new Date("2026-08-07T00:00:03.000Z"),
      eventId: deriveRunQueueId("ev", {
        kind: "stale-generation",
        runId: journal[0].event.data.runId,
      }),
    },
  );
  assert.throws(
    () =>
      replayRunLeaseEvents(
        [
          ...journal.slice(0, 3),
          {
            digest: digestEventEnvelope(staleGenerationEvent),
            event: staleGenerationEvent,
            offset: offset(4),
          },
        ],
        { workspaceId: WORKSPACE_ID },
      ),
    (error) => error.code === "RUN_QUEUE_LEASE_STALE",
  );
  return {
    finalStateDigest: first.finalStateDigest,
    perPrefixDigests: first.prefixes,
    replayedTwiceWithIdenticalDigest: true,
    staleGenerationRefused: true,
    capabilityValuesPersisted: false,
    result: "PASS",
  };
}

function verifyReducerIntegration(fixture, journal) {
  const queue = projectEligibleQueue(fixture);
  const entry = queue.entries[0];
  const ids = fixture.ids.find(
    ({ invocationId }) => invocationId === entry.invocationId,
  );
  const reducerJournal = journal.filter(
    ({ event }) => event.data.leaseGeneration === 1,
  );
  const leaseAttemptId = deriveRunQueueId("at", {
    attemptNumber: 1,
    leaseGeneration: 1,
    runId: entry.runId,
  });
  const leased = lifecycleEvent({
    actorId: ACTOR_ID,
    attemptId: leaseAttemptId,
    attemptNumber: 1,
    binding: null,
    causation: entry.runRef,
    correlationId: ids.correlationId,
    from: "queued",
    invocationId: entry.invocationId,
    leaseGeneration: 1,
    runId: entry.runId,
    sequence: 3,
    sourceRef: entry.runRef,
    to: "leased",
  });
  const records = [
    fixture.invocationRecords.find(
      (record) => record.event.data.invocationId === entry.invocationId,
    ),
    ...fixture.runRecords.filter(
      (record) => record.event.data.runId === entry.runId,
    ),
    { digest: digestEventEnvelope(leased), event: leased, offset: offset(400) },
    ...reducerJournal.map((record, index) => ({
      ...record,
      offset: offset(401 + index),
    })),
  ];
  const replay = replayRecords(records);
  const run = replay.finalState.entities.runs[entry.runId];
  assert.equal(run.status, "leased");
  assert.equal(run.lease, null);
  assert.equal(run.leaseHistory.length, reducerJournal.length);
  return {
    finalRunStatus: run.status,
    finalLease: run.lease,
    leaseHistoryCount: run.leaseHistory.length,
    finalStateDigest: replay.finalStateDigest,
    result: "PASS",
  };
}

async function verifySensitivity() {
  await mkdir(path.join(taskDirectory, "work"), { recursive: true });
  const mutations = [
    {
      label: "queue-proof-binding",
      target: "src/ledger/run-queue.mjs",
      needle: "if (proof.queueDigest !== queue.proof.queueDigest) {",
      replacement: "if (false) {",
    },
    {
      label: "capability-endpoint-scope",
      target: "src/ledger/run-queue.mjs",
      needle:
        "if (request.endpoint && !lease.endpoints.includes(request.endpoint)) {",
      replacement:
        "if (false && request.endpoint && !lease.endpoints.includes(request.endpoint)) {",
    },
    {
      label: "lease-generation-fence",
      target: "src/ledger/run-queue.mjs",
      needle: "if (data.leaseGeneration !== required) {",
      replacement: "if (false) {",
    },
  ];
  const controlParent = await mkdtemp(
    path.join(taskDirectory, "work", "sensitivity-control-"),
  );
  const controlCheckout = path.join(controlParent, "checkout");
  let controlAdded = false;
  let control;
  try {
    execFileSync(
      "git",
      ["worktree", "add", "--detach", controlCheckout, implementationCommit],
      { cwd: root, stdio: "ignore" },
    );
    controlAdded = true;
    control = await runSensitivityChild(controlCheckout, "control");
  } finally {
    if (controlAdded) {
      execFileSync("git", ["worktree", "remove", "--force", controlCheckout], {
        cwd: root,
        stdio: "ignore",
      });
    }
    await rm(controlParent, { recursive: true, force: true });
  }
  assert.equal(
    control.exitCode,
    0,
    `unmutated verifier control failed with exit code ${control.exitCode}`,
  );
  const results = [];
  for (const mutation of mutations) {
    const parent = await mkdtemp(
      path.join(taskDirectory, "work", `sensitivity-${mutation.label}-`),
    );
    const checkout = path.join(parent, "checkout");
    let added = false;
    try {
      execFileSync(
        "git",
        ["worktree", "add", "--detach", checkout, implementationCommit],
        {
          cwd: root,
          stdio: "ignore",
        },
      );
      added = true;
      const targetPath = path.join(checkout, mutation.target);
      const original = await readFile(targetPath, "utf8");
      assert.equal(original.includes(mutation.needle), true);
      await writeFile(
        targetPath,
        original.replace(mutation.needle, mutation.replacement),
      );
      const result = await runSensitivityChild(checkout, mutation.label);
      assert.notEqual(
        result.exitCode,
        0,
        `${mutation.label} mutant unexpectedly passed the verifier`,
      );
      results.push({
        label: mutation.label,
        verifierExitCode: result.exitCode,
        detected: true,
      });
    } finally {
      if (added) {
        execFileSync("git", ["worktree", "remove", "--force", checkout], {
          cwd: root,
          stdio: "ignore",
        });
      }
      await rm(parent, { recursive: true, force: true });
    }
  }
  return {
    mutationCount: results.length,
    controlExitCode: control.exitCode,
    controlPassed: true,
    verifierDetectedMutant: true,
    results,
  };

  async function runSensitivityChild(checkout, label) {
    const cwd = checkout ?? root;
    try {
      execFileSync(process.execPath, ["scripts/verify-e3-t03.mjs"], {
        cwd,
        env: {
          ...process.env,
          E3_T03_IMPLEMENTATION_COMMIT: implementationCommit,
          E3_T03_SKIP_GATES: "1",
          E3_T03_SKIP_SENSITIVITY: "1",
          PROMOTE_EVIDENCE: "0",
          TEST_ARTIFACT_DIR: path.join(
            cwd,
            ".artifacts",
            "e3-t03-sensitivity",
            label,
          ),
          TEST_RUN_ID: `${runId}-${label}`,
        },
        stdio: "pipe",
      });
      return { exitCode: 0 };
    } catch (error) {
      return { exitCode: error.status ?? 1 };
    }
  }
}

function buildStreamFixture(count) {
  const invocationRecords = [];
  const runRecords = [];
  const ids = [];
  const priorities = new Map();
  for (let index = 0; index < count; index += 1) {
    const suffix = String.fromCharCode("d".charCodeAt(0) + index);
    const invocationId = `iv_${suffix.repeat(26)}`;
    const runId = `rn_${"a".repeat(26)}_${suffix.repeat(26)}`;
    const sourceTrigger = sourceReference(
      CHANNEL_STREAM,
      90 + index,
      String(index + 1),
    );
    const snapshotRef = sourceReference(CONFIG_STREAM, 91 + index, "2");
    const policy = {
      allowApprovals: true,
      maxAttempts: 3,
      maxCostUsdCents: 100,
      maxInputTokens: 1000,
      maxOutputTokens: 1000,
      maxWallTimeMs: 10_000,
      version: 1,
    };
    const correlationId = deriveInvocationCorrelationId({
      agentId: AGENT_ID,
      invocationId,
      sourceTrigger,
      workspaceId: WORKSPACE_ID,
    });
    const invocationEvent = issueEventEnvelope(
      {
        actorId: ACTOR_ID,
        causation: sourceTrigger,
        correlationId,
        data: {
          agentId: AGENT_ID,
          correlationId,
          invocationId,
          policy,
          policyDigest: policyDigest(policy),
          schemaVersion: 1,
          snapshotDigest: digest(String(index + 5)),
          snapshotRef,
          sourceTrigger,
          triggerType: "channel.mention",
        },
        eventType: "workspace.invocation.requested",
        idempotencyKey: deriveRunQueueId("ik", { invocationId }),
        schemaVersion: 1,
        workspaceId: WORKSPACE_ID,
      },
      { clock: () => NOW, eventId: deriveRunQueueId("ev", { invocationId }) },
    );
    const invocationRecord = {
      digest: digestEventEnvelope(invocationEvent),
      event: invocationEvent,
      offset: offset(10 + index),
    };
    const invocationRef = sourceReference(
      `workspace:${WORKSPACE_ID}/invocations`,
      10 + index,
      invocationRecord.digest.slice(7),
    );
    const requestedEvent = lifecycleEvent({
      actorId: ACTOR_ID,
      binding: {
        agentId: AGENT_ID,
        correlationId,
        invocationRef,
        policy,
        policyDigest: policyDigest(policy),
        snapshotDigest: invocationEvent.data.snapshotDigest,
        snapshotRef,
        sourceTrigger,
      },
      causation: invocationRef,
      correlationId,
      from: null,
      invocationId,
      leaseGeneration: null,
      runId,
      sequence: 1,
      sourceRef: invocationRef,
      to: "requested",
    });
    const requestedRecord = {
      digest: digestEventEnvelope(requestedEvent),
      event: requestedEvent,
      offset: offset(100 + index * 2),
    };
    const requestedRef = sourceReference(
      `run:${runId}`,
      100 + index * 2,
      requestedRecord.digest.slice(7),
    );
    const queuedEvent = lifecycleEvent({
      actorId: ACTOR_ID,
      binding: null,
      causation: requestedRef,
      correlationId,
      from: "requested",
      invocationId,
      leaseGeneration: null,
      runId,
      sequence: 2,
      sourceRef: requestedRef,
      to: "queued",
    });
    const queuedRecord = {
      digest: digestEventEnvelope(queuedEvent),
      event: queuedEvent,
      offset: offset(101 + index * 2),
    };
    invocationRecords.push(invocationRecord);
    runRecords.push(requestedRecord, queuedRecord);
    ids.push({
      correlationId,
      invocationId,
      invocationRef,
      queuedRef: sourceReference(
        `run:${runId}`,
        101 + index * 2,
        queuedRecord.digest.slice(7),
      ),
      runId,
      snapshotRef,
      sourceTrigger,
    });
    priorities.set(invocationId, index * 10);
  }
  return {
    invocationRecords,
    ids,
    now: NOW,
    priorityFor: (invocation) => priorities.get(invocation.invocationId) ?? 0,
    runRecords,
    workspaceId: WORKSPACE_ID,
  };
}

function lifecycleEvent({
  actorId,
  attemptId = null,
  attemptNumber = null,
  binding,
  causation,
  correlationId,
  from,
  invocationId,
  leaseGeneration = null,
  runId,
  sequence,
  sourceRef,
  to,
}) {
  return issueEventEnvelope(
    {
      actorId,
      causation,
      correlationId,
      data: {
        attemptId,
        attemptNumber,
        binding,
        from,
        invocationId,
        leaseGeneration,
        runId,
        schemaVersion: 1,
        sequence,
        sourceRef,
        terminal: null,
        to,
      },
      eventType: "run.lifecycle.changed",
      idempotencyKey: deriveRunQueueId("ik", {
        from,
        invocationId,
        runId,
        sequence,
        to,
      }),
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
    },
    {
      clock: () => NOW,
      eventId: deriveRunQueueId("ev", {
        from,
        invocationId,
        runId,
        sequence,
        to,
      }),
    },
  );
}

function sourceReference(stream, offsetNumber, digestValue) {
  return {
    digest: digestValue.startsWith("sha256:")
      ? digestValue
      : `sha256:${digestValue.repeat(64).slice(0, 64)}`,
    offset: offset(offsetNumber),
    stream,
  };
}

function digest(value) {
  return `sha256:${value.repeat(64)}`;
}

function offset(number) {
  return `${String(number).padStart(16, "0")}_0000000000000000`;
}

function queueDigestForProof(proof) {
  const payload = {
    entryDigests: proof.entryDigests,
    invocationStreamDigest: proof.invocationStreamDigest,
    runStreamDigest: proof.runStreamDigest,
    schemaVersion: proof.schemaVersion,
    workspaceId: proof.workspaceId,
  };
  return canonicalSha256(payload);
}

function queueForAgent(queue, agentId) {
  const entries = [{ ...queue.entries[0], agentId }];
  const proof = createQueueProof({
    entries,
    invocationStreamDigest: queue.invocationStreamDigest,
    runStreamDigest: queue.runStreamDigest,
    workspaceId: WORKSPACE_ID,
  });
  return {
    ...queue,
    entries,
    proof,
    queueDigest: proof.queueDigest,
  };
}

async function writeJson(filename, value) {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);
}

async function scanEvidence(directory) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  let leaked = false;
  for (const filename of entries) {
    const contents = await readFile(path.join(directory, filename), "utf8");
    if (
      /rcap_[A-Za-z0-9_-]{32,96}|Bearer\s+e3-t03-|PRIVATE KEY|api[_-]?key\s*[:=]/iu.test(
        contents,
      )
    ) {
      leaked = true;
    }
  }
  return {
    checked: true,
    evidenceFiles: entries,
    leaked,
    postVerifierScanCompleted: true,
  };
}
