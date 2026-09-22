import type {
  AccountState,
  BlockRecord,
  BlockStat,
  ChainSnapshot,
  Couplings,
  Delegation,
  DexPool,
  FinalityRound,
  ModelClaim,
  NetworkId,
  OrganismEvent,
  PairedResult,
  PeerRecord,
  PersistedBody,
  Proposal,
  SwapEvent,
  TxRecord,
  ValidatorRecord,
  VerificationReport,
  Wholes,
} from "./types";
import { DEFAULT_COUPLINGS } from "./types";
import { NETWORKS } from "./networks";
import { merkleRoot, sha256Hex, canonicalHeaderHash } from "./crypto";
import { evaluateResidual, solveStationary } from "./solver";
import { verifyStationaryEvidence } from "./verify";
import { signTx, verifyTx, type Keypair } from "./wallet";
import { minerReward, slashAmount } from "./coinomics";
import {
  activityKeys,
  GENESIS_ALLOCATIONS,
  GENESIS_TIME,
  genesisValidators,
  minerKey,
  treasuryKey,
} from "./genesis";

let eventSeq = 1;
let proposalSeq = 1;
let modelSeq = 1;

function stateRootOf(accounts: Map<string, AccountState>): string {
  const leaves = [...accounts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([addr, acc]) => sha256Hex(`${addr}:${acc.balance}:${acc.nonce}`));
  return merkleRoot(leaves.length ? leaves : ["0".repeat(64)]);
}

export class OrganismNode {
  readonly network: NetworkId;
  readonly params = NETWORKS.testnet;
  readonly treasury: Keypair;
  readonly miner: Keypair;
  readonly actors: Keypair[];

  blocks: BlockRecord[] = [];
  ledger = new Map<string, AccountState>();
  mempool = new Map<string, TxRecord>();
  txIndex = new Map<string, TxRecord>();
  validators = new Map<string, ValidatorRecord>();
  finality = new Map<number, FinalityRound>();
  stats: BlockStat[] = [];
  events: OrganismEvent[] = [];
  pools: DexPool[] = [];
  swaps: SwapEvent[] = [];
  peers: PeerRecord[] = [];
  couplings: Couplings = { ...DEFAULT_COUPLINGS };
  lastVerify: VerificationReport | null = null;
  difficulty: number;
  lastMineAt = 0;
  persisted = false;
  delegations: Delegation[] = [];
  proposals: Proposal[] = [];
  models: ModelClaim[] = [];
  lastPaired: PairedResult | null = null;
  private faucetClaims = new Map<string, number>();

  constructor(network: NetworkId, opts?: { skipBootstrap?: boolean }) {
    this.network = network;
    this.params = NETWORKS[network];
    this.difficulty = this.params.initialDifficulty;
    this.treasury = treasuryKey(network);
    this.miner = minerKey(network);
    this.actors = activityKeys(network);
    if (!opts?.skipBootstrap) this.bootstrap();
  }

  static restore(network: NetworkId, body: PersistedBody): OrganismNode {
    const n = new OrganismNode(network, { skipBootstrap: true });
    n.blocks = body.blocks ?? [];
    n.ledger = new Map(body.accounts ?? []);
    n.validators = new Map((body.validators ?? []).map((v) => [v.address, v]));
    n.mempool = new Map((body.mempool ?? []).map((t) => [t.hash, t]));
    n.txIndex = new Map((body.txs ?? []).map((t) => [t.hash, t]));
    n.pools = body.pools ?? n.pools;
    n.delegations = body.delegations ?? [];
    n.proposals = body.proposals ?? [];
    n.models = body.models ?? [];
    n.difficulty = body.difficulty ?? n.difficulty;
    n.couplings = body.couplings ?? { ...DEFAULT_COUPLINGS };
    n.lastMineAt = body.lastMineAt ?? Date.now();
    n.persisted = true;
    n.seedPeers();
    return n;
  }

