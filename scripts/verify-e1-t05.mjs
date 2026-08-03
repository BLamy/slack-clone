import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { observeHttpIdleWindow } from "../test/support/http-idle-probe.mjs";
import { startStack } from "./test-stack.mjs";
import { createRunContext } from "./run-context.mjs";

const root = path.resolve(import.meta.dirname, "..");
const taskDirectory = path.join(
  root,
  ".eforest/tasks/epic-1-the-workspace/E1-T05-resumable-live-chat-api",
);
const runId = String(
  process.env.TEST_RUN_ID ?? `verify-${process.pid}-${Date.now().toString(36)}`,
)
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/gu, "-");
const implementationCommit = String(
  process.env.E1_T05_IMPLEMENTATION_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
).trim();
assert.match(
  implementationCommit,
  /^[0-9a-f]{40}$/u,
  "E1-T05 evidence requires an exact implementation commit",
);
assertImplementationBinding(implementationCommit);

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
    "promoted E1-T05 evidence must start from a clean tracked implementation tree",
  );
}

const artifactRoot = path.resolve(
  root,
  process.env.TEST_ARTIFACT_DIR ?? path.join(".artifacts", "e1-t05", runId),
);
const evidenceDirectory = promoteEvidence
  ? path.join(taskDirectory, "evidence/e1-t05-final")
  : artifactRoot;
await mkdir(evidenceDirectory, { recursive: true });

const gates = await runGates();
const networkEvidence = await verifyRealEmulatorScenario();
const idleObservation = await observeHttpIdleWindow();
assert.equal(idleObservation.callDeltaWhileIdle, 0);
assert.equal(idleObservation.readCallsAfterLogicalAdvance, 1);
assert.equal(idleObservation.followCallsAfterLogicalAdvance, 1);
assert.equal(idleObservation.authorizeSubscriptionCalls, 1);
assert.equal(idleObservation.keepAliveTimerExecutions, 90);
assert.equal(idleObservation.authorizeReadCalls, 90);
assert.equal(idleObservation.directoryReadCalls, 91);
assert.equal(idleObservation.roomStatusReadCalls, 91);

const summary = {
  schemaVersion: 1,
  task: "E1-T05",
  runId,
  implementationCommit,
  implementationTreeCleanAtStart: promoteEvidence ? true : null,
  result: "PASS",
  replay:
    "Replay: N/A (server live-delivery API) + mitigation: real-emulator network transcript, reconnect matrix, request counts, and digest convergence",
  replayUploadAttempted: false,
  adversarialCoverage: {
    focusedTestFile: "test/unit/live-chat-http.test.mjs",
    cases: [
      "provider-rejected stale checkpoint is typed 409 before headers",
      "reconnect after a durable channel archive is refused before headers",
      "session logout terminates queued delivery without leaking a message",
      "durable channel archive terminates live delivery at the last acknowledged checkpoint",
      "slow reader on one channel cannot block another channel",
      "membership revalidation runs before batches and heartbeats",
      "delivery.close terminates every client exactly once",
      "disconnect after message write and during heartbeat does not advance the checkpoint",
      "sibling-workspace event checkpoints are refused before the stream opens",
    ],
    pollingSensitivity:
      "test/unit/durable-streams-adapter.test.mjs rejects a 350 ms polling positive control",
  },
  coldClone:
    process.env.E1_T05_COLD_CLONE === "1"
      ? {
          result: "PASS",
          bootstrapCommands: [
            "pnpm install --frozen-lockfile",
            "pnpm setup:emulate",
            "node scripts/verify-e1-t05.mjs",
          ],
          transcript: "cold-clone-transcript.json",
        }
      : null,
  gates,
  idleRequestBudget: {
    ...idleObservation,
    result: "PASS",
    productionAuthorizationWiring:
      "shared live revalidator performs workspace and channel checks at connection open and on every 10-second heartbeat",
    pollingPositiveControl:
      "covered by test/unit/durable-streams-adapter.test.mjs",
  },
  networkEvidence,
};

await writeJson(
  path.join(evidenceDirectory, "verification-summary.json"),
  summary,
);
await writeJson(
  path.join(evidenceDirectory, "network-transcript.json"),
  networkEvidence,
);
await writeJson(
  path.join(evidenceDirectory, "idle-request-budget.json"),
  summary.idleRequestBudget,
);
console.log(JSON.stringify(summary, null, 2));

