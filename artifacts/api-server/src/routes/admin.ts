/**
 * Admin-only read endpoints (no auth required — these are read-only snapshots
 * of chain state that an operator viewing the explorer admin panel needs).
 * Write/privileged admin routes (multisig propose/approve/execute, slash) live
 * in validators.ts alongside the validator resource routes.
 */
import { Router } from "express";
import { chainState } from "../chain/index.js";
import { getRunningStratumServer } from "../lib/stratum-server.js";

const router = Router();

/** GET /api/admin/slash-events — all slash events across all validators, newest first */
router.get("/admin/slash-events", (_req, res) => {
  const events = [...chainState.slashEvents].reverse();
  res.json({ count: events.length, events });
});

/** GET /api/admin/unbonding — the full unbonding queue */
router.get("/admin/unbonding", (_req, res) => {
  const queue = [...chainState.unbondingQueue].sort((a, b) => a.completionHeight - b.completionHeight);
  const total = queue.reduce((s, u) => s + u.amount, 0);
  res.json({ count: queue.length, total, queue });
});

/** GET /api/admin/stratum — JSON mining pool metrics (wraps StratumServer.getMetrics()) */
router.get("/admin/stratum", (_req, res) => {
  const stratum = getRunningStratumServer();
  if (!stratum) {
    res.json({ enabled: false });
    return;
  }
  res.json({ enabled: true, ...stratum.getMetrics() });
});

export default router;
