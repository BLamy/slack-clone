import { createServer } from "node:http";

export function createInboundHttpServer(handler) {
  if (typeof handler !== "function") {
    throw new TypeError("Inbound HTTP handler must be a function");
  }
  return createServer(handler);
}
