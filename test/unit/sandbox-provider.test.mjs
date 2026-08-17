import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemorySandboxProvider,
  SANDBOX_ERROR_CODES,
  SandboxProviderError,
} from "@stream-slack/sandbox";

const RUN_ID = "rn_sandbox_contract";
const DIGEST = `sha256:${"a".repeat(64)}`;
const SPEC = {
  persistence: "ephemeral",
  requiredCapabilities: ["cancellation", "streaming-exec"],
};

function request(extra = {}) {
  return {
    runId: RUN_ID,
    invocationDigest: DIGEST,
    idempotencyKey: "ik_create",
    expectedFence: 0,
    spec: SPEC,
    ...extra,
  };
}

test("sandbox provider is idempotent and fences lifecycle mutations", async () => {
  const provider = new InMemorySandboxProvider();
  const [first, duplicate] = await Promise.all([
    provider.create(request()),
    provider.create(request()),
  ]);
  assert.deepEqual(first, duplicate);
  assert.equal(provider.sideEffects().creates, 1);

  await assert.rejects(
    provider.create(
      request({
        spec: { requiredCapabilities: [], persistence: "persistent" },
      }),
    ),
    (error) => error.code === SANDBOX_ERROR_CODES.IDEMPOTENCY_CONFLICT,
  );
  await assert.rejects(
    provider.exec({
      runId: RUN_ID,
      invocationDigest: DIGEST,
      idempotencyKey: "ik_exec",
      expectedFence: 0,
      sandboxId: first.sandboxId,
      exec: { command: "printf ok" },
    }),
    (error) => error.code === SANDBOX_ERROR_CODES.FENCE_MISMATCH,
  );

  const execution = await provider.exec({
    ...request({ idempotencyKey: "ik_exec", expectedFence: first.fence }),
    sandboxId: first.sandboxId,
    exec: { command: "printf ok" },
  });
  assert.deepEqual(
    execution,
    await provider.exec({
      ...request({ idempotencyKey: "ik_exec", expectedFence: first.fence }),
      sandboxId: first.sandboxId,
      exec: { command: "printf ok" },
    }),
  );
  assert.equal(provider.sideEffects().executions, 1);
});

test("unsupported capabilities fail before provider side effects", async () => {
  const provider = new InMemorySandboxProvider({
    capabilities: ["cancellation"],
  });
  await assert.rejects(
    provider.create(
      request({ spec: { requiredCapabilities: ["streaming-exec"] } }),
    ),
    (error) => error.code === SANDBOX_ERROR_CODES.UNSUPPORTED_CAPABILITY,
  );
  assert.deepEqual(provider.sideEffects(), {
    creates: 0,
    executions: 0,
    mutations: 0,
  });
});

test("lifecycle operations are typed and provider handles never enter public results", async () => {
  const provider = new InMemorySandboxProvider();
  const sandbox = await provider.create(request());
  assert.equal("handle" in sandbox, false);
  const execution = await provider.exec({
    ...request({ idempotencyKey: "ik_exec", expectedFence: sandbox.fence }),
    sandboxId: sandbox.sandboxId,
    exec: { command: "printf ok", stream: true },
  });
  const cancelled = await provider.cancel({
    ...request({ idempotencyKey: "ik_cancel", expectedFence: execution.fence }),
    sandboxId: sandbox.sandboxId,
  });
  assert.equal(cancelled.lifecycle, "ready");
  const suspended = await provider.suspend({
    ...request({
      idempotencyKey: "ik_suspend",
      expectedFence: cancelled.fence,
    }),
    sandboxId: sandbox.sandboxId,
  });
  const resumed = await provider.resume({
    ...request({ idempotencyKey: "ik_resume", expectedFence: suspended.fence }),
    sandboxId: sandbox.sandboxId,
  });
  const destroyed = await provider.destroy({
    ...request({ idempotencyKey: "ik_destroy", expectedFence: resumed.fence }),
    sandboxId: sandbox.sandboxId,
  });
  assert.equal(destroyed.lifecycle, "destroyed");
  assert.equal(
    JSON.stringify(provider.events()).includes("opaque-provider-handle"),
    false,
  );
  assert.equal(
    JSON.stringify(provider.events()).includes("opaque-execution-handle"),
    false,
  );
  assert.equal(
    new SandboxProviderError("x", "detail").toJSON().detail,
    "detail",
  );
});