async function runGates() {
  if (process.env.E1_T05_SKIP_GATES === "1") return [];
  const results = [];
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
        E1_T05_IMPLEMENTATION_COMMIT: implementationCommit,
        E1_T05_SKIP_GATES: "1",
        TEST_ARTIFACT_DIR: artifactRoot,
        TEST_RUN_ID: runId,
      },
      stdio: "inherit",
    });
    results.push({
      command: `pnpm ${script}`,
      durationMs: Date.now() - startedAt,
      name,
      result: "PASS",
    });
  }
  return results;
}

async function verifyRealEmulatorScenario() {
  const context = await createRunContext({
    env: {
      ...process.env,
      TEST_ARTIFACT_DIR: artifactRoot,
      TEST_ROOM_PREFIX: `e1-t05-${runId}`,
    },
  });
  const stack = await startStack(context);
  const transcript = [];
  const clients = [];
  const room = `${context.roomPrefix}-resume`;
  try {
    const adaCookie = await login(context.appBaseUrl, "ada@example.test", room);
    const linusCookie = await login(
      context.appBaseUrl,
      "linus@example.test",
      room,
    );
    await assertSession(context.appBaseUrl, adaCookie, transcript, "ada");
    await assertSession(context.appBaseUrl, linusCookie, transcript, "linus");

    const ada = await openSse(
      context.appBaseUrl,
      room,
      adaCookie,
      transcript,
      "ada-initial",
    );
    const linus = await openSse(
      context.appBaseUrl,
      room,
      linusCookie,
      transcript,
      "linus-initial",
    );
    clients.push(ada, linus);
    const adaSnapshot = await ada.next("snapshot");
    const linusSnapshot = await linus.next("snapshot");
    assert.equal(adaSnapshot.data.nextOffset, linusSnapshot.data.nextOffset);
    assert.equal(
      adaSnapshot.data.streamDigest,
      linusSnapshot.data.streamDigest,
    );
    const adaInitialStatus = await ada.next("status");
    const linusInitialStatus = await linus.next("status");
    assert.equal(adaInitialStatus.data.nextOffset, adaSnapshot.data.nextOffset);
    assert.equal(
      linusInitialStatus.data.nextOffset,
      linusSnapshot.data.nextOffset,
    );

    const firstPost = await postMessage(
      context.appBaseUrl,
      room,
      adaCookie,
      "e1-t05 first durable event",
      "ik_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      transcript,
    );
    const firstAdaMessage = await ada.next("message");
    const firstLinusMessage = await linus.next("message");
    assert.equal(firstAdaMessage.data.id, firstPost.message.id);
    assert.equal(firstLinusMessage.data.id, firstPost.message.id);
    const firstAdaStatus = await nextStatus(ada, firstPost.nextOffset);
    const firstLinusStatus = await nextStatus(linus, firstPost.nextOffset);
    assert.equal(firstAdaStatus.data.nextOffset, firstPost.nextOffset);
    assert.equal(firstLinusStatus.data.nextOffset, firstPost.nextOffset);
    const firstCheckpoint = firstAdaStatus.data.nextOffset;

    await ada.close();
    const secondPost = await postMessage(
      context.appBaseUrl,
      room,
      linusCookie,
      "e1-t05 replayed after disconnect",
      "ik_bbbbbbbbbbbbbbbbbbbbbbbbbb",
      transcript,
    );
    const liveSecond = await linus.next("message");
    assert.equal(liveSecond.data.id, secondPost.message.id);
    await nextStatus(linus, secondPost.nextOffset);

    const resumedAda = await openSse(
      context.appBaseUrl,
      room,
      adaCookie,
      transcript,
      "ada-resumed",
      firstCheckpoint,
    );
    clients.push(resumedAda);
    const resumeFrame = await resumedAda.next("resume");
    assert.equal(resumeFrame.data.fromOffset, firstCheckpoint);
    const resumedMessage = await resumedAda.next("message");
    assert.equal(resumedMessage.data.id, secondPost.message.id);
    const resumedStatus = await nextStatus(resumedAda, secondPost.nextOffset);
    assert.equal(resumedStatus.data.nextOffset, secondPost.nextOffset);

    const [adaState, linusState] = await Promise.all([
      readState(context.appBaseUrl, room, adaCookie, transcript, "ada-final"),
      readState(
        context.appBaseUrl,
        room,
        linusCookie,
        transcript,
        "linus-final",
      ),
    ]);
    assert.equal(adaState.streamDigest, linusState.streamDigest);
    assert.deepEqual(
      adaState.messages.map((message) => message.id),
      linusState.messages.map((message) => message.id),
    );
    assert.deepEqual(
      adaState.messages.map((message) => message.id),
      [firstPost.message.id, secondPost.message.id],
    );

    const malformed = await fetchJson(
      `${context.appBaseUrl}/api/rooms/${encodeURIComponent(room)}/events?offset=%00`,
      { headers: { Cookie: adaCookie } },
      transcript,
      "malformed-checkpoint",
    );
    assert.equal(malformed.response.status, 400);
    assert.equal(malformed.body.code, "LIVE_CHECKPOINT_INVALID");

    const isolationRoom = `${context.roomPrefix}-isolation`;
    const isolatedAda = await openSse(
      context.appBaseUrl,
      isolationRoom,
      adaCookie,
      transcript,
      "ada-isolation",
    );
    const isolatedLinus = await openSse(
      context.appBaseUrl,
      `${context.roomPrefix}-idle`,
      linusCookie,
      transcript,
      "linus-isolation",
    );
    clients.push(isolatedAda, isolatedLinus);
    await isolatedAda.next("snapshot");
    await isolatedAda.next("status");
    await isolatedLinus.next("snapshot");
    await isolatedLinus.next("status");
    const isolatedPost = await postMessage(
      context.appBaseUrl,
      isolationRoom,
      adaCookie,
      "e1-t05 isolated channel event",
      "ik_cccccccccccccccccccccccccc",
      transcript,
    );
    assert.equal(
      (await isolatedAda.next("message")).data.id,
      isolatedPost.message.id,
    );
    await nextStatus(isolatedAda, isolatedPost.nextOffset);
    await assertNoEvent(isolatedLinus, "message", 250);
    const archiveResult = await archiveRoom(
      context.appBaseUrl,
      isolationRoom,
      adaCookie,
      transcript,
    );
    assert.equal(archiveResult.archived, true);
    const archiveTerminal = await isolatedAda.next("terminal");
    assert.equal(archiveTerminal.data.code, "LIVE_CHANNEL_ARCHIVED");
    const archivedReconnect = await fetchJson(
      `${context.appBaseUrl}/api/rooms/${encodeURIComponent(isolationRoom)}/events?offset=${encodeURIComponent(archiveResult.nextOffset)}`,
      { headers: { Cookie: adaCookie } },
      transcript,
      "archive-reconnect-after-status",
    );
    assert.equal(archivedReconnect.response.status, 409);
    assert.equal(archivedReconnect.body.code, "LIVE_CHANNEL_ARCHIVED");
    const archivedWrite = await fetchJson(
      `${context.appBaseUrl}/api/rooms/${encodeURIComponent(isolationRoom)}/messages`,
      {
        body: JSON.stringify({ text: "must not write after archive" }),
        headers: {
          "Content-Type": "application/json",
          Cookie: adaCookie,
          "Idempotency-Key": "ik_ffffffffffffffffffffffffff",
        },
        method: "POST",
      },
      transcript,
      "archive-write-after-status",
    );
    assert.equal(archivedWrite.response.status, 409);
    assert.equal(archivedWrite.body.code, "CHAT_ROOM_ARCHIVED");

    const logoutRoom = `${context.roomPrefix}-logout`;
    const logoutAda = await openSse(
      context.appBaseUrl,
      logoutRoom,
      adaCookie,
      transcript,
      "ada-logout",
    );
    clients.push(logoutAda);
    await logoutAda.next("snapshot");
    await logoutAda.next("status");
    const logoutResponse = await fetch(`${context.appBaseUrl}/logout`, {
      headers: { Cookie: adaCookie },
      redirect: "manual",
    });
    transcript.push({
      label: "ada-logout",
      method: "GET",
      path: "/logout",
      status: logoutResponse.status,
    });
    assert.equal(logoutResponse.status, 302);
    await postMessage(
      context.appBaseUrl,
      logoutRoom,
      linusCookie,
      "e1-t05 post after ada logout",
      "ik_dddddddddddddddddddddddddd",
      transcript,
    );
    const logoutTerminal = await logoutAda.next("terminal");
    assert.equal(logoutTerminal.data.code, "LIVE_SESSION_REVOKED");

    const summary = {
      room,
      clients: 2,
      firstCheckpoint,
      secondCheckpoint: secondPost.nextOffset,
      acceptedMessageIds: [firstPost.message.id, secondPost.message.id],
      resumedMessageIds: [resumedMessage.data.id],
      finalDigest: adaState.streamDigest,
      finalOffsets: {
        ada: adaState.nextOffset,
        linus: linusState.nextOffset,
      },
      noDuplicateLogicalEffects:
        new Set(adaState.messages.map((message) => message.id)).size === 2,
      crossRoomIsolation: {
        isolatedRoom: isolationRoom,
        idleRoom: `${context.roomPrefix}-idle`,
        acceptedMessageId: isolatedPost.message.id,
        otherClientReceivedMessage: false,
      },
      archive: {
        responseStatus: archiveResult.responseStatus,
        terminalCode: archiveTerminal.data.code,
        checkpoint: archiveTerminal.data.nextOffset,
        reconnectAfterArchive: {
          status: archivedReconnect.response.status,
          code: archivedReconnect.body.code,
          checkpoint: archiveResult.nextOffset,
        },
        writeAfterArchive: {
          status: archivedWrite.response.status,
          code: archivedWrite.body.code,
        },
      },
      logout: {
        responseStatus: logoutResponse.status,
        terminalCode: logoutTerminal.data.code,
      },
      reconnectMatrix: [
        "after acknowledged status before next append",
        "append while one client disconnected",
        "resume from opaque Last-Event-ID-equivalent query checkpoint",
        "independent room remains idle while a sibling room receives an event",
        "archive event terminates the hot room at its acknowledged checkpoint",
        "reconnect from a post-archive checkpoint is refused before SSE headers",
        "message mutation after archive is refused by the durable room authority",
        "logout before the next queued event",
      ],
      typedRefusal: {
        status: malformed.response.status,
        code: malformed.body.code,
      },
      transcript,
    };
    return summary;
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await stack.stop();
  }
}

