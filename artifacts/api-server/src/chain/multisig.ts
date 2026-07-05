import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { WasmVM } from "./wasm.js";
import { logger } from "../lib/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Compiles multisig.wat to hex bytecode. Compiled once at module load and
 * cached — the .wat source is the single source of truth, wabt just does
 * the WAT→WASM translation (same as the in-browser contract editor).
 */
let cachedMultisigWasmHex: string | undefined;
async function getMultisigWasmHex(): Promise<string> {
  if (cachedMultisigWasmHex) return cachedMultisigWasmHex;
  const wabtModule = await import("wabt");
  const wabt = await wabtModule.default();
  const watPath = join(__dirname, "contracts", "multisig.wat");
  const wat = readFileSync(watPath, "utf-8");
  const mod = wabt.parseWat("multisig.wat", wat);
  mod.resolveNames();
  mod.validate();
  const { buffer } = mod.toBinary({});
  cachedMultisigWasmHex = Buffer.from(buffer).toString("hex");
  return cachedMultisigWasmHex;
}

// ── Admin Multisig Integration ─────────────────────────────────────────────
//
// Deploys the native WASM M-of-N multisig contract (multisig.wat) and wraps
// its call ABI in typed helpers. This replaces the single ADMIN_KEY secret
// for privileged admin actions (currently: validator slashing) with an
// on-chain, threshold-signed approval gate — see multisig.wat header for the
// full method/return-code contract.
//
// Configuration (env vars):
//   ADMIN_MULTISIG_ADDRESS   — address of an already-deployed multisig
//                              contract (set this after the first boot log
//                              to make the deployment stick across restarts)
//   ADMIN_MULTISIG_OWNERS    — comma-separated list of 40-hex-char owner
//                              addresses (only used when ADMIN_MULTISIG_ADDRESS
//                              is unset, to deploy a fresh contract)
//   ADMIN_MULTISIG_THRESHOLD — number of approvals required (defaults to a
//                              simple majority of the owner list)

const METHOD = { INIT: 0, ADD_OWNER: 1, FINALIZE: 2, PROPOSE: 3, APPROVE: 4, IS_APPROVED: 5 } as const;

let runtimeMultisigAddress: string | undefined;

function addressToWords(addr: string): number[] {
  if (!/^[0-9a-f]{40}$/.test(addr)) {
    throw new Error(`Invalid multisig owner address (expected 40 hex chars): ${addr}`);
  }
  const bytes = new TextEncoder().encode(addr);
  const words: number[] = [];
  for (let i = 0; i < 10; i++) {
    let w = 0;
    for (let b = 0; b < 4; b++) w |= (bytes[i * 4 + b] ?? 0) << (b * 8);
    words.push(w);
  }
  return words;
}

function hexBytesToWords(hex: string, expectedBytes: number): number[] {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== expectedBytes * 2) {
    throw new Error(`Expected ${expectedBytes} bytes (${expectedBytes * 2} hex chars), got ${clean.length} chars`);
  }
  const bytes = new Uint8Array(expectedBytes);
  for (let i = 0; i < expectedBytes; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  const words: number[] = [];
  for (let i = 0; i < bytes.length; i += 4) {
    let w = 0;
    for (let b = 0; b < 4; b++) w |= (bytes[i + b] ?? 0) << (b * 8);
    words.push(w);
  }
  return words;
}

/**
 * Reads the configured multisig contract address: an explicit env override
 * takes priority (stable across restarts), falling back to whatever was
 * deployed fresh this boot (only stable within the current process).
 */
export function getMultisigAddress(): string | undefined {
  return process.env["ADMIN_MULTISIG_ADDRESS"] || runtimeMultisigAddress;
}

/**
 * Deploys and initializes the admin multisig contract if:
 *   - ADMIN_MULTISIG_ADDRESS is not already set (contract presumed loaded
 *     from DB in that case), and
 *   - ADMIN_MULTISIG_OWNERS is configured.
 * No-op otherwise (e.g. plain ADMIN_KEY-only deployments, or local dev).
 */
