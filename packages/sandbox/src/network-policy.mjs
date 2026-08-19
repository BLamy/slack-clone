import { createHash } from "node:crypto";

import { SANDBOX_ERROR_CODES, sandboxError } from "./errors.mjs";

const ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const PURPOSE = /^[A-Za-z0-9._:-]{1,96}$/u;
const SCHEMES = Object.freeze(["http", "https"]);
const ADDRESS_CLASSES = Object.freeze([
  "public",
  "private",
  "loopback",
  "link-local",
  "metadata",
  "shared",
  "multicast",
  "unspecified",
  "reserved",
  "unknown",
]);
const DENIED_ADDRESS_CLASSES = new Set(
  ADDRESS_CLASSES.filter((value) => value !== "public"),
);
const METADATA_HOSTS = new Set([
  "169.254.169.254",
  "100.100.100.200",
  "fd00:ec2::254",
  "metadata",
  "metadata.google.internal",
  "instance-data.ec2.internal",
  "instance-data",
]);
const DEFAULT_POLICY_VALUE = Object.freeze({
  schemaVersion: 1,
  defaultEgress: "deny",
  defaultInbound: "deny",
  allow: Object.freeze([]),
  inbound: Object.freeze([]),
});

export const NETWORK_POLICY_ERROR_CODES = Object.freeze({
  INVALID_POLICY: "SANDBOX_NETWORK_POLICY_INVALID",
  DENIED: "SANDBOX_NETWORK_DENIED",
  RESOLUTION_DENIED: "SANDBOX_NETWORK_RESOLUTION_DENIED",
  REDIRECT_DENIED: "SANDBOX_NETWORK_REDIRECT_DENIED",
  INBOUND_DENIED: "SANDBOX_NETWORK_INBOUND_DENIED",
});

export const DEFAULT_NETWORK_POLICY = DEFAULT_POLICY_VALUE;

export function compileNetworkPolicy(input = DEFAULT_NETWORK_POLICY) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    policyInvalid("network policy must be an object");
  if (input.schemaVersion !== 1)
    policyInvalid("network policy schemaVersion must be 1");
  if (input.defaultEgress !== undefined && input.defaultEgress !== "deny")
    policyInvalid("network policy defaultEgress must be deny");
  if (input.defaultInbound !== undefined && input.defaultInbound !== "deny")
    policyInvalid("network policy defaultInbound must be deny");
  const allow = normalizeAllowRules(input.allow ?? []);
  const inbound = normalizeInboundRules(input.inbound ?? []);
  const value = {
    schemaVersion: 1,
    defaultEgress: "deny",
    defaultInbound: "deny",
    allow,
    inbound,
  };
  return Object.freeze({
    ...value,
    allow: Object.freeze(allow),
    inbound: Object.freeze(inbound),
    digest: policyDigest(value),
  });
}

export class NetworkPolicyEvaluator {
  #policy;
  #decisionLog;
  #evaluationCounter = 0;

  constructor({ policy = DEFAULT_NETWORK_POLICY, decisionLog = null } = {}) {
    this.#policy = compileNetworkPolicy(policy);
    if (
      decisionLog !== null &&
      (!decisionLog || typeof decisionLog.append !== "function")
    )
      throw new TypeError("decisionLog must expose append");
    this.#decisionLog = decisionLog;
  }

  get policy() {
    return this.#policy;
  }

