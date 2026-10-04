import { Router } from "express";
import { chainState } from "../chain/index.js";
import { merkleRoot, hash256 } from "../chain/crypto.js";
import { generateZkProof } from "../chain/zkproof.js";
import { persistBlock } from "../chain/persistence.js";
import { broadcast } from "../lib/ws-server.js";
import { logger } from "../lib/logger.js";
import type { TxRecord } from "../chain/types.js";
import { RateLimiter, ReplaySet } from "../lib/submission-guard.js";
import { canonicalCoinbase } from "@workspace/coinomics";
import { admitResidual, canonicalResidual, pressureEvidence } from "../chain/canonical-residual.js";
import { openedCouplings } from "../../../../site/src/protocol/constitution.js";
import { foreignNonce, wireNonce } from "../../../../site/src/protocol/domain.js";
import type { TransitionEvidence } from "../../../../site/src/protocol/types.js";

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
  const blocks = all.slice((page - 1) * limit, page * limit).map((block) => ({
    ...block,
    nonce: wireNonce(block.nonce),
  }));
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
  res.json({ ...block, nonce: wireNonce(block.nonce) });
});

// ── Fee breakdown ────────────────────────────────────────────────────────────
//
// GET /api/blocks/:hashOrHeight/fees
//
// Breaks down everything paid to this block's miner: the coinbase reward,
// account-model tx fees (credited directly in ChainState.addBlock), and
// swept UTXO-model tx fees. New blocks credit pendingUtxoFees on the
// account ledger. A leftover `utxo-fees-${height}` output is the old purse.
router.get("/blocks/:hashOrHeight/fees", (req, res) => {
  const { hashOrHeight } = req.params;
  const block =
    chainState.getBlockByHash(hashOrHeight) ??
    (/^\d+$/.test(hashOrHeight)
      ? chainState.getBlockByHeight(Number(hashOrHeight))
      : undefined);

  if (!block) {
    res.status(404).json({ error: "Block not found" });
    return;
  }

  const accountFeeTxs = block.transactions.filter(tx => tx.fee > 0);
  const accountFeesTotal = accountFeeTxs.reduce((sum, tx) => sum + tx.fee, 0);

  const utxoFeeTxHash = hash256(`utxo-fees-${block.height}`);
  const utxoFeeUtxo = chainState.utxoSet.get(utxoFeeTxHash, 0);
  const legacyUtxoFees = utxoFeeUtxo?.amount ?? 0;
  const utxoFeesTotal = legacyUtxoFees + (block.utxoFeeCredit ?? 0);

  res.json({
    height: block.height,
    hash: block.hash,
    miner: block.miner,
    coinbaseReward: block.coinbaseReward,
    accountFees: {
      total: accountFeesTotal,
      txCount: accountFeeTxs.length,
      transactions: accountFeeTxs.map(tx => ({ hash: tx.hash, from: tx.from, fee: tx.fee })),
    },
    utxoFees: {
      total: utxoFeesTotal,
      swept: utxoFeesTotal > 0,
    },
    totalFees: accountFeesTotal + utxoFeesTotal,
    totalMinerEarnings: block.coinbaseReward + accountFeesTotal + utxoFeesTotal,
  });
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
//     nonce:    string | number, // exact u64: decimal text, or a safe integer
//     residual: number,   // Lagrangian residual — must be < RESIDUAL_THRESHOLD
//     prevHash: string,   // expected chain-tip hash (optional; rejects stale work)
//     timestamp: number   // unix seconds (optional; defaults to server time)
//   }
//
// Response 201: { hash, height, reward, txCount }
// Response 400: bad request (missing fields)
// Response 409: stale work (chain tip advanced while solving)
// Response 422: residual above threshold

router.post("/blocks/submit", async (req, res) => {
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
  let submittedNonce: bigint;
  try {
    submittedNonce = foreignNonce(nonce);
  } catch {
    res.status(400).json({ error: "nonce is not a u64" });
    return;
  }
  if (!chainState) {
    res.status(503).json({ error: "Chain not initialised" });
    return;
  }

  const evidence = (req.body as { evidence?: unknown }).evidence;
  if (evidence && typeof evidence === "object") {
    const now = (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0)
      ? Math.floor(timestamp)
      : Math.floor(Date.now() / 1000);
    const committed = await chainState.admitEvidence({
      transactions: [],
      evidence: evidence as TransitionEvidence,
      timestamp: now,
      nonce: submittedNonce,
      miner: miner.toLowerCase(),
      committedPressure: 0,
      couplings: openedCouplings(chainState.canonicalBody.omega),
      difficulty: chainState.canonicalBody.omega.difficulty,
    });
    if (!committed.ok) {
      res.status(422).json({ error: committed.error });
      return;
    }
    persistBlock({
      hash: committed.hash,
      height: committed.height,
      prevHash: committed.prevHash,
      merkleRoot: committed.merkleRoot,
      stateRoot: committed.stateRoot,
      timestamp: now,
      nonce: submittedNonce,
      difficulty: committed.difficulty,
      residual: committed.residual,
      residualFp: committed.residualFp,
      recursionDepth: 2,
      coinbaseReward: committed.reward,
      miner: miner.toLowerCase(),
      txCount: 0,
      transactions: [],
      finalized: false,
      chainId: committed.evidence.chainId,
      evidenceRoot: committed.evidenceRoot,
      omegaRoot: committed.omegaRoot,
      evidence: committed.evidence,
      committedPressure: 0,
    }).catch((err) => logger.warn({ err, height: committed.height }, "Failed to persist canonical evidence block"));
    res.status(201).json({
      hash: committed.hash,
      height: committed.height,
      omegaRoot: committed.omegaRoot,
      tipHash: committed.tipHash,
      reward: committed.reward,
    });
    return;
  }

  if (typeof residual !== "number" || !Number.isFinite(residual)) {
    res.status(400).json({ error: "Missing required field: residual (number)" });
    return;
  }

  // ── Check residual meets the PoS threshold ──────────────────────────────────
  if (residual >= chainState.admissionTarget) {
    res.status(422).json({
      error:     "Residual does not meet threshold",
      residual,
      threshold: chainState.admissionTarget,
    });
    return;
  }

  const tipHash = chainState.latestBlock?.hash ?? "0".repeat(64);

  // ── Reject stale work (optional prevHash check) ─────────────────────────────
  if (typeof prevHash === "string" && prevHash.length > 0 && prevHash !== tipHash) {
    res.status(409).json({
      error:          "Stale work — chain tip has advanced",
      submittedPrev:  prevHash,
      currentTip:     tipHash,
      currentHeight:  chainState.height,
    });
    return;
  }

  // ── Timestamp drift guard ───────────────────────────────────────────────────
  // Reject blocks whose claimed timestamp is more than TIMESTAMP_DRIFT_LIMIT
  // seconds away from server time.  This prevents far-future or far-past
  // timestamps being used to manipulate the chain's time series.
  const serverNow = Math.floor(Date.now() / 1000);
  const claimedTime = (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0)
    ? Math.floor(timestamp)
    : serverNow;
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
  const tipTime = chainState.canonicalBody.omega.tipTimestamp;
  if (chainState.canonicalBody.omega.height >= 0 && claimedTime < tipTime) {
    res.status(422).json({ error: "timestamp is not monotonic", submitted: claimedTime, tipTimestamp: tipTime });
    return;
  }
  const producer = chainState.canonicalBody.omega.validators.get(miner.toLowerCase());
  if (!producer || producer.jailed || producer.slashed || producer.bondedStake <= 0) {
    res.status(422).json({ error: "miner is not a live validator" });
    return;
  }
  const committedPressure = pressureEvidence((req.body as { committedPressure?: unknown }).committedPressure);
  if (committedPressure === null) {
    res.status(422).json({ error: "committed pressure is block evidence" });
    return;
  }

  // ── Replay detection — reject duplicate (prevHash, nonce) pairs ─────────────
  // A valid PoS solution is unique to a given chain tip; the same (tip, nonce)
  // cannot produce two distinct valid blocks, so a duplicate is always spam.
  const replayKey = `${tipHash}:${submittedNonce.toString()}`;
  if (!submitReplay.tryAdd(replayKey)) {
    logger.warn({ ip, miner, nonce: submittedNonce.toString(), prevHash: tipHash }, "Block submission replay rejected");
    res.status(409).json({ error: "Duplicate submission — this (prevHash, nonce) pair has already been processed" });
    return;
  }

  // ── Build the new block ─────────────────────────────────────────────────────
  const height  = chainState.height + 1;
  const now     = (typeof timestamp === "number" && timestamp > 0)
    ? Math.floor(timestamp)
    : Math.floor(Date.now() / 1000);

  // Pull pending txs from the mempool (same as the internal miner)
  const selected  = chainState.selectCanonical(chainState.mempool.all());
  const txHashes  = selected.map((t) => t.hash);
  const mr        = merkleRoot(txHashes.length > 0 ? txHashes : ["0".repeat(64)]);
  const blockHash = hash256(`block-${height}-${tipHash}-${now}`);
  const difficulty = chainState.canonicalBody.omega.difficulty;
  const recomputed = canonicalResidual(
    {
      prevHash: tipHash,
      merkleRoot: mr,
      timestamp: now,
      nonce: submittedNonce,
      difficulty,
    },
    selected.map((t) => ({ hash: t.hash, fee: t.fee })),
    { cumulativeWork: height, mempoolPressure: committedPressure },
    chainState.canonicalBody.omega.couplings,
  );
  const admission = admitResidual(residual, recomputed, chainState.admissionTarget);
  if (!admission.ok) {
    res.status(422).json({
      error: admission.error,
      claimed: residual,
      recomputed,
      threshold: chainState.admissionTarget,
    });
    return;
  }

  const reward = canonicalCoinbase(height, admission.residual, chainState.admissionTarget);

  const txs: TxRecord[] = selected.map((t) => ({
    ...t,
    blockHash,
    blockHeight: height,
    status:      "confirmed" as const,
  }));

  const zkProof = generateZkProof(admission.residual, blockHash, height);

  const block = {
    hash:          blockHash,
    height,
    prevHash:      tipHash,
    merkleRoot:    mr,
    timestamp:     now,
    nonce:         submittedNonce,
    difficulty:    difficulty,
    residual:      admission.residual,
    recursionDepth: 2,
    coinbaseReward: reward,
    miner,
    txCount:       txs.length,
    transactions:  txs,
    finalized:     false,
    zkProof,
    committedPressure,
    sealIdentity: true,
  };

  // ── Apply to chain state ────────────────────────────────────────────────────
  // Note: do NOT call chainState.ledger.credit() here — addBlock() calls
  // distributeBlockReward(). A pre-credit here would double the miner's balance.
  chainState.addBlock(block);
  block.zkProof = generateZkProof(block.residual, block.hash, block.height);
  chainState.gossipBlock(block.hash);

  logger.info(
    { height, hash: block.hash.slice(0, 16), miner, residual: admission.residual, txCount: txs.length },
    "Block submitted by external miner",
  );

  // ── Notify WebSocket clients ────────────────────────────────────────────────
  broadcast({
    type: "new_block",
    data: { height, hash: block.hash, txCount: txs.length, residual: admission.residual, miner, timestamp: now },
  });
  broadcast({
    type: "mempool_update",
    data: { size: chainState.mempool.size, pressure: chainState.mempool.pressure },
  });

  // ── Persist fire-and-forget ─────────────────────────────────────────────────
  persistBlock(block).catch((err) =>
    logger.warn({ err, height }, "Failed to persist externally submitted block"),
  );

  res.status(201).json({ hash: block.hash, height, reward, txCount: txs.length });
});

export default router;
