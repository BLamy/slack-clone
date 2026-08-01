import { stat } from "node:fs/promises";

import { run } from "./process-utils.mjs";

await run("git", ["submodule", "update", "--init", "--recursive"], {
  name: "submodule",
});
await run("pnpm", ["--dir", "emulate", "install", "--frozen-lockfile"], {
  name: "emulate-install",
});
await run("pnpm", ["--dir", "emulate", "--filter", "@emulators/*", "build"], {
  name: "emulate-services",
});
await run("pnpm", ["--dir", "emulate", "--filter", "emulate", "build"], {
  name: "emulate-cli",
});
await stat("emulate/packages/emulate/dist/index.js");
console.log("PASS emulator installed and built from its lockfile");
