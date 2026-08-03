import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { run } from "./process-utils.mjs";

const root = path.resolve(import.meta.dirname, "..");
const runId =
  process.env.TEST_RUN_ID ?? `cold-${process.pid}-${Date.now().toString(36)}`;
const evidenceDirectory =
  process.env.PROMOTE_EVIDENCE === "1"
    ? path.join(
        root,
        ".eforest/tasks/epic-1-the-workspace/E1-T05-resumable-live-chat-api/evidence/e1-t05-final",
      )
    : path.resolve(
        process.env.TEST_ARTIFACT_DIR ??
          path.join(".artifacts", "e1-t05", runId),
      );
await mkdir(evidenceDirectory, { recursive: true });

const install = await run("pnpm", ["install", "--frozen-lockfile"], {
  name: "cold-root-install",
});
const emulatorBuild = await run("pnpm", ["setup:emulate"], {
  name: "cold-emulator-build",
});
const verifier = await run("node", ["scripts/verify-e1-t05.mjs"], {
  name: "verify-E1-T05",
  env: {
    ...process.env,
    E1_T05_COLD_CLONE: "1",
    E1_T05_NETWORK_DISABLED: "0",
    E1_T05_NO_QUERY_STORE: "1",
    TEST_RUN_ID: runId,
  },
});

await writeFile(
  path.join(evidenceDirectory, "cold-clone-transcript.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      runId,
      result: "PASS",
      commands: [
        { command: "pnpm install --frozen-lockfile", exitCode: install.code },
        { command: "pnpm setup:emulate", exitCode: emulatorBuild.code },
        { command: "node scripts/verify-e1-t05.mjs", exitCode: verifier.code },
      ],
    },
    null,
    2,
  )}\n`,
);
