export type NetworkId = "testnet" | "mainnet";

export interface Couplings {
  hash: number;
  structural: number;
  continuity: number;
  mempool: number;
  fees: number;
}

export const DEFAULT_COUPLINGS: Couplings = {
  hash: 1,
  structural: 1,
  continuity: 1,
  mempool: 1,
  fees: 1,
};

export interface NetworkParams {
  id: NetworkId;
  chainId: number;
  name: string;
  domain: string;
  targetBlockTimeMs: number;
  residualThreshold: number;
  territoryThreshold: number;
  initialDifficulty: number;
  baseReward: number;
  halvingInterval: number;
  maxTxPerBlock: number;
  mempoolCap: number;
  finalityQuorum: number;
  finalityLag: number;
  allowFaucet: boolean;
  faucetAmount: number;
}

export interface AccountState {
  balance: number;
  nonce: number;
}

export interface TxRecord {
  hash: string;
  from: string;
  to: string;
  amount: number;
  fee: number;
  nonce: number;
  timestamp: number;
  status: "pending" | "confirmed" | "failed";
  signature: string;
  publicKey: string;
  blockHash: string | null;
  blockHeight: number | null;
}

export interface ResidualBreakdown {
  canonical: number;
  canonicalFp: number;
  territory: number;
  territoryFp: number;
  violations: {
    hash: number;
    structural: number;
    continuity: number;
    mempool: number;
    fees: number;
  };
  lambdas: Couplings;
  hFrac: number;
  hashVal: string;
}

export interface StationarityRelation {
  ok: boolean;
  residualFp: number;
  thresholdFp: number;
  difference: number;
  hashLo: string;
  hashHi: string;
}

export interface EthHeaderRecord {
  slot: number;
  hash: string;
  parentRoot: string;
  stateRoot: string;
  bodyRoot: string;
  participants: number;
}

/** Bitcoin header admitted inside one transition. The hex is the evidence. */
export interface BtcEvidence {
  headerHex: string;
  height: number;
}

export type EthEvidence =
  | { op: "bootstrap"; pubkey: string }
  | {
      op: "header";
      slot: number;
      proposerIndex: number;
      parentRoot: string;
      stateRoot: string;
      bodyRoot: string;
      participants: number;
      signature: string;
    };

export interface WasmEvidence {
  method: "init" | "pause" | "unpause";
  caller: string;
}

export type StakeEvidence =
  | { op: "delegate"; delegator: string; validator: string; amount: number }
  | { op: "claim"; address: string }
  | { op: "slash"; validator: string; reason: "double_sign" | "downtime" }
  | { op: "propose"; proposer: string; title: string; deposit: number; id: number }
  | { op: "vote"; voter: string; id: number; option: "yes" | "no" | "abstain" };

/**
 * Inputs of Ωt → Ωt+1 that are not signed transfers.
 * Carried on the block. Absent on blocks minted before this boundary.
 */
export interface TransitionEvidence {
  v: 1;
  chainId: number;
  wasmCode: string;
  btc: BtcEvidence[];
  eth: EthEvidence[];
  wasm: WasmEvidence[];
  stake: StakeEvidence[];
}

/** Measured answer of the transition relation. Produced by running it, not by describing it. */
export interface ConstitutionAnswer {
  q1: boolean;
  relation: "successor";
  numericModel: "ECMA-262";
  wasmCode: string;
  networksDiverge: boolean;
  deterministic: boolean;
  readsClock: boolean;
  signatureRefused: boolean;
  admittingNonces: number;
  nonceWindow: number;
  admittingShareState: boolean;
  admittingResidualsDiffer: boolean;
  timestampChangesOmega: boolean;
  minerChangesOmega: boolean;
  voteChangesOmega: boolean;
  offBandVoteIsDifferentOmega: boolean;
  inputs: string[];
  fixesForState: string[];
  fixesForBlock: string[];
  outside: string[];
}

/** A body that was given the blocks and the constitution, not the producer's memory. */
export interface SecondBodyReport {
  ok: boolean;
  height: number;
  stateRoot: string;
  hash: string;
  error: string | null;
}

/** The first producer has stopped. A second body produced the next block, and a third body accepted it. */
export interface TakeoverReport {
  ok: boolean;
  height: number;
  hash: string;
  prevHash: string;
  stateRoot: string;
  difficulty: number;
  residual: number;
  btcTip: string | null;
  error: string | null;
}

