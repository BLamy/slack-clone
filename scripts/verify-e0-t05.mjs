import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { analyzeModuleSource } from "../tools/import-analysis.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const runId = String(
  process.env.TEST_RUN_ID ?? `verify-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/gu, "-");
const implementationCommit = String(
  process.env.E0_T05_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }),
).trim();
assert.match(
  implementationCommit,
  /^[0-9a-f]{40}$/u,
  "E0-T05 evidence requires an exact implementation commit",
);
if (process.env.PROMOTE_EVIDENCE === "1") {
  const trackedChanges = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    { cwd: root, encoding: "utf8" },
  ).trim();
  assert.equal(
    trackedChanges,
    "",
    "promoted E0-T05 evidence must start from a clean tracked implementation tree",
  );
}

const artifactRoot = path.resolve(
  root,
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e0-t05", runId),
);
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-0-the-ledger/E0-T05-reducers-digests-and-replay-cli",
);
const taskEvidenceDirectory = path.join(taskDirectory, "evidence");
const validDirectory = path.join(taskDirectory, "fixtures/valid");
const invalidDirectory = path.join(taskDirectory, "fixtures/invalid");
const cliEnvironment = {
  ...process.env,
  E0_T05_NETWORK_DISABLED: "1",
  E0_T05_NO_QUERY_STORE: "1",
  QUERY_STORE_PATH: path.join(artifactRoot, "query-store-must-not-exist"),
  BUILD_CACHE_PATH: path.join(artifactRoot, "build-cache-must-not-exist"),
};

await mkdir(artifactRoot, { recursive: true });
const validFixtureNames = ["ledger-log.v1.json", "message-and-run-log.v1.json"];
const invalidFixtureNames = [
  "duplicate-logical-id.json",
  "invalid-offset.json",
  "illegal-transition.json",
  "malformed-envelope.json",
  "unknown-event-type.json",
];
const gates = [];
const prefixEvidence = {};
const replayEvidence = {};
const invalidEvidence = {};
const mutationEvidence = {};
const provenanceEvidence = {};

for (const fixtureName of validFixtureNames) {
  const fixturePath = path.join(validDirectory, fixtureName);
  const first = await runCli(["replay", fixturePath], {
    ...cliEnvironment,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
  });
  const second = await runCli(["replay", fixturePath], {
    ...cliEnvironment,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TZ: "America/New_York",
  });
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(
    first.stdout,
    second.stdout,
    `${fixtureName} changed across fresh locale/timezone processes`,
  );

  const firstOutput = JSON.parse(first.stdout);
  const prefixes = await runCli(["prefixes", fixturePath], cliEnvironment);
  assert.equal(prefixes.code, 0, prefixes.stderr);
  const prefixOutput = JSON.parse(prefixes.stdout);
  const compare = await runCli(
    ["compare", fixturePath, firstOutput.finalStateDigest],
    cliEnvironment,
  );
  assert.equal(compare.code, 0, compare.stderr);
  assert.equal(JSON.parse(compare.stdout).matches, true);
  const validate = await runCli(["validate", fixturePath], cliEnvironment);
  assert.equal(validate.code, 0, validate.stderr);

  replayEvidence[fixtureName] = {
    bytesIdenticalAcrossFreshProcesses: first.stdout === second.stdout,
    finalStateDigest: firstOutput.finalStateDigest,
    finalStateJson: firstOutput.finalStateJson,
    replayOutputBytes: first.stdout.length,
    validation: JSON.parse(validate.stdout),
  };
  prefixEvidence[fixtureName] = prefixOutput.prefixes;
}

const invalidExpectations = {
  "duplicate-logical-id.json": {
    code: "REDUCER_DUPLICATE_LOGICAL_ID",
    offset: "0000000000000002_0000000000000006",
  },
  "invalid-offset.json": {
    code: "REDUCER_INVALID_OFFSET",
    offset: "not-an-offset",
  },
  "illegal-transition.json": {
    code: "REDUCER_ILLEGAL_TRANSITION",
    offset: "0000000000000002_0000000000000004",
  },
  "malformed-envelope.json": {
    code: "REPLAY_INVALID_ENVELOPE",
    offset: "0000000000000002_0000000000000002",
  },
  "unknown-event-type.json": {
    code: "REPLAY_INVALID_ENVELOPE",
    offset: "0000000000000002_0000000000000001",
  },
};
for (const fixtureName of invalidFixtureNames) {
  const fixturePath = path.join(invalidDirectory, fixtureName);
  const result = await runCli(["validate", fixturePath], cliEnvironment);
  const expected = invalidExpectations[fixtureName];
  assert.notEqual(result.code, 0, `${fixtureName} was silently accepted`);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.error.code, expected.code);
  assert.equal(failure.error.offset, expected.offset);
  invalidEvidence[fixtureName] = {
    code: failure.error.code,
    offset: failure.error.offset,
    path: failure.error.path,
  };
}

for (const fixtureName of validFixtureNames) {
  const fixturePath = path.join(validDirectory, fixtureName);
  const source = await readFile(fixturePath, "utf8");
  const mutation = mutateOneSemanticByte(fixtureName, source);
  const mutationPath = path.join(artifactRoot, `mutated-${fixtureName}`);
  await writeFile(mutationPath, mutation.text);
  const result = await runCli(["replay", mutationPath], cliEnvironment);
  if (result.code === 0) {
    const mutatedOutput = JSON.parse(result.stdout);
    assert.notEqual(
      mutatedOutput.finalStateDigest,
      replayEvidence[fixtureName].finalStateDigest,
      `${fixtureName} semantic byte mutation did not change final digest`,
    );
    mutationEvidence[fixtureName] = {
      changedBytes: 1,
      outcome: "digest-changed",
      finalStateDigest: mutatedOutput.finalStateDigest,
    };
  } else {
    const failure = JSON.parse(result.stderr);
    assert.ok(failure.error);
    mutationEvidence[fixtureName] = {
      changedBytes: 1,
      error: failure.error.code,
      offset: failure.error.offset,
      outcome: "validation-failed",
    };
  }
}

for (const fixtureName of validFixtureNames) {
  const fixturePath = path.join(validDirectory, fixtureName);
  const originalDump = JSON.parse(await readFile(fixturePath, "utf8"));
  const cases = [
    [
      "serverTimestamp",
      (event) => {
        event.serverTimestamp = "2026-01-01T00:00:00.010Z";
      },
    ],
    [
      "correlationId",
      (event) => {
        event.correlationId = "cr_bbbbbbbbbbbbbbbbbbbbbbbbbb";
      },
    ],
    [
      "idempotencyKey",
      (event) => {
        event.idempotencyKey = "ik_bbbbbbbbbbbbbbbbbbbbbbbbbb";
      },
    ],
    [
      "actorId",
      (event) => {
        event.actorId =
          "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
      },
    ],
    [
      "eventId",
      (event) => {
        event.eventId = "ev_zzzzzzzzzzzzzzzzzzzzzzzzzz";
      },
    ],
    [
      "schemaVersion",
      (event) => {
        event.schemaVersion = 2;
      },
    ],
    [
      "offset",
      (...args) => {
        args.at(1).records.at(0).offset = "0000000000000000_000000000000000a";
      },
    ],
  ];
  const results = [];
  for (const [name, mutate] of cases) {
    const mutatedDump = structuredClone(originalDump);
    mutate(mutatedDump.records.at(0).event, mutatedDump);
    const mutatedPath = path.join(
      artifactRoot,
      `provenance-${fixtureName}-${name}.json`,
    );
    await writeFile(mutatedPath, `${JSON.stringify(mutatedDump)}\n`);
    const result = await runCli(["replay", mutatedPath], cliEnvironment);
    if (result.code === 0) {
      const mutatedOutput = JSON.parse(result.stdout);
      assert.notEqual(
        mutatedOutput.finalStateDigest,
        replayEvidence[fixtureName].finalStateDigest,
        `${fixtureName} ${name} mutation did not change final digest`,
      );
      results.push({
        finalStateDigest: mutatedOutput.finalStateDigest,
        name,
        outcome: "digest-changed",
      });
    } else {
      const failure = JSON.parse(result.stderr);
      assert.ok(failure.error);
      results.push({
        code: failure.error.code,
        name,
        offset: failure.error.offset,
        outcome: "validation-failed",
      });
    }
  }

  const sourceBaseline = structuredClone(originalDump);
  sourceBaseline.records.at(0).event.causation = {
    digest:
      "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    offset: "0000000000000000_0000000000000001",
    stream: "channel:ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc",
  };
  const sourceMutated = structuredClone(sourceBaseline);
  sourceMutated.records.at(0).event.causation.digest =
    "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const sourceBaselinePath = path.join(
    artifactRoot,
    `provenance-${fixtureName}-source-baseline.json`,
  );
  const sourceMutatedPath = path.join(
    artifactRoot,
    `provenance-${fixtureName}-source-mutated.json`,
  );
  await writeFile(sourceBaselinePath, `${JSON.stringify(sourceBaseline)}\n`);
  await writeFile(sourceMutatedPath, `${JSON.stringify(sourceMutated)}\n`);
  const sourceBaselineResult = await runCli(
    ["replay", sourceBaselinePath],
    cliEnvironment,
  );
  const sourceMutatedResult = await runCli(
    ["replay", sourceMutatedPath],
    cliEnvironment,
  );
  assert.equal(sourceBaselineResult.code, 0, sourceBaselineResult.stderr);
  assert.equal(sourceMutatedResult.code, 0, sourceMutatedResult.stderr);
  const sourceBaselineOutput = JSON.parse(sourceBaselineResult.stdout);
  const sourceMutatedOutput = JSON.parse(sourceMutatedResult.stdout);
  assert.notEqual(
    sourceMutatedOutput.finalStateDigest,
    sourceBaselineOutput.finalStateDigest,
    `${fixtureName} causation.digest mutation did not change final digest`,
  );
  results.push({
    baselineFinalStateDigest: sourceBaselineOutput.finalStateDigest,
    finalStateDigest: sourceMutatedOutput.finalStateDigest,
    name: "causation.digest",
    outcome: "digest-changed",
  });
  provenanceEvidence[fixtureName] = results;
}

const purityAudit = [];
for (const relativePath of [
  "packages/reducers/src/index.mjs",
  "packages/reducers/src/canonical-state.mjs",
]) {
  const absolutePath = path.join(root, relativePath);
  const source = await readFile(absolutePath, "utf8");
  const analysis = analyzeModuleSource(source, relativePath);
  assert.deepEqual(
    analysis.ambientCapabilities,
    [],
    `${relativePath} reached an ambient capability`,
  );
  assert.ok(
    analysis.imports.every((specifier) => specifier.startsWith(".")),
    `${relativePath} imported a non-local dependency`,
  );
  purityAudit.push({
    ambientCapabilities: analysis.ambientCapabilities,
    imports: analysis.imports,
    path: relativePath,
  });
}

for (const [name, script] of [
  ["format", "format:check"],
  ["lint", "lint"],
  ["typecheck", "typecheck"],
  ["tests", "test"],
  ["build", "build"],
]) {
  const startedAt = Date.now();
  await runPnpm(script, {
    ...process.env,
    BUILD_DIR: path.join(artifactRoot, "build"),
    E0_T05_IMPLEMENTATION_COMMIT: implementationCommit,
    TEST_ARTIFACT_DIR: artifactRoot,
    TEST_RUN_ID: runId,
  });
  gates.push({
    command: `pnpm ${script}`,
    durationMs: Date.now() - startedAt,
    name,
    result: "PASS",
  });
}

assert.equal(
  await pathExists(cliEnvironment.QUERY_STORE_PATH),
  false,
  "query-store path was created during replay",
);
assert.equal(
  await pathExists(cliEnvironment.BUILD_CACHE_PATH),
  false,
  "build-cache path was created during replay",
);

const summary = {
  schemaVersion: 1,
  task: "E0-T05",
  runId,
  implementationCommit,
  implementationTreeCleanAtStart:
    process.env.PROMOTE_EVIDENCE === "1" ? true : null,
  result: "PASS",
  artifactRoot,
  zeroSkippedGates: true,
  gates,
  replay:
    "N/A (CLI replay apparatus, not browser behavior) + mitigation: golden event logs, per-prefix digests, purity audit, and mutation tests",
  replayUploadAttempted: false,
  networkDisabled: true,
  queryStorePathAbsent: true,
  buildCachePathAbsent: true,
  validFixtures: replayEvidence,
  invalidFixtures: invalidEvidence,
  prefixDigests: prefixEvidence,
  mutationSensitivity: mutationEvidence,
  provenanceSensitivity: provenanceEvidence,
  purityAudit,
};
await writeJson(path.join(artifactRoot, "prefix-digests.json"), prefixEvidence);
await writeJson(
  path.join(artifactRoot, "invalid-results.json"),
  invalidEvidence,
);
await writeJson(
  path.join(artifactRoot, "mutation-results.json"),
  mutationEvidence,
);
await writeJson(
  path.join(artifactRoot, "provenance-results.json"),
  provenanceEvidence,
);
await writeJson(path.join(artifactRoot, "purity-audit.json"), purityAudit);
await writeJson(path.join(artifactRoot, "verification-summary.json"), summary);

if (process.env.PROMOTE_EVIDENCE === "1") {
  await mkdir(path.join(taskEvidenceDirectory, "valid"), { recursive: true });
  await mkdir(path.join(taskEvidenceDirectory, "invalid"), { recursive: true });
  for (const fixtureName of validFixtureNames) {
    await copyFile(
      path.join(validDirectory, fixtureName),
      path.join(taskEvidenceDirectory, "valid", fixtureName),
    );
  }
  for (const fixtureName of invalidFixtureNames) {
    await copyFile(
      path.join(invalidDirectory, fixtureName),
      path.join(taskEvidenceDirectory, "invalid", fixtureName),
    );
  }
  for (const name of [
    "invalid-results.json",
    "mutation-results.json",
    "provenance-results.json",
    "prefix-digests.json",
    "purity-audit.json",
    "verification-summary.json",
  ]) {
    await copyFile(
      path.join(artifactRoot, name),
      path.join(taskEvidenceDirectory, name),
    );
  }
}

console.log(JSON.stringify(summary, null, 2));

async function runCli(args, env) {
  try {
    const result = await execFileAsync(
      process.execPath,
      ["scripts/replay-ledger.mjs", ...args],
      {
        cwd: root,
        env,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return { code: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    return {
      code: Number(error.code) || 1,
      stderr: error.stderr ?? "",
      stdout: error.stdout ?? "",
    };
  }
}

async function runPnpm(script, env) {
  try {
    await execFileAsync("pnpm", [script], {
      cwd: root,
      env,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    process.stderr.write(error.stdout ?? "");
    process.stderr.write(error.stderr ?? "");
    throw new Error(`pnpm ${script} failed with code ${error.code}`);
  }
}

function mutateOneSemanticByte(fixtureName, source) {
  const replacements =
    fixtureName === "ledger-log.v1.json"
      ? ['"value": "alpha"', '"value": "alphb"']
      : [
          '"text": "a second deterministic message"',
          '"text": "a second deterministic messagf"',
        ];
  assert.equal(
    source.split(replacements.at(0)).length,
    2,
    `${fixtureName} mutation needle was not unique`,
  );
  const text = source.replace(replacements.at(0), replacements.at(1));
  assert.equal(Buffer.byteLength(source) - Buffer.byteLength(text), 0);
  assert.equal(
    [...Buffer.from(source)].filter(
      (byte, index) => byte !== [...Buffer.from(text)].at(index),
    ).length,
    1,
    `${fixtureName} did not mutate exactly one byte`,
  );
  return { text };
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
