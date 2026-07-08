import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WasmVM } from "./wasm.js";
import { logger } from "../lib/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Arbitrage Integration ─────────────────────────────────────────────────────
//
// Thin typed wrapper around the compiled `arbitrage` WASM contract (see
// contracts/arbitrage/src/lib.rs for the full method/return-code contract
// and the reasoning behind its safety rails). Built ahead of time by
// contracts/arbitrage/build.sh and checked in as arbitrage.hex.

const METHOD = { INIT: 0, SET_MODEL: 1, PAUSE: 2, UNPAUSE: 3, EXECUTE: 4 } as const;

function loadArbitrageWasmHex(): string {
  const hexPath = join(__dirname, "..", "..", "..", "..", "contracts", "arbitrage", "arbitrage.hex");
  return readFileSync(hexPath, "utf-8").trim();
}

function i64ToWords(value: bigint): [number, number] {
  const masked = BigInt.asUintN(64, value);
  const lo = Number(masked & 0xffffffffn);
  let hi = Number((masked >> 32n) & 0xffffffffn);
  if (hi > 0x7fffffff) hi -= 0x100000000;
  return [lo | 0, hi];
}

function addressToWords(addr: string): number[] {
  if (!/^[0-9a-f]{40}$/.test(addr)) {
    throw new Error(`Invalid address (expected 40 hex chars): ${addr}`);
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

function stringToWordsPrefixed(str: string): number[] {
  const bytes = new TextEncoder().encode(str);
  const words: number[] = [bytes.length];
  for (let i = 0; i < bytes.length; i += 4) {
    let w = 0;
    for (let b = 0; b < 4; b++) w |= (bytes[i + b] ?? 0) << (b * 8);
    words.push(w);
  }
  return words;
}

let cachedAddress: string | undefined;

export function getArbitrageAddress(): string | undefined {
  return process.env["ARBITRAGE_ADDRESS"] || cachedAddress;
}

/**
 * Deploys and initializes the Arbitrage contract if ARBITRAGE_ADDRESS isn't
 * already configured. `owner` becomes the only address able to configure the
 * model, pause, and unpause the contract.
 */
export async function deployArbitrageIfNeeded(wasmVM: WasmVM, deployer: string, owner: string): Promise<string | undefined> {
  const existing = getArbitrageAddress();
  if (existing) {
    logger.info({ address: existing }, "Arbitrage configured via env — using existing contract");
    return existing;
  }
  const bytecodeHex = loadArbitrageWasmHex();
  const { address, error } = await wasmVM.deploy(deployer, bytecodeHex, {
    functions: [
      { name: "init", methodId: METHOD.INIT, inputs: ["address"], outputs: ["i32"] },
      { name: "setModel", methodId: METHOD.SET_MODEL, inputs: ["address", "i32"], outputs: ["i32"] },
      { name: "pause", methodId: METHOD.PAUSE, inputs: [], outputs: ["i32"] },
      { name: "unpause", methodId: METHOD.UNPAUSE, inputs: [], outputs: ["i32"] },
    ],
  });
  if (error || !address) {
    logger.error({ error }, "Failed to deploy Arbitrage contract");
    return undefined;
  }
  const initRes = await wasmVM.call(address, METHOD.INIT, addressToWords(owner), deployer);
  if (!initRes.success || initRes.returnValue !== 1) {
    logger.error({ initRes }, "Arbitrage contract did not initialize correctly");
    return undefined;
  }
  cachedAddress = address;
  logger.info({ address, owner }, "Arbitrage deployed — set ARBITRAGE_ADDRESS to this value to keep it stable across restarts");
  return address;
}

export interface SimpleResult { success: boolean; error?: string }

export async function setArbitrageModel(wasmVM: WasmVM, caller: string, registryAddress: string, modelId: number): Promise<SimpleResult> {
  const address = getArbitrageAddress();
  if (!address) return { success: false, error: "Arbitrage not configured" };
  const args = [...addressToWords(registryAddress), modelId];
  const res = await wasmVM.call(address, METHOD.SET_MODEL, args, caller);
  if (!res.success || res.returnValue !== 1) {
    const messages: Record<number, string> = { [-1]: "Caller is not the owner", [-2]: "Contract not initialized" };
    return { success: false, error: res.error ?? messages[res.returnValue ?? -1] ?? `set_model() returned ${res.returnValue}` };
  }
  return { success: true };
}

export async function pauseArbitrage(wasmVM: WasmVM, caller: string): Promise<SimpleResult> {
  const address = getArbitrageAddress();
  if (!address) return { success: false, error: "Arbitrage not configured" };
  const res = await wasmVM.call(address, METHOD.PAUSE, [], caller);
  if (!res.success || res.returnValue !== 1) return { success: false, error: res.error ?? "Caller is not the owner" };
  return { success: true };
}

export async function unpauseArbitrage(wasmVM: WasmVM, caller: string): Promise<SimpleResult> {
  const address = getArbitrageAddress();
  if (!address) return { success: false, error: "Arbitrage not configured" };
  const res = await wasmVM.call(address, METHOD.UNPAUSE, [], caller);
  if (!res.success || res.returnValue !== 1) return { success: false, error: res.error ?? "Caller is not the owner" };
  return { success: true };
}

export interface ExecuteArbitrageParams {
  poolIds: string[];
  tokenIn: string;
  amountIn: number; // base units
  minProfit: number; // base units — NOT enforced as a revert (see LIMITATIONS.md); logged as ArbitrageUnderTarget if missed
}

export interface ExecuteArbitrageResult { success: boolean; profit?: number; error?: string }

export async function executeArbitrage(wasmVM: WasmVM, caller: string, p: ExecuteArbitrageParams): Promise<ExecuteArbitrageResult> {
  const address = getArbitrageAddress();
  if (!address) return { success: false, error: "Arbitrage not configured" };

  const args: number[] = [
    ...stringToWordsPrefixed(p.poolIds.join(",")),
    ...stringToWordsPrefixed(p.tokenIn),
    ...i64ToWords(BigInt(Math.round(p.amountIn))),
    ...i64ToWords(BigInt(Math.round(p.minProfit))),
  ];

  const res = await wasmVM.call(address, METHOD.EXECUTE, args, caller);
  if (!res.success || res.returnValue === null) return { success: false, error: res.error ?? "call failed" };
  const messages: Record<number, string> = {
    [-1]: "Paused or circuit breaker tripped",
    [-2]: "No model configured",
    [-3]: "Model not verified, or not yet past the update delay",
    [-4]: "Amount exceeds the max trade amount",
    [-5]: "Swap failed",
  };
  if (res.returnValue < 0 && res.returnValue >= -5) {
    return { success: false, error: messages[res.returnValue] ?? `execute_arbitrage() returned ${res.returnValue}` };
  }
  return { success: true, profit: res.returnValue };
}
