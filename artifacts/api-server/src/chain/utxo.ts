// ── Full UTXO Model ─────────────────────────────────────────────────────────────
//
// Each coin is a UTXO (Unspent Transaction Output) identified by (txHash, outputIndex).
// Transactions reference previous UTXOs as inputs and create new UTXOs as outputs.
// This enables parallel validation: inputs from different tx can be validated concurrently.

import { ed25519 } from "@noble/curves/ed25519.js";
import { createHash } from "crypto";

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

/** Derive an address from a hex-encoded public key: SHA-256(pubKeyHex).slice(0, 40). */
export function addressFromPubKey(pubKeyHex: string): string {
  return createHash("sha256").update(pubKeyHex).digest("hex").slice(0, 40);
}

/**
 * Canonical message each input's owner signs: binds the specific input being
 * spent to the full set of outputs and fee, so a signature can't be replayed
 * against a different spend of the same coin.
 */
export function utxoSigningMessage(
  input: Pick<UTXOInput, "txHash" | "outputIndex">,
  outputs: UTXOOutput[],
  fee: number,
): Uint8Array {
  const payload = JSON.stringify({
    txHash: input.txHash,
    outputIndex: input.outputIndex,
    outputs,
    fee,
  });
  return new TextEncoder().encode(payload);
}

export interface UTXO {
  txHash: string;
  outputIndex: number;
  address: string;
  amount: number;
  coinbase: boolean;
  blockHeight: number;
  spent: boolean;
  spentByTxHash?: string;
}

export interface UTXOInput {
  txHash: string;
  outputIndex: number;
  signature?: string;
  publicKey?: string;
}

export interface UTXOOutput {
  address: string;
  amount: number;
}

export interface UTXOTransaction {
  hash: string;
  inputs: UTXOInput[];
  outputs: UTXOOutput[];
  fee: number;
  blockHeight: number | null;
  timestamp: number;
  status: "pending" | "confirmed" | "failed";
}

export class UTXOSet {
  private utxos = new Map<string, UTXO>();
  private addressIndex = new Map<string, Set<string>>();

  private key(txHash: string, outputIndex: number): string {
    return `${txHash}:${outputIndex}`;
  }

  add(utxo: UTXO): void {
    const k = this.key(utxo.txHash, utxo.outputIndex);
    this.utxos.set(k, utxo);
    if (!this.addressIndex.has(utxo.address)) {
      this.addressIndex.set(utxo.address, new Set());
    }
    this.addressIndex.get(utxo.address)!.add(k);
  }

  get(txHash: string, outputIndex: number): UTXO | undefined {
    return this.utxos.get(this.key(txHash, outputIndex));
  }

  spend(txHash: string, outputIndex: number, spentByTxHash: string): boolean {
    const k = this.key(txHash, outputIndex);
    const utxo = this.utxos.get(k);
    if (!utxo || utxo.spent) return false;
    utxo.spent = true;
    utxo.spentByTxHash = spentByTxHash;
    return true;
  }

  getUnspent(address: string): UTXO[] {
    const keys = this.addressIndex.get(address) ?? new Set();
    return [...keys]
      .map(k => this.utxos.get(k))
      .filter((u): u is UTXO => !!u && !u.spent);
  }

  getAll(address: string): UTXO[] {
    const keys = this.addressIndex.get(address) ?? new Set();
    return [...keys]
      .map(k => this.utxos.get(k))
      .filter((u): u is UTXO => !!u);
  }

  balance(address: string): number {
    return this.getUnspent(address).reduce((s, u) => s + u.amount, 0);
  }

  totalSupply(): number {
    let total = 0;
    for (const u of this.utxos.values()) {
      if (!u.spent) total += u.amount;
    }
    return total;
  }

  size(): number {
    let count = 0;
    for (const u of this.utxos.values()) {
      if (!u.spent) count++;
    }
    return count;
  }

