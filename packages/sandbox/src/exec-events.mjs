import { createHash } from "node:crypto";

import { SANDBOX_ERROR_CODES, sandboxError } from "./errors.mjs";

const EXECUTION_ID = /^ex_[A-Za-z0-9._:-]{1,160}$/u;
const REASON = /^[A-Za-z0-9._:-]{1,96}$/u;
const DEFAULT_LIMITS = Object.freeze({
  chunkBytes: 64 * 1024,
  commandBytes: 256 * 1024,
  runBytes: 1024 * 1024,
  maxEvents: 4096,
});
const TERMINAL_KINDS = Object.freeze([
  "completed",
  "failed",
  "cancelled",
  "timed-out",
]);

export const EXECUTION_EVENT_TYPES = Object.freeze({
  OUTPUT: "output",
  HEARTBEAT: "heartbeat",
  LIMIT: "limit",
  TERMINAL: "terminal",
});

export const EXECUTION_CHANNELS = Object.freeze(["stdout", "stderr"]);

export const EXECUTION_LIMITS = DEFAULT_LIMITS;

/**
 * The authoritative, bounded execution transcript. Sequence numbers are
 * assigned here, rather than at the HTTP or websocket boundary, so a dropped
 * connection can never create a second public event or reorder channels.
 */
export class ExecutionEventJournal {
  #executionId;
  #limits;
  #events = [];
  #outputBytes = 0;
  #commandBytes = 0;
  #limited = null;
  #terminal = null;

  constructor({ executionId, limits = {} } = {}) {
    if (typeof executionId !== "string" || !EXECUTION_ID.test(executionId))
      invalid("executionId is invalid", "$.executionId");
    this.#executionId = executionId;
    this.#limits = normalizeLimits(limits);
  }

  get executionId() {
    return this.#executionId;
  }

  get limits() {
    return structuredClone(this.#limits);
  }

  get lastSequence() {
    return this.#events.length;
  }

  get outputBytes() {
    return this.#outputBytes;
  }

  get terminalEvent() {
    return this.#terminal ? structuredClone(this.#terminal) : null;
  }

  snapshot() {
    return {
      executionId: this.#executionId,
      lastSequence: this.lastSequence,
      outputBytes: this.#outputBytes,
      commandBytes: this.#commandBytes,
      state: this.#terminal ? this.#terminal.kind : "running",
      limited: this.#limited ? structuredClone(this.#limited) : null,
      terminal: this.terminalEvent,
    };
  }

  events() {
    return structuredClone(this.#events);
  }

  digest() {
    return digest(this.#events);
  }

  replay(afterSequence = 0) {
    assertOffset(afterSequence, this.lastSequence);
    return structuredClone(
      this.#events.filter((event) => event.sequence > afterSequence),
    );
  }

  appendOutput(channel, bytes) {
    assertChannel(channel);
    this.#assertWritable();
    if (this.#limited) throw outputLimit("execution output limit was reached");
    const value = toBytes(bytes);
    const requestedBytes = value.byteLength;
    const available = Math.min(
      this.#limits.chunkBytes,
      this.#limits.commandBytes - this.#commandBytes,
      this.#limits.runBytes - this.#outputBytes,
    );
    const acceptedBytes = Math.max(0, Math.min(requestedBytes, available));
    if (acceptedBytes > 0) {
      this.#commandBytes += acceptedBytes;
      this.#outputBytes += acceptedBytes;
      this.#assertEventCapacity();
      this.#append({
        type: EXECUTION_EVENT_TYPES.OUTPUT,
        channel,
        data: Buffer.from(value.subarray(0, acceptedBytes)).toString("base64"),
        encoding: "base64",
        byteLength: acceptedBytes,
      });
    }
    if (acceptedBytes !== requestedBytes) {
      const reasonCode =
        requestedBytes > this.#limits.chunkBytes
          ? "chunk_bytes"
          : this.#commandBytes >= this.#limits.commandBytes
            ? "command_bytes"
            : "run_bytes";
      const limit = this.#appendLimit({
        channel,
        reasonCode,
        requestedBytes,
        acceptedBytes,
        droppedBytes: requestedBytes - acceptedBytes,
        limitBytes:
          reasonCode === "chunk_bytes"
            ? this.#limits.chunkBytes
            : reasonCode === "command_bytes"
              ? this.#limits.commandBytes
              : this.#limits.runBytes,
      });
      return {
        acceptedBytes,
        truncated: true,
        limit: structuredClone(limit),
      };
    }
    return { acceptedBytes, truncated: false, limit: null };
  }

