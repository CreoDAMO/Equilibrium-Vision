import { createHash } from "crypto";
import { bn254, bn254_Fr } from "@noble/curves/bn254.js";
import type { Fp2 } from "@noble/curves/abstract/tower.js";
import { fpEncode, blockHashToFields } from "./zk-encoding.js";

// ── Groth16-style ZK proof for Proof-of-Stationarity ──────────────────────────
//
// Cryptography: real BN254 (alt_bn128) elliptic curve operations via @noble/curves.
// Proof system:  Simplified Groth16-shaped protocol using actual G1/G2 points.
//
// The proof structure mirrors the full Groth16 wire format (π_A, π_B, π_C) so
// it is compatible with the Rust arkworks verifier once the sidecar is running.
// Point coordinates are genuine BN254 curve points, not hash-derived fake values.
//
// ⚠ Proving: The TS prover is a "deterministic simulation" — it derives real
//   curve points but without a circuit witness.  The Rust consensus-api sidecar
//   (src/bin/consensus-api.rs) produces full Groth16 proofs with a real circuit.
//   The TS prover is the fallback when the sidecar is unavailable.
//
// Verification: Both the TS and Rust verifiers check the same public statement:
//   residual_fp < threshold_fp  (with block hash binding).

// ── BN254 scalar field modulus ────────────────────────────────────────────────

/** BN254 scalar field modulus r (order of G1, G2) */
const Fr_MOD: bigint = bn254_Fr.ORDER;

// ── Point types (wire format) ─────────────────────────────────────────────────

export interface G1Point {
  x: string; // decimal string, Fp element
  y: string;
}

export interface G2Point {
  x: [string, string]; // Fp2 element: [c0, c1]
  y: [string, string];
}

export interface Groth16Proof {
  pi_a: G1Point;
  pi_b: G2Point;
  pi_c: G1Point;
}

export interface VerificationKey {
  alpha: G1Point;
  beta:  G2Point;
  gamma: G2Point;
  delta: G2Point;
  ic:    G1Point[];
}

export interface ZkProof {
  proof:        Groth16Proof;
  publicInputs: {
    residual:      string; // fixed-point decimal (residual × 1e18)
    threshold:     string;
    blockHashLow:  string;
    blockHashHigh: string;
  };
  vkHash:    string;
  valid:     boolean;
  provedAt:  number;
  circuitId: string;
}

// ── Real G1/G2 point derivation ───────────────────────────────────────────────
//
// Derive a G1 point by hashing seed to a scalar then multiplying the generator.
// All resulting points are genuine BN254 G1/G2 points on the curve.

function seedToScalar(seed: string): bigint {
  const h = createHash("sha256").update(seed).digest("hex");
  const raw = BigInt("0x" + h) % Fr_MOD;
  return raw === 0n ? 1n : raw; // never zero (BASE * 0 = infinity)
}

function g1FromSeed(seed: string): G1Point {
  const scalar = seedToScalar(seed);
  const P = bn254.G1.Point.BASE.multiply(scalar);
  const { x, y } = P.toAffine();
  return { x: (x as bigint).toString(), y: (y as bigint).toString() };
}

function g2FromSeed(seed: string): G2Point {
  const scalar = seedToScalar(seed);
  const P = bn254.G2.Point.BASE.multiply(scalar);
  const { x, y } = P.toAffine();
  const xFp2 = x as Fp2;
  const yFp2 = y as Fp2;
  return {
    x: [xFp2.c0.toString(), xFp2.c1.toString()],
    y: [yFp2.c0.toString(), yFp2.c1.toString()],
  };
}

// ── Static verification key (test CRS derived from a fixed seed) ──────────────
//
// In production, replace with the output of the MPC ceremony (matching the
// Rust `keys()` function in zk_proof.rs which uses seed 0xCAFEBABEDEADBEEF).

const STATIONARITY_VK: VerificationKey = {
  alpha: g1FromSeed("equilibrium:vk:alpha"),
  beta:  g2FromSeed("equilibrium:vk:beta"),
  gamma: g2FromSeed("equilibrium:vk:gamma"),
  delta: g2FromSeed("equilibrium:vk:delta"),
  ic: [
    g1FromSeed("equilibrium:vk:ic:0"), // constant term
    g1FromSeed("equilibrium:vk:ic:1"), // residual_fp
    g1FromSeed("equilibrium:vk:ic:2"), // threshold_fp
    g1FromSeed("equilibrium:vk:ic:3"), // block_hash_lo
    g1FromSeed("equilibrium:vk:ic:4"), // block_hash_hi
  ],
};

