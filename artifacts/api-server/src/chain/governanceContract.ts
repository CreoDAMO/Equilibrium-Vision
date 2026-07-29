// ── Governance WASM Contract Bridge ──────────────────────────────────────────
//
// Deploys and calls the on-chain governance WASM contract
// (contracts/governance/src/lib.rs). The WASM contract is the authoritative
// source for proposals stored on-chain; the TypeScript GovernanceModule in
// governance.ts handles the off-chain REST API layer.
//
// The key integration point is gov_pending_param:{name} storage entries written
// by execute_proposal() — the TS processBlock bridge in state.ts polls these
// and applies them to live ChainParameters.
//
// Method IDs (must match the contract's call() dispatch table):
//   0 submit_proposal  1 vote          2 end_voting
//   3 execute_proposal 4 deposit       5 cancel_proposal
//   6 get_proposal     7 get_vote      8 get_capabilities

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { WasmVM } from "./wasm.js";
import { logger } from "../lib/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveContractArtifact(...segments: string[]): string {
  const candidates = [
    join(__dirname, "..", "..", "..", "contracts", ...segments),
    join(__dirname, "..", "..", "..", "..", "contracts", ...segments),
    resolve(process.cwd(), "..", "..", "contracts", ...segments),
    resolve(process.cwd(), "contracts", ...segments),
  ];
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!;
}

export const GOVERNANCE_CONTRACT_METHOD = {
  SUBMIT_PROPOSAL:  0,
  VOTE:             1,
  END_VOTING:       2,
  EXECUTE_PROPOSAL: 3,
  DEPOSIT:          4,
  CANCEL_PROPOSAL:  5,
  GET_PROPOSAL:     6,
  GET_VOTE:         7,
  GET_CAPABILITIES: 8,
} as const;

// ── Typed result interfaces ───────────────────────────────────────────────────

export interface GovProposalRecord {
  id: number;
  proposer: string;
  title: string;
  desc: string;
  /** 0=proposed 1=voting 2=passed 3=failed 4=executed 5=cancelled */
  status: number;
  deposit: number;
  votingStart: number;
  votingEnd: number;
  yes: number;
  no: number;
  abstain: number;
  executed: number;
  msgCount: number;
}

