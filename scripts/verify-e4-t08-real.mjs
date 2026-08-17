import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  CLOUDFLARE_OS_ERROR_CODES,
  CloudflareOsClient,
  CloudflareOsSandboxProvider,
  WorkspaceMaterializer,
  labelsEqual,
  normalizeManifest,
  workspaceDigest,
} from "@stream-slack/sandbox-cloudflare-os";
import {
  EXECUTION_EVENT_TYPES,
  ExecutionEventJournal,
  SandboxQuotaManager,
  compileNetworkPolicy,
  decodeExecutionOutput,
  replayExecutionEvents,
} from "@stream-slack/sandbox";

const REQUIRED = [
  "CF_OS_BASE_URL",
  "CF_OS_TOKEN",
  "CF_OS_TENANT_ID",
  "CF_OS_WORKSPACE_ID",
  "CF_OS_AGENT_ID",
  "CF_OS_TEST_SCOPE",
  "CF_OS_GATEKEEPER_SCHEME",
  "CF_OS_GATEKEEPER_HOST",
  "CF_OS_GATEKEEPER_PORT",
  "CF_OS_GATEKEEPER_PURPOSE",
];
const REPLAY =
  "Replay: N/A (real headless Cloudflare OS sandbox capstone) + mitigation: cold-clone real-provider transcript, exact stream/tree digests, network probe evidence, cost ledger, and before/after Cloudflare OS inventory";
const runId =
  process.env.TEST_RUN_ID ?? "e4-t08-real-" + Date.now().toString(36);
const evidence = path.resolve(
  process.env.TEST_ARTIFACT_DIR ??
    path.join(".artifacts", "e4-t08-real", runId),
);
await mkdir(evidence, { recursive: true });

const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  await writeJson("skipped.json", {
    schemaVersion: 1,
    task: "E4-T08",
    runId,
    result: "SKIPPED",
    missing,
    replay: REPLAY,
  });
  console.error(
    "SKIPPED: missing explicit Cloudflare OS configuration: " +
      missing.join(", "),
  );
  process.exitCode = 2;
} else {
  try {
    await runRealConformance();
  } catch (error) {
    console.error(formatError(error));
    process.exitCode = 1;
  }
}

