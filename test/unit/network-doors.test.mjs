import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  Auth0ClientError,
  createAuth0Client,
} from "../../src/auth0-client.mjs";
import { resolveApplicationApiPath } from "../../public/application-api.js";
import { auditDurableStreamsAccess } from "../../tools/audit-durable-streams-access.mjs";

test("application API door accepts only same-origin /api/ targets", () => {
  assert.equal(
    resolveApplicationApiPath(
      "/api/rooms/demo/messages?after=opaque",
      "https://app.example.test",
    ),
    "/api/rooms/demo/messages?after=opaque",
  );
  for (const target of [
    "https://streams.invalid/rooms/demo/messages",
    ["https://streams", ".invalid/rooms/demo/messages"].join(""),
    "//streams.invalid/rooms/demo/messages",
    "/rooms/demo/messages",
    "/api-ish/rooms/demo/messages",
    "/api/rooms/demo/messages#credential",
  ]) {
    assert.throws(
      () => resolveApplicationApiPath(target, "https://app.example.test"),
      /same-origin \/api\//u,
      target,
    );
  }
});

test("Auth0 door fixes requests to its configured origin and refuses redirects", async () => {
  const requests = [];
  const responses = [
    jsonResponse(200, { access_token: "bounded-token" }),
    jsonResponse(200, {
      sub: "auth0|ada",
      name: "Ada",
      email: "ada@example.test",
      nickname: "ada",
    }),
  ];
  const client = createAuth0Client({
    baseUrl: "http://auth.example.test/base/path?discarded=1",
    clientId: "client",
    clientSecret: "secret",
    realm: "realm",
    reservedOrigin: "http://streams.invalid",
    fetchFn: async (input, init) => {
      requests.push({ input: String(input), init });
      return responses.shift();
    },
  });

  const result = await client.exchangePassword("ada@example.test", "pass");
  assert.equal(result.user.sub, "auth0|ada");
  assert.deepEqual(
    requests.map(({ input }) => input),
    [
      "http://auth.example.test/oauth/token",
      "http://auth.example.test/userinfo",
    ],
  );
  assert.ok(requests.every(({ init }) => init.redirect === "manual"));
  assert.match(requests[1].init.headers.Authorization, /^Bearer /u);

  const redirecting = createAuth0Client({
    baseUrl: "http://auth.example.test",
    clientId: "client",
    clientSecret: "secret",
    realm: "realm",
    reservedOrigin: "http://streams.invalid",
    fetchFn: async () =>
      new Response(null, {
        status: 307,
        headers: { Location: "http://streams.invalid/rooms/demo/messages" },
      }),
  });
  await assert.rejects(
    redirecting.health(),
    (error) =>
      error instanceof Auth0ClientError &&
      error.code === "AUTH0_REDIRECT_REFUSED",
  );

  let confusedRequests = 0;
  assert.throws(
    () =>
      createAuth0Client({
        baseUrl: "http://streams.invalid/provider-role",
        clientId: "client",
        clientSecret: "critic-secret",
        realm: "realm",
        reservedOrigin: "http://streams.invalid/rooms",
        fetchFn: async () => {
          confusedRequests += 1;
          return jsonResponse(200, {});
        },
      }),
    (error) =>
      error instanceof Auth0ClientError &&
      error.code === "AUTH0_TRANSPORT_ROLE_CONFLICT",
  );
  assert.equal(confusedRequests, 0);
  assert.throws(
    () =>
      createAuth0Client({
        baseUrl: "http://auth.example.test",
        clientId: "client",
        clientSecret: "secret",
        realm: "realm",
        fetchFn: async () => jsonResponse(200, {}),
      }),
    /Reserved transport origin is required/u,
  );
});

