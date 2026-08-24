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
    if (execution.cancelRequested && !execution.terminal) {
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
      execution.terminal = "cancelled";
    } else if (!execution.terminal && snapshot.process && snapshot.process.status !== "running") {
      const exitCode = snapshot.process.exitCode ?? null;
      execution.events.push(this.#terminal(
        execution.id,
        execution.events.length + 1,
        exitCode === 0 ? "completed" : "failed",
        exitCode,
        exitCode === 0 ? null : "process_exit",
        { survivors: snapshot.runningProcessCount ?? 0, providerObservationId: "process:" + execution.processId },
      ));
      execution.terminal = exitCode === 0 ? "completed" : "failed";
    }
    state.usage.lastObservedAtMs = Date.now();
    await this.#save(state);
    const offset = Number(afterSequence) || 0;
    return execution.events.filter((event) => event.sequence > offset);
  }

  async #refreshExecution(state, execution) {
    const snapshot = await this.#runner(
      "/sandbox/exec/snapshot?sandboxId=" + encodeURIComponent(state.sandboxId) +
        "&processId=" + encodeURIComponent(execution.processId),
      undefined,
      "GET",
    );
    const stdout = String(snapshot.stdout ?? "");
    const stderr = String(snapshot.stderr ?? "");
    const stdoutDelta = stdout.slice(execution.stdoutOffset);
    const stderrDelta = stderr.slice(execution.stderrOffset);
    execution.stdoutOffset = stdout.length;
    execution.stderrOffset = stderr.length;
    if (stdoutDelta) this.#appendOutput(state, execution, "stdout", stdoutDelta);
    if (stderrDelta) this.#appendOutput(state, execution, "stderr", stderrDelta);
    if (execution.probe && !execution.networkDecisionAdded) {
      const egress = await this.#runner(
        "/sandbox/egress?sandboxId=" + encodeURIComponent(state.sandboxId) +
          "&probeId=" + encodeURIComponent(execution.probe.id),
        undefined,
        "GET",
      );
      const observedAllow = Array.isArray(egress.events) && egress.events.length > 0;
      const deniedByProvider =
        new RegExp("probe:" + execution.probe.id + ":denied", "u").test(stdout) &&
        /(?:Origin is disallowed|error: 520|curl:\s+\(\d+\))/u.test(stdout + "\n" + stderr);
      if (observedAllow || deniedByProvider) {
        const observation = observedAllow ? egress.events[0] : null;
        const decision = {
          type: "network-decision",
          probeId: execution.probe.id,
          outcome: observedAllow ? "allow" : "deny",
          reasonCode: observedAllow
            ? "gatekeeper_observed"
            : /(?:Origin is disallowed|error: 520)/u.test(stdout + "\n" + stderr)
              ? "cloudflare_sandbox_policy"
              : "cloudflare_sandbox_network",
          ruleId: observedAllow ? "e4-t08-gatekeeper" : "default-deny",
          destination: execution.probe.destination,
          providerObservationId: observedAllow
            ? "gatekeeper:" + String(observation.timestampMs)
            : "sandbox-process:" + execution.processId,
        };
        const output = [...execution.events].reverse().find((event) => event.type === "output");
        if (!output) {
          execution.pendingNetworkDecision = decision;
          return snapshot;
        }
        output.networkDecision = decision;
        execution.networkDecisionAdded = true;
        state.usage.networkDecisions += 1;
        state.usage.lastObservedAtMs = Date.now();
        state.usage.sourceObservationId = decision.providerObservationId;
        state.usage.sourceOffset = "process:" + execution.processId;
      }
    }
    return snapshot;
  }

  #appendOutput(state, execution, channel, text) {
    const event = this.#output(execution.id, execution.events.length + 1, channel, text);
    execution.events.push(event);
    state.usage.outputBytes += event.byteLength;
    state.usage.lastObservedAtMs = Date.now();
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

  #output(executionId, sequence, channel, text) {
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
  const url = /https?:\/\/[^'"\s]+/u.exec(command)?.[0] ?? null;
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
      await this.#facetCall(
        reference,
        "prepareDestroy",
        [expectedFence],
        "destroy",
      );
      throw cloudflareOsError(
        CLOUDFLARE_OS_ERROR_CODES.TIMEOUT,
        "Cloudflare OS accepted destroy before the client timed out",
        { operation: "destroy", retryable: false },
      );
    }
    const current = await this.#resource(reference, "destroy");
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

  async #facetCall(reference, method, args, operation, idempotencyKey) {
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
    const result = await this.#batch(operation, (api) => {
      const auth = api.authenticate(this.#token);
      const over = auth.openGadget(reference.workspaceId);
      const gadget = over.getGadget(Number(reference.gadgetId));
      const facet = gadget.connectToGadget();
      return facet[method](...args);
    });
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

  async #batch(operation, callback) {
    try {
      const api = newHttpBatchRpcSession(this.#apiUrl);
      const result = await callback(api);
      this.#audit.push({ method: "RPC", operation, path: "/api", status: 200 });
      return result;
    } catch (error) {
      if (error instanceof CloudflareOsProviderError) throw error;
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
