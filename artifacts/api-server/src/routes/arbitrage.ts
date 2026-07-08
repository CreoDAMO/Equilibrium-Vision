import { Router } from "express";
import { chainState } from "../chain/index.js";
import { findArbitrageOpportunities } from "../variational-ai/bridge.js";
import { logger } from "../lib/logger.js";
import {
  getArbitrageAddress,
  setArbitrageModel,
  pauseArbitrage,
  unpauseArbitrage,
  executeArbitrage,
} from "../chain/arbitrage.js";

const router = Router();

/**
 * Owner-privileged arbitrage actions (set-model, pause, unpause) use the
 * same ADMIN_KEY / X-Admin-Key gate as validator slashing in validators.ts
 * — see that file for the fails-closed-in-production rationale. The
 * contract's own `owner` field is the on-chain source of truth (checked
 * inside the contract call itself); this header check is a cheap first gate
 * before spending a WASM call.
 */
function requireAdmin(req: import("express").Request, res: import("express").Response): boolean {
  const adminKey = process.env["ADMIN_KEY"] || process.env["ADMIN_API_KEY"];
  if (!adminKey) {
    if (process.env["NODE_ENV"] === "production") {
      res.status(503).json({ error: "Server misconfiguration: neither ADMIN_KEY nor ADMIN_API_KEY is set" });
      return false;
    }
    return true; // dev convenience
  }
  if (req.headers["x-admin-key"] !== adminKey) {
    res.status(403).json({ error: "Forbidden: valid X-Admin-Key header required" });
    return false;
  }
  return true;
}

// Scanning spawns a Rust subprocess; cache briefly so bursts of requests
// (e.g. Explorer polling) don't spawn a process per request.
const CACHE_TTL_MS = 4_000;
let cache: { at: number; body: unknown } | null = null;

router.get("/arbitrage/opportunities", async (req, res) => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    res.json(cache.body);
    return;
  }

  const pools = [...chainState.dexPools.values()];
  if (pools.length === 0) {
    const body = { opportunities: [], count: 0, poolsScanned: 0 };
    cache = { at: Date.now(), body };
    res.json(body);
    return;
  }

  const maxOpportunities = Math.min(Number(req.query["limit"] ?? 5) || 5, 20);

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
      max_opportunities: maxOpportunities,
    });

    const body = {
      opportunities: result.opportunities,
      count: result.count,
      poolsScanned: pools.length,
    };
    cache = { at: Date.now(), body };
    res.json(body);
  } catch (err) {
    logger.error({ err }, "arbitrage scan failed");
    res.status(500).json({ error: "Arbitrage scan failed" });
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
  chainState.wasmVM.setBlockHeight(chainState.height);
  const result = await executeArbitrage(chainState.wasmVM, caller.trim().toLowerCase(), {
    poolIds,
    tokenIn,
    amountIn,
    minProfit: typeof minProfit === "number" ? minProfit : 0,
  });
  if (!result.success) return res.status(400).json(result);
  return res.json(result);
});

export default router;
