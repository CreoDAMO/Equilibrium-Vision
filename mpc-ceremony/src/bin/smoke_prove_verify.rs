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

// ── CircomReduction ──────────────────────────────────────────────────────────
//
// snarkjs zkeys store H-query bases in Lagrange form (circom convention).
// ark-groth16's default LibsnarkReduction uses a coset at F::GENERATOR, which
// is incompatible and makes verify() return false despite a correct key import.
//
// We use CircomReduction (below) which shifts into the double-domain coset
// (root of unity of 2n domain), matching snarkjs's witnesscalculator output.

mod circom_reduction {
    use ark_ff::{PrimeField, Zero};
    use ark_groth16::r1cs_to_qap::{evaluate_constraint, LibsnarkReduction, R1CSToQAP};
    use ark_poly::EvaluationDomain;
    use ark_relations::r1cs::{ConstraintMatrices, ConstraintSystemRef, SynthesisError};

    pub struct CircomReduction;

    impl R1CSToQAP for CircomReduction {
        #[allow(clippy::type_complexity)]
        fn instance_map_with_evaluation<F: PrimeField, D: EvaluationDomain<F>>(
            cs: ConstraintSystemRef<F>,
            t: &F,
        ) -> Result<(Vec<F>, Vec<F>, Vec<F>, F, usize, usize), SynthesisError> {
            LibsnarkReduction::instance_map_with_evaluation::<F, D>(cs, t)
        }

        fn witness_map_from_matrices<F: PrimeField, D: EvaluationDomain<F>>(
            matrices: &ConstraintMatrices<F>,
            num_inputs: usize,
            num_constraints: usize,
            full_assignment: &[F],
        ) -> Result<Vec<F>, SynthesisError> {
            let zero = F::zero();

            let domain = D::new(num_constraints + num_inputs)
                .ok_or(SynthesisError::PolynomialDegreeTooLarge)?;
            let domain_size = domain.size();

            // Evaluate A and B linear combinations for every constraint.
            let mut a = vec![zero; domain_size];
            let mut b = vec![zero; domain_size];

            for i in 0..num_constraints {
                a[i] = evaluate_constraint(&matrices.a[i], full_assignment);
                b[i] = evaluate_constraint(&matrices.b[i], full_assignment);
            }

            // NOTE: snarkjs does NOT add public inputs at positions
            // [num_constraints..num_constraints+num_inputs] — those stay zero.
            // LibsnarkReduction does; CircomReduction must NOT.

            // Pointwise product c = a·b (before polynomial ops).
            let mut c = vec![zero; domain_size];
            for i in 0..num_constraints {
                c[i] = a[i] * b[i];
            }

            domain.ifft_in_place(&mut a);
            domain.ifft_in_place(&mut b);

            // Shift into the circom coset: multiply by successive powers of ω₂ₙ
            // (first root of unity of the 2n-size domain).  This makes the h
            // polynomial evaluation points match snarkjs's H-query Lagrange bases.
            let root_of_unity = {
                let double_domain = D::new(2 * domain_size)
                    .ok_or(SynthesisError::PolynomialDegreeTooLarge)?;
                double_domain.element(1)
            };
            D::distribute_powers_and_mul_by_const(&mut a, root_of_unity, F::one());
            D::distribute_powers_and_mul_by_const(&mut b, root_of_unity, F::one());

            domain.fft_in_place(&mut a);
            domain.fft_in_place(&mut b);

            let mut ab = domain.mul_polynomials_in_evaluation_domain(&a, &b);
            drop(a);
            drop(b);

            // Same shift for c.
            domain.ifft_in_place(&mut c);
            D::distribute_powers_and_mul_by_const(&mut c, root_of_unity, F::one());
            domain.fft_in_place(&mut c);

            // h = ab - c  encodes  (A·B − C) / t(x)
            for (ab_i, c_i) in ab.iter_mut().zip(c.iter()) {
                *ab_i -= c_i;
            }

            Ok(ab)
        }

        /// Only called during key generation — delegates to LibsnarkReduction.
        fn h_query_scalars<F: PrimeField, D: EvaluationDomain<F>>(
            max_power: usize,
            t: F,
            zt: F,
            delta_inverse: F,
        ) -> Result<Vec<F>, SynthesisError> {
            LibsnarkReduction::h_query_scalars::<F, D>(max_power, t, zt, delta_inverse)
        }
    }
}

use circom_reduction::CircomReduction;

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
const DIFFERENCE:    u64 = THRESHOLD_FP - RESIDUAL_FP;

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

    // ── Prove with CircomReduction ────────────────────────────────────────────
    // MUST use CircomReduction here — not the default LibsnarkReduction.
    // snarkjs stores H-query in Lagrange form; LibsnarkReduction uses the wrong
    // coset and produces proofs that fail to verify against snarkjs-ceremony keys.
    println!("[smoke] proving with CircomReduction …");
    let mut rng = ark_std::rand::rngs::StdRng::seed_from_u64(0xC0DE_5AFE_DEAD_BEEFu64);
    let proof = Groth16::<Bn254, CircomReduction>::create_random_proof_with_reduction(
        circuit, &pk, &mut rng,
    )
    .unwrap_or_else(|e| {
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
    let valid = Groth16::<Bn254, CircomReduction>::verify_with_processed_vk(
        &pvk,
        &public_inputs,
        &proof,
    )
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
        eprintln!("[smoke] Keys were imported from a snarkjs ceremony but the proof did not verify.");
        eprintln!("[smoke] Check: are the PK/VK from a ceremony over the same R1CS this binary uses?");
        std::process::exit(1);
    }
}
