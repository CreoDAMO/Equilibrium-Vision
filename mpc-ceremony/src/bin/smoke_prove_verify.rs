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
// snarkjs zkeys store the H-query built without the public-input padding that
// ark-groth16's default LibsnarkReduction adds to the A evaluation vector.
// CircomReduction (below) omits that padding in witness_map_from_matrices so
// the H polynomial it produces matches the bases in the imported proving key.
//
// NOTE: CircomReduction is used ONLY for proving against an imported snarkjs
// key. It is NOT used for circuit_specific_setup — that path would produce
// mismatched keys (setup via LibsnarkReduction, prove via no-pad), which is
// why the self-test below uses plain Groth16::<Bn254> (LibsnarkReduction
// throughout) to validate the circuit independently of key import.

mod circom_reduction {
    //! Circom-compatible R1CS→QAP reduction — see circom_reduction.rs for
    //! the canonical version; this is the self-contained inline copy used by
    //! the smoke binary so it compiles without a [lib] target.
    //!
    //! Identical to LibsnarkReduction except: public inputs are NOT copied
    //! into A at positions [num_constraints..num_constraints+num_inputs].
    //! That is the only thing snarkjs/circom does differently.

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
            let domain = D::new(num_constraints + num_inputs)
                .ok_or(SynthesisError::PolynomialDegreeTooLarge)?;
            let domain_size = domain.size();
            eprintln!("[circom_reduction] num_constraints={num_constraints} num_inputs={num_inputs} domain_size={domain_size}");
            let zero = F::zero();

            // Evaluate A and B at constraint positions only.
            // PUBLIC INPUTS ARE NOT PADDED — the only delta from LibsnarkReduction.
            let mut a = vec![zero; domain_size];
            let mut b = vec![zero; domain_size];
            for i in 0..num_constraints {
                a[i] = evaluate_constraint(&matrices.a[i], full_assignment);
                b[i] = evaluate_constraint(&matrices.b[i], full_assignment);
            }

            domain.ifft_in_place(&mut a);
            domain.ifft_in_place(&mut b);

            // Coset {F::GENERATOR · ωⁱ} — same generator (5 for BN254) as snarkjs.
            let coset_domain = domain.get_coset(F::GENERATOR).unwrap();
            coset_domain.fft_in_place(&mut a);
            coset_domain.fft_in_place(&mut b);

            let mut ab = domain.mul_polynomials_in_evaluation_domain(&a, &b);
            drop(a);
            drop(b);

            let mut c = vec![zero; domain_size];
            for i in 0..num_constraints {
                c[i] = evaluate_constraint(&matrices.c[i], full_assignment);
            }
            domain.ifft_in_place(&mut c);
            coset_domain.fft_in_place(&mut c);

            // Divide by Z(generator) — constant over the coset.
            let vanishing_polynomial_over_coset = domain
                .evaluate_vanishing_polynomial(F::GENERATOR)
                .inverse()
                .unwrap();
            for (ab_i, c_i) in ab.iter_mut().zip(c.iter()) {
                *ab_i -= c_i;
                *ab_i *= vanishing_polynomial_over_coset;
            }

            // IFFT → polynomial coefficients, matching monomial H-query in zkey.
            coset_domain.ifft_in_place(&mut ab);

            Ok(ab)
        }

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
    println!("[smoke] PK loaded  IC.len={}  h_query.len={}", pk.vk.gamma_abc_g1.len(), pk.h_query.len());

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

    // ── Self-test: circuit correctness via default ark (LibsnarkReduction) ────
    // Uses plain Groth16::<Bn254> (no custom reduction) so setup, prove, and
    // verify all share the same LibsnarkReduction QAP rules.  This confirms the
    // StationarityCircuit itself is satisfiable before we attempt the snarkjs
    // ceremony path.  CircomReduction is intentionally NOT tested here — it is
    // only valid for proving against an imported snarkjs key, not for
    // circuit_specific_setup (which would produce a mismatched key pair).
    println!("[smoke] self-test: circuit correctness with default ark keys …");
    {
        let mut rng2 = ark_std::rand::rngs::StdRng::seed_from_u64(0xDEAD_BEEF_CAFE_BABEu64);
        let circuit_for_setup = StationarityCircuit {
            residual_fp:   Some(RESIDUAL_FP),
            threshold_fp:  Some(THRESHOLD_FP),
            block_hash_lo: Some(BLOCK_HASH_LO),
            block_hash_hi: Some(BLOCK_HASH_HI),
            difference:    Some(DIFFERENCE),
        };
        let (fresh_pk, fresh_vk) =
            Groth16::<Bn254>::circuit_specific_setup(circuit_for_setup, &mut rng2)
                .expect("[smoke] self-test setup failed");
        let fresh_pvk = prepare_verifying_key(&fresh_vk);

        let circuit_for_prove = StationarityCircuit {
            residual_fp:   Some(RESIDUAL_FP),
            threshold_fp:  Some(THRESHOLD_FP),
            block_hash_lo: Some(BLOCK_HASH_LO),
            block_hash_hi: Some(BLOCK_HASH_HI),
            difference:    Some(DIFFERENCE),
        };
        let mut rng3 = ark_std::rand::rngs::StdRng::seed_from_u64(0x1234_5678u64);
        let fresh_proof =
            Groth16::<Bn254>::prove(&fresh_pk, circuit_for_prove, &mut rng3)
                .expect("[smoke] self-test prove failed");

        let pub_in = vec![
            Fr::from(RESIDUAL_FP),
            Fr::from(THRESHOLD_FP),
            Fr::from(BLOCK_HASH_LO),
            Fr::from(BLOCK_HASH_HI),
        ];
        let self_valid = Groth16::<Bn254>::verify_with_processed_vk(
            &fresh_pvk, &pub_in, &fresh_proof,
        )
        .expect("[smoke] self-test verify error");

        if self_valid {
            println!("[smoke] self-test PASS — StationarityCircuit is satisfiable ✓");
        } else {
            eprintln!("[smoke] self-test FAIL — circuit does not satisfy its own constraints");
            std::process::exit(1);
        }
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
