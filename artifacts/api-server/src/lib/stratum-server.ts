import net from "node:net";
import { logger } from "./logger.js";
import type { ChainState } from "../chain/state.js";

// ── Stratum v1 mining pool protocol ──────────────────────────────────────────
//
// Implements a subset of Stratum v1 sufficient for mobile miners:
//   mining.subscribe   — client registers and gets a session ID
//   mining.authorize   — client logs in with a worker name
//   mining.notify      — server pushes new work (sent after each block)
//   mining.submit      — client submits a solved block
//
// Clients connect over TCP on the configured port (default 3333).
// This implementation stores state in-memory; it is suitable for testnet only.

// ── Types ─────────────────────────────────────────────────────────────────────

interface StratumRequest {
  id: number | null;
  method: string;
  params: unknown[];
}

interface StratumResponse {
  id: number | null;
  result: unknown;
  error: null | [number, string, null];
}

interface MinerSession {
  socket:     net.Socket;
  sessionId:  string;
  worker:     string | null;
  authorized: boolean;
  extraNonce: string;
}

// ── Server ────────────────────────────────────────────────────────────────────

export class StratumServer {
  private server: net.Server;
  private sessions = new Map<string, MinerSession>();
  private jobId = 0;
  private chainState: ChainState | null = null;

  constructor(private readonly port: number = 3333) {
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  /** Attach to a ChainState so notify() can push real work. */
  attachChain(state: ChainState): void {
    this.chainState = state;
  }

  /** Start listening. */
  listen(): void {
    this.server.listen(this.port, () => {
      logger.info({ port: this.port, protocol: "stratum-v1" }, "Stratum mining pool listening");
    });
    this.server.on("error", (err) => {
      logger.error({ err }, "Stratum server error");
    });
  }

  /** Send new work to all connected, authorized miners. */
  notifyAll(): void {
    const job = this.buildJob();
    for (const session of this.sessions.values()) {
      if (session.authorized) this.send(session.socket, job);
    }
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────

  private onConnection(socket: net.Socket): void {
    const sessionId  = Math.random().toString(16).slice(2, 10);
    const extraNonce = Math.random().toString(16).slice(2, 10).padStart(8, "0");
    const session: MinerSession = { socket, sessionId, worker: null, authorized: false, extraNonce };
    this.sessions.set(sessionId, session);
    logger.debug({ sessionId, remote: socket.remoteAddress }, "Stratum client connected");

    let buffer = "";
    socket.setEncoding("utf8");

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) this.handleMessage(session, line.trim());
      }
    });

    socket.on("close", () => {
      this.sessions.delete(sessionId);
      logger.debug({ sessionId }, "Stratum client disconnected");
    });

    socket.on("error", (err) => {
      logger.warn({ sessionId, err: err.message }, "Stratum client error");
      this.sessions.delete(sessionId);
    });
  }

  // ── Message dispatch ──────────────────────────────────────────────────────

  private handleMessage(session: MinerSession, raw: string): void {
    let req: StratumRequest;
    try {
      req = JSON.parse(raw) as StratumRequest;
    } catch {
      return; // Ignore malformed frames
    }

    switch (req.method) {
      case "mining.subscribe":  this.onSubscribe(session, req);  break;
      case "mining.authorize":  this.onAuthorize(session, req);  break;
      case "mining.submit":     this.onSubmit(session, req);     break;
      default:
        this.respond(session.socket, req.id, null, [20, `Unknown method: ${req.method}`, null]);
    }
  }

  // ── Method handlers ───────────────────────────────────────────────────────

  private onSubscribe(session: MinerSession, req: StratumRequest): void {
    // result: [[["mining.set_difficulty","<id>"],["mining.notify","<id>"]], extraNonce1, extraNonce2Size]
    const result = [
      [["mining.set_difficulty", session.sessionId], ["mining.notify", session.sessionId]],
      session.extraNonce,
      4, // extraNonce2 size (bytes)
    ];
    this.respond(session.socket, req.id, result, null);
    // Push initial difficulty
    this.send(session.socket, { id: null, method: "mining.set_difficulty", params: [1e-7] });
  }

  private onAuthorize(session: MinerSession, req: StratumRequest): void {
    const [workerName] = req.params as [string, string];
    session.worker     = workerName ?? "anonymous";
    session.authorized = true;
    this.respond(session.socket, req.id, true, null);
    logger.info({ worker: session.worker, sessionId: session.sessionId }, "Stratum miner authorized");
    // Send current work immediately
    this.send(session.socket, this.buildJob());
  }

  private onSubmit(session: MinerSession, req: StratumRequest): void {
    if (!session.authorized) {
      this.respond(session.socket, req.id, false, [24, "Unauthorized", null]);
      return;
    }

    const [_worker, _jobId, _extraNonce2, _ntime, _nonce] = req.params as string[];
    // TODO: validate the submitted proof against the current job's prevHash + difficulty,
    //       then call chainState.addBlock(...) with the assembled block.
    logger.info({ worker: session.worker, job: _jobId }, "Stratum share received (validation pending)");
    this.respond(session.socket, req.id, true, null);
  }

  // ── Job builder ───────────────────────────────────────────────────────────

  private buildJob(): StratumRequest {
    const prev = this.chainState?.latestBlock;
    const jobIdHex = (++this.jobId).toString(16).padStart(8, "0");
    return {
      id: null,
      method: "mining.notify",
      params: [
        jobIdHex,                          // job_id
        prev?.hash ?? "0".repeat(64),      // prevhash
        "",                                // coinbase1
        "",                                // coinbase2
        [],                                // merkle_branch
        "00000001",                        // version
        "207fffff",                        // nbits (compact difficulty)
        Math.floor(Date.now() / 1000).toString(16), // ntime
        true,                              // clean_jobs
      ],
    };
  }

  // ── I/O helpers ───────────────────────────────────────────────────────────

  private respond(socket: net.Socket, id: number | null, result: unknown, error: StratumResponse["error"]): void {
    this.send(socket, { id, result, error });
  }

  private send(socket: net.Socket, msg: object): void {
    if (!socket.writable) return;
    socket.write(JSON.stringify(msg) + "\n");
  }
}
