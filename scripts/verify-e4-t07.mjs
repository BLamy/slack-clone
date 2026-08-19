import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  QUOTA_ERROR_CODES,
  SandboxQuotaManager,
  compileQuotaPolicy,
  replayQuotaEvents,
} from "@stream-slack/sandbox";
import {
  CLOUDFLARE_OS_ERROR_CODES,
  CloudflareOrphanGarbageCollector,
  CloudflareOsClient,
} from "@stream-slack/sandbox-cloudflare-os";

const runId = process.env.TEST_RUN_ID ?? "e4-t07-" + Date.now().toString(36);
const evidence = path.resolve(
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e4-t07", runId),
);
await mkdir(evidence, { recursive: true });

const DEPLOYMENT_TOKEN = "e4-t07-provider-deployment-identity";
const RAW_SECRET_CANARY = "TOKEN=raw-secret-must-never-be-retained";
const REPLAY_TEXT =
  "Replay: N/A (server quota and GC worker) + mitigation: cold-clone race/replay fixtures, provider inventory transcripts, exact cost digests, and deletion sensitivity";

const quotaFirst = runQuotaSequence(false);
const quotaReplay = runQuotaSequence(true);
assert.deepEqual(
  quotaShape(quotaFirst),
  quotaShape(quotaReplay),
  "shuffled usage observations changed the canonical quota digest",
);
const quotaSensitivity = await runQuotaReservationRaces();

const gcFirst = await runGcSequence();
const gcReplay = await runGcSequence();
assert.deepEqual(
  gcShape(gcFirst),
  gcShape(gcReplay),
  "replayed inventory pages changed the canonical GC digest",
);
const sensitivity = await runGcSensitivity();

await writeJson("quota-reservation.json", quotaSensitivity);
await writeJson("usage-cost.json", {
  eventDigest: quotaFirst.eventDigest,
  replayDigest: quotaFirst.replayDigest,
  reservation: quotaFirst.reservation,
  usage: quotaFirst.usage,
  cost: quotaFirst.cost,
  duplicateObservationCount: quotaFirst.duplicateObservationCount,
});
await writeJson("gc-inventory.json", gcFirst);
await writeJson("deletion-sensitivity.json", sensitivity);
await writeJson("verification-summary.json", {
  schemaVersion: 1,
  task: "E4-T07",
  runId,
  result: "PASS",
  quotaEventDigest: quotaFirst.eventDigest,
  quotaReplayDigest: quotaFirst.replayDigest,
  gcDigest: gcFirst.gcDigest,
  reservationRaceDigest: digestValue(quotaSensitivity),
  sensitivityDigest: digestValue(sensitivity),
  providerPages: gcFirst.providerPages,
  zeroSkips: true,
  replay: REPLAY_TEXT,
});

for (const file of await readdir(evidence)) {
  if (!file.endsWith(".json")) continue;
  const contents = await readFile(path.join(evidence, file), "utf8");
  assert.equal(
    contents.includes(DEPLOYMENT_TOKEN),
    false,
    file + " leaked provider deployment credentials",
  );
  assert.equal(
    contents.includes(RAW_SECRET_CANARY),
    false,
    file + " leaked raw secret canary",
  );
}

console.log(
  JSON.stringify(
    {
      implementationCommit: process.env.E4_T07_IMPLEMENTATION_COMMIT ?? "local",
      result: "PASS",
      runId,
      quotaEventDigest: quotaFirst.eventDigest,
      gcDigest: gcFirst.gcDigest,
      reservationRaceDigest: digestValue(quotaSensitivity),
      sensitivityDigest: digestValue(sensitivity),
    },
    null,
    2,
  ),
);