  /**
   * Validate a UTXO transaction:
   *  - All inputs must exist and be unspent
   *  - Input total must equal output total + fee
   *  - Each input must carry a valid ed25519 signature from the key that
   *    owns the UTXO being spent (publicKey's derived address == utxo.address)
   */
  validateTransaction(tx: UTXOTransaction): string | null {
    let inputTotal = 0;

    for (const input of tx.inputs) {
      const utxo = this.get(input.txHash, input.outputIndex);
      if (!utxo) return `UTXO ${input.txHash}:${input.outputIndex} not found`;
      if (utxo.spent) return `UTXO ${input.txHash}:${input.outputIndex} already spent`;

      if (!input.signature || !input.publicKey) {
        return `Input ${input.txHash}:${input.outputIndex} missing signature or publicKey`;
      }

      const derivedAddress = addressFromPubKey(input.publicKey);
      if (derivedAddress !== utxo.address) {
        return `Input ${input.txHash}:${input.outputIndex} publicKey does not match UTXO owner`;
      }

      let sigValid = false;
      try {
        const message = utxoSigningMessage(input, tx.outputs, tx.fee);
        sigValid = ed25519.verify(
          hexToBytes(input.signature),
          message,
          hexToBytes(input.publicKey),
        );
      } catch {
        sigValid = false;
      }
      if (!sigValid) {
        return `Input ${input.txHash}:${input.outputIndex} has an invalid signature`;
      }

      inputTotal += utxo.amount;
    }

    const outputTotal = tx.outputs.reduce((s, o) => s + o.amount, 0);
    const computed = outputTotal + tx.fee;

    if (computed !== inputTotal) {
      return `Input total ${inputTotal} ≠ output total ${outputTotal} + fee ${tx.fee}`;
    }

    for (const output of tx.outputs) {
      if (output.amount <= 0) return "Output amount must be positive";
      if (output.address.length !== 40) return "Invalid output address";
    }

    return null;
  }

  /**
   * Apply a validated UTXO transaction: spend inputs, create outputs.
   * Call validateTransaction first!
   */
  applyTransaction(tx: UTXOTransaction): void {
    for (const input of tx.inputs) {
      this.spend(input.txHash, input.outputIndex, tx.hash);
    }
    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i]!;
      this.add({
        txHash: tx.hash,
        outputIndex: i,
        address: output.address,
        amount: output.amount,
        coinbase: false,
        blockHeight: tx.blockHeight ?? 0,
        spent: false,
      });
    }
  }

  /**
   * Undo a previously-applied UTXO transaction (used for chain reorgs):
   * un-spends the inputs and removes the outputs it created.
   */
  undoTransaction(tx: UTXOTransaction): void {
    for (const input of tx.inputs) {
      const k = this.key(input.txHash, input.outputIndex);
      const utxo = this.utxos.get(k);
      if (utxo && utxo.spent && utxo.spentByTxHash === tx.hash) {
        utxo.spent = false;
        utxo.spentByTxHash = undefined;
      }
    }
    for (let i = 0; i < tx.outputs.length; i++) {
      const k = this.key(tx.hash, i);
      const utxo = this.utxos.get(k);
      if (utxo) {
        this.utxos.delete(k);
        this.addressIndex.get(utxo.address)?.delete(k);
      }
    }
  }

  /**
   * Remove a single UTXO by (txHash, outputIndex) — used for chain reorgs
   * when a block is rolled back and the coinbase/output it minted must be
   * un-created. No-op if the UTXO doesn't exist.
   */
  remove(txHash: string, outputIndex: number): void {
    const k = this.key(txHash, outputIndex);
    const utxo = this.utxos.get(k);
    if (!utxo) return;
    this.utxos.delete(k);
    this.addressIndex.get(utxo.address)?.delete(k);
  }

  /** Convenience alias for removing a coinbase UTXO (always outputIndex 0). */
  removeCoinbase(txHash: string): void {
    this.remove(txHash, 0);
  }

  /**
   * Create a coinbase UTXO (block reward).
   */
  addCoinbase(txHash: string, address: string, amount: number, blockHeight: number): UTXO {
    const utxo: UTXO = {
      txHash,
      outputIndex: 0,
      address,
      amount,
      coinbase: true,
      blockHeight,
      spent: false,
    };
    this.add(utxo);
    return utxo;
  }

  /**
   * Select UTXOs for a new transaction (greedy coin selection).
   * Returns selected UTXOs and change amount.
   */
  selectCoins(
    address: string,
    targetAmount: number,
    fee: number,
  ): { selected: UTXO[]; change: number } | null {
    const unspent = this.getUnspent(address).sort((a, b) => b.amount - a.amount);
    const target = targetAmount + fee;
    const selected: UTXO[] = [];
    let total = 0;

    for (const u of unspent) {
      selected.push(u);
      total += u.amount;
      if (total >= target) break;
    }

    if (total < target) return null;
    return { selected, change: total - target };
  }
}
