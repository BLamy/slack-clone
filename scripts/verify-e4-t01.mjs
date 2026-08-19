import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import {
  InMemorySandboxProvider,
  SANDBOX_ERROR_CODES,
} from "@stream-slack/sandbox";

const runId = process.env.TEST_RUN_ID ?? `e4-t01-${Date.now().toString(36)}`;
const evidence = path.resolve(
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e4-t01", runId),
);
await mkdir(evidence, { recursive: true });
const runIdValue = "rn_e4_t01_contract";
const invocationDigest = `sha256:${"b".repeat(64)}`;
const base = {
  runId: runIdValue,
  invocationDigest,
  expectedFence: 0,
  spec: {
    persistence: "ephemeral",
    requiredCapabilities: ["cancellation", "streaming-exec"],
  },
};

const provider = new InMemorySandboxProvider();
const [created, duplicate] = await Promise.all([
  provider.create({ ...base, idempotencyKey: "ik_create" }),
  provider.create({ ...base, idempotencyKey: "ik_create" }),
]);
assert.deepEqual(created, duplicate);
assert.equal(provider.sideEffects().creates, 1);
await assert.rejects(
  provider.create({
    ...base,
    idempotencyKey: "ik_create",
    spec: { requiredCapabilities: [] },
  }),
  (error) => error.code === SANDBOX_ERROR_CODES.IDEMPOTENCY_CONFLICT,
);
const execution = await provider.exec({
  ...base,
  idempotencyKey: "ik_exec",
  expectedFence: created.fence,
  sandboxId: created.sandboxId,
  exec: { command: "printf sandbox", stream: true },
});
assert.deepEqual(
  execution,
  await provider.exec({
    ...base,
    idempotencyKey: "ik_exec",
    expectedFence: created.fence,
    sandboxId: created.sandboxId,
    exec: { command: "printf sandbox", stream: true },
  }),
);
assert.equal(provider.sideEffects().executions, 1);
const cancelled = await provider.cancel({
  ...base,
  idempotencyKey: "ik_cancel",
  expectedFence: execution.fence,
  sandboxId: created.sandboxId,
});
const suspended = await provider.suspend({
  ...base,
  idempotencyKey: "ik_suspend",
  expectedFence: cancelled.fence,
  sandboxId: created.sandboxId,
});
const resumed = await provider.resume({
  ...base,
  idempotencyKey: "ik_resume",
  expectedFence: suspended.fence,
  sandboxId: created.sandboxId,
});
const destroyed = await provider.destroy({
  ...base,
  idempotencyKey: "ik_destroy",
  expectedFence: resumed.fence,
  sandboxId: created.sandboxId,
});
assert.equal(destroyed.lifecycle, "destroyed");
await assert.rejects(
  provider.exec({
    ...base,
    idempotencyKey: "ik_stale",
    expectedFence: 1,
    sandboxId: created.sandboxId,
    exec: { command: "printf stale" },
  }),
  (error) => error.code === SANDBOX_ERROR_CODES.FENCE_MISMATCH,
);
const unsupported = new InMemorySandboxProvider({
  capabilities: ["cancellation"],
});
await assert.rejects(
  unsupported.create({
    ...base,
    idempotencyKey: "ik_unsupported",
    spec: { requiredCapabilities: ["streaming-exec"] },
  }),
  (error) => error.code === SANDBOX_ERROR_CODES.UNSUPPORTED_CAPABILITY,
);
assert.equal(unsupported.sideEffects().creates, 0);
const serialized = JSON.stringify(provider.events());
assert.equal(serialized.includes("opaque-provider-handle"), false);
assert.equal(serialized.includes("opaque-execution-handle"), false);

const first = replay(provider.events());
const second = replay(structuredClone(provider.events()));
assert.equal(first.digest, second.digest);
assert.equal(first.events, 6);
await writeJson("lifecycle-events.json", provider.events());
await writeJson("capabilities.json", provider.discover());
await writeJson("sensitivity.json", {
  staleFenceRefused: true,
  unsupportedCapabilityRefused: true,
  result: "PASS",
});
await writeJson("verification-summary.json", {
  schemaVersion: 1,
  task: "E4-T01",
  runId,
  result: "PASS",
  lifecycleDigest: first.digest,
  replayedTwiceWithIdenticalDigest: true,
  sideEffects: provider.sideEffects(),
  replay:
    "Replay: N/A (headless sandbox contract; no browser surface) + mitigation: cold-clone conformance, lifecycle event replay, digest equality, and mutation sensitivity",
});
const files = (await readdir(evidence))
  .filter((name) => name.endsWith(".json"))
  .sort();
for (const file of files) {
  const contents = await readFile(path.join(evidence, file), "utf8");
  assert.equal(
    /(?:Bearer\s+|api[_-]?key\s*[:=]|opaque-(?:provider|execution)-handle)/iu.test(
      contents,
    ),
    false,
    `${file} leaked sensitive material`,
  );
}
console.log(
  JSON.stringify(
    {
      implementationCommit: process.env.E4_T01_IMPLEMENTATION_COMMIT ?? "local",
      result: "PASS",
      runId,
      lifecycleDigest: first.digest,
    },
    null,
    2,
  ),
);

async function writeJson(name, value) {
  await writeFile(
    path.join(evidence, name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}
function replay(events) {
  const state = events.map(({ type, data }) => ({
    type,
    lifecycle: data.lifecycle ?? null,
    sandboxId: data.sandboxId ?? null,
    executionId: data.executionId ?? null,
  }));
  return {
    events: state.length,
    digest: `sha256:${createHash("sha256").update(JSON.stringify(state)).digest("hex")}`,
  };
}
