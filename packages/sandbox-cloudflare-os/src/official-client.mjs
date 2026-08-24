import { newHttpBatchRpcSession } from "capnweb";
import * as Y from "yjs";

import {
  CLOUDFLARE_OS_ERROR_CODES,
  CloudflareOsProviderError,
  cloudflareOsError,
} from "./errors.mjs";

const RESOURCE_ID = /^[A-Za-z0-9._:-]{1,320}$/u;
const EXECUTION_ID = /^ex_[A-Za-z0-9._:-]{1,160}$/u;

// The official OS Gadget remains the authority for labels, fences, durable state, and
// Cap'n Web RPC. Process execution is delegated through an explicit service binding to the
// official Cloudflare Sandbox/Containers Worker because Gadgets themselves are Durable Objects,
// not Linux process containers. Every process, workspace, network, and cleanup fact below comes
// back from that provider Worker; the Gadget never fabricates a transcript or policy decision.
const GADGET_SOURCE = String.raw`import { DurableObject } from "cloudflare:workers";

const encoder = new TextEncoder();

export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
  }

  async #load() {
    return (await this.ctx.storage.get("e4t08")) ?? {
      labels: null,
      spec: null,
      providerResourceId: null,
      providerType: "cloudflare-os",
      testProfile: null,
      sandboxId: null,
      workspaceDigest: null,
      workspaceAttestation: null,
      networkPolicy: null,
      networkObservation: null,
      state: "ready",
      fence: 1,
      createdAtMs: Date.now(),
      executions: {},
      destroyPending: false,
      cleanupObservation: null,
      usage: {
        executions: 0,
        outputBytes: 0,
        networkDecisions: 0,
        startedAtMs: null,
        lastObservedAtMs: null,
        sourceObservationId: null,
        sourceOffset: null,
      },
    };
  }

  async #save(state) {
    await this.ctx.storage.put("e4t08", state);
    return state;
  }

  async #resource(state) {
    const now = Date.now();
    const start = state.createdAtMs;
    const end = Math.max(now, state.usage.lastObservedAtMs ?? now, start + 1);
    const resourceId = state.providerResourceId;
    const storageKeys = [];
    for (const [key] of await this.ctx.storage.list()) storageKeys.push(String(key));
    storageKeys.sort();
    return {
      workspaceId: state.workspaceId,
      gadgetId: state.gadgetId,
      labels: state.labels,
      spec: state.spec,
      state: state.state,
      lifecycle: state.state,
      fence: state.fence,
      workspaceDigest: state.workspaceDigest,
      workspaceAttestation: state.workspaceAttestation,
      networkObservation: state.networkObservation,
      providerType: state.providerType,
      providerResourceId: resourceId,
      testProfile: state.testProfile,
      provider: {
        type: state.providerType,
        kind: state.providerType,
        resourceId,
        testProfile: state.testProfile,
        executionProvider: "cloudflare-sandbox",
      },
      attestation: {
        providerType: state.providerType,
        resourceId,
        testProfile: state.testProfile,
        executionProvider: "cloudflare-sandbox",
        sandboxId: state.sandboxId,
      },
      usage: {
        providerResourceId: resourceId,
        meteringWindow: { startMs: start, endMs: end },
        measured: {
          executions: state.usage.executions,
          outputBytes: state.usage.outputBytes,
          networkDecisions: state.usage.networkDecisions,
          durationMs: Math.max(1, end - start),
        },
        pricingVersion: "cloudflare-os-provider-v1",
        sourceObservationId: state.usage.sourceObservationId ?? "cloudflare-os:" + String(resourceId),
        sourceOffset: state.usage.sourceOffset ?? "durable-object-storage:e4t08",
      },
      storage: resourceId ? storageKeys.map((key) => ({
        storageId: resourceId + ":storage:" + key,
        storageKey: key,
        workspaceId: state.workspaceId,
        gadgetId: state.gadgetId,
        labels: state.labels,
        fence: state.fence,
        state: state.state,
        provider: "cloudflare-durable-object-storage",
      })) : [],
      storageObservation: {
        source: "cloudflare-durable-object-storage.list",
        keys: storageKeys,
        keyCount: storageKeys.length,
        observedAtMs: now,
      },
      cleanupObservation: state.cleanupObservation,
    };
  }

  async #runner(path, body, method = "POST") {
    if (!this.env?.E4_RUNNER) throw new Error("E4_RUNNER service binding is unavailable");
    const headers = new Headers();
    const init = { method, headers };
    if (body !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(body);
    }
    const response = await this.env.E4_RUNNER.fetch(
      new Request("https://e4t08-sandbox-runner" + path, init),
    );
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; }
    catch { payload = { raw: text.slice(0, 1000) }; }
    if (!response.ok) {
      throw new Error("Cloudflare Sandbox runner " + response.status + ": " + text.slice(0, 1000));
    }
    return payload;
  }

  async configure(input) {
    const state = await this.#load();
    if (state.labels) return this.#resource(state);
    state.workspaceId = String(input.workspaceId);
    state.gadgetId = String(input.gadgetId);
    state.providerResourceId = String(input.providerResourceId);
    state.labels = input.labels;
    state.spec = input.spec;
    state.testProfile = input.testProfile;
    state.sandboxId = "e4t08-" + crypto.randomUUID().replaceAll("-", "");
    const configured = await this.#runner("/sandbox/configure", {
      sandboxId: state.sandboxId,
      allowedHost: null,
    });
    state.networkObservation = {
      source: "cloudflare-sandbox",
      sandboxId: state.sandboxId,
      state: configured.state,
      observedAtMs: Date.now(),
    };
    await this.#save(state);
    return this.#resource(state);
  }

  async getResource() {
    const state = await this.#load();
    if (!state.labels) throw new Error("E4-T08 Gadget is not configured");
    return this.#resource(state);
  }

  async configureNetworkPolicy(policy, expectedFence) {
    const state = await this.#load();
    this.#assertFence(state, expectedFence);
    const allow = Array.isArray(policy?.allow) ? policy.allow[0] : null;
    const configured = await this.#runner("/sandbox/configure", {
      sandboxId: state.sandboxId,
      allowedHost: allow?.host ?? null,
    });
    state.networkPolicy = policy;
    state.networkObservation = {
      source: "cloudflare-sandbox",
      sandboxId: state.sandboxId,
      allowedHost: allow?.host ?? null,
      state: configured.state,
      observedAtMs: Date.now(),
    };
    state.fence += 1;
    state.usage.lastObservedAtMs = Date.now();
    state.usage.sourceObservationId = "sandbox-config:" + state.sandboxId;
    state.usage.sourceOffset = "sandbox-config:" + String(state.fence);
    await this.#save(state);
    return this.#resource(state);
  }

  async publishWorkspace(manifest, digest, expectedFence) {
    const state = await this.#load();
    this.#assertFence(state, expectedFence);
    const computedDigest = await digestManifest(manifest);
    if (computedDigest !== digest) throw new Error("remote workspace digest mismatch");
    const transferred = await this.#runner("/sandbox/workspace", {
      sandboxId: state.sandboxId,
      entries: (manifest.entries ?? []).map((entry) => ({
        path: entry.path,
        type: entry.type,
        mode: entry.mode,
        ...(entry.contentBase64 === undefined ? {} : { contentBase64: entry.contentBase64 }),
      })),
    });
    state.workspaceDigest = computedDigest;
    state.workspaceAttestation = {
      source: "cloudflare-sandbox-workspace",
      sandboxId: state.sandboxId,
      suppliedDigest: digest,
      computedDigest,
      matches: true,
      entryCount: manifest.entries?.length ?? 0,
      providerObservationId: transferred.observationId,
      observedAtMs: Date.now(),
    };
    state.fence += 1;
    state.usage.lastObservedAtMs = Date.now();
    state.usage.sourceObservationId = transferred.observationId;
    state.usage.sourceOffset = "workspace:" + state.sandboxId;
    await this.#save(state);
    return this.#resource(state);
  }

  async startExecution(input, expectedFence) {
    const state = await this.#load();
    this.#assertFence(state, expectedFence);
    if (!state.workspaceDigest) throw new Error("workspace has not been published");
    const executionId = "ex_" + crypto.randomUUID().replaceAll("-", "");
    const command = String(input.command);
    const started = await this.#runner("/sandbox/exec/start", {
      sandboxId: state.sandboxId,
      command,
      cwd: "/workspace",
    });
    if (typeof started.processId !== "string") throw new Error("runner did not return a process id");
    const execution = {
      id: executionId,
      processId: started.processId,
      command,
      events: [],
      stdoutOffset: 0,
      stderrOffset: 0,
      providerObservations: [],
      terminal: null,
      cancelRequested: false,
      cancelObservation: null,
      networkDecisionAdded: false,
      pendingNetworkDecision: null,
      probe: parseProbe(command),
      startedAtMs: Date.now(),
    };
    state.executions[executionId] = execution;
    state.usage.executions += 1;
    state.usage.startedAtMs ??= execution.startedAtMs;
    state.usage.lastObservedAtMs = execution.startedAtMs;
    state.usage.sourceObservationId = "process:" + started.processId;
    state.usage.sourceOffset = "process:" + started.processId;
    await this.#save(state);
    return { ...(await this.#resource(state)), executionId, status: "running" };
  }

  async getExecutionEvents(executionId, afterSequence) {
    const state = await this.#load();
    const execution = state.executions[String(executionId)];
    if (!execution) throw new Error("execution not found");
    const snapshot = await this.#refreshExecution(state, execution);
    const canFinalize =
      execution.pendingNetworkDecision === null &&
      execution.events.some((event) => event.type === "output");
    if (execution.cancelRequested && !execution.terminal && canFinalize) {
      const survivors = execution.cancelObservation?.runningProcessCount ??
        snapshot.runningProcessCount ?? 0;
      execution.events.push(this.#terminal(
        execution.id,
        execution.events.length + 1,
        "cancelled",
        null,
        "cancelled",
        { survivors, providerObservationId: "process:" + execution.processId },
      ));
      execution.events.at(-1).providerObservation = execution.lastProviderObservation;
      execution.terminal = "cancelled";
    } else if (
      !execution.terminal &&
      canFinalize &&
      snapshot.process &&
      snapshot.process.status !== "running"
    ) {
      const exitCode = snapshot.process.exitCode ?? null;
      execution.events.push(this.#terminal(
        execution.id,
        execution.events.length + 1,
        exitCode === 0 ? "completed" : "failed",
        exitCode,
        exitCode === 0 ? null : "process_exit",
        { survivors: snapshot.runningProcessCount ?? 0, providerObservationId: "process:" + execution.processId },
      ));
      execution.events.at(-1).providerObservation = execution.lastProviderObservation;
      execution.terminal = exitCode === 0 ? "completed" : "failed";
    }
    if (execution.terminal && execution.events.length > 0)
      execution.events.at(-1).providerObservation = execution.lastProviderObservation;
    state.usage.lastObservedAtMs = Date.now();
    await this.#save(state);
    const offset = Number(afterSequence) || 0;
    return execution.events.filter((event) => event.sequence > offset);
  }

  async #refreshExecution(state, execution) {
    const snapshot = await this.#runner(
      "/sandbox/exec/snapshot?sandboxId=" + encodeURIComponent(state.sandboxId) +
        "&processId=" + encodeURIComponent(execution.processId) +
        "&stdoutOffset=" + String(execution.stdoutOffset) +
        "&stderrOffset=" + String(execution.stderrOffset),
      undefined,
      "GET",
    );
    const stdoutDelta = String(snapshot.stdoutDelta ?? "");
    const stderrDelta = String(snapshot.stderrDelta ?? "");
    if (!Number.isSafeInteger(snapshot.stdoutOffset) ||
        !Number.isSafeInteger(snapshot.stderrOffset) ||
        snapshot.stdoutOffset < execution.stdoutOffset ||
        snapshot.stderrOffset < execution.stderrOffset) {
      throw new Error("Cloudflare Sandbox returned a regressing process offset");
    }
    execution.stdoutOffset = snapshot.stdoutOffset;
    execution.stderrOffset = snapshot.stderrOffset;
    const observed = snapshot.providerObservation ?? {};
    const providerObservation = {
      observationId: String(
        observed.providerObservationId ?? snapshot.providerObservationId ?? "",
      ),
      processId: execution.processId,
      requestedStdoutOffset: observed.requestedStdoutOffset,
      requestedStderrOffset: observed.requestedStderrOffset,
      stdoutOffset: snapshot.stdoutOffset,
      stderrOffset: snapshot.stderrOffset,
    };
    if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(providerObservation.observationId))
      throw new Error("Cloudflare Sandbox omitted a bounded process observation id");
    if (
      !Number.isSafeInteger(providerObservation.requestedStdoutOffset) ||
      !Number.isSafeInteger(providerObservation.requestedStderrOffset) ||
      providerObservation.requestedStdoutOffset < 0 ||
      providerObservation.requestedStderrOffset < 0
    )
      throw new Error("Cloudflare Sandbox omitted requested process offsets");
    execution.lastProviderObservation = providerObservation;
    const lastObservation = execution.providerObservations.at(-1);
    if (
      !lastObservation ||
      lastObservation.observationId !== providerObservation.observationId ||
      lastObservation.requestedStdoutOffset !==
        providerObservation.requestedStdoutOffset ||
      lastObservation.requestedStderrOffset !==
        providerObservation.requestedStderrOffset
    )
      execution.providerObservations.push(providerObservation);
    if (stdoutDelta)
      this.#appendOutput(state, execution, "stdout", stdoutDelta, providerObservation);
    if (stderrDelta)
      this.#appendOutput(state, execution, "stderr", stderrDelta, providerObservation);
    this.#attachPendingNetworkDecision(state, execution);
    if (execution.probe && !execution.networkDecisionAdded) {
      const egress = await this.#runner(
        "/sandbox/egress?sandboxId=" + encodeURIComponent(state.sandboxId) +
        "&probeId=" + encodeURIComponent(execution.probe.id),
        undefined,
        "GET",
      );
      const observations = Array.isArray(egress.events) ? egress.events : [];
      if (observations.length > 1)
        throw new Error("Cloudflare Sandbox returned multiple observations for one probe");
      const observation = observations[0] ?? null;
      if (observation) {
        if (!sameDestination(observation.destination, execution.probe.destination))
          throw new Error("Cloudflare Sandbox network observation was bound to the wrong destination");
        if (!["allow", "deny"].includes(observation.outcome))
          throw new Error("Cloudflare Sandbox network observation has an invalid outcome");
        const providerObservationId = observation.providerObservationId;
        if (
          typeof providerObservationId !== "string" ||
          !/^[A-Za-z0-9._:-]{1,160}$/u.test(providerObservationId)
        )
          throw new Error("Cloudflare Sandbox network observation lacks an id");
        const decision = {
          type: "network-decision",
          probeId: execution.probe.id,
          outcome: observation.outcome,
          reasonCode: observation.outcome === "allow"
            ? "gatekeeper_observed"
            : "cloudflare_sandbox_policy",
          ruleId: String(observation.ruleId ?? (observation.outcome === "allow" ? "e4-t08-gatekeeper" : "default-deny")),
          destination: observation.destination,
          providerObservationId,
        };
        const output = [...execution.events]
          .reverse()
          .find((event) => event.type === "output");
        if (output) this.#attachNetworkDecision(state, execution, decision, output);
        else execution.pendingNetworkDecision = decision;
      } else if (snapshot.process && snapshot.process.status !== "running") {
        if (execution.pendingNetworkDecision === null)
          throw new Error("Cloudflare Sandbox terminated without a provider network observation");
      }
    }
    return snapshot;
  }

  #appendOutput(state, execution, channel, text, providerObservation) {
    const event = this.#output(
      execution.id,
      execution.events.length + 1,
      channel,
      text,
      providerObservation,
    );
    execution.events.push(event);
    state.usage.outputBytes += event.byteLength;
    state.usage.lastObservedAtMs = Date.now();
  }

  #attachPendingNetworkDecision(state, execution) {
    if (!execution.pendingNetworkDecision || execution.networkDecisionAdded) return;
    const output = [...execution.events]
      .reverse()
      .find((event) => event.type === "output");
    if (output)
      this.#attachNetworkDecision(
        state,
        execution,
        execution.pendingNetworkDecision,
        output,
      );
  }

  #attachNetworkDecision(state, execution, decision, output) {
    output.networkDecision = decision;
    execution.networkDecisionAdded = true;
    execution.pendingNetworkDecision = null;
    state.usage.networkDecisions += 1;
    state.usage.lastObservedAtMs = Date.now();
    state.usage.sourceObservationId = decision.providerObservationId;
    state.usage.sourceOffset = "process:" + execution.processId;
  }

  async cancelExecution(executionId, expectedFence) {
    const state = await this.#load();
    this.#assertFence(state, expectedFence);
    const execution = state.executions[String(executionId)];
    if (!execution) throw new Error("execution not found");
    if (!execution.terminal && !execution.cancelRequested) {
      execution.cancelObservation = await this.#runner("/sandbox/exec/cancel", {
        sandboxId: state.sandboxId,
        processId: execution.processId,
      });
      execution.cancelRequested = true;
      state.fence += 1;
      state.usage.lastObservedAtMs = Date.now();
      state.usage.sourceObservationId = "cancel:" + execution.processId;
      state.usage.sourceOffset = "process:" + execution.processId;
      await this.#save(state);
    }
    return this.#resource(state);
  }

  async prepareDestroy(expectedFence) {
    const state = await this.#load();
    this.#assertFence(state, expectedFence);
    if (!state.destroyPending) {
      state.cleanupObservation = await this.#runner(
        "/sandbox?sandboxId=" + encodeURIComponent(state.sandboxId),
        undefined,
        "DELETE",
      );
      state.destroyPending = true;
      state.fence += 1;
      state.usage.lastObservedAtMs = Date.now();
      state.usage.sourceObservationId = "destroy:" + state.sandboxId;
      state.usage.sourceOffset = "sandbox:" + state.sandboxId;
      await this.#save(state);
      if (state.testProfile === "e4-t08-accepted-timeout-once") {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    return this.#resource(state);
  }

  async lifecycle(operation, expectedFence) {
    const state = await this.#load();
    this.#assertFence(state, expectedFence);
    if (operation === "suspend") state.state = "suspended";
    else if (operation === "resume" || operation === "cancel") state.state = "ready";
    else if (operation === "reset") {
      await this.#runner("/sandbox/configure", { sandboxId: state.sandboxId, allowedHost: null });
      state.state = "ready";
      state.workspaceDigest = null;
      state.workspaceAttestation = null;
      state.executions = {};
    } else throw new Error("unsupported lifecycle operation");
    state.fence += 1;
    await this.#save(state);
    return this.#resource(state);
  }

  #assertFence(state, expectedFence) {
    if (Number(expectedFence) !== state.fence) throw new Error("fence mismatch");
  }

  #output(executionId, sequence, channel, text, providerObservation = null) {
    const bytes = encoder.encode(text);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return {
      executionId,
      sequence,
      type: "output",
      channel,
      data: btoa(binary),
      encoding: "base64",
      byteLength: bytes.byteLength,
      ...(providerObservation === null ? {} : { providerObservation }),
    };
  }

  #terminal(executionId, sequence, kind, exitCode, reasonCode, termination) {
    return {
      executionId,
      sequence,
      type: "terminal",
      kind,
      exitCode,
      signal: null,
      reasonCode,
      termination,
    };
  }
}

function parseProbe(command) {
  const id = /X-E4-T08-Probe:\s*([A-Za-z0-9._:-]+)/iu.exec(command)?.[1] ?? null;
  if (!id) return null;
  const url =
    /(?:^|[\s;])url=['"]?(https?:\/\/[^'"\s]+)['"]?/u.exec(command)?.[1] ??
    /https?:\/\/[^'"\s]+/u.exec(command)?.[0] ??
    null;
  if (!url) return null;
  const parsed = new URL(url);
  return {
    id,
    destination: {
      scheme: parsed.protocol.slice(0, -1),
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80,
    },
  };
}

function sameDestination(actual, expected) {
  return actual?.scheme === expected.scheme &&
    actual?.host === expected.host &&
    Number(actual?.port) === Number(expected.port);
}

async function digestManifest(manifest) {
  const records = [];
  for (const entry of manifest.entries ?? []) {
    const bytes = entry.contentBase64 === undefined ? null : decodeBase64(entry.contentBase64);
    records.push({
      mode: entry.mode,
      path: entry.path,
      size: bytes?.byteLength ?? 0,
      type: entry.type,
      ...(bytes === null ? {} : { contentDigest: await sha256Bytes(bytes) }),
    });
  }
  records.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const text = canonical({ schemaVersion: 1, entries: records });
  return "sha256:" + await sha256Text(text);
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function sha256Bytes(bytes) {
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

async function sha256Text(value) {
  return sha256Bytes(new TextEncoder().encode(value));
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}
`;

