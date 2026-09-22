/**
 * Nitro traces the PGLite JS but not the sibling data/wasm files it reads
 * from disk. Copy them next to the bundled module so preview and Vercel can boot.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "node_modules/@electric-sql/pglite/dist");
const outDir = join(root, ".vercel/output/functions/__server.func/_libs");
const names = ["pglite.data", "pglite.wasm", "initdb.wasm"];

if (!existsSync(outDir)) {
  console.log("[pglite] no nitro lib dir, skip");
  process.exit(0);
}
mkdirSync(outDir, { recursive: true });
for (const name of names) {
  const from = join(srcDir, name);
  if (!existsSync(from)) {
    console.error("[pglite] missing", from);
    process.exit(1);
  }
  copyFileSync(from, join(outDir, name));
}
const bundled = readdirSync(outDir).some((f) => f.includes("pglite"));
console.log("[pglite] copied data/wasm", bundled ? "next to bundle" : "(bundle name not seen)");
