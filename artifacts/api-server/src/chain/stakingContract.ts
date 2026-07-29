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
  const bytes = new TextEncoder().encode(addr.padEnd(40, "\0"));
  const words: number[] = [];
  for (let i = 0; i < 40; i += 4) {
    let w = 0;
    for (let b = 0; b < 4; b++) w |= (bytes[i + b] ?? 0) << (b * 8);
    words.push(w);
  }
  return words;
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
  if (bytes.length > maxBytes) throw new Error(`String too long: ${bytes.length} bytes (max ${maxBytes})`);
  const words: number[] = [];
  for (let i = 0; i < bytes.length; i += 4) {
    let w = 0;
    for (let b = 0; b < 4; b++) w |= (bytes[i + b] ?? 0) << (b * 8);
    words.push(w);
  }
  return words;
}

// ── Deploy ────────────────────────────────────────────────────────────────────

let cachedAddress: string | undefined;

export function getStakingContractAddress(): string | undefined {
  return process.env["STAKING_CONTRACT_ADDRESS"] || cachedAddress;
}

export async function deployStakingContractIfNeeded(
  wasmVM: WasmVM,
  deployer: string,
): Promise<string | undefined> {
  const existing = getStakingContractAddress();
  if (existing) {
    logger.info({ address: existing }, "Staking contract configured via env");
    return existing;
  }
  const hexPath = resolveContractArtifact("staking", "staking.hex");
  if (!existsSync(hexPath)) {
    logger.debug({ hexPath }, "Staking WASM bytecode not found — skipping auto-deploy");
    return undefined;
  }
  const bytecodeHex = readFileSync(hexPath, "utf-8").trim();
  const { address, error } = await wasmVM.deploy(deployer, bytecodeHex, {
    functions: [
      { name: "register",           methodId: STAKING_CONTRACT_METHOD.REGISTER,           inputs: ["u16", "string"], outputs: ["i32"] },
      { name: "delegate",           methodId: STAKING_CONTRACT_METHOD.DELEGATE,           inputs: ["i64", "i64"],    outputs: ["i32"] },
      { name: "undelegate",         methodId: STAKING_CONTRACT_METHOD.UNDELEGATE,         inputs: ["i64", "i64"],    outputs: ["i32"] },
      { name: "completeUndelegate", methodId: STAKING_CONTRACT_METHOD.COMPLETE_UNDELEGATE, inputs: ["i64"],           outputs: ["i32"] },
      { name: "claimRewards",       methodId: STAKING_CONTRACT_METHOD.CLAIM_REWARDS,      inputs: ["i64"],           outputs: ["i32"] },
      { name: "distributeEpoch",    methodId: STAKING_CONTRACT_METHOD.DISTRIBUTE_EPOCH,   inputs: [],                outputs: ["i32"] },
      { name: "slash",              methodId: STAKING_CONTRACT_METHOD.SLASH,              inputs: ["i64", "u8", "string"], outputs: ["i32"] },
      { name: "unjail",             methodId: STAKING_CONTRACT_METHOD.UNJAIL,             inputs: [],                outputs: ["i32"] },
      { name: "updateCommission",   methodId: STAKING_CONTRACT_METHOD.UPDATE_COMMISSION,  inputs: ["u16"],           outputs: ["i32"] },
      { name: "getActiveSet",       methodId: STAKING_CONTRACT_METHOD.GET_ACTIVE_SET,     inputs: [],                outputs: ["i32"] },
      { name: "getValidatorInfo",   methodId: STAKING_CONTRACT_METHOD.GET_VALIDATOR_INFO, inputs: ["i64"],           outputs: ["i32"] },
      { name: "getDelegationInfo",  methodId: STAKING_CONTRACT_METHOD.GET_DELEGATION_INFO, inputs: ["string", "i64"], outputs: ["i32"] },
      { name: "getCapabilities",    methodId: STAKING_CONTRACT_METHOD.GET_CAPABILITIES,   inputs: [],                outputs: ["i32"] },
    ],
  });
  if (error || !address) {
    logger.error({ error }, "Failed to deploy Staking WASM contract");
    return undefined;
  }
  cachedAddress = address;
  logger.info({ address }, "Staking WASM contract deployed");
  return address;
}

