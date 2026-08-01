import { run } from "./process-utils.mjs";

await run("pnpm", ["install", "--frozen-lockfile"], { name: "root-install" });
await run("node", ["scripts/setup-emulator.mjs"], { name: "emulator-setup" });
await run("pnpm", ["verify"], {
  name: "verify-E0-T02",
  env: {
    ...process.env,
    TEST_RUN_ID:
      process.env.TEST_RUN_ID ??
      `cold-${process.pid}-${Date.now().toString(36)}`,
  },
});
