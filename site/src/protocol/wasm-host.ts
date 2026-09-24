import { ARBITRAGE_WASM } from "./arbitrage-wasm";

export interface WasmCall {
  code: number;
  logs: string[];
  storage: Array<[string, string]>;
}

function readStr(memory: WebAssembly.Memory, ptr: number, len: number): string {
  return new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len));
}

function writeStr(memory: WebAssembly.Memory, ptr: number, text: string): number {
  const bytes = new TextEncoder().encode(text);
  new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
  return bytes.length;
}

/**
 * Run the compiled arbitrage contract. Host effects land in `storage`.
 * dex_multi_swap is refused here: pool movement stays on the signed swap path.
 */
export async function callArbitrage(
  methodId: number,
  args: Uint8Array,
  ctx: {
    caller: string;
    storage: Map<string, string>;
    blockNumber: number;
  },
): Promise<WasmCall> {
  const logs: string[] = [];
  let memory: WebAssembly.Memory | undefined;
  const mem = () => {
    if (!memory) throw new Error("wasm memory is not ready");
    return memory;
  };
  const compiled = (await WebAssembly.instantiate(ARBITRAGE_WASM as BufferSource, {
    env: {
      storage_get(keyPtr: number, keyLen: number, resultPtr: number): number {
        const key = readStr(mem(), keyPtr, keyLen);
        const val = ctx.storage.get(key);
        if (!val) return 0;
        return writeStr(mem(), resultPtr, val);
      },
      storage_set(keyPtr: number, keyLen: number, valPtr: number, valLen: number) {
        ctx.storage.set(readStr(mem(), keyPtr, keyLen), readStr(mem(), valPtr, valLen));
      },
      log(ptr: number, len: number) {
        logs.push(readStr(mem(), ptr, len));
      },
      block_number: () => ctx.blockNumber >>> 0,
      caller_address(outPtr: number): number {
        return writeStr(mem(), outPtr, ctx.caller.slice(0, 40));
      },
      gov_param: () => 0,
      dex_multi_swap: () => -1,
      call_contract: () => -1,
    },
  })) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
  const instance = compiled.instance;
  memory = instance.exports.memory as WebAssembly.Memory;
  const alloc = instance.exports.alloc as (size: number) => number;
  const call = instance.exports.call as (method: number, ptr: number, len: number) => number;
  const ptr = args.length ? alloc(args.length) : 0;
  if (args.length) new Uint8Array(memory.buffer, ptr, args.length).set(args);
  const code = call(methodId, ptr, args.length);
  return { code, logs, storage: [...ctx.storage.entries()].sort(([a], [b]) => (a < b ? -1 : 1)) };
}
