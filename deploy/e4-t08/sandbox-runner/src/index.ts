import {
  ContainerProxy,
  getSandbox,
  Sandbox as BaseSandbox,
} from "@cloudflare/sandbox";
import type { OutboundHandlerContext } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";

export { ContainerProxy };

const GATEKEEPER_HOST = "e4t08-gatekeeper-20260824.brett-lamy.workers.dev";

export class EgressLog extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/record") {
      const events =
        (await this.ctx.storage.get<EgressEvent[]>("events")) ?? [];
      const event = (await request.json()) as EgressEvent;
      events.push(event);
      await this.ctx.storage.put("events", events.slice(-100));
      return Response.json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/events") {
      return Response.json({
        events: (await this.ctx.storage.get<EgressEvent[]>("events")) ?? [],
      });
    }
    if (request.method === "DELETE" && url.pathname === "/events") {
      await this.ctx.storage.delete("events");
      return Response.json({ ok: true });
    }
    return new Response("Not found", { status: 404 });
  }
}

type EgressEvent = {
  probeId: string | null;
  outcome: "allow" | "deny";
  destination: { scheme: string; host: string; port: number };
  status: number;
  timestampMs: number;
  ruleId: string;
  providerObservationId: string;
};

export class Sandbox extends BaseSandbox<Env> {
  enableInternet = false;
  interceptHttps = true;
}

Sandbox.outboundHandlers = {
  e4t08Allowed: allowGatekeeperEgress,
  e4t08Denied: denyEgress,
};
Sandbox.outboundByHost = { [GATEKEEPER_HOST]: allowGatekeeperEgress };
Sandbox.outbound = denyEgress;