export async function deployAdminMultisigIfConfigured(wasmVM: WasmVM, deployer: string): Promise<void> {
  if (process.env["ADMIN_MULTISIG_ADDRESS"]) {
    logger.info({ address: process.env["ADMIN_MULTISIG_ADDRESS"] }, "Admin multisig configured via env — using existing contract");
    return;
  }
  const ownersRaw = process.env["ADMIN_MULTISIG_OWNERS"];
  if (!ownersRaw) return;

  const owners = ownersRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (owners.length === 0) return;

  const threshold = Number(process.env["ADMIN_MULTISIG_THRESHOLD"] ?? Math.ceil((owners.length + 1) / 2));
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > owners.length) {
    logger.warn({ threshold, ownerCount: owners.length }, "Invalid ADMIN_MULTISIG_THRESHOLD — skipping multisig deployment");
    return;
  }

  const bytecodeHex = await getMultisigWasmHex();
  const { address, error } = await wasmVM.deploy(deployer, bytecodeHex, {
    functions: [
      { name: "init", methodId: METHOD.INIT, inputs: ["i32"], outputs: ["i32"] },
      { name: "addOwner", methodId: METHOD.ADD_OWNER, inputs: ["address"], outputs: ["i32"] },
      { name: "finalize", methodId: METHOD.FINALIZE, inputs: [], outputs: ["i32"] },
      { name: "propose", methodId: METHOD.PROPOSE, inputs: [], outputs: ["i32"] },
      { name: "approve", methodId: METHOD.APPROVE, inputs: ["i32", "i32", "bytes32", "bytes64"], outputs: ["i32"] },
      { name: "isApproved", methodId: METHOD.IS_APPROVED, inputs: ["i32"], outputs: ["i32"] },
    ],
  });
  if (error || !address) {
    logger.error({ error }, "Failed to deploy admin multisig contract");
    return;
  }

  const initRes = await wasmVM.call(address, METHOD.INIT, [threshold]);
  for (const owner of owners) {
    await wasmVM.call(address, METHOD.ADD_OWNER, addressToWords(owner));
  }
  const finalizeRes = await wasmVM.call(address, METHOD.FINALIZE, []);

  if (!initRes.success || !finalizeRes.success || finalizeRes.returnValue !== 1) {
    logger.error({ initRes, finalizeRes }, "Admin multisig deployment did not finalize correctly");
    return;
  }

  runtimeMultisigAddress = address;
  logger.info(
    { address, owners, threshold },
    "Admin multisig deployed — set ADMIN_MULTISIG_ADDRESS to this value to keep it stable across restarts",
  );
}

export interface ProposeResult { success: boolean; proposalId?: number; error?: string }
export async function proposeAdminAction(wasmVM: WasmVM): Promise<ProposeResult> {
  const address = getMultisigAddress();
  if (!address) return { success: false, error: "Admin multisig not configured" };
  const res = await wasmVM.call(address, METHOD.PROPOSE, []);
  if (!res.success || res.returnValue === null || res.returnValue < 0) {
    return { success: false, error: res.error ?? `propose() returned ${res.returnValue}` };
  }
  return { success: true, proposalId: res.returnValue };
}

export interface ApproveResult { success: boolean; approved: boolean; thresholdMet: boolean; error?: string }
export async function approveAdminAction(
  wasmVM: WasmVM,
  proposalId: number,
  ownerIndex: number,
  pubkeyHex: string,
  signatureHex: string,
): Promise<ApproveResult> {
  const address = getMultisigAddress();
  if (!address) return { success: false, approved: false, thresholdMet: false, error: "Admin multisig not configured" };

  let args: number[];
  try {
    args = [proposalId, ownerIndex, ...hexBytesToWords(pubkeyHex, 32), ...hexBytesToWords(signatureHex, 64)];
  } catch (e) {
    return { success: false, approved: false, thresholdMet: false, error: (e as Error).message };
  }

  const res = await wasmVM.call(address, METHOD.APPROVE, args);
  if (!res.success) return { success: false, approved: false, thresholdMet: false, error: res.error };

  const rv = res.returnValue;
  const messages: Record<number, string> = {
    [-1]: "Multisig not finalized",
    [-2]: "Unknown proposal id",
    [-3]: "Proposal already fully approved",
    [-4]: "Unknown owner index",
    0: "Invalid signature or owner address mismatch",
  };
  if (rv === null || rv < 1) {
    return { success: false, approved: false, thresholdMet: false, error: messages[rv ?? -1] ?? `approve() returned ${rv}` };
  }
  return { success: true, approved: true, thresholdMet: rv === 2 };
}

export async function isAdminActionApproved(wasmVM: WasmVM, proposalId: number): Promise<boolean> {
  const address = getMultisigAddress();
  if (!address) return false;
  const res = await wasmVM.call(address, METHOD.IS_APPROVED, [proposalId]);
  return res.success && res.returnValue === 1;
}

export function getMultisigInfo(wasmVM: WasmVM): {
  configured: boolean;
  address?: string;
  ownerCount?: number;
  threshold?: number;
  finalized?: boolean;
} {
  const address = getMultisigAddress();
  if (!address) return { configured: false };
  const storage = wasmVM.getStorage(address);
  return {
    configured: true,
    address,
    ownerCount: Number(storage["meta_owners"] ?? "0"),
    threshold: Number(storage["meta_threshold"] ?? "0"),
    finalized: storage["meta_finalized"] === "1",
  };
}
