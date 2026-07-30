import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { Worker, MessageChannel, isMainThread } from "node:worker_threads";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bls12_381 } from "@noble/curves/bls12-381.js";
import { verifyZkProof, getVerificationKey } from "./zkproof.js";

// Resolve CLI binary once at module load — same helper used by bridge.ts.
//
// NOTE: import.meta.url is NOT rewritten per-source-file by esbuild when
// bundling into a single dist file — every module sees the *bundle's* own
// URL, so a path relative to __dirname assumes the wrong directory depth
// once bundled (dist/ sits one level shallower than src/chain/ did).
// Falling back through cwd- and dirname-relative candidates keeps this
// correct in both `tsx` dev mode and the bundled `dist/index.mjs` runtime.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
function resolveCliBinary(name: string): string {
  const candidates = [
    path.resolve(process.cwd(), name),
    path.resolve(__dirname, "../../", name),
    path.resolve(__dirname, "../", name),
  ];
  return candidates.find(c => fs.existsSync(c)) ?? candidates[0]!;
}
const VAI_CLI_PATH = resolveCliBinary("variational-ai-cli");

// Resolve the compiled Worker thread script for non-blocking WASM execution.
// esbuild mirrors the source tree: src/chain/wasm-worker.ts → dist/chain/wasm-worker.mjs.
// Falls back to "" (sync in-process path) when absent — e.g. vitest runs before a build.
const WORKER_SCRIPT = (
  [
    path.resolve(process.cwd(), "dist/chain/wasm-worker.mjs"), // esbuild bundled (prod + dev)
    path.resolve(__dirname, "chain/wasm-worker.mjs"),           // relative to dist/ (bundled)
    path.resolve(__dirname, "wasm-worker.mjs"),                 // same dir as this file
  ] as const
).find(p => fs.existsSync(p)) ?? "";

// ── WASM Smart Contract Execution Environment ──────────────────────────────────
//
// Deterministic WASM runtime for Equilibrium smart contracts.
// Uses Node.js built-in WebAssembly (no external VM dependency).
//
// Contract ABI: exports { call(methodId: i32, argsPtr: i32, argsLen: i32) → i32 }
// Host imports: { env: { storage_get, storage_set, log, block_number, balance } }

export interface ContractRecord {
  address: string;
  deployer: string;
  bytecode: string;
  bytecodeHash: string;
  storage: Record<string, string>;
  deployedAt: number;
  callCount: number;
  totalGasUsed: number;
  abi?: ContractABI;
  /** Rolling log of `log()` host-import messages emitted across all calls, most recent last. Capped at 200. */
  events?: string[];
}

export interface ContractABI {
  functions: ABIFunction[];
}

export interface ABIFunction {
  name: string;
  methodId: number;
  inputs: string[];
  outputs: string[];
}

export interface CallResult {
  success: boolean;
  returnValue: number | null;
  gasUsed: number;
  logs: string[];
  error?: string;
}

/**
 * Bridges the WASM VM to the rest of the chain (ledger balances, governance
 * parameters, DEX pools) without creating an import cycle — state.ts wires
 * this in once at boot via `setHostContext`. Any host import that touches
 * chain state outside the contract's own KV storage goes through here.
 */
export interface WasmHostContext {
  getBalance(addr: string): number;
  credit(addr: string, amount: number): void;
  debit(addr: string, amount: number): boolean;
  /** Returns undefined for an unknown parameter name. */
  getGovParam(name: string): number | undefined;
  /**
   * Executes a chain of AMM swaps, one per pool id, starting from `tokenIn`
   * with `amountIn` already debited from `trader`. Returns the final output
   * amount, or null if any hop fails (unknown pool / insufficient liquidity) —
   * in which case nothing is mutated for the failed hop (earlier hops in the
   * chain, if any succeeded, are NOT rolled back automatically; callers that
   * need atomicity should pre-validate the whole path).
   */
  dexMultiSwap(poolIds: string[], tokenIn: string, amountIn: number, trader: string): number | null;
}

/** Per-deployer contract nonce for deterministic, non-front-runnable addresses. */
let deployerNonces = new Map<string, number>();
export function resetDeployerNonces() { deployerNonces.clear(); }
export function setDeployerNonce(deployer: string, nonce: number) {
  deployerNonces.set(deployer, nonce);
}

const MAX_CALL_DEPTH = 4;

