import type {
  BlockRecord, TxRecord, AccountState, PeerRecord,
  ValidatorRecord, SlashEvent, FinalityRound, FinalityVote,
  DexPool, LiquidityPosition, SwapEvent, StakeRecord, UnbondingEntry, GossipEvent,
} from "./types.js";
import { merkleRoot, randomHex, addressFromSeed, hash256 } from "./crypto.js";
import { UTXOSet } from "./utxo.js";
import { WasmVM } from "./wasm.js";
import { generateZkProof } from "./zkproof.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE_REWARD = 50_000_000;
const TARGET_BLOCK_TIME = 15;
const INITIAL_DIFFICULTY = 1_000_000;
const UNBONDING_PERIOD = 10;
const DEX_FEE = 0.003;

// ── Ledger ────────────────────────────────────────────────────────────────────

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

  debit(addr: string, amount: number): boolean {
    const acc = this.accounts.get(addr) ?? { balance: 0, nonce: 0 };
    if (acc.balance < amount) return false;
    acc.balance -= amount;
    this.accounts.set(addr, acc);
    return true;
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

// ── Mempool ───────────────────────────────────────────────────────────────────

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

// ── Chain State ───────────────────────────────────────────────────────────────

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
    difficulty: number;
    blockTime: number;
  }> = [];

  // Adaptive difficulty
  currentDifficulty: number = INITIAL_DIFFICULTY;

  // Validators & slashing
  validators = new Map<string, ValidatorRecord>();
  slashEvents: SlashEvent[] = [];

  // Finality gadget
  finalizedHeight: number = -1;
  finalityRounds = new Map<number, FinalityRound>();

  // DEX AMM
  dexPools = new Map<string, DexPool>();
  liquidityPositions: LiquidityPosition[] = [];
  swapHistory: SwapEvent[] = [];

  // Staking
  stakes = new Map<string, StakeRecord>();
  unbondingQueue: UnbondingEntry[] = [];

  // Gossip log
  gossipLog: GossipEvent[] = [];

  // UTXO set (parallel-validation coin model)
  utxoSet = new UTXOSet();

  // WASM smart contract VM
  wasmVM = new WasmVM();

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
    if (this.blocks.length < 2) return TARGET_BLOCK_TIME;
    const recent = this.blocks.slice(-10);
    const deltas = recent
      .slice(1)
      .map((b, i) => b.timestamp - recent[i]!.timestamp)
      .filter((d) => d > 0);
    if (deltas.length === 0) return TARGET_BLOCK_TIME;
    return deltas.reduce((a, b) => a + b, 0) / deltas.length;
  }

  get tps(): number {
    if (this.blocks.length < 2) return 0;
    const recent = this.blocks.slice(-10);
    const txs = recent.reduce((a, b) => a + b.txCount, 0);
    const elapsed = (recent[recent.length - 1]!.timestamp - recent[0]!.timestamp) || 1;
    return txs / elapsed;
  }

  get totalBondedStake(): number {
    let total = 0;
    for (const v of this.validators.values()) {
      if (!v.slashed && !v.jailed) total += v.bondedStake;
    }
    return total;
  }

  // ── Adaptive Difficulty ──────────────────────────────────────────────────────

  updateDifficulty(): void {
    const avg = this.avgBlockTime;
    if (avg === 0) return;
    const ratio = TARGET_BLOCK_TIME / avg;
    // Clamp adjustment to ±20% per block
    const factor = Math.max(0.80, Math.min(1.20, ratio));
    this.currentDifficulty = Math.max(100_000, Math.floor(this.currentDifficulty * factor));
  }

  // ── Block management ─────────────────────────────────────────────────────────

  addBlock(block: BlockRecord): void {
    this.blocks.push(block);

    // Coinbase UTXO for block reward
    const coinbaseTxHash = hash256(`coinbase-${block.height}-${block.hash}`);
    this.utxoSet.addCoinbase(coinbaseTxHash, block.miner, block.coinbaseReward, block.height);

    for (const tx of block.transactions) {
      const confirmed: TxRecord = { ...tx, blockHash: block.hash, blockHeight: block.height, status: "confirmed" };
      this.txIndex.set(tx.hash, confirmed);
      this.mempool.remove([tx.hash]);

      for (const addr of [tx.from, tx.to]) {
        if (!this.addressTxs.has(addr)) this.addressTxs.set(addr, new Set());
        this.addressTxs.get(addr)!.add(tx.hash);
      }

      // Create UTXOs for confirmed transfers (recipient output + change output)
      this.utxoSet.add({
        txHash: tx.hash,
        outputIndex: 0,
        address: tx.to,
        amount: tx.amount,
        coinbase: false,
        blockHeight: block.height,
        spent: false,
      });
      if (tx.fee > 0) {
        // Fee is burned (no UTXO created); change goes to miner implicitly via coinbase
      }
    }

    const prevBlock = this.blocks[this.blocks.length - 2];
    const blockTime = prevBlock ? block.timestamp - prevBlock.timestamp : TARGET_BLOCK_TIME;

    this.blockStats.push({
      height: block.height,
      txCount: block.txCount,
      residual: block.residual,
      mempoolPressure: this.mempool.pressure,
      timestamp: block.timestamp,
      difficulty: this.currentDifficulty,
      blockTime,
    });
    if (this.blockStats.length > 50) this.blockStats.shift();

    this.updateDifficulty();
    this.runFinalityRound(block);
    this.processUnbonding(block.height);
    this.distributeBlockReward(block);
  }

  // ── Chain reorganization ─────────────────────────────────────────────────────
  //
  // Rolls the chain back to `targetHeight` (inclusive of that block, exclusive
  // of everything above it), undoing UTXO effects and returning any non-coinbase
  // transactions to the mempool so they can be re-included by the winning fork.
  // Never rolls back a finalized block — the finality gadget's decision is final.
  rollbackToHeight(targetHeight: number): BlockRecord[] {
    if (targetHeight >= this.height) return [];
    if (targetHeight < this.finalizedHeight) {
      throw new Error(
        `Cannot roll back to height ${targetHeight}: chain is finalized up to ${this.finalizedHeight}`,
      );
    }

    const removed: BlockRecord[] = [];
    while (this.height > targetHeight) {
      const block = this.blocks.pop();
      if (!block) break;
      removed.push(block);

      // Undo coinbase UTXO for this block's reward.
      const coinbaseTxHash = hash256(`coinbase-${block.height}-${block.hash}`);
      this.utxoSet.removeCoinbase(coinbaseTxHash);

      for (const tx of block.transactions) {
        // Undo the recipient-output UTXO created for this transfer.
        this.utxoSet.remove(tx.hash, 0);

        // Return the tx to the mempool as pending (unless it no longer applies).
        this.txIndex.delete(tx.hash);
        const pending: TxRecord = { ...tx, blockHash: null, blockHeight: null, status: "pending" };
        this.mempool.add(pending);

        for (const addr of [tx.from, tx.to]) {
          this.addressTxs.get(addr)?.delete(tx.hash);
        }
      }

      // Drop stats/finality bookkeeping tied to the removed block.
      this.blockStats = this.blockStats.filter((s) => s.height !== block.height);
      this.finalityRounds.delete(block.height);
    }

    return removed;
  }

  /**
   * Attempt a chain reorganization to a competing set of blocks. Follows the
   * Rust consensus's fork-choice rule (`choose_fork`): the chain with the
   * lower cumulative residual (higher stationarity quality) wins. `newBlocks`
   * must chain from a common ancestor already present in `this.blocks`
   * (i.e. `newBlocks[0].prevHash` must equal the hash of the block at the
   * fork point).
   */
  reorganize(newBlocks: BlockRecord[]): { switched: boolean; reason: string } {
    if (newBlocks.length === 0) return { switched: false, reason: "no candidate blocks" };

    const forkPointHash = newBlocks[0]!.prevHash;
    const forkHeight = this.blocks.findIndex((b) => b.hash === forkPointHash);
    if (forkHeight === -1) {
      return { switched: false, reason: "fork point not found on current chain" };
    }

    const currentTail = this.blocks.slice(forkHeight + 1);
    const currentResidual = currentTail.reduce((s, b) => s + b.residual, 0);
    const candidateResidual = newBlocks.reduce((s, b) => s + b.residual, 0);

    if (candidateResidual >= currentResidual) {
      return { switched: false, reason: "candidate chain does not have lower cumulative residual" };
    }

    try {
      this.rollbackToHeight(forkHeight);
    } catch (err) {
      return { switched: false, reason: (err as Error).message };
    }

    for (const block of newBlocks) {
      this.addBlock(block);
    }

    return { switched: true, reason: `reorganized ${currentTail.length} block(s) for ${newBlocks.length} block(s) with lower residual` };
  }

  // ── Finality gadget ──────────────────────────────────────────────────────────

  runFinalityRound(block: BlockRecord): void {
    const activeValidators = [...this.validators.values()].filter(v => !v.slashed && !v.jailed);
    if (activeValidators.length === 0) return;

    const totalVotingPower = activeValidators.reduce((s, v) => s + v.bondedStake, 0);
    const votes: FinalityVote[] = [];

    // Simulate validator votes (95% participation with slight randomness)
    for (const v of activeValidators) {
      const participates = Math.random() < 0.95;
      if (participates) {
        votes.push({
          validatorAddress: v.address,
          blockHash: block.hash,
          height: block.height,
          signature: hash256(`vote-${v.address}-${block.hash}`),
          timestamp: block.timestamp,
        });
        v.blocksVoted += 1;
        // Update uptime
        v.uptime = Math.min(1.0, v.uptime + 0.001);
      } else {
        v.uptime = Math.max(0, v.uptime - 0.005);
        // Slash for downtime if uptime drops too low
        if (v.uptime < 0.5 && !v.jailed) {
          this.slashValidator(v.address, "downtime", block.height, block.timestamp);
        }
      }
    }

    const votingPower = votes.reduce((s, vote) => {
      const val = this.validators.get(vote.validatorAddress);
      return s + (val?.bondedStake ?? 0);
    }, 0);

    const superMajority = totalVotingPower > 0 && votingPower / totalVotingPower >= 2 / 3;

    const round: FinalityRound = {
      height: block.height,
      blockHash: block.hash,
      votes,
      finalized: superMajority,
      finalizedAt: superMajority ? block.timestamp : undefined,
      votingPower,
      totalVotingPower,
    };

    this.finalityRounds.set(block.height, round);
    if (superMajority && block.height > this.finalizedHeight) {
      this.finalizedHeight = block.height;
      this.blocks[block.height]!.finalized = true;
    }
  }

  // ── Validator management ─────────────────────────────────────────────────────

  slashValidator(addr: string, reason: SlashEvent["reason"], height: number, timestamp: number): void {
    const v = this.validators.get(addr);
    if (!v || v.slashed) return;

    const slashPercent = reason === "double_sign" ? 0.05 : 0.01;
    const slashAmount = Math.floor(v.bondedStake * slashPercent);
    v.bondedStake -= slashAmount;
    v.slashCount += 1;
    if (reason === "double_sign") v.slashed = true;
    if (v.slashCount >= 3) v.jailed = true;

    this.slashEvents.push({ validatorAddress: addr, reason, slashAmount, height, timestamp });
  }

  // ── Block reward distribution ─────────────────────────────────────────────────

  distributeBlockReward(block: BlockRecord): void {
    const minerVal = this.validators.get(block.miner);
    if (!minerVal) return;

    minerVal.blocksProposed += 1;
    minerVal.accumulatedRewards += block.coinbaseReward;

    // Distribute a portion to other bonded validators as participation rewards
    const totalBonded = this.totalBondedStake;
    if (totalBonded === 0) return;
    const participationPool = Math.floor(block.coinbaseReward * 0.1);
    for (const v of this.validators.values()) {
      if (!v.slashed && !v.jailed && v.address !== block.miner) {
        const share = Math.floor(participationPool * (v.bondedStake / totalBonded));
        v.accumulatedRewards += share;
      }
    }
  }

  // ── Staking ──────────────────────────────────────────────────────────────────

  stake(delegator: string, validatorAddr: string, amount: number, height: number): string | null {
    if (!this.ledger.debit(delegator, amount)) {
      return "insufficient funds";
    }
    const v = this.validators.get(validatorAddr);
    if (!v) return "validator not found";
    if (v.jailed) return "validator is jailed";

    const key = `${delegator}-${validatorAddr}`;
    const existing = this.stakes.get(key);
    if (existing && !existing.unbonding) {
      existing.amount += amount;
    } else {
      this.stakes.set(key, {
        delegator,
        validator: validatorAddr,
        amount,
        startHeight: height,
        startTimestamp: Math.floor(Date.now() / 1000),
        unbonding: false,
      });
    }

    v.bondedStake += amount;
    return null;
  }

  unstake(delegator: string, validatorAddr: string, amount: number, height: number): string | null {
    const key = `${delegator}-${validatorAddr}`;
    const stake = this.stakes.get(key);
    if (!stake || stake.unbonding) return "no active stake found";
    if (stake.amount < amount) return "insufficient staked amount";

    const v = this.validators.get(validatorAddr);
    if (v) v.bondedStake = Math.max(0, v.bondedStake - amount);

    stake.amount -= amount;
    if (stake.amount === 0) this.stakes.delete(key);

    this.unbondingQueue.push({
      delegator,
      validator: validatorAddr,
      amount,
      unbondingHeight: height,
      completionHeight: height + UNBONDING_PERIOD,
    });

    return null;
  }

  processUnbonding(height: number): void {
    const completed = this.unbondingQueue.filter(u => u.completionHeight <= height);
    this.unbondingQueue = this.unbondingQueue.filter(u => u.completionHeight > height);
    for (const u of completed) {
      this.ledger.credit(u.delegator, u.amount);
    }
  }

  // ── DEX AMM ──────────────────────────────────────────────────────────────────

  swap(
    poolId: string,
    trader: string,
    tokenIn: string,
    amountIn: number,
  ): { amountOut: number; fee: number } | string {
    const pool = this.dexPools.get(poolId);
    if (!pool) return "pool not found";
    if (!this.ledger.debit(trader, amountIn)) return "insufficient funds";

    const isAtoB = tokenIn === pool.tokenA;
    const reserveIn = isAtoB ? pool.reserveA : pool.reserveB;
    const reserveOut = isAtoB ? pool.reserveB : pool.reserveA;

    // x*y = k constant product with fee
    const amountInWithFee = amountIn * (1 - pool.fee);
    const amountOut = Math.floor((reserveOut * amountInWithFee) / (reserveIn + amountInWithFee));
    const fee = Math.floor(amountIn * pool.fee);

    if (amountOut <= 0) return "insufficient liquidity";

    // Update reserves
    if (isAtoB) {
      pool.reserveA += amountIn;
      pool.reserveB -= amountOut;
      pool.volumeA += amountIn;
      pool.volumeB += amountOut;
    } else {
      pool.reserveB += amountIn;
      pool.reserveA -= amountOut;
      pool.volumeB += amountIn;
      pool.volumeA += amountOut;
    }
    pool.txCount += 1;

    // Credit trader with output tokens (simplified: EQU-denominated)
    this.ledger.credit(trader, amountOut);

    const event: SwapEvent = {
      poolId,
      trader,
      amountIn,
      amountOut,
      tokenIn,
      tokenOut: isAtoB ? pool.tokenB : pool.tokenA,
      fee,
      timestamp: Math.floor(Date.now() / 1000),
      txHash: hash256(`swap-${poolId}-${trader}-${Date.now()}`),
    };
    this.swapHistory.unshift(event);
    if (this.swapHistory.length > 200) this.swapHistory.pop();

    return { amountOut, fee };
  }

  addLiquidity(
    poolId: string,
    provider: string,
    amountA: number,
    amountB: number,
  ): { liquidity: number } | string {
    const pool = this.dexPools.get(poolId);
    if (!pool) return "pool not found";
    if (!this.ledger.debit(provider, amountA + amountB)) return "insufficient funds";

    const liquidity = pool.totalLiquidity === 0
      ? Math.floor(Math.sqrt(amountA * amountB))
      : Math.floor(Math.min(
          (amountA * pool.totalLiquidity) / pool.reserveA,
          (amountB * pool.totalLiquidity) / pool.reserveB,
        ));

    pool.reserveA += amountA;
    pool.reserveB += amountB;
    pool.totalLiquidity += liquidity;

    const existing = this.liquidityPositions.find(p => p.poolId === poolId && p.provider === provider);
    if (existing) {
      existing.liquidity += liquidity;
      existing.sharePercent = (existing.liquidity / pool.totalLiquidity) * 100;
    } else {
      this.liquidityPositions.push({
        poolId,
        provider,
        liquidity,
        sharePercent: (liquidity / pool.totalLiquidity) * 100,
      });
    }

    return { liquidity };
  }

  // ── Gossip ───────────────────────────────────────────────────────────────────

  gossipTx(txHash: string): void {
    const connectedPeers = this.peers.filter(p => p.connected);
    if (connectedPeers.length === 0) return;

    const propagated = connectedPeers.map(p => p.peerId);
    const event: GossipEvent = {
      id: hash256(`gossip-${txHash}-${Date.now()}`),
      type: "tx",
      hash: txHash,
      fromPeer: "self",
      propagatedTo: propagated,
      hops: 1,
      timestamp: Math.floor(Date.now() / 1000),
      latencyMs: Math.floor(Math.random() * 80) + 5,
    };
    this.gossipLog.unshift(event);
    if (this.gossipLog.length > 100) this.gossipLog.pop();

    // Simulate second-hop propagation
    setTimeout(() => {
      const secondHop: GossipEvent = {
        id: hash256(`gossip2-${txHash}-${Date.now()}`),
        type: "tx",
        hash: txHash,
        fromPeer: connectedPeers[0]?.peerId ?? "peer",
        propagatedTo: connectedPeers.slice(1).map(p => p.peerId),
        hops: 2,
        timestamp: Math.floor(Date.now() / 1000),
        latencyMs: Math.floor(Math.random() * 150) + 40,
      };
      this.gossipLog.unshift(secondHop);
      if (this.gossipLog.length > 100) this.gossipLog.pop();
    }, 200);
  }

  gossipBlock(blockHash: string): void {
    const connectedPeers = this.peers.filter(p => p.connected);
    const event: GossipEvent = {
      id: hash256(`gossip-block-${blockHash}`),
      type: "block",
      hash: blockHash,
      fromPeer: "self",
      propagatedTo: connectedPeers.map(p => p.peerId),
      hops: 1,
      timestamp: Math.floor(Date.now() / 1000),
      latencyMs: Math.floor(Math.random() * 50) + 10,
    };
    this.gossipLog.unshift(event);
    if (this.gossipLog.length > 100) this.gossipLog.pop();
  }

  // ── Queries ──────────────────────────────────────────────────────────────────

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

  getHeadersRange(from: number, to: number): Omit<BlockRecord, "transactions">[] {
    const end = Math.min(to, this.height);
    const result = [];
    for (let h = Math.max(0, from); h <= end; h++) {
      const b = this.blocks[h];
      if (!b) continue;
      const { transactions: _txs, ...header } = b;
      result.push(header);
    }
    return result;
  }
}

