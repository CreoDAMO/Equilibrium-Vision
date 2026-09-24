import { merkleRoot, sha256Hex } from "./crypto";
import { evaluateResidual, type SolverHeader } from "./solver";
import { minerReward, slashAmount } from "./coinomics";
import { applySwap, poolAddress } from "./dex";
import { decodeHeaderHex, parseBtcHeader, verifyBtcPow } from "./btc";
import { callArbitrage } from "./wasm-host";
import {
  ETH_MIN_PARTICIPANTS,
  hashEthHeader,
  hexOf,
  hexToBytes as ethHex,
  verifyEthHeader,
} from "./eth-light";
import { ARBITRAGE_CODE } from "./evidence";
import { verifyTx } from "./wallet";
import { NETWORKS } from "./networks";
import {
  activityKeys,
  GENESIS_ALLOCATIONS,
  genesisValidators,
  minerKey,
  treasuryKey,
} from "./genesis";
import type {
  AccountState,
  BtcHeaderRecord,
  ConstitutionAnswer,
  Couplings,
  Delegation,
  DexPool,
  EthHeaderRecord,
  NetworkId,
  NetworkParams,
  Proposal,
  ResidualBreakdown,
  StakeEvidence,
  SwapEvent,
  TransitionEvidence,
  TxRecord,
  ValidatorRecord,
} from "./types";
import { DEFAULT_COUPLINGS } from "./types";

/**
 * Ω is the state the next block is a function of.
 * Mempool, peers, clocks, secrets, and the solver's search are not in it.
 */
export interface Omega {
  chainId: number;
  height: number;
  /** Hash of the block that produced this Ω. Not part of omegaDigest: the next header binds it as prev. */
  tipHash: string;
  tipTimestamp: number;
  difficulty: number;
  couplings: Couplings;
  ledger: Map<string, AccountState>;
  pools: DexPool[];
  btc: BtcHeaderRecord[];
  ethPubkey: string;
  eth: EthHeaderRecord[];
  wasm: Map<string, string>;
  validators: Map<string, ValidatorRecord>;
  delegations: Delegation[];
  proposals: Proposal[];
  finalizedHeight: number;
}

/** What a block must carry. Difficulty is a claim about Ω, not a free choice. */
export interface CanonicalInputs {
  transactions: TxRecord[];
  evidence: TransitionEvidence | undefined;
  timestamp: number;
  nonce: number;
  miner: string;
  committedPressure: number;
  couplings: Couplings;
  difficulty: number;
  wasmAfter: Map<string, string> | null;
}

export type Successor =
  | {
      ok: true;
      next: Omega;
      stateRoot: string;
      omegaRoot: string;
      reward: number;
      liquid: number;
      residual: number;
      residualFp: number;
      territory: number;
      breakdown: ResidualBreakdown;
      swaps: SwapEvent[];
    }
  | { ok: false; error: string };

export const NUMERIC_MODEL = "ECMA-262" as const;

const STATE_INPUTS = [
  "ordered transactions",
  "evidence, votes included",
  "miner",
  "timestamp",
] as const;

const BLOCK_INPUTS = [
  ...STATE_INPUTS,
  "nonce",
  "committed pressure",
  "couplings",
] as const;

const OUTSIDE = [
  "mempool",
  "peers",
  "Date",
  "Math.random",
  "solver search",
  "wasm storage cache",
  "pending memory",
] as const;

export function cloneOmega(omega: Omega): Omega {
  return {
    chainId: omega.chainId,
    height: omega.height,
    tipHash: omega.tipHash,
    tipTimestamp: omega.tipTimestamp,
    difficulty: omega.difficulty,
    finalizedHeight: omega.finalizedHeight,
    couplings: { ...omega.couplings },
    ledger: new Map([...omega.ledger.entries()].map(([k, v]) => [k, { ...v }])),
    pools: omega.pools.map((p) => ({ ...p })),
    btc: omega.btc.map((h) => ({ ...h })),
    ethPubkey: omega.ethPubkey,
    eth: omega.eth.map((h) => ({ ...h })),
    wasm: new Map(omega.wasm),
    validators: new Map([...omega.validators.entries()].map(([k, v]) => [k, { ...v }])),
    delegations: omega.delegations.map((d) => ({ ...d })),
    proposals: omega.proposals.map((p) => ({ ...p })),
  };
}