// ── Contract calls ────────────────────────────────────────────────────────────

export interface RegisterValidatorParams {
  commissionBp: number; // 0–10000 (0–100%)
  moniker: string;      // max 64 bytes
}

export interface RegisterResult { success: boolean; validatorId?: number; error?: string }

export async function registerValidatorOnContract(
  wasmVM: WasmVM,
  caller: string,
  p: RegisterValidatorParams,
): Promise<RegisterResult> {
  const address = getStakingContractAddress();
  if (!address) return { success: false, error: "Staking contract not deployed" };
  if (p.commissionBp < 0 || p.commissionBp > 10000) return { success: false, error: "commissionBp must be 0–10000" };

  const monikerWords = stringToWords(p.moniker, 64);
  const args = [p.commissionBp, monikerWords.length * 4, ...monikerWords];

  const res = await wasmVM.call(address, STAKING_CONTRACT_METHOD.REGISTER, args, undefined, caller);
  if (!res.success || res.returnValue === null || res.returnValue < 0) {
    const errs: Record<number, string> = {
      [-1]: "Commission > 100%",
      [-2]: "Moniker too long",
      [-3]: "Insufficient balance for self-bond",
    };
    return { success: false, error: res.error ?? errs[res.returnValue ?? -1] ?? `register() returned ${res.returnValue}` };
  }
  return { success: true, validatorId: res.returnValue };
}

// Legacy alias.
export async function registerValidator(
  wasmVM: WasmVM,
  caller: string,
  commissionBp: number,
  moniker: string,
): Promise<number> {
  const result = await registerValidatorOnContract(wasmVM, caller, { commissionBp, moniker });
  return result.success ? (result.validatorId ?? -99) : -99;
}

export interface DelegateResult { success: boolean; error?: string }

export async function delegateOnContract(
  wasmVM: WasmVM,
  caller: string,
  validatorId: number,
  amount: number,
): Promise<DelegateResult> {
  const address = getStakingContractAddress();
  if (!address) return { success: false, error: "Staking contract not deployed" };

  const args = [...i64ToWords(BigInt(validatorId)), ...i64ToWords(BigInt(Math.floor(amount)))];
  const res = await wasmVM.call(address, STAKING_CONTRACT_METHOD.DELEGATE, args, undefined, caller);
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };

  const errs: Record<number, string> = {
    [-1]: "Unknown validator",
    [-2]: "Insufficient balance",
    [-3]: "Below minimum delegation",
  };
  if (res.returnValue < 0) return { success: false, error: errs[res.returnValue] ?? `delegate() returned ${res.returnValue}` };
  return { success: true };
}

// Legacy alias.
export async function delegate(
  wasmVM: WasmVM,
  caller: string,
  validatorId: number,
  amount: number,
): Promise<number> {
  const result = await delegateOnContract(wasmVM, caller, validatorId, amount);
  return result.success ? 1 : -99;
}

export interface UndelegateResult { success: boolean; unbondingId?: number; error?: string }

export async function undelegateOnContract(
  wasmVM: WasmVM,
  caller: string,
  validatorId: number,
  amount: number,
): Promise<UndelegateResult> {
  const address = getStakingContractAddress();
  if (!address) return { success: false, error: "Staking contract not deployed" };

  const args = [...i64ToWords(BigInt(validatorId)), ...i64ToWords(BigInt(Math.floor(amount)))];
  const res = await wasmVM.call(address, STAKING_CONTRACT_METHOD.UNDELEGATE, args, undefined, caller);
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };

  const errs: Record<number, string> = {
    [-1]: "Insufficient delegation",
    [-2]: "Invalid amount",
  };
  if (res.returnValue < 0) return { success: false, error: errs[res.returnValue] ?? `undelegate() returned ${res.returnValue}` };
  return { success: true, unbondingId: res.returnValue };
}

export interface CompleteUndelegateResult { success: boolean; error?: string }

