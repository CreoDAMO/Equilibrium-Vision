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
  nonce: number;
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
  transactions: TxRecord[];
  finalized?: boolean;
  zkProof?: ZkProof;
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
