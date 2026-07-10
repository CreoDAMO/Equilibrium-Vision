import { Router } from "express";
import { chainState } from "../chain/index.js";

const router = Router();

router.get("/dex/pools", (_req, res) => {
  const pools = [...chainState.dexPools.values()].map(p => ({
    ...p,
    price: p.reserveA > 0 ? p.reserveB / p.reserveA : 0,
    tvl: p.reserveA + p.reserveB,
  }));
  res.json({ count: pools.length, pools });
});

router.get("/dex/pools/:id", (req, res) => {
  const pool = chainState.dexPools.get(req.params["id"]!);
  if (!pool) {
    res.status(404).json({ error: "Pool not found" });
    return;
  }
  const positions = chainState.liquidityPositions.filter(p => p.poolId === pool.id);
  res.json({
    ...pool,
    price: pool.reserveA > 0 ? pool.reserveB / pool.reserveA : 0,
    tvl: pool.reserveA + pool.reserveB,
    positions,
  });
});

router.post("/dex/swap", (req, res) => {
  const { poolId, trader, tokenIn, amountIn } = req.body as {
    poolId?: string;
    trader?: string;
    tokenIn?: string;
    amountIn?: number;
  };

  if (!poolId || !trader || !tokenIn || amountIn == null) {
    res.status(400).json({ error: "poolId, trader, tokenIn, amountIn are required" });
    return;
  }
  if (trader.length !== 40) {
    res.status(400).json({ error: "Invalid trader address" });
    return;
  }
  if (!Number.isFinite(amountIn) || amountIn <= 0) {
    res.status(400).json({ error: "amountIn must be a positive finite number" });
    return;
  }
  const swapPool = chainState.dexPools.get(poolId);
  if (!swapPool) {
    res.status(404).json({ error: "Pool not found" });
    return;
  }
  if (tokenIn !== swapPool.tokenA && tokenIn !== swapPool.tokenB) {
    res.status(400).json({ error: `tokenIn must be ${swapPool.tokenA} or ${swapPool.tokenB}` });
    return;
  }

  const result = chainState.swap(poolId, trader, tokenIn, amountIn);
  if (typeof result === "string") {
    res.status(400).json({ error: result });
    return;
  }
  res.json({ success: true, poolId, trader, tokenIn, amountIn, ...result });
});

router.post("/dex/liquidity/add", (req, res) => {
  const { poolId, provider, amountA, amountB } = req.body as {
    poolId?: string;
    provider?: string;
    amountA?: number;
    amountB?: number;
  };

  if (!poolId || !provider || amountA == null || amountB == null) {
    res.status(400).json({ error: "poolId, provider, amountA, amountB are required" });
    return;
  }
  if (provider.length !== 40) {
    res.status(400).json({ error: "Invalid provider address" });
    return;
  }
  if (!Number.isFinite(amountA) || amountA <= 0) {
    res.status(400).json({ error: "amountA must be a positive finite number" });
    return;
  }
  if (!Number.isFinite(amountB) || amountB <= 0) {
    res.status(400).json({ error: "amountB must be a positive finite number" });
    return;
  }
  const result = chainState.addLiquidity(poolId, provider, amountA, amountB);
  if (typeof result === "string") {
    res.status(400).json({ error: result });
    return;
  }
  res.json({ success: true, poolId, provider, amountA, amountB, ...result });
});

/**
 * Dev/demo-only: seed a synthetic, deliberately mispriced WBTC-USDC pool so
 * the arbitrage detector has a real negative cycle to find (EQU-WBTC and
 * EQU-USDC alone can never form a triangle). Disabled in production.
 * Idempotent — a second call reports the pool already exists.
 *
 * Optional JSON body lets callers (tests, the CLI script, or a future
 * "extended multi-hop" mode) dial the mispricing to an exact magnitude
 * instead of the fixed 20%-cheap default:
 *   { poolId?: string, reserveA?: number, reserveB?: number, discountBp?: number }
 * `discountBp` (basis points below the 100,000 fair price) is the simplest
 * knob — e.g. 500 = 5% cheap (small/marginal profit), 2000 = 20% (default,
 * comfortably profitable), 9000 = 90% (deliberately far above any sane cap,
 * for hard-cap-rejection tests). `reserveA`/`reserveB` override it entirely
 * for full manual control over an arbitrary reserve ratio.
 */