async function runRealConformance() {
  const config = readConfig();
  const suffix = uniqueSuffix();
  const prefix = config.testScope + "_" + suffix;
  const sandboxRunId = "rn_" + prefix;
  const invocationDigest = digestValue({
    task: "E4-T08",
    prefix,
    runId: sandboxRunId,
  });
  const invocationId = prefix + "_invocation";
  const createKey = prefix + "_create";
  const identity = {
    tenantId: config.tenantId,
    workspaceId: config.workspaceId,
    agentId: config.agentId,
    invocationId,
    idempotencyKey: createKey,
  };
  const networkPolicy = buildNetworkPolicy(config);
  const manifest = buildManifest(invocationDigest);
  const expectedWorkspaceDigest = workspaceDigest(manifest);
  const quota = new SandboxQuotaManager({
    policy: {
      schemaVersion: 1,
      scope: identity,
      limits: {
        sandboxes: 1,
        cpuMillis: 5_000_000,
        memoryBytes: 1_073_741_824,
        storageBytes: 1_073_741_824,
        durationMs: 3_600_000,
        spendCents: 1_000_000,
      },
      pricingVersion:
        process.env.CF_OS_PRICING_VERSION ?? "cloudflare-os-provider-v1",
      ratesMicros: {
        cpuMillis: 1,
        memoryByteMs: 0,
        storageByteMs: 0,
        durationMs: 1,
      },
    },
  });
  const reservation = quota.reserve({
    reservationId: prefix + "_reservation",
    tenantId: identity.tenantId,
    workspaceId: identity.workspaceId,
    agentId: identity.agentId,
    runId: sandboxRunId,
    invocationDigest,
    requested: {
      sandboxes: 1,
      cpuMillis: 1000,
      memoryBytes: 64 * 1024 * 1024,
      storageBytes: 64 * 1024 * 1024,
      durationMs: 600_000,
      spendCents: 100_000,
    },
    idempotencyKey: prefix + "_reserve",
  });
  const client = new CloudflareOsClient({
    baseUrl: config.baseUrl,
    token: config.token,
    fetchImpl: globalThis.fetch,
    timeoutMs: config.timeoutMs,
    maxAttempts: 3,
  });
  const provider = new CloudflareOsSandboxProvider({ client });
  const base = {
    runId: sandboxRunId,
    invocationDigest,
    expectedFence: 0,
    resourceIdentity: identity,
    spec: {
      persistence: config.lifecycleMode,
      requiredCapabilities: [
        "cancellation",
        "network-policy",
        "persistence",
        "resource-limit",
        "streaming-exec",
      ],
      networkPolicy,
      testScope: prefix,
    },
  };
  const state = {
    task: "E4-T08",
    runId,
    prefix,
    sandboxRunId,
    invocationDigest,
    expectedWorkspaceDigest,
    networkPolicyDigest: networkPolicy.digest,
    providerResourceId: null,
    providerAttestation: null,
    beforeInventory: null,
    afterCreateInventory: null,
    afterPublishInventory: null,
    beforeDestroyInventory: null,
    afterCleanupInventory: null,
    executions: [],
    networkProbes: [],
    acceptedTimeoutRetry: null,
    quota: null,
    cleanup: null,
  };
  let tempRoot;
  let sandbox = null;
  let primaryError = null;
  let cleanupError = null;
  try {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "stream-slack-e4-t08-"));
    const before = await inventoryAll(client, identity);
    state.beforeInventory = summarizeInventory(before.resources);
    assert.equal(
      exactResources(before.resources, identity).length,
      0,
      "unique E4-T08 ownership labels were already present before create",
    );

    sandbox = await provider.create({
      ...base,
      idempotencyKey: createKey,
    });
    assert.equal(sandbox.lifecycle, "ready");
    const afterCreate = await inventoryAll(client, identity);
    const createdResource = requireOneResource(afterCreate.resources, identity);
    state.afterCreateInventory = summarizeInventory(afterCreate.resources);
    state.providerResourceId = resourceId(createdResource);
    state.providerAttestation = requireCloudflareAttestation(createdResource);
    assert.equal(sandbox.sandboxId, publicSandboxId(createdResource));
    assert.equal(createdResource.fence, sandbox.fence);

    const configured = await provider.configureNetworkPolicy(
      {
        ...base,
        sandboxId: sandbox.sandboxId,
        expectedFence: sandbox.fence,
        idempotencyKey: prefix + "_network_policy",
      },
      networkPolicy,
    );
    sandbox = configured.sandbox;
    assert.equal(configured.policyDigest, networkPolicy.digest);

    const materializer = new WorkspaceMaterializer({
      publicationPath: path.join(tempRoot, "workspace"),
    });
    const materialized = await provider.materializeWorkspace(
      {
        ...base,
        sandboxId: sandbox.sandboxId,
        expectedFence: sandbox.fence,
        workspaceDigest: expectedWorkspaceDigest,
        idempotencyKey: prefix + "_workspace_materialize",
      },
      manifest,
      { materializer },
    );
    assert.equal(materialized.digest, expectedWorkspaceDigest);
    const afterPublish = await inventoryAll(client, identity);
    const publishedResource = requireOneResource(
      afterPublish.resources,
      identity,
    );
    state.afterPublishInventory = summarizeInventory(afterPublish.resources);
    assert.equal(
      extractWorkspaceDigest(publishedResource.raw),
      expectedWorkspaceDigest,
      "remote workspace digest did not match the committed manifest before execution",
    );
    sandbox = await refreshSandbox(
      provider,
      client,
      base,
      sandbox,
      identity,
      prefix + "_refresh_published",
    );

    const deterministicCommand = shellCommand(
      [
        "set -eu",
        "printf 'parent:start\\n'",
        "sh -c 'printf \"child:one\\\\n\"'",
        "sh -c 'printf \"child:two\\\\n\"'",
        "printf 'parent:end\\n'",
      ].join("\n"),
    );
    const deterministicFirst = await runExecution({
      provider,
      base,
      sandbox,
      workspaceDigest: expectedWorkspaceDigest,
      command: deterministicCommand,
      idempotencyKey: prefix + "_exec_deterministic_a",
      disconnect: true,
    });
    assert.equal(deterministicFirst.terminal.kind, "completed");
    assert.equal(deterministicFirst.terminal.exitCode, 0);
    assert.match(deterministicFirst.stdout, /parent:start/u);
    assert.match(deterministicFirst.stdout, /child:one/u);
    assert.match(deterministicFirst.stdout, /child:two/u);
    assert.match(deterministicFirst.stdout, /parent:end/u);
    state.executions.push(executionEvidence(deterministicFirst));
    sandbox = await refreshSandbox(
      provider,
      client,
      base,
      sandbox,
      identity,
      prefix + "_refresh_deterministic_a",
    );

    const deterministicSecond = await runExecution({
      provider,
      base,
      sandbox,
      workspaceDigest: expectedWorkspaceDigest,
      command: deterministicCommand,
      idempotencyKey: prefix + "_exec_deterministic_b",
      disconnect: true,
    });
    assert.equal(
      transcriptShape(deterministicFirst.events),
      transcriptShape(deterministicSecond.events),
      "deterministic stdout/stderr/exit transcripts differed across runs",
    );
    state.executions.push(executionEvidence(deterministicSecond));
    sandbox = await refreshSandbox(
      provider,
      client,
      base,
      sandbox,
      identity,
      prefix + "_refresh_deterministic_b",
    );

    const probeResults = await runNetworkProbes({
      provider,
      client,
      base,
      sandbox,
      workspaceDigest: expectedWorkspaceDigest,
      config,
      prefix,
      identity,
    });
    state.networkProbes = probeResults.map(probeEvidence);
    state.executions.push(...probeResults.map(executionEvidence));
    sandbox = await refreshSandbox(
      provider,
      client,
      base,
      sandbox,
      identity,
      prefix + "_refresh_network",
    );

    const cancellation = await runCancellation({
      provider,
      base,
      sandbox,
      workspaceDigest: expectedWorkspaceDigest,
      idempotencyKey: prefix + "_exec_cancel",
      cancelIdempotencyKey: prefix + "_cancel",
    });
    assert.equal(cancellation.terminal.kind, "cancelled");
    assert.equal(cancellation.terminal.termination?.survivors, 0);
    assert.equal(
      cancellation.stdout.includes("post-cancel-side-effect"),
      false,
    );
    state.executions.push(executionEvidence(cancellation));
    sandbox = await refreshSandbox(
      provider,
      client,
      base,
      sandbox,
      identity,
      prefix + "_refresh_cancel",
    );

    const beforeDestroy = await inventoryAll(client, identity);
    const usageResource = requireOneResource(beforeDestroy.resources, identity);
    state.beforeDestroyInventory = summarizeInventory(beforeDestroy.resources);
    const usage = extractProviderUsage(usageResource.raw);
    const costObservation = {
      reservationId: reservation.reservationId,
      providerResourceId: state.providerResourceId,
      meteringWindow: usage.meteringWindow,
      measured: usage.measured,
      pricingVersion: usage.pricingVersion,
      sourceObservationId:
        usage.sourceObservationId ?? prefix + "_usage_observation",
      sourceOffset: usage.sourceOffset ?? prefix + "_usage_offset",
    };
    const cost = quota.recordUsage(costObservation);
    assert.equal(cost.providerResourceId, state.providerResourceId);
    assert.deepEqual(quota.recordUsage(costObservation), cost);

    const destroyed = await destroyWithAcceptedTimeoutRetry({
      provider,
      client,
      base,
      sandbox,
      identity,
      prefix,
    });
    state.acceptedTimeoutRetry = destroyed.evidence;
    assert.equal(destroyed.remaining.length, 0);
    const afterCleanup = await inventoryAll(client, identity);
    state.afterCleanupInventory = summarizeInventory(afterCleanup.resources);
    assert.equal(exactResources(afterCleanup.resources, identity).length, 0);
    quota.release({
      reservationId: reservation.reservationId,
      expectedFence: reservation.fence,
      reason: "provider-cleanup",
    });
    state.quota = quota.summary();
    assert.equal(state.quota.reservations[0].status, "released");
    assert.equal(
      state.quota.usage.costs[0].providerResourceId,
      state.providerResourceId,
    );
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      state.cleanup = await cleanupExactResources(client, identity, prefix);
    } catch (error) {
      cleanupError = error;
    }
    try {
      const after = await inventoryAll(client, identity);
      state.afterCleanupInventory = summarizeInventory(after.resources);
    } catch (error) {
      state.afterCleanupInventory = { inventoryError: safeError(error) };
      cleanupError ??= error;
    }
    await writeJson("manifest.json", {
      schemaVersion: 1,
      task: "E4-T08",
      runId,
      invocationDigest,
      workspaceDigest: expectedWorkspaceDigest,
      entries: manifest.entries.map((entry) => ({
        path: entry.path,
        type: entry.type,
        mode: entry.mode,
        bytes: entry.bytes?.byteLength ?? 0,
      })),
    });
    await writeJson("provider-inventory.json", {
      schemaVersion: 1,
      task: "E4-T08",
      runId,
      prefix,
      providerResourceId: state.providerResourceId,
      providerAttestation: state.providerAttestation,
      beforeCreate: state.beforeInventory,
      afterCreate: state.afterCreateInventory,
      afterPublish: state.afterPublishInventory,
      beforeDestroy: state.beforeDestroyInventory,
      afterCleanup: state.afterCleanupInventory,
      cleanup: state.cleanup,
      auditOperations: client.audit().map(({ operation }) => operation),
    });
    await writeJson("execution-transcripts.json", {
      schemaVersion: 1,
      task: "E4-T08",
      runId,
      executions: state.executions,
      acceptedTimeoutRetry: state.acceptedTimeoutRetry,
    });
    await writeJson("network-probes.json", {
      schemaVersion: 1,
      task: "E4-T08",
      runId,
      policyDigest: networkPolicy.digest,
      probes: state.networkProbes,
    });
    await writeJson("quota-cost.json", {
      schemaVersion: 1,
      task: "E4-T08",
      runId,
      providerResourceId: state.providerResourceId,
      quota: state.quota,
    });
    if (primaryError || cleanupError)
      await writeJson("failure.json", {
        schemaVersion: 1,
        task: "E4-T08",
        runId,
        result: "FAIL",
        primaryError: primaryError ? safeError(primaryError) : null,
        cleanupError: cleanupError ? safeError(cleanupError) : null,
        replay: REPLAY,
      });
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  }

  if (primaryError || cleanupError) {
    throw new Error(
      [primaryError, cleanupError].filter(Boolean).map(formatError).join("; "),
    );
  }
  const summary = {
    schemaVersion: 1,
    task: "E4-T08",
    runId,
    result: "PASS",
    implementationCommit: process.env.E4_T08_IMPLEMENTATION_COMMIT ?? "local",
    providerResourceId: state.providerResourceId,
    providerAttestation: state.providerAttestation,
    workspaceDigest: expectedWorkspaceDigest,
    transcriptDigest: digestValue(
      state.executions
        .filter((execution) => execution.kind === "completed")
        .map((execution) => execution.transcript),
    ),
    networkDecisionDigest: digestValue(state.networkProbes),
    quotaEventDigest: state.quota.eventDigest,
    acceptedTimeoutRetry: state.acceptedTimeoutRetry,
    finalInventoryCount: state.afterCleanupInventory?.length ?? 0,
    replay: REPLAY,
  };
  await writeJson("verification-summary.json", summary);
  await writeJson("cold-verification-transcript.json", {
    implementationCommit: process.env.E4_T08_IMPLEMENTATION_COMMIT ?? "local",
    result: "PASS",
    runId,
    replay: REPLAY,
  });
  console.log(JSON.stringify(summary, null, 2));
}

