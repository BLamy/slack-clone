import { run, spawnLogged, stop, waitForHttp } from "./process-utils.mjs";

await run("pnpm", ["build"], { name: "client-build" });

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

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await Promise.all([stop(app), stop(emulator)]);
}

process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
process.on("exit", () => {
  app.kill("SIGTERM");
  emulator.kill("SIGTERM");
});

await waitForHttp("http://127.0.0.1:5175/api/health");
console.log("stack ready at http://127.0.0.1:5175");
