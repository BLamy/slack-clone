import { run } from "./process-utils.mjs";

await run("pnpm", ["install", "--frozen-lockfile"], {
  name: "cold-root-install",
});
await run("pnpm", ["setup:emulate"], {
  name: "cold-emulator-build",
});
await run("node", ["scripts/verify-e1-t05.mjs"], {
  name: "verify-E1-T05",
  env: {
    ...process.env,
    E1_T05_NETWORK_DISABLED: "0",
    E1_T05_NO_QUERY_STORE: "1",
    TEST_RUN_ID:
      process.env.TEST_RUN_ID ??
      `cold-${process.pid}-${Date.now().toString(36)}`,
  },
});
