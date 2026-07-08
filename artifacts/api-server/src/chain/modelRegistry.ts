import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { WasmVM } from "./wasm.js";
import { logger } from "../lib/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── ModelRegistry Integration ────────────────────────────────────────────────
//
// Thin typed wrapper around the compiled `model_registry` WASM contract (see
// contracts/model_registry/src/lib.rs for the full method/return-code
// contract). The contract's bytecode is built ahead of time by
// contracts/model_registry/build.sh (real Rust -> wasm32, not WAT) and
// checked in as model_registry.hex — this module just loads that hex and
// packs/unpacks the flat i32-word call ABI.
//
// Fixed-point scales used on the wire (chosen independently per field, not
// mandated by any external spec):
//   - claimedResidual / epsilon: ×1e12 (matches variational-ai-cli's Request/
//     Response JSON convention directly, so no rescale is needed inside the
//     contract when it builds the verify_residual request)
//   - lambda, support data, support labels, tol: ×1e6 (plenty of precision
//     for model inputs/labels; keeps word counts small for large support
//     sets within the 1024-word call-arg limit)

const METHOD = { PROPOSE: 0, VERIFY_MODEL: 1, CHALLENGE: 2, GET_STATUS: 3, GET_VERIFIED_AT: 4 } as const;

const RESIDUAL_SCALE = 1_000_000_000_000; // 1e12
const FIELD_SCALE = 1_000_000; // 1e6 (lambda, support data/labels, tol)

function loadModelRegistryWasmHex(): string {
  const hexPath = join(__dirname, "..", "..", "..", "contracts", "model_registry", "model_registry.hex");
  return readFileSync(hexPath, "utf-8").trim();
}

function i64ToWords(value: bigint): [number, number] {
  const masked = BigInt.asUintN(64, value);
  const lo = Number(masked & 0xffffffffn);
  let hi = Number((masked >> 32n) & 0xffffffffn);
  if (hi > 0x7fffffff) hi -= 0x100000000; // signed i32 wraparound for the high word
  return [lo | 0, hi];
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

function hexToWords32(hex: string): number[] {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== 64) throw new Error(`Expected 32-byte hex hash (64 chars), got ${clean.length}`);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  const words: number[] = [];
  for (let i = 0; i < 32; i += 4) {
    let w = 0;
    for (let b = 0; b < 4; b++) w |= (bytes[i + b] ?? 0) << (b * 8);
    words.push(w);
  }
  return words;
}

let cachedAddress: string | undefined;

export function getModelRegistryAddress(): string | undefined {
  return process.env["MODEL_REGISTRY_ADDRESS"] || cachedAddress;
}

/**
 * Deploys the ModelRegistry contract if MODEL_REGISTRY_ADDRESS isn't already
 * configured. Mirrors deployAdminMultisigIfConfigured's pattern: deploy once,
 * then pin the address via env var for stability across restarts.
 */
export async function deployModelRegistryIfNeeded(wasmVM: WasmVM, deployer: string): Promise<string | undefined> {
  const existing = getModelRegistryAddress();
  if (existing) {
    logger.info({ address: existing }, "ModelRegistry configured via env — using existing contract");
    return existing;
  }
  const bytecodeHex = loadModelRegistryWasmHex();
  const { address, error } = await wasmVM.deploy(deployer, bytecodeHex, {
    functions: [
      { name: "propose", methodId: METHOD.PROPOSE, inputs: [], outputs: ["i32"] },
      { name: "verifyModel", methodId: METHOD.VERIFY_MODEL, inputs: ["i32"], outputs: ["i32"] },
      { name: "challenge", methodId: METHOD.CHALLENGE, inputs: [], outputs: ["i32"] },
      { name: "getStatus", methodId: METHOD.GET_STATUS, inputs: ["i32"], outputs: ["i32"] },
      { name: "getVerifiedAt", methodId: METHOD.GET_VERIFIED_AT, inputs: ["i32"], outputs: ["i32"] },
    ],
  });
  if (error || !address) {
    logger.error({ error }, "Failed to deploy ModelRegistry contract");
    return undefined;
  }
  cachedAddress = address;
  logger.info({ address }, "ModelRegistry deployed — set MODEL_REGISTRY_ADDRESS to this value to keep it stable across restarts");
  return address;
}

export interface ProposeModelParams {
  claimedResidual: number; // real value, will be scaled by 1e12
  supportHashHex: string; // sha256 hex (64 chars) of the canonical support-set encoding — see encodeSupportCommitment()
  inputDim: number;
  hiddenDim: number;
  lambda: number; // real value, scaled by 1e6 on the wire
  seed: number;
  uri: string; // off-chain pointer to the full model artifact (max 256 bytes)
}

export interface ProposeResult { success: boolean; modelId?: number; error?: string }

