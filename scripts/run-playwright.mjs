import { spawnLogged, run, stop, waitForHttp } from "./process-utils.mjs";

const emulator = spawnLogged("node", ["emulate/packages/emulate/dist/index.js", "start", "--service", "durable-streams", "--port", "4100"], {
  name: "emulate",
});

const app = spawnLogged("node", ["src/server.mjs"], {
  name: "app",
  env: {
    ...process.env,
    DURABLE_STREAMS_URL: "http://127.0.0.1:4100",
    PORT: "5175",
  },
});

try {
  await waitForHttp("http://127.0.0.1:5175/api/health");
  await run("pnpm", ["exec", "playwright", "test"], { name: "playwright" });
} finally {
  await Promise.all([stop(app), stop(emulator)]);
}
