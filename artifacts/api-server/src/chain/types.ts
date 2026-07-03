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
}
