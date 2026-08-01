import {
  spawnLogged,
  stop,
  waitForExit,
  waitForHttp,
} from "./process-utils.mjs";

export async function startStack(context, options = {}) {
  const emulatorSpec = options.emulatorSpec ?? {
    command: "node",
    args: [
      "emulate/packages/emulate/dist/index.js",
      "start",
      "--service",
      "durable-streams,auth0",
      "--port",
      String(context.emulatorPort),
      "--seed",
      "emulate.config.yaml",
    ],
    name: `emulate:${context.runId}`,
  };
  const appSpec = options.appSpec ?? {
    command: "node",
    args: ["src/server.mjs"],
    name: `app:${context.runId}`,
    env: {
      ...process.env,
      DURABLE_STREAMS_URL: context.durableStreamsUrl,
      AUTH0_EMULATOR_URL: context.auth0EmulatorUrl,
      AUTH0_CLIENT_ID: "slack-clone-auth0",
      AUTH0_CLIENT_SECRET: "slack-clone-secret",
      AUTH0_REALM: "Username-Password-Authentication",
      HOST: context.host,
      PORT: String(context.appPort),
    },
  };

  const emulator = spawnLogged(emulatorSpec.command, emulatorSpec.args, {
    name: emulatorSpec.name,
    env: emulatorSpec.env,
  });
  const app = spawnLogged(appSpec.command, appSpec.args, {
    name: appSpec.name,
    env: appSpec.env,
  });
  const children = [emulator, app];
  options.onSpawn?.({ app, emulator });
  let stopping = false;
  let leaseReleased = false;

  async function releaseLease() {
    if (leaseReleased) return;
    leaseReleased = true;
    await context.releasePortLease?.();
  }

  async function shutdown() {
    if (stopping) return;
    stopping = true;
    await Promise.all(children.map((child) => stop(child)));
    await releaseLease();
  }

  const failure = Promise.race(
    children.map((child, index) =>
      waitForExit(child).then((result) => ({
        name: index === 0 ? emulatorSpec.name : appSpec.name,
        result,
      })),
    ),
  ).then(async ({ name, result }) => {
    if (stopping) return;
    await shutdown();
    const detail = result.signal
      ? `signal ${result.signal}`
      : `code ${result.code}`;
    throw new Error(`${name} exited unexpectedly with ${detail}`);
  });
  failure.catch(() => {});

  try {
    await Promise.race([
      (options.waitForReady ?? waitForHttp)(`${context.appBaseUrl}/api/health`),
      failure,
    ]);
    await releaseLease();
  } catch (error) {
    await shutdown();
    throw error;
  }

  return {
    app,
    emulator,
    context,
    failure,
    stop: shutdown,
  };
}
