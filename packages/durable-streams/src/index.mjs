import {
  DurableStream,
  DurableStreamError,
  FetchError,
  StreamClosedError,
  stream as openStream,
} from "@durable-streams/client";

import { normalizeRoomId } from "@stream-slack/protocol";
import { materializeMessages } from "@stream-slack/reducers";

const JSON_CONTENT_TYPE = "application/json";
const MAX_CHECKPOINT_BYTES = 512;
const PROTOCOL_ERROR_HEADER = "x-stream-slack-protocol-error";
const RETRY_AFTER_HTTP_DATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/u;
const HTTP_MONTHS = new Map(
  [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ].map((month, index) => [month, index]),
);
const HTTP_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DEFAULT_BACKOFF = Object.freeze({
  initialDelay: 25,
  maxDelay: 1_000,
  multiplier: 2,
  maxRetries: 4,
});

export class DurableStreamsAdapterError extends Error {
  constructor(message, { code, status, finalOffset, cause } = {}) {
    super(message, { cause });
    this.name = "DurableStreamsAdapterError";
    this.code = code ?? "UNKNOWN";
    this.status = status;
    this.finalOffset = finalOffset;
  }
}

export function createDurableStreamsStore({
  baseUrl,
  token,
  fetchFn,
  digestRecords,
  backoffOptions = DEFAULT_BACKOFF,
}) {
  const origin = normalizeBaseUrl(baseUrl);
  const configuredOrigin = new URL(origin).origin;
  if (typeof token !== "string" || token.length === 0) {
    throw new TypeError("Durable Streams administration token is required");
  }
  if (typeof fetchFn !== "function") {
    throw new TypeError("Durable Streams fetch capability is required");
  }
  if (typeof digestRecords !== "function") {
    throw new TypeError("Durable Streams digest function is required");
  }

  const entries = new Map();
  const metrics = {
    appendCalls: 0,
    boundedReads: 0,
    createRequests: 0,
    ensureCalls: 0,
    followCalls: 0,
    requests: 0,
    requestsByMethod: Object.create(null),
    responsesByStatus: Object.create(null),
    sseRequests: 0,
    longPollRequests: 0,
  };
  let nextFollowerId = 1;
  let closed = false;

  function streamUrl(roomId) {
    const room = encodeURIComponent(normalizeRoomId(roomId));
    return `${origin}/rooms/${room}/messages`;
  }

  function entryFor(roomId) {
    assertOpen();
    const room = normalizeRoomId(roomId);
    let entry = entries.get(room);
    if (entry) return entry;

    entry = {
      room,
      ready: null,
      writeTail: Promise.resolve(),
      appendOffset: null,
      followers: new Map(),
      gate: createWakeGate(),
    };
    const instrumentedFetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.origin !== configuredOrigin) {
        throw new DurableStreamsAdapterError(
          "Durable Streams client attempted a request outside its configured origin",
          { code: "ORIGIN_VIOLATION" },
        );
      }

      const method = String(init.method ?? "GET").toUpperCase();
      metrics.requests += 1;
      increment(metrics.requestsByMethod, method);
      if (method === "PUT") metrics.createRequests += 1;
      if (url.searchParams.get("live") === "sse") metrics.sseRequests += 1;
      if (url.searchParams.get("live") === "long-poll") {
        metrics.longPollRequests += 1;
      }

      let response = await fetchFn(input, { ...init, redirect: "manual" });
      increment(metrics.responsesByStatus, String(response.status));
      await validateResponseOrigin({
        configuredOrigin,
        requestUrl: url,
        response,
      });
      if (!response.ok) {
        try {
          validateRetryAfter(response);
        } catch (error) {
          if (!(error instanceof DurableStreamsAdapterError)) throw error;
          await discardResponse(response);
          return protocolErrorResponse(error);
        }
      }
      if (response.ok) {
        try {
          await validateSuccessfulResponse({ method, response, url });
        } catch (error) {
          if (!(error instanceof DurableStreamsAdapterError)) throw error;
          if (method === "HEAD") throw error;
          return protocolErrorResponse(error);
        }
        if (method === "POST") {
          entry.appendOffset = requireCheckpoint(
            response.headers.get("Stream-Next-Offset"),
            "append response",
          );
        }
        if (method === "GET" && url.searchParams.get("live") === "sse") {
          response = strictSseResponse(response);
        }
      }
      return response;
    };

    entry.handle = new DurableStream({
      url: streamUrl(room),
      headers: { Authorization: `Bearer ${token}` },
      contentType: JSON_CONTENT_TYPE,
      fetch: instrumentedFetch,
      backoffOptions,
      batching: false,
      warnOnHttp: false,
    });
    entry.streamOptions = Object.freeze({
      url: streamUrl(room),
      headers: { Authorization: `Bearer ${token}` },
      fetch: instrumentedFetch,
      backoffOptions,
      warnOnHttp: false,
    });
    entries.set(room, entry);
    return entry;
  }

  async function ensure(roomId) {
    metrics.ensureCalls += 1;
    const entry = entryFor(roomId);
    if (!entry.ready) {
      entry.ready = (async () => {
        const metadata = await entry.handle.head();
        if (!metadata.exists) {
          try {
            await entry.handle.create({
              contentType: JSON_CONTENT_TYPE,
              body: "[]",
            });
          } catch (error) {
            if (!isCreateConflict(error)) throw error;
            const racedMetadata = await entry.handle.head();
            if (!racedMetadata.exists) throw error;
          }
        }
        return entry.handle;
      })().catch((error) => {
        entry.ready = null;
        throw asAdapterError(
          error,
          `Failed to ensure stream for ${entry.room}`,
        );
      });
    }
    return entry.ready;
  }

  async function read(roomId, offset = "-1", { signal } = {}) {
    metrics.boundedReads += 1;
    const checkpoint = requireCheckpoint(offset, "read checkpoint");
    const entry = entryFor(roomId);
    await ensure(entry.room);
    let response;
    try {
      response = await openStream({
        ...entry.streamOptions,
        offset: checkpoint,
        live: false,
        signal,
      });
      const records = await response.json();
      const nextOffset = requireCheckpoint(
        response.offset,
        "bounded read response",
      );
      if (!response.upToDate) {
        throw new DurableStreamsAdapterError(
          `Bounded read for ${entry.room} ended before reaching the stream head`,
          { code: "INCOMPLETE_READ" },
        );
      }
      return {
        records,
        messages: materializeMessages(records),
        nextOffset,
        streamDigest: digestRecords(records),
      };
    } catch (error) {
      response?.cancel(error);
      throw asAdapterError(error, `Failed to read stream for ${entry.room}`, {
        signal,
      });
    }
  }

  async function append(roomId, record, { signal } = {}) {
    metrics.appendCalls += 1;
    const entry = entryFor(roomId);
    return serializeWrite(entry, async () => {
      const handle = await ensure(entry.room);
      entry.appendOffset = null;
      try {
        await handle.append(JSON.stringify(record), {
          contentType: JSON_CONTENT_TYPE,
          signal,
        });
        const nextOffset = requireCheckpoint(
          entry.appendOffset,
          "append response",
        );
        entry.gate.wake("append");
        return { message: record, nextOffset };
      } catch (error) {
        throw asAdapterError(
          error,
          `Failed to append stream for ${entry.room}`,
          {
            signal,
          },
        );
      }
    });
  }

  async function follow(
    roomId,
    offset,
    { onBatch, signal, live = "sse" } = {},
  ) {
    metrics.followCalls += 1;
    if (typeof onBatch !== "function") {
      throw new TypeError(
        "Durable Streams follow requires an onBatch callback",
      );
    }
    if (live !== "sse" && live !== "long-poll") {
      throw new TypeError(
        'Durable Streams follow live mode must be "sse" or "long-poll"',
      );
    }

    const startOffset = requireCheckpoint(offset, "follow checkpoint");
    const entry = entryFor(roomId);
    await ensure(entry.room);
    const controller = new AbortController();
    const followerId = nextFollowerId;
    nextFollowerId += 1;
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });

    let response;
    let unsubscribe = () => {};
    let cancelled = false;
    let firstBatch = true;
    const inFlightRequests = new Set();
    const followFetch = (input, init = {}) => {
      if (controller.signal.aborted) {
        return Promise.reject(abortError(controller.signal.reason));
      }
      const request = instrumentedFollowRequest(
        entry.streamOptions.fetch,
        input,
        init,
        controller.signal,
      );
      inFlightRequests.add(request);
      request.finally(() => inFlightRequests.delete(request)).catch(() => {});
      return request;
    };
    const drainRequests = async () => {
      while (inFlightRequests.size > 0) {
        await Promise.allSettled([...inFlightRequests]);
      }
    };

    const cancel = (reason = "follow cancelled") => {
      if (cancelled) return;
      cancelled = true;
      controller.abort(reason);
      entry.gate.wake(reason);
      unsubscribe();
    };

    entry.followers.set(followerId, { cancel });
    try {
      response = await openStream({
        ...entry.streamOptions,
        fetch: followFetch,
        offset: startOffset,
        live,
        signal: controller.signal,
        sseResilience: {
          minConnectionDuration: 0,
          maxShortConnections: 3,
          backoffBaseDelay: 25,
          backoffMaxDelay: 250,
          logWarnings: false,
        },
      });
      unsubscribe = response.subscribeJson(async (batch) => {
        const observedWake = entry.gate.version;
        const nextOffset = requireCheckpoint(batch.offset, "follow response");
        await onBatch({
          records: [...batch.items],
          nextOffset,
          upToDate: batch.upToDate,
          streamClosed: batch.streamClosed,
        });

        if (firstBatch) {
          firstBatch = false;
          return;
        }
        if (
          (batch.items.length > 0 || batch.upToDate) &&
          !batch.streamClosed &&
          (entry.appendOffset === null || entry.appendOffset === nextOffset) &&
          !controller.signal.aborted
        ) {
          await entry.gate.wait(observedWake, controller.signal);
        }
      });
    } catch (error) {
      controller.abort(error);
      await drainRequests();
      entry.followers.delete(followerId);
      signal?.removeEventListener("abort", abortFromCaller);
      throw asAdapterError(error, `Failed to follow stream for ${entry.room}`, {
        signal: controller.signal,
      });
    }

    const closedPromise = response.closed
      .catch((error) => {
        if (controller.signal.aborted) return;
        throw asAdapterError(error, `Live stream failed for ${entry.room}`);
      })
      .finally(async () => {
        await drainRequests();
        entry.followers.delete(followerId);
        signal?.removeEventListener("abort", abortFromCaller);
      });
    closedPromise.catch(() => {});

    return Object.freeze({
      startOffset,
      get currentOffset() {
        return requireCheckpoint(response.offset, "live stream checkpoint");
      },
      cancel,
      closed: closedPromise,
    });
  }

  async function remove(roomId, { signal } = {}) {
    const entry = entryFor(roomId);
    for (const follower of [...entry.followers.values()]) {
      follower.cancel("stream removed");
    }
    entry.gate.wake("stream removed");
    try {
      await entry.handle.delete({ signal });
    } catch (error) {
      if (!isNotFound(error)) {
        throw asAdapterError(
          error,
          `Failed to delete stream for ${entry.room}`,
          {
            signal,
          },
        );
      }
    } finally {
      entries.delete(entry.room);
    }
  }

  function diagnostics() {
    let activeFollowers = 0;
    let pendingIdleWaiters = 0;
    for (const entry of entries.values()) {
      activeFollowers += entry.followers.size;
      pendingIdleWaiters += entry.gate.waiterCount;
    }
    return Object.freeze({
      ...metrics,
      activeFollowers,
      pendingIdleWaiters,
      cachedStreams: entries.size,
      requestsByMethod: { ...metrics.requestsByMethod },
      responsesByStatus: { ...metrics.responsesByStatus },
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const entry of entries.values()) {
      for (const follower of [...entry.followers.values()]) {
        follower.cancel("adapter closed");
      }
      entry.gate.wake("adapter closed");
    }
    entries.clear();
  }

  function assertOpen() {
    if (closed) {
      throw new DurableStreamsAdapterError(
        "Durable Streams adapter is closed",
        {
          code: "ADAPTER_CLOSED",
        },
      );
    }
  }

  return Object.freeze({
    append,
    close,
    diagnostics,
    ensure,
    follow,
    read,
    remove,
  });
}

