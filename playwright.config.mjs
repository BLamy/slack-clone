import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testIgnore: /replay-concurrent\.spec\.mjs/,
  timeout: 30000,
  expect: {
    timeout: 10000,
  },
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5175",
    trace: "on-first-retry",
  },
});
