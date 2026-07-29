// ── Staking WASM Contract Bridge ──────────────────────────────────────────────
//
// Deploys and calls the on-chain staking WASM contract
// (contracts/staking/src/lib.rs). The WASM contract is the authoritative
// source for validator registration, delegation, inflation, slashing, and
// active-set rotation. The TypeScript layer in state.ts maintains a parallel
// in-memory mirror used for fast queries; these helpers sync the two.
//
// Method IDs (must match the contract's call() dispatch table):
//   0 register           1 delegate         2 undelegate
//   3 complete_undelegate 4 claim_rewards    5 distribute_epoch
//   6 slash              7 unjail           8 update_commission
//   9 get_active_set     10 get_validator_info
//   11 get_delegation_info 12 get_capabilities

import type { WasmVM } from "./wasm.js";

export const STAKING_CONTRACT_METHOD = {
  REGISTER:              0,
  DELEGATE:              1,
  UNDELEGATE:            2,
  COMPLETE_UNDELEGATE:   3,
  CLAIM_REWARDS:         4,
  DISTRIBUTE_EPOCH:      5,
  SLASH:                 6,
  UNJAIL:                7,
  UPDATE_COMMISSION:     8,
  GET_ACTIVE_SET:        9,
  GET_VALIDATOR_INFO:   10,
  GET_DELEGATION_INFO:  11,
  GET_CAPABILITIES:     12,
} as const;

/** Slash type constants matching the WASM contract. */
export const SLASH_TYPE = {
  DOUBLE_SIGN:  0,
  DOWNTIME:     1,
  LIGHT_CLIENT: 2,
} as const;

export function getStakingContractAddress(): string | undefined {
  return process.env["STAKING_CONTRACT_ADDRESS"];
}

// ── Typed result interfaces ───────────────────────────────────────────────────

export interface ValidatorInfoRecord {
  addr: string;
  commission_fp: number;
  self_bond: number;
  total_delegated: number;
  /** 0=inactive 1=active 2=jailed 3=tombstoned */
  status: number;
  moniker: string;
}

export interface DelegationInfoRecord {
  validator_id: number;
  amount: number;
  reward_debt: number;
  pending_rewards: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function addrToWords(addr: string): number[] {
  const buf = Buffer.alloc(40, 0);
  buf.write(addr, "utf8");
  const words: number[] = [];
  for (let i = 0; i < 40; i += 4) words.push(buf.readInt32LE(i));
  return words;
}

function i64ToWords(val: number): [number, number] {
  // Split a JS safe integer into two i32 LE words (lo, hi).
  const lo = val & 0xFFFFFFFF;
  const hi = Math.floor(val / 0x100000000);
  return [lo, hi];
}

// ── Contract calls ────────────────────────────────────────────────────────────

/**
 * Register a new validator. Returns validator_id (>=0) or negative error code.
 *   -1 commission > 100%
 *   -2 moniker too long
 *   -3 insufficient balance for self-bond
 */
export async function registerValidator(
  wasmVM: WasmVM,
  caller: string,
  commissionBp: number,
  moniker: string,
): Promise<number> {
  const address = getStakingContractAddress();
  if (!address) return -99;
  const monikerBuf = Buffer.from(moniker.slice(0, 64), "utf8");
  const monikerWords: number[] = [];
  for (let i = 0; i < monikerBuf.length; i += 4) {
    let w = 0;
    for (let b = 0; b < 4 && i + b < monikerBuf.length; b++) {
      w |= (monikerBuf[i + b]! << (b * 8));
    }
    monikerWords.push(w);
  }
  const args = [commissionBp, monikerBuf.length, ...monikerWords];
  const res = await wasmVM.call(address, STAKING_CONTRACT_METHOD.REGISTER, args, undefined, caller);
  return res.returnValue ?? -99;
}

/**
 * Delegate tokens to a validator. Returns 1 on success or negative error.
 *   -1 unknown validator  -2 insufficient balance  -3 below minimum
 */
export async function delegate(
  wasmVM: WasmVM,
  caller: string,
  validatorId: number,
  amount: number,
): Promise<number> {
  const address = getStakingContractAddress();
  if (!address) return -99;
  const [vidLo, vidHi] = i64ToWords(validatorId);
  const [amtLo, amtHi] = i64ToWords(amount);
  const res = await wasmVM.call(
    address, STAKING_CONTRACT_METHOD.DELEGATE,
    [vidLo, vidHi, amtLo, amtHi], undefined, caller,
  );
  return res.returnValue ?? -99;
}

/**
 * Trigger epoch reward distribution (permissionless). Returns distributed
 * amount or 0 if epoch not yet elapsed.
 */
export async function distributeEpoch(
  wasmVM: WasmVM,
  caller: string,
): Promise<number> {
  const address = getStakingContractAddress();
  if (!address) return 0;
  const res = await wasmVM.call(address, STAKING_CONTRACT_METHOD.DISTRIBUTE_EPOCH, [], undefined, caller);
  return res.returnValue ?? 0;
}

/**
 * Slash a validator for a given offence type. Returns slashed amount or
 * negative error code.
 */
export async function slashValidator(
  wasmVM: WasmVM,
  caller: string,
  validatorId: number,
  slashType: number,
  evidenceHashHex: string,
): Promise<number> {
  const address = getStakingContractAddress();
  if (!address) return -99;
  const [vidLo, vidHi] = i64ToWords(validatorId);
  const evidenceBuf = Buffer.from(evidenceHashHex.padEnd(64, "0").slice(0, 64), "hex");
  const evidenceWords: number[] = [];
  for (let i = 0; i < 32; i += 4) evidenceWords.push(evidenceBuf.readInt32LE(i));
  const args = [vidLo, vidHi, slashType, ...evidenceWords];
  const res = await wasmVM.call(address, STAKING_CONTRACT_METHOD.SLASH, args, undefined, caller);
  return res.returnValue ?? -99;
}

/**
 * Query validator info by integer ID. Returns parsed record or undefined.
 */
export async function getValidatorInfo(
  wasmVM: WasmVM,
  validatorId: number,
): Promise<ValidatorInfoRecord | undefined> {
  const address = getStakingContractAddress();
  if (!address) return undefined;
  const [lo, hi] = i64ToWords(validatorId);
  const res = await wasmVM.call(address, STAKING_CONTRACT_METHOD.GET_VALIDATOR_INFO, [lo, hi]);
  if (!res.success || res.returnValue !== 1) return undefined;
  try {
    const storage = wasmVM.getStorage(address);
    return JSON.parse(storage["query_result"] ?? "") as ValidatorInfoRecord;
  } catch {
    return undefined;
  }
}

/**
 * Query delegation info for a delegator + validator pair.
 */
export async function getDelegationInfo(
  wasmVM: WasmVM,
  delegatorAddr: string,
  validatorId: number,
): Promise<DelegationInfoRecord | undefined> {
  const address = getStakingContractAddress();
  if (!address) return undefined;
  const addrWords = addrToWords(delegatorAddr);
  const [vidLo, vidHi] = i64ToWords(validatorId);
  const args = [...addrWords, vidLo, vidHi];
  const res = await wasmVM.call(address, STAKING_CONTRACT_METHOD.GET_DELEGATION_INFO, args);
  if (!res.success || res.returnValue !== 1) return undefined;
  try {
    const storage = wasmVM.getStorage(address);
    return JSON.parse(storage["query_result"] ?? "") as DelegationInfoRecord;
  } catch {
    return undefined;
  }
}
