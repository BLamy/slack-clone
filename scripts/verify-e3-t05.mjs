import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  completeConversationBatch,
  CONVERSATION_SCHEDULER_ERROR_CODES,
  planConversationSchedule,
  replayConversationSchedule,
} from "@stream-slack/protocol";
import { createConversationScheduler } from "../src/ledger/conversation-scheduler.mjs";
import {
  AGENT_A,
  AGENT_A_PRINCIPAL,
  AGENT_B,
  AGENT_C,
  WORKSPACE_ID,
  makeActive,
  makeDelegatedChild,
  makeHistory,
  makeItem,
  makePolicy,
} from "../test/support/conversation-scheduler-fixture.mjs";

const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-3-the-dispatcher/E3-T05-batching-and-recursion-guards",
);
const runId = process.env.TEST_RUN_ID ?? `e3-t05-${Date.now().toString(36)}`;
const reportDirectory = path.resolve(
  root,
  process.env.PROMOTE_EVIDENCE === "1"
    ? path.join(taskDirectory, "evidence/e3-t05-final")
    : (process.env.TEST_ARTIFACT_DIR ??
        path.join(".artifacts", "e3-t05", runId)),
);
const implementationCommit = String(
  process.env.E3_T05_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }),
).trim();
const replayDeclaration =
  "Replay: N/A (server scheduling and recursion policy) + mitigation: burst schedules, durable causation graphs, cycle/fairness matrix, and replay digests";

if (!/^[0-9a-f]{40}$/u.test(implementationCommit)) {
  throw new Error("E3-T05 requires an exact implementation commit");
}

await mkdir(reportDirectory, { recursive: true });
await mkdir(path.join(taskDirectory, "work"), { recursive: true });

const gateResults = [];
if (process.env.E3_T05_SKIP_GATES !== "1") {
  for (const [name, command, args] of [
    ["format", "pnpm", ["format:check"]],
    ["lint", "pnpm", ["lint"]],
    ["typecheck", "pnpm", ["typecheck"]],
    ["tests", "pnpm", ["test"]],
    ["build", "pnpm", ["build"]],
  ]) {
    gateResults.push(runCommand(name, command, args));
  }
}

const functional = await verifyFunctional();
const sensitivity =
  process.env.E3_T05_SKIP_SENSITIVITY === "1"
    ? { result: "SKIPPED", reason: "nested mutation verifier" }
    : await runSensitivity();

await writeJson("batch-manifest.json", functional.batchManifest);
await writeJson("causation-graph.json", functional.causationGraph);
await writeJson("aggregate-budget.json", functional.aggregateBudget);
await writeJson("concurrency-keys.json", functional.concurrencyKeys);
await writeJson("fairness.json", functional.fairness);
await writeJson("refusals.json", functional.refusals);
await writeJson("replay-digests.json", functional.replayDigests);
await writeJson("sensitivity.json", sensitivity);

const summary = {
  schemaVersion: 1,
  implementationCommit,
  runId,
  replay: replayDeclaration,
  gates: gateResults,
  queueOrderCount: functional.queueOrder.length,
  batchCount: functional.batchManifest.batches.length,
  refusalCount: functional.refusals.refusals.length,
  terminalDispositionCount: functional.batchManifest.terminalDispositionCount,
  sensitivity,
};
await writeJson("verification-summary.json", summary);
await writeCanaryScan();

console.log(
  JSON.stringify(
    {
      implementationCommit,
      runId,
      gates: gateResults.map(({ name, result }) => ({ name, result })),
      batches: functional.batchManifest.batches.length,
      refusals: functional.refusals.refusals.length,
      sensitivity: sensitivity.result,
      replay: replayDeclaration,
    },
    null,
    2,
  ),
);

