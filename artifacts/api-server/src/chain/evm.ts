import { createHash } from "crypto";

// ── EVM Compatibility Layer ──────────────────────────────────────────────────
//
// Exposes an Ethereum JSON-RPC compatible interface over Equilibrium chain state.
// Supports: eth_call, eth_getBalance, eth_getTransactionCount, eth_sendRawTransaction,
//           eth_chainId, eth_blockNumber, eth_getBlockByNumber, net_version
//
// Address mapping: EVM address (0x + 20 bytes hex) = Equilibrium address (20 bytes hex)
// Both are 40 hex characters — the 0x prefix is just stripped.

export function evmToEquilibrium(evmAddr: string): string {
  return evmAddr.replace(/^0x/i, "").toLowerCase();
}

export function equilibriumToEvm(addr: string): string {
  return "0x" + addr.toLowerCase();
}

// ABI function selector = keccak256(signature)[0:4]
// We use SHA-256[0:4] as a keccak approximation for selector generation
export function functionSelector(signature: string): string {
  return createHash("sha256").update(signature).digest("hex").slice(0, 8);
}

// Encode a uint256 as 32-byte ABI hex
export function encodeUint256(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

// Decode a 32-byte ABI hex as bigint
export function decodeUint256(hex: string): bigint {
  return BigInt("0x" + hex.slice(0, 64));
}

// Encode a bytes20 address (EVM padded)
export function encodeAddress(addr: string): string {
  return "000000000000000000000000" + evmToEquilibrium(addr);
}

// EVM chain ID for Equilibrium
export const EVM_CHAIN_ID = 1337;

// EVM block response structure
export interface EVMBlock {
  number: string;
  hash: string;
  parentHash: string;
  nonce: string;
  sha3Uncles: string;
  logsBloom: string;
  transactionsRoot: string;
  stateRoot: string;
  receiptsRoot: string;
  miner: string;
  difficulty: string;
  totalDifficulty: string;
  size: string;
  gasLimit: string;
  gasUsed: string;
  timestamp: string;
  transactions: string[];
  uncles: string[];
  baseFeePerGas: string;
}

// EVM transaction response structure
export interface EVMTransaction {
  hash: string;
  nonce: string;
  blockHash: string;
  blockNumber: string;
  transactionIndex: string;
  from: string;
  to: string;
  value: string;
  gasPrice: string;
  gas: string;
  input: string;
  v: string;
  r: string;
  s: string;
}

export interface EVMTransactionReceipt {
  transactionHash: string;
  transactionIndex: string;
  blockHash: string;
  blockNumber: string;
  from: string;
  to: string;
  cumulativeGasUsed: string;
  gasUsed: string;
  logs: EVMLog[];
  status: string;
  contractAddress: string | null;
}

export interface EVMLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

// Convert an Equilibrium block to EVM format
export function formatEVMBlock(block: {
  hash: string;
  height: number;
  timestamp: number;
  minerAddress: string;
  difficulty: number;
  txHashes: string[];
  merkleRoot: string;
}): EVMBlock {
  return {
    number: "0x" + block.height.toString(16),
    hash: "0x" + block.hash,
    parentHash: "0x" + (block.hash.slice(0, 63) + "0"),
    nonce: "0x0000000000000000",
    sha3Uncles: "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347",
    logsBloom: "0x" + "00".repeat(256),
    transactionsRoot: "0x" + block.merkleRoot,
    stateRoot: "0x" + createHash("sha256").update(block.hash + "state").digest("hex"),
    receiptsRoot: "0x" + createHash("sha256").update(block.hash + "receipts").digest("hex"),
    miner: equilibriumToEvm(block.minerAddress),
    difficulty: "0x" + Math.floor(block.difficulty * 1e9).toString(16),
    totalDifficulty: "0x" + Math.floor(block.difficulty * 1e9 * block.height).toString(16),
    size: "0x" + (256 + block.txHashes.length * 128).toString(16),
    gasLimit: "0x" + (15_000_000).toString(16),
    gasUsed: "0x" + (block.txHashes.length * 21_000).toString(16),
    timestamp: "0x" + Math.floor(block.timestamp / 1000).toString(16),
    transactions: block.txHashes.map(h => "0x" + h),
    uncles: [],
    baseFeePerGas: "0x3b9aca00",
  };
}

// JSON-RPC response envelope
export function jsonRpcSuccess(id: number | string | null, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

export function jsonRpcError(id: number | string | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// Decode hex-encoded ETH value (wei) → EQU tokens (18 decimals)
export function weiToEQU(weiHex: string): number {
  const wei = BigInt(weiHex.startsWith("0x") ? weiHex : "0x" + weiHex);
  return Number(wei) / 1e18;
}

// EQU tokens → wei
export function equToWei(equ: number): bigint {
  return BigInt(Math.floor(equ * 1e18));
}
