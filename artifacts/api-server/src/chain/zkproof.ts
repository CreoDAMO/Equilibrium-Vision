import { createHash } from "crypto";
import { bn254, bn254_Fr } from "@noble/curves/bn254.js";
import type { Fp2 } from "@noble/curves/abstract/tower.js";
import { fpEncode, blockHashToFields } from "./zk-encoding.js";

// ── Groth16-style ZK proof for Proof-of-Stationarity ──────────────────────────
//
// Cryptography: real BN254 (alt_bn128) elliptic curve operations via @noble/curves.
// Proof system:  Groth16 protocol using actual G1/G2 points with full pairing
//   verification.
//
// The proof structure mirrors the full Groth16 wire format (π_A, π_B, π_C).
//
// Proving (TS trapdoor simulation):
//   The TS prover derives proof points using the known VK trapdoor scalars
//   (all VK points are generated from deterministic seeds, so their discrete
//   logs are known).  This produces proofs that satisfy the Groth16 pairing
//   equation without a circuit witness:
//     c = (a·b − α_s·β_s − vkX_s·γ_s) · δ_s⁻¹  (mod Fr)
//   The Rust consensus-api sidecar produces full Groth16 proofs with a real
//   circuit witness.  The TS prover is the fallback when the sidecar is
//   unavailable.
//
// Verification: Full Groth16 pairing check (both TS and Rust paths):
//   e(−π_A, π_B) · e(α, β) · e(vk_x, γ) · e(π_C, δ) = 1_Fp12
//   with the additional public-input constraint: residual_fp < threshold_fp.

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

/** Whether the TS trapdoor prover is allowed. False in production. */
const ALLOW_TS_PROVER = process.env["ALLOW_TS_TRAPDOOR_PROVER"] === "true";

/** Proof source discriminator for validation gating. */
export const PROOF_SOURCE_RUST = "rust-sidecar";
export const PROOF_SOURCE_TS_TRAPDOOR = "ts-trapdoor";

// ── VK trapdoor scalars ───────────────────────────────────────────────────────
//
// The VK is derived from deterministic seeds, so we know the discrete
// logarithms of every VK point w.r.t. the curve generators (the trapdoor).
// The prover uses these to compute π_C such that the Groth16 pairing equation
// holds exactly — no circuit witness required (trapdoor simulation).
//
// If this is ever replaced by an MPC-ceremony CRS, store the ceremony α/β/γ/δ
// exponents here (or derive π_C from the real witness instead).

const VK_ALPHA_S: bigint = seedToScalar("equilibrium:vk:alpha");
const VK_BETA_S:  bigint = seedToScalar("equilibrium:vk:beta");
const VK_GAMMA_S: bigint = seedToScalar("equilibrium:vk:gamma");
const VK_DELTA_S: bigint = seedToScalar("equilibrium:vk:delta");
const VK_IC_S:    bigint[] = [0, 1, 2, 3, 4].map(i =>
  seedToScalar(`equilibrium:vk:ic:${i}`),
);

/** Fast modular exponentiation (binary method). */
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** Modular multiplicative inverse via Fermat's little theorem (mod must be prime). */
function modInverse(a: bigint, mod: bigint): bigint {
  return modPow(a, mod - 2n, mod);
}

/**
 * Compute the vk_x "exponent" scalar from public inputs and known IC trapdoors.
 *   vk_x_s = IC_s[0] + Σ(inputs[i] · IC_s[i+1])  (mod Fr)
 */
function vkXScalar(inputs: bigint[]): bigint {
  let acc = VK_IC_S[0];
  for (let i = 0; i < inputs.length; i++) {
    acc = (acc + (inputs[i] % Fr_MOD) * VK_IC_S[i + 1]) % Fr_MOD;
  }
  return acc;
}

// ── Fixed-point encoding ──────────────────────────────────────────────────────
// Canonical implementations live in zk-encoding.ts; re-export for callers
// that already depend on this module's public surface.
export { fpEncode, blockHashToFields as encodeBlockHash } from "./zk-encoding.js";

// ── Point helpers ─────────────────────────────────────────────────────────────

