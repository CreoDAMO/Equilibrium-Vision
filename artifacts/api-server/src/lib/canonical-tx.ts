import { createHash } from "crypto";
import { ed25519 } from "@noble/curves/ed25519.js";

/**
 * The same bytes `site/src/protocol/wallet.ts` signs.
 * A UTF-8 concatenation of the fields is not this message.
 * chainId is in the message so a testnet signature is not a mainnet signature.
 */
export function canonicalSigningBytes(tx: {
  from: string;
  to: string;
  amount: number;
  fee: number;
  nonce: number;
  publicKey: string;
  chainId: number;
}): Buffer {
  const buf = Buffer.alloc(20 + 20 + 8 + 8 + 8 + 32 + 8);
  Buffer.from(tx.from, "hex").copy(buf, 0);
  Buffer.from(tx.to, "hex").copy(buf, 20);
  buf.writeBigUInt64LE(BigInt(tx.amount), 40);
  buf.writeBigUInt64LE(BigInt(tx.fee), 48);
  buf.writeBigUInt64LE(BigInt(tx.nonce), 56);
  Buffer.from(tx.publicKey, "hex").copy(buf, 64);
  buf.writeBigUInt64LE(BigInt(tx.chainId), 96);
  return buf;
}

export function canonicalTxHash(message: Buffer, signature: Buffer): string {
  return createHash("sha256").update(Buffer.concat([message, signature])).digest("hex");
}

const HEX_ADDR = /^[0-9a-f]{40}$/;
const HEX_PUB = /^[0-9a-f]{64}$/;
const HEX_SIG = /^[0-9a-f]{128}$/;
const HEX_HASH = /^[0-9a-f]{64}$/;

export function verifyCanonicalTx(body: {
  from?: string;
  to?: string;
  amount?: number;
  fee?: number;
  nonce?: number;
  signature?: string;
  publicKey?: string;
  chainId?: number;
  hash?: string;
}): { ok: true; hash: string } | { ok: false; status: number; error: string } {
  if (!body.signature || !body.publicKey || body.chainId == null || !body.hash) {
    return { ok: false, status: 401, error: "signature required" };
  }
  if (!body.from || !HEX_ADDR.test(body.from)) return { ok: false, status: 400, error: "from address refused" };
  if (!body.to || !HEX_ADDR.test(body.to)) return { ok: false, status: 400, error: "to address refused" };
  if (!Number.isSafeInteger(body.amount) || body.amount <= 0) return { ok: false, status: 400, error: "amount refused" };
  if (!Number.isSafeInteger(body.fee) || body.fee < 0) return { ok: false, status: 400, error: "fee refused" };
  if (!Number.isSafeInteger(body.nonce) || body.nonce < 0) return { ok: false, status: 400, error: "nonce refused" };
  if (!Number.isSafeInteger(body.chainId) || body.chainId < 0) return { ok: false, status: 400, error: "chain id refused" };
  if (!HEX_PUB.test(body.publicKey) || !HEX_SIG.test(body.signature) || !HEX_HASH.test(body.hash)) {
    return { ok: false, status: 400, error: "signature refused" };
  }
  const derived = createHash("sha256").update(Buffer.from(body.publicKey, "hex")).digest("hex").slice(0, 40);
  if (derived !== body.from) return { ok: false, status: 401, error: "publicKey does not match from address" };
  const message = canonicalSigningBytes({
    from: body.from,
    to: body.to,
    amount: body.amount,
    fee: body.fee,
    nonce: body.nonce,
    publicKey: body.publicKey,
    chainId: body.chainId,
  });
  const signature = Buffer.from(body.signature, "hex");
  const hash = canonicalTxHash(message, signature);
  if (hash !== body.hash) return { ok: false, status: 401, error: "hash is not this signature" };
  let valid = false;
  try {
    valid = ed25519.verify(signature, message, Buffer.from(body.publicKey, "hex"));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, status: 401, error: "signature refused" };
  return { ok: true, hash };
}
