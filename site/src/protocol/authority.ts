import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "./bytes";
import { addressFromPubkeyHex } from "./crypto";
import type { Keypair } from "./wallet";

ed.hashes.sha512 = sha512;

export type StakeOp = "delegate" | "claim" | "propose" | "vote" | "model";

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
  if (input.op !== "delegate" && input.op !== "claim" && input.op !== "propose" && input.op !== "vote" && input.op !== "model") {
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
