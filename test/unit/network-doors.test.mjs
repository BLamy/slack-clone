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

    const result = await auditDurableStreamsAccess({ repositoryRoot });
    assert.equal(result.filesScanned, 2);
    assert.deepEqual(result.failures, [
      "src/provider-bypass.mjs:4 acquires ambient network capability through globalThis.fetch",
    ]);
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
