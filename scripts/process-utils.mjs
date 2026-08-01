import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const PORT_LEASE_DIRECTORY = path.join(
  os.tmpdir(),
  "stream-slack-e0-t02-port-leases",
);
const activePortLeases = new Map();
let exitCleanupRegistered = false;

export function spawnLogged(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

  const output = [];
  const prefix = options.name ? `[${options.name}] ` : "";

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    output.push(text);
    process.stdout.write(`${prefix}${text}`);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    output.push(text);
    process.stderr.write(`${prefix}${text}`);
  });

  child.outputText = () => output.join("");
  return child;
}

export function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
      output: child.outputText?.() ?? "",
    });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal, output: child.outputText?.() ?? "" });
    });
  });
}

export async function run(command, args, options = {}) {
  const child = spawnLogged(command, args, options);
  const result = await waitForExit(child);
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with code ${result.code}`,
    );
  }
  return result;
}

export async function waitForHttp(url, timeoutMs = 30000) {
  const started = Date.now();
  let lastError;

  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = new Error(`${url} returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
  }

  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

export async function stop(child, graceMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const result = await Promise.race([
    waitForExit(child),
    new Promise((resolve) => {
      setTimeout(() => resolve(null), graceMs);
    }),
  ]);
  if (!result && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await waitForExit(child);
  }
}

async function canListen(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

export async function findAvailablePortBlock(
  size = 3,
  host = "127.0.0.1",
  { random = Math.random } = {},
) {
  const minimum = 20000;
  const choices = 35000 - size + 1;
  const initial = Math.floor(random() * choices);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const start = minimum + ((initial + attempt * 7919) % choices);
    const leased = await acquirePortLease(start, size, host);
    if (!leased) continue;
    let available = true;
    for (let offset = 0; offset < size; offset += 1) {
      if (!(await canListen(start + offset, host))) {
        available = false;
        break;
      }
    }
    if (available) return start;
    await releasePortBlock(start, size, host);
  }
  throw new Error(`Unable to allocate ${size} consecutive ports on ${host}`);
}

export async function releasePortBlock(start, size = 3, host = "127.0.0.1") {
  const key = portLeaseKey(start, size, host);
  const lease = activePortLeases.get(key);
  if (!lease) return;
  activePortLeases.delete(key);
  await Promise.all(
    lease.paths.map((leasePath) =>
      unlink(leasePath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      }),
    ),
  );
}

async function acquirePortLease(start, size, host) {
  await mkdir(PORT_LEASE_DIRECTORY, { recursive: true });
  const key = portLeaseKey(start, size, host);
  const paths = [];
  const payload = `${JSON.stringify({ host, pid: process.pid, size, start })}\n`;
  try {
    for (let offset = 0; offset < size; offset += 1) {
      const leasePath = portLeasePath(host, start + offset);
      let handle;
      try {
        handle = await open(leasePath, "wx", 0o600);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        await removeStalePortLease(leasePath);
        return false;
      }
      try {
        await handle.writeFile(payload);
      } finally {
        await handle.close();
      }
      paths.push(leasePath);
    }
  } finally {
    if (paths.length !== size) {
      await Promise.all(
        paths.map((leasePath) =>
          unlink(leasePath).catch((error) => {
            if (error?.code !== "ENOENT") throw error;
          }),
        ),
      );
    }
  }
  activePortLeases.set(key, { paths });
  registerExitCleanup();
  return true;
}

async function removeStalePortLease(leasePath) {
  let info;
  try {
    info = await stat(leasePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  let owner;
  try {
    owner = JSON.parse(await readFile(leasePath, "utf8"));
  } catch {
    if (Date.now() - info.mtimeMs < 30000) return;
  }
  if (owner?.pid && processIsAlive(owner.pid)) return;
  await unlink(leasePath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function portLeaseKey(start, size, host) {
  return `${host}:${start}:${size}`;
}

function portLeasePath(host, port) {
  const safeHost = host.replace(/[^a-z0-9.-]+/giu, "_");
  return path.join(PORT_LEASE_DIRECTORY, `${safeHost}-${port}.lock`);
}

function registerExitCleanup() {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.once("exit", () => {
    for (const lease of activePortLeases.values()) {
      for (const leasePath of lease.paths) {
        try {
          unlinkSync(leasePath);
        } catch {
          // A stale lock is reclaimed on the next allocation attempt.
        }
      }
    }
  });
}