async function runExecution({
  provider,
  base,
  sandbox,
  workspaceDigest: expectedDigest,
  command,
  idempotencyKey,
  disconnect,
  probeId = null,
}) {
  const started = await provider.exec({
    ...base,
    sandboxId: sandbox.sandboxId,
    expectedFence: sandbox.fence,
    workspaceDigest: expectedDigest,
    exec: { command, stream: true },
    idempotencyKey,
  });
  if (typeof started.executionId !== "string")
    throw new Error("real provider did not return an execution id");
  const journal = new ExecutionEventJournal({
    executionId: started.executionId,
  });
  const rawEvents = [];
  const networkDecisions = [];
  const request = {
    ...base,
    sandboxId: sandbox.sandboxId,
    executionId: started.executionId,
    expectedFence: started.fence,
    idempotencyKey: idempotencyKey + "_stream",
  };
  const first = await drainExecution({
    provider,
    request,
    journal,
    rawEvents,
    networkDecisions,
    afterSequence: 0,
    stopAfterFirstOutput: disconnect,
    probeId,
  });
  if (disconnect) assert.equal(first.disconnected, true);
  for (let attempt = 0; !journal.terminalEvent && attempt < 20; attempt += 1) {
    await delay(attempt === 0 ? 0 : 100);
    await drainExecution({
      provider,
      request,
      journal,
      rawEvents,
      networkDecisions,
      afterSequence: journal.lastSequence,
      stopAfterFirstOutput: false,
      probeId,
    });
  }
  assert.ok(
    journal.terminalEvent,
    "execution stream did not reach a terminal event",
  );
  const transcript = journal.events();
  const replayed = replayExecutionEvents(transcript, {
    executionId: started.executionId,
  });
  assert.equal(replayed.digest, journal.digest());
  return {
    kind: journal.terminalEvent.kind,
    executionId: started.executionId,
    terminal: journal.terminalEvent,
    events: transcript,
    transcript: transcriptShape(transcript),
    transcriptDigest: journal.digest(),
    stdout: outputFor(transcript, "stdout"),
    stderr: outputFor(transcript, "stderr"),
    networkDecisions,
    rawEvents,
    disconnected: first.disconnected,
  };
}

