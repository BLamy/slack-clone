import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const runId =
  process.env.TEST_RUN_ID ?? `cold-${process.pid}-${Date.now().toString(36)}`;
const implementationCommit = String(
  process.env.E3_T04_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
if (!/^[0-9a-f]{40}$/u.test(implementationCommit)) {
  throw new Error(
    "E3-T04 cold verification requires an exact implementation commit",
  );
}

const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-3-the-dispatcher/E3-T04-bounded-context-pack",
);
const promoteEvidence = process.env.PROMOTE_EVIDENCE === "1";
const reportDirectory = promoteEvidence
  ? path.join(taskDirectory, "evidence/e3-t04-final")
  : path.resolve(
      root,
      process.env.TEST_ARTIFACT_DIR ??
        path.join(".artifacts", "e3-t04-cold", runId),
    );
const workDirectory = path.join(taskDirectory, "work");
await mkdir(reportDirectory, { recursive: true });
await mkdir(workDirectory, { recursive: true });

const disposableParent = await mkdtemp(path.join(workDirectory, "cold-clone-"));
const checkout = path.join(disposableParent, "checkout");
const artifactDirectory = path.join(checkout, ".artifacts", "e3-t04", runId);
const transcript = {
  schemaVersion: 1,
  runId,
  implementationCommit,
  entrypoint: {
    command: process.env.E3_T04_ENTRYPOINT ?? "make verify-E3-T04",
    delegatedTo: "node scripts/verify-e3-t04.mjs",
  },
  checkout: "disposable git worktree at the implementation commit",
  commands: [],
};
const evidenceFiles = [
  "acl-canaries.json",
  "canary-scan.json",
  "pack-manifest.json",
  "refusal-matrix.json",
  "replay-digests.json",
  "sensitivity.json",
  "truncation.json",
  "trust-boundary.json",
  "verification-summary.json",
];
let worktreeAdded = false;

try {
  await runLogged(
    "git",
    ["worktree", "add", "--detach", checkout, implementationCommit],
    {
      cwd: root,
      displayCommand: `git worktree add --detach <checkout> ${implementationCommit}`,
    },
  );
  worktreeAdded = true;
  await runLogged("git", ["submodule", "update", "--init", "--recursive"], {
    cwd: checkout,
    displayCommand: "git submodule update --init --recursive",
  });
  const clean = await runLogged(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    {
      cwd: checkout,
      displayCommand: "git status --porcelain --untracked-files=all",
    },
  );
  if (clean.trim() !== "") {
    throw new Error(`disposable checkout is not clean: ${clean.trim()}`);
  }
  transcript.cleanCheckoutBeforeInstall = true;
  await runLogged("pnpm", ["install", "--frozen-lockfile"], {
    cwd: checkout,
    displayCommand: "pnpm install --frozen-lockfile",
  });
  await runLogged("pnpm", ["setup:emulate"], {
    cwd: checkout,
    displayCommand: "pnpm setup:emulate",
  });
  await runLogged("node", ["scripts/verify-e3-t04.mjs"], {
    cwd: checkout,
    displayCommand: "node scripts/verify-e3-t04.mjs",
    env: {
      ...process.env,
      E3_T04_COLD_CLONE: "1",
      E3_T04_IMPLEMENTATION_COMMIT: implementationCommit,
      E3_T04_SKIP_GATES: "0",
      E3_T04_SKIP_SENSITIVITY: "0",
      PROMOTE_EVIDENCE: promoteEvidence ? "1" : "0",
      TEST_ARTIFACT_DIR: artifactDirectory,
      TEST_RUN_ID: runId,
    },
  });
  transcript.result = "PASS";
  const verifierEvidenceDirectory = promoteEvidence
    ? path.join(
        checkout,
        ".eforest/tasks/epic-3-the-dispatcher/E3-T04-bounded-context-pack/evidence/e3-t04-final",
      )
    : artifactDirectory;
  for (const filename of evidenceFiles) {
    await copyFile(
      path.join(verifierEvidenceDirectory, filename),
      path.join(reportDirectory, filename),
    );
  }
} finally {
  if (worktreeAdded) {
    try {
      execFileSync("git", ["worktree", "remove", "--force", checkout], {
        cwd: root,
        stdio: "ignore",
      });
    } catch {
      // Preserve the verifier's original failure.
    }
  }
  await rm(disposableParent, { force: true, recursive: true });
}

