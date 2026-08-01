//! Dump full assignment (instance || witness) as LE 32-byte canonical Fr values.
//!
//! Usage:
//!   cargo run --release --bin dump-witness --manifest-path mpc-ceremony/Cargo.toml -- \
//!       --output witness_raw.bin
//!
//! MUST use the same OptimizationGoal and circuit values as export-r1cs.

use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystem, OptimizationGoal};
use equilibrium::zk_proof::StationarityCircuit;
use std::fs;
use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let output = args
        .windows(2)
        .find(|w| w[0] == "--output")
        .map(|w| w[1].as_str())
        .unwrap_or("witness.bin");

    let cs = ConstraintSystem::<Fr>::new_ref();
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
        .expect("generate_constraints");
    cs.finalize();

    assert!(cs.is_satisfied().unwrap(), "circuit not satisfied!");

    let matrices = cs.to_matrices().expect("to_matrices");
    println!(
        "[dump] nVars={}  nInstance={}  nWitness={}  nConstraints={}  goal=Constraints",
        matrices.num_instance_variables + matrices.num_witness_variables,
        matrices.num_instance_variables,
        matrices.num_witness_variables,
        matrices.num_constraints
    );

    let cs_ref = cs.borrow().unwrap();
    let instance = &cs_ref.instance_assignment;
    let witness = &cs_ref.witness_assignment;

    // Canonical (standard) form LE — snarkjs wtns / public signals use this, not Montgomery.
    let mut out = Vec::with_capacity((instance.len() + witness.len()) * 32);
    for val in instance.iter().chain(witness.iter()) {
        let bytes = val.into_bigint().to_bytes_le();
        let mut buf = [0u8; 32];
        buf[..bytes.len().min(32)].copy_from_slice(&bytes[..bytes.len().min(32)]);
        out.extend_from_slice(&buf);
    }

    fs::write(Path::new(output), &out).expect("write witness.bin");
    println!("[dump] wrote {} ({} bytes)", output, out.len());
}
