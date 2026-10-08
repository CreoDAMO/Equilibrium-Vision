import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "./bytes";
import { addressFromPubkeyHex, sha256Hex } from "./crypto";
import type { Keypair } from "./wallet";

ed.hashes.sha512 = sha512;

export type StakeOp = "delegate" | "claim" | "propose" | "vote" | "model" | "unbond";

export interface StakeClaim {
  op: StakeOp;
  chainId: number;
  validator?: string;
  amount?: number;
  title?: string;
  id?: number;
  option?: string;
  uri?: string;
}

/** UTF-8. Every field is bound. A signature for one amount is not a signature for another. */
export function authorityPreimage(address: string, claim: StakeClaim): string {
  return [
    "eq-authority",
    "v1",
    String(claim.chainId),
    claim.op,
    address,
    claim.validator ?? "",
    claim.amount == null ? "" : String(claim.amount),
    claim.title ?? "",
    claim.id == null ? "" : String(claim.id),
    claim.option ?? "",
    claim.uri ?? "",
  ].join("|");
}

export function wasmPreimage(address: string, chainId: number, method: "init" | "pause" | "unpause"): string {
  return ["eq-authority", "v1", String(chainId), "wasm", address, method].join("|");
}

export function signAuthority(kp: Keypair, claim: StakeClaim): { address: string; publicKey: string; signature: string } {
  const signature = bytesToHex(ed.sign(new TextEncoder().encode(authorityPreimage(kp.address, claim)), hexToBytes(kp.privateKey)));
  return { address: kp.address, publicKey: kp.publicKey, signature };
}

export function signWasm(kp: Keypair, chainId: number, method: "init" | "pause" | "unpause"): { address: string; publicKey: string; signature: string } {
  const signature = bytesToHex(ed.sign(new TextEncoder().encode(wasmPreimage(kp.address, chainId, method)), hexToBytes(kp.privateKey)));
  return { address: kp.address, publicKey: kp.publicKey, signature };
}

function verified(publicKey: string, signature: string, message: string, address: string): boolean {
  try {
    if (addressFromPubkeyHex(publicKey) !== address) return false;
    return ed.verify(hexToBytes(signature), new TextEncoder().encode(message), hexToBytes(publicKey));
  } catch {
    return false;
  }
}

export function gateStakeAction(input: StakeClaim & {
  op: string;
  address?: string;
  publicKey?: string;
  signature?: string;
}): { ok: true; address: string } | { ok: false; error: string } {
  if (input.op === "slash") return { ok: false, error: "slash is not a public caller action" };
  if (input.op !== "delegate" && input.op !== "claim" && input.op !== "propose" && input.op !== "vote" && input.op !== "model" && input.op !== "unbond") {
    return { ok: false, error: "unknown op" };
  }
  if (!input.publicKey || !input.signature) return { ok: false, error: "signature required" };
  let address: string;
  try {
    address = addressFromPubkeyHex(input.publicKey);
  } catch {
    return { ok: false, error: "publicKey refused" };
  }
  const claimed = input.address?.trim().toLowerCase().replace(/^0x/, "") ?? "";
  if (claimed && claimed !== address) return { ok: false, error: "address is not the signing key" };
  const claim: StakeClaim = {
    op: input.op,
    chainId: input.chainId,
    validator: input.validator,
    amount: input.amount,
    title: input.title,
    id: input.id,
    option: input.option,
    uri: input.uri,
  };
  if (!verified(input.publicKey, input.signature, authorityPreimage(address, claim), address)) {
    return { ok: false, error: "signature refused" };
  }
  return { ok: true, address };
}

/** Proof-carrying delegate. A failure here is before any debit. */
export function verifyDelegateEvidence(
  chainId: number,
  op: { delegator: string; validator: string; amount: number; publicKey?: string; signature?: string },
): string | null {
  const publicKey = op.publicKey ?? "";
  const signature = op.signature ?? "";
  if (!/^[0-9a-f]{40}$/.test(op.delegator)) return "delegate authority refused";
  if (!/^[0-9a-f]{40}$/.test(op.validator)) return "delegate authority refused";
  if (!/^[0-9a-f]{64}$/.test(publicKey)) return "delegate authority refused";
  if (!/^[0-9a-f]{128}$/.test(signature)) return "delegate authority refused";
  if (!Number.isSafeInteger(op.amount) || op.amount <= 0) return "delegate authority refused";
  const claim: StakeClaim = {
    op: "delegate",
    chainId,
    validator: op.validator,
    amount: op.amount,
  };
  if (!verified(publicKey, signature, authorityPreimage(op.delegator, claim), op.delegator)) {
    return "delegate authority refused";
  }
  return null;
}

