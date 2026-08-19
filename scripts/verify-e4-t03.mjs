import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CLOUDFLARE_OS_ERROR_CODES,
  CloudflareOsClient,
  CloudflareOsSandboxProvider,
  WorkspaceMaterializer,
  comparePublishedTrees,
  normalizeManifest,
  validateArchiveEntries,
  workspaceDigest,
} from "@stream-slack/sandbox-cloudflare-os";

const root = path.resolve(import.meta.dirname, "..");
const runId = process.env.TEST_RUN_ID ?? `e4-t03-${Date.now().toString(36)}`;
const evidence = path.resolve(
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e4-t03", runId),
);
const fixturePath = path.join(
  root,
  ".eforest/tasks/epic-4-the-cloudflare-os/E4-T03-pinned-workspace-materialization/fixtures/manifest.v1.json",
);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const manifest = normalizeManifest(fixture);
const expectedDigest = fixture.expectedWorkspaceDigest;
assert.equal(workspaceDigest(manifest), expectedDigest);
await mkdir(evidence, { recursive: true });

class FixtureProviderClient extends CloudflareOsClient {
  #resource;
  execCalls = 0;

  constructor() {
    super({
      baseUrl: "http://fixture",
      token: "fixture-token",
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
  }

  async create({ labels, spec }) {
    this.#resource = {
      workspaceId: "ws_provider",
      gadgetId: "gd_provider",
      labels: structuredClone(labels),
      spec: structuredClone(spec),
      state: "ready",
      fence: 1,
    };
    return this.#resource;
  }

  async inspect() {
    return this.#resource;
  }

  async exec() {
    this.execCalls += 1;
    this.#resource = {
      ...this.#resource,
      state: "running",
      fence: this.#resource.fence + 1,
    };
    return { ...this.#resource, executionId: "ex_provider", status: "running" };
  }
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "stream-slack-e4-t03-"));
try {
  const firstPath = path.join(tempRoot, "first", "workspace");
  const secondPath = path.join(tempRoot, "second", "workspace");
  const first = new WorkspaceMaterializer({ publicationPath: firstPath });
  const second = new WorkspaceMaterializer({ publicationPath: secondPath });
  await first.materialize(manifest, { expectedDigest });
  await second.materialize(manifest, { expectedDigest });
  const parity = await comparePublishedTrees(firstPath, secondPath);
  assert.deepEqual(parity, {
    equal: true,
    leftDigest: expectedDigest,
    rightDigest: expectedDigest,
  });
  assert.deepEqual(await first.assertExecutionReady(expectedDigest), {
    digest: expectedDigest,
    ready: true,
  });

  const providerClient = new FixtureProviderClient();
  const provider = new CloudflareOsSandboxProvider({ client: providerClient });
  const providerBase = {
    runId: "rn_e4_t03_provider",
    invocationDigest: `sha256:${"f".repeat(64)}`,
    expectedFence: 0,
    resourceIdentity: {
      tenantId: "tenant_provider",
      workspaceId: "workspace_provider",
      agentId: "agent_provider",
      invocationId: "invocation_provider",
      idempotencyKey: "ik_provider_create",
    },
    spec: { persistence: "ephemeral", requiredCapabilities: [] },
  };
  const providerSandbox = await provider.create({
    ...providerBase,
    idempotencyKey: "ik_provider_create",
  });
  await assert.rejects(
    () =>
      provider.exec({
        ...providerBase,
        idempotencyKey: "ik_provider_exec_before_materialize",
        expectedFence: providerSandbox.fence,
        sandboxId: providerSandbox.sandboxId,
        workspaceDigest: expectedDigest,
        exec: { command: "printf blocked" },
      }),
    (error) =>
      error.code === CLOUDFLARE_OS_ERROR_CODES.WORKSPACE_DIGEST_MISMATCH,
  );
  assert.equal(providerClient.execCalls, 0);
  const providerMaterializer = new WorkspaceMaterializer({
    publicationPath: path.join(tempRoot, "provider", "workspace"),
  });
  await provider.materializeWorkspace(
    {
      ...providerBase,
      idempotencyKey: "ik_provider_materialize",
      expectedFence: providerSandbox.fence,
      sandboxId: providerSandbox.sandboxId,
      workspaceDigest: expectedDigest,
    },
    manifest,
    { materializer: providerMaterializer },
  );
  const execution = await provider.exec({
    ...providerBase,
    idempotencyKey: "ik_provider_exec_after_materialize",
    expectedFence: providerSandbox.fence,
    sandboxId: providerSandbox.sandboxId,
    workspaceDigest: expectedDigest,
    exec: { command: "printf ready" },
  });
  assert.equal(execution.status, "running");
  assert.equal(providerClient.execCalls, 1);

  const hostileCases = [
    ["absolute", { path: "/etc/passwd", type: "file", content: "x" }],
    ["parent", { path: "../escape", type: "file", content: "x" }],
    ["nul", { path: "bad\0name", type: "file", content: "x" }],
    ["non-nfc", { path: "e\u0301.txt", type: "file", content: "x" }],
    ["symlink", { path: "link", type: "symlink", target: "../../escape" }],
    ["device", { path: "tty", type: "device" }],
    [
      "duplicate",
      {
        entries: [
          { path: "same", type: "file", content: "one" },
          { path: "same", type: "file", content: "two" },
        ],
      },
    ],
    [
      "file-parent",
      {
        entries: [
          { path: "a", type: "file", content: "x" },
          { path: "a/b", type: "file", content: "y" },
        ],
      },
    ],
    ["oversized", { path: "large", type: "file", content: "123" }],
  ];
  const hostileResults = [];
  for (const [name, entry] of hostileCases) {
    const candidate = entry.entries
      ? { schemaVersion: 1, entries: entry.entries }
      : { schemaVersion: 1, entries: [entry] };
    await assert.rejects(
      async () =>
        normalizeManifest(candidate, {
          maxEntryBytes: name === "oversized" ? 2 : 64,
        }),
      (error) =>
        [
          CLOUDFLARE_OS_ERROR_CODES.INVALID_TREE,
          CLOUDFLARE_OS_ERROR_CODES.PATH_REJECTED,
          CLOUDFLARE_OS_ERROR_CODES.ARCHIVE_REJECTED,
        ].includes(error.code),
    );
    hostileResults.push({ name, rejected: true });
  }
  for (const entry of [
    { path: "link", type: "symlink", target: "../../escape" },
    { path: "alias", type: "hardlink", target: "README.md" },
    { path: "device", type: "device" },
  ]) {
    await assert.rejects(
      async () => validateArchiveEntries([entry]),
      (error) => error.code === CLOUDFLARE_OS_ERROR_CODES.ARCHIVE_REJECTED,
    );
  }
  await assert.rejects(
    async () =>
      validateArchiveEntries([
        {
          path: "bomb",
          type: "file",
          compressedBytes: 1,
          uncompressedBytes: 101,
        },
      ]),
    (error) => error.code === CLOUDFLARE_OS_ERROR_CODES.ARCHIVE_REJECTED,
  );

  const corruptPath = path.join(tempRoot, "corrupt", "workspace");
  const corrupt = new WorkspaceMaterializer({ publicationPath: corruptPath });
  await corrupt.materialize(manifest, { expectedDigest });
  await assert.rejects(
    () =>
      corrupt.materialize(manifest, {
        expectedDigest,
        fault: async (boundary, details) => {
          if (boundary === "entry-written" && details.entry === "bin/run") {
            await writeFile(
              path.join(details.stage, "bin", "run"),
              Uint8Array.from([1, 2, 3]),
            );
          }
        },
      }),
    (error) =>
      error.code === CLOUDFLARE_OS_ERROR_CODES.WORKSPACE_DIGEST_MISMATCH,
  );
  assert.equal(await corrupt.currentDigest(), expectedDigest);
  await assert.rejects(
    () =>
      corrupt.assertExecutionReady(
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      ),
    (error) =>
      error.code === CLOUDFLARE_OS_ERROR_CODES.WORKSPACE_DIGEST_MISMATCH,
  );

  const nextManifest = normalizeManifest({
    ...fixture,
    entries: fixture.entries.map((entry) =>
      entry.path === "README.md"
        ? { ...entry, content: "Pinned workspace v2\n" }
        : entry,
    ),
  });
  const nextDigest = workspaceDigest(nextManifest);
  const crashPath = path.join(tempRoot, "crash", "workspace");
  const crash = new WorkspaceMaterializer({ publicationPath: crashPath });
  await crash.materialize(manifest, { expectedDigest });
  const crashMatrix = [];
  for (const boundary of [
    "manifest-validated",
    "entry-written",
    "before-publish",
    "after-publish",
  ]) {
    await assert.rejects(
      () =>
        crash.materialize(nextManifest, {
          expectedDigest: nextDigest,
          fault: async (current) => {
            if (current === boundary) throw new Error(`crash:${boundary}`);
          },
        }),
      /crash:/u,
    );
    const current = await crash.currentDigest();
    assert.ok([expectedDigest, nextDigest].includes(current));
    const snapshot = await crash.snapshot();
    assert.equal(workspaceDigest(snapshot), current);
    crashMatrix.push({ boundary, digest: current, complete: true });
  }

  const sourcePath = path.join(tempRoot, "source", "workspace");
  const source = new WorkspaceMaterializer({ publicationPath: sourcePath });
  await source.materialize(manifest, { expectedDigest });
  assert.equal(await source.currentDigest(), expectedDigest);
  await source.materialize(nextManifest, { expectedDigest: nextDigest });
  assert.equal(await source.currentDigest(), nextDigest);
  assert.notEqual(expectedDigest, nextDigest);

  await writeJson("tree-digests.json", {
    expectedDigest,
    independentMaterialization: parity,
    changedSourceDigest: nextDigest,
    executionBlockedOnMismatch: true,
  });
  await writeJson("hostile-corpus.json", {
    cases: hostileResults,
    archiveSymlinksHardlinksDevicesRejected: true,
    decompressionBombRejected: true,
  });
  await writeJson("crash-matrix.json", crashMatrix);
  await writeJson("verification-summary.json", {
    schemaVersion: 1,
    task: "E4-T03",
    runId,
    result: "PASS",
    expectedDigest,
    changedSourceDigest: nextDigest,
    replay:
      "Replay: N/A (headless workspace materialization) + mitigation: cold-clone tree parity, hostile archive corpus, crash matrix, and exact digest comparison",
  });
  console.log(
    JSON.stringify(
      {
        implementationCommit:
          process.env.E4_T03_IMPLEMENTATION_COMMIT ?? "local",
        result: "PASS",
        runId,
        expectedDigest,
        changedSourceDigest: nextDigest,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function writeJson(name, value) {
  await writeFile(
    path.join(evidence, name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}
