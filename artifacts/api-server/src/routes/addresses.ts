import { Router } from "express";
import { chainState } from "../chain/index.js";

const router = Router();

router.get("/address/:addr", (req, res) => {
  const { addr } = req.params;
  if (!/^[0-9a-f]{40}$/i.test(addr)) {
    res.status(400).json({ error: "Invalid address format (expected 40-char hex)" });
    return;
  }

  const account = chainState.ledger.getAccount(addr);
  const txs = chainState.getAddressTxs(addr);

  if (account.balance === 0 && txs.length === 0) {
    res.status(404).json({ error: "Address not found" });
    return;
  }

  res.json({
    address: addr,
    balance: account.balance,
    nonce: account.nonce,
    txCount: txs.length,
    transactions: txs.sort((a, b) => b.timestamp - a.timestamp),
  });
});

export default router;
