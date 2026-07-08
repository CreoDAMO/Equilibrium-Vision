import { Router } from "express";
import { chainState } from "../chain/index.js";
import { findArbitrageOpportunities } from "../variational-ai/bridge.js";
import { logger } from "../lib/logger.js";

const router = Router();

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

export default router;