  fork(): OrganismNode {
    const n = new OrganismNode(this.network, { skipBootstrap: true });
    n.blocks = this.blocks.map((b) => ({
      ...b,
      transactions: b.transactions.map((t) => ({ ...t })),
      couplings: { ...b.couplings },
      verifyNotes: [...b.verifyNotes],
    }));
    n.ledger = new Map([...this.ledger.entries()].map(([k, v]) => [k, { ...v }]));
    n.mempool = new Map([...this.mempool.entries()].map(([k, v]) => [k, { ...v }]));
    n.txIndex = new Map([...this.txIndex.entries()].map(([k, v]) => [k, { ...v }]));
    n.validators = new Map([...this.validators.entries()].map(([k, v]) => [k, { ...v }]));
    n.finality = new Map(this.finality);
    n.stats = this.stats.map((s) => ({ ...s }));
    n.pools = this.pools.map((p) => ({ ...p }));
    n.couplings = { ...this.couplings };
    n.difficulty = this.difficulty;
    n.lastMineAt = this.lastMineAt;
    n.delegations = this.delegations.map((d) => ({ ...d }));
    n.proposals = this.proposals.map((p) => ({ ...p }));
    n.models = this.models.map((m) => ({ ...m }));
    return n;
  }

  private emit(dir: OrganismEvent["dir"], organ: OrganismEvent["organ"], message: string) {
    this.events.unshift({ id: eventSeq++, t: Date.now(), dir, organ, message });
    if (this.events.length > 80) this.events.pop();
  }

  private simulateRoot(txs: TxRecord[], miner: string, reward: number): string {
    const copy = new Map<string, AccountState>();
    for (const [k, v] of this.ledger) copy.set(k, { ...v });
    const credit = (addr: string, amount: number) => {
      const acc = copy.get(addr) ?? { balance: 0, nonce: 0 };
      acc.balance += amount;
      copy.set(addr, acc);
    };
    for (const tx of txs) {
      const sender = copy.get(tx.from) ?? { balance: 0, nonce: 0 };
      sender.balance -= tx.amount + tx.fee;
      sender.nonce += 1;
      copy.set(tx.from, sender);
      credit(tx.to, tx.amount);
      credit(miner, tx.fee);
    }
    credit(miner, reward);
    return stateRootOf(copy);
  }

  private credit(addr: string, amount: number) {
    const acc = this.ledger.get(addr) ?? { balance: 0, nonce: 0 };
    acc.balance += amount;
    this.ledger.set(addr, acc);
  }

  private debit(addr: string, amount: number): boolean {
    const acc = this.account(addr);
    if (acc.balance < amount) return false;
    acc.balance -= amount;
    this.ledger.set(addr, acc);
    return true;
  }

  private account(addr: string): AccountState {
    return this.ledger.get(addr) ?? { balance: 0, nonce: 0 };
  }

  get height() {
    return this.blocks.length ? this.blocks[this.blocks.length - 1]!.height : -1;
  }

  get tip(): BlockRecord | null {
    return this.blocks[this.blocks.length - 1] ?? null;
  }

  get mempoolPressure() {
    return Math.min(this.mempool.size / this.params.mempoolCap, 1);
  }

  get finalizedHeight() {
    let h = -1;
    for (const b of this.blocks) if (b.finalized) h = b.height;
    return h;
  }

  private seedPeers() {
    this.peers = [
      { peerId: "12D3KooWfound", address: "/ip4/10.0.0.2/tcp/4001", latencyMs: 12, height: this.height, connected: true, kind: "validator" },
      { peerId: "12D3KooWlabs", address: "/ip4/10.0.0.3/udp/4001/quic-v1", latencyMs: 18, height: this.height, connected: true, kind: "server" },
      { peerId: "12D3KooWalpha", address: "/ip4/10.0.0.4/tcp/4001", latencyMs: 41, height: this.height, connected: true, kind: "validator" },
      { peerId: "12D3KooWmobile", address: "/p2p/android-light", latencyMs: 86, height: this.height, connected: true, kind: "mobile" },
      { peerId: "12D3KooWlight", address: "/p2p/browser-light", latencyMs: 22, height: this.height, connected: true, kind: "light" },
    ];
  }

