// ── Full UTXO Model ─────────────────────────────────────────────────────────────
//
// Each coin is a UTXO (Unspent Transaction Output) identified by (txHash, outputIndex).
// Transactions reference previous UTXOs as inputs and create new UTXOs as outputs.
// This enables parallel validation: inputs from different tx can be validated concurrently.

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
   *  - Each input's address must match the signing key (simplified: no sig check here)
   */
  validateTransaction(tx: UTXOTransaction): string | null {
    let inputTotal = 0;

    for (const input of tx.inputs) {
      const utxo = this.get(input.txHash, input.outputIndex);
      if (!utxo) return `UTXO ${input.txHash}:${input.outputIndex} not found`;
      if (utxo.spent) return `UTXO ${input.txHash}:${input.outputIndex} already spent`;
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
