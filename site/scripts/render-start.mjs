/**
 * Render web service entry. Listens on $PORT.
 *
 * Do not spawn the bare command `vite`. Render's start environment has no
 * node_modules/.bin on PATH, which is the "spawn vite ENOENT" failure.
 * Invoke the installed binary with this node process.
 *
 * The grok live preview keeps using startup.sh → npm run dev on 8080.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = String(process.env.PORT || "10000");
const viteJs = join(root, "node_modules", "vite", "bin", "vite.js");

function appEnv() {
  try {
    const parsed = JSON.parse(readFileSync(join(root, ".grok", "app-env.json"), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const env = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!key.startsWith("VITE_") || typeof value !== "string") continue;
      if (process.env[key] !== undefined) continue;
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

if (!existsSync(viteJs)) {
  console.error(
    `[render-start] ${viteJs} is missing. The build must install devDependencies (npm install --include=dev) before vite preview can serve the Nitro output.`,
  );
  process.exit(1);
}

const child = spawn(process.execPath, [viteJs, "preview", "--host", "0.0.0.0", "--port", port], {
  stdio: "inherit",
  cwd: root,
  env: {
    ...process.env,
    ...appEnv(),
    PORT: port,
    // In-memory PGLite measured ~470 MB on top of the server and does not
    // survive a restart. The starter instance is 512 MB, so loading it gets
    // the process killed on the first health check. Real Postgres still wins
    // when DATABASE_URL is set.
    EQ_PGLITE: "0",
  },
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (err) => {
  console.error("[render-start] failed to start vite preview:", err?.message || err);
  process.exit(127);
});
child.on("exit", (code) => process.exit(code ?? 1));
