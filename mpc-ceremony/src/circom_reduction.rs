//! Circom/snarkjs-compatible R1CS→QAP reduction.
//!
//! snarkjs `groth16 prove` computes the H polynomial in exactly the same way
//! as ark-groth16's `LibsnarkReduction` — same coset (`F::GENERATOR`), same
//! vanishing-polynomial division, same final IFFT to yield **polynomial
//! coefficients** that pair with the monomial H-query stored in the zkey.
//!
//! The **one difference** is that `LibsnarkReduction` copies the public-input
//! assignments into positions `[num_constraints..num_constraints+num_inputs]`
//! of the A evaluation vector before the IFFT, shifting A(x) by those terms.
//! snarkjs/circom never does this.  That changes A(x), which changes H(x),
//! which makes proofs verify `false` against a snarkjs-ceremony key even when
//! every other step is identical.
//!
//! This module is therefore identical to `LibsnarkReduction` with those four
//! lines of public-input padding removed.  `instance_map_with_evaluation` and
//! `h_query_scalars` are unchanged (both delegate to `LibsnarkReduction`).

use ark_ff::{PrimeField, Zero};
use ark_groth16::r1cs_to_qap::{evaluate_constraint, LibsnarkReduction, R1CSToQAP};
use ark_poly::EvaluationDomain;
use ark_relations::r1cs::{ConstraintMatrices, ConstraintSystemRef, SynthesisError};

pub struct CircomReduction;

impl R1CSToQAP for CircomReduction {
    /// Identical to LibsnarkReduction — only the witness map differs.
    #[allow(clippy::type_complexity)]
    fn instance_map_with_evaluation<F: PrimeField, D: EvaluationDomain<F>>(
        cs: ConstraintSystemRef<F>,
        t: &F,
    ) -> Result<(Vec<F>, Vec<F>, Vec<F>, F, usize, usize), SynthesisError> {
        LibsnarkReduction::instance_map_with_evaluation::<F, D>(cs, t)
    }

    /// Circom-compatible witness map.
    ///
    /// Identical to `LibsnarkReduction::witness_map_from_matrices` except that
    /// the public-input assignments are **not** copied into A at positions
    /// `[num_constraints..num_constraints+num_inputs]`.  Snarkjs/circom leaves
    /// those entries zero, producing a different A polynomial and therefore a
    /// different H polynomial — so all proofs must use the same convention as
    /// the ceremony that generated the proving key.
    ///
    /// Returns **polynomial coefficients** of H(x) (after the final coset
    /// IFFT), which pair with the monomial H-query stored in snarkjs zkeys.
    fn witness_map_from_matrices<F: PrimeField, D: EvaluationDomain<F>>(
        matrices: &ConstraintMatrices<F>,
        num_inputs: usize,
        num_constraints: usize,
        full_assignment: &[F],
    ) -> Result<Vec<F>, SynthesisError> {
        let domain = D::new(num_constraints + num_inputs)
            .ok_or(SynthesisError::PolynomialDegreeTooLarge)?;
        let domain_size = domain.size();
        let zero = F::zero();

        // Step 1: evaluate A and B linear combinations at each constraint.
        // PUBLIC INPUTS ARE NOT ADDED — this is the only difference from
        // LibsnarkReduction. snarkjs leaves those evaluation slots at zero.
        let mut a = vec![zero; domain_size];
        let mut b = vec![zero; domain_size];

        for i in 0..num_constraints {
            a[i] = evaluate_constraint(&matrices.a[i], full_assignment);
            b[i] = evaluate_constraint(&matrices.b[i], full_assignment);
        }
        // LibsnarkReduction inserts:
        //   a[num_constraints..num_constraints+num_inputs]
        //       = full_assignment[..num_inputs];
        // We intentionally omit that block.

        domain.ifft_in_place(&mut a);
        domain.ifft_in_place(&mut b);

        // Step 2: evaluate in the generator coset {F::GENERATOR · ωⁱ}.
        // Same coset as LibsnarkReduction — and the same coset snarkjs uses
        // internally (the multiplicative generator of Fr, which is 5 for BN254).
        let coset_domain = domain.get_coset(F::GENERATOR).unwrap();

        coset_domain.fft_in_place(&mut a);
        coset_domain.fft_in_place(&mut b);

        let mut ab = domain.mul_polynomials_in_evaluation_domain(&a, &b);
        drop(a);
        drop(b);

        // Step 3: evaluate C linear combinations at each constraint.
        let mut c = vec![zero; domain_size];
        for i in 0..num_constraints {
            c[i] = evaluate_constraint(&matrices.c[i], full_assignment);
        }

        domain.ifft_in_place(&mut c);
        coset_domain.fft_in_place(&mut c);

        // Step 4: h_coset = (AB − C) / Z(generator).
        // Z(x) = x^n − 1 is constant over the coset {g · ωⁱ}:
        //   Z(g · ωⁱ) = g^n − 1  (same value for every i)
        // Multiplying by its inverse turns AB−C evaluations into H evaluations.
        let vanishing_polynomial_over_coset = domain
            .evaluate_vanishing_polynomial(F::GENERATOR)
            .inverse()
            .unwrap();
        for (ab_i, c_i) in ab.iter_mut().zip(c.iter()) {
            *ab_i -= c_i;
            *ab_i *= vanishing_polynomial_over_coset;
        }

        // Step 5: IFFT back to polynomial coefficients.
        // The ark-groth16 prover MSMs these coefficients against the monomial
        // H-query [Z(τ)·τ^i/δ · G1], computing H(τ)·Z(τ)/δ.
        coset_domain.ifft_in_place(&mut ab);

        Ok(ab)
    }

    /// Identical to LibsnarkReduction — only used during key generation.
    fn h_query_scalars<F: PrimeField, D: EvaluationDomain<F>>(
        max_power: usize,
        t: F,
        zt: F,
        delta_inverse: F,
    ) -> Result<Vec<F>, SynthesisError> {
        LibsnarkReduction::h_query_scalars::<F, D>(max_power, t, zt, delta_inverse)
    }
}