async function validateSuccessfulResponse({ method, response, url }) {
  const live = url.searchParams.get("live");
  const contentType = mediaType(response.headers.get("content-type"));
  if (method === "GET" && live === "sse") {
    if (contentType !== "text/event-stream") {
      await discardResponse(response);
      throw new DurableStreamsAdapterError(
        `Durable Streams SSE response used unexpected content type ${contentType || "<missing>"}`,
        { code: "CONTENT_TYPE_MISMATCH", status: response.status },
      );
    }
    return;
  }

  if (method === "GET" && response.status !== 204) {
    if (contentType !== JSON_CONTENT_TYPE) {
      await discardResponse(response);
      throw new DurableStreamsAdapterError(
        `Durable Streams JSON response used unexpected content type ${contentType || "<missing>"}`,
        { code: "CONTENT_TYPE_MISMATCH", status: response.status },
      );
    }
  }

  if (["GET", "HEAD", "POST", "PUT"].includes(method)) {
    requireCheckpoint(
      response.headers.get("Stream-Next-Offset"),
      `${method} response`,
    );
  }
}

function validateRetryAfter(response) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter === null) return;
  if (/^\d+$/u.test(retryAfter)) {
    const seconds = Number(retryAfter);
    if (Number.isSafeInteger(seconds)) return;
  } else if (isCanonicalHttpDate(retryAfter)) {
    return;
  }
  throw new DurableStreamsAdapterError(
    "Durable Streams response used a malformed Retry-After header",
    { code: "INVALID_RETRY_AFTER", status: response.status },
  );
}

