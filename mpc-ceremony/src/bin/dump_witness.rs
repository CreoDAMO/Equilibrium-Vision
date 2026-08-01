//! Dump the full witness (instance + witness assignments) as little-endian 32-byte Fr values.
//! Output format matches the snarkjs wtns section 2 layout so a Node script can wrap it.
//!
//! Usage:
//!   cargo run --bin dump-witness -- --output witness.bin

use ark_bn254::Fr;
use ark_ff::PrimeField;
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystem};
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
    cs.set_optimization_goal(ark_relations::r1cs::OptimizationGoal::Constraints);

    let circuit = StationarityCircuit {
        residual_fp:   Some(3_000_000_000_000_000),
        threshold_fp:  Some(7_000_000_000_000_000),
        block_hash_lo: Some(0xDEAD_BEEF),
        block_hash_hi: Some(0xCAFE_BABE),
        difference:    Some(4_000_000_000_000_000),
    };
    circuit.generate_constraints(cs.clone()).expect("generate_constraints");
    cs.finalize();

    assert!(cs.is_satisfied().unwrap(), "circuit not satisfied!");

    let cs_ref = cs.borrow().unwrap();
    let instance = &cs_ref.instance_assignment; // [One, pub_in[0..3]]
    let witness  = &cs_ref.witness_assignment;   // [prv_in[0..], intermediates...]

    let total = instance.len() + witness.len();
    println!("[dump] nVars={total}  nInstance={}  nWitness={}", instance.len(), witness.len());

    let mut out = Vec::with_capacity(total * 32);
    for val in instance.iter().chain(witness.iter()) {
        // Canonical (standard) form, LE, 32 bytes — matches snarkjs writeBigInt
        let bigint = val.into_bigint();
        let bytes = bigint.to_bytes_le();
        let mut buf = [0u8; 32];
        buf[..bytes.len().min(32)].copy_from_slice(&bytes[..bytes.len().min(32)]);
        out.extend_from_slice(&buf);
    }

    fs::write(Path::new(output), &out).expect("write witness.bin");
    println!("[dump] wrote {} ({} bytes)", output, out.len());
}