export interface BlockRecord {
  hash: string;
  height: number;
  prevHash: string;
  merkleRoot: string;
  stateRoot: string;
  timestamp: number;
  nonce: number;
  difficulty: number;
  residual: number;
  residualFp: number;
  territoryResidual: number;
  committedPressure: number;
  recursionDepth: number;
  coinbaseReward: number;
  /** Portion of the coinbase credited to the miner's liquid balance. The rest is staked rewards. */
  liquidIssuance?: number;
  miner: string;
  txCount: number;
  transactions: TxRecord[];
  finalized: boolean;
  couplings: Couplings;
  breakdown: ResidualBreakdown;
  solverIterations: number;
  verified: boolean;
  verifyNotes: string[];
  relation?: StationarityRelation;
  /** Present when this block binds chain id and the non-transfer inputs. */
  evidence?: TransitionEvidence;
  /** Digest of Ω after this transition. Bound in the header when evidence is present. */
  omegaRoot?: string;
}

export interface ValidatorRecord {
  address: string;
  moniker: string;
  bondedStake: number;
  accumulatedRewards: number;
  slashed: boolean;
  jailed: boolean;
  uptime: number;
  blocksProposed: number;
  commission: number;
}

export interface Delegation {
  delegator: string;
  validator: string;
  amount: number;
}

export interface Proposal {
  id: number;
  title: string;
  proposer: string;
  deposit: number;
  yes: number;
  no: number;
  abstain: number;
  status: "open" | "passed" | "failed" | "executed";
  couplingKey?: keyof Couplings;
  couplingValue?: number;
}

export interface ModelClaim {
  id: number;
  uri: string;
  residualFp: number;
  supportHash: string;
  status: "proposed" | "verified" | "slashed";
  proposedAt: number;
}

export interface FinalityRound {
  height: number;
  blockHash: string;
  votes: number;
  votingPower: number;
  totalVotingPower: number;
  finalized: boolean;
}

export interface DexPool {
  id: string;
  tokenA: string;
  tokenB: string;
  reserveA: number;
  reserveB: number;
  fee: number;
  txCount: number;
  /** Signed EQU transfers to this address are swaps of tokenA. */
  address: string;
}

export interface BtcHeaderRecord {
  hash: string;
  height: number;
  prevHash: string;
  merkleRoot: string;
  bits: number;
}

export interface SwapEvent {
  poolId: string;
  trader: string;
  amountIn: number;
  amountOut: number;
  tokenIn: string;
  tokenOut: string;
  timestamp: number;
}

export interface BlockStat {
  height: number;
  residual: number;
  territoryResidual: number;
  mempoolPressure: number;
  difficulty: number;
  blockTime: number;
  txCount: number;
  timestamp: number;
}

export interface PeerRecord {
  peerId: string;
  address: string;
  latencyMs: number;
  height: number;
  connected: boolean;
  kind: "server" | "mobile" | "light" | "validator";
}

export type FlowDir = "in" | "out" | "close";

export interface OrganismEvent {
  id: number;
  t: number;
  dir: FlowDir;
  organ:
    | "network"
    | "mempool"
    | "solver"
    | "verify"
    | "transition"
    | "memory"
    | "finality"
    | "wallet"
    | "governance"
    | "mesh";
  message: string;
}

export interface VerificationReport {
  ok: boolean;
  verifyEvals: number;
  checks: Array<{
    name: string;
    ok: boolean;
    detail: string;
  }>;
}

export interface Wholes {
  committed: string[];
  observed: string[];
  operational: string[];
  whole: string[];
}

export interface ExperimentArm {
  residual: number;
  iterations: number;
  nonce: number;
  reward: number;
  pressure: number;
  couplings: Couplings;
}

export interface PairedResult {
  kind: "paired";
  key: keyof Couplings;
  inject: number;
  pressureAtSolve: number;
  withLambda: ExperimentArm;
  withoutLambda: ExperimentArm;
  deltaR: number;
  deltaIters: number;
  /** |ΔR| above noise. A constant λ can do this without moving the nonce. */
  formulaEffect: boolean;
  /** Winning nonce differed. Only nonce-dependent terms can do this. */
  discoveryEffect: boolean;
  rewardEffect: boolean;
  /** True if formula or discovery moved. Not a claim that λ changed the search. */
  causal: boolean;
}

