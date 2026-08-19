export const INTERPROCEDURAL_SOURCE_AUDIT_CASES = Object.freeze([
  providerCase(
    "declaration-order-three-hop",
    `
      const streamOrigin = "http://streams.invalid";
      await outer(streamOrigin + "/rooms/interprocedural-order/messages");
      function outer(target) { return middle(target); }
      const middle = (target) => inner(target);
      const inner = globalThis.fetch;
    `,
  ),
  providerCase(
    "higher-order-parameter-dispatch",
    `
      function invoke(callable, target) { return callable(target); }
      const streamOrigin = "http://streams.invalid";
      await invoke(
        globalThis.fetch,
        streamOrigin + "/rooms/interprocedural-hof/messages",
      );
    `,
  ),
  providerCase(
    "higher-order-object-factory",
    `
      const makeTransport = (callable) => ({
        send(target) { return callable(target); },
      });
      const transport = makeTransport(globalThis.fetch);
      const streamOrigin = "http://streams.invalid";
      await transport.send(
        streamOrigin + "/rooms/interprocedural-factory/messages",
      );
    `,
  ),
  providerCase(
    "literal-array-callback-container",
    `
      const streamOrigin = "http://streams.invalid";
      await Promise.all(
        [globalThis.fetch].map((callable) =>
          callable(streamOrigin + "/rooms/interprocedural-callback/messages"),
        ),
      );
    `,
  ),
  providerCase(
    "array-at-extraction",
    `
      const callable = [globalThis.fetch].at(0);
      const streamOrigin = "http://streams.invalid";
      await callable(streamOrigin + "/rooms/interprocedural-array-at/messages");
    `,
  ),
  providerCase(
    "map-get-extraction",
    `
      const transports = new Map([["primary", globalThis.fetch]]);
      const streamOrigin = "http://streams.invalid";
      await transports.get("primary")(
        streamOrigin + "/rooms/interprocedural-map/messages",
      );
    `,
  ),
  providerCase(
    "class-constructor-injection",
    `
      class Transport {
        constructor(callable) { this.callable = callable; }
        send(target) { return this.callable(target); }
      }
      const transport = new Transport(globalThis.fetch);
      const streamOrigin = "http://streams.invalid";
      await transport.send(
        streamOrigin + "/rooms/interprocedural-class/messages",
      );
    `,
  ),
  providerCase(
    "reflect-get-member-extraction",
    `
      const callable = Reflect.get(globalThis, "fetch");
      const streamOrigin = "http://streams.invalid";
      await callable(
        streamOrigin + "/rooms/interprocedural-reflect-get/messages",
      );
    `,
  ),
  providerCase(
    "descriptor-member-extraction",
    `
      const { value: callable } = Object.getOwnPropertyDescriptor(
        globalThis,
        "fetch",
      );
      const streamOrigin = "http://streams.invalid";
      await callable(
        streamOrigin + "/rooms/interprocedural-descriptor/messages",
      );
    `,
  ),
  providerCase(
    "borrowed-call-prototype",
    `
      const invoke = Function.prototype.call;
      const streamOrigin = "http://streams.invalid";
      await invoke.call(
        globalThis.fetch,
        globalThis,
        streamOrigin + "/rooms/interprocedural-borrow-call/messages",
      );
    `,
  ),
  providerCase(
    "borrowed-apply-prototype",
    `
      const invoke = Function.prototype.apply;
      const streamOrigin = "http://streams.invalid";
      await invoke.call(globalThis.fetch, globalThis, [
        streamOrigin + "/rooms/interprocedural-borrow-apply/messages",
      ]);
    `,
  ),
  providerCase(
    "reflect-get-bind",
    `
      const bind = Reflect.get(Function.prototype, "bind");
      const callable = bind.call(globalThis.fetch, globalThis);
      const streamOrigin = "http://streams.invalid";
      await callable(streamOrigin + "/rooms/interprocedural-bind/messages");
    `,
  ),
  providerCase(
    "default-parameter-provider-second-argument",
    `
      const invoke = (callable = globalThis.fetch, target) => callable(target);
      const streamOrigin = "http://streams.invalid";
      await invoke(
        undefined,
        streamOrigin + "/rooms/interprocedural-default/messages",
      );
    `,
  ),
  providerCase(
    "rest-parameter-provider-third-argument",
    `
      const invoke = (callable, ...targets) => callable(targets[1]);
      const streamOrigin = "http://streams.invalid";
      await invoke(
        globalThis.fetch,
        "/api/rooms/interprocedural/messages",
        streamOrigin + "/rooms/interprocedural-rest/messages",
      );
    `,
  ),
  providerCase(
    "conditional-mixed-application-provider-target",
    `
      const useProvider = true;
      const durableStreamsUrl = "http://streams.invalid";
      await globalThis.fetch(
        useProvider
          ? durableStreamsUrl + "/rooms/interprocedural-conditional/messages"
          : "/api/rooms/interprocedural/messages",
      );
    `,
  ),
  providerCase(
    "logical-mixed-application-provider-target",
    `
      const durableStreamsUrl = "http://streams.invalid";
      const target =
        (durableStreamsUrl &&
          durableStreamsUrl + "/rooms/interprocedural-logical/messages") ||
        "/api/rooms/interprocedural/messages";
      await globalThis.fetch(target);
    `,
  ),
  providerCase(
    "sequence-mixed-application-provider-target",
    `
      const durableStreamsUrl = "http://streams.invalid";
      await globalThis.fetch(
        ("/api/rooms/interprocedural/messages",
        durableStreamsUrl + "/rooms/interprocedural-sequence/messages"),
      );
    `,
  ),
  providerCase(
    "computed-symbol-member-extraction",
    `
      const key = ["fe", "tch"].join("");
      const callable = globalThis[key];
      const streamOrigin = "http://streams.invalid";
      await callable(
        streamOrigin + "/rooms/interprocedural-computed/messages",
      );
    `,
  ),
  providerCase(
    "member-extraction-after-alias-cycle",
    `
      let first;
      let second;
      first = second;
      second = first;
      second = globalThis.fetch;
      const callable = first;
      const streamOrigin = "http://streams.invalid";
      await callable(streamOrigin + "/rooms/interprocedural-cycle/messages");
    `,
  ),
  providerCase(
    "partially-bound-provider-target",
    `
      function invoke(callable, target) { return callable(target); }
      const streamOrigin = "http://streams.invalid";
      const send = invoke.bind(
        null,
        globalThis.fetch,
        streamOrigin + "/rooms/interprocedural-bound-target/messages",
      );
      await send();
    `,
  ),
  providerCase(
    "returned-provider-target",
    `
      const streamOrigin = "http://streams.invalid";
      const target = () =>
        streamOrigin + "/rooms/interprocedural-returned-target/messages";
      await globalThis.fetch(target());
    `,
  ),
  providerCase(
    "iterator-chain-extraction",
    `
      const transports = new Set([globalThis.fetch]);
      const send = transports.values().next().value;
      const streamOrigin = "http://streams.invalid";
      await send(streamOrigin + "/rooms/interprocedural-iterator/messages");
    `,
  ),
  providerCase(
    "object-assign-factory",
    `
      const transport = Object.assign({}, { send: globalThis.fetch });
      const streamOrigin = "http://streams.invalid";
      await transport.send(
        streamOrigin + "/rooms/interprocedural-object-assign/messages",
      );
    `,
  ),
  allowCase(
    "application-api-variable",
    `
      import { applicationApiFetch } from "./application-api.js";
      const streamUrl = "/api/rooms/interprocedural/messages";
      await applicationApiFetch(streamUrl);
    `,
  ),
  allowCase(
    "application-api-conditional",
    `
      import { applicationApiFetch } from "./application-api.js";
      const target = Math.random() > -1
        ? "/api/rooms/interprocedural/messages"
        : "/api/rooms/interprocedural/events";
      await applicationApiFetch(target);
    `,
  ),
  allowCase(
    "application-api-wrapper-options",
    `
      import { applicationApiFetch } from "./application-api.js";
      const invoke = (callable, target, init) => callable(target, init);
      await invoke(applicationApiFetch, "/api/rooms/interprocedural/messages", {
        method: "POST",
      });
    `,
  ),
  allowCase(
    "partially-bound-application-api",
    `
      import { applicationApiFetch } from "./application-api.js";
      function invoke(callable, target) { return callable(target); }
      const send = invoke.bind(
        null,
        applicationApiFetch,
        "/api/rooms/interprocedural/messages",
      );
      await send();
    `,
  ),
  allowCase(
    "returned-application-api-target",
    `
      import { applicationApiFetch } from "./application-api.js";
      const target = () => "/api/rooms/interprocedural/messages";
      await applicationApiFetch(target());
    `,
  ),
]);