function makeQuotaPolicy(limits = {}) {
  return compileQuotaPolicy({
    schemaVersion: 1,
    scope: {
      tenantId: "tenant_e4_t07",
      workspaceId: "workspace_e4_t07",
      agentId: "agent_e4_t07",
    },
    limits: {
      sandboxes: 2,
      cpuMillis: 100,
      memoryBytes: 100,
      storageBytes: 100,
      durationMs: 100,
      spendCents: 10,
      ...limits,
    },
    pricingVersion: "pricing-e4-t07-v1",
    ratesMicros: {
      cpuMillis: 100_000,
      memoryByteMs: 0,
      storageByteMs: 0,
      durationMs: 100_000,
    },
  });
}

function quotaRequest(reservationId, requested) {
  return {
    reservationId,
    tenantId: "tenant_e4_t07",
    workspaceId: "workspace_e4_t07",
    agentId: "agent_e4_t07",
    runId: "rn_e4_t07_" + reservationId,
    invocationDigest: "sha256:" + "a".repeat(64),
    requested,
    idempotencyKey: "ik_" + reservationId,
  };
}

function runQuotaSequence(reverse) {
  const policy = makeQuotaPolicy({
    sandboxes: 2,
    cpuMillis: 200,
    memoryBytes: 200,
    storageBytes: 200,
    durationMs: 200,
    spendCents: 10,
  });
  const manager = new SandboxQuotaManager({ policy });
  const request = quotaRequest("res_usage", {
    sandboxes: 1,
    cpuMillis: 20,
    memoryBytes: 20,
    storageBytes: 20,
    durationMs: 20,
    spendCents: 4,
  });
  const reservation = manager.reserve(request);
  assert.deepEqual(manager.reserve(request), reservation);

  const observations = [
    {
      reservationId: reservation.reservationId,
      providerResourceId: "gadget_usage_a",
      meteringWindow: { startMs: 1_000, endMs: 2_000 },
      measured: {
        cpuMillis: 10,
        memoryByteMs: 10,
        storageByteMs: 10,
        durationMs: 10,
      },
      pricingVersion: policy.pricingVersion,
      sourceObservationId: "obs_usage_a",
      sourceOffset: "offset_0001",
    },
    {
      reservationId: reservation.reservationId,
      providerResourceId: "gadget_usage_a",
      meteringWindow: { startMs: 2_000, endMs: 3_000 },
      measured: {
        cpuMillis: 5,
        memoryByteMs: 10,
        storageByteMs: 10,
        durationMs: 5,
      },
      pricingVersion: policy.pricingVersion,
      sourceObservationId: "obs_usage_b",
      sourceOffset: "offset_0002",
    },
  ];
  const ordered = reverse ? [...observations].reverse() : observations;
  for (const observation of ordered) {
    const cost = manager.recordUsage(observation);
    assert.equal(cost.sourceObservationId, observation.sourceObservationId);
    assert.deepEqual(manager.recordUsage(observation), cost);
  }
  assert.throws(
    () =>
      manager.recordUsage({
        ...observations[0],
        measured: { ...observations[0].measured, cpuMillis: 99 },
      }),
    (error) => error.code === QUOTA_ERROR_CODES.USAGE_CONFLICT,
  );
  const released = manager.release({
    reservationId: reservation.reservationId,
    expectedFence: reservation.fence,
  });
  assert.equal(released.status, "released");

  const events = manager.events();
  const duplicateEvents = [
    ...events,
    ...events.filter((event) => event.eventType === "sandbox.usage.observed"),
    ...events.filter((event) => event.eventType === "sandbox.cost.recorded"),
  ];
  const replayed = replayQuotaEvents(duplicateEvents.reverse(), { policy });
  assert.equal(replayed.digest, manager.digest());
  assert.equal(replayed.costs.size, 2);
  assert.equal(replayed.committedUsage.spendCents, 3);
  const cost = manager.usage().costs[0];
  for (const field of [
    "providerResourceId",
    "meteringWindow",
    "measured",
    "pricingVersion",
    "tenantId",
    "runId",
    "sourceObservationId",
  ])
    assert.notEqual(
      cost[field],
      undefined,
      "cost field " + field + " is missing",
    );
  return {
    eventDigest: manager.digest(),
    replayDigest: replayed.digest,
    reservation: manager.reservation(reservation.reservationId),
    usage: manager.usage(),
    cost,
    duplicateObservationCount: 2,
  };
}

