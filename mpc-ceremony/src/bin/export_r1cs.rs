//! Export the ark StationarityCircuit R1CS in snarkjs binary format.
//!
//! Usage:
//!   cargo run --release --bin export-r1cs --manifest-path mpc-ceremony/Cargo.toml -- \
//!       --output stationarity.r1cs
//!
//! Feed into:
//!   snarkjs groth16 setup stationarity.r1cs pot_final.ptau circuit_0000.zkey
//!
//! MUST use the same OptimizationGoal as dump-witness and prove-time synthesis.
//!
//! Constraint coefficients are written in **canonical** little-endian form
//! (`into_bigint().to_bytes_le()`), matching Atamanov/arkworks-rapidsnark and
//! snarkjs field element convention for .r1cs section 2.

use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField, Zero};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystem, OptimizationGoal};
use equilibrium::zk_proof::StationarityCircuit;
use std::fs;
use std::path::Path;

/// Declared private inputs only (difference + diff_inv). Bit wires are intermediates.
const N_DECLARED_PRV_INPUTS: u32 = 2;

fn write_r1cs(output: &Path) -> Result<(), String> {
    let cs = ConstraintSystem::<Fr>::new_ref();
    // Lock matrix layout — must match dump-witness and any prove-time CS.
    cs.set_optimization_goal(OptimizationGoal::Constraints);

    let circuit = StationarityCircuit {
        residual_fp: Some(3_000_000_000_000_000),
        threshold_fp: Some(7_000_000_000_000_000),
        block_hash_lo: Some(0xDEAD_BEEF),
        block_hash_hi: Some(0xCAFE_BABE),
        difference: Some(4_000_000_000_000_000),
    };
    circuit
        .generate_constraints(cs.clone())
        .map_err(|e| format!("generate_constraints: {e}"))?;
    cs.finalize();

    if !cs.is_satisfied().map_err(|e| format!("is_satisfied: {e}"))? {
        return Err("constraint system not satisfied — fix the witness before exporting".into());
    }

    let matrices = cs
        .to_matrices()
        .ok_or_else(|| "to_matrices() returned None".to_string())?;

    let n_instance = matrices.num_instance_variables; // 1 (One) + n_pub
    let n_witness = matrices.num_witness_variables;
    let n_vars = n_instance + n_witness;
    let n_pub = n_instance - 1;
    let n_constraints = matrices.num_constraints;
    let n_prv = N_DECLARED_PRV_INPUTS.min(n_witness as u32);

    if n_pub != 4 {
        return Err(format!("expected 4 public inputs, got {n_pub}"));
    }

    println!(
        "[r1cs] nVars={n_vars}  nPub={n_pub}  nPrvDeclared={n_prv}  \
         nWitnessTotal={n_witness}  nConstraints={n_constraints}  goal=Constraints  coeffs=canonical"
    );

    let modulus = <Fr as PrimeField>::MODULUS;
    let prime_vec = modulus.to_bytes_le();
    let mut prime32 = [0u8; 32];
    prime32[..prime_vec.len().min(32)].copy_from_slice(&prime_vec[..prime_vec.len().min(32)]);

    // Canonical (standard) LE — same as dump-witness and Atamanov R1CS export.
    // Do NOT write raw Montgomery limbs (f.0); snarkjs treats .r1cs coeffs as
    // standard field elements.
    let fe_bytes = |f: &Fr| -> [u8; 32] {
        let v = f.into_bigint().to_bytes_le();
        let mut out = [0u8; 32];
        out[..v.len().min(32)].copy_from_slice(&v[..v.len().min(32)]);
        out
    };

    // Section 1 — Header
    let mut hdr: Vec<u8> = Vec::new();
    hdr.extend_from_slice(&32u32.to_le_bytes());
    hdr.extend_from_slice(&prime32);
    hdr.extend_from_slice(&(n_vars as u32).to_le_bytes());
    hdr.extend_from_slice(&0u32.to_le_bytes()); // nOutputs
    hdr.extend_from_slice(&(n_pub as u32).to_le_bytes());
    hdr.extend_from_slice(&n_prv.to_le_bytes());
    hdr.extend_from_slice(&(n_vars as u64).to_le_bytes()); // nLabels
    hdr.extend_from_slice(&(n_constraints as u32).to_le_bytes());

    // Section 2 — Constraints (A,B,C per row; terms sorted by wire_id)
    let mut con: Vec<u8> = Vec::new();
    for i in 0..n_constraints {
        for mat in [&matrices.a[i], &matrices.b[i], &matrices.c[i]] {
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

    // Section 3 — Wire-to-label (identity)
    let mut lbl: Vec<u8> = Vec::with_capacity(n_vars * 8);
    for i in 0..n_vars {
        lbl.extend_from_slice(&(i as u64).to_le_bytes());
    }

    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(b"r1cs");
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(&3u32.to_le_bytes());

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