export function paramsOf(chainId: number): NetworkParams | null {
  if (chainId === NETWORKS.mainnet.chainId) return NETWORKS.mainnet;
  if (chainId === NETWORKS.testnet.chainId) return NETWORKS.testnet;
  return null;
}

/** Passed proposals change λ before the block's inputs are applied. Idempotent. */
export function openOmega(omega: Omega): void {
  for (const p of omega.proposals) {
    if (p.status !== "passed") continue;
    if (p.couplingKey && typeof p.couplingValue === "number" && Number.isFinite(p.couplingValue)) {
      omega.couplings = { ...omega.couplings, [p.couplingKey]: Math.max(0, p.couplingValue) };
    }
    p.status = "executed";
  }
}

function credit(ledger: Map<string, AccountState>, addr: string, amount: number) {
  const acc = ledger.get(addr) ?? { balance: 0, nonce: 0 };
  ledger.set(addr, { balance: acc.balance + amount, nonce: acc.nonce });
}

function debit(ledger: Map<string, AccountState>, addr: string, amount: number): boolean {
  const acc = ledger.get(addr) ?? { balance: 0, nonce: 0 };
  if (acc.balance < amount) return false;
  ledger.set(addr, { balance: acc.balance - amount, nonce: acc.nonce });
  return true;
}

export function btcLeafOf(headers: BtcHeaderRecord[]): string {
  const tip = headers[headers.length - 1];
  return tip ? `${tip.hash}:${tip.height}` : "none";
}

export function ethLeafOf(headers: EthHeaderRecord[]): string {
  const tip = headers[headers.length - 1];
  return tip ? `${tip.slot}:${tip.hash}` : "none";
}

export function wasmLeafOf(storage: Map<string, string>): string {
  if (!storage.size) return "none";
  return [...storage.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("|");
}

export function stateRootOf(omega: Pick<Omega, "ledger" | "pools" | "btc" | "eth" | "wasm">): string {
  const leaves = [
    ...[...omega.ledger.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([addr, acc]) => sha256Hex(`${addr}:${acc.balance}:${acc.nonce}`)),
    ...[...omega.pools]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((p) => sha256Hex(`pool:${p.id}:${p.reserveA}:${p.reserveB}:${p.txCount}`)),
    sha256Hex(`btc:${btcLeafOf(omega.btc)}`),
    sha256Hex(`eth:${ethLeafOf(omega.eth)}`),
    sha256Hex(`wasm:${wasmLeafOf(omega.wasm)}`),
  ];
  return merkleRoot(leaves);
}

function num(n: number): string {
  if (!Number.isFinite(n)) return "nan";
  return Object.is(n, -0) ? "0" : String(n);
}

/** Digest of the whole next state, not the account projection. */
export function omegaDigest(omega: Omega): string {
  const ledger = [...omega.ledger.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([a, acc]) => `${a}:${num(acc.balance)}:${acc.nonce}`);
  const pools = [...omega.pools]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => `${p.id}:${num(p.reserveA)}:${num(p.reserveB)}:${p.txCount}:${num(p.fee)}`);
  const btc = omega.btc.map((h) => `${h.height}:${h.hash}`).join(";");
  const eth = `${omega.ethPubkey}:${omega.eth.map((h) => `${h.slot}:${h.hash}`).join(";")}`;
  const wasm = wasmLeafOf(omega.wasm);
  const validators = [...omega.validators.values()]
    .sort((a, b) => (a.address < b.address ? -1 : 1))
    .map(
      (v) =>
        `${v.address}:${num(v.bondedStake)}:${num(v.accumulatedRewards)}:${v.slashed ? 1 : 0}:${v.jailed ? 1 : 0}:${v.blocksProposed}:${num(v.commission)}`,
    );
  const delegations = omega.delegations.map((d) => `${d.delegator}>${d.validator}:${num(d.amount)}`).join(";");
  const proposals = omega.proposals
    .map(
      (p) =>
        `${p.id}:${p.status}:${num(p.yes)}:${num(p.no)}:${num(p.abstain)}:${p.couplingKey ?? ""}:${p.couplingValue ?? ""}`,
    )
    .join(";");
  const c = omega.couplings;
  const body = [
    NUMERIC_MODEL,
    String(omega.chainId),
    String(omega.height),
    String(omega.tipTimestamp),
    String(omega.difficulty),
    String(omega.finalizedHeight),
    `${num(c.hash)},${num(c.structural)},${num(c.continuity)},${num(c.mempool)},${num(c.fees)}`,
    ledger.join(";"),
    pools.join(";"),
    btc,
    eth,
    wasm,
    validators.join(";"),
    delegations,
    proposals,
  ].join("|");
  return sha256Hex(`eq-omega|${body}`);
}

