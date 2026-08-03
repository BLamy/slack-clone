import {
  membershipIdFor,
  validatePrincipalId,
  validateWorkspaceId,
} from "@stream-slack/protocol";

import { validateAndReplayDump } from "./replay.mjs";
import { streamNames } from "./topology.mjs";

export function createWorkspaceDirectoryAuthority({
  bootstrapEvents = [],
  streamStore,
  workspaceId,
}) {
  if (
    !streamStore ||
    typeof streamStore.ensure !== "function" ||
    typeof streamStore.read !== "function" ||
    typeof streamStore.append !== "function"
  ) {
    throw new TypeError("workspace directory requires a Durable Streams store");
  }
  validateWorkspaceId(workspaceId);
  if (!Array.isArray(bootstrapEvents)) {
    throw new TypeError(
      "workspace directory bootstrap events must be an array",
    );
  }

  const stream = streamNames.workspaceDirectory(workspaceId);
  let ready = null;

  async function lookupMembership(requestedWorkspaceId, principalId) {
    if (requestedWorkspaceId !== workspaceId) return null;
    validatePrincipalId(principalId, { expectedWorkspaceId: workspaceId });
    await ensureReady();
    const replay = await readReplay();
    const membershipId = membershipIdFor(workspaceId, principalId);
    return replay.finalState.entities.memberships?.[membershipId] ?? null;
  }

  function ensureReady() {
    if (!ready) {
      ready = initialize().catch((error) => {
        ready = null;
        throw error;
      });
    }
    return ready;
  }

  async function initialize() {
    await streamStore.ensure(stream);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = await streamStore.read(stream, "-1");
      if (snapshot.records.length >= bootstrapEvents.length) {
        assertBootstrapPrefix(snapshot.records);
        await readReplay(snapshot);
        return;
      }
      assertBootstrapPrefix(snapshot.records);
      let head = snapshot.nextOffset;
      try {
        for (
          let index = snapshot.records.length;
          index < bootstrapEvents.length;
          index += 1
        ) {
          const appended = await streamStore.append(
            stream,
            bootstrapEvents[index],
            {
              streamSeq: head,
            },
          );
          head = appended.nextOffset;
        }
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
    throw new Error("workspace directory bootstrap did not converge");
  }

  async function readReplay(snapshot = null) {
    const current = snapshot ?? (await streamStore.read(stream, "-1"));
    return validateAndReplayDump({
      records: current.records.map((record, index) => ({
        event: record?.event ?? record,
        offset: directoryOffset(index + 1),
      })),
    });
  }

  function assertBootstrapPrefix(records) {
    for (let index = 0; index < records.length; index += 1) {
      const actual = records[index]?.event ?? records[index];
      const expected = bootstrapEvents[index];
      if (actual?.eventId !== expected?.eventId) {
        throw new Error(
          "workspace directory contains an unexpected event prefix",
        );
      }
    }
  }

  return Object.freeze({
    lookupMembership,
    get ready() {
      return ensureReady();
    },
    stream,
  });
}

function directoryOffset(sequence) {
  return `0000000000000000_${String(sequence).padStart(16, "0")}`;
}