export async function completeUndelegateOnContract(
  wasmVM: WasmVM,
  caller: string,
  unbondingId: number,
): Promise<CompleteUndelegateResult> {
  const address = getStakingContractAddress();
  if (!address) return { success: false, error: "Staking contract not deployed" };

  const res = await wasmVM.call(
    address, STAKING_CONTRACT_METHOD.COMPLETE_UNDELEGATE,
    [...i64ToWords(BigInt(unbondingId))], undefined, caller,
  );
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };
  if (res.returnValue === 0) return { success: false, error: "Not yet mature" };
  if (res.returnValue < 0) return { success: false, error: `complete_undelegate() returned ${res.returnValue}` };
  return { success: true };
}

export interface ClaimRewardsResult { success: boolean; error?: string }

export async function claimRewardsOnContract(
  wasmVM: WasmVM,
  caller: string,
  validatorId: number,
): Promise<ClaimRewardsResult> {
  const address = getStakingContractAddress();
  if (!address) return { success: false, error: "Staking contract not deployed" };

  const res = await wasmVM.call(
    address, STAKING_CONTRACT_METHOD.CLAIM_REWARDS,
    [...i64ToWords(BigInt(validatorId))], undefined, caller,
  );
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };
  if (res.returnValue === 0) return { success: false, error: "Nothing to claim" };
  if (res.returnValue < 0) return { success: false, error: `claim_rewards() returned ${res.returnValue}` };
  return { success: true };
}

export interface DistributeEpochResult { success: boolean; distributedAmount?: number; error?: string }

export async function distributeEpochOnContract(
  wasmVM: WasmVM,
  caller: string,
): Promise<DistributeEpochResult> {
  const address = getStakingContractAddress();
  if (!address) return { success: false, error: "Staking contract not deployed" };

  const res = await wasmVM.call(address, STAKING_CONTRACT_METHOD.DISTRIBUTE_EPOCH, [], undefined, caller);
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };
  if (res.returnValue === 0) return { success: false, error: "Epoch not ready" };
  if (res.returnValue < 0) return { success: false, error: `distribute_epoch() returned ${res.returnValue}` };
  return { success: true, distributedAmount: res.returnValue };
}

// Legacy alias.
export async function distributeEpoch(wasmVM: WasmVM, caller: string): Promise<number> {
  const result = await distributeEpochOnContract(wasmVM, caller);
  return result.success ? (result.distributedAmount ?? 0) : 0;
}

export interface SlashResult { success: boolean; slashedAmount?: number; error?: string }

export async function slashValidatorOnContract(
  wasmVM: WasmVM,
  caller: string,
  validatorId: number,
  slashType: "double_sign" | "downtime" | "light_client",
  evidenceHash: string, // 64-char hex
): Promise<SlashResult> {
  const address = getStakingContractAddress();
  if (!address) return { success: false, error: "Staking contract not deployed" };

  const typeNum = slashType === "double_sign" ? 0 : slashType === "downtime" ? 1 : 2;
  const hashWords: number[] = [];
  for (let i = 0; i < 64; i += 8) {
    const chunk = evidenceHash.padEnd(64, "0").slice(i, i + 8);
    hashWords.push(parseInt(chunk, 16) | 0);
  }

  const args = [...i64ToWords(BigInt(validatorId)), typeNum, ...hashWords];
  const res = await wasmVM.call(address, STAKING_CONTRACT_METHOD.SLASH, args, undefined, caller);
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };
  if (res.returnValue < 0) return { success: false, error: `slash() returned ${res.returnValue}` };
  return { success: true, slashedAmount: res.returnValue };
}

// Legacy alias.
export async function slashValidator(
  wasmVM: WasmVM,
  caller: string,
  validatorId: number,
  slashType: number,
  evidenceHashHex: string,
): Promise<number> {
  const typeMap: Record<number, "double_sign" | "downtime" | "light_client"> = {
    0: "double_sign", 1: "downtime", 2: "light_client",
  };
  const result = await slashValidatorOnContract(wasmVM, caller, validatorId, typeMap[slashType] ?? "downtime", evidenceHashHex);
  return result.success ? (result.slashedAmount ?? 0) : -99;
}

