import { spawn } from "node:child_process";
import net from "node:net";

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

export async function findAvailablePortBlock(size = 3, host = "127.0.0.1") {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const start = 20000 + Math.floor(Math.random() * 35000);
    let available = true;
    for (let offset = 0; offset < size; offset += 1) {
      if (!(await canListen(start + offset, host))) {
        available = false;
        break;
      }
    }
    if (available) return start;
  }
  throw new Error(`Unable to allocate ${size} consecutive ports on ${host}`);
}
