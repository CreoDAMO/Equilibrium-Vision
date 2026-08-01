//! Circom/snarkjs-compatible R1CS→QAP reduction (ark-circom style).
//!
//! Not “Libsnark minus public-input padding.”
//!
//! - Pad public inputs into A (same as Libsnark / ark-circom)
//! - C := A·B on constraint slots
//! - 2n-domain root-of-unity coset, FFT, AB−C evaluations
//! - No /Z, no final coset IFFT
//! - h_query_scalars: odd coefficients (setup only; ceremony uses zkey H)
//!
//! Ceremony: import zkey → prove with CircomReduction → verify.
//! Do not use this type for ark setup+prove self-test of “circom consistency.”

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

        let mut a = vec![zero; domain_size];
        let mut b = vec![zero; domain_size];
        for i in 0..num_constraints {
            a[i] = evaluate_constraint(&matrices.a[i], full_assignment);
            b[i] = evaluate_constraint(&matrices.b[i], full_assignment);
        }

        // Public-input padding (Libsnark / ark-circom)
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
        let domain = D::new(scalars.len()).ok_or(SynthesisError::PolynomialDegreeTooLarge)?;
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
