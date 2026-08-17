import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CloudflareOsClient,
  CloudflareOsSandboxProvider,
} from "@stream-slack/sandbox-cloudflare-os";
import {
  InMemorySandboxProvider,
  LIFECYCLE_ERROR_CODES,
  SandboxLifecycleManager,
  compileLifecyclePolicy,
  retainedTreeDigest,
} from "@stream-slack/sandbox";

const runId = process.env.TEST_RUN_ID ?? `e4-t06-${Date.now().toString(36)}`;
const evidence = path.resolve(
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e4-t06", runId),
);
await mkdir(evidence, { recursive: true });

const INVOCATION_A = `sha256:${"a".repeat(64)}`;
const INVOCATION_B = `sha256:${"b".repeat(64)}`;
const INVOCATION_C = `sha256:${"c".repeat(64)}`;
const DECLARED_ENTRIES = [
  { path: "workspace/src/main.mjs", content: "export const version = 1;\n" },
  { path: "workspace/README.md", content: "persistent workspace\n" },
];
const UPDATED_ENTRIES = [
  { path: "workspace/src/main.mjs", content: "export const version = 2;\n" },
  { path: "workspace/README.md", content: "persistent workspace updated\n" },
];
const EXCLUDED_ENTRIES = [
  { path: "workspace/tmp/process-canary", content: "tmp-only-canary" },
  { path: "workspace/broker/socket-canary", content: "broker-only-canary" },
  { path: "workspace/proxy/identity-canary", content: "proxy-only-canary" },
  { path: "workspace/env/runtime-canary", content: "env-only-canary" },
  { path: "workspace/tool-cache/tool-canary", content: "cache-only-canary" },
  { path: "workspace/.run-cache/run-canary", content: "run-only-canary" },
  { path: "workspace/workspace-scratch/scratch-canary", content: "scratch" },
];
const ALL_ENTRIES = [...DECLARED_ENTRIES, ...EXCLUDED_ENTRIES];
const DEPLOYMENT_TOKEN = "e4-t06-provider-deployment-identity";
const RAW_SECRET_CANARY = "TOKEN=raw-secret-must-never-be-retained";

const ephemeralFirst = runEphemeralSequence();
const ephemeralReplay = runEphemeralSequence();
assert.deepEqual(
  replayShape(ephemeralFirst),
  replayShape(ephemeralReplay),
  "ephemeral lifecycle replay changed its digests",
);

const persistentFirst = await runPersistentSequence();
const persistentReplay = await runPersistentSequence();
assert.deepEqual(
  replayShape(persistentFirst),
  replayShape(persistentReplay),
  "persistent lifecycle replay changed its digests",
);

const expiry = runRetentionExpiry();
const provider = await runCloudflareProviderSequence();
await runInMemoryResetSequence();

await writeJson("ephemeral-sequence.json", {
  mode: "ephemeral",
  lineageId: ephemeralFirst.lineageId,
  lineageGeneration: ephemeralFirst.lineageGeneration,
  retainedTreeDigest: null,
  terminalDigest: ephemeralFirst.terminalDigest,
  eventDigest: ephemeralFirst.eventDigest,
  inventoryAfterTerminal: ephemeralFirst.inventoryAfterTerminal,
  excludedEntries: EXCLUDED_ENTRIES.length,
});
await writeJson("persistent-sequence.json", {
  mode: "persistent",
  lineageId: persistentFirst.lineageId,
  lineageGeneration: persistentFirst.lineageGeneration,
  firstTreeDigest: persistentFirst.firstTreeDigest,
  secondTreeDigest: persistentFirst.secondTreeDigest,
  terminalDigest: persistentFirst.terminalDigest,
  eventDigest: persistentFirst.eventDigest,
  manifestPaths: persistentFirst.manifestPaths,
  concurrentResume: persistentFirst.concurrentResume,
  oldHandlesFenced: persistentFirst.oldHandlesFenced,
  excludedEntries: EXCLUDED_ENTRIES.length,
});
await writeJson("retention-race.json", expiry);
await writeJson("provider-enforcement.json", provider);
await writeJson("verification-summary.json", {
  schemaVersion: 1,
  task: "E4-T06",
  runId,
  result: "PASS",
  ephemeralLineageDigest: ephemeralFirst.lineageDigest,
  ephemeralTreeDigest: ephemeralFirst.treeDigest,
  ephemeralTerminalDigest: ephemeralFirst.terminalDigest,
  persistentLineageDigest: persistentFirst.lineageDigest,
  persistentTreeDigest: persistentFirst.treeDigest,
  persistentTerminalDigest: persistentFirst.terminalDigest,
  persistentEventDigest: persistentFirst.eventDigest,
  retentionExpiryDigest: expiry.eventDigest,
  providerLifecycleDigest: provider.eventDigest,
  zeroSkips: true,
  replay:
    "Replay: N/A (headless sandbox lifecycle) + mitigation: cold-clone multi-run replay, provider inventory checks, canary-secret scans, and stale-lineage races",
});