async function verifyFunctional() {
  const burst = [
    makeItem({ index: 3, invocationLetter: "c" }),
    makeItem({ index: 1, invocationLetter: "a" }),
    makeItem({ index: 2, invocationLetter: "b" }),
    makeItem({
      agentId: AGENT_B,
      index: 4,
      invocationLetter: "d",
    }),
  ];
  const ordered = planConversationSchedule({
    queued: burst,
    workspaceId: WORKSPACE_ID,
  });
  const reversed = planConversationSchedule({
    queued: [...burst].reverse(),
    workspaceId: WORKSPACE_ID,
  });
  assert.deepEqual(ordered.queueOrder, [
    burst[1].invocationId,
    burst[2].invocationId,
    burst[0].invocationId,
    burst[3].invocationId,
  ]);
  assert.equal(ordered.scheduleDigest, reversed.scheduleDigest);
  assert.equal(ordered.finalScheduleDigest, reversed.finalScheduleDigest);
  assert.equal(ordered.batches.length, 2);
  assert.equal(ordered.batches[0].members.length, 3);

  const activeSource = makeItem({ index: 10, invocationLetter: "e" });
  const blockedSource = makeItem({ index: 11, invocationLetter: "f" });
  const independentSource = makeItem({
    agentId: AGENT_B,
    index: 12,
    invocationLetter: "g",
  });
  const fairnessSchedule = planConversationSchedule({
    active: [makeActive(activeSource)],
    queued: [blockedSource, independentSource],
    workspaceId: WORKSPACE_ID,
  });
  const blockedDecision = decisionFor(fairnessSchedule, blockedSource);
  const independentDecision = decisionFor(fairnessSchedule, independentSource);
  assert.equal(blockedDecision.status, "queued");
  assert.equal(
    blockedDecision.code,
    CONVERSATION_SCHEDULER_ERROR_CODES.CONVERSATION_ACTIVE,
  );
  assert.equal(independentDecision.status, "admitted");

  let providerCalls = 0;
  const scheduler = createConversationScheduler();
  const planned = await scheduler.plan({
    queued: burst.slice(0, 3),
    workspaceId: WORKSPACE_ID,
  });
  const execution = await scheduler.executeBatch({
    batchId: planned.batches[0].batchId,
    provider: async (batch) => {
      providerCalls += 1;
      assert.equal(batch.members.length, 3);
      return { ok: true };
    },
  });
  assert.equal(providerCalls, 1);
  assert.equal(execution.schedule.terminalDispositions.length, 3);
  assert.equal(scheduler.replay().terminalCount, 3);

  const refusalCases = refusalMatrix();
  const refusalSchedule = planConversationSchedule({
    history: [makeHistory(refusalCases.replay)],
    queued: refusalCases.items,
    workspaceId: WORKSPACE_ID,
  });
  const refusalMap = Object.fromEntries(
    refusalSchedule.refusals.map(({ invocationId, code }) => [
      invocationId,
      code,
    ]),
  );
  for (const [invocationId, expectedCode] of refusalCases.expected) {
    assert.equal(refusalMap[invocationId], expectedCode);
  }
  assert.equal(refusalSchedule.batches.length, 0);
  assert.equal(
    refusalSchedule.terminalDispositions.length,
    refusalCases.items.length,
  );

  const guards = guardMatrix();
  const guardSchedule = planConversationSchedule({
    active: [makeActive(guards.activeDelegation)],
    history: [makeHistory(guards.fanoutA), makeHistory(guards.fanoutB)],
    queued: guards.items,
    workspaceId: WORKSPACE_ID,
  });
  const guardMap = Object.fromEntries(
    guardSchedule.refusals.map(({ invocationId, code }) => [
      invocationId,
      code,
    ]),
  );
  for (const [invocationId, expectedCode] of guards.expected) {
    assert.equal(guardMap[invocationId], expectedCode);
  }

  const aggregateCases = aggregateBudgetMatrix();
  const aggregateSchedule = planConversationSchedule({
    queued: [...aggregateCases.items].reverse(),
    workspaceId: WORKSPACE_ID,
  });
  const aggregateMap = Object.fromEntries(
    aggregateSchedule.decisions.map((decision) => [
      decision.invocationId,
      decision,
    ]),
  );
  assert.equal(
    aggregateMap[aggregateCases.first.invocationId].status,
    "admitted",
  );
  assert.equal(
    aggregateMap[aggregateCases.second.invocationId].code,
    CONVERSATION_SCHEDULER_ERROR_CODES.BUDGET_EXCEEDED,
  );
  assert.deepEqual(aggregateSchedule.batches[0].memberInvocationIds, [
    aggregateCases.first.invocationId,
  ]);
  const aggregateFirstGraph = aggregateSchedule.causationGraph.find(
    (entry) => entry.invocationId === aggregateCases.first.invocationId,
  );
  const aggregateSecondGraph = aggregateSchedule.causationGraph.find(
    (entry) => entry.invocationId === aggregateCases.second.invocationId,
  );
  assert.deepEqual(
    aggregateSecondGraph.aggregateUsageBefore,
    aggregateCases.first.estimatedUsage,
  );
  assert.deepEqual(
    aggregateFirstGraph.aggregateUsageAfter,
    aggregateCases.first.estimatedUsage,
  );
  assert.deepEqual(
    aggregateSecondGraph.aggregateBudget,
    aggregateCases.aggregateBudget,
  );
  assert.equal(aggregateSecondGraph.aggregateUsageAfter, null);

  const completed = completeConversationBatch(
    ordered,
    ordered.batches[0].batchId,
    { disposition: "completed" },
  );
  assert.equal(replayConversationSchedule(completed).terminalCount, 3);
  const tampered = structuredClone(completed);
  tampered.decisions[0].status = "queued";
  assert.throws(() => replayConversationSchedule(tampered));

  return {
    batchManifest: {
      batches: ordered.batches,
      completedDigest: completed.finalScheduleDigest,
      providerCalls,
      replayedTerminalCount: scheduler.replay().terminalCount,
      scheduleDigest: ordered.scheduleDigest,
      terminalDispositionCount: execution.schedule.terminalDispositions.length,
    },
    causationGraph: {
      entries: guardSchedule.causationGraph,
      expected: Object.fromEntries(guards.expected),
      scheduleDigest: guardSchedule.scheduleDigest,
    },
    aggregateBudget: {
      budget: aggregateCases.aggregateBudget,
      decisions: aggregateSchedule.decisions,
      entries: aggregateSchedule.causationGraph,
      secondDeclaredBudget: aggregateCases.secondDeclaredBudget,
      scheduleDigest: aggregateSchedule.scheduleDigest,
    },
    concurrencyKeys: {
      keys: ordered.concurrencyKeys,
      queueOrder: ordered.queueOrder,
      reversedDigest: reversed.scheduleDigest,
      scheduleDigest: ordered.scheduleDigest,
    },
    fairness: {
      activeKey: makeActive(activeSource).conversationKey,
      blocked: blockedDecision,
      independent: independentDecision,
      scheduleDigest: fairnessSchedule.scheduleDigest,
    },
    refusals: {
      expected: Object.fromEntries(refusalCases.expected),
      refusals: refusalSchedule.refusals,
      terminalDispositions: refusalSchedule.terminalDispositions,
    },
    replayDigests: {
      completedFinalDigest: completed.finalScheduleDigest,
      replay: replayConversationSchedule(completed),
      reversedInputDigest: reversed.scheduleDigest,
      scheduleDigest: ordered.scheduleDigest,
      equalForReorderedInput:
        ordered.scheduleDigest === reversed.scheduleDigest,
    },
    queueOrder: ordered.queueOrder,
  };
}

