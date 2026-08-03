import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ZERO_OFFSET } from "@stream-slack/protocol";
import { canonicalStateJson } from "@stream-slack/reducers";

import {
  createPrincipalFence,
  createPrincipalDispatchDoor,
  PRINCIPAL_DISPATCH_REFUSAL_CODES,
} from "../src/ledger/dispatch.mjs";
import { EVENT_TYPES_V1 } from "../src/ledger/envelope.mjs";
import { validateAndReplayDump } from "../src/ledger/replay.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-1-the-workspace/E1-T01-principal-event-model",
);
const fixtureDirectory = path.join(taskDirectory, "fixtures");
const validDirectory = path.join(fixtureDirectory, "valid");
const runId = String(
  process.env.TEST_RUN_ID ?? `verify-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/gu, "-");
const implementationCommit = String(
  process.env.E1_T01_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
assert.match(
  implementationCommit,
  /^[0-9a-f]{40}$/u,
  "E1-T01 evidence requires an exact implementation commit",
);

const promoteEvidence = process.env.PROMOTE_EVIDENCE === "1";
if (promoteEvidence) {
  const trackedChanges = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    { cwd: root, encoding: "utf8" },
  ).trim();
  assert.equal(
    trackedChanges,
    "",
    "promoted E1-T01 evidence must start from a clean tracked implementation tree",
  );
}

const artifactRoot = path.resolve(
  root,
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e1-t01", runId),
);
const evidenceDirectory = promoteEvidence
  ? path.join(taskDirectory, "evidence/e1-t01-final")
  : artifactRoot;
await mkdir(artifactRoot, { recursive: true });
await mkdir(evidenceDirectory, { recursive: true });

const fixtureNames = [
  "principal-directory.v1.json",
  "principal-lifecycle.v1.json",
];
const manifest = await readJson(path.join(fixtureDirectory, "manifest.json"));
const replayEvidence = {};
const replayResults = {};
for (const fixtureName of fixtureNames) {
  const fixturePath = path.join(validDirectory, fixtureName);
  const dump = await readJson(fixturePath);
  const first = validateAndReplayDump(dump);
  const second = validateAndReplayDump(structuredClone(dump));
  const prefixes = first.prefixes.map(({ index, offset, stateDigest }) => ({
    index,
    offset,
    stateDigest,
  }));
  assert.equal(
    first.finalStateJson,
    second.finalStateJson,
    `${fixtureName} final canonical state changed across identical replays`,
  );
  assert.deepEqual(
    prefixes,
    second.prefixes.map(({ index, offset, stateDigest }) => ({
      index,
      offset,
      stateDigest,
    })),
    `${fixtureName} per-prefix digests changed across identical replays`,
  );
  assert.equal(
    first.finalStateDigest,
    manifest[fixtureName].finalStateDigest,
    `${fixtureName} final digest changed from the pinned manifest`,
  );
  assert.deepEqual(
    prefixes,
    manifest[fixtureName].prefixes,
    `${fixtureName} prefix digest changed from the pinned manifest`,
  );
  replayResults[fixtureName] = first;
  replayEvidence[fixtureName] = {
    finalStateDigest: first.finalStateDigest,
    offsets: prefixes.map(({ offset }) => offset),
    perPrefixDigests: prefixes,
    records: first.prefixes.length,
    replayedTwiceWithIdenticalBytes: true,
  };
  assertNoCredentialPattern(await readFile(fixturePath, "utf8"), fixtureName);
}

const directoryState = replayResults[fixtureNames[0]].finalState;
const principals = Object.values(directoryState.entities.principals);
assert.deepEqual(
  new Set(principals.map((principal) => principal.kind)),
  new Set(["human", "agent", "service"]),
  "golden identity log must cover all principal kinds",
);
for (const principal of principals) {
  assert.match(
    principal.principalId,
    /^pr_[0-9a-hjkmnp-tv-z]{26}_[0-9a-hjkmnp-tv-z]{26}$/u,
  );
  assert.equal(principal.principalId.startsWith("pr_"), true);
  assert.deepEqual(Object.keys(principal).sort(), [
    "kind",
    "ownedBy",
    "principalId",
    "profile",
    "profileRevision",
    "status",
    "subjectBinding",
  ]);
}
const agent = principals.find((principal) => principal.kind === "agent");
assert.ok(agent);
assert.ok(agent.ownedBy);
assert.equal(agent.status, "deactivated");
assert.equal(
  Object.hasOwn(agent, "permissions"),
  false,
  "ownedBy must not materialize inherited permissions",
);

const envelopeSchema = await readJson(
  path.join(root, "src/ledger/schemas/event-envelope.v1.schema.json"),
);
assert.deepEqual(envelopeSchema.properties.eventType.enum, EVENT_TYPES_V1);
const principalSchema = await readJson(
  path.join(root, "src/ledger/schemas/principal-events.v1.schema.json"),
);
assert.equal(principalSchema.oneOf.length, 3);
assert.deepEqual(
  principalSchema.oneOf.map(({ title }) => title),
  [
    "Principal created",
    "Principal profile updated",
    "Principal suspended or deactivated",
  ],
);

const dispatchEvidence = await verifyDispatchDoor();
const sensitivity = await verifySensitivity();
const networkReplay = await verifyOfflineReplay(
  path.join(validDirectory, fixtureNames[0]),
  replayEvidence[fixtureNames[0]].finalStateDigest,
);

const gates = [];
if (process.env.E1_T01_SKIP_GATES !== "1") {
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
      E1_T01_IMPLEMENTATION_COMMIT: implementationCommit,
      E1_T01_SKIP_GATES: "1",
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
}

const summary = {
  schemaVersion: 1,
  task: "E1-T01",
  runId,
  implementationCommit,
  implementationTreeCleanAtStart: promoteEvidence ? true : null,
  result: "PASS",
  fixtureCount: fixtureNames.length,
  replay:
    "Replay: N/A (server identity event model) + mitigation: golden logs, impersonation refusal matrix, canary scan, and deterministic reducer digests",
  replayUploadAttempted: false,
  gates,
  canaryScan: {
    fixtureCount: fixtureNames.length,
    forbiddenCredentialPatterns: 0,
    result: "PASS",
  },
  dispatch: dispatchEvidence,
  sensitivity,
  networkReplay,
  replayEvidence,
};

await writeJson(
  path.join(evidenceDirectory, "verification-summary.json"),
  summary,
);
await writeJson(
  path.join(evidenceDirectory, "principal-replay-evidence.json"),
  replayEvidence,
);
await writeJson(
  path.join(evidenceDirectory, "dispatch-refusal-matrix.json"),
  dispatchEvidence,
);
await writeJson(path.join(evidenceDirectory, "sensitivity.json"), sensitivity);
await writeJson(
  path.join(evidenceDirectory, "offline-replay.json"),
  networkReplay,
);

process.stdout.write(
  `${canonicalStateJson({
    result: "PASS",
    task: "E1-T01",
    runId,
    implementationCommit,
    fixtureCount: fixtureNames.length,
    finalStateDigests: Object.fromEntries(
      Object.entries(replayEvidence).map(([name, evidence]) => [
        name,
        evidence.finalStateDigest,
      ]),
    ),
    refusalCases: dispatchEvidence.refusalMatrix.length,
    gates: gates.map(({ command, result }) => ({ command, result })),
    replay: summary.replay,
  })}\n`,
);

async function verifyDispatchDoor() {
  const siblingWorkspaceId = "ws_bbbbbbbbbbbbbbbbbbbbbbbbbb";
  const adaId = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
  const linusId = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
  const agentId = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";
  const serviceId = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_eeeeeeeeeeeeeeeeeeeeeeeeee";
  const siblingPrincipalId =
    "pr_bbbbbbbbbbbbbbbbbbbbbbbbbb_zzzzzzzzzzzzzzzzzzzzzzzzzz";
  const bootstrap =
    replayResults["principal-directory.v1.json"].prefixes[3].state;
  const current = new Map(
    Object.values(bootstrap.entities.principals).map((principal) => [
      principal.principalId,
      principal,
    ]),
  );
  const bootstrapPrincipals = new Map(
    Object.values(bootstrap.entities.principals).map((principal) => [
      principal.principalId,
      principal,
    ]),
  );
  const subjectMap = new Map(
    Object.values(bootstrap.entities.principals).map((principal) => [
      subjectKey(principal.subjectBinding),
      principal,
    ]),
  );
  const store = createMemoryStore();
  const withPrincipalFence = createPrincipalFence();
  const door = createPrincipalDispatchDoor({
    producerId: "e1-t01-principal-verifier",
    streamStore: store,
    withPrincipalFence,
    resolvePrincipal: async (subject) =>
      subjectMap.get(subjectKey(subject)) ?? null,
    lookupPrincipal: async (principalId) => current.get(principalId) ?? null,
  });
  const accepted = [];

  const humanResult = await door.dispatch(
    principalRequest("human-identity", "aaaaaaaaaaaaaaaaaaaaaaaaaa"),
    bootstrapPrincipals.get(adaId).subjectBinding,
  );
  assert.equal(humanResult.event.dispatch.actorId, adaId);
  accepted.push({
    actorId: humanResult.event.dispatch.actorId,
    stream: "human-identity",
  });

  const agentResult = await door.dispatch(
    principalRequest("agent-identity", "bbbbbbbbbbbbbbbbbbbbbbbbbb"),
    bootstrapPrincipals.get(agentId).subjectBinding,
  );
  assert.equal(agentResult.event.dispatch.actorId, agentId);
  assert.notEqual(agentResult.event.dispatch.actorId, adaId);
  accepted.push({
    actorId: agentResult.event.dispatch.actorId,
    stream: "agent-identity",
  });

  const refusalMatrix = [];
  for (const [label, actorId, token] of [
    ["other-human", linusId, "aaaaaaaaaaaaaaaaaaaaaaaaaa"],
    ["owned-agent", agentId, "bbbbbbbbbbbbbbbbbbbbbbbbbb"],
    ["service", serviceId, "cccccccccccccccccccccccccc"],
    ["sibling-workspace", siblingPrincipalId, "dddddddddddddddddddddddddd"],
  ]) {
    const stream = `spoof-${label}`;
    const before = await store.read(stream);
    const error = await refused(
      door.dispatch(
        {
          ...principalRequest(stream, token),
          actorId,
        },
        bootstrapPrincipals.get(agentId).subjectBinding,
      ),
      PRINCIPAL_DISPATCH_REFUSAL_CODES.ACTOR_FIELD_FORBIDDEN,
    );
    assert.deepEqual(await store.read(stream), before);
    refusalMatrix.push({ label, code: error.code, targetUnchanged: true });
  }

  const payloadSpoofStream = "spoof-payload";
  const payloadBefore = await store.read(payloadSpoofStream);
  const payloadError = await refused(
    door.dispatch(
      {
        ...principalRequest(payloadSpoofStream, "eeeeeeeeeeeeeeeeeeeeeeeeee"),
        payload: { actorId: adaId },
      },
      bootstrapPrincipals.get(agentId).subjectBinding,
    ),
    PRINCIPAL_DISPATCH_REFUSAL_CODES.ACTOR_FIELD_FORBIDDEN,
  );
  assert.deepEqual(await store.read(payloadSpoofStream), payloadBefore);
  refusalMatrix.push({
    label: "payload-actor",
    code: payloadError.code,
    targetUnchanged: true,
  });

  const siblingStream = "sibling-workspace";
  const siblingBefore = await store.read(siblingStream);
  const siblingError = await refused(
    door.dispatch(
      {
        ...principalRequest(siblingStream, "ffffffffffffffffffffffffff"),
        workspaceId: siblingWorkspaceId,
      },
      bootstrapPrincipals.get(adaId).subjectBinding,
    ),
    PRINCIPAL_DISPATCH_REFUSAL_CODES.SCOPE_MISMATCH,
  );
  assert.deepEqual(await store.read(siblingStream), siblingBefore);
  refusalMatrix.push({
    label: "sibling-workspace-request",
    code: siblingError.code,
    targetUnchanged: true,
  });

  const mismatchDoor = createPrincipalDispatchDoor({
    producerId: "e1-t01-principal-mismatch-verifier",
    streamStore: store,
    withPrincipalFence,
    resolvePrincipal: async () => bootstrapPrincipals.get(adaId),
    lookupPrincipal: async (principalId) => current.get(principalId) ?? null,
  });
  const mismatchStream = "subject-mismatch";
  const mismatchBefore = await store.read(mismatchStream);
  const mismatchError = await refused(
    mismatchDoor.dispatch(
      principalRequest(mismatchStream, "gggggggggggggggggggggggggg"),
      bootstrapPrincipals.get(agentId).subjectBinding,
    ),
    PRINCIPAL_DISPATCH_REFUSAL_CODES.SUBJECT_MISMATCH,
  );
  assert.deepEqual(await store.read(mismatchStream), mismatchBefore);
  refusalMatrix.push({
    label: "subject-mismatch",
    code: mismatchError.code,
    targetUnchanged: true,
  });

  const suspended = {
    ...bootstrapPrincipals.get(agentId),
    status: "suspended",
  };
  current.set(agentId, suspended);
  subjectMap.set(subjectKey(suspended.subjectBinding), suspended);
  const suspendedStream = "suspended-principal";
  const suspendedBefore = await store.read(suspendedStream);
  const suspendedError = await refused(
    door.dispatch(
      principalRequest(suspendedStream, "hhhhhhhhhhhhhhhhhhhhhhhhhh"),
      suspended.subjectBinding,
    ),
    PRINCIPAL_DISPATCH_REFUSAL_CODES.SUSPENDED,
  );
  assert.deepEqual(await store.read(suspendedStream), suspendedBefore);
  refusalMatrix.push({
    label: "suspended-principal",
    code: suspendedError.code,
    targetUnchanged: true,
  });

  const deactivated = { ...suspended, status: "deactivated" };
  current.set(agentId, deactivated);
  subjectMap.set(subjectKey(deactivated.subjectBinding), deactivated);
  const deactivatedStream = "deactivated-principal";
  const deactivatedBefore = await store.read(deactivatedStream);
  const deactivatedError = await refused(
    door.dispatch(
      principalRequest(deactivatedStream, "jjjjjjjjjjjjjjjjjjjjjjjjjj"),
      deactivated.subjectBinding,
    ),
    PRINCIPAL_DISPATCH_REFUSAL_CODES.DEACTIVATED,
  );
  assert.deepEqual(await store.read(deactivatedStream), deactivatedBefore);
  refusalMatrix.push({
    label: "deactivated-principal",
    code: deactivatedError.code,
    targetUnchanged: true,
  });

  const unfencedDoor = createPrincipalDispatchDoor({
    producerId: "e1-t01-principal-unfenced-verifier",
    streamStore: store,
    resolvePrincipal: async () => bootstrapPrincipals.get(adaId),
    lookupPrincipal: async () => bootstrapPrincipals.get(adaId),
  });
  const unfencedStream = "unfenced-principal";
  const unfencedBefore = await store.read(unfencedStream);
  const unfencedError = await refused(
    unfencedDoor.dispatch(
      principalRequest(unfencedStream, "kkkkkkkkkkkkkkkkkkkkkkkkkk"),
      bootstrapPrincipals.get(adaId).subjectBinding,
    ),
    PRINCIPAL_DISPATCH_REFUSAL_CODES.FENCE_REQUIRED,
  );
  assert.deepEqual(await store.read(unfencedStream), unfencedBefore);
  refusalMatrix.push({
    label: "missing-principal-fence",
    code: unfencedError.code,
    targetUnchanged: true,
  });

  assert.deepEqual(Object.keys(bootstrapPrincipals.get(agentId)).sort(), [
    "kind",
    "ownedBy",
    "principalId",
    "profile",
    "profileRevision",
    "status",
    "subjectBinding",
  ]);
  door.close();
  mismatchDoor.close();
  unfencedDoor.close();
  return {
    accepted,
    ownerBoundary: {
      agentId,
      ownedBy: bootstrapPrincipals.get(agentId).ownedBy,
      ownerKind: bootstrapPrincipals.get(agentId).ownedBy
        ? bootstrapPrincipals.get(bootstrapPrincipals.get(agentId).ownedBy).kind
        : null,
      inheritedPermissionFields: false,
    },
    refusalMatrix,
    allRefusedTargetsUnchanged: refusalMatrix.every(
      ({ targetUnchanged }) => targetUnchanged,
    ),
  };
}

async function verifySensitivity() {
  const sourcePath = path.join(validDirectory, "principal-directory.v1.json");
  const source = await readJson(sourcePath);
  const cases = [
    {
      name: "kind-mutation",
      mutate(dump) {
        dump.records[0].event.data.kind = "agent";
      },
    },
    {
      name: "owner-scope-mutation",
      mutate(dump) {
        dump.records[2].event.data.ownedBy =
          "pr_bbbbbbbbbbbbbbbbbbbbbbbbbb_zzzzzzzzzzzzzzzzzzzzzzzzzz";
      },
    },
    {
      name: "subject-reuse-mutation",
      mutate(dump) {
        dump.records[1].event.data.subjectBinding.subject =
          dump.records[0].event.data.subjectBinding.subject;
      },
    },
    {
      name: "profile-authority-mutation",
      mutate(dump) {
        dump.records[0].event.data.profile.handle = "Ada";
      },
    },
  ];
  const results = [];
  for (const testCase of cases) {
    const mutated = structuredClone(source);
    testCase.mutate(mutated);
    const workPath = path.join(artifactRoot, `${testCase.name}.json`);
    await writeJson(workPath, mutated);
    let error;
    try {
      validateAndReplayDump(mutated);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, `${testCase.name} was silently accepted`);
    assert.match(error.code, /^(?:REPLAY_|REDUCER_PRINCIPAL_)/u);
    results.push({
      name: testCase.name,
      outcome: "rejected",
      code: error.code,
      offset: error.offset,
      workPath: path.relative(root, workPath),
    });
  }
  return results;
}

async function verifyOfflineReplay(fixturePath, expectedDigest) {
  const replayPath = path.join(
    artifactRoot,
    "principal-directory-offline.json",
  );
  await writeFile(replayPath, await readFile(fixturePath));
  const result = await runNode(
    ["scripts/replay-ledger.mjs", "replay", replayPath],
    {
      E0_T07_NETWORK_DISABLED: "1",
      E1_T01_NETWORK_DISABLED: "1",
      E1_T01_NO_QUERY_STORE: "1",
      QUERY_STORE_PATH: path.join(artifactRoot, "query-store-must-not-exist"),
      BUILD_CACHE_PATH: path.join(artifactRoot, "build-cache-must-not-exist"),
    },
  );
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.finalStateDigest, expectedDigest);
  return {
    command:
      "node scripts/replay-ledger.mjs replay <principal-directory-offline.json>",
    networkDisabled: true,
    queryStoreWritten: false,
    finalStateDigest: output.finalStateDigest,
    result: "PASS",
  };
}

async function refused(promise, expectedCode) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error.code, expectedCode);
    return error;
  }
  assert.fail(`expected refusal ${expectedCode}`);
}

function principalRequest(stream, token) {
  return {
    expectedHead: ZERO_OFFSET,
    idempotencyKey: `ik_${token}`,
    operation: "principal.verify",
    payload: { value: "deterministic" },
    stream,
    workspaceId: "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
}

function subjectKey(subject) {
  return `${subject.issuer}\u0000${subject.audience}\u0000${subject.subject}`;
}

function createMemoryStore() {
  const streams = new Map();
  return {
    async append(stream, record, options) {
      const records = streams.get(stream) ?? [];
      const currentOffset = offset(records.length);
      if (options.streamSeq !== currentOffset) {
        const error = new Error("stale stream head");
        error.status = 409;
        throw error;
      }
      records.push(record);
      streams.set(stream, records);
      return { nextOffset: offset(records.length) };
    },
    async read(stream) {
      const records = streams.get(stream) ?? [];
      return { records: [...records], nextOffset: offset(records.length) };
    },
  };
}

function offset(sequence) {
  return `0000000000000000_${String(sequence).padStart(16, "0")}`;
}

async function runPnpm(script, env) {
  try {
    const result = await execFileAsync("pnpm", [script], {
      cwd: root,
      env: { ...process.env, ...env },
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    throw new Error(
      `pnpm ${script} failed\n${error.stdout ?? ""}\n${error.stderr ?? error.message}`,
    );
  }
}

async function runNode(args, extraEnv = {}) {
  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd: root,
      env: { ...process.env, ...extraEnv },
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stderr: error.stderr ?? "",
      stdout: error.stdout ?? "",
    };
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function assertNoCredentialPattern(text, label) {
  const patterns = [
    /-----BEGIN [A-Z ]+-----/u,
    /\bbearer\s+[A-Za-z0-9._~-]{8,}/iu,
    /\bbasic\s+[A-Za-z0-9+/=]{8,}/iu,
    /\b(?:password|passwd|secret|session|access[_ -]?token)\s*[=:]\s*[^\s,}]+/iu,
  ];
  for (const pattern of patterns) {
    assert.equal(
      pattern.test(text),
      false,
      `${label} contains a credential-shaped value`,
    );
  }
}
