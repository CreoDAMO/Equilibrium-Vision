//! Circom/snarkjs-compatible R1CS→QAP reduction.
//!
//! snarkjs zkeys store the H query in **Lagrange form** (circom convention).
//! ark-groth16's default `LibsnarkReduction` uses a coset at `F::GENERATOR`,
//! which is incompatible with those keys and causes `verify` to return false
//! even with a correctly-imported PK/VK.
//!
//! This module implements `R1CSToQAP` using the double-domain / root-of-unity
//! shift that matches snarkjs's `witnesscalculator` and `groth16prove`, so that
//! `Groth16::<Bn254, CircomReduction>::create_random_proof_with_reduction`
//! produces proofs that verify against ceremony-imported keys.
//!
//! Adapted from ark-circom (Apache-2.0 / MIT). `instance_map_with_evaluation`
//! and `h_query_scalars` delegate to `LibsnarkReduction`; only
//! `witness_map_from_matrices` differs.

use ark_ff::{PrimeField, Zero};
use ark_groth16::r1cs_to_qap::{evaluate_constraint, LibsnarkReduction, R1CSToQAP};
use ark_poly::EvaluationDomain;
use ark_relations::r1cs::{ConstraintMatrices, ConstraintSystemRef, SynthesisError};

pub struct CircomReduction;

impl R1CSToQAP for CircomReduction {
    /// Delegates to LibsnarkReduction — only the witness map differs.
    #[allow(clippy::type_complexity)]
    fn instance_map_with_evaluation<F: PrimeField, D: EvaluationDomain<F>>(
        cs: ConstraintSystemRef<F>,
        t: &F,
    ) -> Result<(Vec<F>, Vec<F>, Vec<F>, F, usize, usize), SynthesisError> {
        LibsnarkReduction::instance_map_with_evaluation::<F, D>(cs, t)
    }

    /// Circom-compatible witness map.
    ///
    /// snarkjs evaluates h(x) at the **double-domain** coset shifted by
    /// `ω₂ₙ` (the first root of unity of the 2n-size domain), then subtracts
    /// to get h(x)·t(x).  The resulting coefficient vector must align with the
    /// Lagrange-form H-query bases stored in the zkey.
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

        // Step 1: evaluate A and B linear combinations for every constraint.
        let mut a = vec![zero; domain_size];
        let mut b = vec![zero; domain_size];

        for i in 0..num_constraints {
            a[i] = evaluate_constraint(&matrices.a[i], full_assignment);
            b[i] = evaluate_constraint(&matrices.b[i], full_assignment);
        }

        // NOTE: snarkjs does NOT place public inputs at positions
        // [num_constraints..num_constraints+num_inputs].
        // LibsnarkReduction does; CircomReduction must NOT — the snarkjs ceremony
        // generates the H query to match an A polynomial that has zeros there.

        // Step 2: compute pointwise product c = a·b (constraint residuals).
        let mut c = vec![zero; domain_size];
        for i in 0..num_constraints {
            c[i] = a[i] * b[i];
        }

        // Step 3: IFFT to get polynomial coefficients for a and b.
        domain.ifft_in_place(&mut a);
        domain.ifft_in_place(&mut b);

        // Step 4: shift into the "circom coset" — multiply polynomial coefficients
        // by successive powers of ω₂ₙ (first root of unity of the doubled domain).
        // This is equivalent to evaluating a(x) and b(x) at the set {ω₂ₙ · ωⁱ}.
        let root_of_unity = {
            let double_domain = D::new(2 * domain_size)
                .ok_or(SynthesisError::PolynomialDegreeTooLarge)?;
            double_domain.element(1)
        };
        D::distribute_powers_and_mul_by_const(&mut a, root_of_unity, F::one());
        D::distribute_powers_and_mul_by_const(&mut b, root_of_unity, F::one());

        // Step 5: FFT back to evaluation domain.
        domain.fft_in_place(&mut a);
        domain.fft_in_place(&mut b);

        // Step 6: pointwise product a·b in evaluation domain.
        let mut ab = domain.mul_polynomials_in_evaluation_domain(&a, &b);
        drop(a);
        drop(b);

        // Step 7: same shift for c.
        domain.ifft_in_place(&mut c);
        D::distribute_powers_and_mul_by_const(&mut c, root_of_unity, F::one());
        domain.fft_in_place(&mut c);

        // Step 8: h = (ab - c), which encodes (A·B - C) / t(x).
        for (ab_i, c_i) in ab.iter_mut().zip(c.iter()) {
            *ab_i -= c_i;
        }

        Ok(ab)
    }

    /// Delegates to LibsnarkReduction (only used during key generation, not proving).
    fn h_query_scalars<F: PrimeField, D: EvaluationDomain<F>>(
        max_power: usize,
        t: F,
        zt: F,
        delta_inverse: F,
    ) -> Result<Vec<F>, SynthesisError> {
        LibsnarkReduction::h_query_scalars::<F, D>(max_power, t, zt, delta_inverse)
    }
}
