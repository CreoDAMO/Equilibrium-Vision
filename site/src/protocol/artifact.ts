/**
 * Digest of the production output the process can see on disk.
 * `nitro.json`'s build date is removed. Every other byte is included.
 * The digest is not written back into the output, so it does not name itself.
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
export function normalizedArtifactDigest(root: string): { digest: string; files: number } | null {
  if (!existsSync(join(root, "nitro.json"))) return null;
  const lines: string[] = [];
  for (const path of filesOf(root)) {
    const rel = relative(root, path).split("\\").join("/");
    let bytes = readFileSync(path);
    if (rel === "nitro.json") {
      const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      delete parsed.date;
      bytes = Buffer.from(canonical(parsed));
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    lines.push(`${hash}  ${rel}`);
  }
  return {
    digest: createHash("sha256").update(lines.join("\n")).digest("hex"),
    files: lines.length,
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

let cached: { digest: string; files: number } | null | undefined;

/** One digest per process. A missing output is reported as null, not as a failure. */
export function artifactIdentity(): { digest: string; files: number } | null {
  if (cached !== undefined) return cached;
  try {
    const root = findArtifactRoot();
    cached = root ? normalizedArtifactDigest(root) : null;
  } catch {
    cached = null;
  }
  return cached;
}
