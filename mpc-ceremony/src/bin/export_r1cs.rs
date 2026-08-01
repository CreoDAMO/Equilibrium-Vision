//! Export the ark StationarityCircuit R1CS in snarkjs binary format.
//!
//! Usage:
//!   cargo run --release --bin export-r1cs -- --output stationarity.r1cs
//!
//! The exported .r1cs can be fed directly into:
//!   snarkjs groth16 setup stationarity.r1cs pot_final.ptau circuit_0000.zkey
//!
//! Because the R1CS is generated from the SAME ark circuit used for proving,
//! keys produced by the ceremony are guaranteed to be compatible.

use ark_bn254::Fr;
use ark_ff::{BigInteger, One, PrimeField, Zero};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystem};
use equilibrium::zk_proof::StationarityCircuit;
use std::fs;
use std::path::Path;

// ── snarkjs R1CS binary format ────────────────────────────────────────────────
//
// Outer wrapper (all LE):
//   magic "r1cs" (4B) | version u32 | nSections u32
//   for each section: type u32 | size u64 | data [u8; size]
//
// Section 1 — Header:
//   n8 u32 (field elem bytes = 32) | prime [u8; 32] | nVars u32 | nOutputs u32
//   nPubInputs u32 | nPrvInputs u32 | nLabels u64 | nConstraints u32
//
// Section 2 — Constraints:
//   for each constraint: A then B then C
//     nTerms u32 | for each term: wireId u32 | value [u8; 32] (coeff in Montgomery form LE)
//
// Section 3 — Wire-to-label:
//   for each wire: label u64 (= wire index)

/// Declared private *inputs* in StationarityCircuit (not intermediate bit wires).
/// `difference` + `diff_inv` = 2 signals. Bit-decomp wires are intermediates.
const N_DECLARED_PRV_INPUTS: u32 = 2;

