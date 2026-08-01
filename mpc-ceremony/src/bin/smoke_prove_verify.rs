//! Smoke test: prove and verify with keys imported from a snarkjs ceremony.
//!
//! Usage:
//!   cargo run --release --bin smoke-prove-verify -- \
//!       --pk-bin proving_key.bin \
//!       --vk-bin verification_key.bin \
//!       [--vk-json-bin verification_key_json.bin]
//!
//! Exit 0 = all enabled checks passed.
//! Exit 1 = one or more checks failed (see summary).

mod circom_reduction {
    //! ark-circom-style H path (must match src/circom_reduction.rs).

    use ark_ff::{Field, PrimeField};
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
use ark_ec::AffineRepr;
use ark_ff::Zero;
use ark_groth16::{prepare_verifying_key, Groth16, Proof, ProvingKey, VerifyingKey};
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

fn circuit() -> StationarityCircuit {
    StationarityCircuit {
        residual_fp: Some(RESIDUAL_FP),
        threshold_fp: Some(THRESHOLD_FP),
        block_hash_lo: Some(BLOCK_HASH_LO),
        block_hash_hi: Some(BLOCK_HASH_HI),
        difference: Some(DIFFERENCE),
    }
}

fn public_inputs() -> Vec<Fr> {
    vec![
        Fr::from(RESIDUAL_FP),
        Fr::from(THRESHOLD_FP),
        Fr::from(BLOCK_HASH_LO),
        Fr::from(BLOCK_HASH_HI),
    ]
}

fn log_proof(tag: &str, proof: &Proof<Bn254>) {
    println!(
        "[proof:{tag}] A.is_zero={} B.is_zero={} C.is_zero={}",
        proof.a.is_zero(),
        proof.b.is_zero(),
        proof.c.is_zero()
    );
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    let pk_path = parse_arg(&args, "--pk-bin").unwrap_or_else(|| {
        eprintln!(
            "usage: smoke-prove-verify --pk-bin <file> --vk-bin <file> [--vk-json-bin <file>]"
        );
        std::process::exit(2);
    });
    let vk_path = parse_arg(&args, "--vk-bin").unwrap_or_else(|| {
        eprintln!(
            "usage: smoke-prove-verify --pk-bin <file> --vk-bin <file> [--vk-json-bin <file>]"
        );
        std::process::exit(2);
    });
    let vk_json_path = parse_arg(&args, "--vk-json-bin");

    let mut failures = 0u32;
    let pubs = public_inputs();

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
        "[smoke] PK loaded  IC.len={}  h_query.len={}  a={} b_g1={} b_g2={} l={}",
        pk.vk.gamma_abc_g1.len(),
        pk.h_query.len(),
        pk.a_query.len(),
        pk.b_g1_query.len(),
        pk.b_g2_query.len(),
        pk.l_query.len()
    );

