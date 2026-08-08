/**
 * Deterministic process-group fixture used by fake-clock verification. It
 * models a parent plus grandchildren, including SIGTERM-resistant children,
 * without relying on scheduler timing or a live child-process map after a
 * controller crash.
 */
export function createScriptedProcessRunner({
  clock = () => 0,
  defaultChildren = 3,
  defaultIgnoresTerm = true,
  defaultOutputBytes = 0,
} = {}) {
  if (typeof clock !== "function")
    throw new TypeError("scripted process clock must be a function");
  const groups = new Map();
  let nextPid = 70_000;

  async function launch({
    children = defaultChildren,
    ignoresTerm = defaultIgnoresTerm,
    outputBytes = defaultOutputBytes,
  } = {}) {
    if (!Number.isSafeInteger(children) || children < 1 || children > 64) {
      throw new TypeError("scripted child count must be between 1 and 64");
    }
    if (!Number.isSafeInteger(outputBytes) || outputBytes < 0) {
      throw new TypeError("scripted outputBytes must be non-negative");
    }
    const pid = nextPid;
    nextPid += children + 1;
    const group = {
      children: Array.from({ length: children + 1 }, (_, index) => ({
        active: true,
        pid: pid + index,
      })),
      ignoresTerm,
      outputBytes,
      pid,
      signals: [],
      startedAtMs: clock(),
    };
    groups.set(pid, group);
    return { group, groupId: -pid, pid, scripted: true };
  }

  async function terminate(
    handle,
    { boundMs = 500, graceMs = 50, nowMs = clock() } = {},
  ) {
    if (!handle?.scripted || !groups.has(handle.pid)) {
      throw new TypeError("unknown scripted process handle");
    }
    const group = groups.get(handle.pid);
    if (group.children.every(({ active }) => !active)) {
      return {
        durationMs: 0,
        finishedAtMs: nowMs,
        groupId: handle.groupId,
        signals: [...group.signals],
        survivors: 0,
        usedKillEscalation: false,
      };
    }
    group.signals.push("SIGTERM");
    const graceful = !group.ignoresTerm;
    if (graceful) {
      for (const child of group.children) child.active = false;
    } else {
      group.signals.push("SIGKILL");
      for (const child of group.children) child.active = false;
    }
    const durationMs = graceful ? graceMs : graceMs + 1;
    if (durationMs > boundMs) {
      throw new Error("scripted process group exceeded its frozen bound");
    }
    return {
      durationMs,
      finishedAtMs: nowMs + durationMs,
      groupId: handle.groupId,
      signals: [...group.signals],
      survivors: group.children.filter(({ active }) => active).length,
      usedKillEscalation: !graceful,
    };
  }

  return Object.freeze({
    activeCount: () =>
      [...groups.values()].reduce(
        (count, group) =>
          count + group.children.filter(({ active }) => active).length,
        0,
      ),
    getProcessSnapshot: () =>
      [...groups.values()].map((group) => ({
        activeChildren: group.children.filter(({ active }) => active).length,
        groupId: -group.pid,
        outputBytes: group.outputBytes,
        pid: group.pid,
        signals: [...group.signals],
      })),
    launch,
    terminate,
  });
}