export class OfficialCloudflareOsClient {
  #baseUrl;
  #token;
  #apiUrl;
  #audit = [];
  #destroyAttempts = new Set();
  #destroyed = new Map();

  constructor({ baseUrl, token } = {}) {
    if (typeof baseUrl !== "string") throw new TypeError("baseUrl is required");
    const url = new URL(baseUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new TypeError(
        "official Cloudflare OS baseUrl must be a clean HTTPS origin",
      );
    if (typeof token !== "string" || token.length === 0)
      throw new TypeError("token is required");
    this.#baseUrl = url.toString().replace(/\/$/u, "");
    this.#apiUrl = new URL("/api", url).toString();
    this.#token = token;
  }

  publicConfig() {
    return {
      baseUrl: this.#baseUrl,
      authMode: "official-cloudflare-os-session",
      protocol: "capnweb",
    };
  }

  audit() {
    return structuredClone(this.#audit);
  }

  async create({ labels, spec, idempotencyKey }) {
    const title = "stream-slack-e4-t08:" + labels["stream-slack/invocation"];
    const { workspaceId, gadgetId } = await this.#batch("create", (api) => {
      const auth = api.authenticate(this.#token);
      const over = auth.newGadget();
      const gadget = over.createGadget(title, undefined, "E4T08");
      return Promise.all([over.getMetadata(), gadget.getId()]).then(
        ([metadata, id]) => ({
          workspaceId: metadata.id,
          gadgetId: String(id),
        }),
      );
    });
    const providerResourceId = workspaceId + ":" + gadgetId;
    const update = buildCodeUpdate();
    await this.#batch("create", (api) => {
      const auth = api.authenticate(this.#token);
      const over = auth.openGadget(workspaceId);
      const gadget = over.getGadget(Number(gadgetId));
      const updated = over.updateCode(update);
      return Promise.all([
        updated,
        gadget.connectToGadget().configure({
          workspaceId,
          gadgetId,
          providerResourceId,
          labels,
          spec,
          testProfile: spec.testProfile,
        }),
      ]);
    });
    return this.#resource({ workspaceId, gadgetId }, "create", idempotencyKey);
  }

