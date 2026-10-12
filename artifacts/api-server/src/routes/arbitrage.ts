import { Router } from "express";
import { chainState } from "../chain/index.js";
import { findArbitrageOpportunities, type ArbitrageOpportunity } from "../variational-ai/bridge.js";
import { logger } from "../lib/logger.js";
import { RateLimiter } from "../lib/submission-guard.js";
import {
  getArbitrageAddress,
  setArbitrageModel,
  pauseArbitrage,
  unpauseArbitrage,
  executeArbitrage,
} from "../chain/arbitrage.js";

const router = Router();

/**
 * Per-caller execute limiter — independent of the contract's own global
 * circuit breaker (max 5 executions per `arbitrageWindow` block window,
 * shared across every caller). Without this, a single permissionless caller
 * could burn the entire shared window with back-to-back calls and starve
 * every other caller until the contract's window rolls over. 2 calls per
 * 15s (roughly one block interval) per caller is generous enough for
 * legitimate use while preventing single-caller monopolization.
 */
const executeLimiter = new RateLimiter(2, 15_000).startPruning();

/**
 * Owner-privileged arbitrage actions (set-model, pause, unpause) use the
 * same ADMIN_KEY / X-Admin-Key gate as validator slashing in validators.ts
 * — see that file for the fails-closed-in-production rationale. The
 * contract's own `owner` field is the on-chain source of truth (checked
 * inside the contract call itself); this header check is a cheap first gate
 * before spending a WASM call.
 *
 * Three modes:
 *   production + no ADMIN_KEY   → 503 (server misconfiguration, fails closed)
 *   any env   + ADMIN_KEY set   → enforce X-Admin-Key header (403 if wrong)
 *   dev/test  + no ADMIN_KEY    → pass through; WASM contract verifies owner
 */
function requireAdmin(req: import("express").Request, res: import("express").Response): boolean {
  const adminKey = process.env["ADMIN_KEY"] || process.env["ADMIN_API_KEY"];

  // ── ADMIN_KEY set (any env): enforce X-Admin-Key header ─────────────────
  if (adminKey) {
    if (req.headers["x-admin-key"] !== adminKey) {
      res.status(403).json({ error: "Forbidden: valid X-Admin-Key header required" });
      return false;
    }
    return true;
  }

  // ── No ADMIN_KEY: only bypass in an explicit dev/test environment ────────
  // Allowlist: NODE_ENV=development, NODE_ENV=test, or NODE_ENV unset (local
  // dev without a .env file). Everything else — production, staging, or any
  // other named env — fails closed so a misconfigured deployment doesn't
  // silently skip auth. Vitest sets NODE_ENV=test automatically.
  const env = process.env["NODE_ENV"];
  const isDevOrTest = !env || env === "development" || env === "test";
  if (!isDevOrTest) {
    res.status(503).json({ error: "Server misconfiguration: neither ADMIN_KEY nor ADMIN_API_KEY is set" });
    return false;
  }

  // Dev/test: pass through. The WASM contract verifies the caller is the
  // contract owner on every call — on-chain ownership check is always active.
  return true;
}

// Scanning spawns a Rust subprocess; cache briefly so bursts of requests
// (e.g. Explorer polling) don't spawn a process per request.
// The cache stores the scan, not one HTTP body. A later request with a
// smaller limit slices that scan. A larger limit rescans unless the scan
// already returned fewer cycles than it was allowed to ask for.
const CACHE_TTL_MS = 4_000;
export type OpportunityScan = {
  at: number;
  poolsScanned: number;
  scannedAt: number;
  opportunities: ArbitrageOpportunity[];
};
let cache: OpportunityScan | null = null;

export function opportunityLimit(raw: unknown): number {
  const n = typeof raw === "string" || typeof raw === "number" ? Number(raw) : 5;
  if (!Number.isFinite(n)) return 5;
  return Math.min(20, Math.max(1, Math.floor(n)));
}

export function scanCovers(scan: OpportunityScan, limit: number, poolCount: number): boolean {
  if (Date.now() - scan.at >= CACHE_TTL_MS) return false;
  if (scan.poolsScanned !== poolCount) return false;
  if (scan.scannedAt >= limit) return true;
  return scan.opportunities.length < scan.scannedAt;
}

export function opportunitiesBody(scan: OpportunityScan, limit: number) {
  const opportunities = scan.opportunities.slice(0, limit);
  return { opportunities, count: opportunities.length, poolsScanned: scan.poolsScanned };
}

