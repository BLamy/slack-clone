import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: /stack-isolation\.spec\.mjs/,
  outputDir:
    process.env.PLAYWRIGHT_OUTPUT_DIR ??
    ".artifacts/e0-t02/isolation/playwright",
  timeout: 45000,
  workers: 1,
  expect: { timeout: 10000 },
  use: {
    baseURL: process.env.APP_BASE_URL,
    trace: "on-first-retry",
  },
});
