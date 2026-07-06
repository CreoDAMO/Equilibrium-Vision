import { Router } from "express";
import { chainState } from "../chain/index.js";
import { merkleRoot, hash256 } from "../chain/crypto.js";
import { generateZkProof } from "../chain/zkproof.js";
import { persistBlock } from "../chain/persistence.js";
import { broadcast } from "../lib/ws-server.js";
import { logger } from "../lib/logger.js";
import type { TxRecord } from "../chain/types.js";
import { RateLimiter, ReplaySet } from "../lib/submission-guard.js";

const router = Router();

// ── Submission guards (module-scoped, shared across all requests) ─────────────

/** 10 block submissions per IP per 60 s — generous for real PoS solve times. */
const submitRateLimit = new RateLimiter(10, 60_000).startPruning();

/**
 * Replay set keyed by "<prevHash>:<nonce>".
 * Prevents the same (prevHash, nonce) tuple from being accepted twice,
 * even if the chain tip has not yet advanced.
 * Capacity 1 024 covers ~10 minutes of 1 block/s mining with safety margin.
 */
const submitReplay = new ReplaySet(1024);

/** Maximum ±seconds the submitted timestamp may differ from server wall-clock. */
const TIMESTAMP_DRIFT_LIMIT = 300; // 5 minutes

// ── Block list ────────────────────────────────────────────────────────────────

router.get("/blocks", (req, res) => {
  const page = Math.max(1, Number(req.query["page"]) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query["limit"]) || 20));
  const all = [...chainState.blocks].reverse();
  const total = all.length;
  const blocks = all.slice((page - 1) * limit, page * limit);
  res.json({ blocks, total, page, limit });
});

router.get("/blocks/:hashOrHeight", (req, res) => {
  const { hashOrHeight } = req.params;
  let block =
    chainState.getBlockByHash(hashOrHeight) ??
    (/^\d+$/.test(hashOrHeight)
      ? chainState.getBlockByHeight(Number(hashOrHeight))
      : undefined);

  if (!block) {
    res.status(404).json({ error: "Block not found" });
    return;
  }
  res.json(block);
});

// ── External block submission (mobile miners / third-party nodes) ─────────────
//
// POST /api/blocks/submit
//
// Accepts a solved Proof-of-Stationarity block from an external miner
// (e.g. the Android app) and adds it to the chain when valid.
//
// Request body:
//   {
//     miner:    string,   // 40-char hex miner address (required)
//     nonce:    number,   // solver nonce result (required)
//     residual: number,   // Lagrangian residual — must be < RESIDUAL_THRESHOLD
//     prevHash: string,   // expected chain-tip hash (optional; rejects stale work)
//     timestamp: number   // unix seconds (optional; defaults to server time)
//   }
//
// Response 201: { hash, height, reward, txCount }
// Response 400: bad request (missing fields)
// Response 409: stale work (chain tip advanced while solving)
// Response 422: residual above threshold

const RESIDUAL_THRESHOLD = 1e-7;
const BASE_REWARD        = 50_000_000;

