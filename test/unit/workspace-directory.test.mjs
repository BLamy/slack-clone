import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createWorkspaceDirectoryAuthority } from "../../src/ledger/workspace-directory.mjs";

const WORKSPACE_A = "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const MEMBER_A = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";
const MEMBERSHIP_A = "mb_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc";

test("workspace directory retries transient provider startup and replays authority", async () => {
  const fixturePath = path.resolve(
    ".eforest/tasks/epic-1-the-workspace/E1-T02-workspace-membership-and-roles/fixtures/valid/workspace-membership.v1.json",
  );
  const dump = JSON.parse(await readFile(fixturePath, "utf8"));
  const bootstrapEvents = dump.records.map(({ event }) => event);
  const records = [];
  let ensureCalls = 0;
  const streamStore = {
    async append(_stream, event, { streamSeq }) {
      const expected = offset(records.length);
      assert.equal(streamSeq, expected);
      records.push(event);
      return { nextOffset: offset(records.length) };
    },
    async ensure() {
      ensureCalls += 1;
      if (ensureCalls === 1) throw new Error("provider is still starting");
    },
    async read() {
      return { nextOffset: offset(records.length), records: [...records] };
    },
  };
  const authority = createWorkspaceDirectoryAuthority({
    bootstrapEvents,
    streamStore,
    workspaceId: WORKSPACE_A,
  });

  await assert.rejects(
    authority.lookupMembership(WORKSPACE_A, MEMBER_A),
    /provider is still starting/u,
  );
  const membership = await authority.lookupMembership(WORKSPACE_A, MEMBER_A);
  assert.equal(ensureCalls, 2);
  assert.equal(records.length, bootstrapEvents.length);
  assert.equal(membership.membershipId, MEMBERSHIP_A);
  assert.equal(membership.role, "admin");
  assert.equal(membership.status, "active");
});

function offset(sequence) {
  return `0000000000000000_${String(sequence).padStart(16, "0")}`;
}