  async evaluateEgress({
    tenantId,
    runId,
    url,
    purpose,
    resolve,
    redirects = [],
    headers = undefined,
    body = undefined,
    proxyEnv = undefined,
    requestId = undefined,
  } = {}) {
    assertScope(tenantId, runId, purpose);
    if (typeof resolve !== "function")
      return this.#record(
        deniedDecision({
          tenantId,
          runId,
          purpose,
          url,
          reasonCode: "resolver_required",
          requestId: this.#nextEvaluationId(requestId),
        }),
      );
    if (hasProxyConfiguration(proxyEnv))
      return this.#record(
        deniedDecision({
          tenantId,
          runId,
          purpose,
          url,
          reasonCode: "proxy_bypass_denied",
          requestId: this.#nextEvaluationId(requestId),
        }),
      );
    const evaluationId = this.#nextEvaluationId(requestId);
    const hops = [url, ...normalizeRedirects(redirects)];
    const decisions = [];
    for (let index = 0; index < hops.length; index += 1) {
      const decision = await this.#evaluateHop({
        tenantId,
        runId,
        purpose,
        target: hops[index],
        resolve,
        redirect: index > 0,
        requestId: `${evaluationId}:hop:${index}`,
        headers,
        body,
      });
      decisions.push(decision);
      if (!decision.allowed)
        return {
          allowed: false,
          event: decision.event,
          decisions,
          hops: index + 1,
        };
    }
    return {
      allowed: true,
      event: decisions.at(-1).event,
      decisions,
      hops: decisions.length,
    };
  }

  async evaluateSocket({
    tenantId,
    runId,
    host,
    port,
    purpose,
    resolve,
    requestId,
  } = {}) {
    const scheme = port === 443 ? "https" : "http";
    return this.evaluateEgress({
      tenantId,
      runId,
      url: `${scheme}://${formatHost(host)}:${port}/`,
      purpose,
      resolve,
      requestId,
    });
  }

  evaluateInbound({
    tenantId,
    runId,
    host = "127.0.0.1",
    port,
    purpose,
    sidecarId = undefined,
    sourceAddress = "127.0.0.1",
    requestId = undefined,
  } = {}) {
    assertScope(tenantId, runId, purpose);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
      policyInvalid("inbound port is invalid");
    const normalizedHost = normalizeHost(host);
    const source = classifyHost(sourceAddress);
    const rule = this.#policy.inbound.find(
      (candidate) =>
        candidate.port === port &&
        candidate.purpose === purpose &&
        candidate.sidecarId === sidecarId &&
        source.addressClass === "loopback",
    );
    const event = {
      schemaVersion: 1,
      decisionId: decisionId({
        tenantId,
        runId,
        purpose,
        direction: "inbound",
        host: normalizedHost,
        port,
        requestId: this.#nextEvaluationId(requestId),
      }),
      tenantId,
      runId,
      direction: "inbound",
      purpose,
      ruleId: rule?.id ?? null,
      destination: { host: normalizedHost, port },
      outcome: rule ? "allow" : "deny",
      reasonCode: rule
        ? "explicit_sidecar"
        : source.addressClass !== "loopback"
          ? "inbound_source_denied"
          : "inbound_default_deny",
    };
    return this.#record({ allowed: Boolean(rule), event, decisions: [event] });
  }

  async #evaluateHop({
    tenantId,
    runId,
    purpose,
    target,
    resolve,
    redirect,
    requestId,
    headers,
    body,
  }) {
    const destination = normalizeDestination(target, purpose);
    const base = {
      tenantId,
      runId,
      purpose,
      url: target,
      requestId,
    };
    if (!SCHEMES.includes(destination.scheme))
      return this.#record(
        deniedDecision({
          ...base,
          reasonCode: redirect ? "redirect_scheme_denied" : "scheme_denied",
        }),
      );
    const rule = this.#policy.allow.find(
      (candidate) =>
        candidate.scheme === destination.scheme &&
        candidate.host === destination.host &&
        candidate.port === destination.port &&
        candidate.purpose === purpose,
    );
    if (!rule)
      return this.#record(
        deniedDecision({
          ...base,
          reasonCode: redirect ? "redirect_not_allowlisted" : "not_allowlisted",
        }),
      );
    let result;
    try {
      result = await resolve(destination.host);
    } catch {
      return this.#record(
        deniedDecision({
          ...base,
          reasonCode: "dns_resolution_failed",
          ruleId: rule.id,
        }),
      );
    }
    const addresses = normalizeResolvedAddresses(result?.addresses ?? result);
    const aliases = normalizeAliases(result?.aliases ?? result?.cname ?? []);
    const aliasClass = aliases.map((alias) => classifyHost(alias));
    if (aliasClass.some(({ addressClass }) => addressClass !== "public"))
      return this.#record(
        deniedDecision({
          ...base,
          reasonCode: "cname_denied",
          ruleId: rule.id,
        }),
      );
    if (addresses.length === 0)
      return this.#record(
        deniedDecision({
          ...base,
          reasonCode: "dns_empty",
          ruleId: rule.id,
        }),
      );
    const classes = addresses.map((address) => classifyAddress(address));
    const denied = classes.find(({ addressClass }) =>
      DENIED_ADDRESS_CLASSES.has(addressClass),
    );
    if (denied)
      return this.#record(
        deniedDecision({
          ...base,
          reasonCode:
            denied.addressClass === "metadata"
              ? "metadata_denied"
              : "address_class_denied",
          ruleId: rule.id,
          addressClass: denied.addressClass,
        }),
      );
    if (
      classes.some(
        ({ addressClass }) => !rule.addressClasses.includes(addressClass),
      )
    )
      return this.#record(
        deniedDecision({
          ...base,
          reasonCode: "address_class_not_allowlisted",
          ruleId: rule.id,
          addressClass: classes[0].addressClass,
        }),
      );
    if (
      rule.addresses.length > 0 &&
      addresses.some(
        (address) => !rule.addresses.includes(normalizeAddress(address)),
      )
    )
      return this.#record(
        deniedDecision({
          ...base,
          reasonCode: "address_not_allowlisted",
          ruleId: rule.id,
          addressClass: classes[0].addressClass,
        }),
      );
    return this.#record({
      allowed: true,
      event: {
        ...allowedDecision({
          ...base,
          ruleId: rule.id,
          addressClass: classes[0].addressClass,
        }),
        resolutionGeneration: result?.generation ?? 0,
        requestPayloadPresent: headers !== undefined || body !== undefined,
      },
      decisions: [],
    });
  }

  #record(result) {
    this.#decisionLog?.append(result.event);
    return result;
  }

  #nextEvaluationId(requestId) {
    this.#evaluationCounter += 1;
    return requestId ?? `evaluation-${this.#evaluationCounter}`;
  }
}