function toG1Proj(p: G1Point) {
  return bn254.G1.Point.fromAffine({ x: BigInt(p.x), y: BigInt(p.y) });
}

function toG2Proj(p: G2Point) {
  return bn254.G2.Point.fromAffine({
    x: { c0: BigInt(p.x[0]), c1: BigInt(p.x[1]) } as Fp2,
    y: { c0: BigInt(p.y[0]), c1: BigInt(p.y[1]) } as Fp2,
  });
}

// ── Proof generation (TS trapdoor prover) ─────────────────────────────────────
//
// Computes π_A = a·G1 and π_B = b·G2 from deterministic seeds, then derives
// π_C using the Groth16 trapdoor formula so the pairing equation is satisfied:
//
//   c = (a·b − α_s·β_s − vkX_s·γ_s) · δ_s⁻¹  (mod Fr)
//
// This guarantees: e(−π_A,π_B) · e(α,β) · e(vk_x,γ) · e(π_C,δ) = 1_Fp12.
// Use the Rust consensus-api sidecar for proofs with a real circuit witness.

export function generateZkProof(
  residual:  number,
  blockHash: string,
  height:    number,
  threshold = DEFAULT_THRESHOLD,
): ZkProof {
  // MAINNET SAFETY: trapdoor proofs are not accepted on mainnet.
  if (!ALLOW_TS_PROVER) {
    throw new Error("TS trapdoor prover is disabled in production. Use the Rust consensus-api sidecar.");
  }

  const satisfies = residual < threshold;
  const seed      = `${blockHash}-${height}-${residual}`;

  // Public inputs as BN254 scalar field elements
  const residualFp  = fpEncode(residual);
  const thresholdFp = fpEncode(threshold);
  const { blockHashLow, blockHashHigh } = blockHashToFields(blockHash);

  const inputDigest = createHash("sha256")
    .update(`${residualFp}:${thresholdFp}:${blockHashLow}:${blockHashHigh}`)
    .digest("hex");

  // π_A and π_B scalars — deterministic from proof seed + public input digest
  const a = seedToScalar(`${seed}:pi_a:${inputDigest}`);
  const b = seedToScalar(`${seed}:pi_b:${inputDigest}`);

  // π_C scalar via trapdoor: c = (a·b − α_s·β_s − vkX_s·γ_s) · δ_s⁻¹
  const pubInputs: bigint[] = [
    BigInt(residualFp)    % Fr_MOD,
    BigInt(thresholdFp)   % Fr_MOD,
    BigInt(blockHashLow)  % Fr_MOD,
    BigInt(blockHashHigh) % Fr_MOD,
  ];
  const vkX_s     = vkXScalar(pubInputs);
  const ab        = (a * b) % Fr_MOD;
  const alphaBeta = (VK_ALPHA_S * VK_BETA_S) % Fr_MOD;
  const vkXGamma  = (vkX_s * VK_GAMMA_S) % Fr_MOD;
  // (ab − alphaBeta − vkXGamma) mod Fr — add 2·Fr to keep positive
  const numerator = ((ab - alphaBeta - vkXGamma) % Fr_MOD + 2n * Fr_MOD) % Fr_MOD;
  const c         = (numerator * modInverse(VK_DELTA_S, Fr_MOD)) % Fr_MOD;

  // Compute the three proof points
  const piAPt = bn254.G1.Point.BASE.multiply(a);
  const piBPt = bn254.G2.Point.BASE.multiply(b);
  const piCPt = bn254.G1.Point.BASE.multiply(c);

  const { x: axBig, y: ayBig }   = piAPt.toAffine();
  const { x: bxFp2, y: byFp2 }   = piBPt.toAffine();
  const { x: cxBig, y: cyBig }   = piCPt.toAffine();

  const pi_a: G1Point = {
    x: (axBig as bigint).toString(),
    y: (ayBig as bigint).toString(),
  };
  const pi_b: G2Point = {
    x: [(bxFp2 as Fp2).c0.toString(), (bxFp2 as Fp2).c1.toString()],
    y: [(byFp2 as Fp2).c0.toString(), (byFp2 as Fp2).c1.toString()],
  };
  const pi_c: G1Point = {
    x: (cxBig as bigint).toString(),
    y: (cyBig as bigint).toString(),
  };

  return {
    proof: { pi_a, pi_b, pi_c },
    publicInputs: { residual: residualFp, threshold: thresholdFp, blockHashLow, blockHashHigh },
    vkHash:    VK_HASH,
    valid:     satisfies,
    provedAt:  Math.floor(Date.now() / 1000),
    circuitId: CIRCUIT_ID,
  };
}

