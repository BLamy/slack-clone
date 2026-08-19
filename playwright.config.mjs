import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testIgnore: [/replay-concurrent\.spec\.mjs/, /stack-isolation\.spec\.mjs/],
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? "test-results/playwright",
  timeout: 30000,
  expect: {
    timeout: 10000,
  },
  workers: 1,
  use: {
    baseURL: process.env.APP_BASE_URL ?? "http://127.0.0.1:5175",
    trace: "on-first-retry",
  },
});