router.get("/arbitrage/opportunities", async (req, res) => {
  const limit = opportunityLimit(req.query["limit"]);
  const pools = [...chainState.dexPools.values()];
  if (cache && scanCovers(cache, limit, pools.length)) {
    res.json(opportunitiesBody(cache, limit));
    return;
  }

  if (pools.length === 0) {
    cache = { at: Date.now(), poolsScanned: 0, scannedAt: 20, opportunities: [] };
    res.json(opportunitiesBody(cache, limit));
    return;
  }

  try {
    const result = await findArbitrageOpportunities({
      pools: pools.map(p => ({
        pool_id: p.id,
        token_a: p.tokenA,
        token_b: p.tokenB,
        reserve_a: p.reserveA,
        reserve_b: p.reserveB,
        fee: p.fee,
      })),
      max_opportunities: limit,
    });

    cache = {
      at: Date.now(),
      poolsScanned: pools.length,
      scannedAt: limit,
      opportunities: result.opportunities,
    };
    res.json(opportunitiesBody(cache, limit));
  } catch (err) {
    // The Rust scanner binary may be temporarily unavailable (e.g. not yet
    // built in a fresh CI environment, or restarting after a crash).  Return
    // an empty-opportunities response rather than 500 so the explorer stays
    // functional and the endpoint shape is always consistent.
    logger.warn({ err }, "arbitrage scan unavailable — returning empty results");
    cache = { at: Date.now(), poolsScanned: pools.length, scannedAt: 20, opportunities: [] };
    res.json(opportunitiesBody(cache, limit));
  }
});

// GET /api/arbitrage/status — governed-contract status (address, model, paused)
router.get("/arbitrage/status", (_req, res) => {
  const address = getArbitrageAddress();
  if (!address) return res.status(503).json({ error: "Arbitrage contract not deployed" });
  const storage = chainState.wasmVM.getStorage(address);
  return res.json({
    address,
    owner: storage["owner"] ?? null,
    registry: storage["registry"] ?? null,
    modelId: storage["model_id"] !== undefined ? Number(storage["model_id"]) : null,
    paused: storage["paused"] === "1",
    circuitTripped: storage["circuit_tripped"] === "1",
    execCount: storage["exec_count"] !== undefined ? Number(storage["exec_count"]) : 0,
  });
});

// POST /api/arbitrage/set-model — owner-only
// Body: { caller, registryAddress, modelId }
router.post("/arbitrage/set-model", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { caller, registryAddress, modelId } = req.body ?? {};
  if (typeof caller !== "string" || typeof registryAddress !== "string" || typeof modelId !== "number") {
    return res.status(400).json({ error: "caller, registryAddress, modelId are required" });
  }
  chainState.wasmVM.setBlockHeight(chainState.height);
  const result = await setArbitrageModel(chainState.wasmVM, caller.trim().toLowerCase(), registryAddress.trim().toLowerCase(), modelId);
  if (!result.success) return res.status(400).json(result);
  return res.json(result);
});

// POST /api/arbitrage/pause — owner-only. Body: { caller }
router.post("/arbitrage/pause", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { caller } = req.body ?? {};
  if (typeof caller !== "string") return res.status(400).json({ error: "caller is required" });
  chainState.wasmVM.setBlockHeight(chainState.height);
  const result = await pauseArbitrage(chainState.wasmVM, caller.trim().toLowerCase());
  if (!result.success) return res.status(400).json(result);
  return res.json(result);
});

// POST /api/arbitrage/unpause — owner-only. Body: { caller }
router.post("/arbitrage/unpause", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { caller } = req.body ?? {};
  if (typeof caller !== "string") return res.status(400).json({ error: "caller is required" });
  chainState.wasmVM.setBlockHeight(chainState.height);
  const result = await unpauseArbitrage(chainState.wasmVM, caller.trim().toLowerCase());
  if (!result.success) return res.status(400).json(result);
  return res.json(result);
});

// POST /api/arbitrage/execute — permissionless, but the contract's own
// safety rails (pause switch, model verification/maturity, max trade
// amount, circuit breaker) gate whether it actually does anything.
// Body: { caller, poolIds, tokenIn, amountIn, minProfit }
router.post("/arbitrage/execute", async (req, res) => {
  const { caller, poolIds, tokenIn, amountIn, minProfit } = req.body ?? {};
  if (typeof caller !== "string" || !Array.isArray(poolIds) || typeof tokenIn !== "string" || typeof amountIn !== "number") {
    return res.status(400).json({ error: "caller, poolIds (array), tokenIn, amountIn are required" });
  }
  const normalizedCaller = caller.trim().toLowerCase();
  if (!executeLimiter.tryConsume(normalizedCaller)) {
    const retryAfter = executeLimiter.retryAfterSecs(normalizedCaller);
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({
      error: `Rate limit exceeded for this caller — retry in ${retryAfter}s`,
      retryAfter,
    });
  }
  chainState.wasmVM.setBlockHeight(chainState.height);
  const result = await executeArbitrage(chainState.wasmVM, normalizedCaller, {
    poolIds,
    tokenIn,
    amountIn,
    minProfit: typeof minProfit === "number" ? minProfit : 0,
  });
  if (!result.success) return res.status(400).json(result);
  return res.json(result);
});

export default router;
