/**
 * Digest of the production output the process can see on disk.
 * The Nitro build date, the Node major written into the Vercel runtime
 * field, the random lazy-handler id, absolute route paths, and the content
 * hash of those paths are removed. Those name the build machine. The digest
 * is not written back into the output.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

const MANIFEST = /_tanstack-start-manifest_v-[A-Za-z0-9_-]+\.mjs$/;

function machineFree(value: unknown): unknown {
  if (typeof value === "string") return /^nodejs\d+\.x$/.test(value) ? "nodejs" : value;
  if (Array.isArray(value)) return value.map((item) => machineFree(item));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === "date") continue;
      out[key] = machineFree(item);
    }
    return out;
  }
  return value;
}

function normalize(rel: string, bytes: Buffer): { rel: string; bytes: Buffer } {
  if (rel === "nitro.json" || rel.endsWith("/.vc-config.json")) {
    return { rel, bytes: Buffer.from(canonical(machineFree(JSON.parse(bytes.toString("utf8"))))) };
  }
  if (rel.endsWith("/__server.func/index.mjs")) {
    return { rel, bytes: Buffer.from(bytes.toString("utf8").replace(/_lazy_[A-Za-z0-9]+/g, "_lazy")) };
  }
  if (MANIFEST.test(rel) || rel.endsWith("/_ssr/ssr.mjs")) {
    const text = bytes
      .toString("utf8")
      .replace(/filePath: "(?:[^"]*\/)?(src\/routes\/[^"]+)"/g, 'filePath: "$1"')
      .replace(/_tanstack-start-manifest_v-[A-Za-z0-9_-]+/g, "_tanstack-start-manifest");
    const next = Buffer.from(text);
    if (MANIFEST.test(rel)) {
      return { rel: rel.replace(MANIFEST, "_tanstack-start-manifest.mjs"), bytes: next };
    }
    return { rel, bytes: next };
  }
  return { rel, bytes };
}

function filesOf(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else found.push(path);
    }
  };
  walk(root);
  return found.sort((a, b) => {
    const left = relative(root, a).split("\\").join("/");
    const right = relative(root, b).split("\\").join("/");
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** sha256 of the sorted `hash  path` lines. Null when the directory is absent. */
export function normalizedArtifactDigest(root: string): { digest: string; files: number; lines: string[] } | null {
  if (!existsSync(join(root, "nitro.json"))) return null;
  const lines: string[] = [];
  for (const path of filesOf(root)) {
    const raw = relative(root, path).split("\\").join("/");
    const { rel, bytes } = normalize(raw, readFileSync(path));
    const hash = createHash("sha256").update(bytes).digest("hex");
    lines.push(`${hash}  ${rel}`);
  }
  lines.sort();
  return {
    digest: createHash("sha256").update(lines.join("\n")).digest("hex"),
    files: lines.length,
    lines,
  };
}

/** The output directory this process was started with, if the build left one. */
export function findArtifactRoot(start = process.cwd()): string | null {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "nitro.json")) && existsSync(join(dir, "functions")) && existsSync(join(dir, "static"))) {
      return dir;
    }
    for (const rel of [".vercel/output", join("site", ".vercel", "output")]) {
      const candidate = join(dir, rel);
      if (existsSync(join(candidate, "nitro.json"))) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let cached: { digest: string; files: number; lines: string[] } | null | undefined;

/** One digest per process. A missing output is reported as null, not as a failure. */
export function artifactIdentity(): { digest: string; files: number; lines: string[] } | null {
  if (cached !== undefined) return cached;
  try {
    const root = findArtifactRoot();
    cached = root ? normalizedArtifactDigest(root) : null;
  } catch {
    cached = null;
  }
  return cached;
}
