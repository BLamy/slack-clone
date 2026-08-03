import { run } from "./process-utils.mjs";

await run("pnpm", ["install", "--frozen-lockfile"], {
  name: "cold-root-install",
});
await run("node", ["scripts/verify-e1-t03.mjs"], {
  name: "verify-E1-T03",
  env: {
    ...process.env,
    E1_T03_NETWORK_DISABLED: "1",
    E1_T03_NO_QUERY_STORE: "1",
    TEST_RUN_ID:
      process.env.TEST_RUN_ID ??
      `cold-${process.pid}-${Date.now().toString(36)}`,
  },
});
