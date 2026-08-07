import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveInvocationCorrelationId,
  policyDigest,
} from "@stream-slack/protocol";

import {
  createRunLeaseCoordinator,
  projectEligibleQueue,
  rebuildQueueProjection,
  replayRunLeaseEvents,
  RunQueueError,
} from "../../src/ledger/run-queue.mjs";

const WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACTOR_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const AGENT_ID = "ag_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const CHANNEL_STREAM =
  "channel:ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const CONFIG_STREAM =
  "agent:ag_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc/config";
const POLICY = {
  allowApprovals: true,
  maxAttempts: 3,
  maxCostUsdCents: 100,
  maxInputTokens: 1000,
  maxOutputTokens: 1000,
  maxWallTimeMs: 10_000,
  version: 1,
};
const NOW = new Date("2026-08-07T00:00:00.000Z");

test("queue rebuild is deterministic, priority ordered, and source proof bound", () => {
  const fixture = queueFixture(3);
  const first = projectEligibleQueue(fixture);
  const second = rebuildQueueProjection({
    ...fixture,
    invocations: [...fixture.invocations].reverse(),
    runs: [...fixture.runs].reverse(),
  });

  assert.deepEqual(
    first.entries.map(({ invocationId, priority }) => ({
      invocationId,
      priority,
    })),
    [
      { invocationId: fixture.invocations[2].invocationId, priority: 20 },
      { invocationId: fixture.invocations[1].invocationId, priority: 10 },
      { invocationId: fixture.invocations[0].invocationId, priority: 0 },
    ],
  );
  assert.equal(first.queueDigest, second.queueDigest);
  assert.deepEqual(first.proof, second.proof);
  assert.equal(first.proof.entryDigests.length, 3);

  const tampered = projectEligibleQueue({
    ...fixture,
    runs: fixture.runs.map((run, index) =>
      index === 0 ? { ...run, status: "running" } : run,
    ),
  });
  assert.notEqual(tampered.queueDigest, first.queueDigest);
  assert.equal(tampered.entries.length, 2);
});

