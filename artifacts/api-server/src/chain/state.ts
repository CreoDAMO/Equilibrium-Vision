import type { BlockRecord, TxRecord, AccountState, PeerRecord } from "./types.js";
import { merkleRoot, randomHex, addressFromSeed, hash256 } from "./crypto.js";

// ── Ledger ─────────────────────────────────────────────────────────────────────

export class Ledger {
  private accounts = new Map<string, AccountState>();

  balance(addr: string): number {
    return this.accounts.get(addr)?.balance ?? 0;
  }

  nonce(addr: string): number {
    return this.accounts.get(addr)?.nonce ?? 0;
  }

  credit(addr: string, amount: number): void {
    const acc = this.accounts.get(addr) ?? { balance: 0, nonce: 0 };
    acc.balance += amount;
    this.accounts.set(addr, acc);
  }

  applyTx(tx: TxRecord): string | null {
    const sender = this.accounts.get(tx.from) ?? { balance: 0, nonce: 0 };
    if (tx.nonce !== sender.nonce) {
      return `bad nonce: expected ${sender.nonce}, got ${tx.nonce}`;
    }
    const total = tx.amount + tx.fee;
    if (sender.balance < total) {
      return `insufficient funds: have ${sender.balance}, need ${total}`;
    }
    sender.balance -= total;
    sender.nonce += 1;
    this.accounts.set(tx.from, sender);

    const recipient = this.accounts.get(tx.to) ?? { balance: 0, nonce: 0 };
    recipient.balance += tx.amount;
    this.accounts.set(tx.to, recipient);
    return null;
  }

  getAccount(addr: string): AccountState {
    return this.accounts.get(addr) ?? { balance: 0, nonce: 0 };
  }
}

// ── Mempool ────────────────────────────────────────────────────────────────────

export class Mempool {
  private txs = new Map<string, TxRecord>();

  add(tx: TxRecord): void {
    this.txs.set(tx.hash, tx);
  }

  remove(hashes: string[]): void {
    for (const h of hashes) this.txs.delete(h);
  }

  all(): TxRecord[] {
    return [...this.txs.values()].sort((a, b) => b.fee - a.fee);
  }

  get size(): number {
    return this.txs.size;
  }

  get pressure(): number {
    return Math.min(this.size / 500, 1.0);
  }

  has(hash: string): boolean {
    return this.txs.has(hash);
  }

  get(hash: string): TxRecord | undefined {
    return this.txs.get(hash);
  }
}

// ── Chain State ────────────────────────────────────────────────────────────────

export class ChainState {
  blocks: BlockRecord[] = [];
  txIndex = new Map<string, TxRecord>();
  addressTxs = new Map<string, Set<string>>();
  ledger = new Ledger();
  mempool = new Mempool();
  peers: PeerRecord[] = [];
  blockStats: Array<{
    height: number;
    txCount: number;
    residual: number;
    mempoolPressure: number;
    timestamp: number;
  }> = [];

  get height(): number {
    return this.blocks.length - 1;
  }

  get latestBlock(): BlockRecord | undefined {
    return this.blocks[this.blocks.length - 1];
  }

  get totalTxCount(): number {
    return this.txIndex.size;
  }

  get avgBlockTime(): number {
    if (this.blocks.length < 2) return 0;
    const recent = this.blocks.slice(-10);
    const deltas = recent
      .slice(1)
      .map((b, i) => b.timestamp - recent[i].timestamp)
      .filter((d) => d > 0);
    if (deltas.length === 0) return 0;
    return deltas.reduce((a, b) => a + b, 0) / deltas.length;
  }

  get tps(): number {
    if (this.blocks.length < 2) return 0;
    const recent = this.blocks.slice(-10);
    const txs = recent.reduce((a, b) => a + b.txCount, 0);
    const elapsed =
      (recent[recent.length - 1].timestamp - recent[0].timestamp) || 1;
    return txs / elapsed;
  }