async function runCancellation({
  provider,
  base,
  sandbox,
  workspaceDigest: expectedDigest,
  idempotencyKey,
  cancelIdempotencyKey,
}) {
  const started = await provider.exec({
    ...base,
    sandboxId: sandbox.sandboxId,
    expectedFence: sandbox.fence,
    workspaceDigest: expectedDigest,
    exec: {
      command: shellCommand(
        [
          "set -eu",
          "printf 'cancel:start\\n'",
          "(sleep 30; printf 'post-cancel-side-effect\\n') &",
          "child=$!",
          "wait $child",
        ].join("\n"),
      ),
      stream: true,
    },
    idempotencyKey,
  });
  await delay(250);
  const cancellation = await provider.cancelExecution({
    ...base,
    sandboxId: sandbox.sandboxId,
    executionId: started.executionId,
    expectedFence: started.fence,
    idempotencyKey: cancelIdempotencyKey,
  });
  assert.ok(cancellation);
  const journal = new ExecutionEventJournal({
    executionId: started.executionId,
  });
  const rawEvents = [];
  const networkDecisions = [];
  const request = {
    ...base,
    sandboxId: sandbox.sandboxId,
    executionId: started.executionId,
    expectedFence: cancellation.fence,
    idempotencyKey: cancelIdempotencyKey + "_stream",
  };
  for (let attempt = 0; !journal.terminalEvent && attempt < 20; attempt += 1) {
    await drainExecution({
      provider,
      request,
      journal,
      rawEvents,
      networkDecisions,
      afterSequence: journal.lastSequence,
      stopAfterFirstOutput: false,
      probeId: null,
    });
    if (!journal.terminalEvent) await delay(100);
  }
  assert.ok(journal.terminalEvent);
  assert.equal(journal.terminalEvent.kind, "cancelled");
  assert.equal(journal.terminalEvent.termination?.survivors, 0);
  const transcript = journal.events();
  const replayed = replayExecutionEvents(transcript, {
    executionId: started.executionId,
  });
  assert.equal(replayed.digest, journal.digest());
  return {
    kind: "cancelled",
    executionId: started.executionId,
    terminal: journal.terminalEvent,
    events: transcript,
    transcript: transcriptShape(transcript),
    transcriptDigest: journal.digest(),
    stdout: outputFor(transcript, "stdout"),
    stderr: outputFor(transcript, "stderr"),
    networkDecisions,
    rawEvents,
    disconnected: false,
  };
}

async function drainExecution({
  provider,
  request,
  journal,
  rawEvents,
  networkDecisions,
  afterSequence,
  stopAfterFirstOutput,
  probeId,
}) {
  let disconnected = false;
  for await (const event of provider.streamExecution(request, {
    afterSequence,
  })) {
    const candidates = extractNetworkDecisions(event);
    for (const candidate of candidates)
      networkDecisions.push(normalizeNetworkDecision(candidate, probeId));
    rawEvents.push(sanitizeExecutionEvent(event, candidates, probeId));
    if (!isExecutionEvent(event)) {
      if (candidates.length === 0)
        throw new Error("real provider emitted an unknown execution event");
      continue;
    }
    const accepted = journal.ingest(event);
    if (
      stopAfterFirstOutput &&
      accepted.accepted &&
      event.type === EXECUTION_EVENT_TYPES.OUTPUT
    ) {
      disconnected = true;
      break;
    }
  }
  return { disconnected };
}

