/**
 * Render web service entry. Listens on $PORT (Render injects it).
 * Uses the same env wrapper as local preview so VITE_AUTH_ENABLED is set.
 * The grok live preview keeps using startup.sh → npm run dev on 8080.
 */
import { spawn } from "node:child_process";

const port = process.env.PORT || "10000";
const child = spawn(
  process.execPath,
  ["scripts/with-app-env.mjs", "vite", "preview", "--host", "0.0.0.0", "--port", port],
  { stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 1));