function rewardOf(params: NetworkParams, height: number, residual: number): number {
  return Math.max(
    0,
    Math.floor(
      minerReward(height, residual, params.residualThreshold, {
        baseReward: params.baseReward,
        halvingInterval: params.halvingInterval,
      }),
    ),
  );
}

function issuanceSplit(
  validators: Map<string, ValidatorRecord>,
  miner: string,
  reward: number,
): { liquid: number; staked: number } {
  const minerV = validators.get(miner);
  if (!minerV || minerV.jailed || minerV.slashed) return { liquid: reward, staked: 0 };
  const liquid = Math.floor(reward * minerV.commission);
  return { liquid, staked: reward - liquid };
}

function adjustDifficulty(difficulty: number, blockTime: number, params: NetworkParams): number {
  const target = params.targetBlockTimeMs / 1000;
  if (blockTime <= 0) return difficulty;
  const factor = Math.max(0.8, Math.min(1.2, target / blockTime));
  return Math.max(100_000, Math.floor(difficulty * factor));
}

function applyStake(omega: Omega, op: StakeEvidence, params: NetworkParams): string | null {
  if (op.op === "delegate") {
    const v = omega.validators.get(op.validator);
    if (!v || v.jailed) return "delegate refused";
    if (!debit(omega.ledger, op.delegator, op.amount)) return "delegate funds refused";
    v.bondedStake += op.amount;
    omega.delegations.push({ delegator: op.delegator, validator: op.validator, amount: op.amount });
    return null;
  }
  if (op.op === "claim") {
    const v = omega.validators.get(op.address);
    if (!v || v.accumulatedRewards <= 0) return "claim refused";
    const amount = v.accumulatedRewards;
    v.accumulatedRewards = 0;
    credit(omega.ledger, op.address, amount);
    return null;
  }
  if (op.op === "slash") {
    const v = omega.validators.get(op.validator);
    if (!v) return "slash refused";
    const burned = slashAmount(v.bondedStake, op.reason);
    v.bondedStake -= burned;
    v.slashed = true;
    if (op.reason === "double_sign") v.jailed = true;
    return null;
  }
  if (op.op === "vote") {
    const p = omega.proposals.find((x) => x.id === op.id);
    if (!p || p.status !== "open") return "vote refused";
    const v = omega.validators.get(op.voter);
    const power = v?.bondedStake ?? omega.ledger.get(op.voter)?.balance ?? 0;
    if (power <= 0) return "vote refused";
    p[op.option] += power;
    const total = p.yes + p.no + p.abstain;
    const bonded = [...omega.validators.values()].reduce((s, x) => s + x.bondedStake, 0);
    if (total >= params.finalityQuorum * bonded) p.status = p.yes > p.no ? "passed" : "failed";
    return null;
  }
  if (!debit(omega.ledger, op.proposer, op.deposit)) return "proposal deposit refused";
  if (!omega.proposals.some((p) => p.id === op.id)) {
    omega.proposals.unshift({
      id: op.id,
      title: op.title,
      proposer: op.proposer,
      deposit: op.deposit,
      yes: 0,
      no: 0,
      abstain: 0,
      status: "open",
    });
  }
  return null;
}

