import assert from "node:assert/strict";
import test from "node:test";

import { streamNames } from "../../src/ledger/topology.mjs";
import {
  CAPSTONE_IDS,
  createCapstoneAuthorityState,
  createCapstoneSnapshot,
} from "../support/e3-capstone-fixture.mjs";

test("E3 capstone fixture binds one active agent snapshot to the source mention", () => {
  const sourceTrigger = {
    digest: `sha256:${"a".repeat(64)}`,
    offset: "0000000000000001_0000000000000001",
    stream: streamNames.channel(
      CAPSTONE_IDS.workspaceId,
      CAPSTONE_IDS.channelId,
    ),
  };
  const snapshot = createCapstoneSnapshot(sourceTrigger);
  assert.match(snapshot.snapshotDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(snapshot.context.channelId, CAPSTONE_IDS.channelId);
  const state = createCapstoneAuthorityState();
  assert.equal(
    state.entities.principals[CAPSTONE_IDS.agentPrincipalId].kind,
    "agent",
  );
});
