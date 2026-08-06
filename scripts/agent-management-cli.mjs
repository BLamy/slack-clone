import { readFile } from "node:fs/promises";

const COMMANDS = new Set([
  "activate",
  "config-create",
  "create",
  "disable",
  "get",
  "history",
  "list",
  "revoke",
  "revise",
]);
const SECRET_KEY_PATTERN =
  /(?:api[-_]?key|authorization|credential|environment|password|secret|token)/iu;
const SECRET_VALUE_PATTERN =
  /(?:bearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}|-----BEGIN [^-]*PRIVATE KEY-----)/iu;

let exitCode = 0;
try {
  const result = await run(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(redact(result))}\n`);
} catch (error) {
  const result = {
    ok: false,
    code: error?.code ?? "AGENT_CLI_INTERNAL_ERROR",
    error: redactText(error?.detail ?? error?.message ?? "agent CLI failed"),
  };
  exitCode = error?.exitCode ?? 5;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
process.exitCode = exitCode;

async function run(options) {
  const body = await readInput(options);
  const request = buildRequest(options, body);
  let response;
  try {
    response = await fetch(request.url, request.init);
  } catch {
    throw cliError(
      "AGENT_CLI_NETWORK_ERROR",
      "agent management server could not be reached",
      5,
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw cliError(
      "AGENT_CLI_INVALID_RESPONSE",
      "agent management server returned invalid JSON",
      5,
    );
  }
  if (!response.ok) {
    const error = new Error(
      payload?.error ?? "agent management request failed",
    );
    error.code = payload?.code ?? `AGENT_CLI_HTTP_${response.status}`;
    error.detail = payload?.error ?? "agent management request failed";
    error.exitCode = exitCodeForStatus(response.status);
    throw error;
  }
  return payload;
}

function parseArguments(argv) {
  const tokens = [...argv];
  if (tokens[0] === "agent" || tokens[0] === "agents") tokens.shift();
  const command = tokens.shift();
  if (!COMMANDS.has(command)) {
    throw cliError(
      "AGENT_CLI_USAGE_ERROR",
      "command must be create, list, get, config-create, revise, activate, disable, revoke, or history",
      2,
    );
  }
  const options = { command };
  while (tokens.length > 0) {
    const token = tokens.shift();
    if (!token.startsWith("--")) {
      throw cliError(
        "AGENT_CLI_USAGE_ERROR",
        "arguments must use --name value",
        2,
      );
    }
    const name = token.slice(2);
    if (!name || name === "help") {
      throw cliError("AGENT_CLI_USAGE_ERROR", "--help is not a request", 2);
    }
    const value = tokens.shift();
    if (value === undefined || value.startsWith("--")) {
      throw cliError(`AGENT_CLI_USAGE_ERROR`, `--${name} requires a value`, 2);
    }
    if (Object.hasOwn(options, name)) {
      throw cliError("AGENT_CLI_USAGE_ERROR", `--${name} was repeated`, 2);
    }
    options[name] = value;
  }
  if (!options.workspace) {
    throw cliError("AGENT_CLI_USAGE_ERROR", "--workspace is required", 2);
  }
  if (
    [
      "get",
      "history",
      "config-create",
      "revise",
      "activate",
      "disable",
      "revoke",
    ].includes(command) &&
    !options.agent
  ) {
    throw cliError(
      "AGENT_CLI_USAGE_ERROR",
      "--agent is required for this command",
      2,
    );
  }
  if (
    [
      "create",
      "config-create",
      "revise",
      "activate",
      "disable",
      "revoke",
    ].includes(command) &&
    !options["idempotency-key"]
  ) {
    throw cliError(
      "AGENT_CLI_USAGE_ERROR",
      "--idempotency-key is required for mutations",
      2,
    );
  }
  return options;
}

function buildRequest(options, body) {
  const baseUrl =
    options["base-url"] ??
    process.env.STREAM_SLACK_URL ??
    "http://127.0.0.1:5175";
  const base = new URL(baseUrl);
  const workspace = encodeURIComponent(options.workspace);
  const agent = options.agent ? `/${encodeURIComponent(options.agent)}` : "";
  let path = `/api/workspaces/${workspace}/agents${agent}`;
  let method = "GET";
  let requestBody;
  if (options.command === "list") {
    path += pageQuery(options);
  } else if (options.command === "history") {
    path += `/history${pageQuery(options)}`;
  } else if (options.command === "create") {
    method = "POST";
    requestBody = body;
  } else {
    method = "POST";
    const suffix = {
      "config-create": "/config",
      revise: "/revisions",
      activate: "/activate",
      disable: "/disable",
      revoke: "/revoke",
    }[options.command];
    path += suffix;
    requestBody = body;
  }
  const headers = { Accept: "application/json" };
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    headers["Idempotency-Key"] = options["idempotency-key"];
  }
  if (options.cookie ?? process.env.STREAM_SLACK_COOKIE) {
    headers.Cookie = options.cookie ?? process.env.STREAM_SLACK_COOKIE;
  }
  const url = new URL(path, base);
  return {
    init: {
      body: method === "POST" ? JSON.stringify(requestBody ?? {}) : undefined,
      headers,
      method,
    },
    url,
  };
}

async function readInput(options) {
  if (
    ![
      "create",
      "config-create",
      "revise",
      "activate",
      "disable",
      "revoke",
    ].includes(options.command)
  ) {
    return null;
  }
  if (!options["input-json"]) {
    throw cliError(
      "AGENT_CLI_USAGE_ERROR",
      "--input-json is required for mutations",
      2,
    );
  }
  const text =
    options["input-json"] === "-"
      ? await readFile(0, "utf8")
      : options["input-json"];
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("input JSON must be an object");
    }
    return parsed;
  } catch {
    throw cliError(
      "AGENT_CLI_USAGE_ERROR",
      "--input-json must contain one JSON object",
      2,
    );
  }
}

function pageQuery(options) {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set("limit", options.limit);
  if (options.cursor !== undefined) {
    let cursor = options.cursor;
    try {
      cursor = decodeURIComponent(cursor);
    } catch {
      // Let the API return its stable invalid-cursor error.
    }
    query.set("cursor", cursor);
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

function exitCodeForStatus(status) {
  if (status === 401 || status === 403 || status === 404) return 3;
  if (status === 409) return 4;
  if (status >= 400 && status < 500) return 2;
  return 5;
}

function cliError(code, detail, codeValue) {
  const error = new Error(detail);
  error.code = code;
  error.detail = detail;
  error.exitCode = codeValue;
  return error;
}

function redact(value) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== "object") return value;
  const output = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redact(nested);
  }
  return output;
}

function redactText(value) {
  const text = String(value);
  return SECRET_VALUE_PATTERN.test(text) ? "[REDACTED]" : text.slice(0, 2_000);
}
