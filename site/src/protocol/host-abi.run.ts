/**
 * Host ABI 1. The caller is 40 hex. A bad storage write does not land.
 */
import assert from "node:assert/strict";
import { canonicalCaller, decodeHostUtf8, hostAbiManifest, wasmStorageError } from "./host-abi";
import { encodeContext } from "./transition-proof";
import { NETWORKS } from "./networks";
import { sha256Hex } from "./crypto";
import { callArbitrageSync } from "./wasm-host";

assert.equal(canonicalCaller("ab".repeat(20)), "ab".repeat(20));
assert.equal(canonicalCaller("AB".repeat(20)), null);
assert.equal(canonicalCaller("ab".repeat(20) + "cd"), null);
assert.equal(canonicalCaller("caller"), null);

const utf8 = new TextEncoder();
assert.equal(decodeHostUtf8(utf8.encode("ok")), "ok");
assert.equal(decodeHostUtf8(Uint8Array.of(0xff)), null);
assert.equal(decodeHostUtf8(utf8.encode("x".repeat(257))), null);
assert.equal(wasmStorageError([["k", "x".repeat(257)]]), "storage value refused");
assert.equal(wasmStorageError([["k", "v"]]), null);

const withAbi = sha256Hex(encodeContext(NETWORKS.testnet));
assert.equal(hostAbiManifest().includes("caller:40-lowercase-hex"), true);
assert.notEqual(withAbi, sha256Hex(encodeContext(NETWORKS.mainnet)));

const storage = new Map<string, string>();
const refused = callArbitrageSync(0, utf8.encode("not-a-caller"), {
  caller: "not-a-caller",
  storage,
  blockNumber: 0,
});
assert.equal(refused.refusal, "caller is not 40 hex");
assert.equal(storage.size, 0);

console.log("host abi refuses a non-canonical caller");
