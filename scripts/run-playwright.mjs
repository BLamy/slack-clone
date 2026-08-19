import { mkdir } from "node:fs/promises";

import { run } from "./process-utils.mjs";
import { createRunContext } from "./run-context.mjs";
import { startStack } from "./test-stack.mjs";

const context = await createRunContext();
await mkdir(context.playwrightOutputDir, { recursive: true });
const streamProofPath = `${context.artifactRoot}/stream-proof.json`;
const stack = await startStack(context);
const playwrightArgs = ["exec", "playwright", "test"];
if (process.env.PLAYWRIGHT_GREP)
  playwrightArgs.push("--grep", process.env.PLAYWRIGHT_GREP);

try {
  await Promise.race([
    run("pnpm", playwrightArgs, {
      name: `playwright:${context.runId}`,
      env: {
        ...process.env,
        APP_BASE_URL: context.appBaseUrl,
        AUTH0_EMULATOR_URL: context.auth0EmulatorUrl,
        DURABLE_STREAMS_URL: context.durableStreamsUrl,
        PLAYWRIGHT_OUTPUT_DIR: context.playwrightOutputDir,
        STREAM_PROOF_PATH: streamProofPath,
        TEST_ROOM_PREFIX: context.roomPrefix,
        TEST_RUN_ID: context.runId,
      },
    }),
    stack.failure,
  ]);
} finally {
  await stack.stop();
}