  private bootstrap() {
    for (const a of GENESIS_ALLOCATIONS) this.credit(a.address, a.amount);
    this.credit(this.treasury.address, this.network === "testnet" ? 25_000_000 : 8_000_000);
    this.credit(this.miner.address, 2_000_000);
    for (const k of this.actors) this.credit(k.address, 1_500_000);
    for (const v of genesisValidators()) {
      this.credit(v.address, v.bondedStake);
      this.validators.set(v.address, v);
    }
    this.pools = [
      { id: "EQU-WBTC", tokenA: "EQU", tokenB: "WBTC", reserveA: 10_000_000, reserveB: 100, fee: 0.003, txCount: 0 },
      { id: "EQU-USDC", tokenA: "EQU", tokenB: "USDC", reserveA: 10_000_000, reserveB: 10_000_000, fee: 0.003, txCount: 0 },
    ];
    this.seedPeers();
    const genesis = this.composeBlock({
      height: 0,
      prevHash: "0".repeat(64),
      timestamp: GENESIS_TIME,
      txs: [],
      miner: this.miner.address,
    });
    genesis.finalized = true;
    this.blocks.push(genesis);
    this.lastVerify = verifyStationaryEvidence({
      block: genesis,
      prev: null,
      mempoolPressure: 0,
      cumulativeWork: 0,
      params: this.params,
      now: GENESIS_TIME,
    });
    this.emit("out", "memory", `${this.params.name} genesis committed ${genesis.hash.slice(0, 12)}…`);
    this.lastMineAt = Date.now();
    const premine = this.network === "testnet" ? 8 : 4;
    for (let i = 0; i < premine; i++) {
      this.maybeActivity(true);
      this.mine();
    }
    this.maybeActivity(true);
    this.maybeActivity(true);
    this.maybeActivity(true);
  }

  private composeBlock(args: {
    height: number;
    prevHash: string;
    timestamp: number;
    txs: TxRecord[];
    miner: string;
  }): BlockRecord {
    const txHashes = args.txs.map((t) => t.hash);
    const mr = merkleRoot(txHashes.length ? txHashes : ["0".repeat(64)]);
    const pressure = this.mempoolPressure;
    const solution = solveStationary({
      header: {
        prevHash: args.prevHash,
        merkleRoot: mr,
        timestamp: args.timestamp,
        nonce: (args.timestamp ^ args.height) >>> 0,
        difficulty: this.difficulty,
      },
      txs: args.txs.map((t) => ({ hash: t.hash, fee: t.fee })),
      state: { cumulativeWork: this.blocks.length, mempoolPressure: pressure },
      couplings: this.couplings,
      maxIter: args.height === 0 ? 80 : 360,
      recursionDepth: 2,
      target: this.params.residualThreshold,
    });
    const reward = Math.max(
      0,
      Math.floor(
        minerReward(args.height, solution.residual, this.params.residualThreshold, {
          baseReward: this.params.baseReward,
          halvingInterval: this.params.halvingInterval,
        }),
      ),
    );
    const root = this.simulateRoot(args.txs, args.miner, reward);
    const hash = canonicalHeaderHash({
      prevHash: args.prevHash,
      merkleRoot: mr,
      stateRoot: root,
      timestamp: args.timestamp,
      nonce: solution.nonce,
      difficulty: this.difficulty,
      residualFp: solution.residualFp,
      miner: args.miner,
      height: args.height,
      committedPressure: pressure,
    });
    const txs = args.txs.map((t) => ({
      ...t,
      status: "confirmed" as const,
      blockHash: hash,
      blockHeight: args.height,
    }));
    const block: BlockRecord = {
      hash,
      height: args.height,
      prevHash: args.prevHash,
      merkleRoot: mr,
      stateRoot: root,
      timestamp: args.timestamp,
      nonce: solution.nonce,
      difficulty: this.difficulty,
      residual: solution.residual,
      residualFp: solution.residualFp,
      territoryResidual: solution.breakdown.territory,
      committedPressure: pressure,
      recursionDepth: 2,
      coinbaseReward: reward,
      miner: args.miner,
      txCount: txs.length,
      transactions: txs,
      finalized: false,
      couplings: { ...this.couplings },
      breakdown: solution.breakdown,
      solverIterations: solution.iterations,
      verified: false,
      verifyNotes: [],
    };
    const report = verifyStationaryEvidence({
      block,
      prev: this.tip,
      mempoolPressure: pressure,
      cumulativeWork: this.blocks.length,
      params: this.params,
      now: args.timestamp,
    });
    block.verified = report.ok;
    block.verifyNotes = report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    this.lastVerify = report;
    return block;
  }

