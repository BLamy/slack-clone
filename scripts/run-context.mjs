import path from "node:path";

import { findAvailablePortBlock, releasePortBlock } from "./process-utils.mjs";

function safeRunId(value) {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || `run-${process.pid}`;
}

function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${label} must be an integer port from 1024 through 65535`);
  }
  return port;
}

export async function createRunContext({
  env = process.env,
  mode = "test",
  random = Math.random,
} = {}) {
  const runId = safeRunId(
    env.TEST_RUN_ID ?? `e0-t02-${process.pid}-${Date.now().toString(36)}`,
  );
  const host = env.TEST_HOST ?? "127.0.0.1";
  let emulatorPort;
  let auth0Port;
  let appPort;
  let releasePortLease = async () => {};

  if (env.EMULATE_PORT || env.APP_PORT || mode === "dev") {
    emulatorPort = parsePort(env.EMULATE_PORT ?? 4100, "EMULATE_PORT");
    auth0Port = parsePort(env.AUTH0_PORT ?? emulatorPort + 1, "AUTH0_PORT");
    appPort = parsePort(env.APP_PORT ?? env.PORT ?? 5175, "APP_PORT");
  } else {
    emulatorPort = await findAvailablePortBlock(3, host, { random });
    auth0Port = emulatorPort + 1;
    appPort = emulatorPort + 2;
    let released = false;
    releasePortLease = async () => {
      if (released) return;
      released = true;
      await releasePortBlock(emulatorPort, 3, host);
    };
  }

  const artifactRoot = path.resolve(
    env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e0-t02", runId),
  );
  return {
    runId,
    host,
    emulatorPort,
    auth0Port,
    appPort,
    appBaseUrl: `http://${host}:${appPort}`,
    durableStreamsUrl: `http://${host}:${emulatorPort}`,
    auth0EmulatorUrl: `http://${host}:${auth0Port}`,
    roomPrefix: safeRunId(env.TEST_ROOM_PREFIX ?? runId),
    artifactRoot,
    playwrightOutputDir: path.join(artifactRoot, "playwright"),
    buildDir: path.join(artifactRoot, "build"),
    releasePortLease,
  };
}