export interface UnjailResult { success: boolean; error?: string }

export async function unjailValidatorOnContract(
  wasmVM: WasmVM,
  caller: string,
): Promise<UnjailResult> {
  const address = getStakingContractAddress();
  if (!address) return { success: false, error: "Staking contract not deployed" };

  const res = await wasmVM.call(address, STAKING_CONTRACT_METHOD.UNJAIL, [], undefined, caller);
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };
  if (res.returnValue === 0) return { success: false, error: "Not jailed" };
  if (res.returnValue < 0) return { success: false, error: `unjail() returned ${res.returnValue}` };
  return { success: true };
}

export interface UpdateCommissionResult { success: boolean; error?: string }

export async function updateCommissionOnContract(
  wasmVM: WasmVM,
  caller: string,
  newCommissionBp: number,
): Promise<UpdateCommissionResult> {
  const address = getStakingContractAddress();
  if (!address) return { success: false, error: "Staking contract not deployed" };

  const res = await wasmVM.call(address, STAKING_CONTRACT_METHOD.UPDATE_COMMISSION, [newCommissionBp], undefined, caller);
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };
  if (res.returnValue === 0) return { success: false, error: "Invalid commission" };
  if (res.returnValue < 0) return { success: false, error: `update_commission() returned ${res.returnValue}` };
  return { success: true };
}

// ── Contract JSON normalizers ─────────────────────────────────────────────────
// The WASM contracts emit snake_case JSON; these mappers convert to the
// camelCase domain interfaces used by the TypeScript layer.

/** Raw validator JSON emitted by contracts/staking/src/lib.rs get_validator_info() */
interface RawValidatorInfo {
  addr: string;
  commission_fp: number;   // ← "commissionFp" in ValidatorInfo
  self_bond: number;        // ← "selfBond"
  total_delegated: number;  // ← "totalDelegated"
  status: number;
  moniker: string;
}

/** Raw delegation JSON emitted by contracts/staking/src/lib.rs get_delegation_info() */
interface RawDelegationInfo {
  validator_id: number;    // ← "validatorId" in DelegationInfo
  amount: number;
  reward_debt: number;     // ← "rewardDebt"
  pending_rewards: number; // ← "pendingRewards"
}

function normalizeValidatorInfo(raw: RawValidatorInfo): ValidatorInfo {
  return {
    addr:           raw.addr,
    commissionFp:   raw.commission_fp,
    selfBond:       raw.self_bond,
    totalDelegated: raw.total_delegated,
    status:         raw.status,
    moniker:        raw.moniker,
  };
}

function normalizeDelegationInfo(raw: RawDelegationInfo): DelegationInfo {
  return {
    validatorId:    raw.validator_id,
    amount:         raw.amount,
    rewardDebt:     raw.reward_debt,
    pendingRewards: raw.pending_rewards,
  };
}

// ── Queries ───────────────────────────────────────────────────────────────────

export interface ValidatorInfo {
  addr: string;
  commissionFp: number;    // normalized from contract's "commission_fp"
  selfBond: number;         // normalized from contract's "self_bond"
  totalDelegated: number;   // normalized from contract's "total_delegated"
  status: number;
  moniker: string;
}

export async function getValidatorInfoFromContract(
  wasmVM: WasmVM,
  validatorId: number,
): Promise<ValidatorInfo | null> {
  const address = getStakingContractAddress();
  if (!address) return null;

  const res = await wasmVM.call(address, STAKING_CONTRACT_METHOD.GET_VALIDATOR_INFO, [...i64ToWords(BigInt(validatorId))]);
  if (!res.success || res.returnValue !== 1) return null;

  const storage = wasmVM.getStorage(address);
  const raw = storage["query_result"];
  if (!raw) return null;
  try {
    return normalizeValidatorInfo(JSON.parse(raw) as RawValidatorInfo);
  } catch {
    return null;
  }
}