export const NETWORK_DOOR_SOURCE_AUDIT_CASES = Object.freeze([
  providerCase(
    "mutually-recursive-network-capability",
    `
      function first(callable, target, remaining) {
        return remaining === 0
          ? callable(target)
          : second(callable, target, remaining - 1);
      }
      function second(callable, target, remaining) {
        return first(callable, target, remaining);
      }
      const streamOrigin = "http://streams.invalid";
      await first(
        globalThis.fetch,
        streamOrigin + "/rooms/network-door-recursive/messages",
        2,
      );
    `,
  ),
  providerCase(
    "closure-returning-network-capability",
    `
      const closeOver = (callable) => () => callable;
      const send = closeOver(globalThis.fetch)();
      const streamOrigin = "http://streams.invalid";
      await send(streamOrigin + "/rooms/network-door-closure/messages");
    `,
  ),
  providerCase(
    "async-network-wrapper",
    `
      async function invoke(callable, target) {
        return callable(target);
      }
      const streamOrigin = "http://streams.invalid";
      await invoke(
        globalThis.fetch,
        streamOrigin + "/rooms/network-door-async/messages",
      );
    `,
  ),
  providerCase(
    "generator-network-wrapper",
    `
      function* expose(callable) { yield callable; }
      const send = expose(globalThis.fetch).next().value;
      const streamOrigin = "http://streams.invalid";
      await send(streamOrigin + "/rooms/network-door-generator/messages");
    `,
  ),
  providerCase(
    "spread-argument-forwarding",
    `
      const invoke = (callable, args) => callable(...args);
      const streamOrigin = "http://streams.invalid";
      await invoke(globalThis.fetch, [
        streamOrigin + "/rooms/network-door-spread/messages",
      ]);
    `,
  ),
  providerCase(
    "prototype-method-inheritance",
    `
      const inherited = { send: globalThis.fetch };
      const transport = Object.setPrototypeOf({}, inherited);
      const streamOrigin = "http://streams.invalid";
      await transport.send(
        streamOrigin + "/rooms/network-door-prototype/messages",
      );
    `,
  ),
  providerCase(
    "define-property-network-getter",
    `
      const transport = {};
      Object.defineProperty(transport, "send", {
        get() { return globalThis.fetch; },
      });
      const streamOrigin = "http://streams.invalid";
      await transport.send(
        streamOrigin + "/rooms/network-door-define-property/messages",
      );
    `,
  ),
  providerCase(
    "late-weak-map-network-capability",
    `
      const transports = new WeakMap();
      const owner = {};
      transports.set(owner, globalThis.fetch);
      const streamOrigin = "http://streams.invalid";
      await transports.get(owner)(
        streamOrigin + "/rooms/network-door-weak-map/messages",
      );
    `,
  ),
  providerCase(
    "nested-destructuring-network-default",
    `
      const options = { transport: {} };
      const {
        transport: { send = globalThis.fetch },
      } = options;
      const streamOrigin = "http://streams.invalid";
      await send(
        streamOrigin + "/rooms/network-door-nested-default/messages",
      );
    `,
  ),
  providerCase(
    "tagged-network-selector",
    `
      function select(strings, ...values) { return values[0]; }
      const send = select\`transport:\${globalThis.fetch}\`;
      const streamOrigin = "http://streams.invalid";
      await send(streamOrigin + "/rooms/network-door-tagged/messages");
    `,
  ),
  providerCase(
    "proxy-network-get-trap",
    `
      const transport = new Proxy({}, {
        get() { return globalThis.fetch; },
      });
      const streamOrigin = "http://streams.invalid";
      await transport.send(streamOrigin + "/rooms/network-door-proxy/messages");
    `,
  ),
  providerCase(
    "proxy-network-apply-trap",
    `
      const send = new Proxy(() => {}, {
        apply(_target, _thisArg, args) {
          return Reflect.apply(globalThis.fetch, globalThis, args);
        },
      });
      const streamOrigin = "http://streams.invalid";
      await send(
        streamOrigin + "/rooms/network-door-proxy-apply/messages",
      );
    `,
  ),
  providerCase(
    "reflect-construct-network-injection",
    `
      class Transport {
        constructor(callable) { this.send = callable; }
      }
      const transport = Reflect.construct(Transport, [globalThis.fetch]);
      const streamOrigin = "http://streams.invalid";
      await transport.send(
        streamOrigin + "/rooms/network-door-reflect-construct/messages",
      );
    `,
  ),
  providerCase(
    "inherited-network-getter",
    `
      const inherited = {
        get send() { return globalThis.fetch; },
      };
      const transport = Object.create(inherited);
      const streamOrigin = "http://streams.invalid";
      await transport.send(
        streamOrigin + "/rooms/network-door-inherited-getter/messages",
      );
    `,
  ),
  providerCase(
    "optional-network-call",
    `
      const transport = { send: globalThis.fetch };
      const streamOrigin = "http://streams.invalid";
      await transport.send?.(
        streamOrigin + "/rooms/network-door-optional/messages",
      );
    `,
  ),
  providerCase(
    "reflect-computed-network-member",
    `
      const member = ["fe", "tch"].join("");
      const send = Reflect.get(globalThis, member);
      const streamOrigin = "http://streams.invalid";
      await send(
        streamOrigin + "/rooms/network-door-reflect-computed/messages",
      );
    `,
  ),
  providerCase(
    "map-closure-network-capability",
    `
      const expose = (callable) => new Map([["send", () => callable]]);
      const send = expose(globalThis.fetch).get("send")();
      const streamOrigin = "http://streams.invalid";
      await send(streamOrigin + "/rooms/network-door-map-closure/messages");
    `,
  ),
  providerCase(
    "nested-default-rest-network-capability",
    `
      function invoke({ transport: { send = globalThis.fetch } }, ...targets) {
        return send(targets[1]);
      }
      const streamOrigin = "http://streams.invalid";
      await invoke(
        { transport: {} },
        "/api/rooms/network-door/messages",
        streamOrigin + "/rooms/network-door-default-rest/messages",
      );
    `,
  ),
  providerCase(
    "async-generator-network-capability",
    `
      async function* expose(callable) { yield callable; }
      const iterator = expose(globalThis.fetch);
      const send = (await iterator.next()).value;
      const streamOrigin = "http://streams.invalid";
      await send(
        streamOrigin + "/rooms/network-door-async-generator/messages",
      );
    `,
  ),
  providerCase(
    "mixed-door-network-capability",
    `
      import { applicationApiFetch } from "./application-api.js";
      const useProvider = true;
      const send = useProvider ? globalThis.fetch : applicationApiFetch;
      const streamOrigin = "http://streams.invalid";
      await send(streamOrigin + "/rooms/network-door-mixed/messages");
    `,
  ),
  allowCase(
    "declared-application-door-literal",
    `
      import { applicationApiFetch } from "./application-api.js";
      await applicationApiFetch("/api/rooms/network-door/messages");
    `,
  ),
  allowCase(
    "declared-application-door-closure",
    `
      import { applicationApiFetch } from "./application-api.js";
      const target = () => "/api/rooms/network-door/messages";
      await applicationApiFetch(target());
    `,
  ),
  allowCase(
    "application-literal-getter",
    `
      import { applicationApiFetch } from "./application-api.js";
      const target = { get value() { return "/api/rooms/network-door/messages"; } };
      await applicationApiFetch(target.value);
    `,
  ),
  allowCase(
    "application-inherited-getter",
    `
      import { applicationApiFetch } from "./application-api.js";
      const inherited = {
        get value() { return "/api/rooms/network-door/messages"; },
      };
      await applicationApiFetch(Object.create(inherited).value);
    `,
  ),
  allowCase(
    "application-tagged-stream-url",
    `
      import { applicationApiFetch } from "./application-api.js";
      function select(_strings, ...values) { return values[0]; }
      const streamUrl = select\`target:\${"/api/rooms/network-door/messages"}\`;
      await applicationApiFetch(streamUrl);
    `,
  ),
  allowCase(
    "application-conditional-targets",
    `
      import { applicationApiFetch } from "./application-api.js";
      const target = Math.random() > -1
        ? "/api/rooms/network-door/messages"
        : "/api/rooms/network-door/events";
      await applicationApiFetch(target);
    `,
  ),
  allowCase(
    "declared-application-events-door",
    `
      import { applicationApiEvents } from "./application-api.js";
      applicationApiEvents("/api/rooms/network-door/events");
    `,
  ),
]);