  appendHeartbeat(details = {}) {
    this.#assertWritable();
    if (!details || typeof details !== "object" || Array.isArray(details))
      invalid("heartbeat details must be an object", "$.details");
    const safeDetails = {};
    for (const [key, value] of Object.entries(details)) {
      if (!REASON.test(key)) invalid("heartbeat key is invalid", "$.details");
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean" &&
        value !== null
      )
        invalid("heartbeat value is invalid", "$.details");
      safeDetails[key] = value;
    }
    this.#assertEventCapacity();
    return this.#append({
      type: EXECUTION_EVENT_TYPES.HEARTBEAT,
      details: safeDetails,
    });
  }

  appendTerminal({
    kind,
    exitCode = null,
    signal = null,
    reasonCode = null,
    termination = null,
  } = {}) {
    this.#assertWritable();
    assertTerminalKind(kind);
    if (exitCode !== null && !Number.isSafeInteger(exitCode))
      invalid("terminal exitCode is invalid", "$.exitCode");
    if (signal !== null && (typeof signal !== "string" || !REASON.test(signal)))
      invalid("terminal signal is invalid", "$.signal");
    if (
      reasonCode !== null &&
      (typeof reasonCode !== "string" || !REASON.test(reasonCode))
    )
      invalid("terminal reasonCode is invalid", "$.reasonCode");
    if (
      termination !== null &&
      (!termination ||
        typeof termination !== "object" ||
        Array.isArray(termination))
    )
      invalid("terminal termination is invalid", "$.termination");
    this.#assertEventCapacity();
    const event = this.#append({
      type: EXECUTION_EVENT_TYPES.TERMINAL,
      kind,
      exitCode,
      signal,
      reasonCode,
      ...(termination === null
        ? {}
        : { termination: safeTermination(termination) }),
    });
    this.#terminal = event;
    return structuredClone(event);
  }

  /**
   * Ingest one provider event. Duplicate non-terminal frames are reported but
   * never advance the public transcript. A duplicate terminal is a typed
   * refusal because two terminal claims are an integrity failure.
   */
  ingest(event) {
    const normalized = normalizeEvent(event, this.#executionId);
    if (normalized.sequence <= this.lastSequence) {
      const prior = this.#events[normalized.sequence - 1];
      if (!prior || canonical(prior) !== canonical(normalized))
        invalidEvent("provider event conflicts with the committed sequence");
      if (normalized.type === EXECUTION_EVENT_TYPES.TERMINAL)
        throw executionError(
          SANDBOX_ERROR_CODES.EXECUTION_TERMINAL,
          "duplicate terminal event was refused",
        );
      return {
        accepted: false,
        duplicate: true,
        event: structuredClone(prior),
      };
    }
    if (normalized.sequence !== this.lastSequence + 1)
      invalidEvent("provider event sequence has a gap");
    if (this.#terminal)
      throw executionError(
        SANDBOX_ERROR_CODES.EXECUTION_TERMINAL,
        "event arrived after terminal state",
      );
    if (normalized.type === EXECUTION_EVENT_TYPES.OUTPUT) {
      const bytes = decodeExecutionOutput(normalized);
      if (bytes.byteLength > this.#limits.chunkBytes)
        throw outputLimit("provider output chunk exceeded the frozen limit");
      if (
        this.#commandBytes + bytes.byteLength > this.#limits.commandBytes ||
        this.#outputBytes + bytes.byteLength > this.#limits.runBytes
      )
        throw outputLimit("provider output exceeded the frozen limit");
      this.#commandBytes += bytes.byteLength;
      this.#outputBytes += bytes.byteLength;
    } else if (normalized.type === EXECUTION_EVENT_TYPES.LIMIT) {
      if (this.#limited)
        outputLimit("provider emitted more than one limit event");
      this.#limited = normalized;
    }
    this.#assertEventCapacity();
    this.#events.push(normalized);
    if (normalized.type === EXECUTION_EVENT_TYPES.TERMINAL)
      this.#terminal = normalized;
    return {
      accepted: true,
      duplicate: false,
      event: structuredClone(normalized),
    };
  }

  #append(value) {
    const event = {
      executionId: this.#executionId,
      sequence: this.#events.length + 1,
      ...value,
    };
    this.#events.push(event);
    return structuredClone(event);
  }

  #appendLimit(value) {
    this.#assertEventCapacity();
    const event = this.#append({ type: EXECUTION_EVENT_TYPES.LIMIT, ...value });
    this.#limited = event;
    return event;
  }

  #assertEventCapacity() {
    if (this.#events.length >= this.#limits.maxEvents)
      throw outputLimit("execution event limit was reached");
  }

  #assertWritable() {
    if (this.#terminal)
      throw executionError(
        SANDBOX_ERROR_CODES.EXECUTION_TERMINAL,
        "execution is already terminal",
      );
  }
}

/**
 * A run-scoped fence around the transcript and process handle. Calling
 * cancel/timeout fences effects before signaling the provider, so a racing
 * tool, message, or credential operation cannot be accepted after the fence.
 */
export class ExecutionController {
  #journal;
  #processRunner;
  #clock;
  #handle = null;
  #started = false;
  #fenced = false;
  #cancelKind = null;
  #cancelPromise = null;
  #timeout = null;
  #resolveTerminal;
  #terminalPromise;

  constructor({
    executionId,
    processRunner = null,
    limits,
    clock = () => Date.now(),
  } = {}) {
    this.#journal = new ExecutionEventJournal({ executionId, limits });
    if (
      processRunner !== null &&
      (!processRunner ||
        typeof processRunner.launch !== "function" ||
        typeof processRunner.terminate !== "function")
    )
      throw new TypeError("processRunner must expose launch and terminate");
    if (typeof clock !== "function")
      throw new TypeError("clock must be a function");
    this.#processRunner = processRunner;
    this.#clock = clock;
    this.#terminalPromise = new Promise((resolve) => {
      this.#resolveTerminal = resolve;
    });
  }

  get executionId() {
    return this.#journal.executionId;
  }

  get journal() {
    return this.#journal;
  }

  get fenced() {
    return this.#fenced;
  }

  events() {
    return this.#journal.events();
  }

  replay(afterSequence = 0) {
    return this.#journal.replay(afterSequence);
  }

  digest() {
    return this.#journal.digest();
  }

  snapshot() {
    return { ...this.#journal.snapshot(), fenced: this.#fenced };
  }

  async start({
    command,
    args = [],
    cwd,
    env,
    timeoutMs = null,
    outputLimit,
  } = {}) {
    this.assertEffectAllowed("start");
    if (this.#started)
      throw executionError(
        SANDBOX_ERROR_CODES.INVALID_REQUEST,
        "execution already started",
      );
    if (!this.#processRunner)
      throw new TypeError(
        "a processRunner is required to start a local process",
      );
    if (typeof command !== "string" || command.length === 0)
      invalid("command is invalid", "$.command");
    if (!Array.isArray(args) || args.some((value) => typeof value !== "string"))
      invalid("args are invalid", "$.args");
    if (
      timeoutMs !== null &&
      (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    )
      invalid("timeoutMs is invalid", "$.timeoutMs");
    this.#started = true;
    this.#handle = await this.#processRunner.launch({
      command,
      args,
      cwd,
      env,
      outputLimit,
    });
    const child = this.#handle?.child;
    child?.stdout?.on("data", (chunk) => this.#captureOutput("stdout", chunk));
    child?.stderr?.on("data", (chunk) => this.#captureOutput("stderr", chunk));
    child?.once("error", (error) =>
      this.#finish({
        kind: "failed",
        reasonCode: "spawn_error",
        termination: {
          detail: String(error?.code ?? error?.message ?? "spawn"),
        },
      }),
    );
    child?.once("exit", (exitCode, signal) => {
      const kind =
        this.#cancelKind ?? (exitCode === 0 ? "completed" : "failed");
      this.#finish({
        kind,
        exitCode,
        signal,
        reasonCode: this.#cancelKind ? "cancelled" : null,
      });
    });
    if (timeoutMs !== null)
      this.#timeout = setTimeout(() => {
        void this.timeout().catch(() => {});
      }, timeoutMs);
    return { executionId: this.executionId, started: true };
  }

  appendOutput(channel, bytes) {
    this.assertEffectAllowed("output");
    const result = this.#journal.appendOutput(channel, bytes);
    if (result.truncated)
      void this.cancel({ kind: "failed", reasonCode: "output_limit" }).catch(
        () => {},
      );
    return result;
  }

  appendHeartbeat(details = {}) {
    this.assertEffectAllowed("heartbeat");
    return this.#journal.appendHeartbeat(details);
  }

  ingest(event) {
    const result = this.#journal.ingest(event);
    if (result.event.type === EXECUTION_EVENT_TYPES.TERMINAL)
      this.#fenced = true;
    return result;
  }

  complete(result) {
    return this.#finish(result);
  }

  async cancel({
    kind = "cancelled",
    reasonCode = "requested",
    boundMs = 5_000,
    graceMs = 100,
  } = {}) {
    assertTerminalKind(kind);
    if (this.#journal.terminalEvent) return this.#journal.terminalEvent;
    if (this.#cancelPromise) return this.#cancelPromise;
    this.#fenced = true;
    this.#cancelKind = kind;
    this.#cancelPromise = (async () => {
      let termination = null;
      if (this.#handle)
        termination = await this.#processRunner.terminate(this.#handle, {
          boundMs,
          graceMs,
          nowMs: this.#clock(),
        });
      return this.#finish({ kind, reasonCode, termination });
    })();
    return this.#cancelPromise;
  }

  timeout(options = {}) {
    return this.cancel({
      ...options,
      kind: "timed-out",
      reasonCode: "deadline",
    });
  }

  waitForTerminal() {
    return this.#terminalPromise.then((event) => structuredClone(event));
  }

  assertEffectAllowed(operation = "effect") {
    if (this.#fenced || this.#journal.terminalEvent)
      throw executionError(
        SANDBOX_ERROR_CODES.EXECUTION_FENCED,
        `${operation} is fenced after execution termination`,
      );
  }

  #captureOutput(channel, chunk) {
    if (this.#journal.terminalEvent) return;
    try {
      this.appendOutput(channel, chunk);
    } catch (error) {
      if (
        error?.code !== SANDBOX_ERROR_CODES.EXECUTION_OUTPUT_LIMIT &&
        error?.code !== SANDBOX_ERROR_CODES.EXECUTION_TERMINAL
      )
        this.#finish({ kind: "failed", reasonCode: "output_rejected" });
    }
  }

  #finish(result) {
    if (this.#journal.terminalEvent) return this.#journal.terminalEvent;
    if (this.#timeout) {
      clearTimeout(this.#timeout);
      this.#timeout = null;
    }
    this.#fenced ||= result.kind === "cancelled" || result.kind === "timed-out";
    const event = this.#journal.appendTerminal(result);
    this.#fenced = true;
    this.#resolveTerminal(event);
    return event;
  }
}

export function decodeExecutionOutput(event) {
  const normalized = normalizeEvent(event, event?.executionId);
  if (normalized.type !== EXECUTION_EVENT_TYPES.OUTPUT)
    invalidEvent("event is not an output chunk");
  return Buffer.from(normalized.data, "base64");
}

export function replayExecutionEvents(events, { executionId, limits } = {}) {
  if (!Array.isArray(events))
    invalidEvent("execution transcript must be an array");
  const journal = new ExecutionEventJournal({ executionId, limits });
  for (const event of events) journal.ingest(event);
  return {
    digest: journal.digest(),
    events: journal.events(),
    snapshot: journal.snapshot(),
    terminal: journal.terminalEvent,
  };
}

export function createProcessTreeRunner({
  clock = () => Date.now(),
  killProcess,
  spawnProcess,
  probeProcess,
} = {}) {
  if (typeof clock !== "function")
    throw new TypeError("process clock must be a function");
  if (typeof killProcess !== "function")
    throw new TypeError("process kill must be a function");
  if (typeof spawnProcess !== "function")
    throw new TypeError("process spawn must be a function");
  if (typeof probeProcess !== "function")
    throw new TypeError("process probe must be a function");
  const handles = new Map();

  async function launch({ command, args = [], cwd, env } = {}) {
    if (typeof command !== "string" || command.length === 0)
      throw new TypeError("process command is required");
    const child = spawnProcess(command, args, {
      cwd,
      detached: true,
      ...(env === undefined ? {} : { env }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const handle = {
      child,
      groupId: child.pid === undefined ? null : -child.pid,
      pid: child.pid ?? null,
      signals: [],
      terminated: false,
      startedAtMs: clock(),
    };
    if (handle.pid === null)
      throw new TypeError("spawn did not return a process id");
    child.once("exit", () => {
      handle.terminated = true;
    });
    handles.set(handle.pid, handle);
    return handle;
  }

  async function terminate(
    handle,
    { boundMs = 5_000, graceMs = 100, nowMs = clock() } = {},
  ) {
    assertProcessHandle(handle);
    if (!Number.isSafeInteger(boundMs) || boundMs < 1)
      throw new TypeError("termination bound is invalid");
    if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > boundMs)
      throw new TypeError("termination grace is invalid");
    if (handle.terminated || !isAlive(handle, probeProcess)) {
      handle.terminated = true;
      return terminationResult(handle, nowMs, nowMs, false, probeProcess);
    }
    signalGroup(handle, "SIGTERM", killProcess);
    const graceful = await waitForExitOrTimeout(handle.child, graceMs);
    if (!graceful && isAlive(handle, probeProcess))
      signalGroup(handle, "SIGKILL", killProcess);
    if (!graceful) await waitForExit(handle.child);
    handle.terminated = true;
    const finishedAtMs = clock();
    if (finishedAtMs - nowMs > boundMs)
      throw new Error("process group termination exceeded its frozen bound");
    return terminationResult(
      handle,
      nowMs,
      finishedAtMs,
      !graceful,
      probeProcess,
    );
  }

  return Object.freeze({
    activeCount: () =>
      [...handles.values()].filter((handle) => isAlive(handle, probeProcess))
        .length,
    getProcessSnapshot: () =>
      [...handles.values()].map((handle) => ({
        active: isAlive(handle, probeProcess),
        groupId: handle.groupId,
        pid: handle.pid,
        signals: [...handle.signals],
      })),
    launch,
    terminate,
  });
}

function normalizeLimits(limits) {
  if (!limits || typeof limits !== "object" || Array.isArray(limits))
    throw new TypeError("execution limits must be an object");
  const result = {};
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const value = limits[key] ?? DEFAULT_LIMITS[key];
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError(`execution ${key} limit is invalid`);
    result[key] = value;
  }
  return Object.freeze(result);
}

function normalizeEvent(event, expectedExecutionId) {
  if (!event || typeof event !== "object" || Array.isArray(event))
    invalidEvent("execution event must be an object");
  if (
    typeof event.executionId !== "string" ||
    !EXECUTION_ID.test(event.executionId)
  )
    invalidEvent("execution event executionId is invalid");
  if (
    expectedExecutionId !== undefined &&
    event.executionId !== expectedExecutionId
  )
    invalidEvent("execution event is for another execution");
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1)
    invalidEvent("execution event sequence is invalid");
  if (!Object.values(EXECUTION_EVENT_TYPES).includes(event.type))
    invalidEvent("execution event type is invalid");
  if (event.type === EXECUTION_EVENT_TYPES.OUTPUT) {
    assertChannel(event.channel);
    if (
      event.encoding !== "base64" ||
      typeof event.data !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        event.data,
      )
    )
      invalidEvent("execution output encoding is invalid");
    const bytes = Buffer.from(event.data, "base64");
    if (
      !Number.isSafeInteger(event.byteLength) ||
      event.byteLength !== bytes.byteLength
    )
      invalidEvent("execution output byteLength is invalid");
    return {
      executionId: event.executionId,
      sequence: event.sequence,
      type: event.type,
      channel: event.channel,
      data: event.data,
      encoding: event.encoding,
      byteLength: event.byteLength,
    };
  }
  if (event.type === EXECUTION_EVENT_TYPES.HEARTBEAT)
    return {
      executionId: event.executionId,
      sequence: event.sequence,
      type: event.type,
      details: normalizeDetails(event.details),
    };
  if (event.type === EXECUTION_EVENT_TYPES.LIMIT) {
    if (typeof event.reasonCode !== "string" || !REASON.test(event.reasonCode))
      invalidEvent("execution limit reasonCode is invalid");
    for (const key of [
      "requestedBytes",
      "acceptedBytes",
      "droppedBytes",
      "limitBytes",
    ])
      if (!Number.isSafeInteger(event[key]) || event[key] < 0)
        invalidEvent(`execution limit ${key} is invalid`);
    if (event.acceptedBytes + event.droppedBytes !== event.requestedBytes)
      invalidEvent("execution limit byte accounting is invalid");
    return {
      executionId: event.executionId,
      sequence: event.sequence,
      type: event.type,
      ...(event.channel === undefined ? {} : { channel: event.channel }),
      reasonCode: event.reasonCode,
      requestedBytes: event.requestedBytes,
      acceptedBytes: event.acceptedBytes,
      droppedBytes: event.droppedBytes,
      limitBytes: event.limitBytes,
    };
  }
  assertTerminalKind(event.kind);
  if (event.exitCode !== null && !Number.isSafeInteger(event.exitCode))
    invalidEvent("execution terminal exitCode is invalid");
  if (
    event.signal !== undefined &&
    event.signal !== null &&
    (typeof event.signal !== "string" || !REASON.test(event.signal))
  )
    invalidEvent("execution terminal signal is invalid");
  if (
    event.reasonCode !== undefined &&
    event.reasonCode !== null &&
    (typeof event.reasonCode !== "string" || !REASON.test(event.reasonCode))
  )
    invalidEvent("execution terminal reasonCode is invalid");
  return {
    executionId: event.executionId,
    sequence: event.sequence,
    type: event.type,
    kind: event.kind,
    exitCode: event.exitCode ?? null,
    signal: event.signal ?? null,
    reasonCode: event.reasonCode ?? null,
    ...(event.termination === undefined
      ? {}
      : { termination: safeTermination(event.termination) }),
  };
}

function normalizeDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details))
    invalidEvent("execution heartbeat details are invalid");
  const result = {};
  for (const [key, value] of Object.entries(details)) {
    if (
      !REASON.test(key) ||
      (typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean" &&
        value !== null)
    )
      invalidEvent("execution heartbeat details are invalid");
    result[key] = value;
  }
  return result;
}

function safeTermination(value) {
  const result = {};
  for (const key of ["durationMs", "finishedAtMs", "survivors"]) {
    if (
      value[key] !== undefined &&
      (!Number.isSafeInteger(value[key]) || value[key] < 0)
    )
      invalid("terminal termination is invalid", "$.termination");
    if (value[key] !== undefined) result[key] = value[key];
  }
  if (value.groupId !== undefined && !Number.isSafeInteger(value.groupId))
    invalid("terminal termination is invalid", "$.termination");
  if (value.groupId !== undefined) result.groupId = value.groupId;
  if (value.usedKillEscalation !== undefined) {
    if (typeof value.usedKillEscalation !== "boolean")
      invalid("terminal termination is invalid", "$.termination");
    result.usedKillEscalation = value.usedKillEscalation;
  }
  if (Array.isArray(value.signals)) {
    if (
      value.signals.some(
        (signal) => typeof signal !== "string" || !REASON.test(signal),
      )
    )
      invalid(
        "terminal termination signals are invalid",
        "$.termination.signals",
      );
    result.signals = [...value.signals];
  }
  return result;
}