function applyMaterial(omega: Omega, ev: TransitionEvidence | undefined, params: NetworkParams): string | null {
  if (!ev) return null;
  if (ev.v !== 1) return "unknown evidence version";
  if (ev.chainId !== omega.chainId) return `evidence chain ${ev.chainId} is not ${omega.chainId}`;
  if (ev.wasmCode !== ARBITRAGE_CODE) return "wasm code is not this constitution";
  for (const op of ev.stake) {
    const refused = applyStake(omega, op, params);
    if (refused) return refused;
  }
  for (const item of ev.btc) {
    const raw = decodeHeaderHex(item.headerHex);
    if (!raw) return "btc header is not 80 bytes";
    if (!verifyBtcPow(raw)) return "btc proof of work refused";
    const parsed = parseBtcHeader(raw);
    const tip = omega.btc[omega.btc.length - 1];
    if (tip) {
      if (item.height !== tip.height + 1) return "btc height does not extend the tip";
      if (parsed.prevHash !== tip.hash) return "btc prev does not match the tip";
    }
    if (omega.btc.some((h) => h.hash === parsed.hash)) return "btc header already in the transition";
    omega.btc.push({
      hash: parsed.hash,
      height: item.height,
      prevHash: parsed.prevHash,
      merkleRoot: parsed.merkleRoot,
      bits: parsed.bits,
    });
    if (omega.btc.length > 2016) omega.btc.shift();
  }
  for (const item of ev.eth) {
    if (item.op === "bootstrap") {
      if (omega.ethPubkey) return "eth committee already installed";
      let raw: Uint8Array;
      try {
        raw = ethHex(item.pubkey.replace(/^0x/, ""));
      } catch {
        return "eth pubkey is not hex";
      }
      if (raw.length !== 48) return "eth pubkey must be 48 bytes";
      omega.ethPubkey = hexOf(raw);
      continue;
    }
    if (!omega.ethPubkey) return "eth header before committee";
    if (item.participants < ETH_MIN_PARTICIPANTS) return "eth quorum not met";
    const fields = {
      slot: item.slot,
      proposerIndex: item.proposerIndex,
      parentRoot: item.parentRoot,
      stateRoot: item.stateRoot,
      bodyRoot: item.bodyRoot,
    };
    const tip = omega.eth[omega.eth.length - 1];
    if (tip) {
      if (item.slot !== tip.slot + 1) return "eth slot does not extend the tip";
      if (item.parentRoot !== tip.hash) return "eth parent does not match the tip";
    }
    let sig: Uint8Array;
    try {
      sig = ethHex(item.signature.replace(/^0x/, ""));
    } catch {
      return "eth signature is not hex";
    }
    if (!verifyEthHeader(ethHex(omega.ethPubkey), fields, sig)) return "eth signature refused";
    omega.eth.push({
      slot: item.slot,
      hash: hexOf(hashEthHeader(fields)),
      parentRoot: item.parentRoot,
      stateRoot: item.stateRoot,
      bodyRoot: item.bodyRoot,
      participants: item.participants,
    });
  }
  return null;
}

function applyEffects(
  omega: Omega,
  txs: TxRecord[],
  miner: string,
  reward: number,
  swaps: SwapEvent[],
) {
  for (const tx of txs) {
    const sender = omega.ledger.get(tx.from) ?? { balance: 0, nonce: 0 };
    omega.ledger.set(tx.from, { balance: sender.balance - tx.amount - tx.fee, nonce: sender.nonce + 1 });
    credit(omega.ledger, miner, tx.fee);
    const pool = omega.pools.find((p) => (p.address || poolAddress(p.id)) === tx.to);
    if (pool) {
      const out = applySwap(pool, pool.tokenA, tx.amount);
      if (out > 0) {
        swaps.unshift({
          poolId: pool.id,
          trader: tx.from,
          amountIn: tx.amount,
          amountOut: out,
          tokenIn: pool.tokenA,
          tokenOut: pool.tokenB,
          timestamp: tx.timestamp,
        });
      }
    } else {
      credit(omega.ledger, tx.to, tx.amount);
    }
  }
  credit(omega.ledger, miner, reward);
}

/**
 * The relation. One (Ω, inputs) value, one next Ω.
 * Wasm storage is not chosen here: the caller passes the bytes execution produced.
 */