async function runNetworkProbes({
  provider,
  client,
  base,
  sandbox,
  workspaceDigest: expectedDigest,
  config,
  prefix,
  identity,
}) {
  const probes = [
    {
      id: "allowlisted-gatekeeper",
      url: config.gatekeeperUrl,
      expected: "allow",
    },
    { id: "direct-internet", url: "https://example.com/", expected: "deny" },
    { id: "private-address", url: "http://10.0.0.1/", expected: "deny" },
    { id: "link-local", url: "http://169.254.1.1/", expected: "deny" },
    { id: "metadata", url: "http://169.254.169.254/", expected: "deny" },
    {
      id: "inbound",
      url:
        config.inboundProbeUrl ??
        "http://127.0.0.1:" + String(config.gatekeeperPort) + "/",
      expected: "deny",
    },
  ];
  const results = [];
  let currentSandbox = sandbox;
  for (const probe of probes) {
    const result = await runExecution({
      provider,
      base,
      sandbox: currentSandbox,
      workspaceDigest: expectedDigest,
      command: probeCommand(probe.id, probe.url),
      idempotencyKey: prefix + "_probe_" + probe.id,
      disconnect: false,
      probeId: probe.id,
    });
    const marker = new RegExp(
      "probe:" + escapeRegExp(probe.id) + ":(allowed|denied)",
      "u",
    ).exec(result.stdout);
    assert.ok(marker, "probe " + probe.id + " did not emit a result marker");
    assert.equal(
      marker[1] === "allowed" ? "allow" : "deny",
      probe.expected,
      "probe " + probe.id + " produced the wrong provider result",
    );
    const decisions = result.networkDecisions.filter(
      (decision) => decision.probeId === probe.id,
    );
    assert.ok(
      decisions.length > 0,
      "probe " + probe.id + " produced no network decision event",
    );
    assert.equal(
      new Set(decisions.map((decision) => decision.outcome)).size,
      1,
      "probe " + probe.id + " had conflicting network decisions",
    );
    assert.equal(decisions[0].outcome, probe.expected);
    results.push({ ...result, probe, decisions });
    currentSandbox = await refreshSandbox(
      provider,
      client,
      base,
      currentSandbox,
      identity,
      prefix + "_refresh_probe_" + probe.id,
    );
  }
  return results;
}

async function destroyWithAcceptedTimeoutRetry({
  provider,
  client,
  base,
  sandbox,
  identity,
  prefix,
}) {
  const destroyKey = prefix + "_destroy";
  let firstError = null;
  let destroyed = null;
  let retryAttempted = false;
  try {
    destroyed = await provider.destroy({
      ...base,
      sandboxId: sandbox.sandboxId,
      expectedFence: sandbox.fence,
      idempotencyKey: destroyKey,
    });
  } catch (error) {
    firstError = error;
    if (error?.code !== CLOUDFLARE_OS_ERROR_CODES.TIMEOUT) throw error;
    const pending = await waitForResource(client, identity, 10);
    if (!pending)
      throw new Error(
        "destroy timed out but reconciliation found no retryable provider resource",
      );
    const refreshed = await provider.inspect({
      ...base,
      sandboxId: sandbox.sandboxId,
      expectedFence: pending.fence,
      idempotencyKey: prefix + "_inspect_destroy_retry",
    });
    retryAttempted = true;
    destroyed = await provider.destroy({
      ...base,
      sandboxId: refreshed.sandboxId,
      expectedFence: refreshed.fence,
      idempotencyKey: destroyKey,
    });
  }
  assert.ok(destroyed);
  const remaining = await inventoryAll(client, identity);
  assert.equal(
    exactResources(remaining.resources, identity).length,
    0,
    "destroy returned before the unique provider resource was gone",
  );
  assert.equal(
    firstError !== null && retryAttempted,
    true,
    "real provider did not exercise the accepted-then-timeout retry",
  );
  return {
    destroyed,
    remaining: exactResources(remaining.resources, identity),
    evidence: {
      timeoutObserved: firstError !== null,
      retryAttempted,
      sameIdempotencyKey: true,
      resourceGone: true,
    },
  };
}

async function cleanupExactResources(client, identity, prefix) {
  const attempts = [];
  for (let round = 0; round < 12; round += 1) {
    const inventory = await inventoryAll(client, identity);
    const resources = exactResources(inventory.resources, identity);
    if (resources.length === 0)
      return { rounds: round + 1, attempts, remaining: 0 };
    for (const resource of resources) {
      try {
        await client.destroy(
          resourceReference(resource),
          identity,
          prefix + "_cleanup",
          resource.fence,
        );
        attempts.push({
          resourceId: resourceId(resource),
          result: "destroyed",
        });
      } catch (error) {
        attempts.push({
          resourceId: resourceId(resource),
          result: "error",
          error: safeError(error),
        });
        if (
          ![
            CLOUDFLARE_OS_ERROR_CODES.TIMEOUT,
            CLOUDFLARE_OS_ERROR_CODES.NOT_FOUND,
            CLOUDFLARE_OS_ERROR_CODES.CONFLICT,
          ].includes(error?.code)
        )
          throw error;
      }
    }
    await delay(250);
  }
  const remaining = await inventoryAll(client, identity);
  throw new Error(
    "cleanup left " +
      exactResources(remaining.resources, identity).length +
      " uniquely prefixed provider resources",
  );
}

