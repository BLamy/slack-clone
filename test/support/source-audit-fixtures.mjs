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
      const streamUrl = "/api/rooms/interprocedural/messages";
      await globalThis.fetch(streamUrl);
    `,
  ),
  allowCase(
    "application-api-conditional",
    `
      const target = Math.random() > -1
        ? "/api/rooms/interprocedural/messages"
        : "/api/rooms/interprocedural/events";
      await globalThis.fetch(target);
    `,
  ),
  allowCase(
    "application-api-wrapper-options",
    `
      const invoke = (callable, target, init) => callable(target, init);
      await invoke(globalThis.fetch, "/api/rooms/interprocedural/messages", {
        method: "POST",
      });
    `,
  ),
  allowCase(
    "partially-bound-application-api",
    `
      function invoke(callable, target) { return callable(target); }
      const send = invoke.bind(
        null,
        globalThis.fetch,
        "/api/rooms/interprocedural/messages",
      );
      await send();
    `,
  ),
  allowCase(
    "returned-application-api-target",
    `
      const target = () => "/api/rooms/interprocedural/messages";
      await globalThis.fetch(target());
    `,
  ),
]);

function providerCase(name, source) {
  return Object.freeze({
    name,
    source,
    expectedKinds: Object.freeze(["direct-provider-network"]),
  });
}

function allowCase(name, source) {
  return Object.freeze({
    name,
    source,
    expectedKinds: Object.freeze([]),
  });
}
