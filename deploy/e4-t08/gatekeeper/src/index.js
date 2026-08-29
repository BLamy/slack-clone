export class ProbeLog {
  constructor(ctx) {
    this.storage = ctx.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/record") {
      const events = (await this.storage.get("events")) ?? [];
      events.push(await request.json());
      await this.storage.put("events", events.slice(-500));
      return Response.json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/events") {
      return Response.json({
        events: (await this.storage.get("events")) ?? [],
      });
    }
    if (request.method === "DELETE" && url.pathname === "/events") {
      await this.storage.delete("events");
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      url.pathname === "/" ||
      url.pathname.startsWith("/e4-t08-gatekeeper/")
    ) {
      const probeId = request.headers.get("x-e4-t08-probe");
      if (probeId) {
        await env.ProbeLog.getByName("e4-t08-global").fetch(
          new Request("https://probe-log/record", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              probeId,
              path: url.pathname,
              host: url.hostname,
              timestampMs: Date.now(),
              marker: "e4-t08-gatekeeper-ok",
            }),
          }),
        );
      }
      return Response.json({ marker: "e4-t08-gatekeeper-ok" });
    }
    if (url.pathname === "/events") {
      return env.ProbeLog.getByName("e4-t08-global").fetch(request);
    }
    return new Response("not found", { status: 404 });
  },
};