export interface CouplingEffect {
  key: keyof Couplings;
  formulaEffect: boolean;
  discoveryEffect: boolean;
  rewardEffect: boolean;
  deltaR: number;
  nonceWith: number;
  nonceWithout: number;
}

/** One closed transition: solver, verify, mempool, governance, stake, finality, restore. */
export interface WholeReport {
  height: number;
  primedTxs: number;
  pressure: number;
  baseline: {
    nonce: number;
    residual: number;
    reward: number;
    liquid: number;
    verified: boolean;
  };
  couplings: CouplingEffect[];
  mempool: {
    txs: number;
    discoveryEffect: boolean;
    nonceWithTxs: number;
    nonceEmpty: number;
  };
  governance: {
    applied: boolean;
    key: keyof Couplings;
    discoveryEffect: boolean;
    formulaEffect: boolean;
    nonceAfter: number;
  };
  stake: {
    minerBonded: boolean;
    reward: number;
    liquidIssuance: number;
    distributed: number;
  };
  finality: {
    healthyFinalized: boolean;
    jailedFinalized: boolean;
    separatedFromStationarity: boolean;
  };
  persistence: {
    restartEqual: boolean;
    height: number;
    hash: string;
    stateRoot: string;
    residual: number;
  };
  verifyAgrees: boolean;
  sourceLaw: string;
}

export interface BidirectionalTrial {
  height: number;
  claimedR: number;
  inferredR: number;
  agree: boolean;
  discoveryIters: number;
  verifyEvals: number;
  forgedRejected: boolean;
}

export interface PersistedBody {
  blocks: BlockRecord[];
  accounts: Array<[string, AccountState]>;
  validators: ValidatorRecord[];
  mempool: TxRecord[];
  txs: TxRecord[];
  pools: DexPool[];
  delegations: Delegation[];
  proposals: Proposal[];
  models: ModelClaim[];
  btcHeaders?: BtcHeaderRecord[];
  wasmStorage?: Array<[string, string]>;
  ethPubkey?: string;
  ethHeaders?: EthHeaderRecord[];
  difficulty: number;
  couplings: Couplings;
  lastMineAt: number;
}

export interface ChainSnapshot {
  network: NetworkId;
  params: NetworkParams;
  height: number;
  finalizedHeight: number;
  finalityLag: number;
  latestHash: string;
  genesisHash: string;
  difficulty: number;
  lastResidual: number;
  lastTerritoryResidual: number;
  mempoolSize: number;
  mempoolPressure: number;
  tps: number;
  totalTxCount: number;
  validatorCount: number;
  totalBonded: number;
  supply: number;
  peers: PeerRecord[];
  recentBlocks: BlockRecord[];
  recentTxs: TxRecord[];
  mempool: TxRecord[];
  validators: ValidatorRecord[];
  stats: BlockStat[];
  events: OrganismEvent[];
  pools: DexPool[];
  swaps: SwapEvent[];
  btc: { count: number; tipHash: string | null; tipHeight: number | null };
  eth: { bootstrapped: boolean; tipSlot: number | null; tipHash: string | null };
  wasmStorage: Array<[string, string]>;
  announced: string[];
  couplings: Couplings;
  wholes: Wholes;
  lastVerify: VerificationReport | null;
  miner: string;
  treasury: string;
  persisted: boolean;
  delegations: Delegation[];
  proposals: Proposal[];
  models: ModelClaim[];
  lastPaired: PairedResult | null;
  lastWhole: WholeReport | null;
  lastBidirectional: BidirectionalTrial | null;
  /** Null while the second body is still replaying. */
  secondBody: SecondBodyReport | null;
  constitution: ConstitutionAnswer;
  /** Each dependency of the transition, and whether it changes Ω. */
  dependencies: DependencyRow[];
  /** What this kernel can and cannot do, measured where it can be measured. */
  use: ProductionRow[];
}

export type DependencyVerdict =
  | "fixed"
  | "input"
  | "free-changes-omega"
  | "free-same-omega"
  | "spec-contradicts";

export interface DependencyRow {
  id: string;
  specifiedBy: string;
  omegaChanges: boolean;
  verdict: DependencyVerdict;
  detail: string;
}

export type ProductionStatus = "works" | "local" | "absent" | "disagrees";

export interface ProductionRow {
  id: string;
  status: ProductionStatus;
  detail: string;
}
