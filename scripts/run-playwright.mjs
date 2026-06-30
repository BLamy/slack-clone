import { spawnLogged, run, stop, waitForHttp } from "./process-utils.mjs";

const emulator = spawnLogged(
  "node",
  [
    "emulate/packages/emulate/dist/index.js",
    "start",
    "--service",
    "durable-streams,auth0",
    "--port",
    "4100",
    "--seed",
    "emulate.config.yaml",
  ],
  {
    name: "emulate",
  },
);

const app = spawnLogged("node", ["src/server.mjs"], {
  name: "app",
  env: {
    ...process.env,
    DURABLE_STREAMS_URL: "http://127.0.0.1:4100",
    AUTH0_EMULATOR_URL: "http://127.0.0.1:4101",
    AUTH0_CLIENT_ID: "slack-clone-auth0",
    AUTH0_CLIENT_SECRET: "slack-clone-secret",
    AUTH0_REALM: "Username-Password-Authentication",
    PORT: "5175",
  },
});

try {
  await waitForHttp("http://127.0.0.1:5175/api/health");
  await run("pnpm", ["exec", "playwright", "test"], { name: "playwright" });
} finally {
  await Promise.all([stop(app), stop(emulator)]);
}
