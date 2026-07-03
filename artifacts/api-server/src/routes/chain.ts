import { Router } from "express";
import { chainState, minerAddress } from "../chain/index.js";
import { mineNextBlock } from "../chain/state.js";

const router = Router();

router.get("/chain/status", (_req, res) => {
  const s = chainState;
  const lb = s.latestBlock;
  res.json({
    height: s.height,
    latestHash: lb?.hash ?? "0".repeat(64),
    latestTimestamp: lb?.timestamp ?? 0,
    totalTxCount: s.totalTxCount,
    mempoolSize: s.mempool.size,
    mempoolPressure: s.mempool.pressure,
    validatorCount: s.peers.filter((p) => p.connected).length + 1,
    cumulativeWork: s.height * 1_000_000,
    lastResidual: lb?.residual ?? 0,
    avgBlockTime: s.avgBlockTime,
    tps: s.tps,
  });
});

router.get("/chain/stats", (_req, res) => {
  res.json(chainState.blockStats.slice(-20));
});

router.get("/network/peers", (_req, res) => {
  res.json(chainState.peers);
});

export default router;
