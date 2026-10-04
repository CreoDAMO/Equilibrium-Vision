/**
 * Digest of the production output the process can see on disk.
 * The Nitro build date is removed. Absolute route paths and the content
 * hash in the TanStack start manifest are removed, because those name the
 * build machine rather than the program. The digest is not written back
 * into the output.
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

function normalize(rel: string, bytes: Buffer): { rel: string; bytes: Buffer } {
  if (rel === "nitro.json") {
    const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    delete parsed.date;
    return { rel, bytes: Buffer.from(canonical(parsed)) };
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

const READABLE = new Set([
  "nitro.json",
  "functions/__server.func/.vc-config.json",
  "functions/__server.func/index.mjs",
]);

/** Raw text of one output file. Only the three files that disagreed are readable. */
export function artifactFile(rel: string): string | null {
  if (!READABLE.has(rel)) return null;
  try {
    const root = findArtifactRoot();
    if (!root) return null;
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return null;
  }
}
