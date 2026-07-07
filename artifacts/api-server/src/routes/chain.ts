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
    validatorCount: [...s.validators.values()].filter(v => !v.slashed && !v.jailed).length,
    cumulativeWork: s.height * s.currentDifficulty,
    lastResidual: lb?.residual ?? 0,
    avgBlockTime: s.avgBlockTime,
    tps: s.tps,
    difficulty: s.currentDifficulty,
    finalizedHeight: s.finalizedHeight,
    totalBondedStake: s.totalBondedStake,
  });
});

router.get("/chain/stats", (_req, res) => {
  res.json(chainState.blockStats.slice(-20));
});

router.get("/network/peers", (_req, res) => {
  res.json(chainState.peers);
});

/** GET /api/config — static server configuration readable by the explorer UI */
router.get("/config", (_req, res) => {
  const networkName = process.env["NETWORK_NAME"] ?? "Testnet";
  const stratumPort = Number(process.env["STRATUM_PORT"] ?? 0);
  res.json({
    networkName,
    stratumPort,
    stratumEnabled: stratumPort > 0,
  });
});

export default router;
