import { readFile } from "node:fs/promises";

import { canonicalStateJson } from "@stream-slack/reducers";

import { validateAndReplayDump } from "../src/ledger/replay.mjs";

const [command, dumpPath, expectedArgument] = process.argv.slice(2);

if (
  !command ||
  !dumpPath ||
  !["validate", "replay", "prefixes", "compare"].includes(command)
) {
  usage();
}

try {
  const dump = JSON.parse(await readFile(dumpPath, "utf8"));
  const result = validateAndReplayDump(dump);
  const output = commandOutput(command, result, dump, expectedArgument);
  process.stdout.write(`${canonicalStateJson(output)}\n`);
} catch (error) {
  process.stderr.write(
    `${canonicalStateJson({
      result: "FAIL",
      error: error.toJSON?.() ?? {
        name: error.name,
        detail: error instanceof Error ? error.message : String(error),
      },
    })}\n`,
  );
  process.exitCode = 1;
}

function commandOutput(commandName, result, dump, expected) {
  const base = {
    result: "PASS",
    task: "E0-T05",
    records: result.prefixes.length,
    finalStateDigest: result.finalStateDigest,
  };
  if (commandName === "validate") return base;
  if (commandName === "replay") {
    return {
      ...base,
      finalState: result.finalState,
      finalStateJson: result.finalStateJson,
    };
  }
  if (commandName === "prefixes") {
    return {
      ...base,
      prefixes: result.prefixes.map(({ index, offset, stateDigest }) => ({
        index,
        offset,
        stateDigest,
      })),
    };
  }

  const claimed = expected ?? dump.claimedFinalDigest;
  if (typeof claimed !== "string" || claimed.length === 0) {
    throw new Error(
      "compare requires a claimed digest argument or dump.claimedFinalDigest",
    );
  }
  if (claimed !== result.finalStateDigest) {
    const error = new Error(
      `claimed final digest ${claimed} does not match ${result.finalStateDigest}`,
    );
    error.code = "REPLAY_DIGEST_MISMATCH";
    throw error;
  }
  return { ...base, claimedFinalDigest: claimed, matches: true };
}

function usage() {
  process.stderr.write(
    "usage: node scripts/replay-ledger.mjs <validate|replay|prefixes|compare> <dump.json> [claimedDigest]\n",
  );
  process.exit(64);
}