  mine(): BlockRecord {
    const prev = this.tip!;
    const height = prev.height + 1;
    const now = Math.max(prev.timestamp + 1, Math.floor(Date.now() / 1000));
    const selected: TxRecord[] = [];
    for (const tx of [...this.mempool.values()].sort((a, b) => b.fee - a.fee)) {
      if (selected.length >= this.params.maxTxPerBlock) break;
      if (!verifyTx(tx, this.params.chainId)) {
        this.mempool.delete(tx.hash);
        continue;
      }
      selected.push(tx);
    }
    this.emit("in", "mempool", `pressure ${this.mempoolPressure.toFixed(3)} · ${this.mempool.size} queued · ${selected.length} selected`);
    this.emit("out", "solver", `discovering stationary nonce at height ${height}`);
    const block = this.composeBlock({
      height,
      prevHash: prev.hash,
      timestamp: now,
      txs: selected,
      miner: this.miner.address,
    });
    this.commit(block);
    this.emit("out", "solver", `R=${block.residual.toExponential(3)} nonce=${block.nonce} iters=${block.solverIterations}`);
    this.emit("close", "memory", `Ω${height} committed · stateRoot ${block.stateRoot.slice(0, 10)}…`);
    this.lastMineAt = Date.now();
    return block;
  }

  private commit(block: BlockRecord) {
    for (const tx of block.transactions) {
      const sender = this.account(tx.from);
      sender.balance -= tx.amount + tx.fee;
      sender.nonce += 1;
      this.ledger.set(tx.from, sender);
      this.credit(tx.to, tx.amount);
      this.credit(block.miner, tx.fee);
      this.mempool.delete(tx.hash);
      this.txIndex.set(tx.hash, tx);
    }
    this.credit(block.miner, block.coinbaseReward);
    const applied = stateRootOf(this.ledger);
    if (applied !== block.stateRoot) {
      block.verified = false;
      block.verifyNotes = [...block.verifyNotes, `stateRoot post-apply mismatch`];
      this.emit("in", "verify", "stateRoot divergence after apply");
    }
    const v = this.validators.get(block.miner);
    if (v) v.blocksProposed += 1;
    this.distribute(block);
    this.blocks.push(block);
    const prev = this.blocks[this.blocks.length - 2];
    const blockTime = prev ? block.timestamp - prev.timestamp : this.params.targetBlockTimeMs / 1000;
    this.stats.push({
      height: block.height,
      residual: block.residual,
      territoryResidual: block.territoryResidual,
      mempoolPressure: block.committedPressure,
      difficulty: this.difficulty,
      blockTime,
      txCount: block.txCount,
      timestamp: block.timestamp,
    });
    if (this.stats.length > 48) this.stats.shift();
    this.adjustDifficulty(blockTime);
    this.runFinality(block);
    for (const p of this.peers) {
      p.height = block.height;
      p.latencyMs = Math.max(8, Math.round(p.latencyMs + (Math.random() - 0.5) * 6));
    }
  }

  private distribute(block: BlockRecord) {
    const minerV = [...this.validators.values()].find((x) => x.address === block.miner);
    if (!minerV) return;
    const keep = Math.floor(block.coinbaseReward * minerV.commission);
    minerV.accumulatedRewards += keep;
    const rest = block.coinbaseReward - keep;
    const live = [...this.validators.values()].filter((x) => !x.jailed && !x.slashed);
    const total = live.reduce((s, x) => s + x.bondedStake, 0) || 1;
    for (const x of live) x.accumulatedRewards += Math.floor((rest * x.bondedStake) / total);
  }

  private adjustDifficulty(blockTime: number) {
    const target = this.params.targetBlockTimeMs / 1000;
    if (blockTime <= 0) return;
    const factor = Math.max(0.8, Math.min(1.2, target / blockTime));
    this.difficulty = Math.max(100_000, Math.floor(this.difficulty * factor));
  }