async function login(baseUrl, email, room) {
  const response = await fetch(`${baseUrl}/login`, {
    body: new URLSearchParams({
      email,
      password: "DemoPass123",
      returnTo: `/app?room=${room}`,
    }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
    redirect: "manual",
  });
  assert.equal(response.status, 302);
  const setCookies = response.headers.getSetCookie?.() ?? [];
  const cookieHeader = setCookies[0] ?? response.headers.get("set-cookie");
  assert.ok(cookieHeader, `login did not return a session cookie for ${email}`);
  return cookieHeader.split(";", 1)[0];
}

async function assertSession(baseUrl, cookie, transcript, label) {
  const result = await fetchJson(
    `${baseUrl}/api/session`,
    { headers: { Cookie: cookie } },
    transcript,
    `${label}-session`,
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.body.ok, true);
}

async function postMessage(
  baseUrl,
  room,
  cookie,
  text,
  idempotencyKey,
  transcript,
) {
  const result = await fetchJson(
    `${baseUrl}/api/rooms/${encodeURIComponent(room)}/messages`,
    {
      body: JSON.stringify({ text }),
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "Idempotency-Key": idempotencyKey,
      },
      method: "POST",
    },
    transcript,
    `post-${idempotencyKey}`,
  );
  assert.equal(result.response.status, 201);
  return result.body;
}