test("one hundred workers racing one queue proof yield one lease generation", async () => {
  const queue = projectEligibleQueue(queueFixture(1));
  let tokenIndex = 0;
  const coordinator = createRunLeaseCoordinator({
    actorId: ACTOR_ID,
    clock: () => NOW,
    leaseTtlMs: 10_000,
    queueProjection: queue,
    tokenFactory: () =>
      `rcap_${String(tokenIndex++).padStart(43, "a").slice(-43)}`,
    workspaceId: WORKSPACE_ID,
  });

  const results = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      coordinator
        .acquire({
          entry: queue.entries[0],
          queueProof: queue.proof,
          workerId: `worker-${index}`,
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
  assert.ok(
    losers.every(
      ({ error }) =>
        error instanceof RunQueueError && error.code === "RUN_QUEUE_LEASE_HELD",
    ),
  );
  assert.equal(coordinator.getJournal().length, 1);
  assert.equal(winners[0].value.lease.leaseGeneration, 1);
  assert.equal(
    JSON.stringify(coordinator.getJournal()).includes("rcap_"),
    false,
  );
});

test("heartbeat, capability scope, expiry, and reacquisition fence stale workers", async () => {
  const queue = projectEligibleQueue(queueFixture(1));
  let tokenIndex = 0;
  const coordinator = createRunLeaseCoordinator({
    actorId: ACTOR_ID,
    clock: () => NOW,
    leaseTtlMs: 1000,
    queueProjection: queue,
    tokenFactory: () =>
      `rcap_${String(tokenIndex++).padStart(43, "b").slice(-43)}`,
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
  const accepted = await coordinator.mutate({
    capability: first.capability,
    endpoint: "run.events.write",
    mutate: ({ leaseGeneration }) => leaseGeneration,
    runId: entry.runId,
  });
  assert.equal(accepted.result, 1);
  await assert.rejects(
    coordinator.mutate({
      capability: first.capability,
      endpoint: "credentials.read",
      mutate: () => "must-not-run",
      runId: entry.runId,
    }),
    (error) => error.code === "RUN_QUEUE_CAPABILITY_SCOPE",
  );

  const expired = await coordinator.expire({
    now: new Date("2026-08-07T00:00:02.000Z"),
  });
  assert.equal(expired.length, 1);
  for (const operation of ["heartbeat", "release", "mutate"]) {
    const input =
      operation === "heartbeat"
        ? {
            capability: first.capability,
            now: new Date("2026-08-07T00:00:02.100Z"),
            runId: entry.runId,
          }
        : operation === "release"
          ? {
              capability: first.capability,
              now: new Date("2026-08-07T00:00:02.100Z"),
              runId: entry.runId,
            }
          : {
              capability: first.capability,
              mutate: () => "must-not-run",
              runId: entry.runId,
            };
    await assert.rejects(coordinator[operation](input), (error) =>
      [
        "RUN_QUEUE_CAPABILITY_INVALID",
        "RUN_QUEUE_LEASE_NOT_FOUND",
        "RUN_QUEUE_CAPABILITY_EXPIRED",
      ].includes(error.code),
    );
  }

  const second = await coordinator.acquire({
    entry,
    now: new Date("2026-08-07T00:00:02.100Z"),
    queueProof: queue.proof,
    workerId: "replacement-worker",
  });
  assert.equal(second.lease.leaseGeneration, 2);
  assert.notEqual(second.lease.capabilityDigest, first.lease.capabilityDigest);
  assert.equal(
    replayRunLeaseEvents(coordinator.getJournal(), {
      workspaceId: WORKSPACE_ID,
    }).finalStateDigest,
    replayRunLeaseEvents(coordinator.getJournal(), {
      workspaceId: WORKSPACE_ID,
    }).finalStateDigest,
  );
});

test("authority revocation supersedes a lease before the next mutation", async () => {
  const queue = projectEligibleQueue(queueFixture(1));
  let agentStatus = "active";
  let tokenIndex = 0;
  const coordinator = createRunLeaseCoordinator({
    actorId: ACTOR_ID,
    clock: () => NOW,
    leaseTtlMs: 10_000,
    queueProjection: queue,
    resolveAuthority: () => ({
      agentStatus,
      invocationStatus: "requested",
      workspaceStatus: "active",
    }),
    tokenFactory: () =>
      `rcap_${String(tokenIndex++).padStart(43, "c").slice(-43)}`,
    workspaceId: WORKSPACE_ID,
  });
  const first = await coordinator.acquire({
    entry: queue.entries[0],
    queueProof: queue.proof,
    workerId: "revoked-worker",
  });
  agentStatus = "revoked";
  let callbackCalls = 0;
  await assert.rejects(
    coordinator.mutate({
      capability: first.capability,
      mutate: () => {
        callbackCalls += 1;
      },
      runId: queue.entries[0].runId,
    }),
    (error) => error.code === "RUN_QUEUE_AUTHORITY_REVOKED",
  );
  assert.equal(callbackCalls, 0);
  assert.equal(
    coordinator.getState().leases[queue.entries[0].runId],
    undefined,
  );
  agentStatus = "active";
  const second = await coordinator.acquire({
    entry: queue.entries[0],
    queueProof: queue.proof,
    workerId: "replacement-worker",
  });
  assert.equal(second.lease.leaseGeneration, 2);
});

function queueFixture(count) {
  const invocations = [];
  const runs = [];
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
    const invocationRef = sourceReference(
      `workspace:${WORKSPACE_ID}/invocations`,
      1 + index,
      String(index + 3),
    );
    const runRef = sourceReference(`run:${runId}`, 2, String(index + 4));
    const correlationId = deriveInvocationCorrelationId({
      agentId: AGENT_ID,
      invocationId,
      sourceTrigger,
      workspaceId: WORKSPACE_ID,
    });
    invocations.push({
      agentId: AGENT_ID,
      correlationId,
      invocationId,
      policy: POLICY,
      policyDigest: policyDigest(POLICY),
      priority: index * 10,
      schemaVersion: 1,
      snapshotDigest: digest(String(index + 5)),
      snapshotRef,
      sourceRef: invocationRef,
      sourceTrigger,
      triggerType: "channel.mention",
    });
    runs.push({
      agentId: AGENT_ID,
      attempts: 0,
      invocationId,
      runId,
      runRef,
      status: "queued",
    });
  }
  return {
    invocations,
    now: NOW,
    runs,
    workspaceId: WORKSPACE_ID,
  };
}

function digest(value) {
  return `sha256:${value.repeat(64)}`;
}

function offset(number) {
  return `${String(number).padStart(16, "0")}_0000000000000000`;
}

function sourceReference(stream, offsetNumber, digestValue) {
  return {
    digest: digest(digestValue),
    offset: offset(offsetNumber),
    stream,
  };
}