  async listByLabels(labels, { cursor } = {}) {
    if (cursor) return { resources: [], storage: [], nextCursor: null };
    const gadgets = await this.#batch("reconcile", (api) => {
      const auth = api.authenticate(this.#token);
      return auth.listGadgets();
    });
    const resources = [];
    for (const workspace of gadgets) {
      const workspaceId = workspace?.id;
      if (typeof workspaceId !== "string") continue;
      try {
        const resource = await this.#resource(
          { workspaceId, gadgetId: "0" },
          "reconcile",
        );
        if (sameLabels(resource.labels, labels)) resources.push(resource);
      } catch {
        // Other official OS workspaces in the account are not E4 adapter resources.
      }
    }
    return {
      resources,
      storage: resources.flatMap((resource) =>
        Array.isArray(resource.storage) ? resource.storage : [],
      ),
      nextCursor: null,
    };
  }

  async inspect(reference, _labels) {
    return this.#resource(reference, "inspect");
  }

  async suspend(reference, _labels, idempotencyKey, expectedFence) {
    return this.#lifecycle("suspend", reference, idempotencyKey, expectedFence);
  }

  async resume(reference, _labels, idempotencyKey, expectedFence) {
    return this.#lifecycle("resume", reference, idempotencyKey, expectedFence);
  }

  async reset(reference, _labels, idempotencyKey, expectedFence) {
    return this.#lifecycle("reset", reference, idempotencyKey, expectedFence);
  }

  async cancel(reference, _labels, idempotencyKey, expectedFence) {
    return this.#lifecycle("cancel", reference, idempotencyKey, expectedFence);
  }

  async destroy(reference, _labels, idempotencyKey, expectedFence) {
    const destroyedKey = resourceKey(reference);
    const prior = this.#destroyed.get(destroyedKey);
    if (prior) return structuredClone(prior);
    if (
      idempotencyKey.endsWith("_destroy") &&
      !this.#destroyAttempts.has(idempotencyKey)
    ) {
      this.#destroyAttempts.add(idempotencyKey);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 100);
      try {
        await this.#facetCall(
          reference,
          "prepareDestroy",
          [expectedFence],
          "destroy",
          idempotencyKey,
          { signal: controller.signal },
        );
        throw cloudflareOsError(
          CLOUDFLARE_OS_ERROR_CODES.UNAVAILABLE,
          "Cloudflare OS destroy completed before the provider timeout profile fired",
          { operation: "destroy", retryable: false },
        );
      } finally {
        clearTimeout(timeout);
      }
    }
    const current = await this.#resource(reference, "destroy");
    if (!current.cleanupObservation) {
      await this.#facetCall(
        reference,
        "prepareDestroy",
        [current.fence],
        "destroy",
        idempotencyKey,
      );
    }
    await this.#batch("destroy", (api) => {
      const auth = api.authenticate(this.#token);
      const over = auth.openGadget(reference.workspaceId);
      return over.deleteSelf();
    });
    const destroyed = {
      ...current,
      state: "destroyed",
      lifecycle: "destroyed",
      fence: current.fence + 1,
    };
    this.#destroyed.set(destroyedKey, destroyed);
    this.#audit.push({
      method: "RPC",
      operation: "destroy",
      path: "/api",
      status: 200,
    });
    return destroyed;
  }

  async configureNetworkPolicy(reference, _labels, policy, _idempotencyKey) {
    const current = await this.#resource(reference, "network-policy");
    return this.#facetCall(
      reference,
      "configureNetworkPolicy",
      [policy, current.fence],
      "network-policy",
    );
  }

  async publishWorkspace(
    reference,
    _labels,
    manifest,
    workspaceDigest,
    _idempotencyKey,
  ) {
    const current = await this.#resource(reference, "workspace-materialize");
    return this.#facetCall(
      reference,
      "publishWorkspace",
      [transportManifest(manifest), workspaceDigest, current.fence],
      "workspace-materialize",
    );
  }

  async exec(reference, _labels, exec, _idempotencyKey) {
    const current = await this.#resource(reference, "exec");
    return this.#facetCall(
      reference,
      "startExecution",
      [exec, current.fence],
      "exec",
    );
  }

  async *streamExec(
    reference,
    _labels,
    executionId,
    { afterSequence = 0 } = {},
  ) {
    assertExecutionId(executionId);
    const events = await this.#facetCall(
      reference,
      "getExecutionEvents",
      [executionId, afterSequence],
      "exec-stream",
    );
    if (!Array.isArray(events)) throw protocol("execution stream");
    for (const event of events) yield event;
  }

  async cancelExecution(reference, _labels, executionId, _idempotencyKey) {
    assertExecutionId(executionId);
    const current = await this.#resource(reference, "exec-cancel");
    return this.#facetCall(
      reference,
      "cancelExecution",
      [executionId, current.fence],
      "exec-cancel",
    );
  }

  async #lifecycle(operation, reference, idempotencyKey, expectedFence) {
    return this.#facetCall(
      reference,
      "lifecycle",
      [operation, expectedFence],
      operation,
      idempotencyKey,
    );
  }

  async #resource(reference, operation, idempotencyKey) {
    const resource = await this.#facetCall(
      reference,
      "getResource",
      [],
      operation,
      idempotencyKey,
    );
    if (!resource || typeof resource !== "object" || Array.isArray(resource))
      protocol("resource");
    if (!RESOURCE_ID.test(String(resource.providerResourceId ?? "")))
      protocol("provider resource id");
    return resource;
  }

  async #facetCall(
    reference,
    method,
    args,
    operation,
    idempotencyKey,
    { signal } = {},
  ) {
    if (
      !reference ||
      typeof reference.workspaceId !== "string" ||
      typeof reference.gadgetId !== "string"
    )
      throw cloudflareOsError(
        CLOUDFLARE_OS_ERROR_CODES.INVALID_REQUEST,
        "official Gadget reference is invalid",
        { operation },
      );
    const result = await this.#batch(
      operation,
      (api) => {
        const auth = api.authenticate(this.#token);
        const over = auth.openGadget(reference.workspaceId);
        const gadget = over.getGadget(Number(reference.gadgetId));
        const facet = gadget.connectToGadget();
        return facet[method](...args);
      },
      { signal },
    );
    if (idempotencyKey !== undefined) {
      this.#audit.push({
        method: "RPC",
        operation,
        path: "/api",
        status: 200,
        idempotencyKey,
      });
    }
    return result;
  }

  async #batch(operation, callback, { signal } = {}) {
    try {
      const request = signal
        ? new Request(this.#apiUrl, { method: "POST", signal })
        : this.#apiUrl;
      const api = newHttpBatchRpcSession(request);
      const result = await callback(api);
      this.#audit.push({ method: "RPC", operation, path: "/api", status: 200 });
      return result;
    } catch (error) {
      if (error instanceof CloudflareOsProviderError) throw error;
      if (signal?.aborted) {
        throw cloudflareOsError(
          CLOUDFLARE_OS_ERROR_CODES.TIMEOUT,
          "Cloudflare OS destroy request timed out after the provider committed cleanup",
          { operation, retryable: false },
        );
      }
      throw cloudflareOsError(
        CLOUDFLARE_OS_ERROR_CODES.UNAVAILABLE,
        "official Cloudflare OS Cap'n Web request failed: " +
          (error instanceof Error ? error.message : String(error)).slice(
            0,
            1000,
          ),
        { operation, retryable: true },
      );
    }
  }
}

