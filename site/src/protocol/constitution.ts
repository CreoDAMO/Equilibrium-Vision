import { merkleRoot, sha256Hex } from "./crypto";
import { evaluateResidual, type SolverHeader } from "./solver";
import { minerReward, slashAmount } from "./coinomics";
import { applySwap, poolAddress } from "./dex";
import { decodeHeaderHex, parseBtcHeader, verifyBtcPow } from "./btc";
import { callArbitrage } from "./wasm-host";
import {
  ETH_MIN_PARTICIPANTS,
  committeeAggregate,
  committeeRaw,
  hashEthHeader,
  hexOf,
  hexToBytes as ethHex,
  verifyRotation,
  verifySelectedHeader,
} from "./eth-light";
import { participationBytes, popcount, U64_MAX } from "./domain";
import { ARBITRAGE_CODE, canonicalEvidence } from "./evidence";
import { selectSuccessorTxs } from "./tx-select";
import { challengeBinding, modelBinding, residualBinding } from "./membranes";
import { verifyTx } from "./wallet";
import { verifyDelegateEvidence, verifyUnbondEvidence } from "./authority";
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
  Unbonding,
  DexPool,
  EthHeaderRecord,
  ModelClaim,
  NetworkId,
  NetworkParams,
  Proposal,
  ResidualBreakdown,
  Settlement,
  SettlementEvidence,
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
  /** 512 compressed keys, hex. Empty until a committee is installed. The aggregate is derived from this. */
  ethCommittee: string;
  eth: EthHeaderRecord[];
  wasm: Map<string, string>;
  validators: Map<string, ValidatorRecord>;
  delegations: Delegation[];
  unbonding: Unbonding[];
  proposals: Proposal[];
  models: ModelClaim[];
  settlements: Settlement[];
  finalizedHeight: number;
}

