import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
import { logger } from "./logger.js";

// ── WebSocket event types ─────────────────────────────────────────────────────

export type WsEvent =
  | { type: "connected" }
  | { type: "ping" }
  | { type: "new_block"; data: NewBlockPayload }
  | { type: "mempool_update"; data: MempoolUpdatePayload };

export interface NewBlockPayload {
  height: number;
  hash: string;
  txCount: number;
  residual: number;
  miner: string;
  timestamp: number;
}

export interface MempoolUpdatePayload {
  size: number;
  pressure: number;
}

// ── Client registry ───────────────────────────────────────────────────────────

const clients = new Set<WebSocket>();

/** Broadcast an event to every connected WebSocket client. */
export function broadcast(event: WsEvent): void {
  if (clients.size === 0) return;
  const payload = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

// ── Server setup ──────────────────────────────────────────────────────────────

/** Attach a WebSocket server to an existing HTTP server at path `/ws`. */
export function createWsServer(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    clients.add(ws);
    logger.debug({ total: clients.size }, "WebSocket client connected");

    // Acknowledge the connection
    ws.send(JSON.stringify({ type: "connected" } satisfies WsEvent));

    ws.on("close", () => {
      clients.delete(ws);
      logger.debug({ total: clients.size }, "WebSocket client disconnected");
    });

    ws.on("error", (err: Error) => {
      logger.warn({ err: err.message }, "WebSocket client error");
      clients.delete(ws);
    });
  });

  // Keep-alive: ping all open clients every 30 s
  setInterval(() => {
    const payload = JSON.stringify({ type: "ping" } satisfies WsEvent);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }, 30_000);

  logger.info({ path: "/ws", clients: 0 }, "WebSocket server ready");
}
