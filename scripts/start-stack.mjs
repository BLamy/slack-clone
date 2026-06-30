import { spawnLogged, stop, waitForHttp } from "./process-utils.mjs";

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