for (const file of await readdir(evidence)) {
  if (!file.endsWith(".json")) continue;
  const contents = await readFile(path.join(evidence, file), "utf8");
  assert.equal(
    contents.includes(DEPLOYMENT_TOKEN),
    false,
    `${file} leaked deployment identity`,
  );
  assert.equal(
    contents.includes(RAW_SECRET_CANARY),
    false,
    `${file} leaked raw secret canary`,
  );
  for (const entry of EXCLUDED_ENTRIES)
    assert.equal(
      contents.includes(entry.content),
      false,
      `${file} retained excluded canary`,
    );
}

console.log(
  JSON.stringify(
    {
      implementationCommit: process.env.E4_T06_IMPLEMENTATION_COMMIT ?? "local",
      result: "PASS",
      runId,
      ephemeralLineageDigest: ephemeralFirst.lineageDigest,
      persistentLineageDigest: persistentFirst.lineageDigest,
      persistentTreeDigest: persistentFirst.treeDigest,
      retentionExpiryDigest: expiry.eventDigest,
      providerLifecycleDigest: provider.eventDigest,
    },
    null,
    2,
  ),
);

function runEphemeralSequence() {
  const manager = new SandboxLifecycleManager({ clock: () => 10_000 });
  const policy = compileLifecyclePolicy({
    schemaVersion: 1,
    mode: "ephemeral",
    agentId: "agent-e4-t06-ephemeral",
    lineageKey: "one-shot",
    retentionMs: 0,
  });
  const created = manager.create({
    agentId: policy.agentId,
    runId: "rn_e4_t06_ephemeral_create",
    invocationDigest: INVOCATION_A,
    policy,
    idempotencyKey: "ik_e4_t06_ephemeral_create",
  });
  const treeDigest = retainedTreeDigest(ALL_ENTRIES);
  const destroyed = manager.suspend({
    agentId: created.agentId,
    lineageId: created.lineageId,
    runId: "rn_e4_t06_ephemeral_create",
    expectedFence: created.fence,
    resumeToken: created.resumeToken,
    treeDigest,
    entries: ALL_ENTRIES,
    idempotencyKey: "ik_e4_t06_ephemeral_suspend",
  });
  assert.equal(destroyed.destroyed, true);
  assert.equal(destroyed.retainedTreeDigest, null);
  assert.deepEqual(manager.inventory({ agentId: policy.agentId }), []);
  assert.throws(
    () =>
      manager.resume({
        agentId: created.agentId,
        lineageId: created.lineageId,
        runId: "rn_e4_t06_ephemeral_resume",
        invocationDigest: INVOCATION_B,
        expectedFence: destroyed.fence,
        resumeToken: created.resumeToken,
        expectedTreeDigest: treeDigest,
        idempotencyKey: "ik_e4_t06_ephemeral_stale_resume",
      }),
    (error) => error.code === LIFECYCLE_ERROR_CODES.LINEAGE_REVOKED,
  );
  const duplicate = manager.suspend({
    agentId: created.agentId,
    lineageId: created.lineageId,
    runId: "rn_e4_t06_ephemeral_create",
    expectedFence: created.fence,
    resumeToken: created.resumeToken,
    treeDigest,
    entries: ALL_ENTRIES,
    idempotencyKey: "ik_e4_t06_ephemeral_suspend",
  });
  assert.deepEqual(duplicate, destroyed);
  assert.equal(JSON.stringify(manager.events()).includes("canary"), false);
  return summarizeManager(manager, {
    lineageId: created.lineageId,
    lineageGeneration: created.lineageGeneration,
    treeDigest,
    terminalDigest: digestValue(destroyed),
    inventoryAfterTerminal: manager.inventory({ agentId: policy.agentId })
      .length,
  });
}

