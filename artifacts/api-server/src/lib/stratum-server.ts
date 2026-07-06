import net from "node:net";
import { randomBytes } from "node:crypto";
import { logger } from "./logger.js";
import { broadcast } from "./ws-server.js";
import { merkleRoot, hash256 } from "../chain/crypto.js";
import { generateZkProof } from "../chain/zkproof.js";
import { persistBlock } from "../chain/persistence.js";
import type { TxRecord } from "../chain/types.js";
import type { ChainState } from "../chain/state.js";
import { RateLimiter, ReplaySet } from "./submission-guard.js";

// Residual must be below this threshold for a submitted share to count as a
// valid block — same constant used by the /blocks/submit HTTP route.
const RESIDUAL_THRESHOLD = 1e-7;
const BASE_REWARD        = 50_000_000;

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
  // Maps jobIdHex → the chain-tip hash that was current when the job was sent.
  // Used to reject submissions against stale work (tip has advanced).
  private activeJobs = new Map<string, string>();
  private static readonly MAX_ACTIVE_JOBS = 64; // bounded ring-buffer size

  // ── Submission guards ─────────────────────────────────────────────────────

  /**
   * Per-worker-address rate limit: 6 shares per 10 seconds.
   * Keyed by miner address so reconnecting with a new TCP session doesn't
   * reset the counter.  Background pruning runs every 10 s.
   */
  private submitRateLimit = new RateLimiter(6, 10_000).startPruning();

  /**
   * Duplicate-share detection keyed by "<jobId>:<nonce>:<extraNonce2>".
   * Prevents the same solution being credited twice (e.g. double-send on
   * reconnect or intentional replay).  Capacity 1 024 is well above any
   * realistic share burst across all connected miners.
   */
  private recentShares = new ReplaySet(1024);

  /**
   * Maximum seconds the miner-submitted ntime may deviate from server time.
   * 7 200 s (2 hours) matches the standard Bitcoin/Stratum ntime tolerance.
   */
  private static readonly NTIME_DRIFT_LIMIT = 7200;

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
    const sessionId  = randomBytes(4).toString("hex");
    const extraNonce = randomBytes(4).toString("hex");
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

    // Params: [worker, jobId, extraNonce2, ntime, nonce, residual]
    // residual is an Equilibrium-specific extension to standard Stratum v1:
    // the Lagrangian residual the mobile solver computed (float as string).
    const [workerParam, jobId, extraNonce2, ntimeHex, nonceHex, residualStr] = req.params as string[];

    // ── Validate the job is known and not stale ─────────────────────────────
    const jobTipHash = this.activeJobs.get(jobId);
    if (!jobTipHash) {
      this.respond(session.socket, req.id, false, [21, `Unknown job: ${jobId}`, null]);
      return;
    }

    // ── Resolve chain state ─────────────────────────────────────────────────
    const cs = this.chainState;
    if (!cs) {
      this.respond(session.socket, req.id, false, [20, "Chain not initialised", null]);
      return;
    }
    const prev = cs.latestBlock;
    if (!prev) {
      this.respond(session.socket, req.id, false, [20, "Chain not initialised", null]);
      return;
    }

    // Reject stale work — the chain tip advanced since this job was issued.
    if (prev.hash !== jobTipHash) {
      logger.info({ worker: session.worker, job: jobId, jobTip: jobTipHash, currentTip: prev.hash }, "Stratum share rejected: stale job");
      this.respond(session.socket, req.id, false, [21, "Stale job — chain tip has advanced", null]);
      return;
    }

    // ── Parse and validate submitted fields ─────────────────────────────────
    const residual = Number(residualStr);
    if (!Number.isFinite(residual) || residual <= 0) {
      logger.warn({ worker: session.worker, job: jobId }, "Stratum submit: missing or invalid residual");
      this.respond(session.socket, req.id, false, [23, "Invalid residual: must be a positive finite number", null]);
      return;
    }
    if (residual >= RESIDUAL_THRESHOLD) {
      logger.info({ worker: session.worker, job: jobId, residual, threshold: RESIDUAL_THRESHOLD }, "Stratum share rejected: residual above threshold");
      this.respond(session.socket, req.id, false, [23, `Residual ${residual} does not meet threshold ${RESIDUAL_THRESHOLD}`, null]);
      return;
    }

    const parsedNtime = ntimeHex ? parseInt(ntimeHex, 16) : NaN;
    const parsedNonce = nonceHex ? parseInt(nonceHex, 16) : NaN;

    // ── ntime drift guard ────────────────────────────────────────────────────
    // Reject submissions whose claimed ntime deviates more than 2 hours from
    // server wall-clock.  Far-future timestamps can be used to manipulate the
    // block time series; far-past ones may indicate replayed old shares.
    if (Number.isFinite(parsedNtime)) {
      const serverNow = Math.floor(Date.now() / 1000);
      const drift = Math.abs(parsedNtime - serverNow);
      if (drift > StratumServer.NTIME_DRIFT_LIMIT) {
        logger.warn({ worker: session.worker, job: jobId, parsedNtime, serverNow, drift }, "Stratum share rejected: ntime out of range");
        this.respond(session.socket, req.id, false, [23, `ntime deviates ${drift}s from server time (max ${StratumServer.NTIME_DRIFT_LIMIT}s)`, null]);
        return;
      }
    }

    // ── Derive miner address from worker name (format: "address.workerTag") ─
    const minerAddr = (workerParam ?? session.worker ?? "").split(".")[0];
    if (!minerAddr || minerAddr.length !== 40) {
      this.respond(session.socket, req.id, false, [24, "Worker name must start with a 40-char hex miner address", null]);
      return;
    }
    if (!/^[0-9a-f]{40}$/i.test(minerAddr)) {
      this.respond(session.socket, req.id, false, [24, "Miner address must contain only hex characters", null]);
      return;
    }

    // ── Per-worker rate limit ────────────────────────────────────────────────
    // 6 shares per 10 seconds per miner address.  Keyed by address so that
    // reconnecting with a new TCP session does not reset the counter.
    if (!this.submitRateLimit.tryConsume(minerAddr)) {
      const retryAfter = this.submitRateLimit.retryAfterSecs(minerAddr);
      logger.warn({ worker: session.worker, minerAddr, retryAfter }, "Stratum share rate-limited");
      this.respond(session.socket, req.id, false, [23, `Share rate limit exceeded — retry in ${retryAfter}s`, null]);
      return;
    }

    // ── Duplicate share detection ────────────────────────────────────────────
    // Keyed by (jobId, nonce, extraNonce2) — the minimal tuple that uniquely
    // identifies a specific solution attempt.  Prevents double-submission on
    // reconnect or intentional replay attacks.
    const shareKey = `${jobId}:${nonceHex ?? ""}:${extraNonce2 ?? ""}`;
    if (!this.recentShares.tryAdd(shareKey)) {
      logger.warn({ worker: session.worker, minerAddr, job: jobId, shareKey }, "Stratum share rejected: duplicate");
      this.respond(session.socket, req.id, false, [22, "Duplicate share", null]);
      return;
    }

    // ── Assemble the block (mirrors POST /api/blocks/submit) ────────────────
    const height  = cs.height + 1;
    const now     = Number.isFinite(parsedNtime) ? parsedNtime : Math.floor(Date.now() / 1000);
    const nonce   = Number.isFinite(parsedNonce) ? parsedNonce : 0;

    const selected  = cs.mempool.all().slice(0, 50);
    const txHashes  = selected.map((t) => t.hash);
    const mr        = merkleRoot(txHashes.length > 0 ? txHashes : ["0".repeat(64)]);
    const blockHash = hash256(`block-${height}-${prev.hash}-${now}`);

    const quality  = 1.0 / (residual + 1e-6);
    const reward   = Math.floor(BASE_REWARD * Math.min(quality, 1.0));

    const txs: TxRecord[] = selected.map((t) => ({
      ...t,
      blockHash,
      blockHeight: height,
      status: "confirmed" as const,
    }));

    const zkProof = generateZkProof(residual, blockHash, height);

    const block = {
      hash:          blockHash,
      height,
      prevHash:      prev.hash,
      merkleRoot:    mr,
      timestamp:     now,
      nonce,
      difficulty:    cs.currentDifficulty,
      residual,
      residualFp:    Math.floor(residual * 1e18),
      recursionDepth: 2,
      coinbaseReward: reward,
      miner:         minerAddr,
      txCount:       txs.length,
      transactions:  txs,
      finalized:     false,
      zkProof,
    };

    // ── Apply to chain ──────────────────────────────────────────────────────
    cs.addBlock(block);
    cs.gossipBlock(blockHash);

    logger.info(
      { height, hash: blockHash.slice(0, 16), miner: minerAddr, residual, txCount: txs.length, worker: session.worker },
      "Stratum share accepted — block added",
    );

    // Notify WebSocket clients
    broadcast({ type: "new_block",     data: { height, hash: blockHash, txCount: txs.length, residual, miner: minerAddr, timestamp: now } });
    broadcast({ type: "mempool_update", data: { size: cs.mempool.size, pressure: cs.mempool.pressure } });

    // Persist fire-and-forget
    persistBlock(block).catch((err) =>
      logger.warn({ err, height }, "Stratum: failed to persist block"),
    );

    // Push new work to all miners so they stop working on stale jobs
    this.notifyAll();

    this.respond(session.socket, req.id, true, null);
  }

  // ── Job builder ───────────────────────────────────────────────────────────

  private buildJob(): StratumRequest {
    const prev = this.chainState?.latestBlock;
    const tipHash = prev?.hash ?? "0".repeat(64);
    const jobIdHex = (++this.jobId).toString(16).padStart(8, "0");

    // Track tip hash per job so submit can verify the work is not stale.
    // Evict oldest entries when the map exceeds the ring-buffer limit.
    this.activeJobs.set(jobIdHex, tipHash);
    if (this.activeJobs.size > StratumServer.MAX_ACTIVE_JOBS) {
      const oldest = this.activeJobs.keys().next().value;
      if (oldest !== undefined) this.activeJobs.delete(oldest);
    }

    return {
      id: null,
      method: "mining.notify",
      params: [
        jobIdHex,                                    // job_id
        tipHash,                                     // prevhash
        "",                                          // coinbase1
        "",                                          // coinbase2
        [],                                          // merkle_branch
        "00000001",                                  // version
        "207fffff",                                  // nbits (compact difficulty)
        Math.floor(Date.now() / 1000).toString(16),  // ntime
        true,                                        // clean_jobs
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
