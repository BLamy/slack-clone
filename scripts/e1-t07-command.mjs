import { spawnSync } from "node:child_process";

const command = process.argv[2];
if (!["rebuild", "catch-up", "corruption", "shadow"].includes(command)) {
  throw new Error(
    "usage: node scripts/e1-t07-command.mjs rebuild|catch-up|corruption|shadow",
  );
}

const result = spawnSync(process.execPath, ["scripts/verify-e1-t07.mjs"], {
  env: { ...process.env, E1_T07_COMMAND: command },
  stdio: "inherit",
});
process.exitCode = result.status ?? 1;
