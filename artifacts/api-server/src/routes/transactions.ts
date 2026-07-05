import { Router } from "express";
import { createHash } from "crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { chainState } from "../chain/index.js";
import { hash256 } from "../chain/crypto.js";

const router = Router();

const HEX_ADDR = /^[0-9a-f]{40}$/;

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function addressFromPubKeyBytes(pubKeyHex: string): string {
  const bytes = Buffer.from(pubKeyHex, "hex");
  return createHash("sha256").update(bytes).digest("hex").slice(0, 40);
}

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
  };

  if (!body.from || !body.to || body.amount == null || body.fee == null || body.nonce == null) {
    res.status(400).json({ error: "Missing required fields: from, to, amount, fee, nonce" });
    return;
  }
  if (!HEX_ADDR.test(body.from)) {
    res.status(400).json({ error: "Invalid from address: must be 40 lowercase hex chars" });
    return;
  }
  if (!HEX_ADDR.test(body.to)) {
    res.status(400).json({ error: "Invalid to address: must be 40 lowercase hex chars" });
    return;
  }
  if (body.amount <= 0 || body.fee < 0) {
    res.status(400).json({ error: "Amount must be positive, fee must be non-negative" });
    return;
  }

  const requireSig = process.env["REQUIRE_TX_SIGNATURES"] === "true";
  if (requireSig && (!body.signature || !body.publicKey)) {
    res.status(401).json({ error: "Signed transactions required: provide signature and publicKey" });
    return;
  }

  if (body.signature || body.publicKey) {
    if (!body.signature || !body.publicKey) {
      res.status(400).json({ error: "Both signature and publicKey must be provided together" });
      return;
    }
    try {
      const derivedAddress = addressFromPubKeyBytes(body.publicKey);
      if (derivedAddress !== body.from) {
        res.status(401).json({ error: "publicKey does not match from address" });
        return;
      }
      const msgBytes = new TextEncoder().encode(
        `${body.from}${body.to}${body.amount}${body.fee}${body.nonce}`
      );
      const sigBytes = hexToBytes(body.signature);
      const pubBytes = hexToBytes(body.publicKey);
      const valid = ed25519.verify(sigBytes, msgBytes, pubBytes);
      if (!valid) {
        res.status(401).json({ error: "Invalid transaction signature" });
        return;
      }
    } catch {
      res.status(400).json({ error: "Malformed signature or publicKey" });
      return;
    }
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
    signature: body.signature,
    publicKey: body.publicKey,
  };

  chainState.mempool.add(tx);
  chainState.gossipTx(txHash);
  res.json({ txHash, status: "pending" });
});

export default router;