/** What a block must carry. Difficulty is a claim about Ω, not a free choice. */
export interface CanonicalInputs {
  transactions: TxRecord[];
  evidence: TransitionEvidence | undefined;
  timestamp: number;
  /** Exact u64. A JavaScript number is not this field. */
  nonce: bigint;
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
  "device temperature",
  "peer book",
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
    ethCommittee: omega.ethCommittee ?? "",
    eth: omega.eth.map((h) => ({ ...h })),
    wasm: new Map(omega.wasm),
    validators: new Map([...omega.validators.entries()].map(([k, v]) => [k, { ...v }])),
    delegations: omega.delegations.map((d) => ({ ...d })),
    unbonding: omega.unbonding.map((u) => ({ ...u })),
    proposals: omega.proposals.map((p) => ({ ...p, ballots: [...(p.ballots ?? [])] })),
    models: omega.models.map((m) => ({ ...m })),
    settlements: omega.settlements.map((s) => ({ ...s })),
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

export function sameCouplings(a: Couplings, b: Couplings): boolean {
  return a.hash === b.hash
    && a.structural === b.structural
    && a.continuity === b.continuity
    && a.mempool === b.mempool
    && a.fees === b.fees;
}

/** The couplings the next block is allowed to carry. Not a field a peer may choose. */
export function openedCouplings(omega: Omega): Couplings {
  const next = cloneOmega(omega);
  openOmega(next);
  return next.couplings;
}

function isSafeNonNegative(x: number): boolean {
  return Number.isSafeInteger(x) && x >= 0;
}

function isSafePositive(x: number): boolean {
  return Number.isSafeInteger(x) && x > 0;
}

function safeAdd(a: number, b: number): number | null {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return null;
  const sum = a + b;
  return Number.isSafeInteger(sum) ? sum : null;
}

function safeSub(a: number, b: number): number | null {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return null;
  const diff = a - b;
  return Number.isSafeInteger(diff) ? diff : null;
}

/** Every monetary field G can reach. Invalid Ω is not a legal start, and not a legal result. */
export function monetaryError(omega: Omega): string | null {
  for (const acc of omega.ledger.values()) {
    if (!isSafeNonNegative(acc.balance) || !isSafeNonNegative(acc.nonce)) return "balance refused";
  }
  for (const v of omega.validators.values()) {
    if (!isSafeNonNegative(v.bondedStake)) return "bonded stake refused";
    if (!isSafeNonNegative(v.accumulatedRewards)) return "reward refused";
  }
  for (const d of omega.delegations) {
    if (!isSafePositive(d.amount)) return "delegate amount refused";
  }
  for (const u of omega.unbonding) {
    if (!isSafePositive(u.amount) || !Number.isSafeInteger(u.matureAt)) return "unbond refused";
  }
  for (const p of omega.proposals) {
    if (!isSafeNonNegative(p.deposit) || !isSafeNonNegative(p.yes) || !isSafeNonNegative(p.no) || !isSafeNonNegative(p.abstain)) {
      return "proposal deposit refused";
    }
  }
  return null;
}

function credit(ledger: Map<string, AccountState>, addr: string, amount: number): boolean {
  if (!isSafeNonNegative(amount)) return false;
  const acc = ledger.get(addr) ?? { balance: 0, nonce: 0 };
  if (!isSafeNonNegative(acc.balance)) return false;
  if (amount === 0) {
    if (!ledger.has(addr)) ledger.set(addr, { balance: acc.balance, nonce: acc.nonce });
    return true;
  }
  const next = safeAdd(acc.balance, amount);
  if (next === null) return false;
  ledger.set(addr, { balance: next, nonce: acc.nonce });
  return true;
}

function debit(ledger: Map<string, AccountState>, addr: string, amount: number): boolean {
  if (!isSafeNonNegative(amount)) return false;
  const acc = ledger.get(addr) ?? { balance: 0, nonce: 0 };
  if (!isSafeNonNegative(acc.balance)) return false;
  if (amount === 0) return true;
  const next = safeSub(acc.balance, amount);
  if (next === null) return false;
  ledger.set(addr, { balance: next, nonce: acc.nonce });
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

export function stateRootOf(
  omega: Pick<Omega, "ledger" | "pools" | "btc" | "eth" | "wasm" | "models" | "settlements">,
): string {
  const leaves = [
    ...[...omega.ledger.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([addr, acc]) => sha256Hex(`${addr}:${acc.balance}:${acc.nonce}`)),
    ...[...omega.pools]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((p) => sha256Hex(`pool:${p.id}:${p.address}:${num(p.reserveA)}:${num(p.reserveB)}:${num(p.fee)}:${p.txCount}`)),
    sha256Hex(`btc:${btcLeafOf(omega.btc)}`),
    sha256Hex(`eth:${ethLeafOf(omega.eth)}`),
    sha256Hex(`wasm:${wasmLeafOf(omega.wasm)}`),
    sha256Hex(`models:${modelLeaf(omega.models)}`),
    sha256Hex(`settle:${settlementLeaf(omega.settlements)}`),
  ];
  return merkleRoot(leaves);
}

function modelLeaf(models: ModelClaim[]): string {
  return models
    .map((m) => `${m.id}:${m.status}:${m.residualFp}:${m.supportHash}:${encodeURIComponent(m.uri)}:${m.proposedAt}`)
    .join(";");
}

function settlementLeaf(rows: Settlement[]): string {
  return rows
    .map((s) => `${s.id}:${s.status}:${s.asset}:${s.foreignRef}:${s.from}:${s.to}:${s.amount}`)
    .join(";");
}

function num(n: number): string {
  if (!Number.isFinite(n)) return "nan";
  return Object.is(n, -0) ? "0" : String(n);
}

/** Digest of the successor projection. tipHash is not in it: the next header binds that hash as prev. */
export function omegaDigest(omega: Omega): string {
  const ledger = [...omega.ledger.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([a, acc]) => `${a}:${num(acc.balance)}:${acc.nonce}`);
  const pools = [...omega.pools]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => `${p.id}:${p.address}:${num(p.reserveA)}:${num(p.reserveB)}:${p.txCount}:${num(p.fee)}`);
  const btc = omega.btc
    .map((h) => `${h.height}:${h.hash}:${h.prevHash}:${h.merkleRoot}:${num(h.bits)}`)
    .join(";");
  const headers = omega.eth
    .map((h) => `${h.slot}:${h.hash}:${h.participants}:${h.participation}:${h.parentRoot}:${h.stateRoot}:${h.bodyRoot}`)
    .join(";");
  const committee = omega.ethCommittee ?? "";
  const eth = committee ? `${omega.ethPubkey}:${committee}:${headers}` : `${omega.ethPubkey}:${headers}`;
  const wasm = wasmLeafOf(omega.wasm);
  const validators = [...omega.validators.values()]
    .sort((a, b) => (a.address < b.address ? -1 : 1))
    .map(
      (v) =>
        `${v.address}:${encodeURIComponent(v.moniker)}:${num(v.uptime)}:${num(v.bondedStake)}:${num(v.accumulatedRewards)}:${v.slashed ? 1 : 0}:${v.jailed ? 1 : 0}:${v.blocksProposed}:${num(v.commission)}`,
    );
  const delegations = omega.delegations.map((d) => `${d.delegator}>${d.validator}:${num(d.amount)}`).join(";");
  const unbonding = omega.unbonding.map((u) => `${u.delegator}:${u.validator}:${num(u.amount)}:${u.matureAt}`).join(";");
  const proposals = omega.proposals
    .map((p) => {
      const ballots = (p.ballots ?? []).map((b) => `${b.voter}:${b.option}`).join(",");
      return `${p.id}:${p.status}:${encodeURIComponent(p.title)}:${p.proposer}:${num(p.deposit)}:${num(p.yes)}:${num(p.no)}:${num(p.abstain)}:${p.couplingKey ?? ""}:${p.couplingValue ?? ""}:${ballots}`;
    })
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
    modelLeaf(omega.models),
    settlementLeaf(omega.settlements),
  ].join("|");
  const full = unbonding ? `${body}|${unbonding}` : body;
  return sha256Hex(`eq-omega|${full}`);
}