async function waitForResource(client, identity, attempts) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const inventory = await inventoryAll(client, identity);
    const resources = exactResources(inventory.resources, identity);
    if (resources.length > 0)
      return requireOneResource(inventory.resources, identity);
    await delay(250);
  }
  return null;
}

async function refreshSandbox(
  provider,
  client,
  base,
  sandbox,
  identity,
  idempotencyKey,
) {
  const inventory = await inventoryAll(client, identity);
  const current = requireOneResource(inventory.resources, identity);
  return provider.inspect({
    ...base,
    sandboxId: sandbox.sandboxId,
    expectedFence: current.fence,
    idempotencyKey,
  });
}

async function inventoryAll(client, labels) {
  const resources = [];
  const pages = [];
  let cursor = null;
  for (let page = 0; page < 1024; page += 1) {
    const response = await client.inventory(labels, { cursor });
    const values = response?.resources ?? response?.items ?? response;
    if (!Array.isArray(values))
      throw new Error("real provider inventory response was not an array");
    resources.push(...values);
    pages.push(values.length);
    const next =
      response?.nextCursor ??
      response?.next_cursor ??
      response?.pagination?.nextCursor ??
      null;
    if (next === null || next === undefined || next === "")
      return { resources, pages };
    if (typeof next !== "string")
      throw new Error("real provider inventory cursor was invalid");
    cursor = next;
  }
  throw new Error("real provider inventory exceeded the bounded page limit");
}

function exactResources(resources, labels) {
  return resources
    .map((raw) => resourceDetails(raw))
    .filter((resource) => resource && labelsEqual(resource.labels, labels));
}

function requireOneResource(resources, labels) {
  const matches = exactResources(resources, labels);
  assert.equal(
    matches.length,
    1,
    "expected exactly one uniquely owned provider resource",
  );
  return matches[0];
}

function resourceDetails(raw) {
  const record = raw?.resource ?? raw?.workspace ?? raw?.gadget ?? raw;
  if (!record || typeof record !== "object" || Array.isArray(record))
    return null;
  const labels =
    record.labels ?? record.workspace?.labels ?? record.gadget?.labels;
  const workspaceId =
    record.workspaceId ?? record.workspace?.id ?? record.workspace?.workspaceId;
  const gadgetId =
    record.gadgetId ?? record.gadget?.id ?? record.gadget?.gadgetId;
  const fence = record.fence ?? record.revision;
  if (
    !labels ||
    typeof workspaceId !== "string" ||
    typeof gadgetId !== "string" ||
    !Number.isSafeInteger(fence)
  )
    return null;
  return {
    raw,
    labels,
    workspaceId,
    gadgetId,
    fence,
    state: record.state ?? record.status ?? record.lifecycle ?? null,
  };
}

function resourceReference(resource) {
  return {
    workspaceId: resource.workspaceId,
    gadgetId: resource.gadgetId,
  };
}

function resourceId(resource) {
  return resource.workspaceId + ":" + resource.gadgetId;
}

function publicSandboxId(resource) {
  return (
    "sb_" +
    hash(
      canonical({
        gadgetId: resource.gadgetId,
        labels: resource.labels,
        workspaceId: resource.workspaceId,
      }),
    ).slice(0, 24)
  );
}

function requireCloudflareAttestation(resource) {
  const record =
    resource.raw?.resource ??
    resource.raw?.workspace ??
    resource.raw?.gadget ??
    resource.raw;
  const candidates = [
    record?.provider,
    record?.providerName,
    record?.providerType,
    record?.platform,
    record?.metadata?.provider,
    record?.metadata?.providerName,
  ].filter((value) => typeof value === "string");
  const attestation = candidates.find((value) => /cloudflare/iu.test(value));
  if (!attestation)
    throw new Error(
      "real provider response lacked a Cloudflare OS attestation",
    );
  return attestation;
}

function extractWorkspaceDigest(raw) {
  const record = raw?.resource ?? raw?.workspace ?? raw?.gadget ?? raw;
  return (
    record?.workspaceDigest ??
    record?.workspace?.workspaceDigest ??
    record?.workspace?.digest ??
    record?.gadget?.workspaceDigest ??
    record?.gadget?.digest ??
    null
  );
}

function extractProviderUsage(raw) {
  const record = raw?.resource ?? raw?.workspace ?? raw?.gadget ?? raw;
  const source =
    record?.usage ??
    record?.metering ??
    record?.metrics?.usage ??
    record?.cost?.usage ??
    record?.billing?.usage;
  if (!source || typeof source !== "object")
    throw new Error(
      "real provider resource did not return provider-observed usage",
    );
  const meteringWindow = source.meteringWindow ?? {
    startMs: source.startMs,
    endMs: source.endMs,
  };
  const measured = source.measured ?? source.units ?? source;
  assert.ok(Number.isSafeInteger(meteringWindow.startMs));
  assert.ok(Number.isSafeInteger(meteringWindow.endMs));
  assert.ok(meteringWindow.endMs > meteringWindow.startMs);
  assert.ok(measured && typeof measured === "object");
  return {
    meteringWindow,
    measured,
    pricingVersion:
      source.pricingVersion ??
      process.env.CF_OS_PRICING_VERSION ??
      "cloudflare-os-provider-v1",
    sourceObservationId: source.sourceObservationId,
    sourceOffset: source.sourceOffset,
  };
}

