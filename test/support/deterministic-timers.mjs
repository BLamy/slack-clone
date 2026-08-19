export function createDeterministicTimers({ maxCallbacks = 20_000 } = {}) {
  let nowMs = 0;
  let nextId = 1;
  let executedCallbacks = 0;
  const executionsByDelayMs = new Map();
  const tasks = new Map();

  function schedule(kind, callback, delay, args) {
    if (typeof callback !== "function") {
      throw new TypeError(`${kind} callback must be a function`);
    }
    const delayMs = normalizeDelay(delay);
    const handle = { id: nextId };
    nextId += 1;
    tasks.set(handle.id, {
      args,
      callback,
      delayMs,
      dueMs: nowMs + delayMs,
      handle,
      kind,
    });
    return handle;
  }

  function clear(handle) {
    if (handle && typeof handle.id === "number") tasks.delete(handle.id);
  }

  async function advanceBy(duration) {
    const durationMs = normalizeDelay(duration);
    const startedAtMs = nowMs;
    const targetMs = nowMs + durationMs;
    while (true) {
      const next = nextDueTask(tasks, targetMs);
      if (!next) break;
      nowMs = next.dueMs;
      if (next.kind === "timeout") tasks.delete(next.handle.id);
      else next.dueMs += next.delayMs;
      executedCallbacks += 1;
      if (executedCallbacks > maxCallbacks) {
        throw new Error(
          `deterministic timer exceeded ${maxCallbacks} callbacks before ${targetMs}ms`,
        );
      }
      executionsByDelayMs.set(
        next.delayMs,
        (executionsByDelayMs.get(next.delayMs) ?? 0) + 1,
      );
      await next.callback(...next.args);
      await settleMicrotasks();
    }
    nowMs = targetMs;
    await settleMicrotasks();
    return {
      durationMs,
      executedCallbacks,
      finishedAtMs: nowMs,
      startedAtMs,
    };
  }

  return {
    setInterval(callback, delay, ...args) {
      return schedule("interval", callback, delay, args);
    },
    clearInterval: clear,
    setTimeout(callback, delay, ...args) {
      return schedule("timeout", callback, delay, args);
    },
    clearTimeout: clear,
    advanceBy,
    dispose() {
      tasks.clear();
    },
    executionCount(delay) {
      return executionsByDelayMs.get(normalizeDelay(delay)) ?? 0;
    },
    get activeIntervals() {
      return [...tasks.values()].filter((task) => task.kind === "interval")
        .length;
    },
    get activeTimeouts() {
      return [...tasks.values()].filter((task) => task.kind === "timeout")
        .length;
    },
    get nowMs() {
      return nowMs;
    },
  };
}

export async function settleMicrotasks(turns = 20) {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

function nextDueTask(tasks, targetMs) {
  let next = null;
  for (const task of tasks.values()) {
    if (task.dueMs > targetMs) continue;
    if (
      !next ||
      task.dueMs < next.dueMs ||
      (task.dueMs === next.dueMs && task.handle.id < next.handle.id)
    ) {
      next = task;
    }
  }
  return next;
}

function normalizeDelay(value) {
  const delay = Number(value ?? 0);
  if (!Number.isFinite(delay) || delay < 0) {
    throw new TypeError("timer delay must be a finite non-negative number");
  }
  return Math.floor(delay);
}