/**
 * One identity for (Ω, I). The header binds this digest.
 * Difficulty and couplings are claims about Ω: a mismatch is a refusal, not a second value.
 * The mempool is not an input. The transaction list must be the canonical order of itself.
 */
export function transitionDigest(omega: Omega, inputs: CanonicalInputs): string {
  const txs = inputs.transactions
    .map((t) => `${t.hash}:${t.from}:${t.to}:${t.amount}:${t.fee}:${t.nonce}`)
    .join(";");
  const evidence = inputs.evidence ? canonicalEvidence(inputs.evidence) : "";
  if (typeof inputs.nonce !== "bigint" || inputs.nonce < 0n || inputs.nonce > U64_MAX) {
    throw new Error("nonce is not a u64");
  }
  const c = inputs.couplings;
  const body = [
    omega.tipHash,
    omegaDigest(omega),
    txs,
    evidence,
    String(inputs.timestamp),
    inputs.nonce.toString(),
    inputs.miner,
    inputs.committedPressure.toFixed(6),
    String(inputs.difficulty),
    `${num(c.hash)},${num(c.structural)},${num(c.continuity)},${num(c.mempool)},${num(c.fees)}`,
  ].join("|");
  return sha256Hex(`eq-transition|${body}`);
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

/** Last byte of a 64-hex tip, or null when there is no tip. */
function tipByte(hash: string | undefined): number | null {
  if (!hash || hash.length < 2) return null;
  const byte = Number.parseInt(hash.slice(-2), 16);
  return Number.isFinite(byte) ? byte : null;
}

/**
 * Verified foreign tips move the next difficulty.
 * No tip returns 1/1, so the time rule is unchanged.
 * Each tip's last byte maps onto the integer ratio [9950, 10050] / 10000,
 * which is the closed interval [0.995, 1.005].
 */
export function foreignDifficultyFactor(omega: Pick<Omega, "btc" | "eth">): { num: number; den: number } {
  let num = 1;
  let den = 1;
  const apply = (byte: number | null) => {
    if (byte === null) return;
    const bump = Math.round((byte / 255) * 100);
    num *= 9950 + bump;
    den *= 10_000;
  };
  apply(tipByte(omega.btc[omega.btc.length - 1]?.hash));
  apply(tipByte(omega.eth[omega.eth.length - 1]?.hash));
  return { num, den };
}

export function adjustDifficulty(
  difficulty: number,
  blockTime: number,
  params: NetworkParams,
  foreign: { num: number; den: number } = { num: 1, den: 1 },
): number {
  const target = params.targetBlockTimeMs / 1000;
  if (blockTime <= 0) return difficulty;
  const unclamped = (target / blockTime) * (foreign.num / foreign.den);
  const factor = Math.max(0.8, Math.min(1.2, unclamped));
  if (factor === 0.8 || factor === 1.2) {
    return Math.max(100_000, Math.floor(difficulty * factor));
  }
  const scaled = Math.floor((difficulty * target * foreign.num) / (blockTime * foreign.den));
  return Math.max(100_000, scaled);
}

/** Authority is read from Ω before this transition mutates it. Later stake ops do not rewrite it. */
function authoritySnapshot(
  omega: Omega,
  quorumRatio: number,
): { power: Map<string, number>; total: number; quorum: number } | string {
  const power = new Map<string, number>();
  let total = 0;
  for (const v of omega.validators.values()) {
    if (v.jailed || v.slashed || !isSafePositive(v.bondedStake)) continue;
    const next = safeAdd(total, v.bondedStake);
    if (next === null) return "bonded stake refused";
    total = next;
    power.set(v.address, v.bondedStake);
  }
  return { power, total, quorum: quorumRatio * total };
}

function applyStake(
  omega: Omega,
  op: StakeEvidence,
  params: NetworkParams,
  authority: { power: Map<string, number>; total: number; quorum: number },
): string | null {
  if (op.op === "unbond") {
    const refused = verifyUnbondEvidence(omega.chainId, op);
    if (refused) return refused;
    const v = omega.validators.get(op.validator);
    if (!v || v.jailed || v.slashed) return "unbond refused";
    let available = 0;
    for (const d of omega.delegations) {
      if (d.delegator !== op.delegator || d.validator !== op.validator) continue;
      const next = safeAdd(available, d.amount);
      if (next === null) return "unbond funds refused";
      available = next;
    }
    if (available < op.amount) return "unbond funds refused";
    const nextStake = safeSub(v.bondedStake, op.amount);
    if (nextStake === null) return "unbond refused";
    const matureAt = omega.height + params.unbondingPeriod;
    if (!Number.isSafeInteger(matureAt)) return "unbond refused";
    let left = op.amount;
    const kept: Delegation[] = [];
    for (const d of omega.delegations) {
      if (left === 0 || d.delegator !== op.delegator || d.validator !== op.validator) {
        kept.push(d);
        continue;
      }
      if (d.amount > left) {
        kept.push({ ...d, amount: d.amount - left });
        left = 0;
      } else {
        left -= d.amount;
      }
    }
    if (left !== 0) return "unbond funds refused";
    omega.delegations = kept;
    v.bondedStake = nextStake;
    omega.unbonding.push({
      delegator: op.delegator,
      validator: op.validator,
      amount: op.amount,
      matureAt,
    });
    return null;
  }
  if (op.op === "delegate") {
    const publicKey = op.publicKey ?? "";
    const signature = op.signature ?? "";
    if (publicKey !== "" || signature !== "") {
      const refused = verifyDelegateEvidence(omega.chainId, op);
      if (refused) return refused;
    } else {
      return "delegate authority refused";
    }
    const v = omega.validators.get(op.validator);
    if (!v || v.jailed || v.slashed) return "delegate refused";
    if (!isSafePositive(op.amount)) return "delegate amount refused";
    const nextStake = safeAdd(v.bondedStake, op.amount);
    if (nextStake === null) return "delegate amount refused";
    if (!debit(omega.ledger, op.delegator, op.amount)) return "delegate funds refused";
    v.bondedStake = nextStake;
    omega.delegations.push({ delegator: op.delegator, validator: op.validator, amount: op.amount });
    return null;
  }
  if (op.op === "claim") {
    const v = omega.validators.get(op.address);
    if (!v || !isSafePositive(v.accumulatedRewards)) return "claim refused";
    const amount = v.accumulatedRewards;
    if (!credit(omega.ledger, op.address, amount)) return "claim refused";
    v.accumulatedRewards = 0;
    return null;
  }
  if (op.op === "slash") {
    const v = omega.validators.get(op.validator);
    if (!v || v.slashed || v.jailed) return "slash refused";
    if (!isSafePositive(v.bondedStake)) return "slash refused";
    const burned = slashAmount(v.bondedStake, op.reason);
    if (!isSafeNonNegative(burned) || burned > v.bondedStake) return "slash refused";
    const nextStake = safeSub(v.bondedStake, burned);
    if (nextStake === null) return "slash refused";
    v.bondedStake = nextStake;
    v.slashed = true;
    if (op.reason === "double_sign") v.jailed = true;
    return null;
  }
  if (op.op === "vote") {
    const p = omega.proposals.find((x) => x.id === op.id);
    if (!p || p.status !== "open") return "vote refused";
    const power = authority.power.get(op.voter);
    if (power === undefined) return "vote refused";
    if ((p.ballots ?? []).some((b) => b.voter === op.voter)) return "vote already cast";
    const tally = safeAdd(p[op.option], power);
    if (tally === null) return "vote refused";
    p[op.option] = tally;
    p.ballots = [...(p.ballots ?? []), { voter: op.voter, option: op.option }];
    const yesNo = safeAdd(p.yes, p.no);
    const total = yesNo === null ? null : safeAdd(yesNo, p.abstain);
    if (total !== null && authority.total > 0 && total >= authority.quorum) {
      p.status = p.yes > p.no ? "passed" : "failed";
    }
    return null;
  }
  if (op.op === "propose") {
    if (!authority.power.has(op.proposer)) return "proposal proposer unauthorized";
    if (!isSafeNonNegative(op.deposit)) return "proposal deposit refused";
    if (!Number.isSafeInteger(op.id) || op.id < 0) return "proposal deposit refused";
    if (typeof op.title !== "string" || op.title.length > 80) return "proposal deposit refused";
    if (omega.proposals.some((p) => p.id === op.id)) return "proposal already exists";
    if (!debit(omega.ledger, op.proposer, op.deposit)) return "proposal deposit refused";
    const couplingKeys = ["hash", "structural", "continuity", "mempool", "fees"] as const;
    let couplingKey: (typeof couplingKeys)[number] | undefined;
    let couplingValue: number | undefined;
    if (op.couplingKey !== undefined || op.couplingValue !== undefined) {
      if (!op.couplingKey || !(couplingKeys as readonly string[]).includes(op.couplingKey)) return "coupling is not a coupling";
      if (typeof op.couplingValue !== "number" || !Number.isFinite(op.couplingValue)) return "coupling is not a coupling";
      couplingKey = op.couplingKey;
      couplingValue = op.couplingValue;
    }
    omega.proposals.unshift({
      id: op.id,
      title: op.title,
      proposer: op.proposer,
      deposit: op.deposit,
      yes: 0,
      no: 0,
      abstain: 0,
      status: "open",
      ballots: [],
      ...(couplingKey ? { couplingKey, couplingValue } : {}),
    });
    return null;
  }
  return "stake evidence refused";
}

function installCommittee(omega: Omega, committeeHex: string, claimed: string): string | null {
  const raw = committeeRaw(committeeHex);
  if (!raw) return "eth committee refused";
  const derived = committeeAggregate(committeeHex);
  if (!derived) return "eth committee refused";
  const claim = claimed.trim().replace(/^0x/i, "").toLowerCase();
  if (claim !== derived) return "eth aggregate is not the committee";
  omega.ethCommittee = hexOf(raw);
  omega.ethPubkey = derived;
  return null;
}

function committeeBound(omega: Omega): string | null {
  if (!omega.ethCommittee) return null;
  const derived = committeeAggregate(omega.ethCommittee);
  if (!derived || derived !== omega.ethPubkey) return "eth committee is not bound";
  return null;
}

function readSignature(hex: string): Uint8Array | null {
  try {
    const raw = ethHex(hex.replace(/^0x/, ""));
    return raw.length === 96 ? raw : null;
  } catch {
    return null;
  }
}

function applyMaterial(omega: Omega, ev: TransitionEvidence | undefined, params: NetworkParams): string | null {
  if (!ev) return null;
  if (ev.v !== 1) return "unknown evidence version";
  if (ev.chainId !== omega.chainId) return `evidence chain ${ev.chainId} is not ${omega.chainId}`;
  if (ev.wasmCode !== ARBITRAGE_CODE) return "wasm code is not this constitution";
  const authority = authoritySnapshot(omega, params.finalityQuorum);
  if (typeof authority === "string") return authority;
  for (const op of ev.stake) {
    const refused = applyStake(omega, op, params, authority);
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
    if (item.op === "bootstrap" || item.op === "rotate") {
      if (item.op === "bootstrap") {
        if (omega.ethCommittee) return "eth committee already installed";
      } else {
        if (!omega.ethCommittee) return "eth header before committee";
        const bound = committeeBound(omega);
        if (bound) return bound;
        let bits: Uint8Array;
        try {
          bits = participationBytes(item.participation);
        } catch {
          return "participation refused";
        }
        if (popcount(bits) < ETH_MIN_PARTICIPANTS) return "eth quorum not met";
        const next = committeeRaw(item.committee);
        const sig = readSignature(item.signature);
        if (!next || !sig || !verifyRotation(omega.ethCommittee, bits, sig, next)) return "eth rotation refused";
      }
      const installed = installCommittee(omega, item.committee, item.aggregate);
      if (installed) return installed;
      continue;
    }
    if (!omega.ethCommittee) return "eth header before committee";
    const bound = committeeBound(omega);
    if (bound) return bound;
    let bits: Uint8Array;
    try {
      bits = participationBytes(item.participation);
    } catch {
      return "participation refused";
    }
    const participants = popcount(bits);
    if (participants < ETH_MIN_PARTICIPANTS) return "eth quorum not met";
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
    const sig = readSignature(item.signature);
    if (!sig || !verifySelectedHeader(omega.ethCommittee, fields, sig, bits)) return "eth signature refused";
    omega.eth.push({
      slot: item.slot,
      hash: hexOf(hashEthHeader(fields, bits)),
      parentRoot: item.parentRoot,
      stateRoot: item.stateRoot,
      bodyRoot: item.bodyRoot,
      participants,
      participation: hexOf(bits),
    });
  }
  for (const item of ev.settle ?? []) {
    const refused = applySettlement(omega, item);
    if (refused) return refused;
  }
  return null;
}

function foreignKnown(omega: Omega, asset: "btc" | "eth", foreignRef: string): boolean {
  if (asset === "btc") return omega.btc.some((h) => h.hash === foreignRef);
  return omega.eth.some((h) => h.hash === foreignRef);
}

/** Lock moves EQU already in the ledger. Release pays that same EQU. Nothing is minted. */
function applySettlement(omega: Omega, item: SettlementEvidence): string | null {
  if (item.op === "lock") {
    if (!Number.isSafeInteger(item.amount) || item.amount <= 0) return "settlement amount refused";
    if (!Number.isSafeInteger(item.id) || item.id < 0) return "settlement id refused";
    if (omega.settlements.some((s) => s.id === item.id)) return "settlement already exists";
    if (item.asset !== "btc" && item.asset !== "eth") return "settlement asset refused";
    if (!foreignKnown(omega, item.asset, item.foreignRef)) return "foreign observation is not in Ω";
    if (!debit(omega.ledger, item.from, item.amount)) return "settlement lock refused";
    omega.settlements.push({
      id: item.id,
      asset: item.asset,
      foreignRef: item.foreignRef,
      from: item.from,
      to: item.to,
      amount: item.amount,
      status: "locked",
    });
    return null;
  }
  const row = omega.settlements.find((s) => s.id === item.id);
  if (!row || row.status !== "locked") return "settlement is not locked";
  if (!foreignKnown(omega, row.asset, row.foreignRef)) return "foreign observation left the window";
  if (!credit(omega.ledger, row.to, row.amount)) return "settlement amount refused";
  row.status = "settled";
  return null;
}

function admitModels(omega: Omega, ev: TransitionEvidence | undefined, timestamp: number): string | null {
  for (const item of ev?.cognition ?? []) {
    if (item.kind === "bind") continue;
    if (item.kind === "challenge") {
      const row = omega.models.find((m) => m.id === item.id);
      if (!row || row.status === "slashed") return "model is not bound";
      if (!/^[0-9a-f]{64}$/.test(item.supportHash)) return "challenge support refused";
      if (item.supportHash === row.supportHash) return "challenge does not disagree";
      if (item.proof !== challengeBinding(omega.chainId, item.id, item.supportHash)) {
        return "challenge commitment refused";
      }
      row.status = "slashed";
      continue;
    }
    if (!item.uri || item.uri.length > 128) return "model uri refused";
    if (!Number.isSafeInteger(item.residualFp) || item.residualFp < 0) return "model residual refused";
    if (!/^[0-9a-f]{64}$/.test(item.supportHash)) return "model support refused";
    if (item.proof !== modelBinding(omega.chainId, item)) return "model commitment refused";
    const existing = omega.models.find((m) => m.id === item.id);
    if (!existing) {
      omega.models.unshift({
        id: item.id,
        uri: item.uri,
        residualFp: item.residualFp,
        supportHash: item.supportHash,
        status: "bound",
        proposedAt: timestamp,
      });
      continue;
    }
    if (existing.supportHash !== item.supportHash || existing.residualFp !== item.residualFp) {
      return "model claim does not match the registry";
    }
  }
  return null;
}

/** The binding names the residual and state root G just computed. It does not replace them. */
function admitBinding(ev: TransitionEvidence | undefined, residualFp: number, stateRoot: string): string | null {
  for (const item of ev?.cognition ?? []) {
    if (item.kind !== "bind") continue;
    if (item.residualFp !== residualFp) return "proof does not name this residual";
    if (item.proof !== residualBinding(residualFp, stateRoot)) return "proof does not bind this state";
  }
  return null;
}

function applyEffects(
  omega: Omega,
  txs: TxRecord[],
  miner: string,
  reward: number,
  swaps: SwapEvent[],
): string | null {
  for (const tx of txs) {
    if (!Number.isSafeInteger(tx.amount) || !Number.isSafeInteger(tx.fee) || tx.amount <= 0 || tx.fee < 0) {
      return "amount refused";
    }
    const total = safeAdd(tx.amount, tx.fee);
    if (total === null) return "amount refused";
    const sender = omega.ledger.get(tx.from) ?? { balance: 0, nonce: 0 };
    if (!isSafeNonNegative(sender.nonce)) return "bad nonce";
    if (tx.nonce !== sender.nonce) return "bad nonce";
    if (!isSafeNonNegative(sender.balance) || sender.balance < total) return "insufficient funds";
    const left = safeSub(sender.balance, total);
    if (left === null) return "amount refused";
    omega.ledger.set(tx.from, { balance: left, nonce: sender.nonce + 1 });
    if (!credit(omega.ledger, miner, tx.fee)) return "amount refused";
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
    } else if (!credit(omega.ledger, tx.to, tx.amount)) {
      return "amount refused";
    }
  }
  if (!isSafeNonNegative(reward) || !credit(omega.ledger, miner, reward)) return "reward refused";
  return null;
}