// Legacy alias — ValidatorInfoRecord uses the original snake_case field names.
export async function getValidatorInfo(
  wasmVM: WasmVM,
  validatorId: number,
): Promise<ValidatorInfoRecord | undefined> {
  const address = getStakingContractAddress();
  if (!address) return undefined;

  const res = await wasmVM.call(address, STAKING_CONTRACT_METHOD.GET_VALIDATOR_INFO, [...i64ToWords(BigInt(validatorId))]);
  if (!res.success || res.returnValue !== 1) return undefined;

  const storage = wasmVM.getStorage(address);
  const raw = storage["query_result"];
  if (!raw) return undefined;
  try {
    // ValidatorInfoRecord matches the raw contract shape directly.
    return JSON.parse(raw) as ValidatorInfoRecord;
  } catch {
    return undefined;
  }
}

export interface DelegationInfo {
  validatorId: number;    // normalized from contract's "validator_id"
  amount: number;
  rewardDebt: number;     // normalized from contract's "reward_debt"
  pendingRewards: number; // normalized from contract's "pending_rewards"
}

export async function getDelegationInfoFromContract(
  wasmVM: WasmVM,
  delegator: string,
  validatorId: number,
): Promise<DelegationInfo | null> {
  const address = getStakingContractAddress();
  if (!address) return null;

  const delegatorWords = addrToWords(delegator);
  const args = [...delegatorWords, ...i64ToWords(BigInt(validatorId))];

  const res = await wasmVM.call(address, STAKING_CONTRACT_METHOD.GET_DELEGATION_INFO, args);
  if (!res.success || res.returnValue !== 1) return null;

  const storage = wasmVM.getStorage(address);
  const raw = storage["query_result"];
  if (!raw) return null;
  try {
    return normalizeDelegationInfo(JSON.parse(raw) as RawDelegationInfo);
  } catch {
    return null;
  }
}

// Legacy alias — DelegationInfoRecord uses the original snake_case field names.
export async function getDelegationInfo(
  wasmVM: WasmVM,
  delegatorAddr: string,
  validatorId: number,
): Promise<DelegationInfoRecord | undefined> {
  const address = getStakingContractAddress();
  if (!address) return undefined;

  const delegatorWords = addrToWords(delegatorAddr);
  const args = [...delegatorWords, ...i64ToWords(BigInt(validatorId))];

  const res = await wasmVM.call(address, STAKING_CONTRACT_METHOD.GET_DELEGATION_INFO, args);
  if (!res.success || res.returnValue !== 1) return undefined;

  const storage = wasmVM.getStorage(address);
  const raw = storage["query_result"];
  if (!raw) return undefined;
  try {
    // DelegationInfoRecord matches the raw contract shape directly.
    return JSON.parse(raw) as DelegationInfoRecord;
  } catch {
    return undefined;
  }
}

// ── Active set snapshot ───────────────────────────────────────────────────────

export interface ActiveValidator {
  id: number;
  addr: string;
  totalStake: number;
}

export async function getActiveSetFromContract(wasmVM: WasmVM): Promise<number> {
  const address = getStakingContractAddress();
  if (!address) return 0;

  const res = await wasmVM.call(address, STAKING_CONTRACT_METHOD.GET_ACTIVE_SET, []);
  if (!res.success || res.returnValue === null || res.returnValue < 0) return 0;
  return res.returnValue;
}

export async function getActiveSetSnapshot(wasmVM: WasmVM): Promise<ActiveValidator[]> {
  const address = getStakingContractAddress();
  if (!address) return [];

  const count = await getActiveSetFromContract(wasmVM);
  const storage = wasmVM.getStorage(address);
  const validators: ActiveValidator[] = [];

  for (let i = 0; i < count; i++) {
    const vidStr = storage[`active_set:${i}`];
    if (!vidStr) continue;
    const vid = Number(vidStr);
    if (Number.isNaN(vid)) continue;

    const info = await getValidatorInfoFromContract(wasmVM, vid);
    if (!info) continue;

    validators.push({
      id:         vid,
      addr:       info.addr,
      totalStake: info.selfBond + info.totalDelegated,
    });
  }

  return validators;
}