export class WasmVM {
  private contracts = new Map<string, ContractRecord>();
  private blockHeight = 0;
  private persistFn?: (contract: ContractRecord) => Promise<void>;
  private hostCtx?: WasmHostContext;

  setBlockHeight(h: number) { this.blockHeight = h; }

  /** Wires chain-level state (ledger, governance, DEX) into the VM's host imports. */
  setHostContext(ctx: WasmHostContext): void {
    this.hostCtx = ctx;
  }

  /**
   * Register a persistence callback.  Called after every deploy and after
   * every successful call that mutates storage or counters.
   * Fire-and-forget — errors are swallowed so the mining loop never stalls.
   */
  setPersistCallback(fn: (contract: ContractRecord) => Promise<void>): void {
    this.persistFn = fn;
  }

  /** Bulk-load contracts from DB on startup — skips validation for speed. */
  loadContracts(records: ContractRecord[]): void {
    for (const r of records) this.contracts.set(r.address, r);
  }

  private firePersist(contract: ContractRecord): void {
    if (this.persistFn) {
      this.persistFn(contract).catch((err) =>
        console.warn("[WasmVM] contract persist failed:", err),
      );
    }
  }

  async deploy(
    deployer: string,
    bytecodeHex: string,
    abi?: ContractABI,
  ): Promise<{ address: string; error?: string }> {
    // Derive contract address from deployer + bytecode hash
    // SECURITY FIX: Use a monotonic per-deployer nonce instead of Date.now()
    // to prevent address front-running and squatting.
    const bytecodeHash = createHash("sha256").update(bytecodeHex).digest("hex");
    const currentNonce = deployerNonces.get(deployer) ?? 0;
    const nextNonce = currentNonce + 1;
    deployerNonces.set(deployer, nextNonce);
    const address = createHash("sha256")
      .update(`${deployer}:${bytecodeHash}:${nextNonce}`)
      .digest("hex")
      .slice(0, 40);

    // Validate WASM binary — WebAssembly.compile() throws a CompileError for
    // invalid modules, whereas WebAssembly.validate() only returns a boolean.
    try {
      const bytes = hexToBytes(bytecodeHex);
      await WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>);
    } catch (e) {
      return { address: "", error: `Invalid WASM bytecode: ${(e as Error).message}` };
    }