// ── Genesis & Seeding ─────────────────────────────────────────────────────────

function makeAddress(label: string): string {
  return addressFromSeed(label);
}

function seedValidators(state: ChainState): void {
  const validatorDefs = [
    { label: "equilibrium-miner-1",      moniker: "Miner-Alpha",   stake: 10_000_000_000, commission: 0.05 },
    { label: "equilibrium-miner-2",      moniker: "Miner-Beta",    stake:  8_000_000_000, commission: 0.07 },
    { label: "equilibrium-validator-3",  moniker: "Validator-Gamma", stake:  6_000_000_000, commission: 0.10 },
    { label: "equilibrium-validator-4",  moniker: "Validator-Delta", stake:  5_000_000_000, commission: 0.08 },
  ];

  for (const def of validatorDefs) {
    const address = makeAddress(def.label);
    state.validators.set(address, {
      address,
      moniker: def.moniker,
      bondedStake: def.stake,
      accumulatedRewards: 0,
      slashed: false,
      slashCount: 0,
      jailed: false,
      uptime: 0.98 + Math.random() * 0.02,
      blocksProposed: 0,
      blocksVoted: 0,
      commission: def.commission,
    });
  }
}

function seedDexPools(state: ChainState): void {
  const now = Math.floor(Date.now() / 1000);
  state.dexPools.set("EQU-WBTC", {
    id: "EQU-WBTC",
    tokenA: "EQU",
    tokenB: "WBTC",
    reserveA: 50_000_000_000,
    reserveB: 100_000_000,
    totalLiquidity: 2_236_067_977,
    fee: DEX_FEE,
    volumeA: 500_000_000,
    volumeB: 1_000_000,
    txCount: 42,
    createdAt: now,
  });
  state.dexPools.set("EQU-USDC", {
    id: "EQU-USDC",
    tokenA: "EQU",
    tokenB: "USDC",
    reserveA: 100_000_000_000,
    reserveB: 500_000_000,
    totalLiquidity: 7_071_067_811,
    fee: DEX_FEE,
    volumeA: 1_200_000_000,
    volumeB: 6_000_000,
    txCount: 127,
    createdAt: now,
  });
}

