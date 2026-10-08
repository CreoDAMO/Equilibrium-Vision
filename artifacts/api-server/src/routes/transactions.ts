import { Router } from "express";
import { chainState } from "../chain/index.js";
import { verifyCanonicalTx } from "../lib/canonical-tx.js";

const router = Router();

router.get("/tx/:hash", (req, res) => {
  const tx = chainState.getTx(req.params["hash"]!);
  if (!tx) {
    res.status(404).json({ error: "Transaction not found" });
    return;
  }
  res.json(tx);
});

router.post("/tx/broadcast", async (req, res) => {
  const body = req.body as {
    from?: string;
    to?: string;
    amount?: number;
    fee?: number;
    nonce?: number;
    signature?: string;
    publicKey?: string;
    chainId?: number;
    hash?: string;
    timestamp?: number;
  };
  const checked = verifyCanonicalTx(body);
  if (!checked.ok) {
    res.status(checked.status).json({ error: checked.error });
    return;
  }

  const tx = {
    hash: checked.hash,
    from: body.from!,
    to: body.to!,
    amount: body.amount!,
    fee: body.fee!,
    nonce: body.nonce!,
    blockHash: null,
    blockHeight: null,
    timestamp: Number.isSafeInteger(body.timestamp) ? body.timestamp! : Math.floor(Date.now() / 1000),
    status: "pending" as const,
    signature: body.signature,
    publicKey: body.publicKey,
  };

  const queued = chainState.mempool.all().filter((t) => t.from === tx.from);
  const applicable = chainState.ledger.selectApplicable([...queued, tx]);
  if (!applicable.includes(tx)) {
    res.status(400).json({ error: "Transaction does not apply: insufficient funds or bad nonce" });
    return;
  }

  chainState.mempool.add(tx);
  chainState.gossipTx(tx.hash);
  res.json({ txHash: tx.hash, status: "pending" });
});

export default router;
