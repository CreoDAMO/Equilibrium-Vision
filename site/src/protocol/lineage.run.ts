/**
 * S7 observation. Not G, and not an APK.
 * Local wasm bytes are compared with the embedded bytes.
 * The live host is this commit only when /api/light names both.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDED_WASM } from "./deployment";

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(dirname(dirname(here)));

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const wasmPath = join(here, "arbitrage.wasm");
const wasmFile = sha256(wasmPath);
const wasmAgain = sha256(wasmPath);
assert.equal(wasmFile, wasmAgain);
assert.equal(wasmFile, EMBEDDED_WASM);

const status = execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" });
const commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const locks = {
  site: existsSync(join(repo, "site/package-lock.json")) ? sha256(join(repo, "site/package-lock.json")) : null,
  workspace: existsSync(join(repo, "pnpm-lock.yaml")) ? sha256(join(repo, "pnpm-lock.yaml")) : null,
};

let live: { status: number; commit: string | null; wasm: string | null; artifact: string | null; artifactFiles: number | null; error?: string } = {
  status: 0,
  commit: null,
  wasm: null,
  artifact: null,
  artifactFiles: null,
};
try {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  const response = await fetch("https://equilibrium-vision.onrender.com/api/light", { signal: ctrl.signal });
  clearTimeout(timer);
  const body = await response.json() as { deployment?: { commit?: string | null; wasm?: string | null; artifact?: string | null; artifactFiles?: number | null } };
  live = {
    status: response.status,
    commit: body.deployment?.commit ?? null,
    wasm: body.deployment?.wasm ?? null,
    artifact: body.deployment?.artifact ?? null,
    artifactFiles: body.deployment?.artifactFiles ?? null,
  };
} catch (error) {
  live = { status: 0, commit: null, wasm: null, artifact: null, artifactFiles: null, error: error instanceof Error ? error.message : "unreachable" };
}

const commitBound = live.commit === commit;
const artifactBound = live.artifact === "d03a27e330026c63d349b3f63ecd15bb95dfb0821b89ce5a2b44c9b0fe0af849";
const wasmBound = live.wasm === wasmFile;

console.log(JSON.stringify({
  ok: true,
  s7: {
    candidate: commit,
    clean: status.trim() === "",
    wasmFile,
    wasmEmbedded: EMBEDDED_WASM,
    fileEqualsEmbedded: wasmFile === EMBEDDED_WASM,
    locks,
    node: process.version,
    build: "not run. The protocol runner does not invoke vite or db:migrate. Those are not the wasm bytes G executes.",
    live,
    commitBound,
    wasmBound,
    artifactBound,
    bound: commitBound && wasmBound && artifactBound,
    level: artifactBound
      ? "The live output digest matches the independent build. The build date, the Node major, the random handler id, and absolute route paths are not part of that digest."
      : "Local file bytes equal the embedded bytes. The live output digest does not match the independent build.",
  },
}));
