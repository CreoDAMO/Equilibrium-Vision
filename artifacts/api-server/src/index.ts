import http from "node:http";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { initChain, startMining, chainState } from "./chain/index.js";
import { createWsServer } from "./lib/ws-server.js";
import { StratumServer } from "./lib/stratum-server.js";
import { closeWorkers } from "./variational-ai/bridge.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Initialise chain (load from Postgres or build genesis), then start the server.
(async () => {
  await initChain();

  // Wrap Express in a plain HTTP server so we can attach the WebSocket upgrade
  const server = http.createServer(app);
  createWsServer(server);

  server.listen(port, () => {
    logger.info({ port }, "Server listening");
    startMining();

    // Stratum mining pool — enabled when STRATUM_PORT is set (default: off)
    const stratumPort = Number(process.env["STRATUM_PORT"] ?? 0);
    if (stratumPort > 0) {
      const stratum = new StratumServer(stratumPort);
      stratum.attachChain(chainState);
      stratum.listen();
    }
  });

  server.on("error", (err) => {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  });

  // Graceful shutdown — close long-lived Rust worker processes cleanly.
  const shutdown = () => {
    closeWorkers();
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT",  shutdown);
})().catch((err) => {
  // Ensure fatal init errors are visible and crash the process cleanly.
  console.error("Fatal startup error:", err);
  process.exit(1);
});