export interface GovVoteRecord {
  proposalId: number;
  voter: string;
  /** 0=no vote, 1=yes, 2=no, 3=abstain */
  option: number;
  power: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function i64ToWords(value: bigint): [number, number] {
  const masked = BigInt.asUintN(64, value);
  const lo = Number(masked & 0xffffffffn);
  let hi = Number((masked >> 32n) & 0xffffffffn);
  if (hi > 0x7fffffff) hi -= 0x100000000;
  return [lo | 0, hi | 0];
}

function stringToWords(str: string, maxBytes: number): number[] {
  const bytes = new TextEncoder().encode(str);
  if (bytes.length > maxBytes) {
    throw new Error(`String too long: ${bytes.length} bytes (max ${maxBytes})`);
  }
  const words: number[] = [];
  for (let i = 0; i < bytes.length; i += 4) {
    let w = 0;
    for (let b = 0; b < 4; b++) w |= (bytes[i + b] ?? 0) << (b * 8);
    words.push(w);
  }
  return words;
}

function addrToWords(addr: string): number[] {
  const bytes = new TextEncoder().encode(addr.padEnd(40, "\0"));
  const words: number[] = [];
  for (let i = 0; i < 40; i += 4) {
    let w = 0;
    for (let b = 0; b < 4; b++) w |= (bytes[i + b] ?? 0) << (b * 8);
    words.push(w);
  }
  return words;
}

// ── Deploy ────────────────────────────────────────────────────────────────────

let cachedAddress: string | undefined;

export function getGovernanceContractAddress(): string | undefined {
  return process.env["GOVERNANCE_CONTRACT_ADDRESS"] || cachedAddress;
}

export async function deployGovernanceContractIfNeeded(
  wasmVM: WasmVM,
  deployer: string,
): Promise<string | undefined> {
  const existing = getGovernanceContractAddress();
  if (existing) {
    logger.info({ address: existing }, "Governance contract configured via env");
    return existing;
  }
  const hexPath = resolveContractArtifact("governance", "governance.hex");
  if (!existsSync(hexPath)) {
    logger.debug({ hexPath }, "Governance WASM bytecode not found — skipping auto-deploy");
    return undefined;
  }
  const bytecodeHex = readFileSync(hexPath, "utf-8").trim();
  const { address, error } = await wasmVM.deploy(deployer, bytecodeHex, {
    functions: [
      { name: "submitProposal",  methodId: GOVERNANCE_CONTRACT_METHOD.SUBMIT_PROPOSAL,  inputs: [], outputs: ["i32"] },
      { name: "vote",            methodId: GOVERNANCE_CONTRACT_METHOD.VOTE,            inputs: ["i64", "u8"], outputs: ["i32"] },
      { name: "endVoting",       methodId: GOVERNANCE_CONTRACT_METHOD.END_VOTING,       inputs: ["i64"], outputs: ["i32"] },
      { name: "executeProposal", methodId: GOVERNANCE_CONTRACT_METHOD.EXECUTE_PROPOSAL, inputs: ["i64"], outputs: ["i32"] },
      { name: "deposit",         methodId: GOVERNANCE_CONTRACT_METHOD.DEPOSIT,         inputs: ["i64", "i64"], outputs: ["i32"] },
      { name: "cancelProposal",  methodId: GOVERNANCE_CONTRACT_METHOD.CANCEL_PROPOSAL,  inputs: ["i64"], outputs: ["i32"] },
      { name: "getProposal",     methodId: GOVERNANCE_CONTRACT_METHOD.GET_PROPOSAL,     inputs: ["i64"], outputs: ["i32"] },
      { name: "getVote",         methodId: GOVERNANCE_CONTRACT_METHOD.GET_VOTE,         inputs: ["i64", "string"], outputs: ["i32"] },
      { name: "getCapabilities", methodId: GOVERNANCE_CONTRACT_METHOD.GET_CAPABILITIES, inputs: [], outputs: ["i32"] },
    ],
  });
  if (error || !address) {
    logger.error({ error }, "Failed to deploy Governance WASM contract");
    return undefined;
  }
  cachedAddress = address;
  logger.info({ address }, "Governance WASM contract deployed");
  return address;
}

// ── Proposal message types ────────────────────────────────────────────────────

export interface GovParamMessage {
  type: "gov_param";
  paramName: string;
  value: number;
}

export interface TreasurySpendMessage {
  type: "treasury_spend";
  recipient: string; // 40-hex address
  amount: number;
}

export interface ContractCallMessage {
  type: "contract_call";
  contractAddress: string; // 40-hex address
  methodId: number;
  args: number[];
}

export type GovernanceMessage = GovParamMessage | TreasurySpendMessage | ContractCallMessage;

function encodeMessage(msg: GovernanceMessage): string {
  if (msg.type === "gov_param")       return `0,${msg.paramName},${msg.value}`;
  if (msg.type === "treasury_spend")  return `1,${msg.recipient},${msg.amount}`;
  if (msg.type === "contract_call") {
    const args = msg.args.join(",");
    return `2,${msg.contractAddress},${msg.methodId}${args ? "," + args : ""}`;
  }
  throw new Error("Unknown message type");
}

// ── Submit / vote / lifecycle ─────────────────────────────────────────────────

export interface SubmitProposalParams {
  title: string;
  description: string;
  deposit: number;
  messages: GovernanceMessage[];
}

export interface SubmitProposalResult { success: boolean; proposalId?: number; error?: string }

export async function submitProposalToContract(
  wasmVM: WasmVM,
  caller: string,
  p: SubmitProposalParams,
): Promise<SubmitProposalResult> {
  const address = getGovernanceContractAddress();
  if (!address) return { success: false, error: "Governance contract not deployed" };
  if (p.messages.length > 16) return { success: false, error: "Max 16 messages per proposal" };

  const titleWords = stringToWords(p.title, 128);
  const descWords  = stringToWords(p.description, 512);

  const msgWords: number[] = [];
  for (const msg of p.messages) {
    const encoded = encodeMessage(msg);
    const bytes = new TextEncoder().encode(encoded);
    msgWords.push(bytes.length);
    for (let i = 0; i < bytes.length; i += 4) {
      let w = 0;
      for (let b = 0; b < 4; b++) w |= (bytes[i + b] ?? 0) << (b * 8);
      msgWords.push(w);
    }
  }

  const args = [
    titleWords.length * 4,
    ...titleWords,
    descWords.length * 4,
    ...descWords,
    ...i64ToWords(BigInt(Math.floor(p.deposit))),
    p.messages.length,
    ...msgWords,
  ];

  const res = await wasmVM.call(address, GOVERNANCE_CONTRACT_METHOD.SUBMIT_PROPOSAL, args, undefined, caller);
  if (!res.success || res.returnValue === null || res.returnValue < 0) {
    const messages: Record<number, string> = {
      [-1]: "Deposit below minimum",
      [-2]: "Insufficient balance for deposit",
      [-4]: "Too many messages (max 16)",
    };
    return {
      success: false,
      error: res.error ?? messages[res.returnValue ?? -1] ?? `submit_proposal() returned ${res.returnValue}`,
    };
  }
  return { success: true, proposalId: res.returnValue };
}

export interface VoteResult { success: boolean; error?: string }

export async function voteOnContract(
  wasmVM: WasmVM,
  caller: string,
  proposalId: number,
  option: "yes" | "no" | "abstain",
): Promise<VoteResult> {
  const address = getGovernanceContractAddress();
  if (!address) return { success: false, error: "Governance contract not deployed" };

  const optNum = option === "yes" ? 1 : option === "no" ? 2 : 3;
  const args = [...i64ToWords(BigInt(proposalId)), optNum];

  const res = await wasmVM.call(address, GOVERNANCE_CONTRACT_METHOD.VOTE, args, undefined, caller);
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };

  const errs: Record<number, string> = {
    [-1]: "Unknown proposal",
    [-2]: "Voting not open",
    [-3]: "No voting power",
    [-4]: "Invalid vote option",
  };
  if (res.returnValue < 0) return { success: false, error: errs[res.returnValue] ?? `vote() returned ${res.returnValue}` };
  if (res.returnValue === 0) return { success: false, error: "Already voted" };
  return { success: true };
}

export interface EndVotingResult { success: boolean; outcome?: "passed" | "failed"; error?: string }

export async function endVotingOnContract(
  wasmVM: WasmVM,
  caller: string,
  proposalId: number,
): Promise<EndVotingResult> {
  const address = getGovernanceContractAddress();
  if (!address) return { success: false, error: "Governance contract not deployed" };

  const res = await wasmVM.call(
    address, GOVERNANCE_CONTRACT_METHOD.END_VOTING,
    [...i64ToWords(BigInt(proposalId))], undefined, caller,
  );
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };
  if (res.returnValue < 0) return { success: false, error: `end_voting() returned ${res.returnValue}` };
  if (res.returnValue === 0) return { success: false, error: "Voting not yet ended" };
  return { success: true, outcome: res.returnValue === 2 ? "passed" : "failed" };
}

// Legacy wrapper kept for state.ts compatibility.
export async function endVoting(wasmVM: WasmVM, caller: string, proposalId: number): Promise<number> {
  const address = getGovernanceContractAddress();
  if (!address) return -99;
  const res = await wasmVM.call(
    address, GOVERNANCE_CONTRACT_METHOD.END_VOTING,
    [...i64ToWords(BigInt(proposalId))], undefined, caller,
  );
  return res.returnValue ?? -99;
}

export interface ExecuteResult { success: boolean; error?: string }

