import {
  CloudflareOsClient,
  CloudflareOsSandboxProvider,
} from "@stream-slack/sandbox-cloudflare-os";

const required = [
  "CF_OS_BASE_URL",
  "CF_OS_TOKEN",
  "CF_OS_TENANT_ID",
  "CF_OS_WORKSPACE_ID",
  "CF_OS_AGENT_ID",
  "CF_OS_TEST_SCOPE",
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(
    `SKIPPED: missing explicit Cloudflare OS configuration: ${missing.join(", ")}`,
  );
  process.exitCode = 2;
} else {
  await runRealLifecycle();
}

async function runRealLifecycle() {
  const suffix = `e4-t02-${Date.now().toString(36)}`;
  const client = new CloudflareOsClient({
    baseUrl: process.env.CF_OS_BASE_URL,
    token: process.env.CF_OS_TOKEN,
    fetchImpl: globalThis.fetch,
    timeoutMs: 5000,
    maxAttempts: 3,
  });
  const provider = new CloudflareOsSandboxProvider({ client });
  const base = {
    runId: `rn_${suffix}`,
    invocationDigest: `sha256:${"d".repeat(64)}`,
    expectedFence: 0,
    resourceIdentity: {
      tenantId: process.env.CF_OS_TENANT_ID,
      workspaceId: process.env.CF_OS_WORKSPACE_ID,
      agentId: process.env.CF_OS_AGENT_ID,
      invocationId: `${process.env.CF_OS_TEST_SCOPE}_${suffix}`,
      idempotencyKey: `${suffix}-create`,
    },
    spec: {
      persistence: "ephemeral",
      requiredCapabilities: ["persistence"],
      testScope: process.env.CF_OS_TEST_SCOPE,
    },
  };
  let sandbox;
  try {
    sandbox = await provider.create({
      ...base,
      idempotencyKey: `${suffix}-create`,
    });
    sandbox = await provider.inspect({
      ...base,
      idempotencyKey: `${suffix}-inspect`,
      sandboxId: sandbox.sandboxId,
    });
    sandbox = await provider.suspend({
      ...base,
      idempotencyKey: `${suffix}-suspend`,
      expectedFence: sandbox.fence,
      sandboxId: sandbox.sandboxId,
    });
    sandbox = await provider.resume({
      ...base,
      idempotencyKey: `${suffix}-resume`,
      expectedFence: sandbox.fence,
      sandboxId: sandbox.sandboxId,
    });
    const destroyed = await provider.destroy({
      ...base,
      idempotencyKey: `${suffix}-destroy`,
      expectedFence: sandbox.fence,
      sandboxId: sandbox.sandboxId,
    });
    if (destroyed.lifecycle !== "destroyed")
      throw new Error("real gate did not destroy the resource");
    const remaining = await provider.reconcile({
      ...base,
      idempotencyKey: `${suffix}-reconcile`,
      expectedFence: destroyed.fence,
      sandboxId: destroyed.sandboxId,
    });
    if (remaining !== null)
      throw new Error("real gate found an orphaned resource");
    console.log(
      JSON.stringify(
        {
          result: "PASS",
          scope: process.env.CF_OS_TEST_SCOPE,
          resourceDestroyed: true,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (sandbox) {
      try {
        await provider.destroy({
          ...base,
          idempotencyKey: `${suffix}-cleanup`,
          expectedFence: sandbox.fence,
          sandboxId: sandbox.sandboxId,
        });
      } catch {
        // Preserve the original typed provider failure; cleanup failure is reported below.
      }
    }
    throw error;
  }
}