    const contract: ContractRecord = {
      address,
      deployer,
      bytecode: bytecodeHex,
      bytecodeHash,
      storage: {},
      deployedAt: this.blockHeight,
      callCount: 0,
      totalGasUsed: 0,
      abi,
    };
    this.contracts.set(address, contract);
    this.firePersist(contract);
    return { address };
  }

  /**
   * Public entry point for contract calls.
   *
   * When running on the main thread with a live host context, execution is
   * dispatched to a Worker thread (dist/wasm-worker.mjs) so that long-running
   * host imports like `verify_residual` (execFileSync → variational-ai-cli)
   * do not block the main event loop.  Host-context operations (balance reads,
   * credits/debits, DEX swaps, governance params) are proxied back to the main
   * thread via synchronous MessagePort round-trips — the worker blocks briefly
   * for each proxy call while the main thread handles it via its event loop.
   *
   * Falls back to synchronous in-process execution when:
   *   - called from inside a worker thread (isMainThread === false) — prevents
   *     cascading worker creation for call_contract recursion, and
   *   - no host context is wired (e.g. unit tests), or
   *   - the compiled worker script is not present (vitest without a prior build).
   */
  async call(
    address: string,
    methodId: number,
    args: number[],
    gasLimit = 1_000_000,
    callerAddr = "",
  ): Promise<CallResult> {
    // ── Synchronous fast-path ──────────────────────────────────────────────
    // Also force sync under Vitest: the test runner uses fork-mode (not worker
    // threads), so isMainThread===true and WORKER_SCRIPT is present — but
    // receiveMessageOnPort() inside the spawned worker is non-blocking and
    // returns undefined before the main-thread event loop can respond, causing
    // "[wasm-worker] host RPC port closed unexpectedly" on every call that
    // touches host-context (balance, debit, DEX, etc.).
    if (!isMainThread || !this.hostCtx || !WORKER_SCRIPT || process.env["VITEST"]) {
      return this.execCall(address, methodId, args, gasLimit, callerAddr, 0);
    }

    // ── Worker dispatch ────────────────────────────────────────────────────
    // Serialize the contracts snapshot and ship the call to a Worker thread.
    const contracts = [...this.contracts.values()];
    const { port1, port2 } = new MessageChannel();
    const hostCtx = this.hostCtx;

    return new Promise<CallResult>((resolve) => {
      let settled = false;
      const settle = (result: CallResult) => {
        if (settled) return;
        settled = true;
        port2.close();
        worker.terminate();
        resolve(result);
      };

      const worker = new Worker(WORKER_SCRIPT, {
        workerData: {
          contracts,
          blockHeight: this.blockHeight,
          address, methodId, args, gasLimit, callerAddr,
        },
      });

      // ── Host-context proxy ───────────────────────────────────────────────
      // The worker calls receiveMessageOnPort(port1) synchronously for each
      // host-context operation.  We respond here via the event loop so the
      // main thread is never blocked.
      port2.on("message", (msg: Record<string, unknown>) => {
        switch (msg["type"]) {
          case "getBalance":
            port2.postMessage({ balance: hostCtx.getBalance(msg["addr"] as string) });
            break;
          case "credit":
            hostCtx.credit(msg["addr"] as string, msg["amount"] as number);
            port2.postMessage({});
            break;
          case "debit":
            port2.postMessage({ ok: hostCtx.debit(msg["addr"] as string, msg["amount"] as number) });
            break;
          case "getGovParam":
            port2.postMessage({ value: hostCtx.getGovParam(msg["name"] as string) });
            break;
          case "dexMultiSwap":
            port2.postMessage({
              result: hostCtx.dexMultiSwap(
                msg["poolIds"] as string[], msg["tokenIn"] as string,
                msg["amountIn"] as number, msg["trader"] as string,
              ),
            });
            break;
        }
      });

      // ── Worker result ────────────────────────────────────────────────────
      worker.on("message", (msg: Record<string, unknown>) => {
        if (msg["type"] !== "done") return;
        // Apply storage + call-counter updates back to the live contract map.
        const updates = msg["contractUpdates"] as Array<{
          address: string; storage: Record<string, string>;
          callCount: number; totalGasUsed: number; events?: string[];
        }>;
        for (const u of updates) {
          const live = this.contracts.get(u.address);
          if (live) {
            live.storage      = u.storage;
            live.callCount    = u.callCount;
            live.totalGasUsed = u.totalGasUsed;
            if (u.events) live.events = u.events;
            this.firePersist(live);
          }
        }
        settle(msg["result"] as CallResult);
      });

      worker.on("error", (err) => {
        settle({ success: false, returnValue: null, gasUsed: 0, logs: [], error: String(err) });
      });
      worker.on("exit", (code) => {
        if (code !== 0) settle({ success: false, returnValue: null, gasUsed: 0, logs: [], error: `Worker exited with code ${code}` });
      });

      // Transfer port1 to the worker for synchronous host-context RPC.
      worker.postMessage({ port: port1 }, [port1]);
    });
  }

  private execCall(
    address: string,
    methodId: number,
    args: number[],
    gasLimit: number,
    callerAddr: string,
    depth: number,
  ): CallResult {
    const contract = this.contracts.get(address);
    if (!contract) {
      return { success: false, returnValue: null, gasUsed: 0, logs: [], error: "Contract not found" };
    }

    if (!Array.isArray(args)) {
      return { success: false, returnValue: null, gasUsed: 0, logs: [], error: "Invalid args: expected array" };
    }
    const MAX_CALL_ARGS = 1024;
    const argCount = args.length;
    if (argCount > MAX_CALL_ARGS) {
      return {
        success: false,
        returnValue: null,
        gasUsed: 0,
        logs: [],
        error: `Too many args: max ${MAX_CALL_ARGS}`,
      };
    }
    if (depth > MAX_CALL_DEPTH) {
      return { success: false, returnValue: null, gasUsed: 0, logs: [], error: "Max call_contract depth exceeded" };
    }

    const logs: string[] = [];
    const storage = contract.storage;
    let gasUsed = 0;
    const gasPerInstruction = 1;
    // verify_residual is capped at 1 invocation per contract call.
    // Each call blocks the event loop (execFileSync); more than one per
    // execution would multiply the DoS surface with no legitimate use-case.
    let verifyResidualCallCount = 0;
    const hostCtx = this.hostCtx;

    // Inline helper — throws "Out of gas" if the limit is exceeded during a
    // host import.  Called after every expensive host operation.
    const checkGas = () => {
      if (gasUsed > gasLimit) throw new Error("Out of gas");
    };

    // Host import object — the contract's view of the outside world
    const importObject: WebAssembly.Imports = {
      env: {
        storage_get: (keyPtr: number, keyLen: number, resultPtr: number): number => {
          gasUsed += 200;
          checkGas();
          const key = readString(memory, keyPtr, keyLen);
          const value = storage[key] ?? "";
          writeString(memory, resultPtr, value);
          return value.length;
        },
        storage_set: (keyPtr: number, keyLen: number, valPtr: number, valLen: number): void => {
          gasUsed += 500;
          checkGas();
          const key = readString(memory, keyPtr, keyLen);
          const val = readString(memory, valPtr, valLen);
          storage[key] = val;
        },
        log: (msgPtr: number, msgLen: number): void => {
          gasUsed += 50;
          const msg = readString(memory, msgPtr, msgLen);
          logs.push(msg);
        },
        block_number: (): number => {
          gasUsed += gasPerInstruction;
          return this.blockHeight;
        },
        abort: (msg: number, file: number, line: number, col: number): never => {
          throw new Error(`WASM abort at ${line}:${col}`);
        },
        // Derives the canonical wallet address (sha256(raw pubkey bytes)[..40])
        // from the given pubkey, checks it matches the claimed owner address,
        // then verifies the Ed25519 signature over the given message. Used by
        // the on-chain multisig contract to gate approvals to real key holders
        // without ever persisting public keys in contract storage.
        verify_owner_sig: (
          msgPtr: number, msgLen: number,
          sigPtr: number, sigLen: number,
          pubkeyPtr: number, pubkeyLen: number,
          addrPtr: number, addrLen: number,
        ): number => {
          gasUsed += 3000;
          checkGas();
          try {
            const msg = new Uint8Array(memory.buffer, msgPtr, msgLen).slice();
            const sig = new Uint8Array(memory.buffer, sigPtr, sigLen).slice();
            const pubkey = new Uint8Array(memory.buffer, pubkeyPtr, pubkeyLen).slice();
            const addr = readString(memory, addrPtr, addrLen);
            const derived = createHash("sha256").update(pubkey).digest("hex").slice(0, 40);
            if (derived !== addr) return 0;
            return ed25519.verify(sig, msg, pubkey) ? 1 : 0;
          } catch {
            return 0;
          }
        },
        // Writes this contract's own address into WASM memory at outPtr and
        // returns its length. Lets contracts bind signed messages to their
        // own address, preventing cross-contract signature replay.
        self_address: (outPtr: number): number => {
          gasUsed += 50;
          writeString(memory, outPtr, address);
          return address.length;
        },

        // Synchronous residual verifier — calls the variational-ai-cli binary
        // via execFileSync so it can be used as a WASM host import (which must
        // be synchronous; async/await is not allowed here).
        //
        // The contract writes a JSON-encoded VerifyResidualRequest into its
        // WASM memory and passes the pointer + length.  Returns:
        //   1  — residual is valid (within epsilon)
        //   0  — residual mismatch or any error (fail-closed)
        //
        // Safety: capped at 1 call per contract invocation to bound event-loop
        // blocking.  Gas is checked immediately so an over-budget call halts
        // before the subprocess is spawned.  Timeout is 10 s (hard kill).
        verify_residual: (reqPtr: number, reqLen: number): number => {
          gasUsed += 50_000;
          checkGas(); // halt before blocking the event loop if already over budget
          if (++verifyResidualCallCount > 1) {
            throw new Error("verify_residual may only be called once per contract invocation");
          }
          // HARDENING: validate JSON shape before shelling out
          const MAX_REQ_LEN = 16_384;
          if (reqLen > MAX_REQ_LEN) return 0;
          try {
            const reqJson = readString(memory, reqPtr, reqLen);
            // Strict schema validation — only allow expected keys
            const req = JSON.parse(reqJson);
            if (typeof req !== "object" || req === null) return 0;
            const allowedKeys = new Set(["blockHash", "height", "nonce", "difficulty", "residual"]);
            for (const key of Object.keys(req)) {
              if (!allowedKeys.has(key)) return 0;
            }
            if (typeof req.residual !== "number" || !Number.isFinite(req.residual)) return 0;
            if (typeof req.nonce !== "number" || !Number.isInteger(req.nonce)) return 0;
            if (typeof req.height !== "number" || !Number.isInteger(req.height)) return 0;
            const output = execFileSync(VAI_CLI_PATH, [], {
              input: reqJson,
              timeout: 10_000,   // 10 s hard limit — kills with SIGKILL on expiry
              encoding: "utf8",
              killSignal: "SIGKILL",
            });
            const result = JSON.parse(output.trim()) as unknown;
            // Strict type guard — must be exactly a boolean true to succeed
            if (
              typeof result !== "object" || result === null ||
              !("valid" in result) ||
              typeof (result as Record<string, unknown>).valid !== "boolean"
            ) return 0;
            return (result as { valid: boolean }).valid === true ? 1 : 0;
          } catch {
            // Any error (bad JSON, CLI crash, timeout, parse failure) → invalid
            return 0;
          }
        },

        // Writes the address that invoked THIS call (top-level HTTP caller,
        // or the calling contract's own address for a nested call_contract)
        // into memory and returns its length. Empty string if unknown.
        caller_address: (outPtr: number): number => {
          gasUsed += 50;
          writeString(memory, outPtr, callerAddr);
          return callerAddr.length;
        },

        // Reads an address's ledger balance (base units). Returns 0n if no
        // host context is wired (e.g. isolated unit tests).
        balance: (addrPtr: number, addrLen: number): bigint => {
          gasUsed += 200;
          checkGas();
          if (!hostCtx) return 0n;
          const addr = readString(memory, addrPtr, addrLen);
          return BigInt(Math.trunc(hostCtx.getBalance(addr)));
        },

        // Looks up a governance-controlled parameter by name (see
        // ChainParameters in governance.ts for the canonical value/units of
        // each name). Returns -1n for an unknown name or missing host context
        // — contracts must treat a negative result as "param unavailable"
        // since every real parameter value is non-negative.
        gov_param: (namePtr: number, nameLen: number): bigint => {
          gasUsed += 100;
          checkGas();
          if (!hostCtx) return -1n;
          const name = readString(memory, namePtr, nameLen);
          const value = hostCtx.getGovParam(name);
          return value === undefined ? -1n : BigInt(Math.trunc(value));
        },

        // Escrows `amount` from the calling address (caller_address) into
        // this contract's own ledger account. Used for stake bonds — e.g.
        // ModelRegistry.propose() bonds `minimum_bond` from the proposer.
        // Returns 1 on success, 0 if there's no host context, no caller, or
        // insufficient balance (fails closed, no partial transfer).
        bond: (amount: bigint): number => {
          gasUsed += 1_000;
          checkGas();
          if (!hostCtx || !callerAddr) return 0;
          const amt = Number(amount);
          if (!Number.isFinite(amt) || amt <= 0) return 0;
          if (!hostCtx.debit(callerAddr, amt)) return 0;
          hostCtx.credit(address, amt);
          return 1;
        },

        // Pays `amount` out of this contract's own escrowed balance to `to`.
        // Used for slashing rewards, bond refunds, etc. Returns 1 on success,
        // 0 if there's no host context or the contract's balance is short.
        payout: (toPtr: number, toLen: number, amount: bigint): number => {
          gasUsed += 1_000;
          checkGas();
          if (!hostCtx) return 0;
          const to = readString(memory, toPtr, toLen);
          const amt = Number(amount);
          if (!Number.isFinite(amt) || amt <= 0) return 0;
          if (!hostCtx.debit(address, amt)) return 0;
          hostCtx.credit(to, amt);
          return 1;
        },

        // Executes a chain of AMM swaps (one per pool id) starting from
        // `tokenIn`, debiting `amountIn` from THIS contract's own escrowed
        // balance. `poolIdsPtr` points to a comma-separated ASCII list of
        // pool ids (e.g. "EQU-WBTC,WBTC-USDC"). Returns the final output
        // amount, or -1n on any failure (unknown pool, insufficient
        // liquidity, insufficient contract balance).
        dex_multi_swap: (
          poolIdsPtr: number, poolIdsLen: number,
          tokenInPtr: number, tokenInLen: number,
          amountIn: bigint,
        ): bigint => {
          gasUsed += 5_000;
          checkGas();
          if (!hostCtx) return -1n;
          try {
            const poolIds = readString(memory, poolIdsPtr, poolIdsLen).split(",").map(s => s.trim()).filter(Boolean);
            const tokenIn = readString(memory, tokenInPtr, tokenInLen);
            const amt = Number(amountIn);
            if (poolIds.length === 0 || !Number.isFinite(amt) || amt <= 0) return -1n;
            const out = hostCtx.dexMultiSwap(poolIds, tokenIn, amt, address);
            return out === null ? -1n : BigInt(Math.trunc(out));
          } catch {
            return -1n;
          }
        },

        // Deterministic linear-model inference: reads a JSON payload
        // `{ "theta": number[], "x": number[] }` (both fixed-point i64
        // arrays, scaled by 1e9 — same convention as fpEncode in
        // zk-encoding.ts) from memory, computes sigmoid(dot(theta, x))
        // fixed-point-scaled by 1e9, writes it (as decimal ASCII) to
        // outPtr and returns the written length, or -1 on any parse/shape
        // error. This lets a contract (e.g. Arbitrage) run inference against
        // a model's committed parameters without shelling out to a process.
        model_predict: (reqPtr: number, reqLen: number, outPtr: number): number => {
          gasUsed += 2_000;
          checkGas();
          try {
            const req = JSON.parse(readString(memory, reqPtr, reqLen)) as { theta?: number[]; x?: number[] };
            const theta = req.theta;
            const x = req.x;
            if (!Array.isArray(theta) || !Array.isArray(x) || theta.length !== x.length || theta.length === 0) {
              return -1;
            }
            const SCALE = 1_000_000_000;
            let dot = 0;
            for (let i = 0; i < theta.length; i++) {
              dot += (theta[i]! / SCALE) * (x[i]! / SCALE);
            }
            // Deterministic sigmoid approximation (Padé [1,1] near 0,
            // clamped for large |x|). Avoids Math.exp nondeterminism.
            const sigmoid = (() => {
              if (dot >= 8) return 0.999527;
              if (dot <= -8) return 0.000473;
              const exp_approx = (1 + dot + dot * dot / 2) / (1 - dot + dot * dot / 2);
              return 1 / (1 + 1 / exp_approx);
            })();
            const scaled = Math.round(sigmoid * SCALE).toString();
            writeString(memory, outPtr, scaled);
            return scaled.length;
          } catch {
            return -1;
          }
        },

        // Returns the canonical BN254 Groth16 verification key for the
        // Proof-of-Stationarity circuit as a JSON byte blob.  Contracts can
        // call this to independently verify that a block residual was attested
        // by the Rust circuit rather than the TS fallback.
        //
        // Returns 0 if no VK is available (sidecar not running).  Does NOT
        // claim zkML / ERC-7992 model-inference correctness — see LIMITATIONS §7.
        get_verifying_key: (outPtr: number): number => {
          gasUsed += 500;
          checkGas();
          try {
            const vkJson = JSON.stringify(getVerificationKey());
            writeString(memory, outPtr, vkJson);
            return vkJson.length;
          } catch {
            return 0;
          }
        },

        // Verify a Groth16-shaped PoS proof against the TS verification key.
        // Reads a JSON-encoded ZkProof from WASM memory.  Returns 1 if the
        // proof passes verifyZkProof(), 0 otherwise.
        //
        // This is the same check performed by the block-accept path.  Contracts
        // can use it to gate actions on verified PoS attestations.
        //
        // The TS verifier performs the full Groth16 pairing check:
        // e(−π_A,π_B)·e(α,β)·e(vk_x,γ)·e(π_C,δ) = 1_Fp12, plus G1/G2 curve
        // membership and the public residualFp < thresholdFp statement.
        // Note: proofs are generated via the trapdoor formula (not a real
        // circuit witness) — see LIMITATIONS §7 for what this means.
        verify_groth16_proof: (proofPtr: number, proofLen: number): number => {
          gasUsed += 10_000;
          checkGas();
          try {
            const proofJson = readString(memory, proofPtr, proofLen);
            const zkp = JSON.parse(proofJson) as unknown;
            return verifyZkProof(zkp as Parameters<typeof verifyZkProof>[0]) ? 1 : 0;
          } catch {
            return 0;
          }
        },

        // Synchronous cross-contract call. Reads the target address from
        // memory, forwards `argWordCount` i32 words already written at
        // argsPtr (the calling contract is responsible for laying these out
        // itself — there's no HTTP caller to pre-populate them for a nested
        // call), and recurses into `execCall` at depth+1. The child's gas
        // usage is charged to the parent's remaining budget. Returns the
        // child's i32 return value, or -1 on any failure (unknown contract,
        // max depth exceeded, out of gas, or the child call itself failing).
        // Aggregate BLS12-381 public keys (ETH2 / sync-committee style).
        // Reads `n` concatenated compressed G1 pubkeys (48 bytes each) from `pubkeysPtr`.
        // Writes the 48-byte compressed aggregate G1 pubkey to `outPtr`.
        // Returns 1 on success, 0 on failure (invalid input, wrong count, etc).
        // Used by the eth_sync_bridge contract to aggregate sync committee keys.
        bls_aggregate_pubkeys: (pubkeysPtr: number, n: number, outPtr: number): number => {
          gasUsed += 5_000 * n; // O(n) aggregation cost
          checkGas();
          try {
            if (n <= 0 || n > 512) return 0; // Sync committee max size
            const totalLen = n * 48;
            const pubkeysBytes = new Uint8Array(memory.buffer, pubkeysPtr, totalLen);
            const pubkeys: Uint8Array[] = [];
            for (let i = 0; i < n; i++) {
              pubkeys.push(pubkeysBytes.slice(i * 48, (i + 1) * 48));
            }
            // longSignatures mode: G1 pubkeys (48 bytes) + G2 sigs (96 bytes)
            const sigs = bls12_381.longSignatures;
            const aggPoint = sigs.aggregatePublicKeys(pubkeys);
            const aggBytes = aggPoint.toBytes(true); // compressed
            const outView = new Uint8Array(memory.buffer, outPtr, 48);
            outView.set(aggBytes);
            return 1;
          } catch {
            return 0;
          }
        },

        // Verify a BLS12-381 signature (ETH2 / sync-committee style).
        // `pubkeyPtr` → 48-byte compressed G1 pubkey
        // `msgPtr` → message bytes (typically 32-byte signing root)
        // `msgLen` → message length in bytes
        // `sigPtr` → 96-byte compressed G2 signature
        // Returns 1 if valid, 0 if invalid or on any error.
        // Gas: 15,000 per call (one pairing check). Fail-closed on any exception.
        bls_verify: (pubkeyPtr: number, msgPtr: number, msgLen: number, sigPtr: number): number => {
          gasUsed += 15_000; // Pairing check is expensive
          checkGas();
          try {
            const pubkeyBytes = new Uint8Array(memory.buffer, pubkeyPtr, 48).slice();
            const msg = new Uint8Array(memory.buffer, msgPtr, msgLen).slice();
            const sigBytes = new Uint8Array(memory.buffer, sigPtr, 96).slice();
            // longSignatures mode: G1 pubkeys (48 bytes) + G2 sigs (96 bytes)
            const sigs = bls12_381.longSignatures;
            // Hash message onto G2 (signature group for longSignatures)
            // bls12_381.G2 has hashToCurve via the hash-to-curve spec (RFC 9380)
            const G2 = (bls12_381 as unknown as { G2: { hashToCurve(msg: Uint8Array): unknown } }).G2;
            const msgPoint = G2.hashToCurve(msg);
            // sig and pubkey accepted as BLSInput (Uint8Array); message must be WeierstrassPoint
            return (sigs.verify as (s: Uint8Array, m: unknown, p: Uint8Array) => boolean)(
              sigBytes, msgPoint, pubkeyBytes
            ) ? 1 : 0;
          } catch {
            return 0;
          }
        },

        call_contract: (
          addrPtr: number, addrLen: number,
          childMethodId: number,
          argsPtr: number, argWordCount: number,
        ): number => {
          gasUsed += 10_000;
          checkGas();
          const remaining = gasLimit - gasUsed;
          if (remaining <= 0) return -1;
          // SECURITY FIX: snapshot storage before child call for rollback on failure
          const storageSnapshot = new Map<string, string>(Object.entries(storage));
          const restoreStorage = () => {
            for (const k of Object.keys(storage)) delete (storage as Record<string, string>)[k];
            for (const [k, v] of storageSnapshot) (storage as Record<string, string>)[k] = v;
          };
          try {
            const targetAddr = readString(memory, addrPtr, addrLen);
            const childArgs: number[] = [];
            const view = new DataView(memory.buffer);
            for (let i = 0; i < argWordCount; i++) {
              childArgs.push(view.getInt32(argsPtr + i * 4, true));
            }
            const childResult = this.execCall(targetAddr, childMethodId, childArgs, remaining, address, depth + 1);
            if (!childResult.success) {
              restoreStorage(); // ROLLBACK: discard any partial child writes
            }
            gasUsed += childResult.gasUsed;
            for (const l of childResult.logs) logs.push(`[${targetAddr.slice(0, 8)}] ${l}`);
            if (!childResult.success || childResult.returnValue === null) return -1;
            return childResult.returnValue;
          } catch {
            restoreStorage(); // ROLLBACK on exception
            return -1;
          }
        },
      },
    };

    let memory: WebAssembly.Memory;

    try {
      const bytes = hexToBytes(contract.bytecode);
      const module = new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>);
      const instance = new WebAssembly.Instance(module, importObject);

      // Wire up memory (may be exported or in imports)
      memory = (instance.exports.memory as WebAssembly.Memory) ??
        (() => { throw new Error("Contract must export memory"); })();

      if (gasUsed > gasLimit) {
        return { success: false, returnValue: null, gasUsed, logs, error: "Out of gas during init" };
      }

      // Prepare args buffer (write to WASM memory if contract exports alloc)
      const alloc = instance.exports.alloc as ((size: number) => number) | undefined;
      let argsPtr = 0;
      let argsLen = argCount * 4;

      if (alloc && argCount > 0) {
        argsPtr = alloc(argsLen);
        const view = new DataView(memory.buffer);
        for (let i = 0; i < argCount; i++) {
          view.setInt32(argsPtr + i * 4, args[i]!, true);
        }
      }

      const callFn = instance.exports.call as
        ((methodId: number, argsPtr: number, argsLen: number) => number) | undefined;

      let returnValue: number | null = null;

      if (callFn) {
        returnValue = callFn(methodId, argsPtr, argsLen);
        gasUsed += 100;
      } else {
        // Fall back: try to call a named export matching the methodId
        const fn = instance.exports[`fn_${methodId}`] as ((...args: number[]) => number) | undefined;
        if (fn) {
          returnValue = fn(...args);
          gasUsed += 100;
        }
      }

      contract.callCount++;
      contract.totalGasUsed += gasUsed;
      if (logs.length > 0) {
        const events = contract.events ?? (contract.events = []);
        events.push(...logs);
        if (events.length > 200) events.splice(0, events.length - 200);
      }
      this.firePersist(contract);

      return { success: true, returnValue, gasUsed, logs };
    } catch (e) {
      return {
        success: false,
        returnValue: null,
        gasUsed,
        logs,
        error: (e as Error).message,
      };
    }
  }

  getContract(address: string): ContractRecord | undefined {
    return this.contracts.get(address);
  }

  listContracts(): ContractRecord[] {
    return [...this.contracts.values()];
  }

  getStorage(address: string): Record<string, string> {
    return this.contracts.get(address)?.storage ?? {};
  }

  contractCount(): number {
    return this.contracts.size;
  }
}