export function applySuccessor(omega: Omega, inputs: CanonicalInputs): Successor {
  const params = paramsOf(omega.chainId);
  if (!params) return { ok: false, error: "unknown chain" };
  if (inputs.difficulty !== omega.difficulty) return { ok: false, error: "difficulty is not the next difficulty" };
  for (const tx of inputs.transactions) {
    if (!verifyTx(tx, omega.chainId)) return { ok: false, error: "signature refused" };
  }
  const next = cloneOmega(omega);
  openOmega(next);
  const materialError = applyMaterial(next, inputs.evidence, params);
  if (materialError) return { ok: false, error: materialError };
  if (inputs.evidence?.wasm.length) {
    if (!inputs.wasmAfter) return { ok: false, error: "wasm execution missing" };
    next.wasm = new Map(inputs.wasmAfter);
  }
  const height = omega.height + 1;
  const txHashes = inputs.transactions.map((t) => t.hash);
  const mr = merkleRoot(txHashes.length ? txHashes : ["0".repeat(64)]);
  const header: SolverHeader = {
    prevHash: omega.tipHash,
    merkleRoot: mr,
    timestamp: inputs.timestamp,
    nonce: inputs.nonce,
    difficulty: inputs.difficulty,
  };
  const breakdown = evaluateResidual(
    header,
    inputs.transactions.map((t) => ({ hash: t.hash, fee: t.fee })),
    { cumulativeWork: Math.max(0, height), mempoolPressure: inputs.committedPressure },
    inputs.couplings,
  );
  const reward = rewardOf(params, height, breakdown.canonical);
  const split = issuanceSplit(next.validators, inputs.miner, reward);
  const swaps: SwapEvent[] = [];
  applyEffects(next, inputs.transactions, inputs.miner, split.liquid, swaps);
  const stateRoot = stateRootOf(next);
  const minerV = next.validators.get(inputs.miner);
  if (minerV) minerV.blocksProposed += 1;
  distribute(next.validators, reward - split.liquid);
  next.height = height;
  next.tipTimestamp = inputs.timestamp;
  const blockTime =
    omega.height < 0 ? params.targetBlockTimeMs / 1000 : inputs.timestamp - omega.tipTimestamp;
  next.difficulty = adjustDifficulty(omega.difficulty, blockTime, params);
  const all = [...next.validators.values()];
  const live = all.filter((x) => !x.jailed && !x.slashed);
  const total = all.reduce((s, x) => s + x.bondedStake, 0);
  const voting = live.reduce((s, x) => s + x.bondedStake, 0);
  const ratio = total > 0 ? voting / total : 0;
  if (ratio >= params.finalityQuorum) {
    const cutoff = height - params.finalityLag;
    if (cutoff > next.finalizedHeight) next.finalizedHeight = cutoff;
  }
  return {
    ok: true,
    next,
    stateRoot,
    omegaRoot: omegaDigest(next),
    reward,
    liquid: split.liquid,
    residual: breakdown.canonical,
    residualFp: breakdown.canonicalFp,
    territory: breakdown.territory,
    breakdown,
    swaps,
  };
}

function distribute(validators: Map<string, ValidatorRecord>, staked: number) {
  if (staked <= 0) return;
  const live = [...validators.values()].filter((x) => !x.jailed && !x.slashed);
  const total = live.reduce((s, x) => s + x.bondedStake, 0);
  if (total <= 0) return;
  for (const x of live) x.accumulatedRewards += Math.floor((staked * x.bondedStake) / total);
}

async function executeWasm(omega: Omega, ev: TransitionEvidence, blockNumber: number): Promise<Map<string, string> | string> {
  const storage = new Map(omega.wasm);
  for (const call of ev.wasm) {
    const methodId = call.method === "init" ? 0 : call.method === "pause" ? 2 : 3;
    const args = call.method === "init" ? new TextEncoder().encode(call.caller) : new Uint8Array();
    const result = await callArbitrage(methodId, args, { caller: call.caller, storage, blockNumber });
    if (result.code !== 1) return `wasm ${call.method} returned ${result.code}`;
  }
  return storage;
}

/** Constitution entry. Executes wasm. Does not accept a storage cache. */
export async function successor(omega: Omega, inputs: Omit<CanonicalInputs, "wasmAfter">): Promise<Successor> {
  let wasmAfter: Map<string, string> | null = null;
  if (inputs.evidence?.wasm.length) {
    const executed = await executeWasm(omega, inputs.evidence, Math.max(0, omega.height));
    if (typeof executed === "string") return { ok: false, error: executed };
    wasmAfter = executed;
  }
  return applySuccessor(omega, { ...inputs, wasmAfter });
}