export class NetworkDecisionLog {
  #events = [];

  append(event) {
    if (!event || typeof event !== "object" || Array.isArray(event))
      policyInvalid("network decision must be an object");
    const redacted = redactDecision(event);
    this.#events.push(redacted);
    return structuredClone(redacted);
  }

  events() {
    return structuredClone(this.#events);
  }

  digest() {
    return `sha256:${createHash("sha256").update(canonical(this.#events)).digest("hex")}`;
  }
}

export function normalizeHost(host) {
  if (typeof host !== "string" || host.length === 0 || /\s/gu.test(host))
    policyInvalid("host is invalid");
  let value = host.toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  if (value.endsWith(".")) value = value.slice(0, -1);
  if (value.length === 0 || value.includes("%"))
    policyInvalid("host is invalid");
  const parsed = parseAddress(value);
  if (parsed) return parsed.normalized;
  if (value.includes("/") || value.includes("?") || value.includes("#"))
    policyInvalid("host is invalid");
  try {
    const normalized = new URL(`https://${value}/`).hostname
      .toLowerCase()
      .replace(/^\[|\]$/gu, "")
      .replace(/\.$/u, "");
    if (
      normalized.length === 0 ||
      normalized.includes("*") ||
      normalized
        .split(".")
        .some((label) => label.length === 0 || label.length > 63)
    )
      policyInvalid("host is invalid");
    return normalized;
  } catch {
    policyInvalid("host is invalid");
  }
}

export function normalizeAddress(address) {
  const parsed = parseAddress(address);
  if (!parsed) policyInvalid("resolved address is invalid");
  return parsed.normalized;
}

export function classifyAddress(address) {
  const parsed = parseAddress(address);
  if (!parsed)
    return { normalized: normalizeHost(address), addressClass: "unknown" };
  const addressClass = classifyParsedAddress(parsed);
  return { normalized: parsed.normalized, addressClass };
}

function normalizeAllowRules(value) {
  if (!Array.isArray(value) || value.length > 64)
    policyInvalid("network allow rules are invalid");
  const ids = new Set();
  return value
    .map((rule, index) => {
      if (!rule || typeof rule !== "object" || Array.isArray(rule))
        policyInvalid(`network allow rule ${index} is invalid`);
      const id = normalizeId(rule.id, `allow[${index}].id`);
      if (ids.has(id)) policyInvalid("network rule ids must be unique");
      ids.add(id);
      if (!SCHEMES.includes(rule.scheme))
        policyInvalid("network rule scheme is invalid");
      const host = normalizeHost(rule.host);
      if (classifyHost(host).addressClass !== "public")
        policyInvalid("network rule host is not public");
      const port = normalizePort(rule.port);
      const purpose = normalizePurpose(rule.purpose);
      if (
        !Array.isArray(rule.addressClasses) ||
        rule.addressClasses.length === 0
      )
        policyInvalid("network rule addressClasses are required");
      const addressClasses = [...new Set(rule.addressClasses)];
      if (
        addressClasses.some(
          (addressClass) => !ADDRESS_CLASSES.includes(addressClass),
        )
      )
        policyInvalid("network rule addressClasses are invalid");
      if (
        addressClasses.some((addressClass) =>
          DENIED_ADDRESS_CLASSES.has(addressClass),
        )
      )
        policyInvalid("network rules may not allow private address classes");
      const addresses = rule.addresses ?? [];
      if (!Array.isArray(addresses) || addresses.length > 32)
        policyInvalid("network rule addresses are invalid");
      const normalizedAddresses = [...new Set(addresses.map(normalizeAddress))];
      if (
        normalizedAddresses.some(
          (address) => classifyAddress(address).addressClass !== "public",
        )
      )
        policyInvalid("network rules may not allow private addresses");
      return {
        id,
        scheme: rule.scheme,
        host,
        port,
        purpose,
        addressClasses: addressClasses.sort(),
        addresses: normalizedAddresses.sort(),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeInboundRules(value) {
  if (!Array.isArray(value) || value.length > 32)
    policyInvalid("network inbound rules are invalid");
  const ids = new Set();
  return value
    .map((rule, index) => {
      if (!rule || typeof rule !== "object" || Array.isArray(rule))
        policyInvalid(`network inbound rule ${index} is invalid`);
      const id = normalizeId(rule.id, `inbound[${index}].id`);
      if (ids.has(id)) policyInvalid("network rule ids must be unique");
      ids.add(id);
      const sidecarId = normalizeId(
        rule.sidecarId,
        `inbound[${index}].sidecarId`,
      );
      return {
        id,
        sidecarId,
        port: normalizePort(rule.port),
        purpose: normalizePurpose(rule.purpose),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeDestination(value, purpose) {
  if (typeof value !== "string") policyInvalid("destination URL is required");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    policyInvalid("destination URL is invalid");
  }
  if (parsed.username || parsed.password)
    policyInvalid("destination credentials are not allowed");
  return {
    scheme: parsed.protocol.slice(0, -1).toLowerCase(),
    host: normalizeHost(parsed.hostname),
    port:
      parsed.port === ""
        ? parsed.protocol === "https:"
          ? 443
          : 80
        : normalizePort(Number(parsed.port)),
    purpose: normalizePurpose(purpose),
  };
}

function normalizeResolvedAddresses(value) {
  if (!Array.isArray(value) || value.length > 32)
    policyInvalid("DNS resolver returned invalid addresses");
  return [...new Set(value.map(normalizeAddress))];
}

function normalizeAliases(value) {
  if (!Array.isArray(value) || value.length > 16)
    policyInvalid("DNS resolver returned invalid aliases");
  return [...new Set(value.map(normalizeHost))];
}

function normalizeRedirects(value) {
  if (!Array.isArray(value) || value.length > 8)
    policyInvalid("redirect chain is invalid");
  return value.map((entry) => (typeof entry === "string" ? entry : entry?.url));
}

function deniedDecision({
  tenantId,
  runId,
  purpose,
  url,
  reasonCode,
  ruleId = null,
  addressClass = null,
  requestId,
}) {
  return {
    allowed: false,
    event: {
      ...baseDecision({
        tenantId,
        runId,
        purpose,
        url,
        requestId,
        direction: "egress",
      }),
      ruleId,
      outcome: "deny",
      reasonCode,
      ...(addressClass === null ? {} : { addressClass }),
    },
    decisions: [],
  };
}

function allowedDecision({
  tenantId,
  runId,
  purpose,
  url,
  requestId,
  ruleId,
  addressClass,
}) {
  return {
    ...baseDecision({
      tenantId,
      runId,
      purpose,
      url,
      requestId,
      direction: "egress",
    }),
    ruleId,
    outcome: "allow",
    reasonCode: "allowlisted",
    addressClass,
  };
}

function baseDecision({ tenantId, runId, purpose, url, requestId, direction }) {
  const destination =
    direction === "egress"
      ? normalizeDestination(url, purpose)
      : { host: "127.0.0.1", port: 0 };
  return {
    schemaVersion: 1,
    decisionId: decisionId({
      tenantId,
      runId,
      purpose,
      direction,
      destination,
      requestId,
    }),
    tenantId,
    runId,
    direction,
    purpose,
    destination: {
      ...(direction === "egress"
        ? {
            scheme: destination.scheme,
            host: destination.host,
            port: destination.port,
          }
        : destination),
    },
  };
}

function redactDecision(event) {
  const allowedKeys = new Set([
    "schemaVersion",
    "decisionId",
    "tenantId",
    "runId",
    "direction",
    "purpose",
    "ruleId",
    "destination",
    "outcome",
    "reasonCode",
    "addressClass",
    "resolutionGeneration",
  ]);
  const result = {};
  for (const key of allowedKeys) {
    if (event[key] !== undefined) result[key] = structuredClone(event[key]);
  }
  return result;
}

function assertScope(tenantId, runId, purpose) {
  normalizeId(tenantId, "tenantId");
  normalizeId(runId, "runId");
  normalizePurpose(purpose);
}

function normalizeId(value, path) {
  if (typeof value !== "string" || !ID.test(value))
    policyInvalid(`${path} is invalid`);
  return value;
}

function normalizePurpose(value) {
  if (typeof value !== "string" || !PURPOSE.test(value))
    policyInvalid("network purpose is invalid");
  return value;
}

function normalizePort(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535)
    policyInvalid("network port is invalid");
  return value;
}

function hasProxyConfiguration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ].some((key) => value[key] !== undefined && value[key] !== "");
}

function classifyHost(host) {
  const normalized = normalizeHost(host);
  const parsed = parseAddress(normalized);
  if (parsed)
    return { normalized, addressClass: classifyParsedAddress(parsed) };
  if (METADATA_HOSTS.has(normalized))
    return { normalized, addressClass: "metadata" };
  if (normalized === "localhost" || normalized.endsWith(".localhost"))
    return { normalized, addressClass: "loopback" };
  if (normalized.endsWith(".internal") || normalized.endsWith(".local"))
    return { normalized, addressClass: "private" };
  return { normalized, addressClass: "public" };
}

function parseAddress(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const raw =
    value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  const ipv4 = parseIPv4(raw);
  if (ipv4)
    return { kind: "ipv4", normalized: ipv4.normalized, octets: ipv4.octets };
  const ipv6 = parseIPv6(raw);
  if (ipv6)
    return { kind: "ipv6", normalized: ipv6.normalized, words: ipv6.words };
  return null;
}

function parseIPv4(value) {
  const parts = value.split(".");
  if (parts.length !== 4 && parts.length !== 1) return null;
  if (
    parts.length === 1 &&
    !/^(?:0x[0-9a-f]+|0[0-7]+|[0-9]+)$/iu.test(parts[0])
  )
    return null;
  if (parts.length === 1) {
    const number = parseNumericPart(parts[0]);
    if (number === null || number > 0xffffffff) return null;
    const octets = [
      number >>> 24,
      (number >>> 16) & 255,
      (number >>> 8) & 255,
      number & 255,
    ];
    return { normalized: octets.join("."), octets };
  }
  const octets = parts.map(parseNumericPart);
  if (octets.some((part) => part === null || part > 255)) return null;
  return { normalized: octets.join("."), octets };
}

function parseNumericPart(value) {
  if (!/^(?:0x[0-9a-f]+|0[0-7]+|[0-9]+)$/iu.test(value)) return null;
  const radix = /^0x/iu.test(value) ? 16 : /^0[0-7]+$/u.test(value) ? 8 : 10;
  const parsed = Number.parseInt(value, radix);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseIPv6(value) {
  if (!value.includes(":")) return null;
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = parseIPv6Words(halves[0]);
  const right = parseIPv6Words(halves[1] ?? "");
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  )
    return null;
  const words = [
    ...left,
    ...Array.from({ length: missing }, () => 0),
    ...right,
  ];
  return { words, normalized: formatIPv6(words) };
}

function parseIPv6Words(value) {
  if (value === "") return [];
  const parts = value.split(":");
  const words = [];
  for (const part of parts) {
    if (part.includes(".")) {
      const ipv4 = parseIPv4(part);
      if (!ipv4 || words.length + 2 > 8) return null;
      words.push((ipv4.octets[0] << 8) | ipv4.octets[1]);
      words.push((ipv4.octets[2] << 8) | ipv4.octets[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/iu.test(part)) return null;
    words.push(Number.parseInt(part, 16));
  }
  return words;
}

function formatIPv6(words) {
  const pieces = words.map((word) => word.toString(16));
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < pieces.length; index += 1) {
    if (pieces[index] !== "0") continue;
    let end = index;
    while (end < pieces.length && pieces[end] === "0") end += 1;
    if (end - index > bestLength) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end - 1;
  }
  if (bestLength < 2) return pieces.join(":");
  const left = pieces.slice(0, bestStart).join(":");
  const right = pieces.slice(bestStart + bestLength).join(":");
  return `${left}::${right}`;
}

function classifyParsedAddress(parsed) {
  if (
    parsed.kind === "ipv6" &&
    parsed.words.slice(0, 5).every((word) => word === 0) &&
    parsed.words[5] === 0xffff
  ) {
    const octets = [
      parsed.words[6] >> 8,
      parsed.words[6] & 255,
      parsed.words[7] >> 8,
      parsed.words[7] & 255,
    ];
    return classifyParsedAddress({
      kind: "ipv4",
      normalized: octets.join("."),
      octets,
    });
  }
  if (parsed.kind === "ipv4") {
    const [first, second] = parsed.octets;
    if (
      parsed.normalized === "169.254.169.254" ||
      parsed.normalized === "100.100.100.200"
    )
      return "metadata";
    if (first === 0) return "unspecified";
    if (first === 127) return "loopback";
    if (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    )
      return "private";
    if (first === 169 && second === 254) return "link-local";
    if (first === 100 && second >= 64 && second <= 127) return "shared";
    if (first >= 224) return first >= 240 ? "reserved" : "multicast";
    if (
      (first === 192 && second === 0) ||
      (first === 198 && second >= 18 && second <= 19)
    )
      return "reserved";
    return "public";
  }
  const first = parsed.words[0];
  if (parsed.normalized === "fd00:ec2::254") return "metadata";
  if (parsed.words.every((word) => word === 0)) return "unspecified";
  if (parsed.normalized === "::1") return "loopback";
  if ((first & 0xfe00) === 0xfc00) return "private";
  if ((first & 0xffc0) === 0xfe80) return "link-local";
  if ((first & 0xff00) === 0xff00) return "multicast";
  if (first === 0x2001 && parsed.words[1] === 0x0db8) return "reserved";
  return "public";
}

function formatHost(host) {
  const normalized = normalizeHost(host);
  return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function policyDigest(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function decisionId({
  tenantId,
  runId,
  purpose,
  direction,
  destination,
  requestId,
}) {
  return `nd_${createHash("sha256")
    .update(
      canonical({
        tenantId,
        runId,
        purpose,
        direction,
        destination,
        requestId: requestId ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 24)}`;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function policyInvalid(detail) {
  throw sandboxError(SANDBOX_ERROR_CODES.NETWORK_POLICY_INVALID, detail);
}