export function buildGenesisChain(): ChainState {
  const state = new ChainState();

  const miner1 = makeAddress("equilibrium-miner-1");
  const miner2 = makeAddress("equilibrium-miner-2");
  const alice  = makeAddress("equilibrium-alice");
  const bob    = makeAddress("equilibrium-bob");
  const carol  = makeAddress("equilibrium-carol");

  seedValidators(state);
  seedDexPools(state);

  // Seed peers
  state.peers = [
    { peerId: randomHex(20), address: "192.168.1.10:30303", latencyMs: 12,  height: 0, connected: true,  syncState: "synced"  },
    { peerId: randomHex(20), address: "10.0.0.55:30303",    latencyMs: 34,  height: 0, connected: true,  syncState: "synced"  },
    { peerId: randomHex(20), address: "172.16.0.3:30303",   latencyMs: 89,  height: 0, connected: false, syncState: "behind"  },
    { peerId: randomHex(20), address: "203.0.113.7:30303",  latencyMs: 142, height: 0, connected: true,  syncState: "syncing" },
  ];

  const miners = [miner1, miner2];
  let now = Math.floor(Date.now() / 1000) - 25 * 15;
  let prevHash = "0".repeat(64);

  for (let h = 0; h <= 24; h++) {
    const miner = miners[h % 2]!;
    const residual = Math.random() * 1e-8;
    const quality = 1.0 / (residual + 1e-6);
    const reward = Math.floor(BASE_REWARD * Math.min(quality, 1.0));
    state.ledger.credit(miner, reward);

    const txs: TxRecord[] = [];
    const blockHash = hash256(`block-${h}-${prevHash}`);

    if (h >= 3) {
      const txHash = hash256(`tx-${h}-alice`);
      const tx: TxRecord = {
        hash: txHash, from: miner, to: alice,
        amount: 1_000_000, fee: 1_000, nonce: Math.floor(h / 2),
        blockHash, blockHeight: h, timestamp: now, status: "confirmed",
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
        hash: txHash, from: alice, to: bob,
        amount: 250_000, fee: 500, nonce: Math.floor((h - 8) / 3),
        blockHash, blockHeight: h, timestamp: now, status: "confirmed",
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
        hash: txHash, from: bob, to: carol,
        amount: 50_000, fee: 200, nonce: h - 15,
        blockHash, blockHeight: h, timestamp: now, status: "confirmed",
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
      difficulty: state.currentDifficulty,
      residual,
      recursionDepth: 2,
      coinbaseReward: reward,
      miner,
      txCount: txs.length,
      transactions: txs,
      finalized: false,
    };

    state.blocks.push(block);

    const prevBlock = state.blocks[h - 1];
    const blockTime = prevBlock ? block.timestamp - prevBlock.timestamp : TARGET_BLOCK_TIME;
    state.blockStats.push({
      height: h, txCount: txs.length, residual,
      mempoolPressure: 0.1 + Math.random() * 0.6,
      timestamp: now, difficulty: state.currentDifficulty, blockTime,
    });

    state.updateDifficulty();
    state.runFinalityRound(block);
    for (const p of state.peers) p.height = h;

    // Update miner validator stats
    const vMiner = state.validators.get(miner);
    if (vMiner) {
      vMiner.blocksProposed += 1;
      vMiner.accumulatedRewards += reward;
    }

    prevHash = blockHash;
    now += 12 + Math.floor(Math.random() * 6);
  }

  // Seed mempool
  for (let i = 0; i < 6; i++) {
    const txHash = hash256(`mempool-${i}-${Date.now()}`);
    const tx: TxRecord = {
      hash: txHash, from: alice, to: carol,
      amount: 10_000 * (i + 1), fee: 100 + i * 50, nonce: 100 + i,
      blockHash: null, blockHeight: null,
      timestamp: Math.floor(Date.now() / 1000), status: "pending",
    };
    state.mempool.add(tx);
  }

  return state;
}

// ── Block miner ───────────────────────────────────────────────────────────────

export function mineNextBlock(state: ChainState, minerAddr: string): BlockRecord {
  const prev = state.latestBlock!;
  const height = state.height + 1;
  const now = Math.floor(Date.now() / 1000);

  const selected = state.mempool.all().slice(0, 50);
  const txHashes = selected.map((t) => t.hash);
  const mr = merkleRoot(txHashes.length > 0 ? txHashes : ["0".repeat(64)]);

  const residual = Math.random() * 5e-9 + 1e-10;
  const quality = 1.0 / (residual + 1e-6);
  const reward = Math.floor(BASE_REWARD * Math.min(quality, 1.0));

  const blockHash = hash256(`block-${height}-${prev.hash}-${now}`);

  const txs: TxRecord[] = selected.map((t) => ({
    ...t,
    blockHash,
    blockHeight: height,
    status: "confirmed" as const,
  }));

  // Generate ZK proof for this block's stationarity
  const zkProof = generateZkProof(residual, blockHash, height);

  const block: BlockRecord = {
    hash: blockHash,
    height,
    prevHash: prev.hash,
    merkleRoot: mr,
    timestamp: now,
    nonce: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
    difficulty: state.currentDifficulty,
    residual,
    recursionDepth: 2,
    coinbaseReward: reward,
    miner: minerAddr,
    txCount: txs.length,
    transactions: txs,
    finalized: false,
    zkProof,
  };

  state.ledger.credit(minerAddr, reward);
  state.addBlock(block);
  state.gossipBlock(blockHash);
  return block;
}
