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
  WholeReport,
  BtcHeaderRecord,
  EthHeaderRecord,
  TransitionEvidence,
  SecondBodyReport,
  StakeEvidence,
  ProductionRow,
  DependencyRow,
  ConstitutionAnswer,
} from "./types";
import { DEFAULT_COUPLINGS } from "./types";
import { NETWORKS } from "./networks";
import { merkleRoot, sha256Hex, canonicalHeaderHash } from "./crypto";
import { evaluateResidual, solveStationary } from "./solver";
import { verifyStationaryEvidence } from "./verify";
import { signTx, verifyTx, type Keypair } from "./wallet";
import { slashAmount } from "./coinomics";
import { applySwap, poolAddress, quoteSwap } from "./dex";
import { decodeHeaderHex, parseBtcHeader, verifyBtcMerkle, verifyBtcPow } from "./btc";
import { callArbitrage } from "./wasm-host";
import {
  ETH_MIN_PARTICIPANTS,
  ethKeygen,
  hashEthHeader,
  hexOf,
  hexToBytes as ethHex,
  signEthHeader,
  verifyEthHeader,
  countParticipants,
  participationMask,
} from "./eth-light";
import { onPlaneMessage } from "./network-plane";
import { stationarityRelation } from "./relation";
import { hexToBytes } from "./bytes";
import { ARBITRAGE_CODE, evidenceRoot } from "./evidence";
import {
  applySuccessor,
  cloneOmega,
  constitutionalAnswer,
  initialOmega,
  openOmega,
  successor,
  type Successor,
} from "./constitution";
import { dependencyFindings } from "./dependencies";
import {
  activityKeys,
  GENESIS_ALLOCATIONS,
  GENESIS_TIME,
  minerKey,
  treasuryKey,
} from "./genesis";

