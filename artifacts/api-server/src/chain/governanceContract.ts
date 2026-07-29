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

import type { WasmVM } from "./wasm.js";

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

export function getGovernanceContractAddress(): string | undefined {
  return process.env["GOVERNANCE_CONTRACT_ADDRESS"];
}

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

function hexToWords32(hex: string): number[] {
  if (hex.length % 8 !== 0) throw new Error(`hexToWords32: hex length must be a multiple of 8, got ${hex.length}`);
  const words: number[] = [];
  for (let i = 0; i < hex.length; i += 8) {
    const bytes = Buffer.from(hex.slice(i, i + 8), "hex");
    words.push(bytes.readInt32LE(0));
  }
  return words;
}

function stringToWords(s: string, byteLen: number): number[] {
  const buf = Buffer.alloc(byteLen, 0);
  buf.write(s, "utf8");
  const words: number[] = [];
  for (let i = 0; i < byteLen; i += 4) words.push(buf.readInt32LE(i));
  return words;
}

function addrToWords(addr: string): number[] {
  return stringToWords(addr, 40);
}

// ── Contract calls ────────────────────────────────────────────────────────────

/**
 * Call end_voting on an open proposal. Returns 2=passed, 1=failed,
 * 0=still open, -1=unknown.
 */
export async function endVoting(
  wasmVM: WasmVM,
  caller: string,
  proposalId: number,
): Promise<number> {
  const address = getGovernanceContractAddress();
  if (!address) return -99;
  const lo = proposalId & 0xFFFFFFFF;
  const hi = (proposalId / 0x100000000) | 0;
  const res = await wasmVM.call(address, GOVERNANCE_CONTRACT_METHOD.END_VOTING, [lo, hi], undefined, caller);
  return res.returnValue ?? -99;
}

/**
 * Call execute_proposal for a passed proposal. Returns 1=success,
 * 0=not passed, -2=already executed, -3=exec failure.
 */
export async function executeProposal(
  wasmVM: WasmVM,
  caller: string,
  proposalId: number,
): Promise<number> {
  const address = getGovernanceContractAddress();
  if (!address) return -99;
  const lo = proposalId & 0xFFFFFFFF;
  const hi = (proposalId / 0x100000000) | 0;
  const res = await wasmVM.call(address, GOVERNANCE_CONTRACT_METHOD.EXECUTE_PROPOSAL, [lo, hi], undefined, caller);
  return res.returnValue ?? -99;
}

/**
 * Read gov_pending_param:{name} entries from the governance contract's storage
 * and return them as a map of paramName → value. Clears each entry after
 * reading so param changes are applied exactly once. Called by state.ts
 * processBlock bridge.
 */
export function drainPendingParamUpdates(wasmVM: WasmVM): Record<string, number> {
  const address = getGovernanceContractAddress();
  if (!address) return {};

  const storage = wasmVM.getStorage(address);
  const pending: Record<string, number> = {};
  const PREFIX = "gov_pending_param:";

  for (const [k, v] of Object.entries(storage)) {
    if (k.startsWith(PREFIX)) {
      const paramName = k.slice(PREFIX.length);
      const value = Number(v);
      if (Number.isFinite(value)) {
        pending[paramName] = value;
        // Clear from storage so it's only applied once.
        delete (storage as Record<string, string>)[k];
      }
    }
  }

  return pending;
}

/**
 * Query a proposal by integer ID. Returns the parsed record or undefined.
 */
export async function getProposal(
  wasmVM: WasmVM,
  proposalId: number,
): Promise<GovProposalRecord | undefined> {
  const address = getGovernanceContractAddress();
  if (!address) return undefined;
  const lo = proposalId & 0xFFFFFFFF;
  const hi = (proposalId / 0x100000000) | 0;
  const res = await wasmVM.call(address, GOVERNANCE_CONTRACT_METHOD.GET_PROPOSAL, [lo, hi]);
  if (!res.success || res.returnValue !== 1) return undefined;
  try {
    const storage = wasmVM.getStorage(address);
    return JSON.parse(storage["query_result"] ?? "") as GovProposalRecord;
  } catch {
    return undefined;
  }
}