test("full repository audit rejects nested ambient acquisition and permits the application door", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(os.tmpdir(), "stream-slack-network-door-"),
  );
  try {
    await mkdir(path.join(repositoryRoot, "src"), { recursive: true });
    await writeFile(
      path.join(repositoryRoot, "src/provider-bypass.mjs"),
      `
        const options = { transport: {} };
        const {
          transport: { send = globalThis.fetch },
        } = options;
        const streamOrigin = "http://streams.invalid";
        await send(streamOrigin + "/rooms/synthetic/messages");
      `,
    );
    await writeFile(
      path.join(repositoryRoot, "src/application-getter.mjs"),
      `
        import { applicationApiFetch } from "/application-api.js";
        const target = {
          get value() { return "/api/rooms/synthetic/messages"; },
        };
        await applicationApiFetch(target.value);
      `,
    );
    await writeFile(
      path.join(repositoryRoot, "src/constructor-bypass.mjs"),
      `
        const send = (() => {}).constructor("return globalThis.fetch")();
        await send("http://streams.invalid/rooms/synthetic/messages");
      `,
    );
    await writeFile(
      path.join(repositoryRoot, "src/loader-bypass.mjs"),
      `
        import { createRequire as makeRequire } from "node:module";
        const load = makeRequire(import.meta.url);
        export const request = load("node:http").request;
      `,
    );

    const result = await auditDurableStreamsAccess({ repositoryRoot });
    assert.equal(result.filesScanned, 4);
    assert.equal(result.failures.length, 3);
    assert.match(
      result.failures.join("\n"),
      /constructor-bypass\.mjs:2 uses forbidden runtime capability member constructor/u,
    );
    assert.match(
      result.failures.join("\n"),
      /loader-bypass\.mjs:2 imports runtime module loader node:module/u,
    );
    assert.match(
      result.failures.join("\n"),
      /provider-bypass\.mjs:4 acquires ambient network capability through globalThis\.fetch/u,
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("full repository audit covers CommonJS and browser loader files", async () => {
  const repositoryRoot = await mkdtemp(
    path.join(os.tmpdir(), "stream-slack-structural-door-"),
  );
  try {
    await mkdir(path.join(repositoryRoot, "src"), { recursive: true });
    await mkdir(path.join(repositoryRoot, "public"), { recursive: true });
    await writeFile(
      path.join(repositoryRoot, "src/unscanned-loader.cjs"),
      'module.exports = require("node:http");\n',
    );
    await writeFile(
      path.join(repositoryRoot, "public/dom-loader.js"),
      `
        const script = document.createElement("script");
        script.src = "http://streams.invalid/rooms/dom/messages";
        document.head.append(script);
      `,
    );
    await writeFile(
      path.join(repositoryRoot, "public/process-loader.js"),
      `
        import { getBuiltinModule } from "node:process";
        export const request = getBuiltinModule("node:http").request;
      `,
    );
    await writeFile(
      path.join(repositoryRoot, "public/index.html"),
      '<script src="https://streams.invalid/rooms/html/messages"></script>\n',
    );
    await writeFile(
      path.join(repositoryRoot, "public/styles.css"),
      '.avatar { background: url("https://streams.invalid/rooms/css/messages"); }\n',
    );
    await writeFile(
      path.join(repositoryRoot, "public/inline.html"),
      '<script>new Worker("https://streams.invalid/rooms/inline/messages");</script>\n',
    );

    const result = await auditDurableStreamsAccess({ repositoryRoot });
    assert.ok(result.filesScanned >= 5);
    assert.match(
      result.failures.join("\n"),
      /unscanned-loader\.cjs:1 imports outbound network module node:http outside a declared transport door/u,
    );
    assert.match(
      result.failures.join("\n"),
      /dom-loader\.js:2 uses browser request surface createElement outside the application transport door/u,
    );
    assert.match(
      result.failures.join("\n"),
      /process-loader\.js:2 imports runtime capability node:process outside a declared transport door/u,
    );
    assert.match(
      result.failures.join("\n"),
      /index\.html:1 contains browser network URL in a resource attribute/u,
    );
    assert.match(
      result.failures.join("\n"),
      /styles\.css:1 contains browser network URL in a stylesheet resource/u,
    );
    assert.match(
      result.failures.join("\n"),
      /inline\.html:1 acquires ambient network capability Worker outside a declared provider door/u,
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
