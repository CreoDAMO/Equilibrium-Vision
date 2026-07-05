import { Router } from "express";
import { createHash } from "crypto";
import { chainState } from "../chain/index.js";

const router = Router();

// GET /api/utxo/:address — unspent outputs for an address
router.get("/utxo/:address", (req, res) => {
  const { address } = req.params;
  const cs = chainState;
  const unspent = cs.utxoSet.getUnspent(address);
  const balance = cs.utxoSet.balance(address);
  res.json({
    address,
    balance,
    utxoCount: unspent.length,
    utxos: unspent.map(u => ({
      txHash: u.txHash,
      outputIndex: u.outputIndex,
      amount: u.amount,
      coinbase: u.coinbase,
      blockHeight: u.blockHeight,
    })),
  });
});

// GET /api/utxo/:txHash/:outputIndex — specific UTXO
router.get("/utxo/:txHash/:outputIndex", (req, res) => {
  const { txHash, outputIndex } = req.params;
  const cs = chainState;
  const utxo = cs.utxoSet.get(txHash, Number(outputIndex));
  if (!utxo) return res.status(404).json({ error: "UTXO not found" });
  return res.json(utxo);
});

// GET /api/utxo/stats — overall UTXO set statistics
router.get("/utxo/stats", (_req, res) => {
  const cs = chainState;
  return res.json({
    utxoSetSize: cs.utxoSet.size(),
    totalSupply: cs.utxoSet.totalSupply(),
  });
});

// POST /api/utxo/build — build a UTXO transaction (coin selection)
// Body: { from, to, amount, fee }
router.post("/utxo/build", (req, res) => {
  const { from, to, amount, fee = 1000 } = req.body ?? {};
  if (!from || !to || amount == null) {
    return res.status(400).json({ error: "from, to, and amount are required" });
  }

  const cs = chainState;
  const selection = cs.utxoSet.selectCoins(from, Number(amount), Number(fee));
  if (!selection) {
    return res.status(400).json({ error: "Insufficient UTXO balance" });
  }

  const { selected, change } = selection;
  const outputs: { address: string; amount: number }[] = [
    { address: to, amount: Number(amount) },
  ];
  if (change > 0) {
    outputs.push({ address: from, amount: change });
  }

  return res.json({
    inputs: selected.map(u => ({ txHash: u.txHash, outputIndex: u.outputIndex, amount: u.amount })),
    outputs,
    fee: Number(fee),
    totalIn: selected.reduce((s, u) => s + u.amount, 0),
    totalOut: outputs.reduce((s, o) => s + o.amount, 0) + Number(fee),
  });
});

const HEX_ADDR = /^[0-9a-f]{40}$/;

// POST /api/utxo/spend — broadcast a UTXO transaction
// Body: { inputs: [{txHash, outputIndex, signature, publicKey}], outputs: [{address, amount}], fee }
// Each input must carry its own `signature` (hex) and `publicKey` (hex) —
// the signature is an ed25519 signature over utxoSigningMessage(input, outputs, fee)
// produced by the key that owns that specific UTXO. See chain/utxo.ts.
router.post("/utxo/spend", (req, res) => {
  const { inputs, outputs, fee = 1000 } = req.body ?? {};
  const cs = chainState;
  if (!inputs?.length || !outputs?.length) {
    return res.status(400).json({ error: "inputs and outputs are required" });
  }
  if (Number(fee) < 0) {
    return res.status(400).json({ error: "fee must be non-negative" });
  }
  for (const output of outputs) {
    if (!output?.address || !HEX_ADDR.test(output.address)) {
      return res.status(400).json({ error: `Invalid output address: ${output?.address}` });
    }
    if (output.amount == null || Number(output.amount) <= 0) {
      return res.status(400).json({ error: `Output amount must be positive` });
    }
  }
  for (const input of inputs) {
    if (!input?.signature || !input?.publicKey) {
      return res.status(400).json({
        error: `Input ${input?.txHash}:${input?.outputIndex} is missing signature/publicKey`,
      });
    }
  }

  const txHash = createHash("sha256")
    .update(JSON.stringify({
      inputs: inputs.map((i: { txHash: string; outputIndex: number }) => ({ txHash: i.txHash, outputIndex: i.outputIndex })),
      outputs,
      fee,
    }))
    .digest("hex");

  const tx = {
    hash: txHash,
    inputs,
    outputs,
    fee: Number(fee),
    blockHeight: null,
    timestamp: Date.now(),
    status: "pending" as const,
  };

  const error = cs.utxoSet.validateTransaction(tx);
  if (error) return res.status(400).json({ error });

  cs.utxoSet.applyTransaction(tx);

  return res.json({ success: true, txHash, message: "UTXO transaction applied" });
});

export default router;
