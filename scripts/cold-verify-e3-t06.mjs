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
  process.env.E3_T06_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
const promoteEvidence = process.env.PROMOTE_EVIDENCE === "1";
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-3-the-dispatcher/E3-T06-cancellation-retries-and-budgets",
);
const reportDirectory = promoteEvidence
  ? path.join(taskDirectory, "evidence/e3-t06-final")
  : path.resolve(
      root,
      process.env.TEST_ARTIFACT_DIR ??
        path.join(".artifacts", "e3-t06-cold", runId),
    );
const workDirectory = path.join(taskDirectory, "work");
const evidenceFiles = [
  "attempt-timelines.json",
  "canary-scan.json",
  "capability-revocations.json",
  "clock-guards.json",
  "crash-recovery.json",
  "fake-clock-schedules.json",
  "process-resource-counts.json",
  "replay-digests.json",
  "sensitivity.json",
  "terminal-races.json",
  "usage-accounting.json",
  "verification-summary.json",
];

if (!/^[0-9a-f]{40}$/u.test(implementationCommit)) {
  throw new Error(
    "E3-T06 cold verification requires an exact implementation commit",
  );
}

await mkdir(reportDirectory, { recursive: true });
await mkdir(workDirectory, { recursive: true });
const disposableParent = await mkdtemp(path.join(workDirectory, "cold-clone-"));
const checkout = path.join(disposableParent, "checkout");
const artifactDirectory = path.join(checkout, ".artifacts", "e3-t06", runId);
const transcript = {
  schemaVersion: 1,
  runId,
  implementationCommit,
  entrypoint: {
    command: process.env.E3_T06_ENTRYPOINT ?? "make verify-E3-T06",
    delegatedTo: "node scripts/verify-e3-t06.mjs",
  },
  checkout: "disposable git worktree at the implementation commit",
  commands: [],
};
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
  await runLogged(
    "git",
    [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "update",
      "--init",
      "--recursive",
      "--reference",
      path.join(root, "emulate"),
    ],
    {
      cwd: checkout,
      displayCommand:
        "git -c protocol.file.allow=always submodule update --init --recursive --reference <local emulate checkout>",
    },
  );
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
  await runLogged("node", ["scripts/verify-e3-t06.mjs"], {
    cwd: checkout,
    displayCommand: "node scripts/verify-e3-t06.mjs",
    env: {
      ...process.env,
      E3_T06_COLD_CLONE: "1",
      E3_T06_IMPLEMENTATION_COMMIT: implementationCommit,
      E3_T06_SKIP_GATES: "0",
      E3_T06_SKIP_SENSITIVITY: "0",
      PROMOTE_EVIDENCE: promoteEvidence ? "1" : "0",
      TEST_ARTIFACT_DIR: artifactDirectory,
      TEST_RUN_ID: runId,
    },
  });
  transcript.result = "PASS";
  const verifierEvidenceDirectory = promoteEvidence
    ? path.join(
        checkout,
        ".eforest/tasks/epic-3-the-dispatcher/E3-T06-cancellation-retries-and-budgets/evidence/e3-t06-final",
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
await finalizeEvidenceScan();

console.log(
  JSON.stringify(
    { implementationCommit, result: transcript.result ?? "FAIL", runId },
    null,
    2,
  ),
);

async function runLogged(command, args, { cwd, displayCommand, env } = {}) {
  const started = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    stdout = execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      env: env ?? process.env,
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    exitCode = error.status ?? 1;
    stdout = error.stdout ?? "";
    stderr = error.stderr ?? "";
  }
  transcript.commands.push({
    command: displayCommand ?? [command, ...args].join(" "),
    durationMs: Date.now() - started,
    exitCode,
    stderrBytes: Buffer.byteLength(stderr),
    stderrPreview: redact(stderr).slice(-4_000),
    stderrSha256: sha256(stderr),
    stdoutBytes: Buffer.byteLength(stdout),
    stdoutPreview: redact(stdout).slice(-4_000),
    stdoutSha256: sha256(stdout),
  });
  if (exitCode !== 0) {
    throw new Error(
      `${displayCommand ?? command} failed with exit ${exitCode}: ${redact(stderr || stdout).slice(-4_000)}`,
    );
  }
  return stdout;
}

async function finalizeEvidenceScan() {
  const files = (await readdir(reportDirectory))
    .filter((filename) => filename.endsWith(".json"))
    .sort();
  const patterns = [
    /-----BEGIN [^-]*PRIVATE KEY-----/iu,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
    /\b(?:api[_-]?key|client[_-]?secret|password|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/iu,
    /rcap_[A-Za-z0-9_-]{32,96}/u,
  ];
  const findings = [];
  for (const filename of files) {
    const content = await readFile(
      path.join(reportDirectory, filename),
      "utf8",
    );
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) findings.push({ filename, pattern: pattern.source });
    }
  }
  if (findings.length > 0) {
    throw new Error(
      `E3-T06 evidence leaked credential material: ${JSON.stringify(findings)}`,
    );
  }
  const scan = {
    checked: true,
    files,
    findings,
    leaked: false,
    transcriptChecked: files.includes("cold-clone-transcript.json"),
  };
  await writeFile(
    path.join(reportDirectory, "canary-scan.json"),
    `${JSON.stringify(scan, null, 2)}\n`,
  );
}

function redact(value) {
  return String(value)
    .replace(/rcap_[A-Za-z0-9_-]{32,96}/gu, "[capability-redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu, "Bearer [redacted]")
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu,
      "[private-key-redacted]",
    );
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}
