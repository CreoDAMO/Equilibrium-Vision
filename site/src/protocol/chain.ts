import type {
  AccountState,
  BlockRecord,
  BlockStat,
  ChainSnapshot,
  Couplings,
  Delegation,
  Unbonding,
  Withdrawal,
  EthExecutionHeader,
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
  Settlement,
  TakeoverReport,
  StakeEvidence,
  ProductionRow,
  DependencyRow,
  ConstitutionAnswer,
} from "./types";
import { DEFAULT_COUPLINGS } from "./types";
import { NETWORKS } from "./networks";
import { addressFromPubkeyHex, merkleRoot, residualsMatch, sha256Hex } from "./crypto";
import { evaluateResidual, solveStationary } from "./solver";
import { verifyStationaryEvidence } from "./verify";
import { signTx, verifyTx, type Keypair } from "./wallet";
import { signWithdraw, verifyDelegateEvidence, verifyUnbondEvidence, verifyWithdrawEvidence, withdrawalId, WITHDRAWAL_ESCROW } from "./authority";
import { slashAmount } from "./coinomics";
import { challengeBinding, modelBinding } from "./membranes";
import { applySwap, poolAddress, quoteSwap } from "./dex";
import { buildP2pkhTx, decodeHeaderHex, decodeTxHex, isBtcDestination, parseBtcHeader, parseBtcTx, proveBtcOutput, verifyBtcMerkle, verifyBtcPow } from "./btc";
import { decodeEvenHex, executionHeader, isEthAsset, isEthDestination, legacyReceipt, parseExecutionHeader, proveEthEffect, rlpUint, secureLeaf, TRANSFER_TOPIC } from "./eth-exec";
import { callArbitrage } from "./wasm-host";
import {
  ETH_MIN_PARTICIPANTS,
  committeeAggregate,
  committeeRaw,
  countParticipants,
  hashEthHeader,
  hexOf,
  hexToBytes as ethHex,
  participationMask,
  signSelected,
  syncCommittee,
  verifySelectedHeader,
} from "./eth-light";
import { asBlockNonce, foreignNonce, participationBytes, popcount } from "./domain";
import { onPlaneMessage } from "./network-plane";
import { stationarityRelation } from "./relation";
import { bytesToHex, hexToBytes } from "./bytes";
import { ARBITRAGE_CODE } from "./evidence";
import { selectSuccessorTxs } from "./tx-select";
import { chainWeight, preferChain } from "./frontier";
import { sealFromSuccessor } from "./seal";
import {
  applySuccessor,
  cloneOmega,
  constitutionalAnswer,
  initialOmega,
  openOmega,
  openedCouplings,
  omegaDigest,
  successor,
  transitionDigest,
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
  ethCommittee = "";
  private ethSecrets: Uint8Array[] | null = null;
  wasmStorage = new Map<string, string>();
  announcements: string[] = [];
  peers: PeerRecord[] = [];
  couplings: Couplings = { ...DEFAULT_COUPLINGS };
  lastVerify: VerificationReport | null = null;
  difficulty: number;
  lastMineAt = 0;
  persisted = false;
  delegations: Delegation[] = [];
  unbonding: Unbonding[] = [];
  withdrawals: Withdrawal[] = [];
  ethExecution: EthExecutionHeader[] = [];
  proposals: Proposal[] = [];
  models: ModelClaim[] = [];
  settlements: Settlement[] = [];
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
    cognition: [],
    settle: [],
    withdraw: [],
  };
  private pendingWasm: Map<string, string> | null = null;
  private kin: OrganismNode | null = null;
  private kinStarted = false;
  private kinQueue: Promise<void> = Promise.resolve();
  /** Competing blocks. Operational only. None of these is canonical until EQ-09 selects one. */
  private frontier = new Map<string, BlockRecord>();
  private settleAgain = false;

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
    n.blocks = (body.blocks ?? []).map((block) => ({ ...block, nonce: foreignNonce(block.nonce) }));
    n.ledger = new Map(body.accounts ?? []);
    n.validators = new Map((body.validators ?? []).map((v) => [v.address, v]));
    n.mempool = new Map((body.mempool ?? []).map((t) => [t.hash, t]));
    n.txIndex = new Map((body.txs ?? []).map((t) => [t.hash, t]));
    n.pools = (body.pools ?? n.pools).map((p) => ({ ...p, address: p.address || poolAddress(p.id) }));
    n.btcHeaders = body.btcHeaders ?? [];
    n.ethHeaders = body.ethHeaders ?? [];
    n.ethPubkey = body.ethPubkey ?? "";
    n.ethCommittee = body.ethCommittee ?? "";
    n.wasmStorage = new Map(body.wasmStorage ?? []);
    n.delegations = body.delegations ?? [];
    n.unbonding = body.unbonding ?? [];
    n.withdrawals = body.withdrawals ?? [];
    n.ethExecution = body.ethExecution ?? [];
    n.proposals = body.proposals ?? [];
    n.models = body.models ?? [];
    n.settlements = body.settlements ?? [];
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
    n.ethCommittee = this.ethCommittee;
    n.ethSecrets = this.ethSecrets ? this.ethSecrets.map((secret) => new Uint8Array(secret)) : null;
    n.wasmStorage = new Map(this.wasmStorage);
    n.couplings = { ...this.couplings };
    n.difficulty = this.difficulty;
    n.finalizedThrough = this.finalizedThrough;
    n.lastMineAt = this.lastMineAt;
    n.clock = this.clock;
    n.delegations = this.delegations.map((d) => ({ ...d }));
    n.unbonding = this.unbonding.map((u) => ({ ...u }));
    n.withdrawals = this.withdrawals.map((w) => ({ ...w }));
    n.ethExecution = this.ethExecution.map((h) => ({ ...h }));
    n.proposals = this.proposals.map((p) => ({ ...p }));
    n.models = this.models.map((m) => ({ ...m }));
    n.settlements = this.settlements.map((s) => ({ ...s }));
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
      ethCommittee: this.ethCommittee,
      eth: this.ethHeaders.map((h) => ({ ...h })),
      wasm: new Map(this.wasmStorage),
      validators: new Map([...this.validators.entries()].map(([k, v]) => [k, { ...v }])),
      delegations: this.delegations.map((d) => ({ ...d })),
      unbonding: this.unbonding.map((u) => ({ ...u })),
      withdrawals: this.withdrawals.map((w) => ({ ...w })),
      ethExecution: this.ethExecution.map((h) => ({ ...h })),
      proposals: this.proposals.map((p) => ({ ...p })),
      models: this.models.map((m) => ({ ...m })),
      settlements: this.settlements.map((s) => ({ ...s })),
      finalizedHeight: this.finalizedThrough,
    };
  }

  private installNext(next: ReturnType<OrganismNode["toOmega"]>, swaps: SwapEvent[]) {
    this.ledger = next.ledger;
    this.pools = next.pools;
    this.btcHeaders = next.btc;
    this.ethHeaders = next.eth;
    this.ethPubkey = next.ethPubkey;
    this.ethCommittee = next.ethCommittee;
    this.wasmStorage = next.wasm;
    this.validators = next.validators;
    this.delegations = next.delegations;
    this.unbonding = next.unbonding;
    this.withdrawals = next.withdrawals;
    this.ethExecution = next.ethExecution;
    this.proposals = next.proposals;
    this.models = next.models;
    this.settlements = next.settlements;
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
      cognition: [],
      settle: [],
      withdraw: [],
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
      cognition: (ev.cognition ?? []).map((c) => ({ ...c })),
      settle: (ev.settle ?? []).map((s) => ({ ...s })),
      withdraw: (ev.withdraw ?? []).map((w) => {
        if (w.op === "settle") return { ...w, merkle: [...w.merkle] };
        if (w.op === "settleEth") return { ...w, receiptProof: [...w.receiptProof], txProof: [...w.txProof] };
        return { ...w };
      }),
    };
  }

  private held(addr: string): number {
    return this.pending.stake.reduce((sum, op) => {
      if (op.op === "delegate" && op.delegator === addr) return sum + op.amount;
      if (op.op === "propose" && op.proposer === addr) return sum + op.deposit;
      return sum;
    }, 0) + (this.pending.settle ?? []).reduce((sum, op) => {
      if (op.op === "lock" && op.from === addr) return sum + op.amount;
      return sum;
    }, 0) + (this.pending.withdraw ?? []).reduce((sum, op) => {
      if (op.op === "open" && op.sender === addr) return sum + op.amount;
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
    const opened = cloneOmega(this.toOmega());
    openOmega(opened);
    const couplings = opened.couplings;
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
      couplings,
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
        nonce: asBlockNonce(solution.nonce),
        miner: args.miner,
        committedPressure: pressure,
        couplings,
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
    const sealed = sealFromSuccessor(omega, {
      transactions: args.txs,
      evidence,
      timestamp: args.timestamp,
      nonce: asBlockNonce(solution.nonce),
      miner: args.miner,
      committedPressure: pressure,
      couplings,
      difficulty: this.difficulty,
      wasmAfter,
    }, stepped);
    const hash = sealed.hash;
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
      couplings: { ...couplings },
      breakdown: stepped.breakdown,
      solverIterations: solution.iterations,
      verified: false,
      verifyNotes: [],
      evidence,
      omegaRoot: stepped.omegaRoot,
      transitionRoot: sealed.transitionRoot,
    };
    block.relation = stationarityRelation(block, this.params.residualThreshold);
    const report = verifyStationaryEvidence({
      block,
      prev: this.tip,
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
    const producer = this.validators.get(this.miner.address);
    if (!producer || producer.jailed || producer.slashed || producer.bondedStake <= 0) {
      throw new Error("miner is not a live validator");
    }
    const prev = this.tip!;
    const height = prev.height + 1;
    const now = Math.max(prev.timestamp + 1, at ?? this.clock ?? Math.floor(Date.now() / 1000));
    const preview = this.pools.map((p) => ({ ...p }));
    const verified: TxRecord[] = [];
    for (const tx of this.mempool.values()) {
      if (!verifyTx(tx, this.params.chainId)) {
        this.mempool.delete(tx.hash);
        continue;
      }
      const pool = preview.find((p) => (p.address || poolAddress(p.id)) === tx.to);
      if (pool && quoteSwap(pool, pool.tokenA, tx.amount) <= 0) continue;
      verified.push(tx);
    }
    const selected = selectSuccessorTxs(
      (addr) => this.account(addr).balance - this.held(addr),
      (addr) => this.account(addr).nonce,
      verified,
      this.params.maxTxPerBlock,
      (tx) => !preview.some((p) => (p.address || poolAddress(p.id)) === tx.to),
    );
    for (const tx of selected) {
      const pool = preview.find((p) => (p.address || poolAddress(p.id)) === tx.to);
      if (pool) applySwap(pool, pool.tokenA, tx.amount);
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
      nonce: asBlockNonce(block.nonce),
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
    if (block.transitionRoot) {
      const expected = transitionDigest(this.toOmega(), {
        transactions: block.transactions,
        evidence: ev,
        timestamp: block.timestamp,
        nonce: asBlockNonce(block.nonce),
        miner: block.miner,
        committedPressure: block.committedPressure,
        couplings: block.couplings,
        difficulty: block.difficulty,
        wasmAfter: null,
      });
      if (block.transitionRoot !== expected) {
        this.emit("in", "verify", "transition is not this input");
        return false;
      }
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

  private ethStaged(): { pubkey: string; committee: string; headers: EthHeaderRecord[] } {
    let pubkey = this.ethPubkey;
    let committee = this.ethCommittee;
    const headers = this.ethHeaders.map((h) => ({ ...h }));
    for (const item of this.pending.eth) {
      if (item.op === "bootstrap" || item.op === "rotate") {
        pubkey = item.aggregate;
        committee = item.committee;
        continue;
      }
      const fields = {
        slot: item.slot,
        proposerIndex: item.proposerIndex,
        parentRoot: item.parentRoot,
        stateRoot: item.stateRoot,
        bodyRoot: item.bodyRoot,
      };
      const bits = participationBytes(item.participation);
      headers.push({
        slot: item.slot,
        hash: hexOf(hashEthHeader(fields, bits)),
        parentRoot: item.parentRoot,
        stateRoot: item.stateRoot,
        bodyRoot: item.bodyRoot,
        participants: popcount(bits),
        participation: hexOf(bits),
      });
    }
    return { pubkey, committee, headers };
  }

  /**
   * Queue a 512-key committee. The aggregate is derived here and checked
   * again by G. Secrets stay in this process and are not written into the
   * block. This is not Ethereum's sync committee.
   */
  bootstrapEth(supplied?: { committee: string; aggregate: string }): {
    ok: boolean;
    error?: string;
    pubkey?: string;
    committee?: string;
  } {
    const staged = this.ethStaged();
    if (staged.committee) return { ok: false, error: "already bootstrapped", pubkey: staged.pubkey };
    let committee: string;
    let aggregate: string;
    if (supplied) {
      const raw = committeeRaw(supplied.committee);
      const derived = raw ? committeeAggregate(supplied.committee) : null;
      if (!raw || !derived) return { ok: false, error: "eth committee refused" };
      const claim = supplied.aggregate.trim().replace(/^0x/i, "").toLowerCase();
      if (claim !== derived) return { ok: false, error: "eth aggregate is not the committee" };
      committee = hexOf(raw);
      aggregate = derived;
      this.ethSecrets = null;
    } else {
      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      const built = syncCommittee((buf[0]! % 0x7ffffffe) + 1);
      committee = built.committee;
      aggregate = built.aggregate;
      this.ethSecrets = built.secrets.map((secret) => new Uint8Array(secret));
    }
    this.pending.eth.push({ op: "bootstrap", committee, aggregate });
    this.emit("in", "verify", `ETH committee queued · ${aggregate.slice(0, 16)}… · no credit`);
    return { ok: true, pubkey: aggregate, committee };
  }

  submitEthHeader(header: {
    slot: number;
    proposerIndex?: number;
    parentRoot: string;
    stateRoot: string;
    bodyRoot: string;
    participation: string;
    signature: string;
  }): { ok: boolean; error?: string; hash?: string } {
    const staged = this.ethStaged();
    if (!staged.committee) return { ok: false, error: "not bootstrapped" };
    let bits: Uint8Array;
    try {
      bits = participationBytes(header.participation);
    } catch {
      return { ok: false, error: "participation refused" };
    }
    if (popcount(bits) < ETH_MIN_PARTICIPANTS) return { ok: false, error: "quorum not met" };
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
    if (!verifySelectedHeader(staged.committee, fields, sig, bits)) return { ok: false, error: "bad signature" };
    const hash = hexOf(hashEthHeader(fields, bits));
    this.pending.eth.push({
      op: "header",
      slot: fields.slot,
      proposerIndex: fields.proposerIndex,
      parentRoot: fields.parentRoot,
      stateRoot: fields.stateRoot,
      bodyRoot: fields.bodyRoot,
      participation: hexOf(bits),
      signature: header.signature.replace(/^0x/, ""),
    });
    this.emit("in", "verify", `ETH header slot ${header.slot} queued · no credit`);
    return { ok: true, hash };
  }

  /** Sign the next header with the in-process committee. Refuses if those secrets were not kept. */
  signNextEthHeader(bodyRoot: string, stateRoot: string): { ok: boolean; error?: string; header?: {
    slot: number;
    proposerIndex: number;
    parentRoot: string;
    stateRoot: string;
    bodyRoot: string;
    participation: string;
    signature: string;
  } } {
    if (!this.ethSecrets) return { ok: false, error: "no local signing key" };
    const tip = this.ethStaged().headers.at(-1);
    const fields = {
      slot: tip ? tip.slot + 1 : 1,
      proposerIndex: 0,
      parentRoot: tip ? tip.hash : "00".repeat(32),
      stateRoot,
      bodyRoot,
    };
    const bits = participationMask(ETH_MIN_PARTICIPANTS);
    if (countParticipants(bits) < ETH_MIN_PARTICIPANTS) return { ok: false, error: "mask short" };
    const signature = hexOf(signSelected(this.ethSecrets, fields, bits));
    return { ok: true, header: { ...fields, participation: hexOf(bits), signature } };
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
      ethCommittee: this.ethCommittee,
      ethHeaders: this.ethHeaders,
      delegations: this.delegations,
      unbonding: this.unbonding,
      withdrawals: this.withdrawals,
      ethExecution: this.ethExecution,
      proposals: this.proposals,
      models: this.models,
      settlements: this.settlements,
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

  delegate(
    delegator: string,
    validator: string,
    amount: number,
    proof?: { publicKey: string; signature: string },
  ): { ok: boolean; error?: string } {
    const v = this.validators.get(validator);
    const jailed =
      Boolean(v?.jailed) ||
      this.pending.stake.some((s) => s.op === "slash" && s.validator === validator && s.reason === "double_sign");
    if (!v || jailed) return { ok: false, error: "unknown or jailed validator" };
    if (amount <= 0) return { ok: false, error: "amount" };
    if (!proof) return { ok: false, error: "delegate authority refused" };
    const refused = verifyDelegateEvidence(this.params.chainId, {
      delegator,
      validator,
      amount,
      publicKey: proof.publicKey,
      signature: proof.signature,
    });
    if (refused) return { ok: false, error: refused };
    if (this.account(delegator).balance - this.held(delegator) < amount) return { ok: false, error: "insufficient EQU" };
    this.pending.stake.push({
      op: "delegate",
      delegator,
      validator,
      amount,
      publicKey: proof.publicKey,
      signature: proof.signature,
    });
    this.emit("in", "governance", `delegate ${amount} → ${v.moniker} · queued`);
    return { ok: true };
  }

  unbond(
    delegator: string,
    validator: string,
    amount: number,
    proof?: { publicKey: string; signature: string },
  ): { ok: boolean; error?: string } {
    const v = this.validators.get(validator);
    if (!v || v.jailed || v.slashed) return { ok: false, error: "unbond refused" };
    if (!proof) return { ok: false, error: "unbond authority refused" };
    const refused = verifyUnbondEvidence(this.params.chainId, {
      delegator,
      validator,
      amount,
      publicKey: proof.publicKey,
      signature: proof.signature,
    });
    if (refused) return { ok: false, error: refused };
    const queued = this.pending.stake.reduce((sum, op) => {
      if (op.op === "unbond" && op.delegator === delegator && op.validator === validator) return sum + op.amount;
      return sum;
    }, 0);
    const available = this.delegations.reduce((sum, d) => {
      if (d.delegator === delegator && d.validator === validator) return sum + d.amount;
      return sum;
    }, 0);
    if (available - queued < amount) return { ok: false, error: "unbond funds refused" };
    this.pending.stake.push({
      op: "unbond",
      delegator,
      validator,
      amount,
      publicKey: proof.publicKey,
      signature: proof.signature,
    });
    this.emit("in", "governance", `unbond ${amount} from ${v.moniker} · queued`);
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

  propose(
    proposer: string,
    title: string,
    deposit: number,
    coupling?: { key: keyof Couplings; value: number },
  ): { ok: boolean; error?: string; id?: number } {
    if (!title.trim() || title.length > 80) return { ok: false, error: "title" };
    if (!Number.isSafeInteger(deposit) || deposit < 0) return { ok: false, error: "deposit" };
    const proposerV = this.validators.get(proposer);
    if (!proposerV || proposerV.jailed || proposerV.slashed || proposerV.bondedStake <= 0) {
      return { ok: false, error: "proposal proposer unauthorized" };
    }
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
    this.pending.stake.push({
      op: "propose",
      proposer,
      title: p.title,
      deposit,
      id: p.id,
      ...(coupling ? { couplingKey: coupling.key, couplingValue: coupling.value } : {}),
    });
    this.emit("in", "governance", `proposal #${p.id} ${p.title} · deposit queued`);
    return { ok: true, id: p.id };
  }

  vote(voter: string, id: number, option: "yes" | "no" | "abstain"): { ok: boolean; error?: string } {
    const queued = this.pending.stake.some((s) => s.op === "propose" && s.id === id);
    const p = this.proposals.find((x) => x.id === id);
    if (!queued && (!p || p.status !== "open")) return { ok: false, error: "not open" };
    const v = this.validators.get(voter);
    if (!v || v.jailed || v.slashed || v.bondedStake <= 0) return { ok: false, error: "vote refused" };
    if (p?.ballots?.some((b) => b.voter === voter)) return { ok: false, error: "vote already cast" };
    if (this.pending.stake.some((s) => s.op === "vote" && s.voter === voter && s.id === id)) {
      return { ok: false, error: "vote already cast" };
    }
    this.pending.stake.push({ op: "vote", voter, id, option });
    this.emit("in", "governance", `vote ${option} on #${id} · queued`);
    return { ok: true };
  }

  proposeModel(uri: string, residualFp: number, supportHash: string): { ok: true; id: number } | { ok: false; error: string } {
    if (!uri.trim() || uri.length > 128) return { ok: false, error: "model uri refused" };
    if (!Number.isSafeInteger(residualFp) || residualFp < 0) return { ok: false, error: "model residual refused" };
    if (!/^[0-9a-f]{64}$/.test(supportHash)) return { ok: false, error: "model support refused" };
    const used = [
      ...this.models.map((m) => m.id),
      ...(this.pending.cognition ?? []).flatMap((c) => (c.kind === "bind" ? [] : [c.id])),
    ];
    const id = (used.length ? Math.max(...used) : 0) + 1;
    const claim = {
      kind: "model" as const,
      id,
      uri: uri.slice(0, 128),
      residualFp,
      supportHash,
      proof: modelBinding(this.params.chainId, { id, uri: uri.slice(0, 128), residualFp, supportHash }),
    };
    this.pending.cognition = [...(this.pending.cognition ?? []), claim];
    this.emit("in", "governance", `model #${id} staged for the successor`);
    return { ok: true, id };
  }

  challengeModel(id: number, supportHash: string): { ok: true } | { ok: false; error: string } {
    const row = this.models.find((m) => m.id === id);
    if (!row || row.status === "slashed") return { ok: false, error: "model is not bound" };
    if (!/^[0-9a-f]{64}$/.test(supportHash) || supportHash === row.supportHash) {
      return { ok: false, error: "challenge does not disagree" };
    }
    this.pending.cognition = [
      ...(this.pending.cognition ?? []),
      { kind: "challenge", id, supportHash, proof: challengeBinding(this.params.chainId, id, supportHash) },
    ];
    this.emit("in", "governance", `model #${id} challenge staged`);
    return { ok: true };
  }

  lockForeign(
    from: string,
    to: string,
    amount: number,
    asset: "btc" | "eth",
    foreignRef: string,
  ): { ok: true; id: number } | { ok: false; error: string } {
    if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, error: "settlement amount refused" };
    if (this.account(from).balance - this.held(from) < amount) return { ok: false, error: "settlement lock refused" };
    const known = asset === "btc"
      ? this.btcHeaders.some((h) => h.hash === foreignRef) || this.pending.btc.length > 0
      : this.ethHeaders.some((h) => h.hash === foreignRef) || this.pending.eth.some((e) => e.op === "header");
    if (!known) return { ok: false, error: "foreign observation is not in Ω" };
    const used = [
      ...this.settlements.map((s) => s.id),
      ...(this.pending.settle ?? []).flatMap((s) => (s.op === "lock" ? [s.id] : [])),
    ];
    const id = (used.length ? Math.max(...used) : 0) + 1;
    this.pending.settle = [
      ...(this.pending.settle ?? []),
      { op: "lock", id, asset, foreignRef, from, to, amount },
    ];
    this.emit("in", "bridge", `lock ${amount} EQU against ${asset} ${foreignRef.slice(0, 12)} · staged`);
    return { ok: true, id };
  }

  releaseForeign(id: number): { ok: true } | { ok: false; error: string } {
    const row = this.settlements.find((s) => s.id === id && s.status === "locked");
    const staged = (this.pending.settle ?? []).some((s) => s.op === "lock" && s.id === id);
    if (!row && !staged) return { ok: false, error: "settlement is not locked" };
    if ((this.pending.settle ?? []).some((s) => s.op === "release" && s.id === id)) {
      return { ok: false, error: "release already queued" };
    }
    this.pending.settle = [...(this.pending.settle ?? []), { op: "release", id }];
    this.emit("in", "bridge", `release settlement #${id} · staged`);
    return { ok: true };
  }

  /**
   * Stage a signed withdrawal. The debit happens in the successor, not here.
   * Ethereum locks only for an eth destination. The receipt is checked at settle.
   * This is not lockForeign.
   */
  openWithdrawal(input: {
    amount: number;
    network: "btc" | "eth";
    asset: string;
    destination: string;
    nonce: number;
    publicKey: string;
    signature: string;
  }): { ok: true; id: string } | { ok: false; error: string } {
    let sender = "";
    try {
      sender = addressFromPubkeyHex(input.publicKey);
    } catch {
      return { ok: false, error: "withdraw authority refused" };
    }
    const refused = verifyWithdrawEvidence(this.params.chainId, { ...input, sender });
    if (refused) return { ok: false, error: refused };
    if (input.network === "eth") {
      if (!isEthDestination(input.destination)) return { ok: false, error: "withdrawal destination refused" };
      if (!isEthAsset(input.asset)) return { ok: false, error: "withdrawal asset refused" };
    } else if (input.network === "btc") {
      if (input.asset !== "btc") return { ok: false, error: "withdrawal asset refused" };
      if (!isBtcDestination(input.destination)) return { ok: false, error: "withdrawal destination refused" };
    } else return { ok: false, error: "withdrawal network refused" };
    const id = withdrawalId({
      chainId: this.params.chainId,
      sender,
      amount: input.amount,
      network: input.network,
      asset: input.asset,
      destination: input.destination,
      nonce: input.nonce,
    });
    const staged = (this.pending.withdraw ?? []).some((w) => w.op === "open" && w.sender === sender && w.nonce === input.nonce && w.destination === input.destination && w.amount === input.amount);
    if (this.withdrawals.some((w) => w.id === id) || staged) return { ok: false, error: "withdrawal exists" };
    if (this.account(sender).balance - this.held(sender) < input.amount) return { ok: false, error: "withdrawal funds refused" };
    this.pending.withdraw = [
      ...(this.pending.withdraw ?? []),
      {
        op: "open",
        sender,
        amount: input.amount,
        network: input.network,
        asset: input.asset,
        destination: input.destination,
        nonce: input.nonce,
        publicKey: input.publicKey,
        signature: input.signature,
      },
    ];
    this.emit("in", "bridge", `withdraw ${input.amount} EQU → ${input.network} ${input.destination} · staged`);
    return { ok: true, id };
  }

  settleWithdrawal(input: {
    id: string;
    rawTx: string;
    vout: number;
    headerHash: string;
    merkle: string[];
  }): { ok: true } | { ok: false; error: string } {
    const row = this.withdrawals.find((w) => w.id === input.id);
    if (!row || row.status !== "locked") return { ok: false, error: "withdrawal is not locked" };
    if (this.height + 1 >= row.expiryHeight) return { ok: false, error: "withdrawal expired" };
    if (row.network === "eth") return { ok: false, error: "eth execution proof refused" };
    const raw = decodeTxHex(input.rawTx);
    if (!raw) return { ok: false, error: "btc transaction refused" };
    const header = this.btcHeaders.find((h) => h.hash === input.headerHash);
    if (!header) return { ok: false, error: "btc header is not in Ω" };
    const proved = proveBtcOutput(raw, input.vout, input.merkle, header.merkleRoot);
    if (!proved.ok) return proved;
    if (proved.destination !== row.destination || proved.amount !== row.amount || row.asset !== "btc") {
      return { ok: false, error: "withdrawal binding refused" };
    }
    if (this.withdrawals.some((w) => w.effectLocator === proved.locator)) {
      return { ok: false, error: "effect already settled" };
    }
    if ((this.pending.withdraw ?? []).some((w) => w.op === "settle" && w.id === input.id)) {
      return { ok: false, error: "withdrawal is not locked" };
    }
    this.pending.withdraw = [
      ...(this.pending.withdraw ?? []),
      {
        op: "settle",
        id: input.id,
        rawTx: input.rawTx.trim().toLowerCase().replace(/^0x/, ""),
        vout: input.vout,
        headerHash: input.headerHash,
        merkle: input.merkle,
      },
    ];
    this.emit("in", "bridge", `settle withdrawal ${input.id.slice(0, 12)} · staged`);
    return { ok: true };
  }

  private executionWindow(): { ok: true; headers: EthExecutionHeader[] } | { ok: false; error: string } {
    const headers = this.ethExecution.map((h) => ({ ...h }));
    for (const item of this.pending.withdraw ?? []) {
      if (item.op !== "exec") continue;
      const raw = decodeEvenHex(item.headerRlp);
      if (!raw) return { ok: false, error: "eth header refused" };
      const parsed = parseExecutionHeader(raw);
      if (!parsed) return { ok: false, error: "eth header refused" };
      if (headers.some((h) => h.hash === parsed.hash)) return { ok: false, error: "eth header exists" };
      const tip = headers[headers.length - 1];
      if (tip) {
        if (parsed.parentHash !== tip.hash) return { ok: false, error: "eth parent does not match the tip" };
        if (parsed.number !== tip.number + 1) return { ok: false, error: "eth number does not extend the tip" };
      }
      headers.push(parsed);
      if (headers.length > 256) headers.shift();
    }
    return { ok: true, headers };
  }

  /** Stage an execution header. The first one is a structural bootstrap, not a sync-committee checkpoint. */
  admitExecution(headerRlp: string): { ok: true; hash: string } | { ok: false; error: string } {
    const window = this.executionWindow();
    if (!window.ok) return window;
    const raw = decodeEvenHex(headerRlp);
    if (!raw) return { ok: false, error: "eth header refused" };
    const parsed = parseExecutionHeader(raw);
    if (!parsed) return { ok: false, error: "eth header refused" };
    if (window.headers.some((h) => h.hash === parsed.hash)) return { ok: false, error: "eth header exists" };
    const tip = window.headers[window.headers.length - 1];
    if (tip) {
      if (parsed.parentHash !== tip.hash) return { ok: false, error: "eth parent does not match the tip" };
      if (parsed.number !== tip.number + 1) return { ok: false, error: "eth number does not extend the tip" };
    }
    const clean = headerRlp.trim().toLowerCase().replace(/^0x/, "");
    this.pending.withdraw = [...(this.pending.withdraw ?? []), { op: "exec", headerRlp: clean }];
    this.emit("in", "bridge", `ethereum execution header ${parsed.hash.slice(0, 12)} · staged`);
    return { ok: true, hash: parsed.hash };
  }

  /**
   * Stage an Ethereum receipt proof. The roots come from the admitted header, not from the caller.
   * A beacon bodyRoot is not that root.
   */
  settleEthWithdrawal(input: {
    id: string;
    blockHash: string;
    txIndex: number;
    receiptRlp: string;
    receiptProof: string[];
    logIndex: number;
    txRlp: string;
    txProof: string[];
  }): { ok: true } | { ok: false; error: string } {
    const row = this.withdrawals.find((w) => w.id === input.id);
    if (!row || row.status !== "locked") return { ok: false, error: "withdrawal is not locked" };
    if (this.height + 1 >= row.expiryHeight) return { ok: false, error: "withdrawal expired" };
    if (row.network !== "eth" || !isEthAsset(row.asset)) return { ok: false, error: "withdrawal binding refused" };
    const window = this.executionWindow();
    if (!window.ok) return window;
    const blockHash = input.blockHash.trim().toLowerCase().replace(/^0x/, "");
    const header = window.headers.find((h) => h.hash === blockHash);
    if (!header) return { ok: false, error: "eth header is not in Ω" };
    const proved = proveEthEffect({
      receiptsRoot: header.receiptsRoot,
      transactionsRoot: header.transactionsRoot,
      blockHash: header.hash,
      txIndex: input.txIndex,
      receiptRlp: input.receiptRlp,
      receiptProof: input.receiptProof,
      logIndex: input.logIndex,
      txRlp: input.txRlp,
      txProof: input.txProof,
      asset: row.asset,
    });
    if (!proved.ok) return proved;
    if (proved.effect.destination !== row.destination || proved.effect.amount !== row.amount || proved.effect.asset !== row.asset) {
      return { ok: false, error: "withdrawal binding refused" };
    }
    if (this.withdrawals.some((w) => w.effectLocator === proved.effect.locator)) {
      return { ok: false, error: "effect already settled" };
    }
    if ((this.pending.withdraw ?? []).some((w) => (w.op === "settle" || w.op === "settleEth") && w.id === input.id)) {
      return { ok: false, error: "withdrawal is not locked" };
    }
    this.pending.withdraw = [
      ...(this.pending.withdraw ?? []),
      {
        op: "settleEth",
        id: input.id,
        blockHash: header.hash,
        txIndex: input.txIndex,
        receiptRlp: input.receiptRlp.trim().toLowerCase().replace(/^0x/, ""),
        receiptProof: input.receiptProof.map((item) => item.trim().toLowerCase().replace(/^0x/, "")),
        logIndex: input.logIndex,
        txRlp: input.txRlp.trim().toLowerCase().replace(/^0x/, ""),
        txProof: input.txProof.map((item) => item.trim().toLowerCase().replace(/^0x/, "")),
      },
    ];
    this.emit("in", "bridge", `settle ethereum withdrawal ${input.id.slice(0, 12)} · staged`);
    return { ok: true };
  }

  ingestGossip(claimed: BlockRecord): Promise<{ ok: boolean; error?: string; report?: VerificationReport }> {
    this.emit("in", "mesh", `gossip header ${claimed.hash.slice(0, 12)}… h=${claimed.height}`);
    return this.submitExternal(claimed);
  }

  async submitExternal(claimed: BlockRecord): Promise<{ ok: boolean; report: VerificationReport; error?: string }> {
    this.emit("in", "network", `external candidate ${claimed.hash.slice(0, 12)}… at membrane`);
    if (this.blocks.some((b) => b.hash === claimed.hash)) {
      const report = verifyStationaryEvidence({
        block: claimed,
        prev: claimed.height === 0 ? null : (this.blocks.find((b) => b.hash === claimed.prevHash) ?? null),
        cumulativeWork: claimed.height,
        params: this.params,
      });
      return { ok: true, report };
    }
    const proved = await this.proveCandidate(claimed);
    if (!proved.ok) {
      this.emit("in", "verify", `external rejected · ${proved.error}`);
      return { ok: false, report: proved.report, error: proved.error };
    }
    this.frontier.set(claimed.hash, claimed);
    await this.settle();
    if (!this.blocks.some((b) => b.hash === claimed.hash)) {
      return { ok: false, report: proved.report, error: "not the lowest cumulative residual" };
    }
    if (this.kinStarted) this.noteKin(claimed);
    for (const listener of this.commitListeners) listener(claimed);
    this.emit("close", "memory", `external Ω${claimed.height} admitted`);
    return { ok: true, report: proved.report };
  }

  private async proveCandidate(claimed: BlockRecord): Promise<{ ok: true; report: VerificationReport } | { ok: false; report: VerificationReport; error: string }> {
    const blank: VerificationReport = { ok: false, verifyEvals: 0, checks: [] };
    if (claimed.relation) {
      const again = stationarityRelation(claimed, this.params.residualThreshold);
      if (!again.ok || again.hashLo !== claimed.relation.hashLo || again.hashHi !== claimed.relation.hashHi) {
        return { ok: false, report: blank, error: "stationarity relation does not bind this header" };
      }
    }
    if (claimed.height === 0 && this.blocks.length > 0) {
      return { ok: false, report: blank, error: "genesis is already canonical" };
    }
    const parentKnown = claimed.prevHash === "0".repeat(64) || this.blocks.some((b) => b.hash === claimed.prevHash);
    if (!parentKnown) return { ok: false, report: blank, error: "parent is not on the canonical chain" };
    const view = await this.viewAt(claimed.prevHash);
    if (!view) return { ok: false, report: blank, error: "parent did not replay" };
    const prev = claimed.prevHash === "0".repeat(64) ? null : view.tip;
    const report = verifyStationaryEvidence({
      block: claimed,
      prev,
      cumulativeWork: claimed.height,
      params: view.params,
      authorizedCouplings: openedCouplings(view.toOmega()),
    });
    if (!report.ok) {
      const failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
      return { ok: false, report, error: `VerifyStationaryEvidence failed: ${failed.join(", ")}` };
    }
    const err = await view.absorb(claimed);
    if (err) return { ok: false, report, error: err };
    return { ok: true, report };
  }

  private async viewAt(parentHash: string): Promise<OrganismNode | null> {
    if ((this.tip?.hash ?? "0".repeat(64)) === parentHash) return this.fork();
    if (parentHash === "0".repeat(64)) {
      const kin = new OrganismNode(this.network, { skipBootstrap: true });
      kin.constitute();
      return kin;
    }
    const idx = this.blocks.findIndex((b) => b.hash === parentHash);
    if (idx < 0) return null;
    const kin = new OrganismNode(this.network, { skipBootstrap: true });
    kin.constitute();
    for (const block of this.blocks.slice(0, idx + 1)) {
      const err = await kin.absorb(block);
      if (err) return null;
    }
    return kin;
  }

  private settleChain: Promise<void> = Promise.resolve();

  private settle(): Promise<void> {
    const run = this.settleChain.then(() => this.settleBody());
    this.settleChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async settleBody(): Promise<void> {
    let spins = 0;
    do {
      this.settleAgain = false;
      await this.settleOnce();
      spins += 1;
    } while (this.settleAgain && spins < 32);
  }

  private childrenOf(parent: string): BlockRecord[] {
    return [...this.frontier.values()].filter((b) => b.prevHash === parent);
  }

  private bestExtension(): BlockRecord | null {
    const parent = this.tip?.hash ?? "0".repeat(64);
    let best: BlockRecord | null = null;
    for (const block of this.childrenOf(parent)) {
      if (!best) {
        best = block;
        continue;
      }
      const challenger = { weight: chainWeight([block]), tipHash: block.hash };
      const incumbent = { weight: chainWeight([best]), tipHash: best.hash };
      if (preferChain(challenger, incumbent)) best = block;
    }
    return best;
  }

  private bestFork(): BlockRecord[] | null {
    let best: BlockRecord[] | null = null;
    const tip = this.tip?.hash;
    for (const block of this.frontier.values()) {
      if (block.prevHash === tip) continue;
      const chain = this.chainFromCanonical(block);
      if (!chain) continue;
      const parentIdx = this.blocks.findIndex((b) => b.hash === chain[0]!.prevHash);
      if (parentIdx < 0) continue;
      const tail = this.blocks.slice(parentIdx + 1);
      if (tail.length === 0 || tail.some((b) => b.finalized)) continue;
      const challenger = { weight: chainWeight(chain), tipHash: chain[chain.length - 1]!.hash };
      const incumbent = { weight: chainWeight(tail), tipHash: tail[tail.length - 1]!.hash };
      if (!preferChain(challenger, incumbent)) continue;
      if (!best || preferChain(challenger, { weight: chainWeight(best), tipHash: best[best.length - 1]!.hash })) best = chain;
    }
    return best;
  }

  /** The frontier path from a canonical parent through `block`, if it is contiguous. */
  private chainFromCanonical(block: BlockRecord): BlockRecord[] | null {
    const reversed: BlockRecord[] = [block];
    let cursor = block;
    while (!this.blocks.some((b) => b.hash === cursor.prevHash)) {
      if (cursor.prevHash === "0".repeat(64)) break;
      const parent = this.frontier.get(cursor.prevHash);
      if (!parent) return null;
      reversed.push(parent);
      cursor = parent;
    }
    if (cursor.prevHash !== "0".repeat(64) && !this.blocks.some((b) => b.hash === cursor.prevHash)) return null;
    return reversed.reverse();
  }

  private async settleOnce(): Promise<void> {
    const fork = this.bestFork();
    if (fork) {
      const err = await this.reorg(fork);
      if (err) this.frontier.delete(fork[fork.length - 1]!.hash);
      this.settleAgain = true;
      return;
    }
    const next = this.bestExtension();
    if (!next) return;
    const err = await this.absorb(next);
    if (err === "successor is stale") {
      this.settleAgain = true;
      return;
    }
    if (err) {
      this.frontier.delete(next.hash);
      this.settleAgain = true;
      return;
    }
    this.frontier.delete(next.hash);
    this.settleAgain = true;
  }

  private async reorg(chain: BlockRecord[]): Promise<string | null> {
    const parentIdx = this.blocks.findIndex((b) => b.hash === chain[0]!.prevHash);
    if (parentIdx < 0) return "fork point is not canonical";
    const tail = this.blocks.slice(parentIdx + 1);
    if (tail.some((b) => b.finalized)) return "finalized ancestor";
    const baseTip = this.tip?.hash ?? "0".repeat(64);
    const baseOmega = omegaDigest(this.toOmega());
    const kin = new OrganismNode(this.network, { skipBootstrap: true });
    kin.constitute();
    for (const block of [...this.blocks.slice(0, parentIdx + 1), ...chain]) {
      const err = await kin.absorb(block);
      if (err) return err;
    }
    if ((this.tip?.hash ?? "0".repeat(64)) !== baseTip || omegaDigest(this.toOmega()) !== baseOmega) {
      return "successor is stale";
    }
    for (const block of tail) this.frontier.set(block.hash, block);
    for (const block of chain) this.frontier.delete(block.hash);
    this.blocks = kin.blocks;
    this.ledger = kin.ledger;
    this.txIndex = kin.txIndex;
    this.validators = kin.validators;
    this.finality = kin.finality;
    this.stats = kin.stats;
    this.pools = kin.pools;
    this.swaps = kin.swaps;
    this.btcHeaders = kin.btcHeaders;
    const previousCommittee = this.ethCommittee;
    this.ethHeaders = kin.ethHeaders;
    this.ethPubkey = kin.ethPubkey;
    this.ethCommittee = kin.ethCommittee;
    if (this.ethCommittee !== previousCommittee) this.ethSecrets = null;
    this.wasmStorage = kin.wasmStorage;
    this.couplings = { ...kin.couplings };
    this.difficulty = kin.difficulty;
    this.delegations = kin.delegations;
    this.unbonding = kin.unbonding;
    this.withdrawals = kin.withdrawals;
    this.ethExecution = kin.ethExecution;
    this.proposals = kin.proposals;
    this.finalizedThrough = kin.finalizedThrough;
    if (this.kinStarted) {
      this.kin = null;
      this.kinStarted = false;
      this.startKin();
    }
    return null;
  }

  /**
   * The process that produced `blocks` has stopped.
   * This body is given only those blocks. It produces the next one.
   * A third body, also without the producer's memory, has to accept it.
   */
  static async takeover(network: NetworkId, blocks: BlockRecord[]): Promise<TakeoverReport> {
    const fail = (error: string): TakeoverReport => ({
      ok: false,
      height: -1,
      hash: "",
      prevHash: "",
      stateRoot: "",
      difficulty: 0,
      residual: 0,
      btcTip: null,
      error,
    });
    const kin = new OrganismNode(network, { skipBootstrap: true });
    kin.constitute();
    for (const block of blocks) {
      const err = await kin.absorb(block);
      if (err) return fail(`replay: ${err}`);
    }
    const tip = kin.tip;
    if (!tip) return fail("replay produced no tip");
    const step = Math.max(1, Math.floor(kin.params.targetBlockTimeMs / 1000));
    const block = kin.mine(tip.timestamp + step);
    if (!block.verified || block.height !== tip.height + 1 || block.prevHash !== tip.hash) {
      return fail(block.verifyNotes.join("; ") || "the next block did not verify");
    }
    if (!(block.residual < kin.params.residualThreshold)) return fail("residual is not under the target");
    const witness = new OrganismNode(network, { skipBootstrap: true });
    witness.constitute();
    for (const prev of blocks) {
      const err = await witness.absorb(prev);
      if (err) return fail(`witness replay: ${err}`);
    }
    const rejected = await witness.absorb(block);
    if (rejected) return fail(`witness refused the next block: ${rejected}`);
    if (witness.tip?.hash !== block.hash || witness.tip.stateRoot !== block.stateRoot) {
      return fail("witness tip is not the block the second body produced");
    }
    if (witness.difficulty !== kin.difficulty) return fail("witness difficulty diverged");
    const kinTip = kin.btcHeaders[kin.btcHeaders.length - 1]?.hash ?? null;
    const witnessTip = witness.btcHeaders[witness.btcHeaders.length - 1]?.hash ?? null;
    if (kinTip !== witnessTip) return fail("foreign tip did not survive the handoff");
    return {
      ok: true,
      height: block.height,
      hash: block.hash,
      prevHash: block.prevHash,
      stateRoot: block.stateRoot,
      difficulty: witness.difficulty,
      residual: block.residual,
      btcTip: witnessTip,
      error: null,
    };
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
      cumulativeWork: block.height,
      params: this.params,
      authorizedCouplings: openedCouplings(this.toOmega()),
    });
    if (!report.ok) return report.checks.filter((c) => !c.ok).map((c) => c.name).join(", ");
    const baseTip = this.tip?.hash ?? "0".repeat(64);
    const baseOmega = omegaDigest(this.toOmega());
    const stepped = await successor(this.toOmega(), {
      transactions: block.transactions,
      evidence: block.evidence,
      timestamp: block.timestamp,
      nonce: asBlockNonce(block.nonce),
      miner: block.miner,
      committedPressure: block.committedPressure,
      couplings: block.couplings,
      difficulty: block.difficulty,
    });
    if (!stepped.ok) return stepped.error;
    if ((this.tip?.hash ?? "0".repeat(64)) !== baseTip || omegaDigest(this.toOmega()) !== baseOmega) {
      return "successor is stale";
    }
    if (stepped.stateRoot !== block.stateRoot) return "state root does not replay";
    if (block.evidence && stepped.omegaRoot !== block.omegaRoot) return "omega root does not replay";
    if (stepped.reward !== block.coinbaseReward) return "coinbase is not the reward law";
    if (stepped.liquid !== (block.liquidIssuance ?? block.coinbaseReward)) return "liquid issuance is not the stake law";
    if (!residualsMatch(block.residual, stepped.residual)) return "residual is not the transition";
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
          ? `The EQU-USDC pool reserve changed by ${(reserveAfter - reserveBefore).toLocaleString()} EQU. The genesis liquidity address changed by ${(lockedAfter - lockedBefore).toLocaleString()} on the ledger, which is not that reserve. The pool is not that allocation. This swap does not settle on another chain.`
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
      nonce: asBlockNonce(guard.tip?.nonce ?? 0),
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
          ? `An unfunded transfer of 10,000,000,001 was refused by the mempool and by the transition. The sender stayed at ${senderBefore.toLocaleString()}. No recipient balance was created.`
          : `An unfunded transfer was accepted. ${admitted.error ?? ("error" in stepped ? stepped.error : "transition applied")}`,
    });

    const outside = this.fork();
    const withdrawPayer = outside.actors[0]!;
    const hash160 = "cd".repeat(20);
    const destination = `p2pkh:${hash160}`;
    const raw = buildP2pkhTx(1_000, hash160);
    const txid = raw ? parseBtcTx(raw)?.txid ?? null : null;
    const opened = signWithdraw(withdrawPayer, {
      chainId: outside.params.chainId,
      amount: 1_000,
      network: "btc",
      asset: "btc",
      destination,
      nonce: 0,
    });
    const ethSigned = signWithdraw(withdrawPayer, {
      chainId: outside.params.chainId,
      amount: 1_000,
      network: "eth",
      asset: "eth",
      destination,
      nonce: 1,
    });
    const omega = outside.toOmega();
    const headerHash = "22".repeat(32);
    if (txid) omega.btc.push({ hash: headerHash, height: 0, prevHash: "00".repeat(32), merkleRoot: txid, bits: 1 });
    const outsideEvidence = {
      v: 1 as const,
      chainId: outside.params.chainId,
      wasmCode: ARBITRAGE_CODE,
      btc: [] as [],
      eth: [] as [],
      wasm: [] as [],
      stake: [] as [],
      withdraw: [
        {
          op: "open" as const,
          sender: withdrawPayer.address,
          amount: 1_000,
          network: "btc" as const,
          asset: "btc",
          destination,
          nonce: 0,
          publicKey: opened.publicKey,
          signature: opened.signature,
        },
        {
          op: "settle" as const,
          id: opened.id,
          rawTx: raw ? bytesToHex(raw) : "",
          vout: 0,
          headerHash,
          merkle: [] as string[],
        },
      ],
    };
    const outsideStep = applySuccessor(omega, {
      transactions: [],
      evidence: outsideEvidence,
      timestamp: (outside.tip?.timestamp ?? 0) + 15,
      nonce: asBlockNonce(outside.tip?.nonce ?? 0),
      miner: outside.miner.address,
      committedPressure: 0,
      couplings: outside.couplings,
      difficulty: outside.difficulty,
      wasmAfter: null,
    });
    const ethStep = applySuccessor(outside.toOmega(), {
      transactions: [],
      evidence: {
        ...outsideEvidence,
        withdraw: [{
          op: "open" as const,
          sender: withdrawPayer.address,
          amount: 1_000,
          network: "eth" as const,
          asset: "eth",
          destination,
          nonce: 1,
          publicKey: ethSigned.publicKey,
          signature: ethSigned.signature,
        }],
      },
      timestamp: (outside.tip?.timestamp ?? 0) + 15,
      nonce: asBlockNonce(outside.tip?.nonce ?? 0),
      miner: outside.miner.address,
      committedPressure: 0,
      couplings: outside.couplings,
      difficulty: outside.difficulty,
      wasmAfter: null,
    });
    const row = outsideStep.ok ? outsideStep.next.withdrawals.find((w) => w.id === opened.id) : undefined;
    const escrow = outsideStep.ok ? (outsideStep.next.ledger.get(WITHDRAWAL_ESCROW)?.balance ?? 0) : -1;
    const senderLeft = outsideStep.ok ? (outsideStep.next.ledger.get(withdrawPayer.address)?.balance ?? 0) : -1;
    const senderWas = outside.getAccount(withdrawPayer.address).balance;
    const paidOutside = outsideStep.ok && row?.status === "settled" && row.effectLocator !== null && escrow === 0 && senderLeft === senderWas - 1_000;
    const ethRefused = !ethStep.ok && ethStep.error === "withdrawal destination refused";
    const token = "ab".repeat(20);
    const recipient = "ef".repeat(20);
    const logData = new Uint8Array(32);
    logData[30] = 0x03;
    logData[31] = 0xe8;
    const receipt = legacyReceipt({
      status: 1,
      cumulativeGas: 21_000,
      logs: [{
        address: token,
        topics: [TRANSFER_TOPIC, `${"00".repeat(12)}${"11".repeat(20)}`, `${"00".repeat(12)}${recipient}`],
        data: logData,
      }],
    });
    const leaf = secureLeaf(rlpUint(0), receipt);
    const headerBytes = executionHeader({
      parentHash: new Uint8Array(32),
      transactionsRoot: new Uint8Array(32),
      receiptsRoot: leaf.root,
      number: 1,
    });
    const parsedHeader = parseExecutionHeader(headerBytes);
    const ethOpen = parsedHeader
      ? signWithdraw(withdrawPayer, {
          chainId: outside.params.chainId,
          amount: 1_000,
          network: "eth",
          asset: token,
          destination: `eth:${recipient}`,
          nonce: 2,
        })
      : null;
    const ethPaidStep = parsedHeader && ethOpen
      ? applySuccessor(outside.toOmega(), {
          transactions: [],
          evidence: {
            ...outsideEvidence,
            withdraw: [
              {
                op: "open" as const,
                sender: withdrawPayer.address,
                amount: 1_000,
                network: "eth" as const,
                asset: token,
                destination: `eth:${recipient}`,
                nonce: 2,
                publicKey: ethOpen.publicKey,
                signature: ethOpen.signature,
              },
              { op: "exec" as const, headerRlp: bytesToHex(headerBytes) },
              {
                op: "settleEth" as const,
                id: ethOpen.id,
                blockHash: parsedHeader.hash,
                txIndex: 0,
                receiptRlp: bytesToHex(receipt),
                receiptProof: leaf.proof.map((node) => bytesToHex(node)),
                logIndex: 0,
                txRlp: "",
                txProof: [] as string[],
              },
            ],
          },
          timestamp: (outside.tip?.timestamp ?? 0) + 15,
          nonce: asBlockNonce(outside.tip?.nonce ?? 0),
          miner: outside.miner.address,
          committedPressure: 0,
          couplings: outside.couplings,
          difficulty: outside.difficulty,
          wasmAfter: null,
        })
      : null;
    const ethRow = ethPaidStep?.ok ? ethPaidStep.next.withdrawals.find((w) => w.id === ethOpen?.id) : undefined;
    const ethEscrow = ethPaidStep?.ok ? (ethPaidStep.next.ledger.get(WITHDRAWAL_ESCROW)?.balance ?? 0) : -1;
    const ethSender = ethPaidStep?.ok ? (ethPaidStep.next.ledger.get(withdrawPayer.address)?.balance ?? 0) : -1;
    const ethSettled = Boolean(
      parsedHeader
      && ethPaidStep?.ok
      && ethRow?.status === "settled"
      && ethRow.effectLocator === `${parsedHeader.hash}:0:0`
      && ethEscrow === 0
      && ethSender === senderWas - 1_000
      && ethPaidStep.next.ledger.get(recipient) === undefined,
    );
    rows.push({
      id: "withdraw",
      status: paidOutside && ethRefused && ethSettled ? "works" : "absent",
      detail: paidOutside && ethRefused && ethSettled
        ? "A signed withdrawal locked 1,000 EQU and settled when the Bitcoin output matched. The escrow was debited and no EQU address was credited. An Ethereum withdrawal of 1,000 settled when a Transfer log was proven against an admitted execution header. That header is not an EQU beacon, and Ethereum's sync committee is not verified. A p2pkh destination on Ethereum is refused. A header lock is not this path."
        : `Withdrawal did not settle outside. ${outsideStep.ok ? "settle missed" : outsideStep.error}; eth ${ethStep.ok ? "accepted" : ethStep.error}; receipt ${ethPaidStep == null ? "unbuilt" : ethPaidStep.ok ? "missed" : ethPaidStep.error}`,
    });
    rows.push({
      id: "other-miners",
      status: "local",
      detail: "This fork produced its own block and did not start another producer. Separately, a second body given only the blocks produced the next block, and a third body accepted it. The Rust crate does not mine them.",
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
        agree: residualsMatch(tip.residual, local.canonical),
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
        bootstrapped: this.ethCommittee.length > 0,
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
      unbonding: this.unbonding.slice(),
      withdrawals: this.withdrawals.slice(),
      ethExecution: this.ethExecution.slice(),
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