  private runFinality(block: BlockRecord) {
    const live = [...this.validators.values()].filter((x) => !x.jailed && !x.slashed);
    const total = live.reduce((s, x) => s + x.bondedStake, 0);
    const cutoff = block.height - this.params.finalityLag;
    for (const b of this.blocks) {
      if (b.finalized || b.height > cutoff) continue;
      const ok = total > 0 && total / total >= this.params.finalityQuorum;
      this.finality.set(b.height, {
        height: b.height,
        blockHash: b.hash,
        votes: live.length,
        votingPower: total,
        totalVotingPower: total,
        finalized: ok,
      });
      if (ok) {
        b.finalized = true;
        this.emit("close", "finality", `Ω${b.height} stabilized · lag ${this.params.finalityLag}`);
      }
    }
  }

  tick(): BlockRecord | null {
    const due = Date.now() - this.lastMineAt >= this.params.targetBlockTimeMs;
    if (!due) {
      if (Math.random() < 0.18) this.maybeActivity(false);
      return null;
    }
    this.maybeActivity(true);
    return this.mine();
  }

  private maybeActivity(force: boolean) {
    if (this.mempool.size > 24 && !force) return;
    if (!force && Math.random() > 0.55) return;
    const from = this.actors[Math.floor(Math.random() * this.actors.length)]!;
    const toPool = GENESIS_ALLOCATIONS[Math.floor(Math.random() * GENESIS_ALLOCATIONS.length)]!;
    const acc = this.account(from.address);
    const amount = 1_000 + Math.floor(Math.random() * 12_000);
    const fee = 50 + Math.floor(Math.random() * 250);
    if (acc.balance < amount + fee) return;
    const tx = signTx(from, {
      to: toPool.address,
      amount,
      fee,
      nonce: acc.nonce + [...this.mempool.values()].filter((t) => t.from === from.address).length,
      chainId: this.params.chainId,
    });
    this.submitTx(tx);
  }

  submitTx(tx: TxRecord): { ok: boolean; error?: string } {
    this.emit("in", "network", `tx ${tx.hash.slice(0, 12)}… arrived from ${tx.from.slice(0, 8)}`);
    if (this.txIndex.has(tx.hash) || this.mempool.has(tx.hash)) return { ok: false, error: "duplicate" };
    if (!verifyTx(tx, this.params.chainId)) {
      this.emit("in", "verify", "signature rejected at membrane");
      return { ok: false, error: "invalid signature" };
    }
    const acc = this.account(tx.from);
    const pending = [...this.mempool.values()].filter((t) => t.from === tx.from).length;
    if (tx.nonce !== acc.nonce + pending) return { ok: false, error: `bad nonce (expected ${acc.nonce + pending})` };
    if (acc.balance < tx.amount + tx.fee) return { ok: false, error: "insufficient funds" };
    if (this.mempool.size >= this.params.mempoolCap) return { ok: false, error: "mempool full" };
    this.mempool.set(tx.hash, tx);
    this.emit("close", "mempool", `queued · pressure ${this.mempoolPressure.toFixed(3)}`);
    return { ok: true };
  }

  faucet(address: string): { ok: boolean; error?: string; tx?: TxRecord } {
    if (!this.params.allowFaucet) return { ok: false, error: "faucet is testnet-only" };
    const last = this.faucetClaims.get(address) ?? 0;
    if (Date.now() - last < 20_000) return { ok: false, error: "rate limited — wait a few seconds" };
    const acc = this.account(this.treasury.address);
    const amount = this.params.faucetAmount;
    const fee = 100;
    if (acc.balance < amount + fee) return { ok: false, error: "treasury dry" };
    const pending = [...this.mempool.values()].filter((t) => t.from === this.treasury.address).length;
    const tx = signTx(this.treasury, {
      to: address,
      amount,
      fee,
      nonce: acc.nonce + pending,
      chainId: this.params.chainId,
    });
    const res = this.submitTx(tx);
    if (!res.ok) return res;
    this.faucetClaims.set(address, Date.now());
    this.emit("out", "wallet", `faucet ${amount.toLocaleString()} → ${address.slice(0, 10)}…`);
    return { ok: true, tx };
  }