function buildNetworkPolicy(config) {
  const allow = {
    id: "e4-t08-gatekeeper",
    scheme: config.gatekeeperScheme,
    host: config.gatekeeperHost,
    port: config.gatekeeperPort,
    purpose: config.gatekeeperPurpose,
    addressClasses: ["public"],
  };
  if (process.env.CF_OS_GATEKEEPER_ADDRESS)
    allow.addresses = [process.env.CF_OS_GATEKEEPER_ADDRESS];
  return compileNetworkPolicy({
    schemaVersion: 1,
    defaultEgress: "deny",
    defaultInbound: "deny",
    allow: [allow],
    inbound: [],
  });
}

function buildManifest(invocationDigest) {
  return normalizeManifest({
    schemaVersion: 1,
    invocationDigest,
    entries: [
      {
        path: "workspace/README.md",
        type: "file",
        content: "Stream Slack E4-T08 pinned workspace\n",
      },
      {
        path: "workspace/bin/scenario.sh",
        type: "file",
        mode: 0o755,
        content: "#!/bin/sh\nprintf 'pinned-workspace-ok\\n'\n",
      },
    ],
  });
}

function buildProbePolicyUrl(config) {
  return (
    config.gatekeeperScheme +
    "://" +
    formatHost(config.gatekeeperHost) +
    ":" +
    String(config.gatekeeperPort) +
    "/"
  );
}

function probeCommand(id, url) {
  const body = [
    "set -eu",
    "url=" + shellQuote(url),
    "code=$(curl --silent --output /dev/null --max-time 3 --max-redirs 0 --write-out '%{http_code}' \"$url\" 2>/dev/null || printf '000')",
    "if [ \"$code\" = '000' ]; then result=denied; else result=allowed; fi",
    "printf 'probe:" + id + ':%s\\n\' "$result"',
  ].join("\n");
  return shellCommand(body);
}

function shellCommand(body) {
  return "sh -c " + shellQuote(body);
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/gu, "'\\''") + "'";
}

function outputFor(events, channel) {
  return Buffer.concat(
    events
      .filter(
        (event) =>
          event.type === EXECUTION_EVENT_TYPES.OUTPUT &&
          event.channel === channel,
      )
      .map(decodeExecutionOutput),
  ).toString("utf8");
}

function transcriptShape(events) {
  return JSON.stringify(
    events.map(({ executionId: _executionId, ...event }) => event),
  );
}

function executionEvidence(result) {
  return {
    executionId: result.executionId,
    kind: result.kind,
    terminal: result.terminal,
    transcriptDigest: result.transcriptDigest,
    transcript: result.transcript,
    stdout: result.stdout,
    stderr: result.stderr,
    disconnected: result.disconnected,
  };
}

function probeEvidence(result) {
  return {
    ...executionEvidence(result),
    probe: result.probe,
    decisions: result.decisions,
  };
}

function isExecutionEvent(event) {
  return (
    event &&
    typeof event === "object" &&
    Object.values(EXECUTION_EVENT_TYPES).includes(event.type)
  );
}

function extractNetworkDecisions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const candidates = [];
  if (
    value.type === "network-decision" ||
    value.type === "network_decision" ||
    value.kind === "network-decision"
  )
    candidates.push(value);
  for (const key of [
    "networkDecision",
    "network_decision",
    "network",
    "decision",
  ]) {
    if (value[key] && typeof value[key] === "object")
      candidates.push(value[key]);
  }
  for (const key of ["networkDecisions", "network_decisions"]) {
    if (Array.isArray(value[key])) candidates.push(...value[key]);
  }
  if (value.details && typeof value.details === "object")
    candidates.push(...extractNetworkDecisions(value.details));
  return candidates;
}

function normalizeNetworkDecision(value, fallbackProbeId) {
  const outcomeValue =
    value.allowed === true
      ? "allow"
      : value.allowed === false
        ? "deny"
        : (value.outcome ?? value.decision ?? value.result);
  const outcome = String(outcomeValue ?? "").toLowerCase();
  if (!["allow", "allowed", "deny", "denied"].includes(outcome))
    throw new Error("real provider network decision has no allow/deny outcome");
  return {
    probeId:
      value.probeId ??
      value.probe_id ??
      value.requestId ??
      value.request_id ??
      fallbackProbeId,
    outcome: outcome.startsWith("allow") ? "allow" : "deny",
    reasonCode: value.reasonCode ?? value.reason_code ?? null,
    ruleId: value.ruleId ?? value.rule_id ?? null,
    destination: summarizeDestination(value.destination ?? value.url ?? null),
  };
}

function summarizeDestination(value) {
  if (typeof value !== "string") {
    if (!value || typeof value !== "object") return null;
    return {
      scheme: value.scheme ?? null,
      host: value.host ?? null,
      port: value.port ?? null,
    };
  }
  try {
    const parsed = new URL(value);
    return {
      scheme: parsed.protocol.replace(/:$/u, ""),
      host: parsed.hostname,
      port: parsed.port
        ? Number(parsed.port)
        : parsed.protocol === "https:"
          ? 443
          : 80,
    };
  } catch {
    return null;
  }
}

function sanitizeExecutionEvent(event, candidates, probeId) {
  if (isExecutionEvent(event)) {
    if (event.type === EXECUTION_EVENT_TYPES.OUTPUT)
      return {
        executionId: event.executionId,
        sequence: event.sequence,
        type: event.type,
        channel: event.channel,
        byteLength: event.byteLength,
        data: event.data,
      };
    return structuredClone(event);
  }
  return {
    type: event.type ?? event.kind ?? "network-decision",
    networkDecisions: candidates.map((candidate) =>
      normalizeNetworkDecision(candidate, probeId),
    ),
  };
}

