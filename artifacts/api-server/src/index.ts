import http from "node:http";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { startMining, chainState } from "./chain/index.js";
import { createWsServer } from "./lib/ws-server.js";
import { StratumServer } from "./lib/stratum-server.js";

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