function refusalMatrix() {
  const self = makeItem({
    agentId: AGENT_A,
    authorAgentId: AGENT_A,
    authorId: AGENT_A_PRINCIPAL,
    authorKind: "agent",
    index: 20,
    invocationLetter: "j",
  });
  const quoted = makeItem({
    index: 21,
    invocationLetter: "k",
    mentionKind: "quoted",
  });
  const code = makeItem({
    index: 22,
    invocationLetter: "q",
    mentionKind: "code",
  });
  const edit = makeItem({
    eventType: "channel.message.edited",
    index: 23,
    invocationLetter: "m",
    isEdit: true,
  });
  const retry = makeItem({ index: 24, invocationLetter: "n", isRetry: true });
  const reply = makeItem({
    authorAgentId: AGENT_A,
    authorId: AGENT_A_PRINCIPAL,
    authorKind: "agent",
    index: 25,
    invocationLetter: "r",
    isAgentReply: true,
  });
  const replay = makeItem({ index: 26, invocationLetter: "p" });
  return {
    expected: [
      [self.invocationId, CONVERSATION_SCHEDULER_ERROR_CODES.SELF_TRIGGER],
      [quoted.invocationId, CONVERSATION_SCHEDULER_ERROR_CODES.QUOTED_MENTION],
      [code.invocationId, CONVERSATION_SCHEDULER_ERROR_CODES.QUOTED_MENTION],
      [edit.invocationId, CONVERSATION_SCHEDULER_ERROR_CODES.EDIT_TRIGGER],
      [retry.invocationId, CONVERSATION_SCHEDULER_ERROR_CODES.RETRY_TRIGGER],
      [reply.invocationId, CONVERSATION_SCHEDULER_ERROR_CODES.AGENT_REPLY],
      [replay.invocationId, CONVERSATION_SCHEDULER_ERROR_CODES.REPLAYED_SOURCE],
    ],
    items: [self, quoted, code, edit, retry, reply, replay],
    replay,
  };
}

