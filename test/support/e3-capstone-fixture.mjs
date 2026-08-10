import { readFileSync } from "node:fs";

import {
  agentConfigDigest,
  agentConfigRevisionId,
  createInvocationSnapshot,
  createProviderRegistry,
  membershipIdFor,
} from "@stream-slack/protocol";
import { createInitialState } from "@stream-slack/reducers";

import { canonicalSha256 } from "../../src/ledger/canonical-json.mjs";
import {
  digestEventEnvelope,
  issueEventEnvelope,
} from "../../src/ledger/envelope.mjs";
import { streamNames } from "../../src/ledger/topology.mjs";
import { deterministicOffset } from "./durable-stream-harness.mjs";

export const CAPSTONE_IDS = Object.freeze({
  agentId: "ag_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd",
  agentPrincipalId: "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_dddddddddddddddddddddddddd",
  channelId: "ch_aaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbb",
  humanId: "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_cccccccccccccccccccccccccc",
  secondHumanId: "pr_aaaaaaaaaaaaaaaaaaaaaaaaaa_eeeeeeeeeeeeeeeeeeeeeeeeee",
  workspaceId: "ws_aaaaaaaaaaaaaaaaaaaaaaaaaa",
});

export const CAPSTONE_TIME = "2026-08-10T00:00:00.000Z";

const config = JSON.parse(
  readFileSync(
    new URL(
      "../../.eforest/tasks/epic-2-the-roster/E2-T01-versioned-agent-config-schema/fixtures/valid/agent-config.v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

export function createCapstoneAuthorityState() {
  const state = createInitialState();
  const { agentPrincipalId, channelId, humanId, secondHumanId, workspaceId } =
    CAPSTONE_IDS;
  state.entities.principals = {
    [humanId]: principal(humanId, "brett", "human"),
    [secondHumanId]: principal(secondHumanId, "sam", "human"),
    [agentPrincipalId]: principal(agentPrincipalId, "helper", "agent", humanId),
  };
  state.entities.channels = {
    [channelId]: {
      channelId,
      creatorId: humanId,
      status: "active",
      workspaceId,
    },
  };
  state.entities.memberships = {};
  state.entities.channelMemberships = {};
  for (const principalId of [humanId, secondHumanId, agentPrincipalId]) {
    state.entities.memberships[membershipIdFor(workspaceId, principalId)] = {
      principalId,
      role: principalId === agentPrincipalId ? "agent" : "member",
      status: "active",
      workspaceId,
    };
    state.entities.channelMemberships[`${channelId}\u0000${principalId}`] = {
      channelId,
      principalId,
      status: "active",
      workspaceId,
    };
  }
  return state;
}

export function createCapstoneSnapshot(sourceTrigger) {
  const { agentId, agentPrincipalId, channelId, workspaceId } = CAPSTONE_IDS;
  const activeConfig = structuredClone(config);
  const configDigest = agentConfigDigest(activeConfig);
  const configSource = {
    offset: deterministicOffset(2),
    stateDigest: fixedDigest("b"),
    stream: streamNames.agentConfig(workspaceId, agentId),
  };
  const directorySource = {
    offset: deterministicOffset(4),
    stateDigest: fixedDigest("d"),
    stream: streamNames.workspaceDirectory(workspaceId),
  };
  const revisionId = agentConfigRevisionId({
    agentId,
    configDigest,
    revision: 1,
  });
  const providerRegistry = createProviderRegistry({ now: 0 });
  return createInvocationSnapshot({
    agentId,
    budgetUsage: null,
    channelMembership: {
      channelId,
      principalId: agentPrincipalId,
      revision: 1,
      status: "active",
    },
    configState: {
      activeConfig,
      activeRevisionId: revisionId,
      revisions: [
        {
          agentId,
          config: activeConfig,
          configDigest,
          revision: 1,
          revisionId,
          sourceOffset: configSource.offset,
          workspaceId,
        },
      ],
      runnable: true,
      status: "active",
    },
    connectionGrants: activeConfig.connectionGrants.refs.map((ref, index) => ({
      ...ref,
      agentId,
      expiresAt: 1_000,
      sourceOffset: deterministicOffset(50 + index),
      sourceStream: `connection:${ref.connectionId}/config`,
      stateDigest: fixedDigest(String(6 + index)),
      status: "active",
      workspaceId,
    })),
    context: { channelId, scope: "current-channel", threadId: null },
    now: 100,
    principal: principal(agentPrincipalId, "helper", "agent"),
    providerConfigurations: {
      harness: { protocol: "scripted-harness-v1" },
      sandbox: { protocol: "scripted-sandbox-v1" },
    },
    providerRegistry,
    sourceHeads: { config: configSource, directory: directorySource },
    sourceTrigger,
    workspaceInputManifest: {
      files: [{ bytes: 10, digest: fixedDigest("e"), path: "README.md" }],
      maxBytes: activeConfig.workspaceInputs.maxBytes,
      paths: [...activeConfig.workspaceInputs.paths],
      source: activeConfig.workspaceInputs.source,
      sourceOffset: directorySource.offset,
      sourceStream: directorySource.stream,
      stateDigest: directorySource.stateDigest,
    },
    workspaceMembership: {
      membershipId: membershipIdFor(workspaceId, agentPrincipalId),
      principalId: agentPrincipalId,
      revision: 1,
      role: "agent",
      status: "active",
      workspaceId,
    },
  });
}

export function createChannelAppend({ state, store }) {
  const { channelId, workspaceId } = CAPSTONE_IDS;
  const stream = streamNames.channel(workspaceId, channelId);
  return async function append(request) {
    const sequence = store.count(stream) + 1;
    const event = issueEventEnvelope(
      {
        actorId: request.actorId,
        causation: null,
        correlationId: `cr_${tokenFor(sequence)}`,
        data: request.payload,
        eventType:
          request.operation === "channel.message.reply"
            ? "channel.message.replied"
            : "channel.message.created",
        idempotencyKey: request.idempotencyKey,
        schemaVersion: 1,
        workspaceId,
      },
      {
        clock: () => new Date(CAPSTONE_TIME),
        eventId: `ev_${tokenFor(sequence)}`,
      },
    );
    const digest = digestEventEnvelope(event);
    const offset = deterministicOffset(sequence);
    store.seed(stream, { digest, event, offset, stream });
    state.entities.messages[event.data.messageId] = {
      ...event.data,
      revision: 1,
      status: "active",
      workspaceId,
    };
    return {
      event: structuredClone(event.data),
      receipt: {
        eventDigest: canonicalSha256(event.data),
        nextOffset: offset,
        stream,
        workspaceId,
      },
    };
  };
}

export function fixedDigest(letter) {
  return `sha256:${letter.repeat(64)}`;
}

function principal(principalId, handle, kind, ownedBy = null) {
  return {
    kind,
    ownedBy,
    principalId,
    profile: {
      displayName: handle,
      email: `${handle}@example.test`,
      handle,
    },
    profileRevision: 1,
    status: "active",
    subjectBinding: {
      audience: "stream-slack",
      issuer: "auth0",
      subject: principalId,
    },
  };
}

function tokenFor(sequence) {
  const letters = "abcdefghjkmnpqrstvwxyz";
  return letters[(sequence - 1) % letters.length].repeat(26);
}