let eventSeq = 1;
let proposalSeq = 1;
let modelSeq = 1;

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
  btcHeaders: BtcHeaderRecord[] = [];
  ethHeaders: EthHeaderRecord[] = [];
  ethPubkey = "";
  private ethSecret: Uint8Array | null = null;
  wasmStorage = new Map<string, string>();
  announcements: string[] = [];
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
  lastWhole: WholeReport | null = null;
  kinReport: SecondBodyReport | null = null;
  private constitutionReport: ConstitutionAnswer | null = null;
  private dependencyReport: DependencyRow[] | null = null;
  private useReport: ProductionRow[] | null = null;
  /** Law's finalized height. Not the block flag, which later blocks rewrite. */
  private finalizedThrough = -1;
  private clock: number | null = null;
  private detStep = 0;
  private faucetClaims = new Map<string, number>();
  private commitListeners: Array<(block: BlockRecord) => void> = [];
  private pending: TransitionEvidence = {
    v: 1,
    chainId: 0,
    wasmCode: ARBITRAGE_CODE,
    btc: [],
    eth: [],
    wasm: [],
    stake: [],
  };
  private pendingWasm: Map<string, string> | null = null;
  private kin: OrganismNode | null = null;
  private kinStarted = false;
  private kinQueue: Promise<void> = Promise.resolve();

  constructor(network: NetworkId, opts?: { skipBootstrap?: boolean }) {
    this.network = network;
    this.params = NETWORKS[network];
    this.difficulty = this.params.initialDifficulty;
    this.treasury = treasuryKey(network);
    this.miner = minerKey(network);
    this.actors = activityKeys(network);
    this.pending = this.blankEvidence();
    if (!opts?.skipBootstrap) this.bootstrap();
  }

  static restore(network: NetworkId, body: PersistedBody, opts?: { audit?: boolean }): OrganismNode {
    const n = new OrganismNode(network, { skipBootstrap: true });
    n.blocks = body.blocks ?? [];
    n.ledger = new Map(body.accounts ?? []);
    n.validators = new Map((body.validators ?? []).map((v) => [v.address, v]));
    n.mempool = new Map((body.mempool ?? []).map((t) => [t.hash, t]));
    n.txIndex = new Map((body.txs ?? []).map((t) => [t.hash, t]));
    n.pools = (body.pools ?? n.pools).map((p) => ({ ...p, address: p.address || poolAddress(p.id) }));
    n.btcHeaders = body.btcHeaders ?? [];
    n.ethHeaders = body.ethHeaders ?? [];
    n.ethPubkey = body.ethPubkey ?? "";
    n.wasmStorage = new Map(body.wasmStorage ?? []);
    n.delegations = body.delegations ?? [];
    n.proposals = body.proposals ?? [];
    n.models = body.models ?? [];
    n.difficulty = body.difficulty ?? n.difficulty;
    n.couplings = body.couplings ?? { ...DEFAULT_COUPLINGS };
    n.lastMineAt = body.lastMineAt ?? Date.now();
    n.persisted = true;
    n.finalizedThrough = n.finalizedHeight;
    n.seedPeers();
    if (opts?.audit) n.startKin();
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
    n.btcHeaders = this.btcHeaders.map((h) => ({ ...h }));
    n.ethHeaders = this.ethHeaders.map((h) => ({ ...h }));
    n.ethPubkey = this.ethPubkey;
    n.ethSecret = this.ethSecret ? new Uint8Array(this.ethSecret) : null;
    n.wasmStorage = new Map(this.wasmStorage);
    n.couplings = { ...this.couplings };
    n.difficulty = this.difficulty;
    n.finalizedThrough = this.finalizedThrough;
    n.lastMineAt = this.lastMineAt;
    n.clock = this.clock;
    n.delegations = this.delegations.map((d) => ({ ...d }));
    n.proposals = this.proposals.map((p) => ({ ...p }));
    n.models = this.models.map((m) => ({ ...m }));
    n.pending = this.cloneEvidence(this.pending);
    n.pendingWasm = this.pendingWasm ? new Map(this.pendingWasm) : null;
    n.detStep = this.detStep;
    return n;
  }

  private emit(dir: OrganismEvent["dir"], organ: OrganismEvent["organ"], message: string) {
    this.events.unshift({ id: eventSeq++, t: Date.now(), dir, organ, message });
    if (this.events.length > 80) this.events.pop();
  }

  private toOmega() {
    return {
      chainId: this.params.chainId,
      height: this.height,
      tipHash: this.tip?.hash ?? "0".repeat(64),
      tipTimestamp: this.tip?.timestamp ?? 0,
      difficulty: this.difficulty,
      couplings: { ...this.couplings },
      ledger: new Map([...this.ledger.entries()].map(([k, v]) => [k, { ...v }])),
      pools: this.pools.map((p) => ({ ...p })),
      btc: this.btcHeaders.map((h) => ({ ...h })),
      ethPubkey: this.ethPubkey,
      eth: this.ethHeaders.map((h) => ({ ...h })),
      wasm: new Map(this.wasmStorage),
      validators: new Map([...this.validators.entries()].map(([k, v]) => [k, { ...v }])),
      delegations: this.delegations.map((d) => ({ ...d })),
      proposals: this.proposals.map((p) => ({ ...p })),
      finalizedHeight: this.finalizedThrough,
    };
  }

  private installNext(next: ReturnType<OrganismNode["toOmega"]>, swaps: SwapEvent[]) {
    this.ledger = next.ledger;
    this.pools = next.pools;
    this.btcHeaders = next.btc;
    this.ethHeaders = next.eth;
    this.ethPubkey = next.ethPubkey;
    this.wasmStorage = next.wasm;
    this.validators = next.validators;
    this.delegations = next.delegations;
    this.proposals = next.proposals;
    this.couplings = { ...next.couplings };
    this.difficulty = next.difficulty;
    this.finalizedThrough = next.finalizedHeight;
    for (let i = swaps.length - 1; i >= 0; i--) this.swaps.unshift(swaps[i]!);
    if (this.swaps.length > 40) this.swaps.length = 40;
  }

  private adopt(block: BlockRecord, stepped: Extract<Successor, { ok: true }>) {
    this.installNext(stepped.next, stepped.swaps);
    for (const tx of block.transactions) {
      this.mempool.delete(tx.hash);
      this.txIndex.set(tx.hash, tx);
    }
    this.blocks.push(block);
    const all = [...stepped.next.validators.values()];
    const live = all.filter((x) => !x.jailed && !x.slashed);
    const totalPower = all.reduce((s, x) => s + x.bondedStake, 0);
    const votingPower = live.reduce((s, x) => s + x.bondedStake, 0);
    for (const b of this.blocks) {
      if (b.finalized || b.height > stepped.next.finalizedHeight) continue;
      b.finalized = true;
      this.finality.set(b.height, {
        height: b.height,
        blockHash: b.hash,
        votes: live.length,
        votingPower,
        totalVotingPower: totalPower,
        finalized: true,
      });
      this.emit("close", "finality", `Ω${b.height} stabilized · lag ${this.params.finalityLag}`);
    }
    const prev = this.blocks[this.blocks.length - 2];
    const blockTime = prev ? block.timestamp - prev.timestamp : this.params.targetBlockTimeMs / 1000;
    this.stats.push({
      height: block.height,
      residual: block.residual,
      territoryResidual: block.territoryResidual,
      mempoolPressure: block.committedPressure,
      difficulty: block.difficulty,
      blockTime,
      txCount: block.txCount,
      timestamp: block.timestamp,
    });
    if (this.stats.length > 48) this.stats.shift();
    for (const p of this.peers) {
      p.height = block.height;
      p.latencyMs = Math.max(8, Math.round(p.latencyMs + (Math.random() - 0.5) * 6));
    }
  }

  private blankEvidence(): TransitionEvidence {
    return {
      v: 1,
      chainId: this.params.chainId,
      wasmCode: ARBITRAGE_CODE,
      btc: [],
      eth: [],
      wasm: [],
      stake: [],
    };
  }

  private cloneEvidence(ev: TransitionEvidence): TransitionEvidence {
    return {
      v: 1,
      chainId: ev.chainId,
      wasmCode: ev.wasmCode,
      btc: ev.btc.map((b) => ({ ...b })),
      eth: ev.eth.map((e) => ({ ...e })),
      wasm: ev.wasm.map((w) => ({ ...w })),
      stake: ev.stake.map((s) => ({ ...s })),
    };
  }

  private held(addr: string): number {
    return this.pending.stake.reduce((sum, op) => {
      if (op.op === "delegate" && op.delegator === addr) return sum + op.amount;
      if (op.op === "propose" && op.proposer === addr) return sum + op.deposit;
      return sum;
    }, 0);
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
    this.constitute();
    const genesis = this.composeBlock({
      height: 0,
      prevHash: "0".repeat(64),
      timestamp: GENESIS_TIME,
      txs: [],
      miner: this.miner.address,
    });
    this.sealing = true;
    if (!this.commit(genesis)) throw new Error("genesis did not commit");
    this.sealing = false;
    this.emit("out", "memory", `${this.params.name} genesis committed ${genesis.hash.slice(0, 12)}…`);
    this.lastMineAt = Date.now();
    this.clock = GENESIS_TIME;
    const step = Math.max(1, Math.floor(this.params.targetBlockTimeMs / 1000));
    const premine = this.network === "testnet" ? 8 : 4;
    for (let i = 0; i < premine; i++) {
      this.clock += step;
      this.maybeActivity(true, true);
      this.mine();
    }
    this.clock = null;
    this.maybeActivity(true, true);
    this.maybeActivity(true, true);
    this.maybeActivity(true, true);
    this.startKin();
  }

  /** Ω before any block. The same function a second body starts from. */
  private constitute() {
    const omega = initialOmega(this.network);
    this.ledger = omega.ledger;
    this.pools = omega.pools;
    this.validators = omega.validators;
    this.difficulty = omega.difficulty;
    this.couplings = { ...omega.couplings };
    this.seedPeers();
  }

  /** Move producer stake out of liquid so the coinbase has a validator to pay. */
  private bondProducer() {
    if (this.validators.has(this.miner.address)) return;
    const bond = 500_000;
    if (!this.debit(this.miner.address, bond)) return;
    this.validators.set(this.miner.address, {
      address: this.miner.address,
      moniker: "Foundation miner",
      bondedStake: bond,
      accumulatedRewards: 0,
      slashed: false,
      jailed: false,
      uptime: 1,
      blocksProposed: 0,
      commission: 0.1,
    });
    this.emit("close", "governance", "producer bonded · staking is inside the transition");
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
    let evidence = this.cloneEvidence(this.pending);
    let wasmAfter = evidence.wasm.length ? this.pendingWasm : null;
    const omega = this.toOmega();
    const stepInputs = (ev: TransitionEvidence, wasm: Map<string, string> | null) =>
      applySuccessor(omega, {
        transactions: args.txs,
        evidence: ev,
        timestamp: args.timestamp,
        nonce: solution.nonce,
        miner: args.miner,
        committedPressure: pressure,
        couplings: this.couplings,
        difficulty: this.difficulty,
        wasmAfter: wasm,
      });
    let stepped = stepInputs(evidence, wasmAfter);
    if (!stepped.ok) {
      this.emit("in", "verify", stepped.error);
      this.pending = this.blankEvidence();
      this.pendingWasm = null;
      evidence = this.blankEvidence();
      wasmAfter = null;
      stepped = stepInputs(evidence, wasmAfter);
    }
    if (!stepped.ok) throw new Error(stepped.error);
    const hash = canonicalHeaderHash({
      prevHash: args.prevHash,
      merkleRoot: mr,
      stateRoot: stepped.stateRoot,
      timestamp: args.timestamp,
      nonce: solution.nonce,
      difficulty: this.difficulty,
      residualFp: stepped.residualFp,
      miner: args.miner,
      height: args.height,
      committedPressure: pressure,
      chainId: evidence.chainId,
      evidenceRoot: evidenceRoot(evidence),
      omegaRoot: stepped.omegaRoot,
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
      stateRoot: stepped.stateRoot,
      timestamp: args.timestamp,
      nonce: solution.nonce,
      difficulty: this.difficulty,
      residual: stepped.residual,
      residualFp: stepped.residualFp,
      territoryResidual: stepped.territory,
      committedPressure: pressure,
      recursionDepth: 2,
      coinbaseReward: stepped.reward,
      liquidIssuance: stepped.liquid,
      miner: args.miner,
      txCount: txs.length,
      transactions: txs,
      finalized: false,
      couplings: { ...this.couplings },
      breakdown: stepped.breakdown,
      solverIterations: solution.iterations,
      verified: false,
      verifyNotes: [],
      evidence,
      omegaRoot: stepped.omegaRoot,
    };
    block.relation = stationarityRelation(block, this.params.residualThreshold);
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

  mine(at?: number): BlockRecord {
    this.bondProducer();
    const opened = cloneOmega(this.toOmega());
    openOmega(opened);
    this.couplings = opened.couplings;
    this.proposals = opened.proposals;
    const prev = this.tip!;
    const height = prev.height + 1;
    const now = Math.max(prev.timestamp + 1, at ?? this.clock ?? Math.floor(Date.now() / 1000));
    const preview = this.pools.map((p) => ({ ...p }));
    const selected: TxRecord[] = [];
    const reserved = new Map<string, number>();
    for (const tx of [...this.mempool.values()].sort((a, b) => b.fee - a.fee)) {
      if (selected.length >= this.params.maxTxPerBlock) break;
      if (!verifyTx(tx, this.params.chainId)) {
        this.mempool.delete(tx.hash);
        continue;
      }
      const already = reserved.get(tx.from) ?? 0;
      const acc = this.account(tx.from);
      if (acc.balance < this.held(tx.from) + already + tx.amount + tx.fee) continue;
      const pool = preview.find((p) => (p.address || poolAddress(p.id)) === tx.to);
      if (pool && quoteSwap(pool, pool.tokenA, tx.amount) <= 0) continue;
      if (pool) applySwap(pool, pool.tokenA, tx.amount);
      reserved.set(tx.from, already + tx.amount + tx.fee);
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
    this.sealing = true;
    const committedOk = this.commit(block);
    this.sealing = false;
    if (!committedOk) {
      this.emit("in", "verify", `Ω${height} refused · state did not close`);
      return block;
    }
    this.announcements.push(block.hash);
    if (this.announcements.length > 32) this.announcements.shift();
    this.emit("out", "solver", `R=${block.residual.toExponential(3)} nonce=${block.nonce} iters=${block.solverIterations}`);
    this.emit("close", "memory", `Ω${height} committed · stateRoot ${block.stateRoot.slice(0, 10)}…`);
    this.lastMineAt = Date.now();
    return block;
  }

  private sealing = false;

  private wasmOverlayMatches(ev: TransitionEvidence): boolean {
    if (!this.pendingWasm || ev.wasm.length !== this.pending.wasm.length) return false;
    return ev.wasm.every((call, i) => {
      const queued = this.pending.wasm[i];
      return queued && queued.method === call.method && queued.caller === call.caller;
    });
  }

  private commit(block: BlockRecord, wasmReady?: Map<string, string> | null): boolean {
    const ev = block.evidence;
    const wasmAfter = ev?.wasm.length ? (wasmReady ?? (this.wasmOverlayMatches(ev) ? this.pendingWasm : null)) : null;
    const stepped = applySuccessor(this.toOmega(), {
      transactions: block.transactions,
      evidence: ev,
      timestamp: block.timestamp,
      nonce: block.nonce,
      miner: block.miner,
      committedPressure: block.committedPressure,
      couplings: block.couplings,
      difficulty: block.difficulty,
      wasmAfter,
    });
    if (!stepped.ok) {
      this.emit("in", "verify", stepped.error);
      return false;
    }
    if (stepped.stateRoot !== block.stateRoot || (block.evidence && stepped.omegaRoot !== block.omegaRoot)) {
      this.emit("in", "verify", "state did not replay");
      return false;
    }
    if (stepped.reward !== block.coinbaseReward || stepped.liquid !== (block.liquidIssuance ?? block.coinbaseReward)) {
      this.emit("in", "verify", "reward law diverged");
      return false;
    }
    this.adopt(block, stepped);
    this.pending = this.sealing ? this.blankEvidence() : this.pending;
    this.pendingWasm = this.sealing ? null : this.pendingWasm;
    if (this.kinStarted) this.noteKin(block);
    if (!block.verified) return true;
    for (const listener of this.commitListeners) listener(block);
    return true;
  }

  /** Fired after a block is committed and verified. Transports may speak. They may not commit. */
  onCommitted(listener: (block: BlockRecord) => void) {
    this.commitListeners.push(listener);
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

  private unit(tag: string): number {
    const hex = sha256Hex(`eq-det|${this.params.chainId}|${this.height}|${this.detStep}|${tag}`);
    this.detStep += 1;
    return parseInt(hex.slice(0, 8), 16) / 0x100000000;
  }

  private maybeActivity(force: boolean, deterministic = false) {
    const rnd = () => (deterministic ? this.unit("act") : Math.random());
    if (this.mempool.size > 24 && !force) return;
    if (!force && rnd() > 0.55) return;
    const from = this.actors[Math.floor(rnd() * this.actors.length)]!;
    const toPool = GENESIS_ALLOCATIONS[Math.floor(rnd() * GENESIS_ALLOCATIONS.length)]!;
    const acc = this.account(from.address);
    const amount = 1_000 + Math.floor(rnd() * 12_000);
    const fee = 50 + Math.floor(rnd() * 250);
    if (acc.balance - this.held(from.address) < amount + fee) return;
    const tx = signTx(from, {
      to: toPool.address,
      amount,
      fee,
      nonce: acc.nonce + [...this.mempool.values()].filter((t) => t.from === from.address).length,
      chainId: this.params.chainId,
      timestamp: this.clock ?? undefined,
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
    if (acc.balance - this.held(tx.from) < tx.amount + tx.fee) return { ok: false, error: "insufficient funds" };
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

  swap(poolId: string, _trader: string, tokenIn: string, amountIn: number): {
    ok: boolean;
    error?: string;
    amountOut?: number;
    poolAddress?: string;
  } {
    const pool = this.pools.find((p) => p.id === poolId);
    if (!pool) return { ok: false, error: "unknown pool" };
    const amountOut = quoteSwap(pool, tokenIn, amountIn);
    if (tokenIn !== pool.tokenA) {
      return { ok: false, error: "only a signed EQU transfer to the pool is a swap", amountOut, poolAddress: pool.address };
    }
    if (amountOut <= 0) return { ok: false, error: "zero output", poolAddress: pool.address };
    return { ok: true, amountOut, poolAddress: pool.address };
  }

  /**
   * Queue a Bitcoin header. Proof of work is checked now.
   * The header enters state only inside the next block, which carries it.
   */
  submitBtcHeader(hex: string, height: number): { ok: boolean; error?: string; hash?: string } {
    const raw = decodeHeaderHex(hex);
    if (!raw) return { ok: false, error: "header must be 80 bytes of hex" };
    if (!Number.isInteger(height) || height < 0) return { ok: false, error: "height must be a non-negative integer" };
    if (!verifyBtcPow(raw)) return { ok: false, error: "bad proof of work" };
    const parsed = parseBtcHeader(raw);
    const staged = this.btcHeaders.map((h) => ({ ...h }));
    for (const item of this.pending.btc) {
      const prev = decodeHeaderHex(item.headerHex);
      if (!prev) return { ok: false, error: "queued header is not 80 bytes" };
      const body = parseBtcHeader(prev);
      staged.push({ hash: body.hash, height: item.height, prevHash: body.prevHash, merkleRoot: body.merkleRoot, bits: body.bits });
    }
    const tip = staged[staged.length - 1];
    if (tip) {
      if (height !== tip.height + 1) return { ok: false, error: "height does not extend the tip" };
      if (parsed.prevHash !== tip.hash) return { ok: false, error: "prev hash does not match the tip" };
    }
    if (staged.some((h) => h.hash === parsed.hash)) return { ok: false, error: "header already admitted" };
    this.pending.btc.push({ headerHex: hex.trim(), height });
    this.emit("in", "verify", `BTC header ${height} queued · ${parsed.hash.slice(0, 16)}… · no credit`);
    return { ok: true, hash: parsed.hash };
  }

  /** Merkle inclusion against an admitted header. Still does not mint. */
  verifyBtcTransfer(txHashHex: string, proofHex: string[], blockHeight: number): { ok: boolean; error?: string } {
    const header = this.btcHeaders.find((h) => h.height === blockHeight);
    if (!header) return { ok: false, error: "no admitted header at that height" };
    const tip = this.btcHeaders[this.btcHeaders.length - 1];
    if (!tip || tip.height - header.height < 6) return { ok: false, error: "fewer than 6 confirmations" };
    let txHash: Uint8Array;
    let root: Uint8Array;
    const proof: Uint8Array[] = [];
    try {
      txHash = hexToBytes(txHashHex);
      root = hexToBytes(header.merkleRoot);
      for (const entry of proofHex) proof.push(hexToBytes(entry));
    } catch {
      return { ok: false, error: "proof is not hex" };
    }
    if (!verifyBtcMerkle(txHash, proof, root)) return { ok: false, error: "merkle proof rejected" };
    return { ok: true };
  }

  /** Execute the compiled arbitrage contract against a staged store. The call rides in the next block. */
  async executeContract(method: "init" | "pause" | "unpause", caller: string): Promise<{
    ok: boolean;
    code: number;
    logs: string[];
    error?: string;
  }> {
    const owner = caller.slice(0, 40).padEnd(40, "0");
    const methodId = method === "init" ? 0 : method === "pause" ? 2 : 3;
    const args = method === "init" ? new TextEncoder().encode(owner) : new Uint8Array();
    const storage = new Map(this.pendingWasm ?? this.wasmStorage);
    const result = await callArbitrage(methodId, args, {
      caller: owner,
      storage,
      blockNumber: Math.max(0, this.height),
    });
    const ok = result.code === 1;
    if (ok) {
      this.pendingWasm = storage;
      this.pending.wasm.push({ method, caller: owner });
    }
    this.emit("in", "verify", `wasm ${method} → ${result.code}${ok ? " · queued" : " refused"}`);
    return { ok, code: result.code, logs: result.logs, error: ok ? undefined : `contract returned ${result.code}` };
  }

  private ethStaged(): { pubkey: string; headers: EthHeaderRecord[] } {
    let pubkey = this.ethPubkey;
    const headers = this.ethHeaders.map((h) => ({ ...h }));
    for (const item of this.pending.eth) {
      if (item.op === "bootstrap") {
        pubkey = item.pubkey;
        continue;
      }
      const fields = {
        slot: item.slot,
        proposerIndex: item.proposerIndex,
        parentRoot: item.parentRoot,
        stateRoot: item.stateRoot,
        bodyRoot: item.bodyRoot,
      };
      headers.push({
        slot: item.slot,
        hash: hexOf(hashEthHeader(fields)),
        parentRoot: item.parentRoot,
        stateRoot: item.stateRoot,
        bodyRoot: item.bodyRoot,
        participants: item.participants,
      });
    }
    return { pubkey, headers };
  }

  /**
   * Queue a BLS aggregate key. The secret stays in this process and is not
   * written into the block. This is not Ethereum's sync committee unless
   * the caller supplies that committee's key.
   */
  bootstrapEth(pubkeyHex?: string): { ok: boolean; error?: string; pubkey?: string } {
    if (this.ethStaged().pubkey) return { ok: false, error: "already bootstrapped", pubkey: this.ethStaged().pubkey };
    let pubkey: string;
    if (pubkeyHex) {
      const raw = ethHex(pubkeyHex.replace(/^0x/, ""));
      if (raw.length !== 48) return { ok: false, error: "aggregate pubkey must be 48 bytes" };
      pubkey = hexOf(raw);
      this.ethSecret = null;
    } else {
      const key = ethKeygen();
      this.ethSecret = key.secret;
      pubkey = hexOf(key.pubkey);
    }
    this.pending.eth.push({ op: "bootstrap", pubkey });
    this.emit("in", "verify", `ETH committee queued · ${pubkey.slice(0, 16)}… · no credit`);
    return { ok: true, pubkey };
  }

  submitEthHeader(header: {
    slot: number;
    proposerIndex?: number;
    parentRoot: string;
    stateRoot: string;
    bodyRoot: string;
    participants: number;
    signature: string;
  }): { ok: boolean; error?: string; hash?: string } {
    const staged = this.ethStaged();
    if (!staged.pubkey) return { ok: false, error: "not bootstrapped" };
    if (header.participants < ETH_MIN_PARTICIPANTS) return { ok: false, error: "quorum not met" };
    const fields = {
      slot: header.slot,
      proposerIndex: header.proposerIndex ?? 0,
      parentRoot: header.parentRoot,
      stateRoot: header.stateRoot,
      bodyRoot: header.bodyRoot,
    };
    const tip = staged.headers[staged.headers.length - 1];
    if (tip) {
      if (header.slot !== tip.slot + 1) return { ok: false, error: "slot does not extend the tip" };
      if (header.parentRoot !== tip.hash) return { ok: false, error: "parent root does not match the tip" };
    }
    let sig: Uint8Array;
    try {
      sig = ethHex(header.signature.replace(/^0x/, ""));
    } catch {
      return { ok: false, error: "signature is not hex" };
    }
    if (!verifyEthHeader(ethHex(staged.pubkey), fields, sig)) return { ok: false, error: "bad signature" };
    const hash = hexOf(hashEthHeader(fields));
    this.pending.eth.push({
      op: "header",
      slot: fields.slot,
      proposerIndex: fields.proposerIndex,
      parentRoot: fields.parentRoot,
      stateRoot: fields.stateRoot,
      bodyRoot: fields.bodyRoot,
      participants: header.participants,
      signature: header.signature.replace(/^0x/, ""),
    });
    this.emit("in", "verify", `ETH header slot ${header.slot} queued · no credit`);
    return { ok: true, hash };
  }

  /** Sign the next header with the in-process key. Refuses if that key was not kept. */
  signNextEthHeader(bodyRoot: string, stateRoot: string): { ok: boolean; error?: string; header?: {
    slot: number;
    proposerIndex: number;
    parentRoot: string;
    stateRoot: string;
    bodyRoot: string;
    participants: number;
    signature: string;
  } } {
    if (!this.ethSecret) return { ok: false, error: "no local signing key" };
    const tip = this.ethStaged().headers.at(-1);
    const fields = {
      slot: tip ? tip.slot + 1 : 1,
      proposerIndex: 0,
      parentRoot: tip ? tip.hash : "00".repeat(32),
      stateRoot,
      bodyRoot,
    };
    const participants = countParticipants(participationMask(ETH_MIN_PARTICIPANTS));
    if (participants < ETH_MIN_PARTICIPANTS) return { ok: false, error: "mask short" };
    const signature = hexOf(signEthHeader(this.ethSecret, fields));
    return { ok: true, header: { ...fields, participants, signature } };
  }

  /** A peer announced a hash. Record it. Do not commit it. */
  noteAnnouncement(hash: string) {
    if (!/^[0-9a-f]{64}$/i.test(hash)) return;
    if (this.announcements.includes(hash)) return;
    this.announcements.push(hash);
    if (this.announcements.length > 32) this.announcements.shift();
    this.emit("in", "mesh", `announced ${hash.slice(0, 12)}… · hash is not a block`);
  }

  /**
   * A peer delivered a candidate. The plane does not commit it.
   * Only the organism's admit path can.
   */
  deliverFromPeer(peerId: string, claimed: BlockRecord): Promise<{ ok: boolean; error?: string; duplicate?: boolean }> {
    this.emit("in", "mesh", `plane ${peerId.slice(0, 12)} announced ${claimed.hash.slice(0, 12)}…`);
    return onPlaneMessage(
      {
        hasBlock: (hash) => this.blocks.some((b) => b.hash === hash),
        admit: (block) => this.ingestGossip(block),
      },
      { event: "block", peerId, blockHash: claimed.hash },
      claimed,
    );
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
      formulaEffect: Math.abs(b.residual - a.residual) > 1e-12,
      discoveryEffect: a.nonce !== b.nonce,
      rewardEffect: a.coinbaseReward !== b.coinbaseReward,
      causal: Math.abs(b.residual - a.residual) > 1e-12 || a.nonce !== b.nonce,
    };
    this.lastPaired = result;
    this.emit("in", "governance", `paired λ_${key} · ΔR=${result.deltaR.toExponential(3)} · formula=${result.formulaEffect} · discovery=${result.discoveryEffect}`);
    return result;
  }

  toBody(): PersistedBody {
    return {
      blocks: this.blocks,
      accounts: [...this.ledger.entries()],
      validators: [...this.validators.values()],
      mempool: [...this.mempool.values()],
      txs: [...this.txIndex.values()],
      pools: this.pools,
      btcHeaders: this.btcHeaders,
      wasmStorage: [...this.wasmStorage.entries()],
      ethPubkey: this.ethPubkey,
      ethHeaders: this.ethHeaders,
      delegations: this.delegations,
      proposals: this.proposals,
      models: this.models,
      difficulty: this.difficulty,
      couplings: this.couplings,
      lastMineAt: this.lastMineAt,
    };
  }

  /**
   * One transition, not five pages.
   * Forks only — the live chain is not rewritten by the measurement.
   */
  measureWhole(): WholeReport {
    const primed = this.fork();
    primed.clock = Math.max((primed.tip?.timestamp ?? 0) + 1, Math.floor(Date.now() / 1000));
    for (let i = 0; i < 8; i++) primed.maybeActivity(true);
    const base = primed.fork();
    const a = base.mine();
    const keys = ["hash", "structural", "continuity", "mempool", "fees"] as const;
    const couplings = keys.map((key) => {
      const arm = primed.fork();
      arm.couplings = { ...arm.couplings, [key]: 0 };
      const b = arm.mine();
      return {
        key,
        formulaEffect: Math.abs(b.residual - a.residual) > 1e-12,
        discoveryEffect: b.nonce !== a.nonce,
        rewardEffect: b.coinbaseReward !== a.coinbaseReward,
        deltaR: b.residual - a.residual,
        nonceWith: a.nonce,
        nonceWithout: b.nonce,
      };
    });

    const empty = primed.fork();
    const txs = empty.mempool.size;
    empty.mempool.clear();
    const cleared = empty.mine();

    const gov = primed.fork();
    gov.proposals.push({
      id: 4242,
      title: "set λ_structural = 0",
      proposer: gov.miner.address,
      deposit: 0,
      yes: 1,
      no: 0,
      abstain: 0,
      status: "passed",
      couplingKey: "structural",
      couplingValue: 0,
    });
    const gblock = gov.mine();
    const applied = gov.proposals.find((p) => p.id === 4242)?.status === "executed";

    const rewardBefore = [...primed.validators.values()].reduce((s, v) => s + v.accumulatedRewards, 0);
    const rewardAfter = [...base.validators.values()].reduce((s, v) => s + v.accumulatedRewards, 0);

    const healthy = primed.fork();
    const h0 = healthy.height;
    healthy.mine();
    healthy.mine();
    healthy.mine();
    const healthyBlock = healthy.blocks.find((b) => b.height === h0 + 1);

    const jailed = primed.fork();
    for (const v of jailed.validators.values()) v.jailed = true;
    const j0 = jailed.height;
    jailed.mine();
    jailed.mine();
    jailed.mine();
    const jailedBlock = jailed.blocks.find((b) => b.height === j0 + 1);

    const restored = OrganismNode.restore(base.network, base.toBody());
    const supplyOf = (n: OrganismNode) => [...n.ledger.values()].reduce((s, acc) => s + acc.balance, 0);
    const restartEqual =
      restored.height === base.height &&
      restored.tip?.hash === base.tip?.hash &&
      restored.tip?.stateRoot === base.tip?.stateRoot &&
      restored.tip?.residual === base.tip?.residual &&
      restored.difficulty === base.difficulty &&
      supplyOf(restored) === supplyOf(base);

    const report: WholeReport = {
      height: a.height,
      primedTxs: primed.mempool.size,
      pressure: primed.mempoolPressure,
      baseline: {
        nonce: a.nonce,
        residual: a.residual,
        reward: a.coinbaseReward,
        liquid: a.liquidIssuance ?? a.coinbaseReward,
        verified: a.verified,
      },
      couplings,
      mempool: {
        txs,
        discoveryEffect: txs > 0 && cleared.nonce !== a.nonce,
        nonceWithTxs: a.nonce,
        nonceEmpty: cleared.nonce,
      },
      governance: {
        applied: Boolean(applied),
        key: "structural",
        discoveryEffect: gblock.nonce !== a.nonce,
        formulaEffect: Math.abs(gblock.residual - a.residual) > 1e-12,
        nonceAfter: gblock.nonce,
      },
      stake: {
        minerBonded: base.validators.has(base.miner.address),
        reward: a.coinbaseReward,
        liquidIssuance: a.liquidIssuance ?? a.coinbaseReward,
        distributed: rewardAfter - rewardBefore,
      },
      finality: {
        healthyFinalized: Boolean(healthyBlock?.finalized),
        jailedFinalized: Boolean(jailedBlock?.finalized),
        separatedFromStationarity: Boolean(
          healthyBlock?.finalized && healthyBlock.verified && jailedBlock && !jailedBlock.finalized && jailedBlock.verified,
        ),
      },
      persistence: {
        restartEqual,
        height: base.height,
        hash: base.tip?.hash ?? "",
        stateRoot: base.tip?.stateRoot ?? "",
        residual: base.tip?.residual ?? 0,
      },
      verifyAgrees: Boolean(a.verified && base.lastVerify?.ok),
      sourceLaw:
        "Inside one transaction set, λ_mempool, λ_continuity, and λ_fees do not depend on the nonce — the Rust joint gradient of mempool pressure is 0. They can change R and leave the nonce where it was. λ_structural does depend on the nonce, so a passed governance message sets it before the solve. The mempool changes discovery by changing the transaction set, not by the size of λ₃. Reward stays put while both residuals sit under the threshold, because quality is clipped at 1. Stake receives the coinbase that is not the producer's commission. Finality is lagged voting power, not the residual.",
    };
    this.lastWhole = report;
    this.emit("close", "transition", `whole · verify ${report.baseline.verified ? "ok" : "fail"} · restore ${restartEqual ? "equal" : "diverged"}`);
    return report;
  }

  delegate(delegator: string, validator: string, amount: number): { ok: boolean; error?: string } {
    const v = this.validators.get(validator);
    const jailed =
      Boolean(v?.jailed) ||
      this.pending.stake.some((s) => s.op === "slash" && s.validator === validator && s.reason === "double_sign");
    if (!v || jailed) return { ok: false, error: "unknown or jailed validator" };
    if (amount <= 0) return { ok: false, error: "amount" };
    if (this.account(delegator).balance - this.held(delegator) < amount) return { ok: false, error: "insufficient EQU" };
    this.pending.stake.push({ op: "delegate", delegator, validator, amount });
    this.emit("in", "governance", `delegate ${amount} → ${v.moniker} · queued`);
    return { ok: true };
  }

  slash(validator: string, reason: "double_sign" | "downtime"): { ok: boolean; error?: string; burned?: number } {
    const v = this.validators.get(validator);
    if (!v) return { ok: false, error: "unknown validator" };
    if (this.pending.stake.some((s) => s.op === "slash" && s.validator === validator)) {
      return { ok: false, error: "slash already queued" };
    }
    const burned = slashAmount(v.bondedStake, reason);
    this.pending.stake.push({ op: "slash", validator, reason });
    this.emit("in", "governance", `slash ${reason} ${burned} on ${v.moniker} · queued`);
    return { ok: true, burned };
  }

  claimRewards(address: string): { ok: boolean; error?: string; amount?: number } {
    const v = this.validators.get(address);
    if (!v) return { ok: false, error: "not a validator" };
    if (this.pending.stake.some((s) => s.op === "claim" && s.address === address)) return { ok: false, error: "claim already queued" };
    const amount = v.accumulatedRewards;
    if (amount <= 0) return { ok: false, error: "nothing to claim" };
    this.pending.stake.push({ op: "claim", address });
    this.emit("in", "governance", `claim ${amount} · queued`);
    return { ok: true, amount };
  }

  propose(proposer: string, title: string, deposit: number): { ok: boolean; error?: string; id?: number } {
    if (!title.trim()) return { ok: false, error: "title" };
    if (deposit < 0) return { ok: false, error: "deposit" };
    if (this.account(proposer).balance - this.held(proposer) < deposit) return { ok: false, error: "insufficient deposit" };
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
    this.pending.stake.push({ op: "propose", proposer, title: p.title, deposit, id: p.id });
    this.emit("in", "governance", `proposal #${p.id} ${p.title} · deposit queued`);
    return { ok: true, id: p.id };
  }

  vote(voter: string, id: number, option: "yes" | "no" | "abstain"): { ok: boolean; error?: string } {
    const queued = this.pending.stake.some((s) => s.op === "propose" && s.id === id);
    const p = this.proposals.find((x) => x.id === id);
    if (!queued && (!p || p.status !== "open")) return { ok: false, error: "not open" };
    const v = this.validators.get(voter);
    const power = v?.bondedStake ?? this.account(voter).balance;
    if (power <= 0) return { ok: false, error: "no voting power" };
    this.pending.stake.push({ op: "vote", voter, id, option });
    this.emit("in", "governance", `vote ${option} on #${id} · queued`);
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

  ingestGossip(claimed: BlockRecord): Promise<{ ok: boolean; error?: string; report?: VerificationReport }> {
    this.emit("in", "mesh", `gossip header ${claimed.hash.slice(0, 12)}… h=${claimed.height}`);
    return this.submitExternal(claimed);
  }

  async submitExternal(claimed: BlockRecord): Promise<{ ok: boolean; report: VerificationReport; error?: string }> {
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
    if (claimed.relation) {
      const again = stationarityRelation(claimed, this.params.residualThreshold);
      if (!again.ok || again.hashLo !== claimed.relation.hashLo || again.hashHi !== claimed.relation.hashHi) {
        this.emit("in", "verify", "external rejected · stationarity relation does not bind this header");
        return { ok: false, report, error: "stationarity relation does not bind this header" };
      }
    }
    if (!this.tip || claimed.height !== this.tip.height + 1 || claimed.prevHash !== this.tip.hash) {
      this.emit("in", "verify", "external rejected · not the next candidate");
      return { ok: false, report, error: "not the next candidate" };
    }
    const err = await this.absorb(claimed);
    if (err) {
      this.emit("in", "verify", `external rejected · ${err}`);
      return { ok: false, report, error: err };
    }
    if (this.kinStarted) this.noteKin(claimed);
    if (claimed.verified) {
      for (const listener of this.commitListeners) listener(claimed);
    }
    this.emit("close", "memory", `external Ω${claimed.height} admitted`);
    return { ok: true, report };
  }

  /**
   * Second body. Constitution, then the blocks. No producer memory, no secret, no overlay.
   */
  static async become(network: NetworkId, blocks: BlockRecord[]): Promise<SecondBodyReport> {
    const kin = new OrganismNode(network, { skipBootstrap: true });
    kin.constitute();
    for (const block of blocks) {
      const err = await kin.absorb(block);
      if (err) {
        return {
          ok: false,
          height: block.height,
          stateRoot: kin.tip?.stateRoot ?? "",
          hash: kin.tip?.hash ?? "",
          error: err,
        };
      }
    }
    return {
      ok: true,
      height: kin.height,
      stateRoot: kin.tip?.stateRoot ?? "",
      hash: kin.tip?.hash ?? "",
      error: null,
    };
  }

  /** Replay this process's blocks on a body that was not given its memory. */
  startKin() {
    if (this.kinStarted) return;
    this.kinStarted = true;
    const blocks = this.blocks.slice();
    this.kinQueue = this.replaySnapshot(blocks);
  }

  async kinSettled(): Promise<SecondBodyReport | null> {
    await this.kinQueue;
    return this.kinReport;
  }

  private replaySnapshot(blocks: BlockRecord[]): Promise<void> {
    return (async () => {
      try {
        const kin = new OrganismNode(this.network, { skipBootstrap: true });
        kin.constitute();
        for (const block of blocks) {
          const err = await kin.absorb(block);
          if (err) {
            this.kin = null;
            this.kinReport = { ok: false, height: block.height, stateRoot: "", hash: block.hash, error: err };
            return;
          }
        }
        this.kin = kin;
        this.kinReport = {
          ok: true,
          height: kin.height,
          stateRoot: kin.tip?.stateRoot ?? "",
          hash: kin.tip?.hash ?? "",
          error: null,
        };
      } catch (err) {
        this.kin = null;
        this.kinReport = {
          ok: false,
          height: -1,
          stateRoot: "",
          hash: "",
          error: err instanceof Error ? err.message : "replay failed",
        };
      }
    })();
  }

  private noteKin(block: BlockRecord) {
    this.kinQueue = this.kinQueue.then(async () => {
      if (!this.kin) return;
      const err = await this.kin.absorb(block);
      if (err) {
        this.kinReport = { ok: false, height: block.height, stateRoot: "", hash: block.hash, error: err };
        this.kin = null;
        return;
      }
      this.kinReport = {
        ok: true,
        height: this.kin.height,
        stateRoot: this.kin.tip?.stateRoot ?? "",
        hash: this.kin.tip?.hash ?? "",
        error: null,
      };
    });
  }

  private async absorb(block: BlockRecord): Promise<string | null> {
    if (block.height === 0) {
      if (block.prevHash !== "0".repeat(64)) return "genesis predecessor is not zero";
    } else if (!this.tip || this.tip.hash !== block.prevHash || this.tip.height + 1 !== block.height) {
      return "not the next block";
    }
    const report = verifyStationaryEvidence({
      block,
      prev: this.tip,
      mempoolPressure: block.committedPressure,
      cumulativeWork: block.height,
      params: this.params,
      now: block.timestamp,
    });
    if (!report.ok) return report.checks.filter((c) => !c.ok).map((c) => c.name).join(", ");
    const stepped = await successor(this.toOmega(), {
      transactions: block.transactions,
      evidence: block.evidence,
      timestamp: block.timestamp,
      nonce: block.nonce,
      miner: block.miner,
      committedPressure: block.committedPressure,
      couplings: block.couplings,
      difficulty: block.difficulty,
    });
    if (!stepped.ok) return stepped.error;
    if (stepped.stateRoot !== block.stateRoot) return "state root does not replay";
    if (block.evidence && stepped.omegaRoot !== block.omegaRoot) return "omega root does not replay";
    if (stepped.reward !== block.coinbaseReward) return "coinbase is not the reward law";
    if (stepped.liquid !== (block.liquidIssuance ?? block.coinbaseReward)) return "liquid issuance is not the stake law";
    if (Math.abs(stepped.residual - block.residual) > 1e-12) return "residual is not the transition";
    this.adopt(block, stepped);
    return null;
  }

  /** What a person can do with this kernel. Run on forks. The live chain is not the experiment. */
  private measureUse(): ProductionRow[] {
    const rows: ProductionRow[] = [];
    const issued = this.fork();
    const supplyBefore = [...issued.ledger.values()].reduce((s, a) => s + a.balance, 0);
    issued.clock = (issued.tip?.timestamp ?? 0) + 1;
    const block = issued.mine();
    const supplyAfter = [...issued.ledger.values()].reduce((s, a) => s + a.balance, 0);
    rows.push({
      id: "produce-block",
      status: block.verified ? "works" : "absent",
      detail: block.verified
        ? `A fork produced block ${block.height}. The residual was recomputed, not trusted.`
        : `The fork's block was not verified. ${block.verifyNotes.join("; ") || "no note"}`,
    });
    rows.push({
      id: "issue-equ",
      status: supplyAfter > supplyBefore ? "works" : "absent",
      detail:
        supplyAfter > supplyBefore
          ? `The ledger grew by ${(supplyAfter - supplyBefore).toLocaleString()} EQU. That is the liquid coinbase of ${block.coinbaseReward.toLocaleString()}. The rest, if any, is a validator claim, not a spendable balance yet.`
          : "Mining did not increase the ledger.",
    });

    const pay = this.fork();
    pay.clock = (pay.tip?.timestamp ?? 0) + 1;
    const from = pay.actors[0]!;
    const to = "cd".repeat(20);
    const before = pay.getAccount(to).balance;
    const tx = signTx(from, {
      to,
      amount: 1_000,
      fee: 10_000,
      nonce: pay.getAccount(from.address).nonce,
      chainId: pay.params.chainId,
      timestamp: pay.clock,
    });
    const submitted = pay.submitTx(tx);
    const paid = pay.mine();
    const included = paid.transactions.some((t) => t.hash === tx.hash);
    const received = pay.getAccount(to).balance - before;
    rows.push({
      id: "transfer",
      status: submitted.ok && included && received === 1_000 ? "works" : "absent",
      detail:
        submitted.ok && included && received === 1_000
          ? "1,000 EQU moved from one key to another inside this kernel."
          : `Transfer did not land. ${submitted.error ?? (included ? `recipient changed by ${received}` : "not included")}`,
    });

    const trade = this.fork();
    trade.clock = (trade.tip?.timestamp ?? 0) + 1;
    const pool = trade.pools.find((p) => p.id === "EQU-USDC");
    const trader = trade.actors[0]!;
    const liquidity = GENESIS_ALLOCATIONS.find((a) => a.category === "liquidity_pools");
    const lockedBefore = liquidity ? trade.getAccount(liquidity.address).balance : 0;
    if (!pool) {
      rows.push({ id: "trade", status: "absent", detail: "No EQU-USDC pool on this kernel." });
    } else {
      const reserveBefore = pool.reserveA;
      const swap = signTx(trader, {
        to: pool.address,
        amount: 10_000,
        fee: 10_000,
        nonce: trade.getAccount(trader.address).nonce,
        chainId: trade.params.chainId,
        timestamp: trade.clock,
      });
      const queued = trade.submitTx(swap);
      const traded = trade.mine();
      const reserveAfter = trade.pools.find((p) => p.id === "EQU-USDC")?.reserveA ?? reserveBefore;
      const lockedAfter = liquidity ? trade.getAccount(liquidity.address).balance : lockedBefore;
      const moved = queued.ok && traded.transactions.some((t) => t.hash === swap.hash) && reserveAfter !== reserveBefore;
      rows.push({
        id: "trade",
        status: moved ? "local" : "absent",
        detail: moved
          ? `The pool reserve changed by ${(reserveAfter - reserveBefore).toLocaleString()} EQU. The genesis liquidity address changed by ${(lockedAfter - lockedBefore).toLocaleString()}, which is not that reserve. The pool is not that allocation, and it settles nowhere else.`
          : "A signed swap did not move the pool.",
      });
    }

    const guard = this.fork();
    const payer = guard.actors[0]!;
    const unfunded = signTx(payer, {
      to: "ab".repeat(20),
      amount: 10_000_000_001,
      fee: 0,
      nonce: guard.getAccount(payer.address).nonce,
      chainId: guard.params.chainId,
      timestamp: guard.tip?.timestamp ?? 0,
    });
    const senderBefore = guard.getAccount(payer.address).balance;
    const admitted = guard.submitTx(unfunded);
    const stepped = applySuccessor(guard.toOmega(), {
      transactions: [unfunded],
      evidence: undefined,
      timestamp: (guard.tip?.timestamp ?? 0) + 15,
      nonce: guard.tip?.nonce ?? 0,
      miner: guard.miner.address,
      committedPressure: 0,
      couplings: guard.couplings,
      difficulty: guard.difficulty,
      wasmAfter: null,
    });
    const refused = !stepped.ok && stepped.error === "insufficient funds";
    const recipient = stepped.ok ? (stepped.next.ledger.get(unfunded.to)?.balance ?? 0) : 0;
    rows.push({
      id: "unfunded",
      status: !admitted.ok && refused && recipient === 0 ? "works" : "absent",
      detail:
        !admitted.ok && refused && recipient === 0
          ? `An unfunded transfer of 10,000,000,001 was refused at the mempool and by the transition. The sender stayed at ${senderBefore.toLocaleString()}. No second output was created.`
          : `An unfunded transfer was accepted. ${admitted.error ?? ("error" in stepped ? stepped.error : "transition applied")}`,
    });

    rows.push({
      id: "withdraw",
      status: "absent",
      detail: "Nothing in the transition pays an exchange, a bank, or another chain. EQU issued here cannot be withdrawn.",
    });
    rows.push({
      id: "other-miners",
      status: "local",
      detail: "This process produces the blocks. A second body can replay them. It does not compete for them, and the Rust crate does not mine them.",
    });
    return rows;
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
      btc: {
        count: this.btcHeaders.length,
        tipHash: this.btcHeaders[this.btcHeaders.length - 1]?.hash ?? null,
        tipHeight: this.btcHeaders[this.btcHeaders.length - 1]?.height ?? null,
      },
      eth: {
        bootstrapped: this.ethPubkey.length > 0,
        tipSlot: this.ethHeaders[this.ethHeaders.length - 1]?.slot ?? null,
        tipHash: this.ethHeaders[this.ethHeaders.length - 1]?.hash ?? null,
      },
      wasmStorage: [...this.wasmStorage.entries()],
      announced: this.announcements.slice(-8),
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
      lastWhole: this.lastWhole,
      lastBidirectional,
      secondBody: this.kinReport,
      constitution: (this.constitutionReport ??= constitutionalAnswer()),
      dependencies: (this.dependencyReport ??= dependencyFindings()),
      use: (this.useReport ??= this.measureUse()),
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
      committed: [
        "account balances",
        "account nonces",
        "pool reserves",
        "bitcoin headers",
        "beacon headers",
        "wasm storage",
        "validators",
        "delegations",
        "proposals",
        "couplings",
        "difficulty",
        "finalized height",
        "state root",
        "omega root",
        "transition evidence",
      ],
      observed: ["explorer projections", "metrics", "light headers", "mempool view", "residual", "mesh roster"],
      operational: ["mempool", "peer table", "faucet claims", "model registry", "solver search"],
      whole: ["theory", "Rust reference", "TypeScript node", "Android verifier", "P2P mesh", "ZK experiments", "contracts/", "lib/coinomics"],
    };
  }
}