await writeFile(
  path.join(reportDirectory, "cold-clone-transcript.json"),
  `${JSON.stringify(transcript, null, 2)}\n`,
);
const evidenceScan = await scanReportFiles(reportDirectory);
if (evidenceScan.leaked) {
  throw new Error(
    `E3-T04 evidence contains credential material: ${evidenceScan.files.find((file) => file.leaked)?.name ?? "unknown"}`,
  );
}

const canaryScanPath = path.join(reportDirectory, "canary-scan.json");
const canaryScan = JSON.parse(await readFile(canaryScanPath, "utf8"));
canaryScan.evidenceFiles = evidenceScan.files.map(({ name }) => name);
canaryScan.postVerifierTranscriptChecked = evidenceScan.files.some(
  ({ name }) => name === "cold-clone-transcript.json",
);
canaryScan.publishedEvidenceLeaked = evidenceScan.leaked;
canaryScan.canaryPresentInPublishedEvidence = evidenceScan.leaked;
if (!canaryScan.postVerifierTranscriptChecked) {
  throw new Error("E3-T04 transcript was not included in the evidence scan");
}
await writeFile(canaryScanPath, `${JSON.stringify(canaryScan, null, 2)}\n`);

const summaryPath = path.join(reportDirectory, "verification-summary.json");
const summary = JSON.parse(await readFile(summaryPath, "utf8"));
summary.implementationTreeCleanAtStart =
  transcript.cleanCheckoutBeforeInstall === true;
summary.canaryScan = canaryScan;
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

const finalEvidenceScan = await scanReportFiles(reportDirectory);
if (finalEvidenceScan.leaked) {
  throw new Error(
    "E3-T04 evidence leaked credential material after scan update",
  );
}
canaryScan.files = finalEvidenceScan.files;
canaryScan.leaked = finalEvidenceScan.leaked;
canaryScan.finalEvidenceChecked = true;
await writeFile(canaryScanPath, `${JSON.stringify(canaryScan, null, 2)}\n`);
summary.canaryScan = canaryScan;
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

console.log(
  JSON.stringify(
    { implementationCommit, result: transcript.result, runId },
    null,
    2,
  ),
);

async function scanReportFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const contents = await readFile(path.join(directory, entry.name), "utf8");
    files.push({
      leaked:
        /rcap_[A-Za-z0-9_-]{20,96}|PRIVATE KEY|api[_-]?key\s*[:=]|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|sibling-canary|ambient-value-must-not-enter-the-pack/iu.test(
          contents,
        ),
      name: entry.name,
    });
  }
  return {
    files: files.sort(({ name: left }, { name: right }) =>
      left.localeCompare(right),
    ),
    leaked: files.some((file) => file.leaked),
  };
}

async function runLogged(command, args, { cwd, displayCommand, env } = {}) {
  const startedAt = Date.now();
  try {
    const stdout = execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      env: env ?? process.env,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    transcript.commands.push(
      commandEvidence({
        command: displayCommand ?? [command, ...args].join(" "),
        durationMs: Date.now() - startedAt,
        exitCode: 0,
        stderr: "",
        stdout,
      }),
    );
    return stdout;
  } catch (error) {
    const stdout = String(error.stdout ?? "");
    const stderr = String(error.stderr ?? "");
    transcript.commands.push(
      commandEvidence({
        command: displayCommand ?? [command, ...args].join(" "),
        durationMs: Date.now() - startedAt,
        exitCode: error.status ?? 1,
        stderr,
        stdout,
      }),
    );
    throw error;
  }
}

function commandEvidence({ command, durationMs, exitCode, stderr, stdout }) {
  return {
    command,
    durationMs,
    exitCode,
    stderrBytes: Buffer.byteLength(stderr),
    stderrPreview: redactOutput(stderr),
    stderrSha256: digestOutput(stderr),
    stdoutBytes: Buffer.byteLength(stdout),
    stdoutPreview: redactOutput(stdout),
    stdoutSha256: digestOutput(stdout),
  };
}

function digestOutput(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function redactOutput(value) {
  return value
    .replace(
      /(?:api[_-]?key|authorization|bearer|password|secret|token)\s*[:=]?[^\n]*/giu,
      "[REDACTED]",
    )
    .replace(/test_token_[A-Za-z0-9_-]+/gu, "[REDACTED]")
    .replace(
      /sibling-canary|ambient-value-must-not-enter-the-pack/giu,
      "[CANARY-REDACTED]",
    )
    .slice(-4000);
}