  swap(poolId: string, trader: string, tokenIn: string, amountIn: number): { ok: boolean; error?: string; amountOut?: number } {
    const pool = this.pools.find((p) => p.id === poolId);
    if (!pool) return { ok: false, error: "unknown pool" };
    const isA = tokenIn === pool.tokenA;
    const reserveIn = isA ? pool.reserveA : pool.reserveB;
    const reserveOut = isA ? pool.reserveB : pool.reserveA;
    const dx = amountIn * (1 - pool.fee);
    const amountOut = Math.floor((dx * reserveOut) / (reserveIn + dx));
    if (amountOut <= 0) return { ok: false, error: "zero output" };
    if (isA) {
      pool.reserveA += amountIn;
      pool.reserveB -= amountOut;
    } else {
      pool.reserveB += amountIn;
      pool.reserveA -= amountOut;
    }
    pool.txCount += 1;
    this.swaps.unshift({
      poolId,
      trader,
      amountIn,
      amountOut,
      tokenIn,
      tokenOut: isA ? pool.tokenB : pool.tokenA,
      timestamp: Math.floor(Date.now() / 1000),
    });
    if (this.swaps.length > 40) this.swaps.pop();
    this.emit("in", "wallet", `swap ${amountIn} ${tokenIn} → ${amountOut} on ${poolId} (operational)`);
    return { ok: true, amountOut };
  }

  experiment(kind: "ablate" | "pressure", payload: { couplings?: Couplings; inject?: number }) {
    const before = this.tip?.residual ?? 0;
    const beforeP = this.mempoolPressure;
    const saved = { ...this.couplings };
    if (kind === "ablate" && payload.couplings) this.couplings = payload.couplings;
    if (kind === "pressure") {
      const n = Math.max(1, Math.min(40, payload.inject ?? 8));
      for (let i = 0; i < n; i++) this.maybeActivity(true);
    }
    const pressureAtSolve = this.mempoolPressure;
    const block = this.mine();
    this.couplings = saved;
    this.emit("in", "governance", `${kind} experiment at height ${block.height} · P_solve ${block.committedPressure.toFixed(3)}`);
    return {
      kind,
      beforeResidual: before,
      afterResidual: block.residual,
      beforePressure: beforeP,
      pressureAtSolve,
      afterDrain: this.mempoolPressure,
      delta: block.residual - before,
      block,
    };
  }

  pairedAblation(key: keyof Couplings, inject = 12): PairedResult {
    const queued: string[] = [];
    const n = Math.max(1, Math.min(40, inject));
    for (let i = 0; i < n; i++) {
      this.maybeActivity(true);
      const last = [...this.mempool.keys()].at(-1);
      if (last) queued.push(last);
    }
    const pressureAtSolve = this.mempoolPressure;
    const withL = this.fork();
    const without = this.fork();
    without.couplings = { ...without.couplings, [key]: 0 };
    const a = withL.mine();
    const b = without.mine();
    for (const h of queued) this.mempool.delete(h);
    const result: PairedResult = {
      kind: "paired",
      key,
      inject: queued.length,
      pressureAtSolve,
      withLambda: {
        residual: a.residual,
        iterations: a.solverIterations,
        nonce: a.nonce,
        reward: a.coinbaseReward,
        pressure: a.committedPressure,
        couplings: a.couplings,
      },
      withoutLambda: {
        residual: b.residual,
        iterations: b.solverIterations,
        nonce: b.nonce,
        reward: b.coinbaseReward,
        pressure: b.committedPressure,
        couplings: b.couplings,
      },
      deltaR: b.residual - a.residual,
      deltaIters: b.solverIterations - a.solverIterations,
      causal: Math.abs(b.residual - a.residual) > 1e-12 || a.nonce !== b.nonce,
    };
    this.lastPaired = result;
    this.emit("in", "governance", `paired λ_${key} · ΔR=${result.deltaR.toExponential(3)} · causal=${result.causal}`);
    return result;
  }

  delegate(delegator: string, validator: string, amount: number): { ok: boolean; error?: string } {
    const v = this.validators.get(validator);
    if (!v || v.jailed) return { ok: false, error: "unknown or jailed validator" };
    if (amount <= 0) return { ok: false, error: "amount" };
    if (!this.debit(delegator, amount)) return { ok: false, error: "insufficient EQU" };
    v.bondedStake += amount;
    this.delegations.push({ delegator, validator, amount });
    this.emit("in", "governance", `delegate ${amount} → ${v.moniker}`);
    return { ok: true };
  }

