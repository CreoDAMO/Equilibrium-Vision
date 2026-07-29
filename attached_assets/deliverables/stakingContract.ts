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
  REGISTER: 0,
  DELEGATE: 1,
  UNDELEGATE: 2,
  COMPLETE_UNDELEGATE: 3,
  CLAIM_REWARDS: 4,
  DISTRIBUTE_EPOCH: 5,
  SLASH: 6,
  UNJAIL: 7,
  UPDATE_COMMISSION: 8,
  GET_ACTIVE_SET: 9,
  GET_VALIDATOR_INFO: 10,
  GET_DELEGATION_INFO: 11,
  GET_CAPABILITIES: 12,
} as const;

function loadStakingWasmHex(): string {
  const hexPath = resolveContractArtifact("staking", "staking.hex");
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

export function getStakingContractAddress(): string | undefined {
  return process.env["STAKING_CONTRACT_ADDRESS"] || cachedAddress;
}

export async function deployStakingContractIfNeeded(wasmVM: WasmVM, deployer: string): Promise<string | undefined> {
  const existing = getStakingContractAddress();
  if (existing) {
    logger.info({ address: existing }, "Staking contract configured via env");
    return existing;
  }
  const bytecodeHex = loadStakingWasmHex();
  const { address, error } = await wasmVM.deploy(deployer, bytecodeHex, {
    functions: [
      { name: "register", methodId: METHOD.REGISTER, inputs: ["u16", "string"], outputs: ["i32"] },
      { name: "delegate", methodId: METHOD.DELEGATE, inputs: ["i64", "i64"], outputs: ["i32"] },
      { name: "undelegate", methodId: METHOD.UNDELEGATE, inputs: ["i64", "i64"], outputs: ["i32"] },
      { name: "completeUndelegate", methodId: METHOD.COMPLETE_UNDELEGATE, inputs: ["i64"], outputs: ["i32"] },
      { name: "claimRewards", methodId: METHOD.CLAIM_REWARDS, inputs: ["i64"], outputs: ["i32"] },
      { name: "distributeEpoch", methodId: METHOD.DISTRIBUTE_EPOCH, inputs: [], outputs: ["i32"] },
      { name: "slash", methodId: METHOD.SLASH, inputs: ["i64", "u8", "string"], outputs: ["i32"] },
      { name: "unjail", methodId: METHOD.UNJAIL, inputs: [], outputs: ["i32"] },
      { name: "updateCommission", methodId: METHOD.UPDATE_COMMISSION, inputs: ["u16"], outputs: ["i32"] },
      { name: "getActiveSet", methodId: METHOD.GET_ACTIVE_SET, inputs: [], outputs: ["i32"] },
      { name: "getValidatorInfo", methodId: METHOD.GET_VALIDATOR_INFO, inputs: ["i64"], outputs: ["i32"] },
      { name: "getDelegationInfo", methodId: METHOD.GET_DELEGATION_INFO, inputs: ["string", "i64"], outputs: ["i32"] },
      { name: "getCapabilities", methodId: METHOD.GET_CAPABILITIES, inputs: [], outputs: ["i32"] },
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

// ── Contract calls ───────────────────────────────────────────────────────────

export interface RegisterValidatorParams {
  commissionBp: number; // 0–10000 (0–100%)
  moniker: string; // max 64 bytes
}

export interface RegisterResult { success: boolean; validatorId?: number; error?: string }

export async function registerValidatorOnContract(
  wasmVM: WasmVM,
  caller: string,
  p: RegisterValidatorParams,
): Promise<RegisterResult> {
  const address = getStakingContractAddress();
  if (!address) return { success: false, error: "Staking contract not deployed" };
  if (p.commissionBp < 0 || p.commissionBp > 10000) {
    return { success: false, error: "commissionBp must be 0–10000" };
  }

  const monikerWords = stringToWords(p.moniker, 64);
  const args = [p.commissionBp, monikerWords.length * 4, ...monikerWords];

  const res = await wasmVM.call(address, METHOD.REGISTER, args, undefined, caller);
  if (!res.success || res.returnValue === null || res.returnValue < 0) {
    const messages: Record<number, string> = {
      [-1]: "Commission > 100%",
      [-2]: "Moniker too long",
      [-3]: "Insufficient balance for self-bond",
    };
    return { success: false, error: res.error ?? messages[res.returnValue ?? -1] ?? `register() returned ${res.returnValue}` };
  }
  return { success: true, validatorId: res.returnValue };
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
  const res = await wasmVM.call(address, METHOD.DELEGATE, args, undefined, caller);
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };

  const messages: Record<number, string> = {
    [-1]: "Unknown validator",
    [-2]: "Insufficient balance",
    [-3]: "Below minimum delegation",
  };
  if (res.returnValue < 0) return { success: false, error: messages[res.returnValue] ?? `delegate() returned ${res.returnValue}` };
  return { success: true };
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
  const res = await wasmVM.call(address, METHOD.UNDELEGATE, args, undefined, caller);
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };

  const messages: Record<number, string> = {
    [-1]: "Insufficient delegation",
    [-2]: "Invalid amount",
  };
  if (res.returnValue < 0) return { success: false, error: messages[res.returnValue] ?? `undelegate() returned ${res.returnValue}` };
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

  const res = await wasmVM.call(address, METHOD.COMPLETE_UNDELEGATE, [...i64ToWords(BigInt(unbondingId))], undefined, caller);
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

  const res = await wasmVM.call(address, METHOD.CLAIM_REWARDS, [...i64ToWords(BigInt(validatorId))], undefined, caller);
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };

  if (res.returnValue === 0) return { success: false, error: "Nothing to claim" };
  if (res.returnValue < 0) return { success: false, error: `claim_rewards() returned ${res.returnValue}` };
  return { success: true };
}

export interface DistributeEpochResult { success: boolean; distributedAmount?: number; error?: string }

export async function distributeEpochOnContract(wasmVM: WasmVM, caller: string): Promise<DistributeEpochResult> {
  const address = getStakingContractAddress();
  if (!address) return { success: false, error: "Staking contract not deployed" };

  const res = await wasmVM.call(address, METHOD.DISTRIBUTE_EPOCH, [], undefined, caller);
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };

  if (res.returnValue === 0) return { success: false, error: "Epoch not ready" };
  if (res.returnValue < 0) return { success: false, error: `distribute_epoch() returned ${res.returnValue}` };
  return { success: true, distributedAmount: res.returnValue };
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
    const chunk = evidenceHash.slice(i, i + 8);
    hashWords.push(parseInt(chunk, 16) | 0);
  }

  const args = [...i64ToWords(BigInt(validatorId)), typeNum, ...hashWords];
  const res = await wasmVM.call(address, METHOD.SLASH, args, undefined, caller);
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };

  if (res.returnValue < 0) return { success: false, error: `slash() returned ${res.returnValue}` };
  return { success: true, slashedAmount: res.returnValue };
}