const VK_HASH = createHash("sha256")
  .update(JSON.stringify(STATIONARITY_VK))
  .digest("hex");

const CIRCUIT_ID = "stationarity-v2-groth16-bn254";

const DEFAULT_THRESHOLD = 1e-7;

// ── Fixed-point encoding ──────────────────────────────────────────────────────
// Canonical implementations live in zk-encoding.ts; re-export for callers
// that already depend on this module's public surface.
export { fpEncode, blockHashToFields as encodeBlockHash } from "./zk-encoding.js";

// ── Proof generation (TS fallback prover) ────────────────────────────────────
//
// Derives real G1/G2 proof points via deterministic scalar multiplication.
// The scalars depend on the block context and the residual value.
// This is NOT a zero-knowledge proof of circuit satisfaction — it uses real
// curve points but without a circuit witness.  Use the Rust sidecar for full
// Groth16 proofs with a real witness.

export function generateZkProof(
  residual:  number,
  blockHash: string,
  height:    number,
  threshold = DEFAULT_THRESHOLD,
): ZkProof {
  const satisfies = residual < threshold;
  const seed      = `${blockHash}-${height}-${residual}`;

  // Public inputs as BN254 scalar field elements
  const residualFp  = fpEncode(residual);
  const thresholdFp = fpEncode(threshold);
  const { blockHashLow, blockHashHigh } = blockHashToFields(blockHash);

  // π_A = BASE * scalar_A,  π_C = BASE * scalar_C  (G1)
  // π_B = G2_BASE * scalar_B                        (G2)
  //
  // Scalars mix the proof seed with the public input digest so the points
  // change whenever the public inputs change.
  const inputDigest = createHash("sha256")
    .update(`${residualFp}:${thresholdFp}:${blockHashLow}:${blockHashHigh}`)
    .digest("hex");
  const pi_a = g1FromSeed(`${seed}:pi_a:${inputDigest}`);
  const pi_b = g2FromSeed(`${seed}:pi_b:${inputDigest}`);
  const pi_c = g1FromSeed(`${seed}:pi_c:${inputDigest}`);

  return {
    proof: { pi_a, pi_b, pi_c },
    publicInputs: { residual: residualFp, threshold: thresholdFp, blockHashLow, blockHashHigh },
    vkHash:   VK_HASH,
    valid:    satisfies,
    provedAt: Math.floor(Date.now() / 1000),
    circuitId: CIRCUIT_ID,
  };
}

// ── Verification ─────────────────────────────────────────────────────────────
//
// Verifies the public-input statement: residual_fp < threshold_fp.
// Also checks that each G1 proof point is a valid BN254 G1 point.
//
// A full pairing-check verifier (e(π_A,π_B) = e(α,β)·…) is omitted because
// the TS prover derives points without a circuit witness — the pairing would
// always fail against a VK from a different circuit.  The Rust sidecar
// (StationarityProof::verify) performs the full pairing check.

function isValidG1(p: G1Point): boolean {
  try {
    const x = BigInt(p.x);
    const y = BigInt(p.y);
    bn254.G1.Point.fromAffine({ x, y }).assertValidity();
    return true;
  } catch {
    return false;
  }
}

export function verifyZkProof(zkp: ZkProof, threshold = DEFAULT_THRESHOLD): boolean {
  if (zkp.vkHash    !== VK_HASH)    return false;
  if (zkp.circuitId !== CIRCUIT_ID) return false;

  // Re-derive expected threshold field element
  const expectedThresholdFp = fpEncode(threshold);
  if (zkp.publicInputs.threshold !== expectedThresholdFp) return false;

  // Verify residual satisfies the circuit constraint
  const residual = Number(BigInt(zkp.publicInputs.residual)) / 1e18;
  if (residual >= threshold) return false;

  // Validate proof points are genuine BN254 G1 points
  if (!isValidG1(zkp.proof.pi_a)) return false;
  if (!isValidG1(zkp.proof.pi_c)) return false;

  return true;
}

export function getVerificationKey(): VerificationKey {
  return STATIONARITY_VK;
}

export function getVkHash(): string {
  return VK_HASH;
}
