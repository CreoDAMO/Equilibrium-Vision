/**
 * wasm-worker.ts — Worker thread for non-blocking WASM contract execution.
 *
 * Runs the full WASM contract call synchronously inside this worker thread so
 * the main Node.js event loop stays unblocked during long-running host imports
 * like `verify_residual` (which shells out to the variational-ai-cli binary).
 *
 * Host-context operations that need live chain state (balance reads/writes,
 * governance param lookups, DEX swaps) are proxied back to the main thread via
 * synchronous MessagePort round-trips using `receiveMessageOnPort`.  From the
 * worker's perspective each proxy call is a blocking wait; from the main
 * thread's perspective it is a regular async event-loop message — so neither
 * side deadlocks and the main thread remains responsive to HTTP traffic while
 * the contract executes.
 *
 * Build: included as a second esbuild entry point in build.mjs so that
 * dist/wasm-worker.mjs is emitted alongside dist/index.mjs.
 */

import { workerData, parentPort, receiveMessageOnPort } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import { WasmVM } from "./wasm.js";
import type { ContractRecord, WasmHostContext, CallResult } from "./wasm.js";

// ── Worker request shape (sent via workerData) ────────────────────────────────

export interface WasmWorkerRequest {
  contracts:   ContractRecord[];
  blockHeight: number;
  address:     string;
  methodId:    number;
  args:        number[];
  gasLimit:    number;
  callerAddr:  string;
}

// ── Worker response shape (posted back to main thread) ────────────────────────

export interface WasmWorkerResponse {
  type:            "done";
  result:          CallResult;
  /** Final state of every contract touched during this call (incl. sub-calls). */
  contractUpdates: Array<{
    address:       string;
    storage:       Record<string, string>;
    callCount:     number;
    totalGasUsed:  number;
    events?:       string[];
  }>;
}

// ── Proxy host context ────────────────────────────────────────────────────────
// Each method synchronously round-trips to the main thread via MessagePort.
// receiveMessageOnPort() is allowed (and synchronous) inside worker threads.

class ProxyHostContext implements WasmHostContext {
  constructor(private readonly port: MessagePort) {}

  private rpc<T>(msg: Record<string, unknown>): T {
    this.port.postMessage(msg);
    const envelope = receiveMessageOnPort(this.port);
    if (!envelope) throw new Error("[wasm-worker] host RPC port closed unexpectedly");
    return envelope.message as T;
  }

  getBalance(addr: string): number {
    return this.rpc<{ balance: number }>({ type: "getBalance", addr }).balance;
  }
  credit(addr: string, amount: number): void {
    this.rpc<Record<string, never>>({ type: "credit", addr, amount });
  }
  debit(addr: string, amount: number): boolean {
    return this.rpc<{ ok: boolean }>({ type: "debit", addr, amount }).ok;
  }
  getGovParam(name: string): number | undefined {
    return this.rpc<{ value: number | undefined }>({ type: "getGovParam", name }).value;
  }
  dexMultiSwap(poolIds: string[], tokenIn: string, amountIn: number, trader: string): number | null {
    return this.rpc<{ result: number | null }>({
      type: "dexMultiSwap", poolIds, tokenIn, amountIn, trader,
    }).result;
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

(async () => {
  if (!parentPort) throw new Error("[wasm-worker] must be run as a Worker thread");

  // Step 1: receive the dedicated MessagePort for synchronous host-context RPC.
  // The main thread transfers port1 of a new MessageChannel here immediately
  // after creating the Worker.
  const portEnvelope = receiveMessageOnPort(parentPort);
  if (!portEnvelope) throw new Error("[wasm-worker] expected port handshake message");
  const { port } = portEnvelope.message as { port: MessagePort };

  // Step 2: unpack the call specification from workerData.
  const req = workerData as WasmWorkerRequest;

  // Step 3: build a local WasmVM with the contracts snapshot.
  const vm = new WasmVM();
  vm.loadContracts(req.contracts);
  vm.setBlockHeight(req.blockHeight);
  // setHostContext wires the proxy — all host imports route back to main thread.
  vm.setHostContext(new ProxyHostContext(port));
  // No persist callback: the main thread applies storage updates after we return.

  // Step 4: run the call (synchronous WASM + any execFileSync for verify_residual).
  // vm.call() detects isMainThread===false and calls execCall directly (no nested workers).
  let result: CallResult;
  try {
    result = await vm.call(req.address, req.methodId, req.args, req.gasLimit, req.callerAddr);
  } catch (err) {
    result = { success: false, returnValue: null, gasUsed: 0, logs: [], error: String(err) };
  }

  // Step 5: collect which contracts were mutated (callCount incremented by execCall).
  const contractUpdates = vm.listContracts()
    .filter(c => c.callCount > 0)
    .map(c => ({
      address:      c.address,
      storage:      c.storage,
      callCount:    c.callCount,
      totalGasUsed: c.totalGasUsed,
      events:       c.events,
    }));

  // Step 6: report back; main thread resolves its awaiting Promise and terminates us.
  parentPort.postMessage({ type: "done", result, contractUpdates } satisfies WasmWorkerResponse);
})();
