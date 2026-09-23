import { sha256Hex } from "./crypto";
import type { DexPool } from "./types";

/** Deterministic sink for a pool. A signed EQU transfer to this address is a swap. */
export function poolAddress(poolId: string): string {
  return sha256Hex(`eq-pool:${poolId}`).slice(0, 40);
}

/** Constant-product quote. Does not mutate the pool. */
export function quoteSwap(pool: DexPool, tokenIn: string, amountIn: number): number {
  if (!Number.isFinite(amountIn) || amountIn <= 0) return 0;
  const isA = tokenIn === pool.tokenA;
  if (!isA && tokenIn !== pool.tokenB) return 0;
  const reserveIn = isA ? pool.reserveA : pool.reserveB;
  const reserveOut = isA ? pool.reserveB : pool.reserveA;
  if (reserveIn <= 0 || reserveOut <= 0) return 0;
  const dx = amountIn * (1 - pool.fee);
  if (dx <= 0) return 0;
  return Math.floor((dx * reserveOut) / (reserveIn + dx));
}

/** Apply a quote. Returns the output amount, or 0 if the pool refuses it. */
export function applySwap(pool: DexPool, tokenIn: string, amountIn: number): number {
  const out = quoteSwap(pool, tokenIn, amountIn);
  if (out <= 0) return 0;
  if (tokenIn === pool.tokenA) {
    pool.reserveA += amountIn;
    pool.reserveB -= out;
  } else {
    pool.reserveB += amountIn;
    pool.reserveA -= out;
  }
  pool.txCount += 1;
  return out;
}