export async function proposeModel(wasmVM: WasmVM, caller: string, p: ProposeModelParams): Promise<ProposeResult> {
  const address = getModelRegistryAddress();
  if (!address) return { success: false, error: "ModelRegistry not configured" };

  let args: number[];
  try {
    args = [
      ...i64ToWords(BigInt(Math.round(p.claimedResidual * RESIDUAL_SCALE))),
      ...hexToWords32(p.supportHashHex),
      p.inputDim,
      p.hiddenDim,
      Math.round(p.lambda * FIELD_SCALE),
      p.seed,
      new TextEncoder().encode(p.uri).length,
      ...stringToWords(p.uri, 256),
    ];
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }

  const res = await wasmVM.call(address, METHOD.PROPOSE, args, undefined, caller);
  if (!res.success || res.returnValue === null || res.returnValue < 0) {
    const messages: Record<number, string> = {
      [-1]: "Insufficient balance for minimum bond",
      [-2]: "Proposer already at max models per proposer",
      [-3]: "URI too long (max 256 bytes)",
    };
    return { success: false, error: res.error ?? messages[res.returnValue ?? -1] ?? `propose() returned ${res.returnValue}` };
  }
  return { success: true, modelId: res.returnValue };
}

export interface VerifyModelResult { success: boolean; status?: "verified" | "already-verified" | "slashed"; error?: string }

export async function verifyModel(wasmVM: WasmVM, caller: string, modelId: number): Promise<VerifyModelResult> {
  const address = getModelRegistryAddress();
  if (!address) return { success: false, error: "ModelRegistry not configured" };
  const res = await wasmVM.call(address, METHOD.VERIFY_MODEL, [modelId], undefined, caller);
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };
  const messages: Record<number, string> = { [-1]: "Unknown model", [-2]: "Challenge window still open" };
  if (res.returnValue < 0) return { success: false, error: messages[res.returnValue] ?? `verify_model() returned ${res.returnValue}` };
  return { success: true, status: res.returnValue === 1 ? "verified" : "slashed" };
}

export interface ChallengeParams {
  modelId: number;
  supportData: number[][]; // [nSupport][inputDim]
  supportLabels: number[]; // [nSupport]
  tol?: number;
  maxIter?: number;
}

export interface ChallengeResult { success: boolean; outcome?: "slashed" | "failed"; error?: string }

/**
 * Canonical fixed-point encoding of a support set, used both to build the
 * on-chain commitment hash at propose() time and to encode the challenge()
 * call args — MUST stay in lockstep with the Rust contract's hashing order
 * (all support_data fixed-point i64 LE bytes, then all support_labels).
 */
export function encodeSupportCommitment(supportData: number[][], supportLabels: number[]): { hashHex: string; dataFp: bigint[]; labelsFp: bigint[] } {
  const dataFp = supportData.flat().map((v) => BigInt(Math.round(v * FIELD_SCALE)));
  const labelsFp = supportLabels.map((v) => BigInt(Math.round(v * FIELD_SCALE)));
  const buf = Buffer.alloc((dataFp.length + labelsFp.length) * 8);
  let offset = 0;
  for (const v of [...dataFp, ...labelsFp]) {
    buf.writeBigInt64LE(BigInt.asIntN(64, v), offset);
    offset += 8;
  }
  const hashHex = createHash("sha256").update(buf).digest("hex");
  return { hashHex, dataFp, labelsFp };
}

export async function challengeModel(wasmVM: WasmVM, caller: string, p: ChallengeParams): Promise<ChallengeResult> {
  const address = getModelRegistryAddress();
  if (!address) return { success: false, error: "ModelRegistry not configured" };

  const n = p.supportLabels.length;
  if (p.supportData.length !== n) return { success: false, error: "supportData/supportLabels length mismatch" };

  const { dataFp, labelsFp } = encodeSupportCommitment(p.supportData, p.supportLabels);
  const args: number[] = [p.modelId, n];
  for (const v of dataFp) args.push(...i64ToWords(v));
  for (const v of labelsFp) args.push(...i64ToWords(v));
  args.push(Math.round((p.tol ?? 0) * FIELD_SCALE));
  args.push(p.maxIter ?? 0);

  if (args.length > 1024) {
    return { success: false, error: `Support set too large: ${args.length} words exceeds the 1024-word call-arg limit` };
  }

  const res = await wasmVM.call(address, METHOD.CHALLENGE, args, undefined, caller);
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };
  const messages: Record<number, string> = {
    [-1]: "Unknown model",
    [-2]: "Model not in Proposed state",
    [-3]: "Challenge window closed",
    [-4]: "Support data does not match the committed hash",
    [-5]: "Insufficient balance for challenge bond",
  };
  if (res.returnValue < 0) return { success: false, error: messages[res.returnValue] ?? `challenge() returned ${res.returnValue}` };
  return { success: true, outcome: res.returnValue === 2 ? "slashed" : "failed" };
}

export async function getModelStatus(wasmVM: WasmVM, modelId: number): Promise<"proposed" | "verified" | "slashed" | "unknown"> {
  const address = getModelRegistryAddress();
  if (!address) return "unknown";
  const res = await wasmVM.call(address, METHOD.GET_STATUS, [modelId]);
  if (!res.success || res.returnValue === null) return "unknown";
  return res.returnValue === 0 ? "proposed" : res.returnValue === 1 ? "verified" : res.returnValue === 2 ? "slashed" : "unknown";
}

export function getModelDetails(wasmVM: WasmVM, modelId: number): Record<string, string> {
  const address = getModelRegistryAddress();
  if (!address) return {};
  const storage = wasmVM.getStorage(address);
  const details: Record<string, string> = {};
  for (const [key, value] of Object.entries(storage)) {
    if (key.endsWith(`:${modelId}`)) details[key.slice(0, key.lastIndexOf(":"))] = value;
  }
  return details;
}