router.post("/dex/pools/seed-arbitrage-demo", (req, res) => {
  if (process.env["NODE_ENV"] === "production") {
    res.status(403).json({ error: "Demo seeding is disabled in production" });
    return;
  }

  const body = (req.body ?? {}) as {
    poolId?: unknown; reserveA?: unknown; reserveB?: unknown; discountBp?: unknown;
  };
  const poolId = typeof body.poolId === "string" && body.poolId ? body.poolId : "WBTC-USDC";

  // Fair WBTC price implied by the two real genesis pools: 1 WBTC = 100,000 EQU
  // = 100,000 USDC. Default: price this pool 20% cheap (discountBp=2000) so a
  // profitable cycle survives the 0.3%-per-hop DEX fee across all 3 hops.
  let reserveA = typeof body.reserveA === "number" && body.reserveA > 0 ? body.reserveA : 100;
  let reserveB: number;
  if (typeof body.reserveB === "number" && body.reserveB > 0) {
    reserveB = body.reserveB;
  } else {
    const discountBp = typeof body.discountBp === "number" && body.discountBp >= 0 && body.discountBp < 10_000
      ? body.discountBp
      : 2_000;
    const fairReserveB = reserveA * 100_000;
    reserveB = Math.max(1, Math.round(fairReserveB * (10_000 - discountBp) / 10_000));
  }

  const result = chainState.createPool(poolId, "WBTC", "USDC", reserveA, reserveB);

  if (typeof result === "string") {
    res.status(409).json({ error: result, poolId });
    return;
  }

  res.json({
    success: true,
    poolId,
    reserveA,
    reserveB,
    impliedPrice: reserveB / reserveA,
    message: `Seeded WBTC-USDC pool '${poolId}' (1 WBTC = ${(reserveB / reserveA).toLocaleString()} USDC vs. fair 100,000) for arbitrage demo`,
  });
});

router.get("/dex/swaps", (req, res) => {
  const limit = Math.min(Number(req.query["limit"] ?? 50), 200);
  res.json({ count: chainState.swapHistory.length, swaps: chainState.swapHistory.slice(0, limit) });
});

router.get("/dex/positions/:provider", (req, res) => {
  const positions = chainState.liquidityPositions.filter(
    p => p.provider === req.params["provider"],
  );
  res.json({ provider: req.params["provider"], positions });
});

router.get("/dex/quote", (req, res) => {
  const { poolId, tokenIn, amountIn } = req.query as {
    poolId?: string;
    tokenIn?: string;
    amountIn?: string;
  };

  if (!poolId || !tokenIn || !amountIn) {
    res.status(400).json({ error: "poolId, tokenIn, amountIn are required" });
    return;
  }
  const pool = chainState.dexPools.get(poolId);
  if (!pool) {
    res.status(404).json({ error: "Pool not found" });
    return;
  }

  const amt = Number(amountIn);
  const isAtoB = tokenIn === pool.tokenA;
  const reserveIn = isAtoB ? pool.reserveA : pool.reserveB;
  const reserveOut = isAtoB ? pool.reserveB : pool.reserveA;

  const amountInWithFee = amt * (1 - pool.fee);
  const amountOut = Math.floor((reserveOut * amountInWithFee) / (reserveIn + amountInWithFee));
  const priceImpact = (amt / reserveIn) * 100;

  res.json({
    poolId,
    tokenIn,
    tokenOut: isAtoB ? pool.tokenB : pool.tokenA,
    amountIn: amt,
    amountOut,
    fee: Math.floor(amt * pool.fee),
    priceImpact: priceImpact.toFixed(4),
    rate: amountOut / amt,
  });
});

export default router;