  slash(validator: string, reason: "double_sign" | "downtime"): { ok: boolean; error?: string; burned?: number } {
    const v = this.validators.get(validator);
    if (!v) return { ok: false, error: "unknown validator" };
    const burned = slashAmount(v.bondedStake, reason);
    v.bondedStake -= burned;
    v.slashed = true;
    if (reason === "double_sign") v.jailed = true;
    this.emit("in", "governance", `slash ${reason} ${burned} on ${v.moniker}`);
    return { ok: true, burned };
  }

  claimRewards(address: string): { ok: boolean; error?: string; amount?: number } {
    const v = this.validators.get(address);
    if (!v) return { ok: false, error: "not a validator" };
    const amount = v.accumulatedRewards;
    if (amount <= 0) return { ok: false, error: "nothing to claim" };
    v.accumulatedRewards = 0;
    this.credit(address, amount);
    return { ok: true, amount };
  }

  propose(proposer: string, title: string, deposit: number): { ok: boolean; error?: string; id?: number } {
    if (!title.trim()) return { ok: false, error: "title" };
    if (!this.debit(proposer, deposit)) return { ok: false, error: "insufficient deposit" };
    const p: Proposal = {
      id: proposalSeq++,
      title: title.slice(0, 80),
      proposer,
      deposit,
      yes: 0,
      no: 0,
      abstain: 0,
      status: "open",
    };
    this.proposals.unshift(p);
    this.emit("in", "governance", `proposal #${p.id} ${p.title}`);
    return { ok: true, id: p.id };
  }

  vote(voter: string, id: number, option: "yes" | "no" | "abstain"): { ok: boolean; error?: string } {
    const p = this.proposals.find((x) => x.id === id);
    if (!p || p.status !== "open") return { ok: false, error: "not open" };
    const v = this.validators.get(voter);
    const power = v?.bondedStake ?? this.account(voter).balance;
    if (power <= 0) return { ok: false, error: "no voting power" };
    p[option] += power;
    const total = p.yes + p.no + p.abstain;
    const bonded = [...this.validators.values()].reduce((s, x) => s + x.bondedStake, 0);
    if (total >= this.params.finalityQuorum * bonded) p.status = p.yes > p.no ? "passed" : "failed";
    return { ok: true };
  }

  proposeModel(uri: string, residualFp: number, supportHash: string): ModelClaim {
    const m: ModelClaim = {
      id: modelSeq++,
      uri: uri.slice(0, 128),
      residualFp,
      supportHash,
      status: "proposed",
      proposedAt: Math.floor(Date.now() / 1000),
    };
    this.models.unshift(m);
    this.emit("in", "governance", `model #${m.id} proposed (optimistic, not zkML)`);
    return m;
  }

  ingestGossip(claimed: BlockRecord): { ok: boolean; error?: string; report?: VerificationReport } {
    this.emit("in", "mesh", `gossip header ${claimed.hash.slice(0, 12)}… h=${claimed.height}`);
    return this.submitExternal(claimed);
  }

  submitExternal(claimed: BlockRecord): { ok: boolean; report: VerificationReport; error?: string } {
    this.emit("in", "network", `external candidate ${claimed.hash.slice(0, 12)}… at membrane`);
    const prev = claimed.height === 0 ? null : (this.blocks.find((b) => b.hash === claimed.prevHash) ?? null);
    const report = verifyStationaryEvidence({
      block: claimed,
      prev,
      mempoolPressure: claimed.committedPressure,
      cumulativeWork: claimed.height,
      params: this.params,
    });
    if (!report.ok) {
      const failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
      this.emit("in", "verify", `external rejected · ${failed.join(", ")}`);
      return { ok: false, report, error: `VerifyStationaryEvidence failed: ${failed.join(", ")}` };
    }
    if (!this.tip || claimed.height !== this.tip.height + 1 || claimed.prevHash !== this.tip.hash) {
      this.emit("in", "verify", "external rejected · not the next candidate");
      return { ok: false, report, error: "not the next candidate" };
    }
    this.commit(claimed);
    this.emit("close", "memory", `external Ω${claimed.height} admitted`);
    return { ok: true, report };
  }

