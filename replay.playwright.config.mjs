import { defineConfig } from "@playwright/test";
import { devices as replayDevices, replayReporter } from "@replayio/playwright";

export default defineConfig({
  testDir: "./tests",
  testMatch: /replay-concurrent\.spec\.mjs/,
  timeout: 60000,
  fullyParallel: true,
  workers: 2,
  reporter: [["list"], replayReporter({ upload: false })],
  expect: {
    timeout: 15000,
  },
  projects: [
    {
      name: "replay-chromium",
      use: {
        ...replayDevices["Replay Chromium"],
        baseURL: "http://127.0.0.1:5175",
      },
    },
  ],
});