export interface UnjailResult { success: boolean; error?: string }

export async function unjailValidatorOnContract(wasmVM: WasmVM, caller: string): Promise<UnjailResult> {
  const address = getStakingContractAddress();
  if (!address) return { success: false, error: "Staking contract not deployed" };

  const res = await wasmVM.call(address, METHOD.UNJAIL, [], undefined, caller);
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

  const res = await wasmVM.call(address, METHOD.UPDATE_COMMISSION, [newCommissionBp], undefined, caller);
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };

  if (res.returnValue === 0) return { success: false, error: "Invalid commission" };
  if (res.returnValue < 0) return { success: false, error: `update_commission() returned ${res.returnValue}` };
  return { success: true };
}

// ── Queries ──────────────────────────────────────────────────────────────────

export interface ValidatorInfo {
  addr: string;
  commissionFp: number;
  selfBond: number;
  totalDelegated: number;
  status: number;
  moniker: string;
}

export async function getValidatorInfoFromContract(wasmVM: WasmVM, validatorId: number): Promise<ValidatorInfo | null> {
  const address = getStakingContractAddress();
  if (!address) return null;

  const res = await wasmVM.call(address, METHOD.GET_VALIDATOR_INFO, [...i64ToWords(BigInt(validatorId))]);
  if (!res.success || res.returnValue !== 1) return null;

  const storage = wasmVM.getStorage(address);
  const raw = storage["query_result"];
  if (!raw) return null;

  try {
    const v = JSON.parse(raw) as ValidatorInfo;
    return v;
  } catch {
    return null;
  }
}

export interface DelegationInfo {
  validatorId: number;
  amount: number;
  rewardDebt: number;
  pendingRewards: number;
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

  const res = await wasmVM.call(address, METHOD.GET_DELEGATION_INFO, args);
  if (!res.success || res.returnValue !== 1) return null;

  const storage = wasmVM.getStorage(address);
  const raw = storage["query_result"];
  if (!raw) return null;

  try {
    const d = JSON.parse(raw) as DelegationInfo;
    return d;
  } catch {
    return null;
  }
}

export async function getActiveSetFromContract(wasmVM: WasmVM): Promise<number> {
  const address = getStakingContractAddress();
  if (!address) return 0;

  const res = await wasmVM.call(address, METHOD.GET_ACTIVE_SET, []);
  if (!res.success || res.returnValue === null || res.returnValue < 0) return 0;
  return res.returnValue;
}

// ── Active set snapshot ──────────────────────────────────────────────────────

export interface ActiveValidator {
  id: number;
  addr: string;
  totalStake: number;
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
      id: vid,
      addr: info.addr,
      totalStake: info.selfBond + info.totalDelegated,
    });
  }

  return validators;
}
