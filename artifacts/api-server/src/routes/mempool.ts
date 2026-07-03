import { Router } from "express";
import { chainState } from "../chain/index.js";

const router = Router();

router.get("/mempool", (_req, res) => {
  const txs = chainState.mempool.all();
  res.json({
    count: txs.length,
    pressure: chainState.mempool.pressure,
    transactions: txs,
  });
});

export default router;
