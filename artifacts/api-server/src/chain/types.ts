export interface BlockHeader {
  prevHash: string;
  merkleRoot: string;
  timestamp: number;
  nonce: bigint;
  difficulty: bigint;
  recursionDepth: number;
  residual: number;
}

export interface TxRecord {
  hash: string;
  from: string;
  to: string;
  amount: number;
  fee: number;
  nonce: number;
  blockHash: string | null;
  blockHeight: number | null;
  timestamp: number;
  status: "pending" | "confirmed" | "failed";
  signature?: string;
  publicKey?: string;
}

// ── ZK Proof (Groth16 / BN254) ────────────────────────────────────────────────

export interface ZkG1Point { x: string; y: string; }
export interface ZkG2Point { x: [string, string]; y: [string, string]; }

export interface ZkGroth16Proof {
  pi_a: ZkG1Point;
  pi_b: ZkG2Point;
  pi_c: ZkG1Point;
}

export interface ZkProof {
  proof: ZkGroth16Proof;
  publicInputs: {
    residual: string;
    threshold: string;
    blockHashLow: string;
    blockHashHigh: string;
  };
  vkHash: string;
  valid: boolean;
  provedAt: number;
  circuitId: string;
}

export interface BlockRecord {
  hash: string;
  height: number;
  prevHash: string;
  merkleRoot: string;
  timestamp: number;
  /** Exact u64. A safe integer may still arrive as a number. Above 2^53 it is a bigint. */
  nonce: number | bigint;
  difficulty: number;
  residual: number;
  /** Fixed-point integer: floor(residual × 1e18). Used for deterministic fork-choice
   *  comparisons that are identical across ARM (mobile) and x86 (cloud) nodes.
   *  Optional for backward compatibility; always set on newly mined blocks. */
  residualFp?: number;
  recursionDepth: number;
  coinbaseReward: number;
  miner: string;
  txCount: number;
  /** True only when addBlock installed this block as the canonical successor. */
  canonicalSuccessor?: boolean;
  finalized?: boolean;
  zkProof?: ZkProof;
  /**
   * Header state root. On an evidence-bearing block this is the canonical projection
   * supplied with the block. On an artifacts-native block it is the operational SMT.
   */
  stateRoot?: string;
  /**
   * Artifacts sparse-merkle commitment: accounts, UTXOs, contracts, pools, validator bond.
   * Not EQ-07 stateRootOf. An evidence header does not put this value in stateRoot.
   */
  operationalRoot?: string;
  /**
   * Mempool pressure that entered the residual. Bound by the header hash
   * when the block is sealed. Absent on rows written before identity sealing.
   */
  committedPressure?: number;
  /** When set, addBlock replaces `hash` with canonicalHeaderHash after the state root exists. Replay leaves this unset. */
  sealIdentity?: boolean;
  /**
   * Set together with evidenceRoot. The seal then binds chain id, the evidence
   * root, and the omega digest. Absent on artifacts-native blocks that are not
   * carrying a kernel evidence header.
   */
  chainId?: number;
  evidenceRoot?: string;
  omegaRoot?: string;
  /** Digest of (Ω, I). Present when the successor sealed this block. */
  transitionRoot?: string;
  /**
   * Kernel wasm map carried by an evidence block. Contract storage is not this map.
   * Applied only when the block also binds a canonical state root.
   */
  wasmEntries?: Array<[string, string]>;
  /** Stake, foreign, and wasm inputs. addBlock refuses these. The canonical body replays them. */
  evidence?: import("../../../../site/src/protocol/types.js").TransitionEvidence;
  /** Next-block coupling written by a kernel proposal. Not governance.params. */
  couplingKey?: "hash" | "structural" | "continuity" | "mempool" | "fees";
  couplingValue?: number;
  /**
   * UTXO-model fees credited on the account ledger for this block.
   * Not a second output. Absent after a restart, which reloads the balance
   * and does not rebuild this line.
   */
  utxoFeeCredit?: number;
}

/**
 * Compact block header for light-node / mobile sync.
 * Contains only the fields needed to verify the chain without transaction data.
 */
export interface LightBlockHeader {
  hash: string;
  height: number;
  prevHash: string;
  merkleRoot: string;
  stateRoot: string;
  timestamp: number;
  /** Wire form. A safe u64 is a number. A larger u64 is decimal text. */
  nonce: number | string;
  difficulty: number;
  residual: number;
  residualFp: number;
  recursionDepth: number;
  coinbaseReward: number;
  miner: string;
  txCount: number;
  finalized: boolean;
}

export interface AccountState {
  balance: number;
  nonce: number;
}

export interface PeerRecord {
  peerId: string;
  address: string;
  latencyMs: number;
  height: number;
  connected: boolean;
  syncState?: "synced" | "syncing" | "behind";
}

// ── Validators ─────────────────────────────────────────────────────────────────

export interface ValidatorRecord {
  address: string;
  moniker: string;
  bondedStake: number;
  accumulatedRewards: number;
  slashed: boolean;
  slashCount: number;
  jailed: boolean;
  uptime: number;
  blocksProposed: number;
  blocksVoted: number;
  commission: number;
}

export interface SlashEvent {
  validatorAddress: string;
  reason: "double_sign" | "downtime" | "invalid_block";
  slashAmount: number;
  height: number;
  timestamp: number;
}

// ── Finality (BFT Gadget) ──────────────────────────────────────────────────────

export interface FinalityVote {
  validatorAddress: string;
  blockHash: string;
  height: number;
  signature: string;
  timestamp: number;
}

export interface FinalityRound {
  height: number;
  blockHash: string;
  votes: FinalityVote[];
  finalized: boolean;
  finalizedAt?: number;
  votingPower: number;
  totalVotingPower: number;
}

// ── DEX AMM ───────────────────────────────────────────────────────────────────

export interface DexPool {
  id: string;
  tokenA: string;
  tokenB: string;
  reserveA: number;
  reserveB: number;
  totalLiquidity: number;
  fee: number;
  volumeA: number;
  volumeB: number;
  txCount: number;
  createdAt: number;
}

export interface LiquidityPosition {
  poolId: string;
  provider: string;
  liquidity: number;
  sharePercent: number;
}

export interface SwapEvent {
  poolId: string;
  trader: string;
  amountIn: number;
  amountOut: number;
  tokenIn: string;
  tokenOut: string;
  fee: number;
  timestamp: number;
  txHash: string;
}

// ── Staking ────────────────────────────────────────────────────────────────────

export interface StakeRecord {
  delegator: string;
  validator: string;
  amount: number;
  startHeight: number;
  startTimestamp: number;
  unbonding: boolean;
  unbondingHeight?: number;
  unbondingTimestamp?: number;
  /** Cumulative rewards this delegation has earned and had auto-credited to its ledger balance. */
  rewardsEarned: number;
}

export interface UnbondingEntry {
  delegator: string;
  validator: string;
  amount: number;
  unbondingHeight: number;
  completionHeight: number;
}

// ── Gossip ─────────────────────────────────────────────────────────────────────

export interface GossipEvent {
  id: string;
  type: "tx" | "block" | "vote";
  hash: string;
  fromPeer: string;
  propagatedTo: string[];
  hops: number;
  timestamp: number;
  latencyMs: number;
}