type RunnerBody = {
  sandboxId?: string;
  allowedHost?: string | null;
  entries?: Array<{
    path: string;
    type?: "file" | "directory";
    mode?: number;
    contentBase64?: string;
  }>;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  processId?: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === "GET" &&
      url.pathname.startsWith("/e4-t08-gatekeeper/")
    ) {
      return Response.json({ marker: "e4-t08-gatekeeper-ok" });
    }
    if (url.pathname === "/run") {
      const sandbox = getSandbox(env.Sandbox, "compatibility-check");
      const result = await sandbox.exec('echo "2 + 2 = $((2 + 2))"');
      return Response.json(result);
    }

    let body: RunnerBody = {};
    if (request.method !== "GET" && request.method !== "DELETE") {
      body = (await request.json()) as RunnerBody;
    }
    const sandboxId = body.sandboxId ?? url.searchParams.get("sandboxId") ?? "";
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(sandboxId)) {
      return Response.json({ error: "sandboxId is invalid" }, { status: 400 });
    }
    const sandbox = getSandbox(env.Sandbox, sandboxId);

    if (request.method === "POST" && url.pathname === "/sandbox/configure") {
      try {
        // Keep the provider catch-all handler in the path for every host. A
        // non-empty allowlist would short-circuit the handler and lose the
        // provider-owned deny observation.
        await sandbox.setAllowedHosts(["*"]);
        await sandbox.setDeniedHosts([]);
        if (body.allowedHost) {
          await sandbox.setOutboundByHost(body.allowedHost, "e4t08Allowed", {
            sandboxId,
          });
        }
        await sandbox.setOutboundHandler("e4t08Denied", { sandboxId });
        await clearEgress(env, sandboxId);
        return Response.json({ sandboxId, state: await sandbox.getState() });
      } catch (error) {
        return Response.json(
          {
            error:
              error instanceof Error
                ? (error.stack ?? error.message)
                : String(error),
          },
          { status: 500 },
        );
      }
    }
    if (request.method === "POST" && url.pathname === "/sandbox/workspace") {
      for (const entry of body.entries ?? []) {
        const entryPath = safeWorkspacePath(entry.path);
        if (entry.type === "directory") {
          await sandbox.mkdir(entryPath, { recursive: true });
        } else {
          await sandbox.mkdir(entryPath.slice(0, entryPath.lastIndexOf("/")), {
            recursive: true,
          });
          await sandbox.writeFile(entryPath, entry.contentBase64 ?? "", {
            encoding: "base64",
          });
        }
        if (entry.mode !== undefined) {
          await sandbox.exec(
            `chmod ${entry.mode.toString(8)} ${shellQuote(entryPath)}`,
          );
        }
      }
      return Response.json({
        sandboxId,
        files:
          body.entries?.filter((entry) => entry.type !== "directory").length ??
          0,
        observationId: `workspace:${sandboxId}:${Date.now()}`,
      });
    }
    if (request.method === "POST" && url.pathname === "/sandbox/exec/start") {
      if (typeof body.command !== "string" || body.command.length === 0) {
        return Response.json({ error: "command is required" }, { status: 400 });
      }
      const process = await sandbox.startProcess(body.command, {
        cwd: body.cwd ?? "/workspace",
        env: body.env,
        autoCleanup: false,
      });
      return Response.json({ sandboxId, processId: process.id });
    }
    if (request.method === "GET" && url.pathname === "/sandbox/exec/snapshot") {
      const processId =
        body.processId ?? url.searchParams.get("processId") ?? "";
      if (!processId) {
        return Response.json(
          { error: "processId is required" },
          { status: 400 },
        );
      }
      const process = await sandbox.getProcess(processId);
      const logs = process
        ? await process.getLogs()
        : { stdout: "", stderr: "" };
      const stdoutOffset = Number(url.searchParams.get("stdoutOffset") ?? "0");
      const stderrOffset = Number(url.searchParams.get("stderrOffset") ?? "0");
      if (
        !Number.isSafeInteger(stdoutOffset) ||
        stdoutOffset < 0 ||
        !Number.isSafeInteger(stderrOffset) ||
        stderrOffset < 0
      ) {
        return Response.json(
          { error: "process offsets are invalid" },
          { status: 400 },
        );
      }
      const stdout = String(logs.stdout ?? "");
      const stderr = String(logs.stderr ?? "");
      if (stdoutOffset > stdout.length || stderrOffset > stderr.length) {
        return Response.json(
          { error: "process offsets are ahead of provider logs" },
          { status: 409 },
        );
      }
      const processes = await sandbox.listProcesses();
      const egress = await readEgress(env, sandboxId);
      const providerObservationId = `process-log:${processId}:${stdoutOffset}:${stderrOffset}:${stdout.length}:${stderr.length}`;
      return Response.json({
        sandboxId,
        process: process
          ? {
              id: process.id,
              status: process.status,
              exitCode: process.exitCode ?? null,
            }
          : null,
        stdoutDelta: stdout.slice(stdoutOffset),
        stderrDelta: stderr.slice(stderrOffset),
        stdoutOffset: stdout.length,
        stderrOffset: stderr.length,
        providerObservationId,
        providerObservation: {
          providerObservationId,
          requestedStdoutOffset: stdoutOffset,
          requestedStderrOffset: stderrOffset,
          stdoutOffset: stdout.length,
          stderrOffset: stderr.length,
        },
        runningProcessCount: processes.filter(
          (candidate) => candidate.status === "running",
        ).length,
        processes: processes.map((candidate) => ({
          id: candidate.id,
          status: candidate.status,
          command: candidate.command,
        })),
        egress,
      });
    }
    if (request.method === "GET" && url.pathname === "/sandbox/egress") {
      const probeId = url.searchParams.get("probeId") ?? "";
      const events = (await readEgress(env, sandboxId)).filter(
        (event) => event.probeId === probeId,
      );
      return Response.json({
        sandboxId,
        probeId,
        events,
        observationId: events[0]?.providerObservationId ?? null,
      });
    }
    if (request.method === "POST" && url.pathname === "/sandbox/exec/cancel") {
      if (!body.processId) {
        return Response.json(
          { error: "processId is required" },
          { status: 400 },
        );
      }
      await sandbox.killProcess(body.processId, "SIGTERM");
      const cleanedCount = await sandbox.killAllProcesses();
      const processes = await sandbox.listProcesses();
      return Response.json({
        sandboxId,
        cleanedCount,
        runningProcessCount: processes.filter(
          (candidate) => candidate.status === "running",
        ).length,
      });
    }
    if (request.method === "DELETE" && url.pathname === "/sandbox") {
      await sandbox.destroy();
      return Response.json({
        sandboxId,
        destroyed: true,
        runningProcessCount: 0,
      });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },
};

