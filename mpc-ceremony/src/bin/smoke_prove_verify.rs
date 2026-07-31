//! Smoke test: prove and verify with keys imported from a snarkjs ceremony.
//!
//! Usage:
//!   cargo run --release --bin smoke-prove-verify -- \
//!       --pk-bin proving_key.bin \
//!       --vk-bin verification_key.bin
//!
//! Exit 0 = proof verifies correctly.
//! Exit 1 = proof fails or file errors.
//!
//! Uses a hardcoded valid witness for StationarityCircuit:
//!   residual_fp  = 3_000_000_000_000_000
//!   threshold_fp = 7_000_000_000_000_000
//!   difference   = 4_000_000_000_000_000   (= threshold - residual)
//!   block_hash_lo = 0xDEAD_BEEF
//!   block_hash_hi = 0xCAFE_BABE
//!
//! Constraint check: residual_fp + difference == threshold_fp  ✓

use ark_bn254::{Bn254, Fr};
use ark_ff::PrimeField;
use ark_groth16::{Groth16, ProvingKey, prepare_verifying_key};
use ark_serialize::CanonicalDeserialize;
use ark_snark::SNARK;
use ark_std::rand::SeedableRng;
use equilibrium::zk_proof::StationarityCircuit;
use std::fs;
use std::path::Path;

// Known valid witness constants
const RESIDUAL_FP:   u64 = 3_000_000_000_000_000;
const THRESHOLD_FP:  u64 = 7_000_000_000_000_000;
const BLOCK_HASH_LO: u64 = 0xDEAD_BEEF;
const BLOCK_HASH_HI: u64 = 0xCAFE_BABE;
const DIFFERENCE:    u64 = THRESHOLD_FP - RESIDUAL_FP; // = 4_000_000_000_000_000

fn parse_arg<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|w| w[0] == flag)
        .map(|w| w[1].as_str())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    let pk_path = parse_arg(&args, "--pk-bin").unwrap_or_else(|| {
        eprintln!("usage: smoke-prove-verify --pk-bin <file> --vk-bin <file>");
        std::process::exit(2);
    });
    let vk_path = parse_arg(&args, "--vk-bin").unwrap_or_else(|| {
        eprintln!("usage: smoke-prove-verify --pk-bin <file> --vk-bin <file>");
        std::process::exit(2);
    });

    // ── Load keys ─────────────────────────────────────────────────────────────
    println!("[smoke] loading PK from {pk_path}");
    let pk_bytes = fs::read(pk_path).unwrap_or_else(|e| {
        eprintln!("[smoke] FATAL: cannot read PK: {e}");
        std::process::exit(1);
    });
    let pk = ProvingKey::<Bn254>::deserialize_compressed(&*pk_bytes).unwrap_or_else(|e| {
        eprintln!("[smoke] FATAL: deserialize PK: {e}");
        std::process::exit(1);
    });
    println!("[smoke] PK loaded  IC.len={}", pk.vk.gamma_abc_g1.len());

    println!("[smoke] loading VK from {vk_path}");
    let vk_bytes = fs::read(vk_path).unwrap_or_else(|e| {
        eprintln!("[smoke] FATAL: cannot read VK: {e}");
        std::process::exit(1);
    });
    let vk = ark_groth16::VerifyingKey::<Bn254>::deserialize_compressed(&*vk_bytes)
        .unwrap_or_else(|e| {
            eprintln!("[smoke] FATAL: deserialize VK: {e}");
            std::process::exit(1);
        });
    let pvk = prepare_verifying_key(&vk);
    println!("[smoke] VK loaded  IC.len={}", vk.gamma_abc_g1.len());

    // ── Sanity: IC length must be nPublic + 1 = 5 ────────────────────────────
    if vk.gamma_abc_g1.len() != 5 {
        eprintln!(
            "[smoke] FATAL: IC length = {}, expected 5 (4 public inputs + 1)",
            vk.gamma_abc_g1.len()
        );
        std::process::exit(1);
    }

    // ── Build circuit with valid witness ──────────────────────────────────────
    let circuit = StationarityCircuit {
        residual_fp:   Some(RESIDUAL_FP),
        threshold_fp:  Some(THRESHOLD_FP),
        block_hash_lo: Some(BLOCK_HASH_LO),
        block_hash_hi: Some(BLOCK_HASH_HI),
        difference:    Some(DIFFERENCE),
    };

    // ── Prove ─────────────────────────────────────────────────────────────────
    println!("[smoke] proving …");
    let mut rng = ark_std::rand::rngs::StdRng::seed_from_u64(0xC0DE_5AFE_DEAD_BEEFu64);
    let proof = Groth16::<Bn254>::prove(&pk, circuit, &mut rng).unwrap_or_else(|e| {
        eprintln!("[smoke] FATAL: prove failed: {e}");
        std::process::exit(1);
    });
    println!("[smoke] proof generated");

    // ── Build public inputs (same order as new_input calls in StationarityCircuit) ──
    let public_inputs = vec![
        Fr::from(RESIDUAL_FP),
        Fr::from(THRESHOLD_FP),
        Fr::from(BLOCK_HASH_LO),
        Fr::from(BLOCK_HASH_HI),
    ];

    // ── Verify ────────────────────────────────────────────────────────────────
    println!("[smoke] verifying …");
    let valid = Groth16::<Bn254>::verify_with_processed_vk(&pvk, &public_inputs, &proof)
        .unwrap_or_else(|e| {
            eprintln!("[smoke] FATAL: verify error: {e}");
            std::process::exit(1);
        });

    if valid {
        println!("[smoke] PASS — proof verifies with ceremony-imported keys ✓");
        println!("[smoke] witness: residual={RESIDUAL_FP} threshold={THRESHOLD_FP} diff={DIFFERENCE}");
        std::process::exit(0);
    } else {
        eprintln!("[smoke] FAIL — verify returned false");
        eprintln!("[smoke] This means the imported keys do not match the StationarityCircuit R1CS.");
        eprintln!("[smoke] Likely cause: zkey was produced from a different circuit.");
        std::process::exit(1);
    }
}
