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
  recursionDepth: number;
  coinbaseReward: number;
  miner: string;
  txCount: number;
  transactions: TxRecord[];
  finalized?: boolean;
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