// ── WASM memory helpers ───────────────────────────────────────────────────────

function readString(memory: WebAssembly.Memory, ptr: number, len: number): string {
  const bytes = new Uint8Array(memory.buffer, ptr, len);
  return new TextDecoder().decode(bytes);
}

function writeString(memory: WebAssembly.Memory, ptr: number, str: string): void {
  const bytes = new TextEncoder().encode(str);
  const view = new Uint8Array(memory.buffer, ptr, bytes.length);
  view.set(bytes);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ── Example contracts ─────────────────────────────────────────────────────────
// Pre-compiled WAT → hex for easy testing without an external toolchain.

// Counter contract (WAT source):
// (module
//   (memory (export "memory") 1)
//   (global $counter (mut i32) (i32.const 0))
//   (func (export "call") (param $methodId i32) (param $argsPtr i32) (param $argsLen i32) (result i32)
//     (if (i32.eq (local.get $methodId) (i32.const 1))
//       (then (global.set $counter (i32.add (global.get $counter) (i32.const 1)))))
//     (global.get $counter))
// )
export const COUNTER_CONTRACT_WAT = `\
(module
  (memory (export "memory") 1)
  (global $counter (mut i32) (i32.const 0))
  (func (export "call") (param $m i32) (param $p i32) (param $l i32) (result i32)
    (if (i32.eq (local.get $m) (i32.const 1))
      (then (global.set $counter (i32.add (global.get $counter) (i32.const 1)))))
    (global.get $counter)
  )
)`;

// Minimal adder (method 1 = add first two i32 args)
export const ADDER_CONTRACT_WAT = `\
(module
  (memory (export "memory") 1)
  (func (export "call") (param $m i32) (param $p i32) (param $l i32) (result i32)
    (if (i32.eq (local.get $m) (i32.const 1))
      (then
        (return (i32.add
          (i32.load (local.get $p))
          (i32.load (i32.add (local.get $p) (i32.const 4)))
        ))
      )
    )
    (i32.const 0)
  )
)`;