function isCanonicalHttpDate(value) {
  const match = RETRY_AFTER_HTTP_DATE.exec(value);
  if (!match) return false;
  const [
    ,
    weekday,
    dayText,
    monthText,
    yearText,
    hourText,
    minuteText,
    secondText,
  ] = match;
  const day = Number(dayText);
  const month = HTTP_MONTHS.get(monthText);
  const year = Number(yearText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month === undefined || hour > 23 || minute > 59 || second > 59) {
    return false;
  }

  const parsed = new Date(0);
  parsed.setUTCHours(hour, minute, second, 0);
  parsed.setUTCFullYear(year, month, day);
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month &&
    parsed.getUTCDate() === day &&
    parsed.getUTCHours() === hour &&
    parsed.getUTCMinutes() === minute &&
    parsed.getUTCSeconds() === second &&
    HTTP_WEEKDAYS[parsed.getUTCDay()] === weekday
  );
}

async function validateResponseOrigin({
  configuredOrigin,
  requestUrl,
  response,
}) {
  if (response.url) {
    const responseUrl = new URL(response.url, requestUrl);
    if (responseUrl.origin !== configuredOrigin) {
      await discardResponse(response);
      throw new DurableStreamsAdapterError(
        "Durable Streams client received a response outside its configured origin",
        { code: "ORIGIN_VIOLATION", status: response.status },
      );
    }
  }

  if (response.status < 300 || response.status > 399) return;
  const location = response.headers.get("location");
  let redirectUrl;
  try {
    redirectUrl = location ? new URL(location, requestUrl) : null;
  } catch {
    await discardResponse(response);
    throw new DurableStreamsAdapterError(
      "Durable Streams response used a malformed redirect location",
      { code: "INVALID_REDIRECT", status: response.status },
    );
  }
  await discardResponse(response);
  if (redirectUrl && redirectUrl.origin !== configuredOrigin) {
    throw new DurableStreamsAdapterError(
      "Durable Streams client refused a redirect outside its configured origin",
      { code: "ORIGIN_VIOLATION", status: response.status },
    );
  }
  throw new DurableStreamsAdapterError(
    "Durable Streams client refused an unexpected provider redirect",
    { code: "UNEXPECTED_REDIRECT", status: response.status },
  );
}