/** Ω before any block. Two networks are not the same object. */
export function initialOmega(network: NetworkId): Omega {
  const params = NETWORKS[network];
  const omega: Omega = {
    chainId: params.chainId,
    height: -1,
    tipHash: "0".repeat(64),
    tipTimestamp: 0,
    difficulty: params.initialDifficulty,
    couplings: { ...DEFAULT_COUPLINGS },
    ledger: new Map(),
    pools: [],
    btc: [],
    ethPubkey: "",
    eth: [],
    wasm: new Map(),
    validators: new Map(),
    delegations: [],
    proposals: [],
    finalizedHeight: -1,
  };
  for (const a of GENESIS_ALLOCATIONS) credit(omega.ledger, a.address, a.amount);
  credit(omega.ledger, treasuryKey(network).address, network === "testnet" ? 25_000_000 : 8_000_000);
  const miner = minerKey(network).address;
  credit(omega.ledger, miner, 2_000_000);
  for (const k of activityKeys(network)) credit(omega.ledger, k.address, 1_500_000);
  for (const v of genesisValidators()) {
    credit(omega.ledger, v.address, v.bondedStake);
    omega.validators.set(v.address, { ...v });
  }
  omega.pools = [
    { id: "EQU-WBTC", tokenA: "EQU", tokenB: "WBTC", reserveA: 10_000_000, reserveB: 100, fee: 0.003, txCount: 0 },
    { id: "EQU-USDC", tokenA: "EQU", tokenB: "USDC", reserveA: 10_000_000, reserveB: 10_000_000, fee: 0.003, txCount: 0 },
  ].map((p) => ({ ...p, address: poolAddress(p.id) }));
  const bond = 500_000;
  if (debit(omega.ledger, miner, bond)) {
    omega.validators.set(miner, {
      address: miner,
      moniker: "Foundation miner",
      bondedStake: bond,
      accumulatedRewards: 0,
      slashed: false,
      jailed: false,
      uptime: 1,
      blocksProposed: 0,
      commission: 0.1,
    });
  }
  return omega;
}

function blankInputs(omega: Omega, nonce: number, timestamp: number, miner: string): CanonicalInputs {
  return {
    transactions: [],
    evidence: undefined,
    timestamp,
    nonce,
    miner,
    committedPressure: 0,
    couplings: { ...omega.couplings },
    difficulty: omega.difficulty,
    wasmAfter: null,
  };
}

/** How many nonces in a window satisfy the residual predicate. Stops at two. */
export function admittingNonces(omega: Omega, window: number, timestamp = omega.tipTimestamp + 1): number[] {
  const params = paramsOf(omega.chainId);
  if (!params) return [];
  const found: number[] = [];
  const mr = "0".repeat(64);
  for (let nonce = 0; nonce < window && found.length < 2; nonce++) {
    const residual = evaluateResidual(
      { prevHash: omega.tipHash, merkleRoot: mr, timestamp, nonce, difficulty: omega.difficulty },
      [],
      { cumulativeWork: Math.max(0, omega.height + 1), mempoolPressure: 0 },
      omega.couplings,
    );
    if (residual.canonical < params.residualThreshold) found.push(nonce);
  }
  return found;
}

/**
 * Q1 and Q2, by execution.
 * Q1 is whether this function is a description that does not close over a node.
 * Q2 is which inputs that description has to be given so the next state is one value.
 */