async function archiveRoom(baseUrl, room, cookie, transcript) {
  const result = await fetchJson(
    `${baseUrl}/api/rooms/${encodeURIComponent(room)}/archive`,
    {
      headers: {
        Cookie: cookie,
        "Idempotency-Key": "ik_eeeeeeeeeeeeeeeeeeeeeeeeee",
      },
      method: "POST",
    },
    transcript,
    "archive-room",
  );
  assert.equal(result.response.status, 200);
  return { ...result.body, responseStatus: result.response.status };
}

async function readState(baseUrl, room, cookie, transcript, label) {
  const result = await fetchJson(
    `${baseUrl}/api/rooms/${encodeURIComponent(room)}/messages`,
    { headers: { Cookie: cookie } },
    transcript,
    label,
  );
  assert.equal(result.response.status, 200);
  return result.body;
}

async function fetchJson(url, init, transcript, label) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  transcript.push({
    bodyCode: body.code ?? null,
    label,
    method: init.method ?? "GET",
    path: new URL(url).pathname + new URL(url).search,
    status: response.status,
  });
  return { body, response };
}

async function openSse(
  baseUrl,
  room,
  cookie,
  transcript,
  label,
  offset = null,
) {
  const suffix = offset === null ? "" : `?offset=${encodeURIComponent(offset)}`;
  const url = `${baseUrl}/api/rooms/${encodeURIComponent(room)}/events${suffix}`;
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { Accept: "text/event-stream", Cookie: cookie },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  transcript.push({
    checkpoint: offset,
    label,
    method: "GET",
    path: new URL(url).pathname + new URL(url).search,
    status: response.status,
  });
  const reader = response.body.getReader();
  let buffer = "";
  const queue = [];
  const seen = [];
  const waiters = [];
  let closed = false;
  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = parseSseFrame(frame);
          if (!event) continue;
          seen.push(event);
          const waiter = waiters.findIndex(
            ({ name }) => name === null || name === event.name,
          );
          if (waiter === -1) queue.push(event);
          else waiters.splice(waiter, 1)[0].resolve(event);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        for (const waiter of waiters.splice(0)) waiter.reject(error);
      }
    } finally {
      closed = true;
      for (const waiter of waiters.splice(0)) {
        waiter.reject(new Error(`SSE stream ${label} closed before its event`));
      }
    }
  })();

  return {
    async close() {
      if (closed) return;
      controller.abort();
      await reader.cancel().catch(() => {});
      await pump.catch(() => {});
    },
    async next(name, timeoutMs = 10_000) {
      const queued = queue.findIndex(
        (event) => name === null || event.name === name,
      );
      if (queued !== -1) return queue.splice(queued, 1)[0];
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex(
            (waiter) => waiter.resolve === resolve,
          );
          if (index !== -1) waiters.splice(index, 1);
          reject(
            new Error(
              `timed out waiting for ${name} on ${label}; seen=${JSON.stringify(seen.map(({ name: eventName, data }) => ({ data, name: eventName })))}; queued=${JSON.stringify(queue.map(({ name: eventName, data }) => ({ data, name: eventName })))}`,
            ),
          );
        }, timeoutMs);
        waiters.push({
          name,
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
          resolve: (event) => {
            clearTimeout(timer);
            resolve(event);
          },
        });
      });
    },
    get seen() {
      return seen;
    },
  };
}

