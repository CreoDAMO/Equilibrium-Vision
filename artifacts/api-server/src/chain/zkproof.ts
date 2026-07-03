import { createHash, createHmac } from "crypto";

// ── Groth16-style ZK proof for Proof-of-Stationarity ──────────────────────────
//
// Public statement: "I know a gradient path that terminates with residual < threshold"
// Private witness:  The Lagrangian evaluation trajectory (gradient steps)
//
// Proof structure follows BN254 (alt_bn128) Groth16 conventions:
//   π = (π_A ∈ G1, π_B ∈ G2, π_C ∈ G1)
//   Verifier checks: e(π_A, π_B) = e(α, β) · e(Σ public_inputs·IC_i, γ) · e(π_C, δ)

export interface G1Point {
  x: string;
  y: string;
}

export interface G2Point {
  x: [string, string];
  y: [string, string];
}

export interface Groth16Proof {
  pi_a: G1Point;
  pi_b: G2Point;
  pi_c: G1Point;
}

export interface VerificationKey {
  alpha: G1Point;
  beta: G2Point;
  gamma: G2Point;
  delta: G2Point;
  ic: G1Point[];
}

export interface ZkProof {
  proof: Groth16Proof;
  publicInputs: {
    residual: string;
    threshold: string;
    blockHashLow: string;
    blockHashHigh: string;
  };
  vkHash: string;
  valid: boolean;
  provedAt: number;
  circuitId: string;
}

// Deterministic field element from a string (simulated BN254 scalar field)
function fieldElement(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  // BN254 scalar field modulus approximation (254-bit)
  return BigInt("0x" + h).toString(10);
}

function g1Point(seed: string): G1Point {
  const h1 = createHash("sha256").update(seed + ":x").digest("hex");
  const h2 = createHash("sha256").update(seed + ":y").digest("hex");
  return { x: fieldElement(h1), y: fieldElement(h2) };
}

function g2Point(seed: string): G2Point {
  const hx0 = createHash("sha256").update(seed + ":x0").digest("hex");
  const hx1 = createHash("sha256").update(seed + ":x1").digest("hex");
  const hy0 = createHash("sha256").update(seed + ":y0").digest("hex");
  const hy1 = createHash("sha256").update(seed + ":y1").digest("hex");
  return {
    x: [fieldElement(hx0), fieldElement(hx1)],
    y: [fieldElement(hy0), fieldElement(hy1)],
  };
}

// The static verification key for the stationarity circuit (circuit-specific constant)
const STATIONARITY_VK: VerificationKey = {
  alpha: g1Point("equilibrium:vk:alpha"),
  beta:  g2Point("equilibrium:vk:beta"),
  gamma: g2Point("equilibrium:vk:gamma"),
  delta: g2Point("equilibrium:vk:delta"),
  ic: [
    g1Point("equilibrium:vk:ic:0"),
    g1Point("equilibrium:vk:ic:1"),
    g1Point("equilibrium:vk:ic:2"),
    g1Point("equilibrium:vk:ic:3"),
  ],
};

const VK_HASH = createHash("sha256")
  .update(JSON.stringify(STATIONARITY_VK))
  .digest("hex");

const CIRCUIT_ID = "stationarity-v1-bn254-groth16";

// Residual threshold used in proof verification
const DEFAULT_THRESHOLD = 1e-7;

/**
 * Generate a Groth16-style proof that the given residual satisfies:
 *   residual < threshold
 * The proof is deterministically derived from the block context.
 * In production this would call the arkworks/circom proving key.
 */
export function generateZkProof(
  residual: number,
  blockHash: string,
  height: number,
  threshold = DEFAULT_THRESHOLD,
): ZkProof {
  const seed = `${blockHash}-${height}-${residual}`;
  const satisfies = residual < threshold;

  // Public inputs as BN254 scalar field elements
  // residual encoded as fixed-point (residual * 1e18)
  const residualFp = BigInt(Math.floor(residual * 1e18)).toString(10);
  const thresholdFp = BigInt(Math.floor(threshold * 1e18)).toString(10);
  const hashInt = BigInt("0x" + blockHash.slice(0, 32));
  const blockHashLow  = (hashInt & BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF")).toString(10);
  const blockHashHigh = (hashInt >> BigInt(128)).toString(10);

  const proof: Groth16Proof = {
    pi_a: g1Point(seed + ":pi_a"),
    pi_b: g2Point(seed + ":pi_b"),
    pi_c: g1Point(seed + ":pi_c"),
  };

  return {
    proof,
    publicInputs: {
      residual: residualFp,
      threshold: thresholdFp,
      blockHashLow,
      blockHashHigh,
    },
    vkHash: VK_HASH,
    valid: satisfies,
    provedAt: Math.floor(Date.now() / 1000),
    circuitId: CIRCUIT_ID,
  };
}

/**
 * Verify a Groth16 proof against the circuit verification key.
 * In production this would perform the full pairing check on BN254.
 * Here we verify the public inputs are consistent and the residual satisfies threshold.
 */
export function verifyZkProof(zkp: ZkProof, threshold = DEFAULT_THRESHOLD): boolean {
  if (zkp.vkHash !== VK_HASH) return false;
  if (zkp.circuitId !== CIRCUIT_ID) return false;

  // Re-derive threshold field element and compare
  const expectedThresholdFp = BigInt(Math.floor(threshold * 1e18)).toString(10);
  if (zkp.publicInputs.threshold !== expectedThresholdFp) return false;

  // Verify residual satisfies the circuit constraint
  const residual = Number(BigInt(zkp.publicInputs.residual)) / 1e18;
  return residual < threshold;
}

export function getVerificationKey(): VerificationKey {
  return STATIONARITY_VK;
}

export function getVkHash(): string {
  return VK_HASH;
}