function settleMaturedUnbondings(omega: Omega, height: number): string | null {
  const keep: Unbonding[] = [];
  for (const u of omega.unbonding) {
    if (u.matureAt > height) {
      keep.push(u);
      continue;
    }
    if (!credit(omega.ledger, u.delegator, u.amount)) return "unbond payout refused";
  }
  omega.unbonding = keep;
  return null;
}

class DerivedWasm {
  constructor(readonly storage: Map<string, string>) {}
}

/**
 * The relation. One (Ω, inputs) value, one next Ω.
 * Wasm storage is not an input. Only successor() can pass a DerivedWasm.
 */
export function applySuccessor(omega: Omega, inputs: CanonicalInputs, derived?: DerivedWasm): Successor {
  const params = paramsOf(omega.chainId);
  if (!params) return { ok: false, error: "unknown chain" };
  if (typeof inputs.nonce !== "bigint" || inputs.nonce < 0n || inputs.nonce > U64_MAX) {
    return { ok: false, error: "nonce is not a u64" };
  }
  const invalid = monetaryError(omega);
  if (invalid) return { ok: false, error: invalid };
  if (inputs.difficulty !== omega.difficulty) return { ok: false, error: "difficulty is not the next difficulty" };
  if (!Number.isFinite(inputs.committedPressure) || inputs.committedPressure < 0 || inputs.committedPressure > 1) {
    return { ok: false, error: "pressure is not in [0,1]" };
  }
  if (!Number.isSafeInteger(inputs.timestamp) || inputs.timestamp < 0) return { ok: false, error: "timestamp is not a time" };
  if (omega.height >= 0 && inputs.timestamp < omega.tipTimestamp) return { ok: false, error: "timestamp is not monotonic" };
  for (const tx of inputs.transactions) {
    if (!verifyTx(tx, omega.chainId)) return { ok: false, error: "signature refused" };
  }
  if (inputs.transactions.length > params.maxTxPerBlock) {
    return { ok: false, error: "transactions are not the canonical selection" };
  }
  const ordered = selectSuccessorTxs(
    (addr) => omega.ledger.get(addr)?.balance ?? 0,
    (addr) => omega.ledger.get(addr)?.nonce ?? 0,
    inputs.transactions,
    params.maxTxPerBlock,
    (tx) => !omega.pools.some((p) => (p.address || poolAddress(p.id)) === tx.to),
  );
  if (
    ordered.length === inputs.transactions.length
    && ordered.some((tx, i) => tx !== inputs.transactions[i])
  ) {
    return { ok: false, error: "transactions are not the canonical selection" };
  }
  const next = cloneOmega(omega);
  openOmega(next);
  if (!sameCouplings(inputs.couplings, next.couplings)) return { ok: false, error: "couplings are not the opened couplings" };
  const producer = next.validators.get(inputs.miner);
  if (!producer || producer.jailed || producer.slashed || producer.bondedStake <= 0) {
    return { ok: false, error: "miner is not a live validator" };
  }
  const materialError = applyMaterial(next, inputs.evidence, params);
  if (materialError) return { ok: false, error: materialError };
  if (inputs.evidence?.wasm.length) {
    if (!(derived instanceof DerivedWasm)) return { ok: false, error: "wasm is executed by the successor" };
    next.wasm = new Map(derived.storage);
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
    next.couplings,
  );
  const reward = rewardOf(params, height, breakdown.canonical);
  const split = issuanceSplit(next.validators, inputs.miner, reward);
  const swaps: SwapEvent[] = [];
  const effectError = applyEffects(next, inputs.transactions, inputs.miner, split.liquid, swaps);
  if (effectError) return { ok: false, error: effectError };
  // A list the selector would not emit is not I, even if effects could apply it
  // (a miner fee credited inside the block is not a balance the selector sees).
  if (
    ordered.length !== inputs.transactions.length
    || ordered.some((tx, i) => tx !== inputs.transactions[i])
  ) {
    return { ok: false, error: "transactions are not the canonical selection" };
  }
  const modelError = admitModels(next, inputs.evidence, inputs.timestamp);
  if (modelError) return { ok: false, error: modelError };
  const settled = settleMaturedUnbondings(next, height);
  if (settled) return { ok: false, error: settled };
  const stateRoot = stateRootOf(next);
  const bindError = admitBinding(inputs.evidence, breakdown.canonicalFp, stateRoot);
  if (bindError) return { ok: false, error: bindError };
  const minerV = next.validators.get(inputs.miner);
  if (minerV) minerV.blocksProposed += 1;
  const distributed = distribute(next.validators, reward - split.liquid);
  if (distributed) return { ok: false, error: distributed };
  const still = monetaryError(next);
  if (still) return { ok: false, error: still };
  next.height = height;
  next.tipTimestamp = inputs.timestamp;
  const blockTime =
    omega.height < 0 ? params.targetBlockTimeMs / 1000 : inputs.timestamp - omega.tipTimestamp;
  next.difficulty = adjustDifficulty(omega.difficulty, blockTime, params, foreignDifficultyFactor(next));
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

function distribute(validators: Map<string, ValidatorRecord>, staked: number): string | null {
  if (!isSafeNonNegative(staked)) return "reward refused";
  if (staked === 0) return null;
  const live = [...validators.values()].filter((x) => !x.jailed && !x.slashed && isSafePositive(x.bondedStake));
  let total = 0;
  for (const x of live) {
    const next = safeAdd(total, x.bondedStake);
    if (next === null) return "bonded stake refused";
    total = next;
  }
  if (!isSafePositive(total)) return "bonded stake refused";
  for (const x of live) {
    const product = safeAdd(0, staked * x.bondedStake);
    if (product === null || !Number.isSafeInteger(staked * x.bondedStake)) return "reward refused";
    const share = Math.floor((staked * x.bondedStake) / total);
    if (!isSafeNonNegative(share)) return "reward refused";
    const next = safeAdd(x.accumulatedRewards, share);
    if (next === null) return "reward refused";
    x.accumulatedRewards = next;
  }
  return null;
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

/** Constitution entry. Executes wasm. A caller-supplied map is not Ω.wasm. */
export async function successor(omega: Omega, inputs: Omit<CanonicalInputs, "wasmAfter">): Promise<Successor> {
  let derived: DerivedWasm | undefined;
  if (inputs.evidence?.wasm.length) {
    const executed = await executeWasm(omega, inputs.evidence, Math.max(0, omega.height));
    if (typeof executed === "string") return { ok: false, error: executed };
    derived = new DerivedWasm(executed);
  }
  return applySuccessor(omega, { ...inputs, wasmAfter: null }, derived);
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
    ethCommittee: "",
    eth: [],
    wasm: new Map(),
    validators: new Map(),
    delegations: [],
    unbonding: [],
    proposals: [],
    models: [],
    settlements: [],
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

function blankInputs(omega: Omega, nonce: bigint, timestamp: number, miner: string): CanonicalInputs {
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
  const keys = [...test.validators.keys()];
  const miner = keys[0] ?? "miner";
  const base = blankInputs(test, BigInt(admitted[0] ?? 0), t0, miner);
  const once = applySuccessor(test, base);
  const twice = applySuccessor(test, base);
  const deterministicStep = once.ok && twice.ok && once.omegaRoot === twice.omegaRoot;

  let admittingShareState = false;
  let admittingResidualsDiffer = false;
  if (admitted.length >= 2 && once.ok) {
    const other = applySuccessor(test, { ...base, nonce: BigInt(admitted[1]!) });
    if (other.ok) {
      admittingShareState = other.omegaRoot === once.omegaRoot;
      admittingResidualsDiffer = other.residual !== once.residual;
    }
  }

  const later = applySuccessor(test, { ...base, timestamp: t0 + 10_000 });
  const timestampChangesOmega = once.ok && later.ok && later.omegaRoot !== once.omegaRoot;

  const otherLive = keys.find((k) => k !== miner) ?? miner;
  const paid = applySuccessor(test, { ...base, miner: otherLive });
  const minerChangesOmega = miner !== otherLive && once.ok && paid.ok && paid.omegaRoot !== once.omegaRoot;
  const stranger = applySuccessor(test, { ...base, miner: "0".repeat(40) });
  const strangerRefused = !stranger.ok && stranger.error === "miner is not a live validator";

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

  const q1 = deterministic && deterministicStep && networksDiverge && !readsClock && signatureRefused && strangerRefused;

  const fixesForState = [
    "Ω itself, including couplings after passed proposals open",
    "ordered transactions and their signatures",
    "evidence in canonical order, votes included",
    "miner, and the miner must already be a live validator",
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
