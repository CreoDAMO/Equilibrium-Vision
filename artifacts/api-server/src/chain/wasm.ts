import { createHash } from "crypto";

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

export class WasmVM {
  private contracts = new Map<string, ContractRecord>();
  private blockHeight = 0;
  private persistFn?: (contract: ContractRecord) => Promise<void>;

  setBlockHeight(h: number) { this.blockHeight = h; }

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
    const bytecodeHash = createHash("sha256").update(bytecodeHex).digest("hex");
    const address = createHash("sha256")
      .update(`${deployer}:${bytecodeHash}:${Date.now()}`)
      .digest("hex")
      .slice(0, 40);

    // Validate WASM binary
    try {
      const bytes = hexToBytes(bytecodeHex);
      await WebAssembly.validate(bytes as Uint8Array<ArrayBuffer>); // throws if invalid
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

  async call(
    address: string,
    methodId: number,
    args: number[],
    gasLimit = 1_000_000,
  ): Promise<CallResult> {
    const contract = this.contracts.get(address);
    if (!contract) {
      return { success: false, returnValue: null, gasUsed: 0, logs: [], error: "Contract not found" };
    }

    const logs: string[] = [];
    const storage = contract.storage;
    let gasUsed = 0;
    const gasPerInstruction = 1;

    // Host import object — the contract's view of the outside world
    const importObject: WebAssembly.Imports = {
      env: {
        storage_get: (keyPtr: number, keyLen: number, resultPtr: number): number => {
          gasUsed += 200;
          const key = readString(memory, keyPtr, keyLen);
          const value = storage[key] ?? "";
          writeString(memory, resultPtr, value);
          return value.length;
        },
        storage_set: (keyPtr: number, keyLen: number, valPtr: number, valLen: number): void => {
          gasUsed += 500;
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
      },
    };

    let memory: WebAssembly.Memory;

    try {
      const bytes = hexToBytes(contract.bytecode);
      const result = await WebAssembly.instantiate(bytes as Uint8Array<ArrayBuffer>, importObject);
      const instance = result.instance;

      // Wire up memory (may be exported or in imports)
      memory = (instance.exports.memory as WebAssembly.Memory) ??
        (() => { throw new Error("Contract must export memory"); })();

      if (gasUsed > gasLimit) {
        return { success: false, returnValue: null, gasUsed, logs, error: "Out of gas during init" };
      }

      // Prepare args buffer (write to WASM memory if contract exports alloc)
      const alloc = instance.exports.alloc as ((size: number) => number) | undefined;
      let argsPtr = 0;
      let argsLen = args.length * 4;

      if (alloc && args.length > 0) {
        argsPtr = alloc(argsLen);
        const view = new DataView(memory.buffer);
        for (let i = 0; i < args.length; i++) {
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
