# Equilibrium ZK Circuit Specification

## Overview

Equilibrium uses a Groth16 proof (BN254 elliptic curve) to attest that a mined
block satisfies the Proof-of-Stationarity (PoS) constraint: the Lagrangian
residual is below the network-specified threshold.  This document is the
authoritative specification of the arithmetic circuit.  Any changes to the
circuit **must** be reflected here before updating the sidecar binary or
verifying key.

---

## Circuit Relation

Let **F** be the BN254 scalar field (order `r`):

```
r = 21888242871839275222246405745257275088548364400416034343698204186575808495617
```

The circuit proves the following relation **R**:

```
R((residual_fp, block_hash_low, block_hash_high, threshold_fp) ;
  (nonce, merkle_root_fp, timestamp, prev_hash_fp))
```

Where `;` separates *public* inputs (known to the verifier) from *private*
witnesses (known only to the prover).

---

## Public Inputs

| Index | Name              | Type   | Description                                                                       |
|-------|-------------------|--------|-----------------------------------------------------------------------------------|
| 0     | `residual_fp`     | F      | Fixed-point residual: `floor(residual × 1 000 000 000)` mod r                   |
| 1     | `block_hash_low`  | F      | Lower 128 bits of SHA-256(header bytes) as a field element                       |
| 2     | `block_hash_high` | F      | Upper 128 bits of SHA-256(header bytes) as a field element                       |
| 3     | `threshold_fp`    | F      | Fixed-point threshold: `floor(target_residual × 1 000 000 000)` mod r           |

### Encoding rules (shared between TS fallback and Rust sidecar)

Both sides **must** use the canonical encoder from `zk-encoding.ts` /
`zk_proof.rs`:

```ts
// TypeScript (zk-encoding.ts)
const FIELD_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export function fpEncode(x: number): bigint {
  return BigInt(Math.floor(x * 1_000_000_000)) % FIELD_ORDER;
}
```

```rust
// Rust (zk_proof.rs)
const FIELD_ORDER: u128 = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
pub fn fp_encode(x: f64) -> u128 {
    ((x * 1_000_000_000.0).floor() as u128) % FIELD_ORDER
}
```

---

## Private Witnesses

| Name             | Type   | Description                                                             |
|------------------|--------|-------------------------------------------------------------------------|
| `nonce`          | u64    | Block nonce that achieves the residual                                  |
| `merkle_root_fp` | F      | Merkle root of block transactions, split into two 128-bit halves        |
| `timestamp`      | u64    | Block timestamp (unix seconds)                                          |
| `prev_hash_fp`   | F      | Previous block hash, split into two 128-bit halves                      |

---

## Circuit Constraints

### 1. Hash Preimage Check

```
SHA256(prev_hash_fp || merkle_root_fp || timestamp || nonce) == block_hash
```

The circuit verifies that the claimed block hash is the correct SHA-256 of the
header fields.  Implemented as a SHA-256 gadget over the BN254 field.

### 2. Residual Computation

The Lagrangian residual is computed inside the circuit as:

```
residual = λ₀ · hash_violation²
         + λ₁ · structural_violation²
         + λ₂ · chain_violation²
         + λ₃ · mempool_violation²
         + λ₄ · fee_violation²
```

Where each `violation` term mirrors the computation in `stationary_solver.rs`
and the Lagrange multipliers `λ` are part of the witness.

### 3. Threshold Check

```
residual_fp < threshold_fp
```

This is a range-check constraint using a binary decomposition of the difference
`threshold_fp - residual_fp`, which must be non-negative.

### 4. Fixed-Point Consistency

```
residual_fp == floor(residual × 1_000_000_000)  mod r
```

Ensures the prover cannot claim a lower residual by submitting a different
fixed-point representation.

---

## Verification Key

The Groth16 verifying key (VK) is generated once per circuit version from the
powers-of-tau ceremony.  The VK hash is stored in each block's `zkProof.vkHash`
field.  Nodes reject blocks whose VK hash does not match the current canonical
VK.

**Current canonical VK hash (testnet):** `equilibrium-circuit-v1` (placeholder
until the MPC ceremony completes).

---

## Sidecar Integration

The Rust sidecar (`equilibrium/src/bin/consensus-api.rs`) generates real Groth16
proofs using `ark-groth16` + `ark-bn254`.  The TypeScript fallback
(`chain/zkproof.ts`) uses `@noble/curves` BN254 to simulate proof generation
for testing.

Both implementations **must** produce byte-identical `publicInputs` for the
same block header.  The shared encoder in `chain/zk-encoding.ts` /
`zk_proof.rs::fp_encode` guarantees this.

---

## Audit Checklist

- [ ] Circuit correctly enforces `residual_fp < threshold_fp`
- [ ] Hash preimage gadget matches SHA-256 spec exactly (no endian confusion)
- [ ] Fixed-point scale (1e9) is identical in Rust and TypeScript encoders
- [ ] VK is pinned to the ceremony output and rotated only via governance proposal
- [ ] Verifying key hash check is enforced in `consensus.rs::validate_block`