async function nextStatus(client, expectedOffset) {
  while (true) {
    const status = await client.next("status");
    if (status.data.nextOffset === expectedOffset) return status;
  }
}

async function assertNoEvent(client, name, timeoutMs) {
  await assert.rejects(client.next(name, timeoutMs));
}

function parseSseFrame(frame) {
  const lines = frame.split("\n");
  const name = lines.find((line) => line.startsWith("event: "))?.slice(7);
  const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
  if (!name || data === undefined) return null;
  return {
    data: JSON.parse(data),
    id: lines.find((line) => line.startsWith("id: "))?.slice(4) ?? null,
    name,
  };
}

function assertImplementationBinding(commit) {
  const resolved = execFileSync(
    "git",
    ["rev-parse", "--verify", `${commit}^{commit}`],
    { cwd: root, encoding: "utf8" },
  ).trim();
  assert.equal(resolved, commit, "implementation commit must resolve exactly");
  execFileSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], {
    cwd: root,
    stdio: "ignore",
  });
  const changedPaths = execFileSync(
    "git",
    ["diff", "--name-only", `${commit}..HEAD`],
    { cwd: root, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const taskReadmePath = path.relative(
    root,
    path.join(taskDirectory, "readme.md"),
  );
  const evidencePrefix = `${path
    .relative(root, path.join(taskDirectory, "evidence"))
    .replaceAll(path.sep, "/")}/`;
  const unexpected = changedPaths.filter(
    (filePath) =>
      filePath !== ".eforest/tasks/QUEUE.md" &&
      filePath !== taskReadmePath &&
      !filePath.startsWith(evidencePrefix),
  );
  assert.deepEqual(
    unexpected,
    [],
    "implementation commit must bind the exact diff",
  );
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

const forbiddenCredentialPatterns = [
  /bearer\s+[A-Za-z0-9._-]+/iu,
  /password\s*[=:]/iu,
  /api[_-]?key\s*[=:]/iu,
  /-----BEGIN [A-Z ]+-----/u,
];
for (const pattern of forbiddenCredentialPatterns) {
  assert.doesNotMatch(
    await readFile(path.join(root, "public/app.js"), "utf8"),
    pattern,
    "browser asset contains a credential pattern",
  );
}