export async function executeProposalOnContract(
  wasmVM: WasmVM,
  caller: string,
  proposalId: number,
): Promise<ExecuteResult> {
  const address = getGovernanceContractAddress();
  if (!address) return { success: false, error: "Governance contract not deployed" };

  const res = await wasmVM.call(
    address, GOVERNANCE_CONTRACT_METHOD.EXECUTE_PROPOSAL,
    [...i64ToWords(BigInt(proposalId))], undefined, caller,
  );
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };

  const errs: Record<number, string> = {
    [-1]: "Unknown proposal",
    [-2]: "Already executed",
    [-3]: "Execution failed",
  };
  if (res.returnValue < 0) return { success: false, error: errs[res.returnValue] ?? `execute_proposal() returned ${res.returnValue}` };
  if (res.returnValue === 0) return { success: false, error: "Proposal not passed" };
  return { success: true };
}

// Legacy wrapper kept for compatibility.
export async function executeProposal(wasmVM: WasmVM, caller: string, proposalId: number): Promise<number> {
  const address = getGovernanceContractAddress();
  if (!address) return -99;
  const res = await wasmVM.call(
    address, GOVERNANCE_CONTRACT_METHOD.EXECUTE_PROPOSAL,
    [...i64ToWords(BigInt(proposalId))], undefined, caller,
  );
  return res.returnValue ?? -99;
}

export interface CancelResult { success: boolean; error?: string }

export async function cancelProposalOnContract(
  wasmVM: WasmVM,
  caller: string,
  proposalId: number,
): Promise<CancelResult> {
  const address = getGovernanceContractAddress();
  if (!address) return { success: false, error: "Governance contract not deployed" };

  const res = await wasmVM.call(
    address, GOVERNANCE_CONTRACT_METHOD.CANCEL_PROPOSAL,
    [...i64ToWords(BigInt(proposalId))], undefined, caller,
  );
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };

  const errs: Record<number, string> = {
    [-1]: "Unknown proposal",
    [-2]: "Already active (passed/failed/executed)",
  };
  if (res.returnValue < 0) return { success: false, error: errs[res.returnValue] ?? `cancel_proposal() returned ${res.returnValue}` };
  if (res.returnValue === 0) return { success: false, error: "Not the proposer" };
  return { success: true };
}

// ── Contract JSON normalizers ─────────────────────────────────────────────────
// The WASM contracts emit snake_case JSON; these mappers convert to the
// camelCase domain interfaces used by the TypeScript layer.

/** Raw proposal JSON emitted by contracts/governance/src/lib.rs get_proposal() */
interface RawProposal {
  id: number;
  proposer: string;
  title: string;
  desc: string;          // ← "description" in ProposalInfo
  status: number;
  deposit: number;
  voting_start: number;  // ← "votingStart"
  voting_end: number;    // ← "votingEnd"
  yes: number;
  no: number;
  abstain: number;
  executed: number;
  msg_count: number;     // ← "msgCount"
}

/** Raw vote JSON emitted by contracts/governance/src/lib.rs get_vote() */
interface RawVote {
  proposal_id: number;
  voter: string;
  option: number;
  power: number;
}

function normalizeProposal(raw: RawProposal): ProposalInfo {
  return {
    id:          raw.id,
    proposer:    raw.proposer,
    title:       raw.title,
    description: raw.desc,
    status:      raw.status,
    deposit:     raw.deposit,
    votingStart: raw.voting_start,
    votingEnd:   raw.voting_end,
    yes:         raw.yes,
    no:          raw.no,
    abstain:     raw.abstain,
    executed:    raw.executed,
    msgCount:    raw.msg_count,
  };
}

// ── Queries ───────────────────────────────────────────────────────────────────

export interface ProposalInfo {
  id: number;
  proposer: string;
  title: string;
  description: string;   // normalized from contract's "desc"
  status: number;
  deposit: number;
  votingStart: number;   // normalized from contract's "voting_start"
  votingEnd: number;     // normalized from contract's "voting_end"
  yes: number;
  no: number;
  abstain: number;
  executed: number;
  msgCount: number;      // normalized from contract's "msg_count"
}

export async function getProposalFromContract(
  wasmVM: WasmVM,
  proposalId: number,
): Promise<ProposalInfo | null> {
  const address = getGovernanceContractAddress();
  if (!address) return null;

  const res = await wasmVM.call(address, GOVERNANCE_CONTRACT_METHOD.GET_PROPOSAL, [...i64ToWords(BigInt(proposalId))]);
  if (!res.success || res.returnValue !== 1) return null;

  const storage = wasmVM.getStorage(address);
  const raw = storage["query_result"];
  if (!raw) return null;
  try {
    return normalizeProposal(JSON.parse(raw) as RawProposal);
  } catch {
    return null;
  }
}