fn write_r1cs(output: &Path) -> Result<(), String> {
    // ── Build constraint system with a valid satisfying witness ───────────────
    // The witness must satisfy all constraints so is_satisfied() passes.
    let cs = ConstraintSystem::<Fr>::new_ref();
    let circuit = StationarityCircuit {
        residual_fp:   Some(3_000_000_000_000_000),
        threshold_fp:  Some(7_000_000_000_000_000),
        block_hash_lo: Some(0xDEAD_BEEF),
        block_hash_hi: Some(0xCAFE_BABE),
        difference:    Some(4_000_000_000_000_000),
    };
    circuit
        .generate_constraints(cs.clone())
        .map_err(|e| format!("generate_constraints: {e}"))?;
    cs.finalize();

    // Fail early rather than exporting an unsatisfiable R1CS.
    if !cs.is_satisfied().map_err(|e| format!("is_satisfied: {e}"))? {
        return Err("constraint system not satisfied — fix the witness before exporting".into());
    }

    let matrices = cs
        .to_matrices()
        .ok_or_else(|| "to_matrices() returned None".to_string())?;

    let n_instance    = matrices.num_instance_variables; // 1 (One) + n_pub
    let n_witness     = matrices.num_witness_variables;
    let n_vars        = n_instance + n_witness;
    let n_pub         = n_instance - 1;                  // public inputs (excl. wire 0)
    let n_constraints = matrices.num_constraints;

    // nPrvInputs in the snarkjs header = declared private signals only,
    // NOT total witness variables (which includes intermediate bit-decomp wires).
    let n_prv = N_DECLARED_PRV_INPUTS.min(n_witness as u32);

    if n_pub != 4 {
        return Err(format!("expected 4 public inputs, got {n_pub}"));
    }

    println!(
        "[r1cs] nVars={n_vars}  nPub={n_pub}  nPrvDeclared={n_prv}  \
         nWitnessTotal={n_witness}  nConstraints={n_constraints}"
    );

    // ── Field prime (BN254 scalar field Fr) in LE ─────────────────────────────
    let modulus   = <Fr as PrimeField>::MODULUS;
    let prime_vec = modulus.to_bytes_le();
    let mut prime32 = [0u8; 32];
    prime32[..prime_vec.len().min(32)].copy_from_slice(&prime_vec[..prime_vec.len().min(32)]);

    // ── Helper: field element → 32-byte LE (Montgomery form) ─────────────────
    //
    // snarkjs R1CS binary stores constraint coefficients in **Montgomery form**
    // (via ffjavascript's `Fr.toRprLE`).  ark-ff stores Fr internally as
    // `v * R mod p` (Montgomery form) in the `.0` limbs.  Calling
    // `into_bigint()` performs the Montgomery reduction to canonical form —
    // that is the WRONG representation for snarkjs.  Read the raw limbs with
    // `f.0.to_bytes_le()` instead so the ceremony keys are built from the same
    // Montgomery-form coefficients that ark uses during proving.
    let fe_bytes = |f: &Fr| -> [u8; 32] {
        let v = f.0.to_bytes_le();
        let mut out = [0u8; 32];
        out[..v.len().min(32)].copy_from_slice(&v[..v.len().min(32)]);
        out
    };

    // ── Section 1: Header ─────────────────────────────────────────────────────
    let mut hdr: Vec<u8> = Vec::new();
    hdr.extend_from_slice(&32u32.to_le_bytes());                  // n8
    hdr.extend_from_slice(&prime32);                              // prime
    hdr.extend_from_slice(&(n_vars as u32).to_le_bytes());        // nVars
    hdr.extend_from_slice(&0u32.to_le_bytes());                   // nOutputs
    hdr.extend_from_slice(&(n_pub as u32).to_le_bytes());         // nPubInputs
    hdr.extend_from_slice(&n_prv.to_le_bytes());                  // nPrvInputs (declared only)
    hdr.extend_from_slice(&(n_vars as u64).to_le_bytes());        // nLabels
    hdr.extend_from_slice(&(n_constraints as u32).to_le_bytes()); // nConstraints

    // ── Section 2: Constraints — terms sorted by wire_id (snarkjs requirement) ─
    let mut con: Vec<u8> = Vec::new();
    for i in 0..n_constraints {
        for mat in [&matrices.a[i], &matrices.b[i], &matrices.c[i]] {
            // Collect, sort by wire id, merge duplicates, drop zeros.
            let mut terms: Vec<(u32, Fr)> = mat
                .iter()
                .filter(|(coeff, _)| !coeff.is_zero())
                .map(|(coeff, wire)| (*wire as u32, *coeff))
                .collect();
            terms.sort_by_key(|(w, _)| *w);

            let mut merged: Vec<(u32, Fr)> = Vec::new();
            for (w, c) in terms {
                match merged.last_mut() {
                    Some(last) if last.0 == w => last.1 += c,
                    _ => merged.push((w, c)),
                }
            }
            merged.retain(|(_, c)| !c.is_zero());

            con.extend_from_slice(&(merged.len() as u32).to_le_bytes());
            for (wire_id, coeff) in merged {
                con.extend_from_slice(&wire_id.to_le_bytes());
                con.extend_from_slice(&fe_bytes(&coeff));
            }
        }
    }

    // ── Section 3: Wire-to-label (identity mapping) ───────────────────────────
    let mut lbl: Vec<u8> = Vec::with_capacity(n_vars * 8);
    for i in 0..n_vars {
        lbl.extend_from_slice(&(i as u64).to_le_bytes());
    }

    // ── Assemble binary ───────────────────────────────────────────────────────
    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(b"r1cs");             // magic
    out.extend_from_slice(&1u32.to_le_bytes()); // version
    out.extend_from_slice(&3u32.to_le_bytes()); // nSections

    for (ty, data) in [(1u32, &hdr), (2u32, &con), (3u32, &lbl)] {
        out.extend_from_slice(&ty.to_le_bytes());
        out.extend_from_slice(&(data.len() as u64).to_le_bytes());
        out.extend_from_slice(data);
    }

    fs::write(output, &out).map_err(|e| format!("write: {e}"))?;
    println!("[r1cs] wrote {} ({} bytes)", output.display(), out.len());
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let output = args
        .windows(2)
        .find(|w| w[0] == "--output")
        .map(|w| w[1].as_str())
        .unwrap_or("stationarity.r1cs");

    write_r1cs(Path::new(output)).unwrap_or_else(|e| {
        eprintln!("[export-r1cs] FATAL: {e}");
        std::process::exit(1);
    });
}