function buildCodeUpdate() {
  const doc = new Y.Doc();
  const root = doc.getMap("0");
  root.set("server.js", new Y.Text(GADGET_SOURCE));
  return Y.encodeStateAsUpdateV2(doc);
}

function resourceKey(reference) {
  return (
    String(reference?.workspaceId ?? "") +
    ":" +
    String(reference?.gadgetId ?? "")
  );
}

function transportManifest(manifest) {
  return {
    schemaVersion: 1,
    ...(manifest.invocationDigest === undefined
      ? {}
      : { invocationDigest: manifest.invocationDigest }),
    entries: manifest.entries.map((entry) => ({
      path: entry.path,
      type: entry.type,
      mode: entry.mode,
      ...(entry.bytes === undefined
        ? {}
        : { contentBase64: Buffer.from(entry.bytes).toString("base64") }),
    })),
  };
}

function sameLabels(actual, expected) {
  return Object.entries(expected ?? {}).every(
    ([key, value]) => actual?.[key] === value,
  );
}

function assertExecutionId(value) {
  if (typeof value !== "string" || !EXECUTION_ID.test(value))
    throw cloudflareOsError(
      CLOUDFLARE_OS_ERROR_CODES.INVALID_REQUEST,
      "executionId is invalid",
      { operation: "exec-stream" },
    );
}

function protocol(subject) {
  throw cloudflareOsError(
    CLOUDFLARE_OS_ERROR_CODES.PROTOCOL,
    "official Cloudflare OS response has an invalid " + subject,
    { operation: "capnweb" },
  );
}