  addBlock(block: BlockRecord): void {
    this.blocks.push(block);

    for (const tx of block.transactions) {
      const confirmed: TxRecord = { ...tx, blockHash: block.hash, blockHeight: block.height, status: "confirmed" };
      this.txIndex.set(tx.hash, confirmed);
      this.mempool.remove([tx.hash]);

      for (const addr of [tx.from, tx.to]) {
        if (!this.addressTxs.has(addr)) this.addressTxs.set(addr, new Set());
        this.addressTxs.get(addr)!.add(tx.hash);
      }
    }

    this.blockStats.push({
      height: block.height,
      txCount: block.txCount,
      residual: block.residual,
      mempoolPressure: this.mempool.pressure,
      timestamp: block.timestamp,
    });
    if (this.blockStats.length > 50) this.blockStats.shift();
  }

  getBlockByHash(hash: string): BlockRecord | undefined {
    return this.blocks.find((b) => b.hash === hash);
  }

  getBlockByHeight(height: number): BlockRecord | undefined {
    return this.blocks[height];
  }

  getTx(hash: string): TxRecord | undefined {
    return this.txIndex.get(hash) ?? this.mempool.get(hash);
  }

  getAddressTxs(addr: string): TxRecord[] {
    const hashes = this.addressTxs.get(addr) ?? new Set();
    return [...hashes]
      .map((h) => this.txIndex.get(h))
      .filter(Boolean) as TxRecord[];
  }
}

// ── Genesis & Seeding ──────────────────────────────────────────────────────────

function makeAddress(label: string): string {
  return addressFromSeed(label);
}

export function buildGenesisChain(): ChainState {
  const state = new ChainState();

  // Known addresses
  const miner1 = makeAddress("equilibrium-miner-1");
  const miner2 = makeAddress("equilibrium-miner-2");
  const alice  = makeAddress("equilibrium-alice");
  const bob    = makeAddress("equilibrium-bob");
  const carol  = makeAddress("equilibrium-carol");

  // Seed peers
  state.peers = [
    { peerId: randomHex(20), address: "192.168.1.10:30303", latencyMs: 12,  height: 0, connected: true  },
    { peerId: randomHex(20), address: "10.0.0.55:30303",    latencyMs: 34,  height: 0, connected: true  },
    { peerId: randomHex(20), address: "172.16.0.3:30303",   latencyMs: 89,  height: 0, connected: false },
    { peerId: randomHex(20), address: "203.0.113.7:30303",  latencyMs: 142, height: 0, connected: true  },
  ];

  // Build 25 genesis blocks
  const BASE_REWARD = 50_000_000;
  const DIFFICULTY = 1_000_000;
  const miners = [miner1, miner2];
  let now = Math.floor(Date.now() / 1000) - 25 * 15;

  let prevHash = "0".repeat(64);

  for (let h = 0; h <= 24; h++) {
    const miner = miners[h % 2];
    const residual = Math.random() * 1e-8;
    const quality = 1.0 / (residual + 1e-6);
    const reward = Math.floor(BASE_REWARD * Math.min(quality, 1.0));
    state.ledger.credit(miner, reward);

    const txs: TxRecord[] = [];
    const blockHash = hash256(`block-${h}-${prevHash}`);

    // Add some transfers after block 3
    if (h >= 3) {
      const txHash = hash256(`tx-${h}-alice`);
      const tx: TxRecord = {
        hash: txHash,
        from: miner,
        to: alice,
        amount: 1_000_000,
        fee: 1_000,
        nonce: Math.floor(h / 2),
        blockHash,
        blockHeight: h,
        timestamp: now,
        status: "confirmed",
      };
      txs.push(tx);
      state.txIndex.set(txHash, tx);
      if (!state.addressTxs.has(miner)) state.addressTxs.set(miner, new Set());
      if (!state.addressTxs.has(alice)) state.addressTxs.set(alice, new Set());
      state.addressTxs.get(miner)!.add(txHash);
      state.addressTxs.get(alice)!.add(txHash);
      state.ledger.credit(alice, 1_000_000);
    }
    if (h >= 8) {
      const txHash = hash256(`tx-${h}-bob`);
      const tx: TxRecord = {
        hash: txHash,
        from: alice,
        to: bob,
        amount: 250_000,
        fee: 500,
        nonce: Math.floor((h - 8) / 3),
        blockHash,
        blockHeight: h,
        timestamp: now,
        status: "confirmed",
      };
      txs.push(tx);
      state.txIndex.set(txHash, tx);
      if (!state.addressTxs.has(bob)) state.addressTxs.set(bob, new Set());
      state.addressTxs.get(alice)!.add(txHash);
      state.addressTxs.get(bob)!.add(txHash);
      state.ledger.credit(bob, 250_000);
    }
    if (h >= 15) {
      const txHash = hash256(`tx-${h}-carol`);
      const tx: TxRecord = {
        hash: txHash,
        from: bob,
        to: carol,
        amount: 50_000,
        fee: 200,
        nonce: h - 15,
        blockHash,
        blockHeight: h,
        timestamp: now,
        status: "confirmed",
      };
      txs.push(tx);
      state.txIndex.set(txHash, tx);
      if (!state.addressTxs.has(carol)) state.addressTxs.set(carol, new Set());
      state.addressTxs.get(bob)!.add(txHash);
      state.addressTxs.get(carol)!.add(txHash);
      state.ledger.credit(carol, 50_000);
    }

    const txHashes = txs.map((t) => t.hash);
    const mr = merkleRoot(txHashes.length > 0 ? txHashes : ["0".repeat(64)]);

    const block: BlockRecord = {
      hash: blockHash,
      height: h,
      prevHash,
      merkleRoot: mr,
      timestamp: now,
      nonce: Math.floor(Math.random() * 1e15),
      difficulty: DIFFICULTY,
      residual,
      recursionDepth: 2,
      coinbaseReward: reward,
      miner,
      txCount: txs.length,
      transactions: txs,
    };

    state.blocks.push(block);
    state.blockStats.push({
      height: h,
      txCount: txs.length,
      residual,
      mempoolPressure: 0.1 + Math.random() * 0.6,
      timestamp: now,
    });

    for (const p of state.peers) p.height = h;

    prevHash = blockHash;
    now += 12 + Math.floor(Math.random() * 6);
  }

  // Seed a few mempool transactions
  for (let i = 0; i < 6; i++) {
    const txHash = hash256(`mempool-${i}-${Date.now()}`);
    const tx: TxRecord = {
      hash: txHash,
      from: alice,
      to: carol,
      amount: 10_000 * (i + 1),
      fee: 100 + i * 50,
      nonce: 100 + i,
      blockHash: null,
      blockHeight: null,
      timestamp: Math.floor(Date.now() / 1000),
      status: "pending",
    };
    state.mempool.add(tx);
  }

  return state;
}

