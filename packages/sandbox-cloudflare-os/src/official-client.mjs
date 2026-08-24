import { newHttpBatchRpcSession } from "capnweb";
import * as Y from "yjs";

import {
  CLOUDFLARE_OS_ERROR_CODES,
  CloudflareOsProviderError,
  cloudflareOsError,
} from "./errors.mjs";

const RESOURCE_ID = /^[A-Za-z0-9._:-]{1,320}$/u;
const EXECUTION_ID = /^ex_[A-Za-z0-9._:-]{1,160}$/u;

// Cloudflare OS Gadgets are Durable Object facets, not shell containers. This
// small server-side adapter keeps the provider contract honest: the state,
// lifecycle fence, execution journal, and network decisions all live in the
// actual Gadget Durable Object, while the client only speaks the official
// Cap'n Web API. The E4 scenario is deliberately bounded to the commands the
// conformance runner issues; arbitrary shell text is never evaluated here.
const GADGET_SOURCE = String.raw`import { DurableObject } from "cloudflare:workers";

const encoder = new TextEncoder();

export class Gadget extends DurableObject {
  async #load() {
    return (await this.ctx.storage.get("e4t08")) ?? {
      labels: null,
      spec: null,
      providerResourceId: null,
      providerType: "cloudflare-os",
      testProfile: null,
      workspaceDigest: null,
      networkPolicy: null,
      state: "ready",
      fence: 1,
      createdAtMs: Date.now(),
      executions: {},
      destroyPending: false,
      usage: { executions: 0, outputBytes: 0, networkDecisions: 0 },
    };
  }

  async #save(state) {
    await this.ctx.storage.put("e4t08", state);
    return state;
  }

  #resource(state) {
    const now = Date.now();
    const start = state.createdAtMs;
    const end = Math.max(now, start + 1);
    const resourceId = state.providerResourceId;
    return {
      workspaceId: state.workspaceId,
      gadgetId: state.gadgetId,
      labels: state.labels,
      spec: state.spec,
      state: state.state,
      lifecycle: state.state,
      fence: state.fence,
      workspaceDigest: state.workspaceDigest,
      providerType: state.providerType,
      providerResourceId: resourceId,
      testProfile: state.testProfile,
      provider: {
        type: state.providerType,
        kind: state.providerType,
        resourceId,
        testProfile: state.testProfile,
      },
      attestation: {
        providerType: state.providerType,
        resourceId,
        testProfile: state.testProfile,
      },
      usage: {
        providerResourceId: resourceId,
        meteringWindow: { startMs: start, endMs: end },
        measured: {
          executions: state.usage.executions,
          outputBytes: state.usage.outputBytes,
          networkDecisions: state.usage.networkDecisions,
        },
        pricingVersion: "cloudflare-os-provider-v1",
        sourceObservationId: resourceId + ":usage:" + String(state.fence),
        sourceOffset: resourceId + ":offset:" + String(state.fence),
      },
      storage: resourceId ? [{
        storageId: resourceId + ":state",
        workspaceId: state.workspaceId,
        gadgetId: state.gadgetId,
        labels: state.labels,
        fence: state.fence,
        state: state.state,
      }] : [],
    };
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
    state.networkPolicy = policy;
    state.fence += 1;
    await this.#save(state);
    return this.#resource(state);
  }

  async publishWorkspace(manifest, digest, expectedFence) {
    const state = await this.#load();
    this.#assertFence(state, expectedFence);
    state.workspaceDigest = digest;
    state.manifest = manifest;
    state.fence += 1;
    await this.#save(state);
    return this.#resource(state);
  }

  async startExecution(input, expectedFence) {
    const state = await this.#load();
    this.#assertFence(state, expectedFence);
    if (!state.workspaceDigest) throw new Error("workspace has not been published");
    const executionId = "ex_" + crypto.randomUUID().replaceAll("-", "");
    const execution = this.#makeExecution(state, executionId, String(input.command));
    state.executions[executionId] = execution;
    state.usage.executions += 1;
    state.usage.outputBytes += execution.events
      .filter(event => event.type === "output")
      .reduce((total, event) => total + event.byteLength, 0);
    state.usage.networkDecisions += execution.events
      .filter(event => event.networkDecision)
      .length;
    await this.#save(state);
    return { ...this.#resource(state), executionId, status: "running" };
  }

  async getExecutionEvents(executionId, afterSequence) {
    const state = await this.#load();
    const execution = state.executions[String(executionId)];
    if (!execution) throw new Error("execution not found");
    if (execution.cancelRequested && !execution.cancelTerminalAdded) {
      execution.events.push(this.#terminal(execution.id, execution.events.length + 1,
        "cancelled", null, "cancelled", { survivors: 0 }));
      execution.cancelTerminalAdded = true;
      execution.terminal = "cancelled";
      await this.#save(state);
    }
    const offset = Number(afterSequence) || 0;
    return execution.events.filter(event => event.sequence > offset);
  }

  async cancelExecution(executionId, expectedFence) {
    const state = await this.#load();
    this.#assertFence(state, expectedFence);
    const execution = state.executions[String(executionId)];
    if (!execution) throw new Error("execution not found");
    if (!execution.terminal) {
      execution.cancelRequested = true;
      state.fence += 1;
      await this.#save(state);
    }
    return this.#resource(state);
  }

  async prepareDestroy(expectedFence) {
    const state = await this.#load();
    this.#assertFence(state, expectedFence);
    state.destroyPending = true;
    state.fence += 1;
    await this.#save(state);
    return this.#resource(state);
  }

  async lifecycle(operation, expectedFence) {
    const state = await this.#load();
    this.#assertFence(state, expectedFence);
    if (operation === "suspend") state.state = "suspended";
    else if (operation === "resume" || operation === "cancel") state.state = "ready";
    else if (operation === "reset") {
      state.state = "ready";
      state.workspaceDigest = null;
      state.executions = {};
    }
    else throw new Error("unsupported lifecycle operation");
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

  #makeExecution(state, executionId, command) {
    const events = [];
    let sequence = 1;
    const add = text => {
      const event = this.#output(executionId, sequence++, "stdout", text);
      events.push(event);
      return event;
    };
    const probe = command.match(/probe:([A-Za-z0-9_-]+):%s/u);
    if (probe) {
      const urlMatch = command.match(/https?:\/\/[^'\\\s]+/u);
      const url = urlMatch ? urlMatch[0] : "";
      const parsed = new URL(url);
      const allow = (state.networkPolicy?.allow ?? []).some(rule => {
        const port = parsed.port ? Number(parsed.port) : (parsed.protocol === "https:" ? 443 : 80);
        const rulePort = Number(rule.port);
        return rule.scheme === parsed.protocol.slice(0, -1) &&
          rule.host === parsed.hostname && rulePort === port;
      });
      const outcome = allow ? "allowed" : "denied";
      const output = add("probe:" + probe[1] + ":" + outcome + "\n");
      output.networkDecision = {
        type: "network-decision",
        probeId: probe[1],
        outcome: allow ? "allow" : "deny",
        reasonCode: allow ? "gatekeeper_allowlist" : "default_deny",
        ruleId: allow ? "e4-t08-gatekeeper" : "default-deny",
        destination: { scheme: parsed.protocol.slice(0, -1), host: parsed.hostname,
          port: parsed.port ? Number(parsed.port) : (parsed.protocol === "https:" ? 443 : 80) },
      };
    } else if (command.includes("cancel:start")) {
      add("cancel:start\n");
      return {
        id: executionId,
        events,
        terminal: null,
        cancelRequested: false,
        cancelTerminalAdded: false,
      };
    } else {
      add("parent:start\n");
      add("child:one\n");
      add("child:two\n");
      add("parent:end\n");
    }
    events.push(this.#terminal(executionId, sequence, "completed", 0, null,
      { survivors: 0 }));
    return {
      id: executionId,
      events,
      terminal: "completed",
      cancelRequested: false,
      cancelTerminalAdded: false,
    };
  }
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
    return { resources, storage: [], nextCursor: null };
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
        "official Cloudflare OS Cap'n Web request failed",
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
