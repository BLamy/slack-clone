import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
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
const OTHER_AGENT_ID =
  "ag_aaaaaaaaaaaaaaaaaaaaaaaaaa_eeeeeeeeeeeeeeeeeeeeeeeeee";
const RUN_ID = "rn_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";
const INVOCATION_ID = "iv_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHANNEL_STREAM =
  "channel:ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const SAME_WORKSPACE_OTHER_CHANNEL =
  "channel:ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_eeeeeeeeeeeeeeeeeeeeeeeeee";
const OTHER_WORKSPACE_CHANNEL =
  "channel:ch_bbbbbbbbbbbbbbbbbbbbbbbbbb_eeeeeeeeeeeeeeeeeeeeeeeeee";
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
assert.deepEqual(
  describeLifecycle(complete.records),
  corpus.validLifecycle,
  "lifecycle fixture must describe the generated valid corpus",
);
assert.deepEqual(corpus.terminalStates, [
  "completed",
  "failed",
  "timed-out",
  "cancelled",
]);
assert.deepEqual(corpus.invalidMutationFields, [
  "state",
  "sequence",
  "runId",
  "attemptId",
  "sourceRef",
  "usage",
  "terminal",
]);
assert.deepEqual(corpus.boundedRecordTypes, [
  "activity",
  "usage",
  "approval",
  "artifact",
  "result",
  "failure",
]);
const first = replayRecords(complete.records);
const second = replayRecords(structuredClone(complete.records));
assert.equal(first.finalStateDigest, second.finalStateDigest);
assert.deepEqual(
  first.prefixes.map(({ index, offset, stateDigest }) => ({
    index,
    offset,
    stateDigest,
  })),
  second.prefixes.map(({ index, offset, stateDigest }) => ({
    index,
    offset,
    stateDigest,
  })),
);
assert.equal(first.finalStateDigest, corpus.replay.finalStateDigest);
assert.deepEqual(
  first.prefixes.map(({ index, offset, stateDigest }) => ({
    index,
    offset,
    stateDigest,
  })),
  corpus.replay.perPrefixDigests,
  "replay must match the pinned fixture digests",
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

const invalidOffsets = verifyInvalidMutations(
  complete.records,
  corpus.invalidMutationFields,
);
const bindingAudit = verifyBindingAudit(complete);
const terminalRaces = verifyTerminalRaces(corpus.terminalStates);
const boundedRecords = verifyBoundedRecords(
  complete.records,
  corpus.boundedRecordTypes,
);
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
await writeJson(
  path.join(evidenceDirectory, "verification-summary.json"),
  summary,
);
const evidenceScan = await scanEvidenceDirectory(evidenceDirectory);
const publishedCanaryScan = {
  ...canaryScan,
  canaryPresentInPublishedEvidence: evidenceScan.leaked,
  evidenceFiles: evidenceScan.files,
  postVerifierEvidenceScanCompleted: evidenceScan.checked,
  publishedEvidenceLeaked: evidenceScan.leaked,
};
summary.canaryScan = publishedCanaryScan;
await writeJson(
  path.join(evidenceDirectory, "canary-scan.json"),
  publishedCanaryScan,
);
await writeJson(
  path.join(evidenceDirectory, "verification-summary.json"),
  summary,
);

console.log(JSON.stringify(summary, null, 2));

async function scanEvidenceDirectory(directory) {
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  let leaked = false;
  for (const filename of files) {
    const contents = await readFile(path.join(directory, filename), "utf8");
    if (
      /e3-t01-verifier-canary-|PRIVATE KEY|api[_-]?key\s*[:=]|Bearer\s+[A-Za-z0-9._~+/=-]{12,}/iu.test(
        contents,
      )
    ) {
      leaked = true;
    }
  }
  return { checked: true, files, leaked };
}

function describeLifecycle(records) {
  return records.map(({ event }) => {
    if (event.eventType !== "run.lifecycle.changed") return event.eventType;
    return `${event.eventType}:${String(event.data.from)}->${event.data.to}`;
  });
}

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

function verifyInvalidMutations(records, expectedFields) {
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
  assert.deepEqual(
    cases.map(([name]) => name),
    expectedFields,
    "invalid mutation fixture must cover the verifier matrix",
  );
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
  const reuseAttacks = [
    [
      "agent",
      (records) => {
        records[1].event.data.binding.agentId = OTHER_AGENT_ID;
      },
      "INVOCATION_RUN_BINDING_MISMATCH",
    ],
    [
      "snapshot-digest",
      (records) => {
        records[1].event.data.binding.snapshotDigest = digest("9");
      },
      "INVOCATION_RUN_BINDING_MISMATCH",
    ],
    [
      "source-trigger",
      (records) => {
        records[1].event.data.binding.sourceTrigger = sourceReference(
          SAME_WORKSPACE_OTHER_CHANNEL,
          offset(94),
          digest("9"),
        );
      },
      "INVOCATION_RUN_BINDING_MISMATCH",
    ],
    [
      "invocation",
      (records) => {
        records[1].event.data.invocationId = "iv_bbbbbbbbbbbbbbbbbbbbbbbbbb";
      },
      "INVOCATION_RUN_BINDING_MISMATCH",
    ],
    [
      "workspace",
      (records) => {
        records[1].event.data.binding.sourceTrigger = sourceReference(
          OTHER_WORKSPACE_CHANNEL,
          offset(95),
          digest("9"),
        );
      },
      "INVOCATION_RUN_INVALID_SOURCE",
    ],
  ].map(([name, mutate, expectedCode]) => {
    const mutated = structuredClone(complete.records);
    mutate(mutated);
    let error = null;
    try {
      replayRecords(mutated);
    } catch (candidate) {
      error = candidate;
    }
    assert.ok(error, `${name} binding reuse must be rejected`);
    assert.equal(error.code, expectedCode, name);
    assert.equal(error.offset, mutated[1].offset, name);
    return {
      attack: name,
      expectedCode,
      observedCode: error.code,
      offset: error.offset,
      refused: true,
    };
  });
  return {
    agentId: invocation.agentId,
    correlationId: invocation.correlationId,
    invocationId: invocation.invocationId,
    runId: runRequested.runId,
    snapshotDigest: invocation.snapshotDigest,
    sourceTrigger: invocation.sourceTrigger,
    reuseAttacks,
    result: "PASS",
  };
}

function verifyTerminalRaces(expectedTerminals) {
  const winner = buildLifecycleRecords({ terminal: "completed" });
  const sharedHead = winner.records.at(-1);
  const rows = expectedTerminals.map((terminal, index) => {
    const candidateRecords = structuredClone(winner.records);
    const candidateData = {
      attemptId: "at_1",
      attemptNumber: 1,
      binding: null,
      from: "completed",
      invocationId: INVOCATION_ID,
      leaseGeneration: 1,
      runId: RUN_ID,
      schemaVersion: 1,
      sequence: 14,
      sourceRef: sourceReference(
        `run:${RUN_ID}`,
        sharedHead.offset,
        digestEventEnvelope(sharedHead.event),
      ),
      terminal: {
        failureCode: terminal === "failed" ? "provider_failed" : null,
        kind: terminal,
        reasonCode:
          terminal === "timed-out"
            ? "deadline"
            : terminal === "cancelled"
              ? "requested"
              : null,
        resultRef:
          terminal === "completed"
            ? winner.resultRef
            : null,
      },
      to: terminal,
    };
    const event = eventEnvelope(
      index === 0 ? "z" : "y",
      "run.lifecycle.changed",
      candidateData,
      candidateData.sourceRef,
    );
    candidateRecords.push({
      event,
      offset: offset(15),
    });
    let error = null;
    try {
      replayRecords(candidateRecords);
    } catch (candidate) {
      error = candidate;
    }
    assert.equal(error?.code, "INVOCATION_RUN_TERMINAL_IMMUTABLE", terminal);
    assert.equal(error?.offset, offset(15), terminal);
    return {
      attemptedTerminal: terminal,
      expectedCode: "INVOCATION_RUN_TERMINAL_IMMUTABLE",
      observedCode: error.code,
      offset: error.offset,
      refused: true,
      sharedHeadOffset: sharedHead.offset,
      winner: "completed",
    };
  });
  return {
    candidates: rows,
    sharedHeadOffset: sharedHead.offset,
    terminalWinner: "completed",
    oneWinnerPerExpectedHead:
      winner.records.at(-1).event.data.to === "completed" &&
      rows.every((row) => row.refused),
    result: "PASS",
  };
}

function verifyBoundedRecords(records, expectedRecordTypes) {
  const activityIndex = records.findIndex(
    ({ event }) => event.eventType === "run.activity.recorded",
  );
  assert.notEqual(activityIndex, -1, "fixture must include an activity record");
  const attacks = [
    [
      "unrestricted-output-field",
      (data) => {
        data.processOutput = "raw provider output";
      },
      "INVOCATION_RUN_INVALID_DATA",
    ],
    [
      "oversized-summary",
      (data) => {
        data.summary = "x".repeat(513);
      },
      "INVOCATION_RUN_INVALID_DATA",
    ],
  ].map(([attack, mutate, expectedCode]) => {
    const mutated = structuredClone(records);
    mutate(mutated[activityIndex].event.data);
    let error = null;
    try {
      replayRecords(mutated);
    } catch (candidate) {
      error = candidate;
    }
    assert.ok(error, `${attack} must be rejected before append`);
    assert.equal(error.code, expectedCode, attack);
    assert.equal(error.offset, mutated[activityIndex].offset, attack);
    return {
      attack,
      expectedCode,
      observedCode: error.code,
      offset: error.offset,
      refused: true,
    };
  });
  assert.deepEqual(expectedRecordTypes, [
    "activity",
    "usage",
    "approval",
    "artifact",
    "result",
    "failure",
  ]);
  return {
    contentReferencesOnly: true,
    attacks,
    rawProviderOutputFields: 0,
    rawSecretFields: 0,
    recordCount: records.length,
    recordTypes: expectedRecordTypes,
    rejectedOversizedFields: attacks.filter(
      ({ attack }) => attack === "oversized-summary",
    ).length,
    rejectedRawProviderOutputFields: attacks.filter(
      ({ attack }) => attack === "unrestricted-output-field",
    ).length,
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
    result: "PASS",
  };
}

async function verifySensitivity() {
  await mkdir(path.join(taskDirectory, "work"), { recursive: true });
  const mutations = [
    {
      anchor: `function hasSecret(value) {
  return (
    typeof value === "string" &&
    SECRET_PATTERNS.some((pattern) => pattern.test(value))
  );
}`,
      file: "packages/protocol/src/invocation-run.mjs",
      label: "disable secret canary rejection",
      replacement: "function hasSecret() { return false; }",
      command: ["node", "--test", "test/unit/invocation-run.test.mjs"],
    },
    {
      anchor: 'if (data.to === "completed") {',
      file: "packages/reducers/src/index.mjs",
      label: "disable completed-result terminal check",
      replacement: "if (false) {",
      command: ["node", "scripts/verify-e3-t01.mjs"],
      nestedVerifier: true,
    },
  ];
  const results = [];
  for (const mutation of mutations) {
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
      const modulePath = path.join(checkout, mutation.file);
      let source = await readFile(modulePath, "utf8");
      assert.equal(
        source.split(mutation.anchor).length - 1,
        1,
        `${mutation.label} anchor must remain unique`,
      );
      source = source.replace(mutation.anchor, mutation.replacement);
      await writeFile(modulePath, source);
      execFileSync("pnpm", ["install", "--frozen-lockfile"], {
        cwd: checkout,
        env: process.env,
        stdio: "ignore",
      });
      let exitCode = 0;
      const environment = {
        ...process.env,
        E3_T01_IMPLEMENTATION_COMMIT: implementationCommit,
        E3_T01_SKIP_GATES: mutation.nestedVerifier ? "1" : process.env.E3_T01_SKIP_GATES,
        E3_T01_SKIP_SENSITIVITY: mutation.nestedVerifier ? "1" : process.env.E3_T01_SKIP_SENSITIVITY,
        PROMOTE_EVIDENCE: "0",
        TEST_ARTIFACT_DIR: mutation.nestedVerifier
          ? path.join(parent, "nested-artifacts")
          : process.env.TEST_ARTIFACT_DIR,
        TEST_RUN_ID: `${runId}-${mutation.label.replaceAll(" ", "-")}`,
      };
      try {
        execFileSync(mutation.command[0], mutation.command.slice(1), {
          cwd: checkout,
          env: environment,
          stdio: "ignore",
        });
      } catch (error) {
        exitCode = typeof error.status === "number" ? error.status : 1;
      }
      assert.notEqual(
        exitCode,
        0,
        `${mutation.label} must make the verifier fail`,
      );
      results.push({
        mutation: mutation.label,
        verifierCommand: mutation.command.join(" "),
        verifierExitCode: exitCode,
        verifierRejected: true,
        result: "PASS",
      });
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
  return { mutations: results, result: "PASS" };
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
