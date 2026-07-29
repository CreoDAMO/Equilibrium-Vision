import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { WasmVM } from "./wasm.js";
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

const METHOD = {
  SUBMIT_PROPOSAL: 0,
  VOTE: 1,
  END_VOTING: 2,
  EXECUTE_PROPOSAL: 3,
  DEPOSIT: 4,
  CANCEL_PROPOSAL: 5,
  GET_PROPOSAL: 6,
  GET_VOTE: 7,
  GET_CAPABILITIES: 8,
} as const;

function loadGovernanceWasmHex(): string {
  const hexPath = resolveContractArtifact("governance", "governance.hex");
  return readFileSync(hexPath, "utf-8").trim();
}

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

let cachedAddress: string | undefined;

export function getGovernanceContractAddress(): string | undefined {
  return process.env["GOVERNANCE_CONTRACT_ADDRESS"] || cachedAddress;
}

export async function deployGovernanceContractIfNeeded(wasmVM: WasmVM, deployer: string): Promise<string | undefined> {
  const existing = getGovernanceContractAddress();
  if (existing) {
    logger.info({ address: existing }, "Governance contract configured via env");
    return existing;
  }
  const bytecodeHex = loadGovernanceWasmHex();
  const { address, error } = await wasmVM.deploy(deployer, bytecodeHex, {
    functions: [
      { name: "submitProposal", methodId: METHOD.SUBMIT_PROPOSAL, inputs: [], outputs: ["i32"] },
      { name: "vote", methodId: METHOD.VOTE, inputs: ["i64", "u8"], outputs: ["i32"] },
      { name: "endVoting", methodId: METHOD.END_VOTING, inputs: ["i64"], outputs: ["i32"] },
      { name: "executeProposal", methodId: METHOD.EXECUTE_PROPOSAL, inputs: ["i64"], outputs: ["i32"] },
      { name: "deposit", methodId: METHOD.DEPOSIT, inputs: ["i64", "i64"], outputs: ["i32"] },
      { name: "cancelProposal", methodId: METHOD.CANCEL_PROPOSAL, inputs: ["i64"], outputs: ["i32"] },
      { name: "getProposal", methodId: METHOD.GET_PROPOSAL, inputs: ["i64"], outputs: ["i32"] },
      { name: "getVote", methodId: METHOD.GET_VOTE, inputs: ["i64", "string"], outputs: ["i32"] },
      { name: "getCapabilities", methodId: METHOD.GET_CAPABILITIES, inputs: [], outputs: ["i32"] },
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

// ── Proposal message builders ────────────────────────────────────────────────

export interface GovParamMessage {
  type: "gov_param";
  paramName: string;
  value: number; // raw integer (not scaled)
}

export interface TreasurySpendMessage {
  type: "treasury_spend";
  recipient: string; // 40-hex address
  amount: number; // base units
}

export interface ContractCallMessage {
  type: "contract_call";
  contractAddress: string; // 40-hex address
  methodId: number;
  args: number[]; // i32 words
}

export type GovernanceMessage = GovParamMessage | TreasurySpendMessage | ContractCallMessage;

function encodeMessage(msg: GovernanceMessage): string {
  if (msg.type === "gov_param") {
    return `0,${msg.paramName},${msg.value}`;
  }
  if (msg.type === "treasury_spend") {
    return `1,${msg.recipient},${msg.amount}`;
  }
  if (msg.type === "contract_call") {
    const args = msg.args.join(",");
    return `2,${msg.contractAddress},${msg.methodId}${args ? "," + args : ""}`;
  }
  throw new Error(`Unknown message type`);
}

// ── Contract calls ───────────────────────────────────────────────────────────

export interface SubmitProposalParams {
  title: string;
  description: string;
  deposit: number; // base units, must be >= govMinDeposit
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
  const descWords = stringToWords(p.description, 512);

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

  const res = await wasmVM.call(address, METHOD.SUBMIT_PROPOSAL, args, undefined, caller);
  if (!res.success || res.returnValue === null || res.returnValue < 0) {
    const messages: Record<number, string> = {
      [-1]: "Deposit below minimum",
      [-2]: "Insufficient balance for deposit",
      [-4]: "Too many messages (max 16)",
    };
    return { success: false, error: res.error ?? messages[res.returnValue ?? -1] ?? `submit_proposal() returned ${res.returnValue}` };
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

  const res = await wasmVM.call(address, METHOD.VOTE, args, undefined, caller);
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };

  const messages: Record<number, string> = {
    [-1]: "Unknown proposal",
    [-2]: "Voting not open",
    [-3]: "No voting power",
    [-4]: "Invalid vote option",
  };
  if (res.returnValue < 0) return { success: false, error: messages[res.returnValue] ?? `vote() returned ${res.returnValue}` };
  if (res.returnValue === 0) return { success: false, error: "Already voted" };
  return { success: true };
}

export interface EndVotingResult { success: boolean; outcome?: "passed" | "failed"; error?: string }

export async function endVotingOnContract(wasmVM: WasmVM, caller: string, proposalId: number): Promise<EndVotingResult> {
  const address = getGovernanceContractAddress();
  if (!address) return { success: false, error: "Governance contract not deployed" };

  const res = await wasmVM.call(address, METHOD.END_VOTING, [...i64ToWords(BigInt(proposalId))], undefined, caller);
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };

  const messages: Record<number, string> = { [-1]: "Unknown proposal" };
  if (res.returnValue < 0) return { success: false, error: messages[res.returnValue] ?? `end_voting() returned ${res.returnValue}` };
  if (res.returnValue === 0) return { success: false, error: "Voting not yet ended" };

  return { success: true, outcome: res.returnValue === 2 ? "passed" : "failed" };
}

export interface ExecuteResult { success: boolean; error?: string }

export async function executeProposalOnContract(wasmVM: WasmVM, caller: string, proposalId: number): Promise<ExecuteResult> {
  const address = getGovernanceContractAddress();
  if (!address) return { success: false, error: "Governance contract not deployed" };

  const res = await wasmVM.call(address, METHOD.EXECUTE_PROPOSAL, [...i64ToWords(BigInt(proposalId))], undefined, caller);
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };

  const messages: Record<number, string> = {
    [-1]: "Unknown proposal",
    [-2]: "Already executed",
    [-3]: "Execution failed",
  };
  if (res.returnValue < 0) return { success: false, error: messages[res.returnValue] ?? `execute_proposal() returned ${res.returnValue}` };
  if (res.returnValue === 0) return { success: false, error: "Proposal not passed" };
  return { success: true };
}

export interface CancelResult { success: boolean; error?: string }

export async function cancelProposalOnContract(wasmVM: WasmVM, caller: string, proposalId: number): Promise<CancelResult> {
  const address = getGovernanceContractAddress();
  if (!address) return { success: false, error: "Governance contract not deployed" };

  const res = await wasmVM.call(address, METHOD.CANCEL_PROPOSAL, [...i64ToWords(BigInt(proposalId))], undefined, caller);
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };

  const messages: Record<number, string> = {
    [-1]: "Unknown proposal",
    [-2]: "Already active (passed/failed/executed)",
  };
  if (res.returnValue < 0) return { success: false, error: messages[res.returnValue] ?? `cancel_proposal() returned ${res.returnValue}` };
  if (res.returnValue === 0) return { success: false, error: "Not the proposer" };
  return { success: true };
}

export interface ProposalInfo {
  id: number;
  proposer: string;
  title: string;
  description: string;
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

export async function getProposalFromContract(wasmVM: WasmVM, proposalId: number): Promise<ProposalInfo | null> {
  const address = getGovernanceContractAddress();
  if (!address) return null;

  const res = await wasmVM.call(address, METHOD.GET_PROPOSAL, [...i64ToWords(BigInt(proposalId))]);
  if (!res.success || res.returnValue !== 1) return null;

  const storage = wasmVM.getStorage(address);
  const raw = storage["query_result"];
  if (!raw) return null;

  try {
    const p = JSON.parse(raw) as ProposalInfo;
    return p;
  } catch {
    return null;
  }
}

export async function getVoteFromContract(wasmVM: WasmVM, proposalId: number, voter: string): Promise<{ option: number; power: number } | null> {
  const address = getGovernanceContractAddress();
  if (!address) return null;

  const voterWords = addrToWords(voter);
  const args = [...i64ToWords(BigInt(proposalId)), ...voterWords];

  const res = await wasmVM.call(address, METHOD.GET_VOTE, args);
  if (!res.success || res.returnValue !== 1) return null;

  const storage = wasmVM.getStorage(address);
  const raw = storage["query_result"];
  if (!raw) return null;

  try {
    const v = JSON.parse(raw) as { option: number; power: number };
    return v;
  } catch {
    return null;
  }
}

// ── Pending parameter bridge ─────────────────────────────────────────────────

/**
 * Scan the governance contract storage for pending parameter changes
 * (keys matching `gov_pending_param:*`) and return them as a map.
 * The TypeScript GovernanceModule calls this at processBlock() time
 * to apply on-chain parameter changes from WASM governance proposals.
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
      if (!Number.isNaN(num)) {
        params[paramName] = num;
      }
    }
  }
  return params;
}

/**
 * Clear pending parameter keys from governance contract storage after
 * they've been applied by the TypeScript layer.
 */
export function clearPendingGovParams(wasmVM: WasmVM): void {
  const address = getGovernanceContractAddress();
  if (!address) return;

  const storage = wasmVM.getStorage(address);
  for (const key of Object.keys(storage)) {
    if (key.startsWith("gov_pending_param:")) {
      delete storage[key];
    }
  }
}