async function runQuotaReservationRaces() {
  const dimensions = [
    "sandboxes",
    "cpuMillis",
    "memoryBytes",
    "storageBytes",
    "durationMs",
    "spendCents",
  ];
  const races = [];
  let providerCalls = 0;
  const provider = {
    async create(reservation) {
      assert.equal(reservation.status, "active");
      providerCalls += 1;
      return { providerResourceId: "provider_" + reservation.reservationId };
    },
  };
  for (const dimension of dimensions) {
    const limits = {
      sandboxes: dimension === "sandboxes" ? 1 : 10,
      cpuMillis: dimension === "cpuMillis" ? 10 : 100,
      memoryBytes: dimension === "memoryBytes" ? 10 : 100,
      storageBytes: dimension === "storageBytes" ? 10 : 100,
      durationMs: dimension === "durationMs" ? 10 : 100,
      spendCents: dimension === "spendCents" ? 10 : 100,
    };
    const manager = new SandboxQuotaManager({
      policy: makeQuotaPolicy(limits),
    });
    const requested = {
      sandboxes: 1,
      cpuMillis: 1,
      memoryBytes: 1,
      storageBytes: 1,
      durationMs: 1,
      spendCents: 1,
    };
    if (dimension !== "sandboxes") requested[dimension] = 6;
    const settled = await Promise.allSettled(
      ["a", "b"].map((suffix) =>
        Promise.resolve().then(() => {
          const result = manager.reserve(
            quotaRequest(dimension + "_race_" + suffix, requested),
          );
          return provider.create(result);
        }),
      ),
    );
    const outcomes = settled.map((entry) => {
      if (entry.status === "fulfilled") return "accepted";
      assert.equal(entry.reason.code, QUOTA_ERROR_CODES.QUOTA_EXCEEDED);
      return "rejected";
    });
    assert.deepEqual(outcomes, ["accepted", "rejected"]);
    races.push({ dimension, outcomes });
  }
  assert.equal(providerCalls, dimensions.length);
  assert.throws(
    () =>
      new SandboxQuotaManager({ policy: makeQuotaPolicy() }).reserve({
        ...quotaRequest("scope_attack", {
          sandboxes: 1,
          cpuMillis: 1,
          memoryBytes: 1,
          storageBytes: 1,
          durationMs: 1,
          spendCents: 1,
        }),
        tenantId: "tenant_other",
      }),
    (error) => error.code === QUOTA_ERROR_CODES.INVALID_REQUEST,
  );
  return {
    dimensions,
    races,
    providerCalls,
    noProviderCallForRejectedReservations: true,
  };
}

function quotaShape(value) {
  return {
    eventDigest: value.eventDigest,
    replayDigest: value.replayDigest,
    usageDigest: digestValue(value.usage),
    costDigest: digestValue(value.cost),
  };
}

function makeOwnershipLabels() {
  return {
    "stream-slack/deployment": "deployment_e4_t07",
    "stream-slack/tenant": "tenant_e4_t07",
    "stream-slack/workspace": "workspace_e4_t07",
    "stream-slack/agent": "agent_e4_t07",
  };
}

function resource(name, labels, fence = 1) {
  return {
    workspaceId: "ws_e4_t07_" + name,
    gadgetId: "gd_e4_t07_" + name,
    labels: { ...labels },
    state: "ready",
    fence,
  };
}