function protocolErrorResponse(error) {
  return new Response(
    JSON.stringify({
      kind: "stream-slack-protocol",
      code: error.code,
      message: error.message,
      status: error.status,
    }),
    {
      status: 400,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        [PROTOCOL_ERROR_HEADER]: error.code,
      },
    },
  );
}

function createWakeGate() {
  let version = 0;
  const waiters = new Set();
  return {
    get version() {
      return version;
    },
    get waiterCount() {
      return waiters.size;
    },
    wait(observedVersion, signal) {
      if (version !== observedVersion || signal.aborted)
        return Promise.resolve();
      return new Promise((resolve) => {
        const waiter = () => {
          signal.removeEventListener("abort", waiter);
          waiters.delete(waiter);
          resolve();
        };
        waiters.add(waiter);
        signal.addEventListener("abort", waiter, { once: true });
        if (version !== observedVersion) waiter();
      });
    },
    wake() {
      version += 1;
      for (const waiter of [...waiters]) waiter();
    },
  };
}

function serializeWrite(entry, operation) {
  const result = entry.writeTail.then(operation, operation);
  entry.writeTail = result.catch(() => {});
  return result;
}

function instrumentedFollowRequest(fetchFn, input, init, signal) {
  const requestSignal = init.signal
    ? AbortSignal.any([signal, init.signal])
    : signal;
  return fetchFn(input, { ...init, signal: requestSignal });
}