export const STATIC_DOOR_CONTRACT_SOURCE_AUDIT_CASES = Object.freeze([
  violationCase(
    "commonjs-network-loader",
    `
      module.exports = require("node:http");
    `,
    ["direct-provider-network"],
    "src/commonjs-network-loader.cjs",
  ),
  violationCase(
    "named-process-loader",
    `
      import { getBuiltinModule } from "node:process";
      export const request = getBuiltinModule("node:http").request;
    `,
    ["direct-provider-network"],
    "src/named-process-loader.mjs",
  ),
  allowCase(
    "safe-named-process-import",
    `
      import { env, exit, on } from "node:process";
      export const runtime = { env, exit, on };
    `,
    "src/safe-process-import.mjs",
  ),
  violationCase(
    "dom-script-src-loader",
    `
      const script = document.createElement("script");
      script.src = "http://streams.invalid/rooms/dom-script/messages";
      document.head.append(script);
    `,
    ["direct-provider-network"],
    "public/dom-script-loader.js",
  ),
  violationCase(
    "dom-image-src-loader",
    `
      const beacon = new Image();
      beacon.src = "http://streams.invalid/rooms/dom-image/messages";
    `,
    ["direct-provider-network"],
    "public/dom-image-loader.js",
  ),
  violationCase(
    "dom-worker-loader",
    `
      new Worker("http://streams.invalid/rooms/dom-worker/messages");
      new SharedWorker("http://streams.invalid/rooms/dom-shared-worker/messages");
    `,
    ["direct-provider-network"],
    "public/dom-worker-loader.js",
  ),
  violationCase(
    "service-worker-loader",
    `
      navigator.serviceWorker.register(
        "http://streams.invalid/rooms/dom-service-worker/messages",
      );
    `,
    ["direct-provider-network"],
    "public/dom-service-worker-loader.js",
  ),
  providerCase(
    "window-top-fetch",
    `
      const streamOrigin = "http://streams.invalid";
      await window.top.fetch(streamOrigin + "/rooms/window-top/messages");
    `,
  ),
  providerCase(
    "bare-top-fetch",
    `
      const streamOrigin = "http://streams.invalid";
      await top.fetch(streamOrigin + "/rooms/bare-top/messages");
    `,
  ),
  providerCase(
    "document-default-view-fetch",
    `
      const streamOrigin = "http://streams.invalid";
      await document.defaultView.fetch(
        streamOrigin + "/rooms/default-view/messages",
      );
    `,
  ),
  providerCase(
    "global-function-recovery",
    `
      const send = globalThis.Function("return globalThis.fetch")();
      await send("http://streams.invalid/rooms/global-function/messages");
    `,
  ),
  providerCase(
    "global-eval-recovery",
    `
      const send = globalThis.eval("globalThis.fetch");
      await send("http://streams.invalid/rooms/global-eval/messages");
    `,
  ),
  providerCase(
    "arrow-constructor-recovery",
    `
      const send = (() => {}).constructor("return globalThis.fetch")();
      await send("http://streams.invalid/rooms/arrow-constructor/messages");
    `,
  ),
  providerCase(
    "async-constructor-recovery",
    `
      const AsyncFunction = (async () => {}).constructor;
      const send = await AsyncFunction("return globalThis.fetch")();
      await send("http://streams.invalid/rooms/async-constructor/messages");
    `,
  ),
  providerCase(
    "reflect-constructor-recovery",
    `
      const Constructor = Reflect.get(() => {}, "constructor");
      const send = Constructor("return globalThis.fetch")();
      await send("http://streams.invalid/rooms/reflect-constructor/messages");
    `,
  ),
  providerCase(
    "descriptor-constructor-recovery",
    `
      const descriptor = Object.getOwnPropertyDescriptor(
        () => {},
        "constructor",
      );
      const send = descriptor.value("return globalThis.fetch")();
      await send("http://streams.invalid/rooms/descriptor-constructor/messages");
    `,
  ),
  providerCase(
    "nested-send-beacon",
    `
      window.navigator.sendBeacon(
        "http://streams.invalid/rooms/send-beacon/messages",
        "payload",
      );
    `,
  ),
  providerCase(
    "node-dns-module",
    `
      import { resolve } from "node:dns";
      await new Promise((done) => resolve("streams.invalid", done));
    `,
  ),
  providerCase(
    "node-dns-promises-module",
    `
      import { resolve } from "node:dns/promises";
      await resolve("streams.invalid");
    `,
  ),
  providerCase(
    "node-child-process-module",
    `
      import { execFile } from "node:child_process";
      execFile("curl", ["http://streams.invalid/rooms/process/messages"]);
    `,
  ),
  providerCase(
    "deno-network-global",
    `
      await globalThis.Deno.connect({ hostname: "streams.invalid", port: 80 });
    `,
  ),
  providerCase(
    "bun-network-global",
    `
      Bun.connect({ hostname: "streams.invalid", port: 80 });
    `,
  ),
  providerCase(
    "create-require-alias",
    `
      import { createRequire as makeRequire } from "node:module";
      const load = makeRequire(import.meta.url);
      const { request } = load("node:http");
      export { request };
    `,
  ),
  providerCase(
    "commonjs-require-alias",
    `
      const load = require;
      const { request } = load("node:http");
      export { request };
    `,
  ),
  providerCase(
    "get-builtin-alias",
    `
      const load = process.getBuiltinModule;
      const { request } = load("node:http");
      export { request };
    `,
  ),
  providerCase(
    "get-builtin-computed",
    `
      const member = ["get", "BuiltinModule"].join("");
      const { request } = process[member]("node:http");
      export { request };
    `,
  ),
  providerCase(
    "remote-dynamic-import",
    `
      const transport = await import(
        "https://streams.invalid/rooms/remote/module.js"
      );
      await transport.send();
    `,
  ),
  providerCase(
    "remote-static-import",
    `
      import { send } from "https://streams.invalid/rooms/remote/module.js";
      await send();
    `,
  ),
  violationCase(
    "raw-named-function-export",
    `
      export function rawNetwork() {
        return globalThis.fetch;
      }
    `,
    ["network-capability-export"],
    "public/application-api.js",
  ),
  violationCase(
    "raw-default-function-export",
    `
      export default function rawNetwork() {
        return globalThis.fetch;
      }
    `,
    ["network-capability-export"],
    "public/application-api.js",
  ),
  violationCase(
    "raw-assignment-export",
    `
      let rawNetwork;
      rawNetwork = globalThis.fetch;
      export { rawNetwork };
    `,
    ["network-capability-export"],
    "public/application-api.js",
  ),
  violationCase(
    "raw-class-getter-export",
    `
      export class RawNetwork {
        get fetch() {
          return globalThis.fetch;
        }
      }
    `,
    ["network-capability-export"],
    "public/application-api.js",
  ),
  violationCase(
    "raw-event-source-export",
    `
      export function rawEvents() {
        return globalThis.EventSource;
      }
    `,
    ["network-capability-export"],
    "public/application-api.js",
  ),
  violationCase(
    "inbound-dynamic-module",
    `
      const { request } = await import("node:http");
      request("http://streams.invalid");
    `,
    ["direct-provider-network"],
    "src/http-server.mjs",
  ),
  violationCase(
    "inbound-create-require",
    `
      import { createRequire } from "node:module";
      const load = createRequire(import.meta.url);
      load("node:http").request("http://streams.invalid");
    `,
    ["direct-provider-network"],
    "src/http-server.mjs",
  ),
  violationCase(
    "inbound-get-builtin-alias",
    `
      const load = process.getBuiltinModule;
      load("node:http").request("http://streams.invalid");
    `,
    ["direct-provider-network"],
    "src/http-server.mjs",
  ),
  allowCase(
    "inbound-create-server-only",
    `
      import { createServer } from "node:http";
      export function createInboundHttpServer(handler) {
        return createServer(handler);
      }
    `,
    "src/http-server.mjs",
  ),
]);

export const SOURCE_AUDIT_CASES = Object.freeze([
  ...INTERPROCEDURAL_SOURCE_AUDIT_CASES,
  ...NETWORK_DOOR_SOURCE_AUDIT_CASES,
  ...STATIC_DOOR_CONTRACT_SOURCE_AUDIT_CASES,
]);

function providerCase(name, source, filename) {
  return violationCase(name, source, ["direct-provider-network"], filename);
}

function allowCase(name, source, filename) {
  return Object.freeze({
    name,
    source,
    ...(filename ? { filename } : {}),
    expectedKinds: Object.freeze([]),
  });
}

function violationCase(name, source, expectedKinds, filename) {
  return Object.freeze({
    name,
    source,
    ...(filename ? { filename } : {}),
    expectedKinds: Object.freeze(expectedKinds),
  });
}
