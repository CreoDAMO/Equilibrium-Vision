import { bn254_Fr } from "@noble/curves/bn254.js";

// ── Canonical ZK public-input encoding ───────────────────────────────────────
//
// Single source of truth for converting floating-point residuals and block
// hashes into BN254 scalar field elements.  Both the TS fallback prover
// (zkproof.ts) and the Rust sidecar bridge (consensus-bridge.ts) import from
// here so they always produce bit-identical public inputs for the same block.

/** BN254 scalar field modulus r */
const Fr_MOD: bigint = bn254_Fr.ORDER;

/**
 * Encode a floating-point residual as a BN254 scalar field element.
 * Uses Math.floor (not Math.round) to guarantee a deterministic result.
 * Returns a decimal string suitable for use as a Groth16 public input.
 */
export function fpEncode(val: number): string {
  return (BigInt(Math.floor(val * 1e18)) % Fr_MOD).toString(10);
}

/**
 * Split a block hash into the two BN254 public inputs expected by the
 * stationarity circuit.  Takes the first 32 hex characters (128 bits) of the
 * hash, strips an optional "0x" prefix, then returns:
 *   blockHashLow  — lower 128 bits as a decimal string
 *   blockHashHigh — upper bits (always 0 for a 128-bit input)
 *
 * Both the bridge and the TS prover must call this function so that the
 * reconstructed public inputs are identical regardless of which prover ran.
 */
export function blockHashToFields(hash: string): { blockHashLow: string; blockHashHigh: string } {
  const hex     = hash.startsWith("0x") ? hash.slice(2) : hash;
  const hashInt = BigInt("0x" + hex.slice(0, 32));
  return {
    blockHashLow:  (hashInt & 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFn).toString(10),
    blockHashHigh: (hashInt >> 128n).toString(10),
  };
}