async function allowGatekeeperEgress(
  request: Request,
  env: Env,
  context: OutboundHandlerContext<{ sandboxId: string }>,
) {
  const url = new URL(request.url);
  console.log("e4t08 outbound allow", url.toString(), context.containerId);
  const probeId = request.headers.get("x-e4-t08-probe");
  const sandboxId = context.params?.sandboxId ?? context.containerId;
  const destination = observedDestination(request);
  if (url.pathname !== "/" && !url.pathname.startsWith("/e4-t08-gatekeeper/")) {
    await recordEgress(env, sandboxId, {
      probeId,
      outcome: "deny",
      destination,
      status: 403,
      timestampMs: Date.now(),
      ruleId: "e4-t08-gatekeeper-path",
      providerObservationId: `container-egress:${sandboxId}:${Date.now()}`,
    });
    return new Response("Forbidden by E4-T08 Gatekeeper policy", {
      status: 403,
    });
  }
  const target = new URL(
    url.pathname + url.search,
    `https://${GATEKEEPER_HOST}`,
  );
  const response = await fetch(new Request(target, request));
  await recordEgress(env, sandboxId, {
    probeId,
    outcome: response.ok ? "allow" : "deny",
    destination,
    status: response.status,
    timestampMs: Date.now(),
    ruleId: "e4-t08-gatekeeper",
    providerObservationId: `container-egress:${sandboxId}:${Date.now()}`,
  });
  return response;
}

async function denyEgress(
  request: Request,
  env: Env,
  context: OutboundHandlerContext<{ sandboxId: string }>,
) {
  const url = new URL(request.url);
  console.log("e4t08 outbound deny", url.toString(), context.containerId);
  const sandboxId = context.params?.sandboxId ?? context.containerId;
  await recordEgress(env, sandboxId, {
    probeId: request.headers.get("x-e4-t08-probe"),
    outcome: "deny",
    destination: observedDestination(request),
    status: 403,
    timestampMs: Date.now(),
    ruleId: "default-deny",
    providerObservationId: `container-egress:${sandboxId}:${Date.now()}`,
  });
  return new Response("Forbidden by E4-T08 default-deny policy", {
    status: 403,
  });
}

async function recordEgress(env: Env, sandboxId: string, event: EgressEvent) {
  await env.EgressLog.getByName(sandboxId).fetch(
    new Request("https://egress/record", {
      method: "POST",
      body: JSON.stringify(event),
      headers: { "content-type": "application/json" },
    }),
  );
}

async function readEgress(env: Env, sandboxId: string): Promise<EgressEvent[]> {
  const response = await env.EgressLog.getByName(sandboxId).fetch(
    "https://egress/events",
  );
  const payload = (await response.json()) as { events?: EgressEvent[] };
  return payload.events ?? [];
}

async function clearEgress(env: Env, sandboxId: string) {
  await env.EgressLog.getByName(sandboxId).fetch(
    new Request("https://egress/events", { method: "DELETE" }),
  );
}

function safeWorkspacePath(value: string) {
  if (value === "workspace") return "/workspace";
  if (!/^workspace\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error("workspace path is invalid");
  }
  return `/${value}`;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function observedDestination(request: Request) {
  const intercepted = new URL(request.url);
  return {
    scheme: intercepted.protocol.slice(0, -1),
    host: intercepted.hostname,
    port: intercepted.port
      ? Number(intercepted.port)
      : intercepted.protocol === "http:"
        ? 80
        : 443,
  };
}