async function runPersistentSequence() {
  let now = 20_000;
  const manager = new SandboxLifecycleManager({ clock: () => now });
  const policy = compileLifecyclePolicy({
    schemaVersion: 1,
    mode: "persistent",
    agentId: "agent-e4-t06-persistent",
    lineageKey: "coding",
    retentionMs: 100,
  });
  assert.throws(
    () => compileLifecyclePolicy({ ...policy, schemaVersion: 2 }),
    (error) => error.code === LIFECYCLE_ERROR_CODES.INVALID_POLICY,
  );
  assert.throws(
    () => compileLifecyclePolicy({ ...policy, encryption: "caller-managed" }),
    (error) => error.code === LIFECYCLE_ERROR_CODES.INVALID_POLICY,
  );
  const secretManager = new SandboxLifecycleManager();
  const secretCreated = secretManager.create({
    agentId: policy.agentId,
    runId: "rn_e4_t06_secret",
    invocationDigest: INVOCATION_A,
    policy,
    idempotencyKey: "ik_e4_t06_secret_create",
  });
  assert.throws(
    () =>
      secretManager.suspend({
        agentId: policy.agentId,
        lineageId: secretCreated.lineageId,
        runId: "rn_e4_t06_secret",
        expectedFence: secretCreated.fence,
        resumeToken: secretCreated.resumeToken,
        entries: [{ path: "workspace/src/secret", content: RAW_SECRET_CANARY }],
        idempotencyKey: "ik_e4_t06_secret_suspend",
      }),
    (error) => error.code === LIFECYCLE_ERROR_CODES.RETAINED_SECRET,
  );

  const created = manager.create({
    agentId: policy.agentId,
    runId: "rn_e4_t06_persistent_create",
    invocationDigest: INVOCATION_A,
    policy,
    idempotencyKey: "ik_e4_t06_persistent_create",
  });
  const duplicateCreate = manager.create({
    agentId: policy.agentId,
    runId: "rn_e4_t06_persistent_create",
    invocationDigest: INVOCATION_A,
    policy,
    idempotencyKey: "ik_e4_t06_persistent_create",
  });
  assert.deepEqual(duplicateCreate, created);

  const firstTreeDigest = retainedTreeDigest(ALL_ENTRIES);
  const suspended = manager.suspend({
    agentId: created.agentId,
    lineageId: created.lineageId,
    runId: "rn_e4_t06_persistent_create",
    expectedFence: created.fence,
    resumeToken: created.resumeToken,
    treeDigest: firstTreeDigest,
    entries: ALL_ENTRIES,
    idempotencyKey: "ik_e4_t06_persistent_suspend_1",
  });
  const duplicateSuspend = manager.suspend({
    agentId: created.agentId,
    lineageId: created.lineageId,
    runId: "rn_e4_t06_persistent_create",
    expectedFence: created.fence,
    resumeToken: created.resumeToken,
    treeDigest: firstTreeDigest,
    entries: ALL_ENTRIES,
    idempotencyKey: "ik_e4_t06_persistent_suspend_1",
  });
  assert.deepEqual(duplicateSuspend, suspended);
  assert.deepEqual(
    manager
      .retainedManifest(created.lineageId)
      .map(({ path: entryPath }) => entryPath),
    DECLARED_ENTRIES.map(({ path: entryPath }) => entryPath).sort(),
  );
  assert.equal(suspended.baseTreeDigest, null);
  assert.equal(suspended.treeDigest, firstTreeDigest);
  assert.equal(manager.inventory({ agentId: "agent-e4-t06-other" }).length, 0);

  const resumeRequest = {
    agentId: created.agentId,
    lineageId: created.lineageId,
    expectedFence: suspended.fence,
    resumeToken: suspended.resumeToken,
    expectedTreeDigest: suspended.treeDigest,
  };
  const race = await Promise.allSettled([
    Promise.resolve().then(() =>
      manager.resume({
        ...resumeRequest,
        runId: "rn_e4_t06_persistent_resume_a",
        invocationDigest: INVOCATION_B,
        idempotencyKey: "ik_e4_t06_persistent_resume_a",
      }),
    ),
    Promise.resolve().then(() =>
      manager.resume({
        ...resumeRequest,
        runId: "rn_e4_t06_persistent_resume_b",
        invocationDigest: INVOCATION_C,
        idempotencyKey: "ik_e4_t06_persistent_resume_b",
      }),
    ),
  ]);
  assert.equal(race.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(race.filter(({ status }) => status === "rejected").length, 1);
  const rejectedRace = race.find(({ status }) => status === "rejected");
  assert.equal(rejectedRace.reason.code, LIFECYCLE_ERROR_CODES.LINEAGE_BUSY);
  const resumed = race.find(({ status }) => status === "fulfilled").value;

  assert.throws(
    () =>
      manager.resume({
        ...resumeRequest,
        runId: "rn_e4_t06_persistent_stale",
        invocationDigest: INVOCATION_C,
        idempotencyKey: "ik_e4_t06_persistent_stale_resume",
      }),
    (error) => error.code === LIFECYCLE_ERROR_CODES.LINEAGE_BUSY,
  );
  assert.throws(
    () =>
      manager.suspend({
        agentId: "agent-e4-t06-other",
        lineageId: created.lineageId,
        runId: "rn_e4_t06_persistent_resume_a",
        expectedFence: resumed.fence,
        resumeToken: resumed.resumeToken,
        entries: UPDATED_ENTRIES,
        idempotencyKey: "ik_e4_t06_wrong-agent",
      }),
    (error) => error.code === LIFECYCLE_ERROR_CODES.LINEAGE_FENCE_MISMATCH,
  );

  const secondTreeDigest = retainedTreeDigest(UPDATED_ENTRIES);
  const suspendedAgain = manager.suspend({
    agentId: resumed.agentId,
    lineageId: resumed.lineageId,
    runId: "rn_e4_t06_persistent_resume_a",
    expectedFence: resumed.fence,
    resumeToken: resumed.resumeToken,
    treeDigest: secondTreeDigest,
    entries: UPDATED_ENTRIES,
    idempotencyKey: "ik_e4_t06_persistent_suspend_2",
  });
  const suspendEvent = manager
    .events()
    .find(
      ({ operation, newTreeDigest }) =>
        operation === "suspend" && newTreeDigest === secondTreeDigest,
    );
  assert.equal(suspendEvent.baseTreeDigest, firstTreeDigest);
  assert.equal(suspendEvent.newTreeDigest, secondTreeDigest);

  assert.throws(
    () =>
      manager.resume({
        agentId: resumed.agentId,
        lineageId: resumed.lineageId,
        runId: "rn_e4_t06_persistent_resume_c",
        invocationDigest: INVOCATION_C,
        expectedFence: suspendedAgain.fence,
        resumeToken: suspendedAgain.resumeToken,
        expectedTreeDigest: `sha256:${"d".repeat(64)}`,
        idempotencyKey: "ik_e4_t06_corrupt-manifest",
      }),
    (error) => error.code === LIFECYCLE_ERROR_CODES.TREE_DIGEST_MISMATCH,
  );
  assert.equal(
    manager.inventory({ agentId: policy.agentId })[0].status,
    "suspended",
  );
  const resumedAgain = manager.resume({
    agentId: resumed.agentId,
    lineageId: resumed.lineageId,
    runId: "rn_e4_t06_persistent_resume_c",
    invocationDigest: INVOCATION_C,
    expectedFence: suspendedAgain.fence,
    resumeToken: suspendedAgain.resumeToken,
    expectedTreeDigest: secondTreeDigest,
    idempotencyKey: "ik_e4_t06_persistent_resume_c_valid",
  });
  assert.equal(resumedAgain.baseTreeDigest, secondTreeDigest);

  const reset = manager.reset({
    agentId: resumedAgain.agentId,
    lineageId: resumedAgain.lineageId,
    runId: "rn_e4_t06_persistent_resume_c",
    expectedFence: resumedAgain.fence,
    resumeToken: resumedAgain.resumeToken,
    idempotencyKey: "ik_e4_t06_persistent_reset",
  });
  assert.equal(reset.treeDigest, null);
  assert.deepEqual(manager.retainedManifest(reset.lineageId), []);
  assert.throws(
    () =>
      manager.reset({
        agentId: resumedAgain.agentId,
        lineageId: resumedAgain.lineageId,
        runId: "rn_e4_t06_persistent_resume_c",
        expectedFence: resumedAgain.fence,
        resumeToken: resumedAgain.resumeToken,
        idempotencyKey: "ik_e4_t06_stale-reset",
      }),
    (error) => error.code === LIFECYCLE_ERROR_CODES.LINEAGE_FENCE_MISMATCH,
  );
  const revoked = manager.revoke({
    agentId: reset.agentId,
    lineageId: reset.lineageId,
    runId: "rn_e4_t06_persistent_resume_c",
    expectedFence: reset.fence,
    resumeToken: reset.resumeToken,
    idempotencyKey: "ik_e4_t06_persistent_revoke",
  });
  assert.equal(revoked.revoked, true);
  assert.deepEqual(manager.inventory({ agentId: policy.agentId }), []);
  assert.throws(
    () => manager.retainedManifest(reset.lineageId),
    (error) => error.code === LIFECYCLE_ERROR_CODES.LINEAGE_REVOKED,
  );
  assert.equal(JSON.stringify(manager.events()).includes("resumeToken"), false);
  assert.equal(
    JSON.stringify(manager.events()).includes("workspace/src/main.mjs"),
    false,
  );

  return summarizeManager(manager, {
    lineageId: created.lineageId,
    lineageGeneration: created.lineageGeneration,
    treeDigest: secondTreeDigest,
    firstTreeDigest,
    secondTreeDigest,
    manifestPaths: DECLARED_ENTRIES.map(
      ({ path: entryPath }) => entryPath,
    ).sort(),
    concurrentResume: {
      winners: 1,
      losers: 1,
      loserCode: rejectedRace.reason.code,
    },
    oldHandlesFenced: true,
    terminalDigest: digestValue(revoked),
  });
}

function runRetentionExpiry() {
  let now = 30_000;
  const manager = new SandboxLifecycleManager({ clock: () => now });
  const policy = compileLifecyclePolicy({
    mode: "persistent",
    agentId: "agent-e4-t06-expiry",
    lineageKey: "expiry",
    retentionMs: 50,
  });
  const created = manager.create({
    agentId: policy.agentId,
    runId: "rn_e4_t06_expiry_create",
    invocationDigest: INVOCATION_A,
    policy,
    idempotencyKey: "ik_e4_t06_expiry_create",
  });
  const suspended = manager.suspend({
    agentId: created.agentId,
    lineageId: created.lineageId,
    runId: "rn_e4_t06_expiry_create",
    expectedFence: created.fence,
    resumeToken: created.resumeToken,
    treeDigest: retainedTreeDigest(DECLARED_ENTRIES),
    entries: DECLARED_ENTRIES,
    idempotencyKey: "ik_e4_t06_expiry_suspend",
  });
  now = suspended.fence === 2 ? 30_050 : 30_051;
  assert.deepEqual(manager.expire(), [created.lineageId]);
  assert.deepEqual(manager.inventory({ agentId: policy.agentId }), []);
  assert.throws(
    () =>
      manager.resume({
        agentId: created.agentId,
        lineageId: created.lineageId,
        runId: "rn_e4_t06_expiry_resume",
        invocationDigest: INVOCATION_B,
        expectedFence: suspended.fence,
        resumeToken: suspended.resumeToken,
        expectedTreeDigest: suspended.treeDigest,
        idempotencyKey: "ik_e4_t06_expiry_resume",
      }),
    (error) => error.code === LIFECYCLE_ERROR_CODES.RETENTION_EXPIRED,
  );
  return {
    expiredLineages: [created.lineageId],
    inventoryAfterExpiry: 0,
    eventDigest: manager.digest(),
    terminalDigest: digestValue(manager.events().at(-1)),
  };
}

async function runCloudflareProviderSequence() {
  const requests = [];
  let remote = null;
  let destroyedStorage = false;
  const client = new CloudflareOsClient({
    baseUrl: "http://fixture.invalid",
    token: DEPLOYMENT_TOKEN,
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      const body = options.body === undefined ? null : JSON.parse(options.body);
      requests.push({ method: options.method, path: parsed.pathname, body });
      if (parsed.pathname === "/v1/workspaces" && options.method === "POST") {
        remote = {
          workspaceId: "ws_e4_t06",
          gadgetId: "gd_e4_t06",
          labels: body.labels,
          spec: body.spec,
          state: "ready",
          fence: 1,
        };
        return jsonResponse(remote);
      }
      if (parsed.pathname === "/v1/workspaces" && options.method === "GET")
        return jsonResponse({
          resources: remote && !destroyedStorage ? [remote] : [],
        });
      if (options.method === "GET") return jsonResponse(remote);
      const operation = parsed.pathname.split("/").at(-1);
      if (operation === "destroy") destroyedStorage = true;
      remote = {
        ...remote,
        state:
          operation === "suspend"
            ? "suspended"
            : operation === "destroy"
              ? "destroyed"
              : "ready",
        fence: remote.fence + 1,
      };
      return jsonResponse(remote);
    },
  });
  const provider = new CloudflareOsSandboxProvider({ client });
  const base = {
    runId: "rn_e4_t06_cloudflare",
    invocationDigest: INVOCATION_A,
    expectedFence: 0,
    resourceIdentity: {
      tenantId: "tenant_e4_t06",
      workspaceId: "workspace_e4_t06",
      agentId: "agent_e4_t06_cloudflare",
      invocationId: "invocation_e4_t06",
      idempotencyKey: "ik_e4_t06_cloudflare_create",
    },
    spec: { persistence: "persistent", requiredCapabilities: ["persistence"] },
  };
  const created = await provider.create({
    ...base,
    idempotencyKey: "ik_e4_t06_cloudflare_create",
  });
  const suspended = await provider.suspend({
    ...base,
    sandboxId: created.sandboxId,
    expectedFence: created.fence,
    idempotencyKey: "ik_e4_t06_cloudflare_suspend",
  });
  const resumed = await provider.resume({
    ...base,
    sandboxId: created.sandboxId,
    expectedFence: suspended.fence,
    idempotencyKey: "ik_e4_t06_cloudflare_resume",
  });
  const reset = await provider.reset({
    ...base,
    sandboxId: created.sandboxId,
    expectedFence: resumed.fence,
    idempotencyKey: "ik_e4_t06_cloudflare_reset",
  });
  const destroyed = await provider.destroy({
    ...base,
    sandboxId: created.sandboxId,
    expectedFence: reset.fence,
    idempotencyKey: "ik_e4_t06_cloudflare_destroy",
  });
  assert.equal(destroyed.lifecycle, "destroyed");
  assert.equal(destroyedStorage, true);
  assert.deepEqual(await client.inventory(base.resourceIdentity), {
    resources: [],
  });
  assert.equal(
    await provider.reconcile({
      ...base,
      sandboxId: created.sandboxId,
      expectedFence: destroyed.fence,
    }),
    null,
  );
  assert.deepEqual(
    requests
      .filter(({ method }) => method === "POST")
      .map(({ path: requestPath }) => requestPath.split("/").at(-1)),
    ["workspaces", "suspend", "resume", "reset", "destroy"],
  );
  assert.equal(JSON.stringify(requests).includes(DEPLOYMENT_TOKEN), false);
  assert.equal(JSON.stringify(requests).includes(RAW_SECRET_CANARY), false);
  assert.equal(
    JSON.stringify(provider.events()).includes(DEPLOYMENT_TOKEN),
    false,
  );
  return {
    eventDigest: digestValue(provider.events()),
    providerEventCount: provider.events().length,
    remoteDestroyed: destroyedStorage,
    inventoryAfterDestroy: 0,
    lifecycleOperations: ["create", "suspend", "resume", "reset", "destroy"],
    auditOperations: client.audit().map(({ operation }) => operation),
  };
}

