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
