import { Router } from "express";
import { chainState } from "../chain/index.js";
import { hash256 } from "../chain/crypto.js";

const router = Router();

router.get("/tx/:hash", (req, res) => {
  const tx = chainState.getTx(req.params["hash"]!);
  if (!tx) {
    res.status(404).json({ error: "Transaction not found" });
    return;
  }
  res.json(tx);
});

router.post("/tx/broadcast", (req, res) => {
  const body = req.body as {
    from?: string;
    to?: string;
    amount?: number;
    fee?: number;
    nonce?: number;
    signature?: string;
    publicKey?: string;
  };

  if (!body.from || !body.to || body.amount == null || body.fee == null || body.nonce == null) {
    res.status(400).json({ error: "Missing required fields: from, to, amount, fee, nonce" });
    return;
  }
  if (typeof body.from !== "string" || body.from.length !== 40) {
    res.status(400).json({ error: "Invalid from address" });
    return;
  }
  if (typeof body.to !== "string" || body.to.length !== 40) {
    res.status(400).json({ error: "Invalid to address" });
    return;
  }
  if (body.amount <= 0 || body.fee < 0) {
    res.status(400).json({ error: "Amount must be positive, fee must be non-negative" });
    return;
  }

  const txHash = hash256(
    `${body.from}${body.to}${body.amount}${body.fee}${body.nonce}${Date.now()}`
  );

  const tx = {
    hash: txHash,
    from: body.from,
    to: body.to,
    amount: body.amount,
    fee: body.fee,
    nonce: body.nonce,
    blockHash: null,
    blockHeight: null,
    timestamp: Math.floor(Date.now() / 1000),
    status: "pending" as const,
  };

  chainState.mempool.add(tx);
  chainState.gossipTx(txHash);
  res.json({ txHash, status: "pending" });
});

export default router;