// ── Verification ─────────────────────────────────────────────────────────────
//
// Full Groth16 pairing check via multi-pairing:
//   e(−π_A, π_B) · e(α, β) · e(vk_x, γ) · e(π_C, δ) = 1_Fp12
//
// Where vk_x = IC[0] + Σ(pubInput_i · IC[i+1])  (G1 accumulator).
//
// Uses bn254.pairingBatch so all four Miller loops share a single final
// exponentiation — roughly 4× faster than four separate bn254.pairing calls.
//
// Verifies proofs from both the TS trapdoor prover and the Rust consensus-api
// sidecar, provided both use the same seed-derived VK.

/**
 * Full Groth16 multi-pairing check against STATIONARITY_VK.
 *
 * Runs the four Miller loops in a single batch and applies one final
 * exponentiation, then checks the result equals 1 in Fp12.
 *
 * Returns true iff e(−π_A,π_B)·e(α,β)·e(vk_x,γ)·e(π_C,δ) = 1_Fp12.
 */
function verifyPairing(proof: Groth16Proof, publicInputValues: bigint[]): boolean {
  try {
    const piA   = toG1Proj(proof.pi_a);
    const piB   = toG2Proj(proof.pi_b);
    const piC   = toG1Proj(proof.pi_c);
    const alpha = toG1Proj(STATIONARITY_VK.alpha);
    const beta  = toG2Proj(STATIONARITY_VK.beta);
    const gamma = toG2Proj(STATIONARITY_VK.gamma);
    const delta = toG2Proj(STATIONARITY_VK.delta);

    // vk_x = IC[0] + Σ(inputs[i] · IC[i+1])
    let vkX = toG1Proj(STATIONARITY_VK.ic[0]);
    for (let i = 0; i < publicInputValues.length; i++) {
      const scalar = publicInputValues[i] % Fr_MOD;
      if (scalar > 0n) {
        vkX = vkX.add(toG1Proj(STATIONARITY_VK.ic[i + 1]).multiply(scalar));
      }
    }

    // Multi-pairing: four Miller loops + one final exponentiation.
    // bn254.pairingBatch(pairs, withFinalExponent=true) returns
    // finalExp( ∏ millerLoop(g1_i, g2_i) ) which must equal Fp12.ONE.
    const result = bn254.pairingBatch([
      { g1: piA.negate(), g2: piB   },
      { g1: alpha,        g2: beta  },
      { g1: vkX,         g2: gamma },
      { g1: piC,         g2: delta },
    ]);

    return bn254.fields.Fp12.eql(result, bn254.fields.Fp12.ONE);
  } catch {
    return false;
  }
}

function isValidG1(p: G1Point): boolean {
  try {
    toG1Proj(p).assertValidity();
    return true;
  } catch {
    return false;
  }
}

function isValidG2(p: G2Point): boolean {
  try {
    toG2Proj(p).assertValidity();
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

  // Validate proof points are on the correct curves before pairing
  if (!isValidG1(zkp.proof.pi_a)) return false;
  if (!isValidG2(zkp.proof.pi_b)) return false;
  if (!isValidG1(zkp.proof.pi_c)) return false;

  // Full Groth16 pairing check
  const pubInputValues: bigint[] = [
    BigInt(zkp.publicInputs.residual)      % Fr_MOD,
    BigInt(zkp.publicInputs.threshold)     % Fr_MOD,
    BigInt(zkp.publicInputs.blockHashLow)  % Fr_MOD,
    BigInt(zkp.publicInputs.blockHashHigh) % Fr_MOD,
  ];
  if (!verifyPairing(zkp.proof, pubInputValues)) return false;

  return true;
}

export function getVerificationKey(): VerificationKey {
  return STATIONARITY_VK;
}

export function getVkHash(): string {
  return VK_HASH;
}