router.post("/blocks/submit", (req, res) => {
  // ── Rate limiting — per source IP ───────────────────────────────────────────
  // Always use the TCP socket address.  We deliberately ignore X-Forwarded-For
  // because (a) the server is not behind a vetted trusted proxy and (b) XFF
  // headers are trivially forged by any client, making them useless for spam
  // protection.  The real connection IP is the only unforgeable source identity.
  const ip = req.socket.remoteAddress ?? "unknown";
  if (!submitRateLimit.tryConsume(ip)) {
    const retryAfter = submitRateLimit.retryAfterSecs(ip);
    res.status(429)
      .set("Retry-After", String(retryAfter))
      .json({ error: "Too many block submissions — slow down", retryAfter });
    return;
  }

  const { miner, nonce, residual, prevHash, timestamp } = req.body as Record<string, unknown>;

  // ── Validate required fields ────────────────────────────────────────────────
  if (typeof miner !== "string" || miner.length === 0) {
    res.status(400).json({ error: "Missing required field: miner" });
    return;
  }
  // Miner must be a valid 40-character lowercase hex address.
  if (!/^[0-9a-f]{40}$/i.test(miner)) {
    res.status(400).json({ error: "miner must be a 40-character hex address" });
    return;
  }
  if (typeof nonce !== "number" || !Number.isFinite(nonce)) {
    res.status(400).json({ error: "Missing required field: nonce (number)" });
    return;
  }
  if (typeof residual !== "number" || !Number.isFinite(residual)) {
    res.status(400).json({ error: "Missing required field: residual (number)" });
    return;
  }

  // ── Check residual meets the PoS threshold ──────────────────────────────────
  if (residual >= RESIDUAL_THRESHOLD) {
    res.status(422).json({
      error:     "Residual does not meet threshold",
      residual,
      threshold: RESIDUAL_THRESHOLD,
    });
    return;
  }

  // ── Ensure chain is initialised ─────────────────────────────────────────────
  const prev = chainState.latestBlock;
  if (!prev) {
    res.status(503).json({ error: "Chain not initialised" });
    return;
  }

  // ── Reject stale work (optional prevHash check) ─────────────────────────────
  if (typeof prevHash === "string" && prevHash.length > 0 && prevHash !== prev.hash) {
    res.status(409).json({
      error:          "Stale work — chain tip has advanced",
      submittedPrev:  prevHash,
      currentTip:     prev.hash,
      currentHeight:  chainState.height,
    });
    return;
  }

  // ── Timestamp drift guard ───────────────────────────────────────────────────
  // Reject blocks whose claimed timestamp is more than TIMESTAMP_DRIFT_LIMIT
  // seconds away from server time.  This prevents far-future or far-past
  // timestamps being used to manipulate the chain's time series.
  const serverNow = Math.floor(Date.now() / 1000);
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    const drift = Math.abs(Math.floor(timestamp) - serverNow);
    if (drift > TIMESTAMP_DRIFT_LIMIT) {
      res.status(400).json({
        error:        "Submitted timestamp deviates too far from server time",
        submitted:    Math.floor(timestamp),
        serverTime:   serverNow,
        maxDriftSecs: TIMESTAMP_DRIFT_LIMIT,
      });
      return;
    }
  }

  // ── Replay detection — reject duplicate (prevHash, nonce) pairs ─────────────
  // A valid PoS solution is unique to a given chain tip; the same (tip, nonce)
  // cannot produce two distinct valid blocks, so a duplicate is always spam.
  const replayKey = `${prev.hash}:${nonce}`;
  if (!submitReplay.tryAdd(replayKey)) {
    logger.warn({ ip, miner, nonce, prevHash: prev.hash }, "Block submission replay rejected");
    res.status(409).json({ error: "Duplicate submission — this (prevHash, nonce) pair has already been processed" });
    return;
  }

  // ── Build the new block ─────────────────────────────────────────────────────
  const height  = chainState.height + 1;
  const now     = (typeof timestamp === "number" && timestamp > 0)
    ? Math.floor(timestamp)
    : Math.floor(Date.now() / 1000);

  // Pull pending txs from the mempool (same as the internal miner)
  const selected  = chainState.mempool.all().slice(0, 50);
  const txHashes  = selected.map((t) => t.hash);
  const mr        = merkleRoot(txHashes.length > 0 ? txHashes : ["0".repeat(64)]);
  const blockHash = hash256(`block-${height}-${prev.hash}-${now}`);

  const quality   = 1.0 / (residual + 1e-6);
  const reward    = Math.floor(BASE_REWARD * Math.min(quality, 1.0));

  const txs: TxRecord[] = selected.map((t) => ({
    ...t,
    blockHash,
    blockHeight: height,
    status:      "confirmed" as const,
  }));

  const zkProof = generateZkProof(residual, blockHash, height);

  const block = {
    hash:          blockHash,
    height,
    prevHash:      prev.hash,
    merkleRoot:    mr,
    timestamp:     now,
    nonce:         Math.floor(nonce),
    difficulty:    chainState.currentDifficulty,
    residual,
    recursionDepth: 2,
    coinbaseReward: reward,
    miner,
    txCount:       txs.length,
    transactions:  txs,
    finalized:     false,
    zkProof,
  };

  // ── Apply to chain state ────────────────────────────────────────────────────
  // Note: do NOT call chainState.ledger.credit() here — addBlock() calls
  // distributeBlockReward() which already credits the miner (and splits among
  // delegators if they are a registered validator).  A pre-credit here would
  // double the miner's balance on every externally-submitted block.
  chainState.addBlock(block);
  chainState.gossipBlock(blockHash);

  logger.info(
    { height, hash: blockHash.slice(0, 16), miner, residual, txCount: txs.length },
    "Block submitted by external miner",
  );

  // ── Notify WebSocket clients ────────────────────────────────────────────────
  broadcast({
    type: "new_block",
    data: { height, hash: blockHash, txCount: txs.length, residual, miner, timestamp: now },
  });
  broadcast({
    type: "mempool_update",
    data: { size: chainState.mempool.size, pressure: chainState.mempool.pressure },
  });

  // ── Persist fire-and-forget ─────────────────────────────────────────────────
  persistBlock(block).catch((err) =>
    logger.warn({ err, height }, "Failed to persist externally submitted block"),
  );

  res.status(201).json({ hash: blockHash, height, reward, txCount: txs.length });
});

export default router;