async function runGcSequence() {
  let now = 0;
  const ownershipLabels = makeOwnershipLabels();
  const resources = new Map();
  const live = resource("live", ownershipLabels, 1);
  const orphan = resource("orphan", ownershipLabels, 2);
  const protectedResource = resource("protected", ownershipLabels, 3);
  const timeoutResource = resource("timeout", ownershipLabels, 4);
  const heartbeatResource = resource("heartbeat", ownershipLabels, 5);
  const foreign = resource("foreign", {
    ...ownershipLabels,
    "stream-slack/deployment": "deployment_other",
  });
  const partial = resource("partial", {
    "stream-slack/tenant": ownershipLabels["stream-slack/tenant"],
    "stream-slack/workspace": ownershipLabels["stream-slack/workspace"],
    "stream-slack/agent": ownershipLabels["stream-slack/agent"],
  });
  const unlabeled = resource("unlabeled", {});
  for (const value of [
    live,
    orphan,
    protectedResource,
    timeoutResource,
    heartbeatResource,
    foreign,
    partial,
    unlabeled,
  ])
    resources.set(resourceKey(value), value);
  let protectedLeaseArmed = false;
  let timeoutAttempts = 0;
  const destroyCalls = [];
  const inventoryPages = [];
  const client = new CloudflareOsClient({
    baseUrl: "http://fixture.invalid",
    token: DEPLOYMENT_TOKEN,
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      if (options.method === "GET") {
        const all = [...resources.values()].sort((left, right) =>
          resourceKey(left).localeCompare(resourceKey(right)),
        );
        const cursor = parsed.searchParams.get("cursor");
        const start =
          cursor === null
            ? 0
            : all.findIndex((candidate) => resourceKey(candidate) === cursor) +
              1;
        const page = all.slice(start, start + 3);
        const nextCursor =
          start + page.length < all.length && page.length > 0
            ? resourceKey(page.at(-1))
            : null;
        inventoryPages.push({ cursor, count: page.length });
        return jsonResponse({ resources: page, nextCursor });
      }
      const segments = parsed.pathname.split("/").filter(Boolean);
      const workspaceId = segments.at(-4);
      const gadgetId = segments.at(-2);
      const key = workspaceId + ":" + gadgetId;
      const current = resources.get(key);
      if (!current) return jsonResponse({}, 404);
      if (options.headers["if-match"] !== "fence-" + current.fence)
        return jsonResponse({ message: "stale provider fence" }, 409);
      destroyCalls.push({
        key,
        expectedFence: current.fence,
        idempotencyKey: options.headers["idempotency-key"],
      });
      if (key === resourceKey(timeoutResource) && timeoutAttempts === 0) {
        timeoutAttempts += 1;
        return jsonResponse({}, 504);
      }
      if (key === resourceKey(timeoutResource)) timeoutAttempts += 1;
      resources.delete(key);
      return jsonResponse({
        ...current,
        state: "destroyed",
        fence: current.fence + 1,
      });
    },
  });
  const leaseResolver = async (candidate, { phase }) => {
    if (candidate.resourceKey === resourceKey(live))
      return { active: true, heartbeatSequence: 7 };
    if (candidate.resourceKey === resourceKey(protectedResource)) {
      if (phase === "pre-destroy") {
        protectedLeaseArmed = true;
        return { active: true, heartbeatSequence: 8 };
      }
      if (protectedLeaseArmed) return { active: true, heartbeatSequence: 8 };
    }
    if (candidate.resourceKey === resourceKey(heartbeatResource))
      return {
        active: false,
        heartbeatSequence: phase === "pre-destroy" ? 2 : 1,
      };
    return { active: false, heartbeatSequence: 0 };
  };
  const gcOptions = {
    client,
    ownershipLabels,
    graceMs: 10,
    leaseResolver,
    clock: () => now,
  };
  const gc = new CloudflareOrphanGarbageCollector(gcOptions);
  const first = await gc.scan();
  assert.equal(first.destroyed.length, 0);
  assert.deepEqual(
    new Set(first.quarantined),
    new Set([
      resourceKey(orphan),
      resourceKey(protectedResource),
      resourceKey(timeoutResource),
      resourceKey(heartbeatResource),
    ]),
  );
  assert.equal(first.ignored, 3);
  const checkpoint = gc.state();
  const recovered = new CloudflareOrphanGarbageCollector({
    ...gcOptions,
    state: checkpoint,
  });
  assert.equal(recovered.state().eventDigest, checkpoint.eventDigest);
  now = 5;
  const beforeGrace = await recovered.scan();
  assert.equal(beforeGrace.destroyed.length, 0);
  now = 20;
  const afterGrace = await recovered.scan();
  assert.deepEqual(afterGrace.destroyed, [resourceKey(orphan)]);
  assert.equal(
    afterGrace.destroyed.includes(resourceKey(heartbeatResource)),
    false,
  );
  assert.equal(afterGrace.destroyFailures.length, 1);
  assert.equal(
    afterGrace.destroyFailures[0].resourceKey,
    resourceKey(timeoutResource),
  );
  assert.equal(protectedLeaseArmed, true);
  now = 21;
  const afterTimeoutReconcile = await recovered.scan();
  assert.equal(
    afterTimeoutReconcile.destroyed.includes(resourceKey(protectedResource)),
    false,
  );
  assert.equal(
    afterTimeoutReconcile.destroyed.includes(resourceKey(timeoutResource)),
    true,
  );
  assert.equal(resources.has(resourceKey(timeoutResource)), false);
  const timeoutDestroyCalls = destroyCalls.filter(
    ({ key }) => key === resourceKey(timeoutResource),
  );
  assert.equal(timeoutDestroyCalls.length, 2);
  assert.equal(
    new Set(timeoutDestroyCalls.map(({ idempotencyKey }) => idempotencyKey))
      .size,
    1,
  );
  assert.equal(timeoutAttempts, 2);

  const rollback = resource("rollback", ownershipLabels, 5);
  resources.set(resourceKey(rollback), rollback);
  const rollbackFirst = await recovered.scan();
  assert.equal(rollbackFirst.quarantined.includes(resourceKey(rollback)), true);
  now = 10;
  const rollbackSecond = await recovered.scan();
  assert.equal(
    rollbackSecond.destroyed.includes(resourceKey(rollback)),
    false,
    "wall-clock rollback must not advance quarantine grace",
  );
  now = 30;
  const rollbackBeforeGrace = await recovered.scan();
  assert.equal(
    rollbackBeforeGrace.destroyed.includes(resourceKey(heartbeatResource)),
    true,
  );
  assert.equal(
    rollbackBeforeGrace.destroyed.includes(resourceKey(rollback)),
    false,
  );
  now = 31;
  const rollbackDestroyed = await recovered.scan();
  assert.deepEqual(rollbackDestroyed.destroyed, [resourceKey(rollback)]);

  const remainingKeys = [...resources.keys()].sort();
  assert.deepEqual(
    remainingKeys,
    [
      resourceKey(foreign),
      resourceKey(live),
      resourceKey(partial),
      resourceKey(protectedResource),
      resourceKey(unlabeled),
    ].sort(),
  );
  assert.equal(
    destroyCalls.some(({ key }) => key === resourceKey(foreign)),
    false,
  );
  assert.equal(
    inventoryPages.filter(({ cursor }) => cursor !== null).length > 0,
    true,
    "GC must consume more than one provider inventory page",
  );
  assert.equal(
    client.audit().some(({ operation }) => operation === "destroy"),
    true,
  );
  assert.equal(
    client.audit().some(({ path: auditPath }) => auditPath.includes("cursor=")),
    true,
  );
  await assert.rejects(
    () =>
      client.destroy(
        {
          workspaceId: live.workspaceId,
          gadgetId: live.gadgetId,
        },
        ownershipLabels,
        "gc_stale_fence",
        999,
      ),
    (error) => error.code === CLOUDFLARE_OS_ERROR_CODES.CONFLICT,
  );
  assert.equal(resources.has(resourceKey(live)), true);
  assert.equal(
    JSON.stringify(client.audit()).includes(DEPLOYMENT_TOKEN),
    false,
  );

  return {
    gcDigest: recovered.digest(),
    providerPages: inventoryPages.length,
    providerAuditOperations: client.audit().map(({ operation }) => operation),
    destroyCalls,
    destroyedOwnedOrphans: destroyCalls.map(({ key }) => key).sort(),
    foreignAndLivePreserved: true,
    delayedHeartbeatProtected: true,
    delayedHeartbeatSequenceAdvanced: true,
    timeoutRetryReconciled: true,
    staleFenceRejected: true,
    wallClockRollbackSafe: true,
    finalInventory: remainingKeys,
  };
}

