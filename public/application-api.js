const API_PREFIX = "/api/";

export function resolveApplicationApiPath(
  value,
  origin = globalThis.location?.origin,
) {
  if (typeof origin !== "string" || origin.length === 0) {
    throw new TypeError("Application API origin is required");
  }
  const base = new URL(origin);
  const target = new URL(String(value), `${base.origin}/`);
  if (
    target.origin !== base.origin ||
    !target.pathname.startsWith(API_PREFIX) ||
    target.username ||
    target.password ||
    target.hash
  ) {
    throw new TypeError(
      "Application API requests must stay on same-origin /api/",
    );
  }
  return `${target.pathname}${target.search}`;
}

export function applicationApiFetch(pathname, init = {}) {
  return globalThis.fetch(resolveApplicationApiPath(pathname), {
    ...init,
    credentials: "same-origin",
    redirect: "error",
  });
}

export function applicationApiEvents(pathname) {
  return new globalThis.EventSource(resolveApplicationApiPath(pathname), {
    withCredentials: true,
  });
}