function assertOffset(value, lastSequence) {
  if (!Number.isSafeInteger(value) || value < 0 || value > lastSequence)
    throw executionError(
      SANDBOX_ERROR_CODES.EXECUTION_INVALID_OFFSET,
      "resume offset is outside the committed execution transcript",
    );
}

function assertChannel(channel) {
  if (!EXECUTION_CHANNELS.includes(channel))
    invalidEvent("execution channel is invalid");
}

function assertTerminalKind(kind) {
  if (!TERMINAL_KINDS.includes(kind))
    invalid("terminal kind is invalid", "$.kind");
}

function toBytes(value) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  invalid("output must be a string or byte array", "$.bytes");
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function executionError(code, detail) {
  return sandboxError(code, detail);
}

function invalid(detail, path) {
  throw sandboxError(SANDBOX_ERROR_CODES.INVALID_REQUEST, detail, path);
}

function invalidEvent(detail) {
  throw sandboxError(SANDBOX_ERROR_CODES.EXECUTION_INVALID_EVENT, detail);
}

function outputLimit(detail) {
  throw sandboxError(SANDBOX_ERROR_CODES.EXECUTION_OUTPUT_LIMIT, detail);
}

function assertProcessHandle(handle) {
  if (!handle || typeof handle !== "object" || !handle.child || !handle.pid)
    throw new TypeError("unknown process handle");
}

function isAlive(handle, probeProcess) {
  if (handle.terminated || handle.pid === null) return false;
  try {
    probeProcess(handle.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function signalGroup(handle, signal, killProcess) {
  if (handle.groupId === null) return;
  try {
    killProcess(handle.groupId, signal);
    handle.signals.push(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(true);
  return new Promise((resolve) => {
    child.once("exit", () => resolve(true));
  });
}

function waitForExitOrTimeout(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", () => finish(true));
  });
}

function terminationResult(
  handle,
  startedAtMs,
  finishedAtMs,
  usedKillEscalation,
  probeProcess,
) {
  return {
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
    finishedAtMs,
    groupId: Math.abs(handle.groupId ?? 0),
    signals: [...handle.signals],
    survivors: isAlive(handle, probeProcess) ? 1 : 0,
    usedKillEscalation,
  };
}