// Legacy alias — GovProposalRecord uses "desc" (the contract's native field name).
export async function getProposal(
  wasmVM: WasmVM,
  proposalId: number,
): Promise<GovProposalRecord | undefined> {
  const address = getGovernanceContractAddress();
  if (!address) return undefined;

  const res = await wasmVM.call(address, GOVERNANCE_CONTRACT_METHOD.GET_PROPOSAL, [...i64ToWords(BigInt(proposalId))]);
  if (!res.success || res.returnValue !== 1) return undefined;

  const storage = wasmVM.getStorage(address);
  const raw = storage["query_result"];
  if (!raw) return undefined;
  try {
    // GovProposalRecord matches the raw contract shape, so no camelCase mapping needed.
    const r = JSON.parse(raw) as RawProposal;
    return {
      id:           r.id,
      proposer:     r.proposer,
      title:        r.title,
      desc:         r.desc,
      status:       r.status,
      deposit:      r.deposit,
      votingStart:  r.voting_start,
      votingEnd:    r.voting_end,
      yes:          r.yes,
      no:           r.no,
      abstain:      r.abstain,
      executed:     r.executed,
      msgCount:     r.msg_count,
    };
  } catch {
    return undefined;
  }
}

export async function getVoteFromContract(
  wasmVM: WasmVM,
  proposalId: number,
  voter: string,
): Promise<{ option: number; power: number } | null> {
  const address = getGovernanceContractAddress();
  if (!address) return null;

  const voterWords = addrToWords(voter);
  const args = [...i64ToWords(BigInt(proposalId)), ...voterWords];

  const res = await wasmVM.call(address, GOVERNANCE_CONTRACT_METHOD.GET_VOTE, args);
  if (!res.success || res.returnValue !== 1) return null;

  const storage = wasmVM.getStorage(address);
  const raw = storage["query_result"];
  if (!raw) return null;
  try {
    // Contract emits: {"proposal_id":N,"voter":"...","option":N,"power":N}
    const r = JSON.parse(raw) as RawVote;
    return { option: r.option, power: r.power };
  } catch {
    return null;
  }
}

// ── Pending parameter bridge ──────────────────────────────────────────────────

/**
 * Scan the governance contract storage for pending parameter changes
 * (keys matching `gov_pending_param:*`) and return them as a map.
 * Does NOT clear the keys — call clearPendingGovParams() after applying.
 */
export function scanPendingGovParams(wasmVM: WasmVM): Record<string, number> {
  const address = getGovernanceContractAddress();
  if (!address) return {};

  const storage = wasmVM.getStorage(address);
  const params: Record<string, number> = {};
  for (const [key, value] of Object.entries(storage)) {
    if (key.startsWith("gov_pending_param:")) {
      const paramName = key.slice("gov_pending_param:".length);
      const num = Number(value);
      if (!Number.isNaN(num)) params[paramName] = num;
    }
  }
  return params;
}

/**
 * Clear all gov_pending_param:* keys from governance contract storage
 * after they have been applied by the TypeScript layer.
 */
export function clearPendingGovParams(wasmVM: WasmVM): void {
  const address = getGovernanceContractAddress();
  if (!address) return;

  const storage = wasmVM.getStorage(address);
  for (const key of Object.keys(storage)) {
    if (key.startsWith("gov_pending_param:")) {
      delete (storage as Record<string, string>)[key];
    }
  }
}

/**
 * Atomically scan + clear gov_pending_param:* entries.
 * Called by state.ts processBlock bridge. Returns a map of paramName → value.
 */
export function drainPendingParamUpdates(wasmVM: WasmVM): Record<string, number> {
  const params = scanPendingGovParams(wasmVM);
  if (Object.keys(params).length > 0) clearPendingGovParams(wasmVM);
  return params;
}