function summarizeInventory(resources) {
  return resources.map((raw) => {
    const resource = resourceDetails(raw);
    if (!resource) return { invalid: true };
    const record = raw?.resource ?? raw?.workspace ?? raw?.gadget ?? raw;
    return {
      workspaceId: resource.workspaceId,
      gadgetId: resource.gadgetId,
      labels: resource.labels,
      fence: resource.fence,
      state: resource.state,
      workspaceDigest: extractWorkspaceDigest(raw),
      provider:
        record?.provider ??
        record?.providerName ??
        record?.providerType ??
        null,
    };
  });
}

function readConfig() {
  const baseUrl = process.env.CF_OS_BASE_URL;
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("CF_OS_BASE_URL must be an absolute HTTPS URL");
  }
  if (parsed.protocol !== "https:")
    throw new Error("real E4-T08 requires an HTTPS Cloudflare OS base URL");
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    isLocalHost(parsed.hostname)
  )
    throw new Error(
      "real E4-T08 refused a local, credentialed, or query-bearing base URL",
    );
  const testScope = process.env.CF_OS_TEST_SCOPE;
  if (!/^[A-Za-z0-9._:-]{1,64}$/u.test(testScope))
    throw new Error("CF_OS_TEST_SCOPE must be a bounded identifier");
  const gatekeeperPort = parsePort(process.env.CF_OS_GATEKEEPER_PORT);
  const gatekeeperScheme = process.env.CF_OS_GATEKEEPER_SCHEME;
  if (!["http", "https"].includes(gatekeeperScheme))
    throw new Error("CF_OS_GATEKEEPER_SCHEME must be http or https");
  const gatekeeperHost = process.env.CF_OS_GATEKEEPER_HOST;
  if (!/^[A-Za-z0-9.:[\]-]{1,253}$/u.test(gatekeeperHost))
    throw new Error("CF_OS_GATEKEEPER_HOST is invalid");
  const gatekeeperPurpose = process.env.CF_OS_GATEKEEPER_PURPOSE;
  if (!/^[A-Za-z0-9._:-]{1,96}$/u.test(gatekeeperPurpose))
    throw new Error("CF_OS_GATEKEEPER_PURPOSE is invalid");
  const lifecycleMode = process.env.CF_OS_LIFECYCLE_MODE ?? "ephemeral";
  if (!["ephemeral", "persistent"].includes(lifecycleMode))
    throw new Error("CF_OS_LIFECYCLE_MODE must be ephemeral or persistent");
  return {
    baseUrl,
    token: process.env.CF_OS_TOKEN,
    tenantId: boundedId(process.env.CF_OS_TENANT_ID, "CF_OS_TENANT_ID"),
    workspaceId: boundedId(
      process.env.CF_OS_WORKSPACE_ID,
      "CF_OS_WORKSPACE_ID",
    ),
    agentId: boundedId(process.env.CF_OS_AGENT_ID, "CF_OS_AGENT_ID"),
    testScope,
    lifecycleMode,
    timeoutMs: parsePositiveInteger(
      process.env.CF_OS_HTTP_TIMEOUT_MS ?? "5000",
      "CF_OS_HTTP_TIMEOUT_MS",
    ),
    gatekeeperScheme,
    gatekeeperHost,
    gatekeeperPort,
    gatekeeperPurpose,
    gatekeeperUrl: buildProbePolicyUrl({
      gatekeeperScheme,
      gatekeeperHost,
      gatekeeperPort,
    }),
    inboundProbeUrl: process.env.CF_OS_INBOUND_PROBE_URL,
  };
}

function boundedId(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/u.test(value))
    throw new Error(name + " must be a bounded identifier");
  return value;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("CF_OS_GATEKEEPER_PORT must be a valid port");
  return port;
}

function parsePositiveInteger(value, name) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1)
    throw new Error(name + " must be a positive integer");
  return result;
}

function isLocalHost(hostname) {
  const value = hostname.toLowerCase();
  return (
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value.endsWith(".invalid") ||
    value.endsWith(".test") ||
    value === "127.0.0.1" ||
    value === "::1" ||
    value === "[::1]"
  );
}

function uniqueSuffix() {
  return (
    Date.now().toString(36) +
    "_" +
    process.hrtime.bigint().toString(36).slice(-8)
  );
}

function formatHost(host) {
  return host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host;
}

function escapeRegExp(value) {
  return value.replace(/[|\\^$*+?.()[\]{}]/gu, "\\$&");
}

function safeError(error) {
  return {
    code: error?.code ?? "E4_T08_FAILURE",
    operation: error?.operation ?? null,
    status: error?.status ?? null,
    detail: String(error?.detail ?? error?.message ?? "unknown failure")
      .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
      .replace(/token[=:]\s*\S+/giu, "token=[REDACTED]"),
  };
}

function formatError(error) {
  const safe = safeError(error);
  return safe.code + ": " + safe.detail;
}

function writeJson(name, value) {
  return writeFile(
    path.join(evidence, name),
    JSON.stringify(value, null, 2) + "\n",
  );
}

function digestValue(value) {
  return "sha256:" + hash(canonical(value));
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
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
