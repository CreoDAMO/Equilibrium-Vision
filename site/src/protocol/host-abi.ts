/**
 * Host ABI 1.
 * Caller identity is 40 lowercase hex characters, checked before the call.
 * Storage keys and values are at most 256 UTF-8 bytes, decoded fatally.
 * The module allocates 64 bytes for the caller and 256 for a storage read.
 * A longer write is a refusal, not a write past that buffer.
 */
export const HOST_ABI_ID = "eq-host-abi-1";
export const STORAGE_MAX_BYTES = 256;
export const CALLER_BYTES = 40;

const CALLER = /^[0-9a-f]{40}$/;
const utf8 = new TextEncoder();

/** Stable text hashed into the transition context. A label alone is not the contract. */
export function hostAbiManifest(): string {
  return [
    HOST_ABI_ID,
    "caller:40-lowercase-hex",
    "caller-bytes:40",
    "storage-key-max:256",
    "storage-value-max:256",
    "utf8:fatal",
    "empty-value:absent",
    "storage-get-missing:0",
    "gov-param:0",
    "dex-multi-swap:-1",
    "call-contract:-1",
    "log:not-installed",
    "block-number:uint32",
    "methods:init=0,pause=2,unpause=3",
  ].join("\n");
}

export function canonicalCaller(caller: string): string | null {
  return CALLER.test(caller) ? caller : null;
}

export function decodeHostUtf8(bytes: Uint8Array): string | null {
  if (bytes.length > STORAGE_MAX_BYTES) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Reject a map that cannot be read back within the module buffer. */
export function wasmStorageError(entries: Iterable<[string, string]>): string | null {
  for (const [key, value] of entries) {
    if (utf8.encode(key).length > STORAGE_MAX_BYTES) return "storage key refused";
    if (utf8.encode(value).length > STORAGE_MAX_BYTES) return "storage value refused";
  }
  return null;
}
