import { ARBITRAGE_WASM } from "./arbitrage-wasm";
import { canonicalCaller, decodeHostUtf8, STORAGE_MAX_BYTES } from "./host-abi";

export interface WasmCall {
  code: number;
  logs: string[];
  storage: Array<[string, string]>;
  refusal?: string;
}

function instantiate(bytes: BufferSource, imports: WebAssembly.Imports): WebAssembly.Instance {
  return new WebAssembly.Instance(new WebAssembly.Module(bytes), imports);
}

/**
 * Run the compiled arbitrage contract. Host effects land in `storage`.
 * dex_multi_swap is refused here: pool movement stays on the signed swap path.
 * The instance is built synchronously so local sealing and external admission
 * call one interpreter.
 */
export function callArbitrageSync(
  methodId: number,
  args: Uint8Array,
  ctx: {
    caller: string;
    storage: Map<string, string>;
    blockNumber: number;
  },
): WasmCall {
  const caller = canonicalCaller(ctx.caller);
  if (!caller) {
    return { code: 0, logs: [], storage: [...ctx.storage.entries()], refusal: "caller is not 40 hex" };
  }
  const logs: string[] = [];
  const overlay = new Map<string, string>();
  let refusal: string | null = null;
  let memory: WebAssembly.Memory | undefined;
  const mem = () => {
    if (!memory) throw new Error("wasm memory is not ready");
    return memory;
  };
  const bytesAt = (ptr: number, len: number): Uint8Array | null => {
    if (!Number.isInteger(ptr) || !Number.isInteger(len) || ptr < 0 || len < 0) return null;
    if (len > STORAGE_MAX_BYTES) return null;
    const view = new Uint8Array(mem().buffer, ptr, len);
    return view.slice();
  };
  const instance = instantiate(ARBITRAGE_WASM as BufferSource, {
    env: {
      storage_get(keyPtr: number, keyLen: number, resultPtr: number): number {
        const raw = bytesAt(keyPtr, keyLen);
        const key = raw && decodeHostUtf8(raw);
        if (!key) {
          refusal = "storage key refused";
          return 0;
        }
        const val = overlay.has(key) ? overlay.get(key) : ctx.storage.get(key);
        if (!val) return 0;
        const encoded = new TextEncoder().encode(val);
        if (encoded.length > STORAGE_MAX_BYTES) {
          refusal = "storage value refused";
          return 0;
        }
        new Uint8Array(mem().buffer, resultPtr, encoded.length).set(encoded);
        return encoded.length;
      },
      storage_set(keyPtr: number, keyLen: number, valPtr: number, valLen: number) {
        const keyRaw = bytesAt(keyPtr, keyLen);
        const valRaw = bytesAt(valPtr, valLen);
        const key = keyRaw && decodeHostUtf8(keyRaw);
        const val = valRaw && decodeHostUtf8(valRaw);
        if (!key || val === null) {
          refusal = "storage write refused";
          return;
        }
        overlay.set(key, val);
      },
      log(ptr: number, len: number) {
        const raw = bytesAt(ptr, len);
        const line = raw && decodeHostUtf8(raw);
        if (line) logs.push(line);
      },
      block_number: () => ctx.blockNumber >>> 0,
      caller_address(outPtr: number): number {
        const encoded = new TextEncoder().encode(caller);
        new Uint8Array(mem().buffer, outPtr, encoded.length).set(encoded);
        return encoded.length;
      },
      gov_param: () => 0,
      dex_multi_swap: () => -1,
      call_contract: () => -1,
    },
  });
  memory = instance.exports.memory as WebAssembly.Memory;
  const alloc = instance.exports.alloc as (size: number) => number;
  const call = instance.exports.call as (method: number, ptr: number, len: number) => number;
  const ptr = args.length ? alloc(args.length) : 0;
  if (args.length) new Uint8Array(memory.buffer, ptr, args.length).set(args);
  const code = call(methodId, ptr, args.length);
  if (refusal) {
    return { code: 0, logs, storage: [...ctx.storage.entries()], refusal };
  }
  for (const [key, value] of overlay) ctx.storage.set(key, value);
  return { code, logs, storage: [...ctx.storage.entries()].sort(([a], [b]) => (a < b ? -1 : 1)) };
}

export async function callArbitrage(
  methodId: number,
  args: Uint8Array,
  ctx: {
    caller: string;
    storage: Map<string, string>;
    blockNumber: number;
  },
): Promise<WasmCall> {
  return callArbitrageSync(methodId, args, ctx);
}
