import { createHash } from "node:crypto";

import { CLOUDFLARE_OS_ERROR_CODES, cloudflareOsError } from "../errors.mjs";

const PATH_SEGMENT = /^[^/\\\0]+$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MAX_MODE = 0o7777;
const DEFAULT_LIMITS = Object.freeze({
  maxEntryBytes: 4 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxCompressionRatio: 100,
});

export function normalizeManifest(manifest, limits = {}) {
  const options = { ...DEFAULT_LIMITS, ...limits };
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    invalidTree("manifest must be an object");
  if (manifest.schemaVersion !== 1)
    invalidTree("manifest schemaVersion is unsupported");
  if (
    manifest.invocationDigest !== undefined &&
    !DIGEST.test(manifest.invocationDigest)
  )
    invalidTree("manifest invocationDigest is invalid");
  if (!Array.isArray(manifest.entries))
    invalidTree("manifest entries must be an array");

  const entries = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const source of manifest.entries) {
    if (!source || typeof source !== "object" || Array.isArray(source))
      invalidTree("manifest entry must be an object");
    const path = normalizePath(source.path);
    if (seen.has(path)) pathRejected("manifest contains duplicate paths");
    seen.add(path);
    const type = source.type;
    if (type !== "file" && type !== "directory")
      archiveRejected(`manifest entry type is not allowed: ${String(type)}`);
    const mode = normalizeMode(source.mode, type);
    if (type === "directory") {
      if (source.content !== undefined || source.bytes !== undefined)
        invalidTree("directory entry cannot contain file bytes");
      entries.push({ path, type, mode });
      continue;
    }
    const bytes = decodeBytes(source);
    if (bytes.byteLength > options.maxEntryBytes)
      archiveRejected("manifest entry exceeds the per-entry byte limit");
    totalBytes += bytes.byteLength;
    if (totalBytes > options.maxTotalBytes)
      archiveRejected("manifest exceeds the total byte limit");
    entries.push({ path, type, mode, bytes });
  }
  const expanded = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const parentPath = parts.slice(0, index).join("/");
      const existing = expanded.get(parentPath);
      if (existing?.type === "file")
        pathRejected("file entry cannot also be a directory parent");
      if (!existing)
        expanded.set(parentPath, {
          path: parentPath,
          type: "directory",
          mode: 0o755,
        });
    }
  }
  const completeEntries = [...expanded.values()];
  completeEntries.sort((left, right) => compareUtf8(left.path, right.path));
  rejectPathConflicts(completeEntries);
  return Object.freeze({
    schemaVersion: 1,
    ...(manifest.invocationDigest === undefined
      ? {}
      : { invocationDigest: manifest.invocationDigest }),
    entries: Object.freeze(
      completeEntries.map((entry) => Object.freeze(entry)),
    ),
    totalBytes,
  });
}

export function validateArchiveEntries(entries, limits = {}) {
  if (!Array.isArray(entries))
    archiveRejected("archive entries must be an array");
  const options = { ...DEFAULT_LIMITS, ...limits };
  const manifestEntries = entries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      archiveRejected("archive entry must be an object");
    const compressed = entry.compressedBytes;
    const uncompressed = entry.uncompressedBytes;
    if (compressed !== undefined || uncompressed !== undefined) {
      if (
        !Number.isSafeInteger(compressed) ||
        compressed < 1 ||
        !Number.isSafeInteger(uncompressed) ||
        uncompressed < 0
      )
        archiveRejected("archive compression sizes are invalid");
      if (uncompressed > compressed * options.maxCompressionRatio)
        archiveRejected("archive decompression ratio exceeds the limit");
    }
    if (
      ["symlink", "hardlink", "device", "fifo", "socket", "special"].includes(
        entry.type,
      )
    )
      archiveRejected(`archive entry type is not allowed: ${entry.type}`);
    return entry;
  });
  return normalizeManifest(
    { schemaVersion: 1, entries: manifestEntries },
    options,
  );
}

export function workspaceDigest(manifest) {
  const normalized = normalizeManifest(manifest);
  const records = normalized.entries.map((entry) => ({
    mode: entry.mode,
    path: entry.path,
    size: entry.bytes?.byteLength ?? 0,
    type: entry.type,
    ...(entry.bytes === undefined
      ? {}
      : { contentDigest: sha256Bytes(entry.bytes) }),
  }));
  return `sha256:${sha256Text(canonical({ schemaVersion: 1, entries: records }))}`;
}

export function canonical(value) {
  if (value instanceof Uint8Array)
    return JSON.stringify(Buffer.from(value).toString("base64"));
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizePath(value) {
  if (typeof value !== "string" || value.length === 0)
    pathRejected("path is required");
  if (value !== value.normalize("NFC"))
    pathRejected("path is not NFC-normalized");
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0"))
    pathRejected("path must be a relative POSIX path");
  if (/^[A-Za-z]:/u.test(value))
    pathRejected("drive-qualified paths are not allowed");
  const parts = value.split("/");
  if (
    parts.some(
      (part) => !PATH_SEGMENT.test(part) || part === "." || part === "..",
    )
  )
    pathRejected("path contains an unsafe segment");
  return value;
}

function decodeBytes(source) {
  if (source.bytes instanceof Uint8Array) return new Uint8Array(source.bytes);
  if (typeof source.bytes === "string") {
    try {
      return Uint8Array.from(Buffer.from(source.bytes, "base64"));
    } catch {
      invalidTree("file bytes are not valid base64");
    }
  }
  if (typeof source.content === "string")
    return new TextEncoder().encode(source.content);
  invalidTree("file entry requires content or base64 bytes");
}

function normalizeMode(mode, type) {
  const normalized = mode ?? (type === "directory" ? 0o755 : 0o644);
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 0 ||
    normalized > MAX_MODE
  )
    invalidTree("entry mode is invalid");
  return normalized;
}

function rejectPathConflicts(entries) {
  const paths = new Set(entries.map((entry) => entry.path));
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const parentPath = parts.slice(0, index).join("/");
      const parentEntry = entries.find(
        (candidate) => candidate.path === parentPath,
      );
      if (parentEntry?.type === "file")
        pathRejected("file entry cannot also be a directory parent");
      if (!paths.has(parentPath) && entry.type === "directory") continue;
    }
  }
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function invalidTree(detail) {
  throw cloudflareOsError(CLOUDFLARE_OS_ERROR_CODES.INVALID_TREE, detail, {
    operation: "manifest",
  });
}

function pathRejected(detail) {
  throw cloudflareOsError(CLOUDFLARE_OS_ERROR_CODES.PATH_REJECTED, detail, {
    operation: "manifest",
  });
}

function archiveRejected(detail) {
  throw cloudflareOsError(CLOUDFLARE_OS_ERROR_CODES.ARCHIVE_REJECTED, detail, {
    operation: "archive",
  });
}