    println!("[smoke] loading VK from {vk_path}");
    let vk_bytes = fs::read(vk_path).unwrap_or_else(|e| {
        eprintln!("[smoke] FATAL: cannot read VK: {e}");
        std::process::exit(1);
    });
    let vk = VerifyingKey::<Bn254>::deserialize_compressed(&*vk_bytes).unwrap_or_else(|e| {
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

    // Check 1: circuit self-test (Libsnark only)
    println!("[check 1] circuit self-test (Libsnark setup+prove+verify) ...");
    {
        let mut rng = ark_std::rand::rngs::StdRng::seed_from_u64(0xDEAD_BEEF_CAFE_BABEu64);
        let (fpk, fvk) = Groth16::<Bn254>::circuit_specific_setup(circuit(), &mut rng)
            .expect("[check 1] setup failed");
        let fpvk = prepare_verifying_key(&fvk);
        let mut rng2 = ark_std::rand::rngs::StdRng::seed_from_u64(0x1234_5678u64);
        let proof = Groth16::<Bn254>::prove(&fpk, circuit(), &mut rng2)
            .expect("[check 1] prove failed");
        let ok = Groth16::<Bn254>::verify_with_processed_vk(&fpvk, &pubs, &proof)
            .expect("[check 1] verify error");
        if ok {
            println!("[check 1] PASS — circuit satisfiable under Libsnark");
        } else {
            println!("[check 1] FAIL — circuit broken");
            failures += 1;
        }
    }

    // Check 2: VK parity (zkey import vs JSON import)
    if let Some(json_path) = vk_json_path {
        println!("[check 2] VK parity zkey-bin vs json-bin ...");
        match fs::read(json_path) {
            Ok(jb) => match VerifyingKey::<Bn254>::deserialize_compressed(&*jb) {
                Ok(jvk) => {
                    let alpha_eq = vk.alpha_g1 == jvk.alpha_g1;
                    let beta_eq = vk.beta_g2 == jvk.beta_g2;
                    let gamma_eq = vk.gamma_g2 == jvk.gamma_g2;
                    let delta_eq = vk.delta_g2 == jvk.delta_g2;
                    let ic_eq = vk.gamma_abc_g1 == jvk.gamma_abc_g1;
                    if alpha_eq && beta_eq && gamma_eq && delta_eq && ic_eq {
                        println!("[check 2] PASS — zkey VK == JSON VK");
                    } else {
                        println!("[check 2] FAIL — VK mismatch");
                        println!(
                            "  alpha_g1={alpha_eq} beta_g2={beta_eq} gamma_g2={gamma_eq} \
                             delta_g2={delta_eq} IC={ic_eq}"
                        );
                        failures += 1;
                    }
                }
                Err(e) => {
                    println!("[check 2] ERROR deserialize json VK: {e}");
                    failures += 1;
                }
            },
            Err(e) => {
                println!("[check 2] ERROR read {json_path}: {e}");
                failures += 1;
            }
        }
    } else {
        println!("[check 2] SKIP — pass --vk-json-bin to enable");
    }

    // Check 3: Libsnark prove against IMPORTED keys
    println!("[check 3] Libsnark prove+verify vs imported PK/VK ...");
    {
        let mut rng = ark_std::rand::rngs::StdRng::seed_from_u64(0x0000_A11Cu64);
        match Groth16::<Bn254>::create_random_proof_with_reduction(circuit(), &pk, &mut rng) {
            Ok(proof) => {
                log_proof("libsnark", &proof);
                match Groth16::<Bn254>::verify_with_processed_vk(&pvk, &pubs, &proof) {
                    Ok(true) => {
                        println!("[check 3] PASS — Libsnark works with snarkjs keys");
                    }
                    Ok(false) => {
                        println!(
                            "[check 3] FAIL — Libsnark proof does not verify on imported keys"
                        );
                        failures += 1;
                    }
                    Err(e) => {
                        println!("[check 3] ERROR verify: {e}");
                        failures += 1;
                    }
                }
            }
            Err(e) => {
                println!("[check 3] ERROR prove: {e}");
                failures += 1;
            }
        }
    }

    // Check 4: CircomReduction prove against IMPORTED keys
    println!("[check 4] CircomReduction prove+verify vs imported PK/VK ...");
    {
        let mut rng = ark_std::rand::rngs::StdRng::seed_from_u64(0xC1C0_C1C0u64);
        match Groth16::<Bn254, CircomReduction>::create_random_proof_with_reduction(
            circuit(),
            &pk,
            &mut rng,
        ) {
            Ok(proof) => {
                log_proof("circom", &proof);
                match Groth16::<Bn254, CircomReduction>::verify_with_processed_vk(
                    &pvk, &pubs, &proof,
                ) {
                    Ok(true) => {
                        println!("[check 4] PASS — CircomReduction works with snarkjs keys");
                    }
                    Ok(false) => {
                        println!("[check 4] FAIL — CircomReduction proof does not verify");
                        failures += 1;
                    }
                    Err(e) => {
                        println!("[check 4] ERROR verify: {e}");
                        failures += 1;
                    }
                }
            }
            Err(e) => {
                println!("[check 4] ERROR prove: {e}");
                failures += 1;
            }
        }
    }

    println!();
    println!("========================================");
    println!("  failures={failures}");
    if failures == 0 {
        println!("  CEREMONY SMOKE: ALL CHECKS PASSED");
        std::process::exit(0);
    } else {
        println!("  CEREMONY SMOKE: DIAGNOSTIC FAILURES");
        println!("  Interpret:");
        println!("    1 FAIL -> circuit / R1CS problem");
        println!("    2 FAIL -> VK import (zkey vs JSON G1/G2 parse)");
        println!("    3+4 FAIL, 2 PASS -> prove path / H / A,B,L queries (not VK)");
        println!("    3 FAIL, 4 PASS -> use CircomReduction; Libsnark wrong for this zkey");
        println!("    3 PASS, 4 FAIL -> Circom H path wrong for this zkey");
        println!("    3 FAIL, 4 FAIL, 2 PASS -> key queries or assignment/wire mismatch");
        std::process::exit(1);
    }
}
