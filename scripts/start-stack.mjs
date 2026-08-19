import { createRunContext } from "./run-context.mjs";
import { startStack } from "./test-stack.mjs";

const context = await createRunContext({ mode: "dev" });
const stack = await startStack(context);
let shuttingDown = false;

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  await stack.stop();
  process.exit(exitCode);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

console.log(`stack ready at ${context.appBaseUrl}`);
try {
  await stack.failure;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await shutdown(1);
}