/** Proof-carrying unbond. A delegate signature is not this signature. A failure here is before any release. */
export function verifyUnbondEvidence(
  chainId: number,
  op: { delegator: string; validator: string; amount: number; publicKey?: string; signature?: string },
): string | null {
  const publicKey = op.publicKey ?? "";
  const signature = op.signature ?? "";
  if (!/^[0-9a-f]{40}$/.test(op.delegator)) return "unbond authority refused";
  if (!/^[0-9a-f]{40}$/.test(op.validator)) return "unbond authority refused";
  if (!/^[0-9a-f]{64}$/.test(publicKey)) return "unbond authority refused";
  if (!/^[0-9a-f]{128}$/.test(signature)) return "unbond authority refused";
  if (!Number.isSafeInteger(op.amount) || op.amount <= 0) return "unbond authority refused";
  const claim: StakeClaim = {
    op: "unbond",
    chainId,
    validator: op.validator,
    amount: op.amount,
  };
  if (!verified(publicKey, signature, authorityPreimage(op.delegator, claim), op.delegator)) {
    return "unbond authority refused";
  }
  return null;
}

export function gateWasmCaller(input: {
  method: "init" | "pause" | "unpause";
  chainId: number;
  caller?: string;
  publicKey?: string;
  signature?: string;
}): { ok: true; address: string } | { ok: false; error: string } {
  if (!input.publicKey || !input.signature) return { ok: false, error: "signature required" };
  let address: string;
  try {
    address = addressFromPubkeyHex(input.publicKey);
  } catch {
    return { ok: false, error: "publicKey refused" };
  }
  const claimed = input.caller?.trim().toLowerCase().replace(/^0x/, "") ?? "";
  if (claimed && claimed !== address) return { ok: false, error: "caller is not the signing key" };
  if (!verified(input.publicKey, input.signature, wasmPreimage(address, input.chainId, input.method), address)) {
    return { ok: false, error: "signature refused" };
  }
  return { ok: true, address };
}

export interface WithdrawClaim {
  chainId: number;
  sender: string;
  amount: number;
  network: "btc" | "eth";
  asset: string;
  destination: string;
  nonce: number;
}

/** Not a transfer, and not a stake signature. Every field of the obligation is bound. */
export function withdrawPreimage(claim: WithdrawClaim): string {
  return [
    "eq-authority",
    "v1",
    String(claim.chainId),
    "withdraw",
    claim.sender,
    String(claim.amount),
    claim.network,
    claim.asset,
    claim.destination,
    String(claim.nonce),
  ].join("|");
}

/** Identity of the obligation. The external transaction is not this hash. */
export function withdrawalCommitment(claim: WithdrawClaim): string {
  return [
    "eq-withdrawal",
    "v1",
    String(claim.chainId),
    claim.sender,
    String(claim.amount),
    claim.network,
    claim.asset,
    claim.destination,
    String(claim.nonce),
  ].join("|");
}

export function withdrawalId(claim: WithdrawClaim): string {
  return sha256Hex(withdrawalCommitment(claim));
}

/** Nobody holds this key. Locked EQU sits here until settle destroys it or refund returns it. */
export const WITHDRAWAL_ESCROW = sha256Hex("eq-withdrawal-escrow|v1").slice(0, 40);

export function signWithdraw(kp: Keypair, claim: Omit<WithdrawClaim, "sender">): {
  address: string;
  publicKey: string;
  signature: string;
  id: string;
} {
  const full: WithdrawClaim = { ...claim, sender: kp.address };
  const signature = bytesToHex(ed.sign(new TextEncoder().encode(withdrawPreimage(full)), hexToBytes(kp.privateKey)));
  return { address: kp.address, publicKey: kp.publicKey, signature, id: withdrawalId(full) };
}

/** Proof-carrying withdrawal. A failure here is before any debit. */
export function verifyWithdrawEvidence(
  chainId: number,
  op: {
    sender: string;
    amount: number;
    network: string;
    asset: string;
    destination: string;
    nonce: number;
    publicKey?: string;
    signature?: string;
  },
): string | null {
  const publicKey = op.publicKey ?? "";
  const signature = op.signature ?? "";
  if (!/^[0-9a-f]{40}$/.test(op.sender)) return "withdraw authority refused";
  if (!/^[0-9a-f]{64}$/.test(publicKey)) return "withdraw authority refused";
  if (!/^[0-9a-f]{128}$/.test(signature)) return "withdraw authority refused";
  if (!Number.isSafeInteger(op.amount) || op.amount <= 0) return "withdraw authority refused";
  if (!Number.isSafeInteger(op.nonce) || op.nonce < 0) return "withdraw authority refused";
  if (op.network !== "btc" && op.network !== "eth") return "withdraw authority refused";
  if (typeof op.asset !== "string" || op.asset.length === 0 || op.asset.length > 32) return "withdraw authority refused";
  if (typeof op.destination !== "string" || op.destination.length === 0 || op.destination.length > 80) return "withdraw authority refused";
  const claim: WithdrawClaim = {
    chainId,
    sender: op.sender,
    amount: op.amount,
    network: op.network,
    asset: op.asset,
    destination: op.destination,
    nonce: op.nonce,
  };
  if (!verified(publicKey, signature, withdrawPreimage(claim), op.sender)) return "withdraw authority refused";
  return null;
}