export function constitutionalAnswer(): ConstitutionAnswer {
  const born = initialOmega("testnet");
  const again = initialOmega("testnet");
  const main = initialOmega("mainnet");
  const networksDiverge = omegaDigest(born) !== omegaDigest(main);
  const deterministic = omegaDigest(born) === omegaDigest(again);
  const test = cloneOmega(born);
  test.height = 0;
  const source = `${applySuccessor.toString()}\n${successor.toString()}\n${openOmega.toString()}\n${initialOmega.toString()}`;
  const readsClock = /Date\.now|Math\.random/.test(source);

  const window = 512;
  const t0 = test.tipTimestamp + 15;
  const admitted = admittingNonces(test, window, t0);
  const miner = [...test.validators.keys()][0] ?? "miner";
  const base = blankInputs(test, admitted[0] ?? 0, t0, miner);
  const once = applySuccessor(test, base);
  const twice = applySuccessor(test, base);
  const deterministicStep = once.ok && twice.ok && once.omegaRoot === twice.omegaRoot;

  let admittingShareState = false;
  let admittingResidualsDiffer = false;
  if (admitted.length >= 2 && once.ok) {
    const other = applySuccessor(test, { ...base, nonce: admitted[1]! });
    if (other.ok) {
      admittingShareState = other.omegaRoot === once.omegaRoot;
      admittingResidualsDiffer = other.residual !== once.residual;
    }
  }

  const later = applySuccessor(test, { ...base, timestamp: t0 + 10_000 });
  const timestampChangesOmega = once.ok && later.ok && later.omegaRoot !== once.omegaRoot;

  const otherMiner = miner === "other" ? "miner" : "other";
  const paid = applySuccessor(test, { ...base, miner: otherMiner });
  const minerChangesOmega = once.ok && paid.ok && paid.omegaRoot !== once.omegaRoot;

  const garbage: TxRecord = {
    hash: "11",
    from: "aa",
    to: "bb",
    amount: 1,
    fee: 1,
    nonce: 0,
    timestamp: t0,
    status: "pending",
    signature: "00",
    publicKey: "00",
    blockHash: null,
    blockHeight: null,
  };
  const refused = applySuccessor(test, { ...base, transactions: [garbage] });
  const signatureRefused = !refused.ok && refused.error === "signature refused";

  const voting = cloneOmega(test);
  voting.proposals = [
    { id: 1, title: "x", proposer: miner, deposit: 0, yes: 0, no: 0, abstain: 0, status: "open" },
  ];
  const unvoted = applySuccessor(voting, base);
  const withVote = applySuccessor(voting, {
    ...base,
    evidence: {
      v: 1,
      chainId: test.chainId,
      wasmCode: ARBITRAGE_CODE,
      btc: [],
      eth: [],
      wasm: [],
      stake: [{ op: "vote", voter: miner, id: 1, option: "yes" }],
    },
  });
  const voteChangesOmega = unvoted.ok && withVote.ok && withVote.omegaRoot !== unvoted.omegaRoot;

  const side = cloneOmega(voting);
  const proposal = side.proposals[0];
  if (proposal) proposal.yes += 1;
  const offBand = applySuccessor(side, base);
  const offBandVoteIsDifferentOmega =
    unvoted.ok && offBand.ok && withVote.ok && offBand.omegaRoot !== withVote.omegaRoot;

  const q1 = deterministic && deterministicStep && networksDiverge && !readsClock && signatureRefused;

  const fixesForState = [
    "Ω itself, including couplings after passed proposals open",
    "ordered transactions and their signatures",
    "evidence in canonical order, votes included",
    "miner",
    "timestamp, because the next difficulty is a function of it",
    "the numeric model ECMA-262",
    "the wasm binary and host ABI, when a call is in the evidence",
  ];
  if (admitted.length >= 2 && !admittingShareState) fixesForState.push("nonce, because two admitting nonces moved Ω");
  if (admitted.length >= 2 && admittingShareState) {
    fixesForState.push("not the nonce, while every admitting nonce is under the reward clip");
  }
  const fixesForBlock = [
    "the state inputs",
    "nonce",
    "committed pressure",
    "couplings used in the residual",
  ];

  return {
    q1,
    relation: "successor",
    numericModel: NUMERIC_MODEL,
    wasmCode: ARBITRAGE_CODE,
    networksDiverge,
    deterministic: deterministic && deterministicStep,
    readsClock,
    signatureRefused,
    admittingNonces: admitted.length,
    nonceWindow: window,
    admittingShareState,
    admittingResidualsDiffer,
    timestampChangesOmega,
    minerChangesOmega,
    voteChangesOmega,
    offBandVoteIsDifferentOmega,
    inputs: [...BLOCK_INPUTS],
    fixesForState,
    fixesForBlock,
    outside: [...OUTSIDE],
  };
}
