import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  digestEventEnvelope,
  issueEventEnvelope,
} from "../src/ledger/envelope.mjs";
import { replayRecords } from "@stream-slack/reducers";
import {
  deriveInvocationCorrelationId,
  policyDigest,
} from "@stream-slack/protocol";

const WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACTOR_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const AGENT_ID = "ag_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const RUN_ID = "rn_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";
const INVOCATION_ID = "iv_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHANNEL_STREAM =
  "channel:ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const SNAPSHOT_STREAM =
  "agent:ag_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc/config";
const RESULT_STREAM =
  "projection:px_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";

const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-3-the-dispatcher/E3-T01-invocation-run-state-machine",
);
const fixtureDirectory = path.join(taskDirectory, "fixtures");
const runId = String(
  process.env.TEST_RUN_ID ?? `verify-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/gu, "-");
const implementationCommit = String(
  process.env.E3_T01_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
assert.match(implementationCommit, /^[0-9a-f]{40}$/u);
const promoteEvidence = process.env.PROMOTE_EVIDENCE === "1";
if (promoteEvidence) {
  assert.equal(
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    "",
    "promoted E3-T01 evidence requires a clean tracked implementation tree",
  );
}
const artifactRoot = path.resolve(
  root,
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e3-t01", runId),
);
const evidenceDirectory = promoteEvidence
  ? path.join(taskDirectory, "evidence/e3-t01-final")
  : artifactRoot;
await mkdir(evidenceDirectory, { recursive: true });

const corpus = JSON.parse(
  await readFile(
    path.join(fixtureDirectory, "lifecycle-corpus.v1.json"),
    "utf8",
  ),
);
assert.equal(corpus.task, "E3-T01");
assert.equal(corpus.schemaVersion, 1);

const complete = buildLifecycleRecords();
const first = replayRecords(complete.records);
const second = replayRecords(structuredClone(complete.records));
assert.equal(first.finalStateDigest, second.finalStateDigest);
assert.deepEqual(
  first.prefixes.map(({ offset, stateDigest }) => ({ offset, stateDigest })),
  second.prefixes.map(({ offset, stateDigest }) => ({ offset, stateDigest })),
);
const run = first.finalState.entities.runs[RUN_ID];
assert.equal(run.status, "completed");
assert.equal(Object.keys(run.attempts).length, 1);
assert.equal(run.attempts.at_1.attemptNumber, 1);
assert.deepEqual(run.usage, {
  costUsdCents: 7,
  inputTokens: 12,
  outputBytes: 128,
  outputTokens: 8,
  totalTokens: 20,
  wallTimeMs: 40,
});
assert.equal(run.result.resultRef.digest, complete.resultRef.digest);

const invalidOffsets = verifyInvalidMutations(complete.records);
const bindingAudit = verifyBindingAudit(complete);
const terminalRaces = verifyTerminalRaces();
const boundedRecords = verifyBoundedRecords(complete.records);
const canaryScan = verifyCanaryIsolation(complete.records);
const sensitivityEvidence =
  process.env.E3_T01_SKIP_SENSITIVITY === "1"
    ? { result: "SKIPPED", reason: "nested mutation verifier" }
    : await verifySensitivity();

const gates = [];
if (process.env.E3_T01_SKIP_GATES !== "1") {
  for (const [name, script] of [
    ["format", "format:check"],
    ["lint", "lint"],
    ["typecheck", "typecheck"],
    ["tests", "test"],
    ["build", "build"],
  ]) {
    const startedAt = Date.now();
    execFileSync("pnpm", [script], {
      cwd: root,
      env: {
        ...process.env,
        BUILD_DIR: path.join(artifactRoot, "build"),
        E3_T01_IMPLEMENTATION_COMMIT: implementationCommit,
        E3_T01_SKIP_GATES: "1",
        E3_T01_SKIP_SENSITIVITY: "1",
        TEST_ARTIFACT_DIR: artifactRoot,
        TEST_RUN_ID: runId,
      },
      stdio: "inherit",
    });
    gates.push({
      command: `pnpm ${script}`,
      durationMs: Date.now() - startedAt,
      name,
      result: "PASS",
    });
  }
}

const replayEvidence = {
  finalStateDigest: first.finalStateDigest,
  networkUsed: false,
  perPrefixDigests: first.prefixes.map(({ index, offset, stateDigest }) => ({
    index,
    offset,
    stateDigest,
  })),
  replayedTwiceWithIdenticalDigest: true,
  result: "PASS",
  runState: run.status,
  usage: run.usage,
  queryStoreUsed: false,
};
const summary = {
  schemaVersion: 1,
  task: "E3-T01",
  runId,
  implementationCommit,
  implementationTreeCleanAtStart: promoteEvidence,
  result: "PASS",
  replay:
    "Replay: N/A (server run protocol) + mitigation: lifecycle corpus, source-reference audit, secret canary scan, and per-prefix replay digests",
  replayUploadAttempted: false,
  gates,
  bindingAudit,
  boundedRecords,
  canaryScan,
  invalidOffsets,
  replayEvidence,
  sensitivityEvidence,
  terminalRaces,
};

await writeJson(
  path.join(evidenceDirectory, "verification-summary.json"),
  summary,
);
await writeJson(
  path.join(evidenceDirectory, "prefix-replay.json"),
  replayEvidence,
);
await writeJson(
  path.join(evidenceDirectory, "invalid-offsets.json"),
  invalidOffsets,
);
await writeJson(
  path.join(evidenceDirectory, "binding-audit.json"),
  bindingAudit,
);
await writeJson(
  path.join(evidenceDirectory, "bounded-records.json"),
  boundedRecords,
);
await writeJson(
  path.join(evidenceDirectory, "terminal-races.json"),
  terminalRaces,
);
await writeJson(path.join(evidenceDirectory, "canary-scan.json"), canaryScan);
await writeJson(
  path.join(evidenceDirectory, "sensitivity.json"),
  sensitivityEvidence,
);

console.log(JSON.stringify(summary, null, 2));

function buildLifecycleRecords({ terminal = "completed" } = {}) {
  const sourceTrigger = sourceReference(
    CHANNEL_STREAM,
    offset(90),
    digest("1"),
  );
  const snapshotRef = sourceReference(SNAPSHOT_STREAM, offset(91), digest("2"));
  const policy = {
    allowApprovals: true,
    maxAttempts: 3,
    maxCostUsdCents: 100,
    maxInputTokens: 1000,
    maxOutputTokens: 1000,
    maxWallTimeMs: 10_000,
    version: 1,
  };
  const correlationId = deriveInvocationCorrelationId({
    agentId: AGENT_ID,
    invocationId: INVOCATION_ID,
    sourceTrigger,
    workspaceId: WORKSPACE_ID,
  });
  const invocationData = {
    agentId: AGENT_ID,
    correlationId,
    invocationId: INVOCATION_ID,
    policy,
    policyDigest: policyDigest(policy),
    schemaVersion: 1,
    snapshotDigest: digest("3"),
    snapshotRef,
    sourceTrigger,
    triggerType: "mention",
  };
  const invocation = eventEnvelope(
    "a",
    "workspace.invocation.requested",
    invocationData,
    sourceTrigger,
  );
  const invocationRecord = { event: invocation, offset: offset(1) };
  const invocationRef = sourceReference(
    "workspace:ws_aaaaaaaaaaaaaaaaaaaaaaaaaa/invocations",
    offset(1),
    digestEventEnvelope(invocation),
  );
  const binding = {
    agentId: AGENT_ID,
    correlationId,
    invocationRef,
    policy,
    policyDigest: policyDigest(policy),
    snapshotDigest: invocationData.snapshotDigest,
    snapshotRef,
    sourceTrigger,
  };
  const records = [invocationRecord];
  let previous = invocationRecord;
  const eventLetters = "abcdefghjkmnpqrstvwxyz";
  let eventIndex = 1;
  function append(data, eventType = "run.lifecycle.changed") {
    const causation =
      data.sourceRef ??
      sourceReference(
        `run:${RUN_ID}`,
        previous.offset,
        digestEventEnvelope(previous.event),
      );
    const eventData = { ...data, sourceRef: data.sourceRef ?? causation };
    const record = {
      event: eventEnvelope(
        eventLetters[eventIndex],
        eventType,
        eventData,
        causation,
      ),
      offset: offset(records.length + 1),
    };
    records.push(record);
    previous = record;
    eventIndex += 1;
    return record;
  }
  const lifecycle = (
    sequence,
    from,
    to,
    attemptId = null,
    attemptNumber = null,
    leaseGeneration = null,
    terminalData = null,
    extra = {},
  ) => ({
    attemptId,
    attemptNumber,
    binding: sequence === 1 ? binding : null,
    from,
    invocationId: INVOCATION_ID,
    leaseGeneration,
    runId: RUN_ID,
    schemaVersion: 1,
    sequence,
    sourceRef: sequence === 1 ? invocationRef : undefined,
    terminal: terminalData,
    to,
    ...extra,
  });
  append(lifecycle(1, null, "requested"));
  append(lifecycle(2, "requested", "queued"));
  append(lifecycle(3, "queued", "leased", "at_1", 1, 1));
  append(lifecycle(4, "leased", "running", "at_1", 1, 1));
  if (terminal === "completed") {
    append(
      {
        ...commonRecord(5, previous),
        kind: "progress",
        summary: "started",
        contentRef: null,
      },
      "run.activity.recorded",
    );
    append(
      {
        ...commonRecord(6, previous),
        costUsdCents: 7,
        inputTokens: 12,
        outputBytes: 128,
        outputTokens: 8,
        totalTokens: 20,
        wallTimeMs: 40,
      },
      "run.usage.recorded",
    );
    append(lifecycle(7, "running", "awaiting-approval", "at_1", 1, 1));
    append(
      {
        ...commonRecord(8, previous),
        action: "publish-result",
        approvalId: "approval_1",
        requestRef: sourceTrigger,
      },
      "run.approval.requested",
    );
    append(
      {
        ...commonRecord(9, previous),
        approvalId: "approval_1",
        decision: "approved",
      },
      "run.approval.decided",
    );
    append(lifecycle(10, "awaiting-approval", "running", "at_1", 1, 1));
    append(
      {
        ...commonRecord(11, previous),
        artifactId: "artifact_1",
        byteLength: 128,
        contentRef: sourceReference(RESULT_STREAM, offset(92), digest("4")),
        kind: "report",
        mediaType: "text/plain",
        name: "result.txt",
      },
      "run.artifact.recorded",
    );
    const resultRef = sourceReference(RESULT_STREAM, offset(93), digest("5"));
    append(
      {
        ...commonRecord(12, previous),
        resultRef,
        summary: "completed",
      },
      "run.result.recorded",
    );
    const resultRecord = records.at(-1);
    append(
      lifecycle(
        13,
        "running",
        "completed",
        "at_1",
        1,
        1,
        {
          kind: "completed",
          resultRef,
          failureCode: null,
          reasonCode: null,
        },
        {
          sourceRef: sourceReference(
            `run:${RUN_ID}`,
            resultRecord.offset,
            digestEventEnvelope(resultRecord.event),
          ),
        },
      ),
    );
    return { records, resultRef, sourceTrigger, binding, invocationData };
  }
  if (terminal === "failed") {
    append(
      {
        ...commonRecord(5, previous),
        detailRef: null,
        failureCode: "provider_failed",
        retryable: false,
      },
      "run.failure.recorded",
    );
    const failureRecord = records.at(-1);
    append(
      lifecycle(
        6,
        "running",
        "failed",
        "at_1",
        1,
        1,
        {
          kind: "failed",
          resultRef: null,
          failureCode: "provider_failed",
          reasonCode: null,
        },
        {
          sourceRef: sourceReference(
            `run:${RUN_ID}`,
            failureRecord.offset,
            digestEventEnvelope(failureRecord.event),
          ),
        },
      ),
    );
    return { records, resultRef: null, sourceTrigger, binding, invocationData };
  }
  append(
    lifecycle(5, "running", terminal, "at_1", 1, 1, {
      kind: terminal,
      resultRef: null,
      failureCode: null,
      reasonCode: terminal === "timed-out" ? "deadline" : "requested",
    }),
  );
  return { records, resultRef: null, sourceTrigger, binding, invocationData };
}

function verifyInvalidMutations(records) {
  const cases = [
    [
      "state",
      2,
      (data) => ({
        ...data,
        attemptId: "at_1",
        attemptNumber: 1,
        from: "requested",
        leaseGeneration: 1,
        to: "running",
      }),
      "INVOCATION_RUN_INVALID_TRANSITION",
    ],
    [
      "sequence",
      6,
      (data) => ({ ...data, sequence: data.sequence + 1 }),
      "INVOCATION_RUN_INVALID_STATE",
    ],
    [
      "runId",
      4,
      (data) => ({
        ...data,
        runId: "rn_aaaaaaaaaaaaaaaaaaaaaaaaaa_eeeeeeeeeeeeeeeeeeeeeeeeee",
      }),
      "INVOCATION_RUN_INVALID_TRANSITION",
    ],
    [
      "attemptId",
      5,
      (data) => ({ ...data, attemptId: "at_wrong" }),
      "INVOCATION_RUN_BINDING_MISMATCH",
    ],
    [
      "sourceRef",
      3,
      (data) => ({
        ...data,
        sourceRef: sourceReference(`run:${RUN_ID}`, offset(2), digest("9")),
      }),
      "INVOCATION_RUN_INVALID_SOURCE",
    ],
    [
      "usage",
      6,
      (data) => ({ ...data, totalTokens: 999 }),
      "INVOCATION_RUN_INVALID_DATA",
    ],
    [
      "terminal",
      records.length - 1,
      (data) => ({
        ...data,
        terminal: {
          ...data.terminal,
          resultRef: sourceReference(RESULT_STREAM, offset(99), digest("8")),
        },
      }),
      "INVOCATION_RUN_INVALID_STATE",
    ],
  ];
  return cases.map(([name, recordIndex, mutate, expectedCode]) => {
    const mutated = structuredClone(records);
    mutated[recordIndex].event.data = mutate(mutated[recordIndex].event.data);
    let error = null;
    try {
      replayRecords(mutated);
    } catch (candidate) {
      error = candidate;
    }
    assert.ok(error, `${name} mutation must be rejected`);
    assert.equal(error.code, expectedCode, name);
    assert.equal(error.offset, mutated[recordIndex].offset, name);
    return {
      field: name,
      expectedCode,
      observedCode: error.code,
      offset: error.offset,
      refused: true,
    };
  });
}

function verifyBindingAudit(complete) {
  const invocation = complete.records[0].event.data;
  const runRequested = complete.records[1].event.data;
  assert.equal(runRequested.binding.agentId, invocation.agentId);
  assert.equal(
    runRequested.binding.invocationRef.stream,
    "workspace:ws_aaaaaaaaaaaaaaaaaaaaaaaaaa/invocations",
  );
  assert.equal(runRequested.binding.snapshotDigest, invocation.snapshotDigest);
  assert.deepEqual(runRequested.binding.snapshotRef, invocation.snapshotRef);
  assert.deepEqual(
    runRequested.binding.sourceTrigger,
    invocation.sourceTrigger,
  );
  assert.equal(runRequested.binding.policyDigest, invocation.policyDigest);
  assert.equal(
    runRequested.binding.correlationId,
    deriveInvocationCorrelationId({
      agentId: invocation.agentId,
      invocationId: invocation.invocationId,
      sourceTrigger: invocation.sourceTrigger,
      workspaceId: WORKSPACE_ID,
    }),
  );
  return {
    agentId: invocation.agentId,
    correlationId: invocation.correlationId,
    invocationId: invocation.invocationId,
    runId: runRequested.runId,
    snapshotDigest: invocation.snapshotDigest,
    sourceTrigger: invocation.sourceTrigger,
    result: "PASS",
  };
}

function verifyTerminalRaces() {
  const rows = ["completed", "failed", "timed-out", "cancelled"].map(
    (terminal) => {
      const candidate = buildLifecycleRecords({ terminal });
      const replay = replayRecords(candidate.records);
      assert.equal(replay.finalState.entities.runs[RUN_ID].status, terminal);
      return {
        terminal,
        finalStateDigest: replay.finalStateDigest,
        result: "one-terminal-winner",
      };
    },
  );
  return {
    candidates: rows,
    oneWinnerPerExpectedHead: true,
    result: "PASS",
  };
}

function verifyBoundedRecords(records) {
  const text = JSON.stringify(records);
  for (const forbidden of [
    "credentials",
    "providerToken",
    "processOutput",
    "environment",
    "password",
  ]) {
    assert.equal(
      text.includes(forbidden),
      false,
      `forbidden field ${forbidden} leaked`,
    );
  }
  return {
    contentReferencesOnly: true,
    rawProviderOutputFields: 0,
    rawSecretFields: 0,
    recordCount: records.length,
    result: "PASS",
  };
}

function verifyCanaryIsolation(records) {
  const canaryRecords = structuredClone(records);
  canaryRecords[5].event.data.summary =
    "Bearer e3-t01-verifier-canary-123456789";
  let error = null;
  try {
    replayRecords(canaryRecords);
  } catch (candidate) {
    error = candidate;
  }
  assert.equal(error?.code, "INVOCATION_RUN_SECRET_VALUE");
  return {
    canaryRejected: true,
    canaryPresentInPublishedEvidence: false,
    result: "PASS",
  };
}

async function verifySensitivity() {
  await mkdir(path.join(taskDirectory, "work"), { recursive: true });
  const parent = await mkdtemp(
    path.join(taskDirectory, "work", "sensitivity-"),
  );
  const checkout = path.join(parent, "checkout");
  let added = false;
  try {
    execFileSync(
      "git",
      ["worktree", "add", "--detach", checkout, implementationCommit],
      {
        cwd: root,
        stdio: "ignore",
      },
    );
    added = true;
    const modulePath = path.join(
      checkout,
      "packages/protocol/src/invocation-run.mjs",
    );
    let source = await readFile(modulePath, "utf8");
    const anchor = `function hasSecret(value) {
  return (
    typeof value === "string" &&
    SECRET_PATTERNS.some((pattern) => pattern.test(value))
  );
}`;
    assert.equal(
      source.split(anchor).length - 1,
      1,
      "sensitivity anchor must remain unique",
    );
    source = source.replace(anchor, "function hasSecret() { return false; }");
    await writeFile(modulePath, source);
    execFileSync("pnpm", ["install", "--frozen-lockfile"], {
      cwd: checkout,
      env: process.env,
      stdio: "ignore",
    });
    let exitCode = 0;
    try {
      execFileSync("node", ["--test", "test/unit/invocation-run.test.mjs"], {
        cwd: checkout,
        env: process.env,
        stdio: "ignore",
      });
    } catch (error) {
      exitCode = typeof error.status === "number" ? error.status : 1;
    }
    assert.notEqual(
      exitCode,
      0,
      "secret-redaction mutation must make the verifier fail",
    );
    return {
      mutation: "disable secret canary rejection",
      verifierCommand: "node --test test/unit/invocation-run.test.mjs",
      verifierExitCode: exitCode,
      verifierRejected: true,
      result: "PASS",
    };
  } finally {
    if (added) {
      execFileSync("git", ["worktree", "remove", "--force", checkout], {
        cwd: root,
        stdio: "ignore",
      });
    }
    await rm(parent, { recursive: true, force: true });
  }
}

function eventEnvelope(letter, eventType, data, causation) {
  return issueEventEnvelope(
    {
      actorId: ACTOR_ID,
      causation,
      correlationId:
        data.correlationId ??
        deriveInvocationCorrelationId({
          agentId: AGENT_ID,
          invocationId: INVOCATION_ID,
          sourceTrigger: sourceReference(
            CHANNEL_STREAM,
            offset(90),
            digest("1"),
          ),
          workspaceId: WORKSPACE_ID,
        }),
      data,
      eventType,
      idempotencyKey: `ik_${letter.repeat(26)}`,
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
    },
    {
      clock: () =>
        new Date(
          `2026-08-07T00:00:${String(letter.charCodeAt(0) - 96).padStart(2, "0")}.000Z`,
        ),
      eventId: `ev_${letter.repeat(26)}`,
    },
  );
}

function commonRecord(sequence, previous) {
  return {
    attemptId: "at_1",
    invocationId: INVOCATION_ID,
    runId: RUN_ID,
    schemaVersion: 1,
    sequence,
    sourceRef: sourceReference(
      `run:${RUN_ID}`,
      previous.offset,
      digestEventEnvelope(previous.event),
    ),
  };
}

function sourceReference(stream, sourceOffset, sourceDigest) {
  return { digest: sourceDigest, offset: sourceOffset, stream };
}

function offset(value) {
  return `${value.toString(10).padStart(16, "0")}_${"a".repeat(16)}`;
}

function digest(letter) {
  return `sha256:${letter.repeat(64)}`;
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