function guardMatrix() {
  const missingGrant = makeItem({
    agentId: AGENT_B,
    authorAgentId: AGENT_A,
    authorId: AGENT_A_PRINCIPAL,
    authorKind: "agent",
    index: 30,
    invocationLetter: "q",
  });
  const revoked = makeDelegatedChild({ index: 31, invocationLetter: "r" });
  revoked.causation.delegationGrant.status = "revoked";
  const cycle = makeDelegatedChild({ index: 32, invocationLetter: "s" });
  cycle.causation.ancestors = [
    {
      agentId: AGENT_B,
      invocationId: cycle.invocationId,
      sourceRef: cycle.sourceTrigger,
    },
  ];
  cycle.causation.parentInvocationId = cycle.invocationId;
  cycle.causation.rootInvocationId = cycle.invocationId;
  const depth = makeDelegatedChild({
    index: 33,
    invocationLetter: "t",
    policy: makePolicy({
      delegation: {
        allowCrossChannel: false,
        enabled: true,
        maxChildren: 2,
        maxDepth: 1,
      },
    }),
  });
  depth.causation.ancestors = [
    {
      agentId: AGENT_A,
      invocationId: `iv_${"a".repeat(26)}`,
      sourceRef: depth.sourceTrigger,
    },
    {
      agentId: AGENT_C,
      invocationId: `iv_${"b".repeat(26)}`,
      sourceRef: depth.sourceTrigger,
    },
  ];
  depth.causation.parentInvocationId = `iv_${"b".repeat(26)}`;
  depth.causation.rootInvocationId = `iv_${"a".repeat(26)}`;
  const fanout = makeDelegatedChild({ index: 34, invocationLetter: "v" });
  const fanoutA = makeDelegatedChild({ index: 35, invocationLetter: "w" });
  const fanoutB = makeDelegatedChild({ index: 36, invocationLetter: "x" });
  const activeDelegation = makeDelegatedChild({
    index: 37,
    invocationLetter: "y",
  });
  const concurrency = makeDelegatedChild({
    index: 38,
    invocationLetter: "z",
    parent: `iv_${"z".repeat(26)}`,
  });
  const budget = makeDelegatedChild({
    index: 39,
    invocationLetter: "k",
    parent: `iv_${"y".repeat(26)}`,
  });
  budget.causation.aggregateBudget = {
    costUsdCents: 0,
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
  };
  return {
    activeDelegation,
    expected: [
      [
        missingGrant.invocationId,
        CONVERSATION_SCHEDULER_ERROR_CODES.DELEGATION_REQUIRED,
      ],
      [
        revoked.invocationId,
        CONVERSATION_SCHEDULER_ERROR_CODES.DELEGATION_REVOKED,
      ],
      [cycle.invocationId, CONVERSATION_SCHEDULER_ERROR_CODES.CYCLE],
      [depth.invocationId, CONVERSATION_SCHEDULER_ERROR_CODES.DELEGATION_DEPTH],
      [
        fanout.invocationId,
        CONVERSATION_SCHEDULER_ERROR_CODES.DELEGATION_FANOUT,
      ],
      [
        concurrency.invocationId,
        CONVERSATION_SCHEDULER_ERROR_CODES.DELEGATION_CONCURRENCY,
      ],
      [budget.invocationId, CONVERSATION_SCHEDULER_ERROR_CODES.BUDGET_EXCEEDED],
    ],
    fanoutA,
    fanoutB,
    items: [missingGrant, revoked, cycle, depth, fanout, concurrency, budget],
  };
}

function aggregateBudgetMatrix() {
  const policy = makePolicy({
    delegation: {
      allowCrossChannel: false,
      enabled: true,
      maxChildren: 2,
      maxDepth: 2,
    },
  });
  const first = makeDelegatedChild({
    agentId: AGENT_C,
    index: 40,
    invocationLetter: "g",
    maxConcurrent: 2,
    policy,
  });
  const second = makeDelegatedChild({
    agentId: AGENT_C,
    index: 41,
    invocationLetter: "h",
    maxConcurrent: 2,
    policy,
  });
  const aggregateBudget = {
    costUsdCents: 3,
    inputTokens: 15,
    outputTokens: 8,
    totalTokens: 23,
  };
  const secondDeclaredBudget = {
    costUsdCents: 100,
    inputTokens: 100,
    outputTokens: 100,
    totalTokens: 200,
  };
  first.causation.aggregateBudget = aggregateBudget;
  second.causation.aggregateBudget = secondDeclaredBudget;
  return {
    aggregateBudget,
    first,
    items: [second, first],
    second,
    secondDeclaredBudget,
  };
}

function decisionFor(schedule, item) {
  const decision = schedule.decisions.find(
    (candidate) => candidate.invocationId === item.invocationId,
  );
  assert.ok(decision, `missing scheduling decision for ${item.invocationId}`);
  return decision;
}