// ── Block miner (simulated Proof-of-Stationarity) ─────────────────────────────

export function mineNextBlock(state: ChainState, minerAddr: string): BlockRecord {
  const prev = state.latestBlock!;
  const height = state.height + 1;
  const now = Math.floor(Date.now() / 1000);

  // Pick top txs from mempool (up to 50)
  const selected = state.mempool.all().slice(0, 50);
  const txHashes = selected.map((t) => t.hash);
  const mr = merkleRoot(txHashes.length > 0 ? txHashes : ["0".repeat(64)]);

  // Simulate Lagrangian optimization residual
  const residual = Math.random() * 5e-9 + 1e-10;
  const quality = 1.0 / (residual + 1e-6);
  const reward = Math.floor(50_000_000 * Math.min(quality, 1.0));

  const blockHash = hash256(`block-${height}-${prev.hash}-${now}`);

  const txs: TxRecord[] = selected.map((t) => ({
    ...t,
    blockHash,
    blockHeight: height,
    status: "confirmed" as const,
  }));

  const block: BlockRecord = {
    hash: blockHash,
    height,
    prevHash: prev.hash,
    merkleRoot: mr,
    timestamp: now,
    nonce: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
    difficulty: 1_000_000,
    residual,
    recursionDepth: 2,
    coinbaseReward: reward,
    miner: minerAddr,
    txCount: txs.length,
    transactions: txs,
  };

  state.ledger.credit(minerAddr, reward);
  state.addBlock(block);
  return block;
}
