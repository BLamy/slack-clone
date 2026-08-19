import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  readdir,
  lstat,
  rename,
  rm,
  symlink,
  writeFile,
  chmod,
} from "node:fs/promises";
import path from "node:path";

import {
  CLOUDFLARE_OS_ERROR_CODES,
  CloudflareOsProviderError,
  cloudflareOsError,
} from "../errors.mjs";
import {
  canonical,
  normalizeManifest,
  normalizePath,
  workspaceDigest,
} from "./manifest.mjs";

const VERSION = /^version-sha256-([0-9a-f]{64})$/u;

export class WorkspaceMaterializer {
  #publicationPath;
  #parent;
  #baseName;
  #limits;

  constructor({ publicationPath, limits } = {}) {
    if (
      typeof publicationPath !== "string" ||
      !path.isAbsolute(publicationPath)
    )
      throw new TypeError("publicationPath must be absolute");
    this.#publicationPath = publicationPath;
    this.#parent = path.dirname(publicationPath);
    this.#baseName = path.basename(publicationPath);
    this.#limits = limits;
  }

  async currentDigest() {
    let target;
    try {
      target = await readlink(this.#publicationPath);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw publishError("published workspace pointer is not a symlink");
    }
    const match = VERSION.exec(path.basename(target));
    if (!match)
      throw publishError("published workspace pointer has an invalid digest");
    return `sha256:${match[1]}`;
  }

  async materialize(manifest, { expectedDigest, fault } = {}) {
    const normalized = normalizeManifest(manifest, this.#limits);
    const digest = workspaceDigest(normalized);
    if (expectedDigest !== undefined && expectedDigest !== digest)
      throw cloudflareOsError(
        CLOUDFLARE_OS_ERROR_CODES.WORKSPACE_DIGEST_MISMATCH,
        "workspace manifest digest does not match the invocation expectation",
        { operation: "materialize" },
      );
    await mkdir(this.#parent, { recursive: true });
    const versions = path.join(this.#parent, `.${this.#baseName}.versions`);
    await mkdir(versions, { recursive: true });
    const stage = await mkdtemp(path.join(versions, ".staging-"));
    const versionName = `version-${digest.replace(":", "-")}`;
    const versionPath = path.join(versions, versionName);
    const linkPath = path.join(
      this.#parent,
      `.${this.#baseName}.next-${path.basename(stage)}`,
    );
    let published = false;
    try {
      await boundary(fault, "manifest-validated", { digest, stage });
      for (const entry of normalized.entries) {
        const target = path.join(stage, ...entry.path.split("/"));
        if (entry.type === "directory") {
          await mkdir(target, { recursive: true, mode: entry.mode });
          await chmod(target, entry.mode);
        } else {
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, entry.bytes, {
            mode: entry.mode,
            flag: "wx",
          });
          await chmod(target, entry.mode);
        }
        await boundary(fault, "entry-written", {
          digest,
          stage,
          entry: entry.path,
        });
      }
      const transferred = await snapshotManifest(stage, this.#limits);
      if (workspaceDigest(transferred) !== digest)
        throw cloudflareOsError(
          CLOUDFLARE_OS_ERROR_CODES.WORKSPACE_DIGEST_MISMATCH,
          "transferred workspace bytes do not match the manifest digest",
          { operation: "materialize" },
        );
      await boundary(fault, "before-publish", { digest, stage });
      try {
        await lstat(versionPath);
        await rm(stage, { recursive: true, force: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await rename(stage, versionPath);
      }
      await symlink(path.relative(this.#parent, versionPath), linkPath, "dir");
      await rename(linkPath, this.#publicationPath);
      published = true;
      await boundary(fault, "after-publish", { digest, stage: versionPath });
      return {
        digest,
        entries: normalized.entries.length,
        totalBytes: normalized.totalBytes,
        publicationPath: this.#publicationPath,
      };
    } finally {
      if (!published) await rm(stage, { recursive: true, force: true });
      await rm(linkPath, { force: true });
    }
  }

  async snapshot() {
    const pointerDigest = await this.currentDigest();
    if (pointerDigest === null) return null;
    let snapshot;
    try {
      snapshot = await snapshotManifest(this.#publicationPath, this.#limits);
    } catch (error) {
      if (error instanceof CloudflareOsProviderError) throw error;
      throw workspaceIntegrityError();
    }
    if (workspaceDigest(snapshot) !== pointerDigest)
      throw workspaceIntegrityError();
    return snapshot;
  }

  async assertExecutionReady(expectedDigest) {
    const snapshot = await this.snapshot();
    const actualDigest = snapshot === null ? null : workspaceDigest(snapshot);
    if (actualDigest !== expectedDigest)
      throw cloudflareOsError(
        CLOUDFLARE_OS_ERROR_CODES.WORKSPACE_DIGEST_MISMATCH,
        "execution is blocked until the published workspace matches the invocation digest",
        { operation: "exec" },
      );
    return { digest: actualDigest, ready: true };
  }
}

export async function snapshotManifest(directory, limits) {
  const entries = [];
  await walk(directory, "", entries);
  return normalizeManifest({ schemaVersion: 1, entries }, limits);
}

export async function comparePublishedTrees(left, right, limits) {
  const first = await snapshotManifest(left, limits);
  const second = await snapshotManifest(right, limits);
  return {
    equal: canonical(first) === canonical(second),
    leftDigest: workspaceDigest(first),
    rightDigest: workspaceDigest(second),
  };
}

async function walk(directory, prefix, entries) {
  const children = await readdir(path.join(directory, prefix), {
    withFileTypes: true,
  });
  for (const child of children.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const relative = normalizePath(
      prefix ? `${prefix}/${child.name}` : child.name,
    );
    const target = path.join(directory, relative);
    const info = await lstat(target);
    if (info.isSymbolicLink() || child.isSymbolicLink())
      throw publishError("published workspace contains a symlink");
    if (info.isDirectory()) {
      entries.push({
        path: relative,
        type: "directory",
        mode: info.mode & 0o7777,
      });
      await walk(directory, relative, entries);
    } else if (info.isFile()) {
      entries.push({
        path: relative,
        type: "file",
        mode: info.mode & 0o7777,
        bytes: new Uint8Array(await readFile(target)),
      });
    } else {
      throw publishError("published workspace contains a non-regular entry");
    }
  }
}

async function boundary(fault, name, details) {
  if (typeof fault === "function") await fault(name, details);
}

function publishError(detail) {
  return cloudflareOsError(CLOUDFLARE_OS_ERROR_CODES.PUBLISH_FAILED, detail, {
    operation: "publish",
  });
}

function workspaceIntegrityError() {
  return cloudflareOsError(
    CLOUDFLARE_OS_ERROR_CODES.WORKSPACE_DIGEST_MISMATCH,
    "published workspace bytes do not match the content-addressed pointer",
    { operation: "publish" },
  );
}
