//! Smoke test: prove and verify with keys imported from a snarkjs ceremony.
//!
//! Usage:
//!   cargo run --release --bin smoke-prove-verify -- \
//!       --pk-bin proving_key.bin \
//!       --vk-bin verification_key.bin

mod circom_reduction {
    //! ark-circom-style H path (must match src/circom_reduction.rs).

    use ark_ff::{Field, One, PrimeField, Zero};
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
            eprintln!(
                "[circom_reduction] ark-circom-style num_constraints={num_constraints} \
                 num_inputs={num_inputs} domain_size={domain_size}"
            );

            let mut a = vec![zero; domain_size];
            let mut b = vec![zero; domain_size];
            for i in 0..num_constraints {
                a[i] = evaluate_constraint(&matrices.a[i], full_assignment);
                b[i] = evaluate_constraint(&matrices.b[i], full_assignment);
            }

            let start = num_constraints;
            let end = start + num_inputs;
            a[start..end].copy_from_slice(&full_assignment[..num_inputs]);

            let mut c = vec![zero; domain_size];
            for i in 0..num_constraints {
                c[i] = a[i] * b[i];
            }

            domain.ifft_in_place(&mut a);
            domain.ifft_in_place(&mut b);
            domain.ifft_in_place(&mut c);

            let root_of_unity = {
                let domain_double = D::new(2 * domain_size)
                    .ok_or(SynthesisError::PolynomialDegreeTooLarge)?;
                domain_double.element(1)
            };
            distribute_powers(&mut a, root_of_unity);
            distribute_powers(&mut b, root_of_unity);
            distribute_powers(&mut c, root_of_unity);

            domain.fft_in_place(&mut a);
            domain.fft_in_place(&mut b);
            domain.fft_in_place(&mut c);

            let mut ab = domain.mul_polynomials_in_evaluation_domain(&a, &b);
            for (ab_i, c_i) in ab.iter_mut().zip(c.iter()) {
                *ab_i -= c_i;
            }

            Ok(ab)
        }

        fn h_query_scalars<F: PrimeField, D: EvaluationDomain<F>>(
            max_power: usize,
            t: F,
            _zt: F,
            delta_inverse: F,
        ) -> Result<Vec<F>, SynthesisError> {
            let mut scalars: Vec<F> = (0..2 * max_power + 1)
                .map(|i| delta_inverse * t.pow([i as u64]))
                .collect();
            let domain =
                D::new(scalars.len()).ok_or(SynthesisError::PolynomialDegreeTooLarge)?;
            domain.ifft_in_place(&mut scalars);
            Ok(scalars.into_iter().skip(1).step_by(2).collect())
        }
    }

    fn distribute_powers<F: Field>(coeffs: &mut [F], root: F) {
        let mut pow = F::one();
        for c in coeffs.iter_mut() {
            *c *= pow;
            pow *= root;
        }
    }
}

use circom_reduction::CircomReduction;

use ark_bn254::{Bn254, Fr};
use ark_groth16::{prepare_verifying_key, Groth16, ProvingKey};
use ark_serialize::CanonicalDeserialize;
use ark_snark::SNARK;
use ark_std::rand::SeedableRng;
use equilibrium::zk_proof::StationarityCircuit;
use std::fs;

const RESIDUAL_FP: u64 = 3_000_000_000_000_000;
const THRESHOLD_FP: u64 = 7_000_000_000_000_000;
const BLOCK_HASH_LO: u64 = 0xDEAD_BEEF;
const BLOCK_HASH_HI: u64 = 0xCAFE_BABE;
const DIFFERENCE: u64 = THRESHOLD_FP - RESIDUAL_FP;

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

    println!("[smoke] loading PK from {pk_path}");
    let pk_bytes = fs::read(pk_path).unwrap_or_else(|e| {
        eprintln!("[smoke] FATAL: cannot read PK: {e}");
        std::process::exit(1);
    });
    let pk = ProvingKey::<Bn254>::deserialize_compressed(&*pk_bytes).unwrap_or_else(|e| {
        eprintln!("[smoke] FATAL: deserialize PK: {e}");
        std::process::exit(1);
    });
    println!(
        "[smoke] PK loaded  IC.len={}  h_query.len={}",
        pk.vk.gamma_abc_g1.len(),
        pk.h_query.len()
    );

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

    if vk.gamma_abc_g1.len() != 5 {
        eprintln!(
            "[smoke] FATAL: IC length = {}, expected 5",
            vk.gamma_abc_g1.len()
        );
        std::process::exit(1);
    }

    // Self-test: default ark only (circuit check)
    println!("[smoke] self-test: circuit correctness with default ark keys …");
    {
        let mut rng2 = ark_std::rand::rngs::StdRng::seed_from_u64(0xDEAD_BEEF_CAFE_BABEu64);
        let circuit_for_setup = StationarityCircuit {
            residual_fp: Some(RESIDUAL_FP),
            threshold_fp: Some(THRESHOLD_FP),
            block_hash_lo: Some(BLOCK_HASH_LO),
            block_hash_hi: Some(BLOCK_HASH_HI),
            difference: Some(DIFFERENCE),
        };
        let (fresh_pk, fresh_vk) =
            Groth16::<Bn254>::circuit_specific_setup(circuit_for_setup, &mut rng2)
                .expect("[smoke] self-test setup failed");
        let fresh_pvk = prepare_verifying_key(&fresh_vk);

        let circuit_for_prove = StationarityCircuit {
            residual_fp: Some(RESIDUAL_FP),
            threshold_fp: Some(THRESHOLD_FP),
            block_hash_lo: Some(BLOCK_HASH_LO),
            block_hash_hi: Some(BLOCK_HASH_HI),
            difference: Some(DIFFERENCE),
        };
        let mut rng3 = ark_std::rand::rngs::StdRng::seed_from_u64(0x1234_5678u64);
        let fresh_proof = Groth16::<Bn254>::prove(&fresh_pk, circuit_for_prove, &mut rng3)
            .expect("[smoke] self-test prove failed");

        let pub_in = vec![
            Fr::from(RESIDUAL_FP),
            Fr::from(THRESHOLD_FP),
            Fr::from(BLOCK_HASH_LO),
            Fr::from(BLOCK_HASH_HI),
        ];
        let self_valid =
            Groth16::<Bn254>::verify_with_processed_vk(&fresh_pvk, &pub_in, &fresh_proof)
                .expect("[smoke] self-test verify error");

        if self_valid {
            println!("[smoke] self-test PASS — StationarityCircuit is satisfiable ✓");
        } else {
            eprintln!("[smoke] self-test FAIL — circuit does not satisfy its own constraints");
            std::process::exit(1);
        }
    }

    let circuit = StationarityCircuit {
        residual_fp: Some(RESIDUAL_FP),
        threshold_fp: Some(THRESHOLD_FP),
        block_hash_lo: Some(BLOCK_HASH_LO),
        block_hash_hi: Some(BLOCK_HASH_HI),
        difference: Some(DIFFERENCE),
    };

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

    let public_inputs = vec![
        Fr::from(RESIDUAL_FP),
        Fr::from(THRESHOLD_FP),
        Fr::from(BLOCK_HASH_LO),
        Fr::from(BLOCK_HASH_HI),
    ];

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
        std::process::exit(0);
    } else {
        eprintln!("[smoke] FAIL — verify returned false");
        std::process::exit(1);
    }
}
