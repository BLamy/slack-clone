import {
  membershipIdFor,
  sameSubjectBinding,
  validateAuthenticatedSubject,
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

  async function lookupPrincipal(requestedWorkspaceId, principalId) {
    if (requestedWorkspaceId !== workspaceId) return null;
    validatePrincipalId(principalId, { expectedWorkspaceId: workspaceId });
    await ensureReady();
    const replay = await readReplay();
    return replay.finalState.entities.principals?.[principalId] ?? null;
  }

  async function lookupPrincipalBySubject(
    requestedWorkspaceId,
    authenticatedSubject,
  ) {
    if (requestedWorkspaceId !== workspaceId) return null;
    validateAuthenticatedSubject(authenticatedSubject);
    await ensureReady();
    const replay = await readReplay();
    return (
      Object.values(replay.finalState.entities.principals ?? {}).find(
        (principal) =>
          sameSubjectBinding(principal.subjectBinding, authenticatedSubject),
      ) ?? null
    );
  }

  async function read({ signal } = {}) {
    await ensureReady();
    const snapshot = await streamStore.read(stream, "-1", { signal });
    const replay = await readReplay(snapshot);
    return {
      ...snapshot,
      replay,
      state: replay.finalState,
      stateDigest: replay.finalStateDigest,
      stream,
    };
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
    const prefixLength = Math.min(records.length, bootstrapEvents.length);
    for (let index = 0; index < prefixLength; index += 1) {
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
    lookupPrincipal,
    lookupPrincipalBySubject,
    read,
    get ready() {
      return ensureReady();
    },
    stream,
  });
}

function directoryOffset(sequence) {
  return `0000000000000000_${String(sequence).padStart(16, "0")}`;
}
