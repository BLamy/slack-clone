import { spawn } from "node:child_process";

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
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      resolve({ code, signal, output: child.outputText?.() ?? "" });
    });
  });
}

export async function run(command, args, options = {}) {
  const child = spawnLogged(command, args, options);
  const result = await waitForExit(child);
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.code}`);
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
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

export async function stop(child) {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  const result = await Promise.race([
    waitForExit(child),
    new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
  ]);
  if (!result && !child.killed) child.kill("SIGKILL");
}