function abortError(reason) {
  return new DOMException(String(reason ?? "cancelled"), "AbortError");
}

function requireCheckpoint(value, context) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_CHECKPOINT_BYTES ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw new DurableStreamsAdapterError(
      `Durable Streams ${context} did not provide a valid opaque checkpoint`,
      { code: "INVALID_CHECKPOINT" },
    );
  }
  return value;
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value));
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new TypeError("Durable Streams URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new TypeError("Durable Streams URL must not embed credentials");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

function mediaType(value) {
  return String(value ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

async function discardResponse(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The caller still receives the typed protocol error below.
  }
}

function strictSseResponse(response) {
  if (!response.body) {
    throw new DurableStreamsAdapterError(
      "Durable Streams SSE response did not provide a response body",
      { code: "MALFORMED_SSE_FRAME", status: response.status },
    );
  }
  const decoder = new TextDecoder();
  let pending = "";
  const body = response.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        pending = trailingSseFragment(pending);
        controller.enqueue(chunk);
      },
      flush() {
        pending += decoder.decode();
        if (pending.trim().length > 0) {
          throw new DurableStreamsAdapterError(
            "Durable Streams SSE response ended with a partial frame",
            { code: "MALFORMED_SSE_FRAME", status: response.status },
          );
        }
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function trailingSseFragment(value) {
  let boundary = -1;
  const pattern = /\r?\n\r?\n/gu;
  for (const match of value.matchAll(pattern)) {
    boundary = match.index + match[0].length;
  }
  return boundary === -1 ? value : value.slice(boundary);
}

function increment(record, key) {
  record[key] = (record[key] ?? 0) + 1;
}

function isDurableError(error, code) {
  return error instanceof DurableStreamError && error.code === code;
}

function isCreateConflict(error) {
  return (
    isDurableError(error, "CONFLICT_EXISTS") ||
    (error instanceof FetchError && error.status === 409)
  );
}

function isNotFound(error) {
  return (
    isDurableError(error, "NOT_FOUND") ||
    (error instanceof FetchError && error.status === 404)
  );
}

function asAdapterError(error, message, { signal } = {}) {
  if (error instanceof DurableStreamsAdapterError) return error;
  if (signal?.aborted || error?.name === "AbortError") {
    return new DurableStreamsAdapterError(message, {
      code: "CANCELLED",
      cause: error,
    });
  }
  if (error instanceof StreamClosedError) {
    return new DurableStreamsAdapterError(message, {
      code: "STREAM_CLOSED",
      status: error.status,
      finalOffset: error.finalOffset,
      cause: error,
    });
  }
  if (error instanceof FetchError) {
    const protocolCode = error.headers[PROTOCOL_ERROR_HEADER];
    if (protocolCode) {
      const protocol = protocolErrorDetails(error.json);
      return new DurableStreamsAdapterError(
        protocol?.message ?? error.text ?? message,
        {
          code: protocolCode,
          status: protocolStatus(protocol, error.status),
          cause: error,
        },
      );
    }
    if (
      error.status === 409 &&
      error.headers["stream-closed"]?.toLowerCase() === "true"
    ) {
      return new DurableStreamsAdapterError(message, {
        code: "STREAM_CLOSED",
        status: error.status,
        finalOffset: error.headers["stream-next-offset"],
        cause: error,
      });
    }
    const durableError = DurableStreamError.fromFetchError(error);
    return new DurableStreamsAdapterError(message, {
      code: durableError.code,
      status: durableError.status,
      cause: error,
    });
  }
  if (error instanceof DurableStreamError) {
    const protocol = protocolErrorDetails(error.details);
    if (protocol) {
      return new DurableStreamsAdapterError(protocol.message, {
        code: protocol.code,
        status: protocolStatus(protocol, error.status),
        cause: error,
      });
    }
    return new DurableStreamsAdapterError(message, {
      code: error.code,
      status: error.status,
      cause: error,
    });
  }
  return new DurableStreamsAdapterError(message, { cause: error });
}

function protocolErrorDetails(value) {
  if (
    value &&
    typeof value === "object" &&
    value.kind === "stream-slack-protocol" &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  ) {
    return value;
  }
  return null;
}

function protocolStatus(protocol, fallback) {
  return Number.isInteger(protocol?.status) &&
    protocol.status >= 100 &&
    protocol.status <= 599
    ? protocol.status
    : fallback;
}