async function runGcSensitivity() {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "stream-slack-e4-t07-sensitivity-"),
  );
  try {
    const sourcePath = path.resolve(
      "packages/sandbox-cloudflare-os/src/gc.mjs",
    );
    const errorsPath = path.resolve(
      "packages/sandbox-cloudflare-os/src/errors.mjs",
    );
    const source = await readFile(sourcePath, "utf8");
    const marker = "if (secondLease?.active === true) {";
    assert.equal(
      source.includes(marker),
      true,
      "GC second-check marker drifted",
    );
    const mutatedSource = source.replace(
      marker,
      "if (false && secondLease?.active === true) {",
    );
    await writeFile(path.join(tempRoot, "gc.mjs"), mutatedSource);
    await copyFile(errorsPath, path.join(tempRoot, "errors.mjs"));
    const fixturePath = path.join(tempRoot, "false-orphan.mjs");
    const gcUrl = pathToFileURL(path.join(tempRoot, "gc.mjs")).href;
    const fixture = [
      'import assert from "node:assert/strict";',
      "import { CloudflareOrphanGarbageCollector } from " +
        JSON.stringify(gcUrl) +
        ";",
      "const labels = " + JSON.stringify(makeOwnershipLabels()) + ";",
      'const resource = { workspaceId: "ws_e4_t07_sensitive", gadgetId: "gd_e4_t07_sensitive", labels, state: "ready", fence: 1 };',
      "let now = 0;",
      'let phase = "";',
      "const gc = new CloudflareOrphanGarbageCollector({",
      '  client: { async inventory() { return { resources: [resource] }; }, async destroy() { process.stderr.write("DESTRUCTIVE_DESTROY_REACHED\\n"); process.exit(73); } },',
      "  ownershipLabels: labels,",
      "  graceMs: 10,",
      "  clock: () => now,",
      '  leaseResolver: async (_resource, context) => { phase = context.phase; return { active: phase === "pre-destroy", heartbeatSequence: 0 }; }',
      "});",
      "await gc.scan();",
      "now = 20;",
      "const secondScan = await gc.scan();",
      'assert.equal(secondScan.destroyed.length, 0, "false-orphan recheck must prevent destroy");',
    ].join("\n");
    await writeFile(fixturePath, fixture);
    const result = spawnSync(process.execPath, [fixturePath], {
      cwd: path.resolve("."),
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      73,
      "removing the second orphan check must make the verifier fail",
    );
    assert.match(result.stderr, /DESTRUCTIVE_DESTROY_REACHED/u);
    return {
      mutatedVerifierExitCode: result.status,
      secondOrphanCheckSensitive: true,
      mutationStoppedAtDestroyGuard: true,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function gcShape(value) {
  return {
    gcDigest: value.gcDigest,
    providerPages: value.providerPages,
    destroyedOwnedOrphans: value.destroyedOwnedOrphans,
    finalInventory: value.finalInventory,
    delayedHeartbeatProtected: value.delayedHeartbeatProtected,
    timeoutRetryReconciled: value.timeoutRetryReconciled,
    wallClockRollbackSafe: value.wallClockRollbackSafe,
  };
}

function resourceKey(value) {
  return value.workspaceId + ":" + value.gadgetId;
}

function digestValue(value) {
  return (
    "sha256:" + createHash("sha256").update(canonical(value)).digest("hex")
  );
}

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function writeJson(name, value) {
  await writeFile(
    path.join(evidence, name),
    JSON.stringify(value, null, 2) + "\n",
  );
}