async function runInMemoryResetSequence() {
  const provider = new InMemorySandboxProvider();
  const base = {
    runId: "rn_e4_t06_inmemory",
    invocationDigest: INVOCATION_A,
    expectedFence: 0,
    idempotencyKey: "ik_e4_t06_inmemory_create",
    spec: { persistence: "persistent", requiredCapabilities: [] },
  };
  const created = await provider.create(base);
  const suspended = await provider.suspend({
    ...base,
    sandboxId: created.sandboxId,
    expectedFence: created.fence,
    idempotencyKey: "ik_e4_t06_inmemory_suspend",
  });
  const resumed = await provider.resume({
    ...base,
    sandboxId: created.sandboxId,
    expectedFence: suspended.fence,
    idempotencyKey: "ik_e4_t06_inmemory_resume",
  });
  const reset = await provider.reset({
    ...base,
    sandboxId: created.sandboxId,
    expectedFence: resumed.fence,
    idempotencyKey: "ik_e4_t06_inmemory_reset",
  });
  assert.equal(reset.lifecycle, "ready");
  assert.notEqual(reset.fence, resumed.fence);
}

function summarizeManager(manager, extra) {
  const events = manager.events();
  return {
    ...extra,
    lineageDigest: digestValue({
      lineageId: extra.lineageId,
      lineageGeneration: extra.lineageGeneration,
    }),
    eventDigest: manager.digest(),
    terminalDigest: extra.terminalDigest ?? digestValue(events.at(-1)),
    treeDigest: extra.treeDigest ?? null,
  };
}

function replayShape(value) {
  return {
    lineageId: value.lineageId,
    lineageGeneration: value.lineageGeneration,
    lineageDigest: value.lineageDigest,
    treeDigest: value.treeDigest,
    eventDigest: value.eventDigest,
    terminalDigest: value.terminalDigest,
  };
}

function digestValue(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function writeJson(name, value) {
  await writeFile(
    path.join(evidence, name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}
