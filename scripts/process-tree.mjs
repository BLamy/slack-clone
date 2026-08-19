import { spawn } from "node:child_process";

const DEFAULT_OUTPUT_LIMIT = 1_000_000;

/**
 * Spawn each attempt in its own detached process group. Child output is
 * counted and drained but never copied into the durable run journal.
 */
export function createProcessTreeRunner({
  clock = () => Date.now(),
  killProcess = process.kill,
  spawnProcess = spawn,
  outputLimit = DEFAULT_OUTPUT_LIMIT,
} = {}) {
  if (typeof clock !== "function")
    throw new TypeError("process clock must be a function");
  if (typeof killProcess !== "function")
    throw new TypeError("process kill must be a function");
  if (typeof spawnProcess !== "function")
    throw new TypeError("process spawn must be a function");
  if (!Number.isSafeInteger(outputLimit) || outputLimit < 1) {
    throw new TypeError("process outputLimit must be a positive safe integer");
  }

  const handles = new Map();

  async function launch({
    args = [],
    command = process.execPath,
    cwd,
    env,
    outputLimit: attemptOutputLimit = outputLimit,
  } = {}) {
    const child = spawnProcess(command, args, {
      cwd,
      detached: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const handle = {
      child,
      groupId: child.pid === undefined ? null : -child.pid,
      launchedAtMs: clock(),
      outputBytes: 0,
      outputExceeded: false,
      pid: child.pid ?? null,
      signals: [],
      terminated: false,
    };
    if (!Number.isSafeInteger(attemptOutputLimit) || attemptOutputLimit < 1) {
      throw new TypeError(
        "attempt outputLimit must be a positive safe integer",
      );
    }
    attachOutputCounter(child.stdout, handle, attemptOutputLimit);
    attachOutputCounter(child.stderr, handle, attemptOutputLimit);
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
    assertHandle(handle);
    if (handle.terminated || !isAlive(handle)) {
      handle.terminated = true;
      return terminationResult(handle, nowMs, nowMs, false);
    }
    if (!Number.isSafeInteger(boundMs) || boundMs < 1) {
      throw new TypeError("termination bound must be a positive safe integer");
    }
    if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > boundMs) {
      throw new TypeError(
        "termination grace must be within the termination bound",
      );
    }
    const startedAtMs = clock();
    signalGroup(handle, "SIGTERM", killProcess);
    const graceful = await waitForExitOrTimeout(handle.child, graceMs);
    if (!graceful && isAlive(handle))
      signalGroup(handle, "SIGKILL", killProcess);
    if (!graceful) await waitForExit(handle.child);
    handle.terminated = true;
    const finishedAtMs = clock();
    const durationMs = finishedAtMs - startedAtMs;
    if (durationMs > boundMs) {
      throw new Error("process group termination exceeded its frozen bound");
    }
    return terminationResult(handle, nowMs, finishedAtMs, !graceful);
  }

  return Object.freeze({
    activeCount: () =>
      [...handles.values()].filter((handle) => isAlive(handle)).length,
    getProcessSnapshot: () =>
      [...handles.values()].map((handle) => ({
        active: isAlive(handle),
        groupId: handle.groupId,
        outputBytes: handle.outputBytes,
        outputExceeded: handle.outputExceeded,
        pid: handle.pid,
        signals: [...handle.signals],
      })),
    launch,
    terminate,
  });
}

function attachOutputCounter(stream, handle, outputLimit) {
  stream?.on("data", (chunk) => {
    handle.outputBytes += Buffer.byteLength(chunk);
    if (handle.outputBytes > outputLimit) handle.outputExceeded = true;
  });
}

function assertHandle(handle) {
  if (!handle || typeof handle !== "object" || !handle.child || !handle.pid) {
    throw new TypeError("unknown process handle");
  }
}

function isAlive(handle) {
  if (handle.terminated || handle.pid === null) return false;
  try {
    process.kill(handle.pid, 0);
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
) {
  return {
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
    finishedAtMs,
    groupId: handle.groupId,
    signals: [...handle.signals],
    survivors: isAlive(handle) ? 1 : 0,
    usedKillEscalation,
  };
}