async function runSensitivity() {
  const mutations = [
    {
      file: "packages/protocol/src/conversation-scheduling.mjs",
      label: "self-trigger-fence",
      needle:
        'if (source.authorKind === "agent" && source.authorAgentId === item.agentId) {',
      replacement: "if (false) {",
    },
    {
      file: "packages/protocol/src/conversation-scheduling.mjs",
      label: "cycle-fence",
      needle:
        "if (ancestors.some((ancestor) => ancestor.agentId === item.agentId)) {",
      replacement: "if (false) {",
    },
    {
      file: "packages/protocol/src/conversation-scheduling.mjs",
      label: "conversation-key-fence",
      needle: "if (activeKeys.has(key)) {",
      replacement: "if (false) {",
    },
    {
      file: "packages/protocol/src/conversation-scheduling.mjs",
      label: "aggregate-budget-accumulator",
      needle: `const before = priorUsage
    ? maxUsage(priorUsage, item.causation.aggregateUsage)
    : item.causation.aggregateUsage;`,
      replacement: "const before = item.causation.aggregateUsage;",
    },
    {
      file: "packages/protocol/src/conversation-scheduling.mjs",
      label: "aggregate-budget-narrowing",
      needle: `const budget = priorBudget
    ? minBudget(priorBudget, item.causation.aggregateBudget)
    : item.causation.aggregateBudget;`,
      replacement: "const budget = item.causation.aggregateBudget;",
    },
  ];
  const results = [];
  for (const mutation of mutations) {
    const parent = await mkdtemp(path.join(taskDirectory, "work", "mutant-"));
    const checkout = path.join(parent, "checkout");
    let added = false;
    try {
      execFileSync(
        "git",
        ["worktree", "add", "--detach", checkout, implementationCommit],
        {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      added = true;
      const protocolLink = path.join(
        checkout,
        "node_modules/@stream-slack/protocol",
      );
      await mkdir(path.dirname(protocolLink), { recursive: true });
      await symlink(
        path.join(checkout, "packages/protocol"),
        protocolLink,
        "dir",
      );
      const file = path.join(checkout, mutation.file);
      const source = await readFile(file, "utf8");
      const occurrences = source.split(mutation.needle).length - 1;
      assert.equal(occurrences, 1, `${mutation.label} needle must occur once`);
      await writeFile(
        file,
        source.replace(mutation.needle, mutation.replacement),
      );
      const result = spawnSync(
        process.execPath,
        ["scripts/verify-e3-t05.mjs"],
        {
          cwd: checkout,
          encoding: "utf8",
          env: {
            ...process.env,
            E3_T05_IMPLEMENTATION_COMMIT: implementationCommit,
            E3_T05_SKIP_GATES: "1",
            E3_T05_SKIP_SENSITIVITY: "1",
            PROMOTE_EVIDENCE: "0",
            TEST_ARTIFACT_DIR: `.artifacts/e3-t05-mutant-${mutation.label}`,
            TEST_RUN_ID: `e3-t05-mutant-${mutation.label}`,
          },
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      results.push({
        detected: result.status !== 0,
        label: mutation.label,
        verifierExitCode: result.status,
      });
      assert.notEqual(result.status, 0, `${mutation.label} was not detected`);
    } finally {
      if (added) {
        try {
          execFileSync("git", ["worktree", "remove", "--force", checkout], {
            cwd: root,
            stdio: "ignore",
          });
        } catch {
          // Preserve the mutation verifier's result.
        }
      }
      await rm(parent, { force: true, recursive: true });
    }
  }
  return {
    controlExitCode: 0,
    detectedCount: results.filter(({ detected }) => detected).length,
    mutationCount: results.length,
    result: "PASS",
    results,
  };
}

function runCommand(name, command, args) {
  const started = Date.now();
  try {
    execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.slice(-4000);
    throw new Error(`${name} failed: ${detail}`);
  }
  return {
    command: [command, ...args].join(" "),
    durationMs: Date.now() - started,
    name,
    result: "PASS",
  };
}

async function writeJson(filename, value) {
  await writeFile(
    path.join(reportDirectory, filename),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

async function writeCanaryScan() {
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
    const matches = patterns.flatMap((pattern) => content.match(pattern) ?? []);
    findings.push({
      file: filename,
      leaked: matches.length > 0,
      matches: [...new Set(matches)].map((match) => redactedPreview(match)),
    });
  }
  await writeJson("canary-scan.json", {
    files: findings,
    finalEvidenceChecked: true,
    leaked: findings.some(({ leaked }) => leaked),
  });
}

function redactedPreview(value) {
  if (value.length <= 8) return "[REDACTED]";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