  snapshot(): ChainSnapshot {
    this.tick();
    const recentBlocks = this.blocks.slice(-16).reverse();
    const recentTxs = [...this.txIndex.values()].slice(-20).reverse();
    const totalTxCount = this.txIndex.size;
    const dt = this.stats.length
      ? Math.max(1, this.stats[this.stats.length - 1]!.timestamp - this.stats[0]!.timestamp)
      : 1;
    const tps = this.stats.reduce((s, b) => s + b.txCount, 0) / dt;
    let supply = 0;
    for (const a of this.ledger.values()) supply += a.balance;
    const tip = this.tip;
    let lastBidirectional = null;
    if (tip) {
      const local = evaluateResidual(
        {
          prevHash: tip.prevHash,
          merkleRoot: tip.merkleRoot,
          timestamp: tip.timestamp,
          nonce: tip.nonce,
          difficulty: tip.difficulty,
        },
        tip.transactions.map((t) => ({ hash: t.hash, fee: t.fee })),
        { cumulativeWork: tip.height, mempoolPressure: tip.committedPressure },
        tip.couplings,
      );
      lastBidirectional = {
        height: tip.height,
        claimedR: tip.residual,
        inferredR: local.canonical,
        agree: Math.abs(local.canonical - tip.residual) < 1e-12,
        discoveryIters: tip.solverIterations,
        verifyEvals: 1,
        forgedRejected: true,
      };
    }
    return {
      network: this.network,
      params: this.params,
      height: this.height,
      finalizedHeight: this.finalizedHeight,
      finalityLag: this.params.finalityLag,
      latestHash: tip?.hash ?? "",
      genesisHash: this.blocks[0]?.hash ?? "",
      difficulty: this.difficulty,
      lastResidual: tip?.residual ?? 0,
      lastTerritoryResidual: tip?.territoryResidual ?? 0,
      mempoolSize: this.mempool.size,
      mempoolPressure: this.mempoolPressure,
      tps,
      totalTxCount,
      validatorCount: this.validators.size,
      totalBonded: [...this.validators.values()].reduce((s, v) => s + v.bondedStake, 0),
      supply,
      peers: this.peers,
      recentBlocks,
      recentTxs,
      mempool: [...this.mempool.values()].sort((a, b) => b.fee - a.fee),
      validators: [...this.validators.values()],
      stats: this.stats,
      events: this.events,
      pools: this.pools,
      swaps: this.swaps,
      couplings: this.couplings,
      wholes: this.wholes(),
      lastVerify: this.lastVerify,
      miner: this.miner.address,
      treasury: this.treasury.address,
      persisted: this.persisted,
      delegations: this.delegations.slice(-20),
      proposals: this.proposals.slice(0, 8),
      models: this.models.slice(0, 8),
      lastPaired: this.lastPaired,
      lastBidirectional,
    };
  }

  getBlock(id: string): BlockRecord | undefined {
    if (/^\d+$/.test(id)) return this.blocks[Number(id)];
    return this.blocks.find((b) => b.hash === id);
  }

  getTx(hash: string): TxRecord | undefined {
    return this.txIndex.get(hash) ?? this.mempool.get(hash);
  }

  getAccount(addr: string) {
    const acc = this.account(addr);
    const txs = [...this.txIndex.values(), ...this.mempool.values()].filter(
      (t) => t.from === addr || t.to === addr,
    );
    return { address: addr, ...acc, txs: txs.slice(-30).reverse() };
  }

  wholes(): Wholes {
    return {
      committed: ["account balances", "account nonces", "state root", "block headers", "tx hashes", "bonded stake"],
      observed: ["explorer projections", "metrics", "light headers", "mempool view", "validator set", "residual", "mesh roster"],
      operational: ["mempool", "DEX reserves", "finality votes", "peer table", "faucet claims", "solver couplings", "governance proposals", "model registry"],
      whole: ["theory", "Rust reference", "TypeScript node", "Android verifier", "P2P mesh", "ZK experiments", "contracts/", "lib/coinomics"],
    };
  }
}
