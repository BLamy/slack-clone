import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertPrincipalCanMutate,
  assertPrincipalSubject,
  PRINCIPAL_ERROR_CODES,
  PrincipalValidationError,
  ZERO_OFFSET,
  validatePrincipalProfile,
  validateSubjectBinding,
} from "@stream-slack/protocol";
import { validateAndReplayDump } from "../../src/ledger/replay.mjs";
import {
  createPrincipalDispatchDoor,
  PRINCIPAL_DISPATCH_REFUSAL_CODES,
} from "../../src/ledger/dispatch.mjs";

const WORKSPACE_ID = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADA_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const AGENT_ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd";

const ADA_SUBJECT = {
  audience: "stream-slack",
  issuer: "auth0",
  subject: "auth0-user-ada",
};
const AGENT_SUBJECT = {
  audience: "stream-slack",
  issuer: "stream-slack-agent",
  subject: "agent-helper-1",
};

const ADA = {
  kind: "human",
  ownedBy: null,
  principalId: ADA_ID,
  profile: {
    displayName: "Ada Lovelace",
    email: "ada@example.com",
    handle: "ada",
  },
  profileRevision: 1,
  status: "active",
  subjectBinding: ADA_SUBJECT,
};

const AGENT = {
  kind: "agent",
  ownedBy: ADA_ID,
  principalId: AGENT_ID,
  profile: {
    displayName: "Workspace Helper",
    email: "",
    handle: "workspace-helper",
  },
  profileRevision: 1,
  status: "active",
  subjectBinding: AGENT_SUBJECT,
};

test("principal contracts reject credential-shaped subjects and mutable profile authority", () => {
  assert.doesNotThrow(() => validateSubjectBinding(ADA_SUBJECT));
  assert.doesNotThrow(() => validatePrincipalProfile(ADA.profile));
  assert.throws(
    () =>
      validateSubjectBinding({
        ...ADA_SUBJECT,
        subject: "Bearer should-not-be-a-subject",
      }),
    (error) =>
      error instanceof PrincipalValidationError &&
      error.code === PRINCIPAL_ERROR_CODES.INVALID_SUBJECT_BINDING,
  );
  assert.throws(
    () => assertPrincipalSubject(ADA, AGENT_SUBJECT),
    (error) => error.code === PRINCIPAL_ERROR_CODES.SUBJECT_MISMATCH,
  );
  assert.throws(
    () => assertPrincipalCanMutate({ ...ADA, status: "suspended" }),
    (error) => error.code === PRINCIPAL_ERROR_CODES.SUSPENDED,
  );
});

test("golden principal fixtures preserve IDs while profiles and lifecycle state change", async () => {
  const fixturePath =
    ".eforest/tasks/epic-1-the-workspace/E1-T01-principal-event-model/fixtures/valid/principal-directory.v1.json";
  const dump = JSON.parse(await readFile(fixturePath, "utf8"));
  const first = validateAndReplayDump(dump);
  const second = validateAndReplayDump(structuredClone(dump));
  assert.equal(first.finalStateDigest, second.finalStateDigest);
  assert.deepEqual(
    first.prefixes.map(({ offset, stateDigest }) => ({ offset, stateDigest })),
    second.prefixes.map(({ offset, stateDigest }) => ({ offset, stateDigest })),
  );
  assert.equal(
    first.finalState.entities.principals[AGENT_ID].status,
    "deactivated",
  );
  assert.equal(first.finalState.entities.principals[AGENT_ID].ownedBy, ADA_ID);
  const profileUpdate = first.finalState.eventProvenance.find(
    ({ envelope }) => envelope.eventType === "principal.profile.updated",
  );
  assert.equal(profileUpdate.envelope.actorId, ADA_ID);
});

test("principal dispatch stamps authenticated identity and fences stale lifecycle state", async () => {
  const store = createMemoryStore();
  const current = new Map([
    [ADA_ID, ADA],
    [AGENT_ID, AGENT],
  ]);
  const bySubject = new Map([
    [subjectKey(ADA_SUBJECT), ADA],
    [subjectKey(AGENT_SUBJECT), AGENT],
  ]);
  const door = createPrincipalDispatchDoor({
    producerId: "unit-principal-door",
    streamStore: store,
    resolvePrincipal: async (subject) =>
      bySubject.get(subjectKey(subject)) ?? null,
    lookupPrincipal: async (principalId) => current.get(principalId) ?? null,
  });

  const humanResult = await door.dispatch(
    request("human-principal-stream", "aaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ADA_SUBJECT,
  );
  assert.equal(humanResult.event.dispatch.actorId, ADA_ID);

  const agentResult = await door.dispatch(
    request("agent-principal-stream", "bbbbbbbbbbbbbbbbbbbbbbbbbb"),
    AGENT_SUBJECT,
  );
  assert.equal(agentResult.event.dispatch.actorId, AGENT_ID);
  assert.notEqual(agentResult.event.dispatch.actorId, ADA_ID);

  await assert.rejects(
    door.dispatch(
      {
        ...request("spoof-stream", "cccccccccccccccccccccccccc"),
        actorId: ADA_ID,
      },
      AGENT_SUBJECT,
    ),
    (error) =>
      error.code === PRINCIPAL_DISPATCH_REFUSAL_CODES.ACTOR_FIELD_FORBIDDEN,
  );
  await assert.rejects(
    door.dispatch(
      {
        ...request("payload-spoof-stream", "eeeeeeeeeeeeeeeeeeeeeeeeee"),
        payload: { actorId: ADA_ID },
      },
      AGENT_SUBJECT,
    ),
    (error) =>
      error.code === PRINCIPAL_DISPATCH_REFUSAL_CODES.ACTOR_FIELD_FORBIDDEN,
  );

  current.set(ADA_ID, {
    ...ADA,
    subjectBinding: { ...ADA_SUBJECT, subject: "rotated-subject" },
  });
  await assert.rejects(
    door.dispatch(
      request("subject-race-stream", "dddddddddddddddddddddddddd"),
      ADA_SUBJECT,
    ),
    (error) => error.code === PRINCIPAL_DISPATCH_REFUSAL_CODES.SUBJECT_MISMATCH,
  );
  current.set(ADA_ID, ADA);

  current.set(AGENT_ID, { ...AGENT, status: "suspended" });
  const before = await store.read("blocked-principal-stream");
  await assert.rejects(
    door.dispatch(
      request("blocked-principal-stream", "ffffffffffffffffffffffffff"),
      AGENT_SUBJECT,
    ),
    (error) => error.code === PRINCIPAL_DISPATCH_REFUSAL_CODES.SUSPENDED,
  );
  assert.deepEqual(await store.read("blocked-principal-stream"), before);
  door.close();
});

function request(stream, token) {
  return {
    expectedHead: ZERO_OFFSET,
    idempotencyKey: `ik_${token}`,
    operation: "principal.test",
    payload: { value: "accepted" },
    stream,
    workspaceId: WORKSPACE_ID,
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
      const nextOffset = offset(records.length);
      if (options.streamSeq !== nextOffset) {
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
