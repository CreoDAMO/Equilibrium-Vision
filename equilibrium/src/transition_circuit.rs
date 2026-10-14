//! Integer successor skeleton, as a Groth16 statement beside stationarity.
//!
//! Stationarity proves `residual + difference = threshold` for a header hash
//! the verifier supplies. This statement proves the integer checks that do
//! not depend on the floating-point laws:
//!
//! - successor height is the predecessor height plus one
//! - the timestamp does not move backwards (`delta` fits in 64 bits)
//! - the credited balance is the predecessor balance plus the liquid amount
//! - the residual is strictly under the threshold, in the same 64-bit sense
//!
//! The sealed digests and the difficulty are public inputs, so a proof for
//! one block will not verify as another block. They are not computed inside
//! the circuit. Reward, residual, pool quotes, and difficulty retarget stay
//! outside: those laws are floating-point, and an approximate field circuit
//! would be a different relation. This is not a proof of `applySuccessor`.

use ark_bn254::{Bn254, Fr};
use ark_ff::{Field, One, PrimeField, Zero};
use ark_groth16::{prepare_verifying_key, Groth16, PreparedVerifyingKey, ProvingKey};
use ark_r1cs_std::fields::fp::FpVar;
use ark_r1cs_std::prelude::*;
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
use ark_snark::SNARK;
use rand::rngs::StdRng;
use rand::SeedableRng;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SkeletonPublic {
    pub height_before: u64,
    pub height_after: u64,
    pub timestamp_before: u64,
    pub timestamp_after: u64,
    pub difficulty: u64,
    pub residual_fp: u64,
    pub threshold_fp: u64,
    pub balance_before: u64,
    pub liquid: u64,
    pub balance_after: u64,
    pub before_lo: u64,
    pub before_hi: u64,
    pub transition_lo: u64,
    pub transition_hi: u64,
    pub after_lo: u64,
    pub after_hi: u64,
}

#[derive(Clone)]
struct SkeletonCircuit {
    public: SkeletonPublic,
    difference: u64,
    time_delta: u64,
}

fn fit_u64<F: PrimeField>(value: &FpVar<F>) -> Result<(), SynthesisError> {
    let bits = value.to_bits_le()?;
    for bit in bits.iter().skip(64) {
        bit.enforce_equal(&Boolean::FALSE)?;
    }
    Ok(())
}

impl ConstraintSynthesizer<Fr> for SkeletonCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let height_before = input(cs.clone(), self.public.height_before)?;
        let height_after = input(cs.clone(), self.public.height_after)?;
        let timestamp_before = input(cs.clone(), self.public.timestamp_before)?;
        let timestamp_after = input(cs.clone(), self.public.timestamp_after)?;
        let _difficulty = input(cs.clone(), self.public.difficulty)?;
        let residual = input(cs.clone(), self.public.residual_fp)?;
        let threshold = input(cs.clone(), self.public.threshold_fp)?;
        let balance_before = input(cs.clone(), self.public.balance_before)?;
        let liquid = input(cs.clone(), self.public.liquid)?;
        let balance_after = input(cs.clone(), self.public.balance_after)?;
        let _before_lo = input(cs.clone(), self.public.before_lo)?;
        let _before_hi = input(cs.clone(), self.public.before_hi)?;
        let _transition_lo = input(cs.clone(), self.public.transition_lo)?;
        let _transition_hi = input(cs.clone(), self.public.transition_hi)?;
        let _after_lo = input(cs.clone(), self.public.after_lo)?;
        let _after_hi = input(cs.clone(), self.public.after_hi)?;

        fit_u64(&height_before)?;
        fit_u64(&height_after)?;
        fit_u64(&timestamp_before)?;
        fit_u64(&timestamp_after)?;
        fit_u64(&residual)?;
        fit_u64(&threshold)?;
        fit_u64(&balance_before)?;
        fit_u64(&liquid)?;
        fit_u64(&balance_after)?;

        let stepped = &height_before + &FpVar::constant(Fr::one());
        stepped.enforce_equal(&height_after)?;

        let delta = FpVar::new_witness(cs.clone(), || Ok(Fr::from(self.time_delta)))?;
        fit_u64(&delta)?;
        (&timestamp_before + &delta).enforce_equal(&timestamp_after)?;

        (&balance_before + &liquid).enforce_equal(&balance_after)?;

        let difference = FpVar::new_witness(cs.clone(), || Ok(Fr::from(self.difference)))?;
        fit_u64(&difference)?;
        (&residual + &difference).enforce_equal(&threshold)?;
        let inverse = FpVar::new_witness(cs, || {
            let value = difference.value().unwrap_or(Fr::zero());
            Ok(value.inverse().unwrap_or(Fr::one()))
        })?;
        difference.mul_equals(&inverse, &FpVar::constant(Fr::one()))?;
        Ok(())
    }
}

fn input(cs: ConstraintSystemRef<Fr>, value: u64) -> Result<FpVar<Fr>, SynthesisError> {
    FpVar::new_input(cs, || Ok(Fr::from(value)))
}

fn witnesses(public: &SkeletonPublic) -> Result<(u64, u64), &'static str> {
    if public.height_after != public.height_before.saturating_add(1) || public.height_before == u64::MAX {
        return Err("height is not the next height");
    }
    if public.timestamp_after < public.timestamp_before {
        return Err("timestamp moved backwards");
    }
    if public.residual_fp >= public.threshold_fp {
        return Err("residual is not under the threshold");
    }
    let credited = u128::from(public.balance_before) + u128::from(public.liquid);
    if credited != u128::from(public.balance_after) {
        return Err("balance is not the predecessor plus the liquid credit");
    }
    Ok((public.threshold_fp - public.residual_fp, public.timestamp_after - public.timestamp_before))
}

fn statement(public: &SkeletonPublic) -> Vec<Fr> {
    [
        public.height_before,
        public.height_after,
        public.timestamp_before,
        public.timestamp_after,
        public.difficulty,
        public.residual_fp,
        public.threshold_fp,
        public.balance_before,
        public.liquid,
        public.balance_after,
        public.before_lo,
        public.before_hi,
        public.transition_lo,
        public.transition_hi,
        public.after_lo,
        public.after_hi,
    ]
    .into_iter()
    .map(Fr::from)
    .collect()
}

struct SkeletonKeys {
    pk: ProvingKey<Bn254>,
    pvk: PreparedVerifyingKey<Bn254>,
}

fn keys() -> &'static SkeletonKeys {
    KEYS.get_or_init(|| {
        let sample = sample_public();
        let (difference, time_delta) = witnesses(&sample).expect("sample skeleton");
        let circuit = SkeletonCircuit { public: sample, difference, time_delta };
        let mut rng = StdRng::seed_from_u64(0x5E11_7014);
        let (pk, vk) = Groth16::<Bn254>::circuit_specific_setup(circuit, &mut rng)
            .expect("successor skeleton setup");
        SkeletonKeys { pk, pvk: prepare_verifying_key(&vk) }
    })
}

static KEYS: OnceLock<SkeletonKeys> = OnceLock::new();

fn sample_public() -> SkeletonPublic {
    SkeletonPublic {
        height_before: 0,
        height_after: 1,
        timestamp_before: 1_700_000_000,
        timestamp_after: 1_700_000_012,
        difficulty: 1_000_000,
        residual_fp: 5,
        threshold_fp: 1_000,
        balance_before: 40,
        liquid: 2,
        balance_after: 42,
        before_lo: 1,
        before_hi: 2,
        transition_lo: 3,
        transition_hi: 4,
        after_lo: 5,
        after_hi: 6,
    }
}

pub fn prove_successor_skeleton(public: &SkeletonPublic) -> Result<Vec<u8>, &'static str> {
    let (difference, time_delta) = witnesses(public)?;
    let circuit = SkeletonCircuit { public: *public, difference, time_delta };
    let mut rng = StdRng::seed_from_u64(0x5E11_7014);
    let proof = Groth16::<Bn254>::prove(&keys().pk, circuit, &mut rng).map_err(|_| "skeleton proving failed")?;
    let mut bytes = Vec::new();
    use ark_serialize::CanonicalSerialize;
    proof.serialize_compressed(&mut bytes).map_err(|_| "skeleton proof did not serialize")?;
    Ok(bytes)
}

pub fn verify_successor_skeleton(proof_bytes: &[u8], public: &SkeletonPublic) -> bool {
    use ark_serialize::CanonicalDeserialize;
    let proof = match ark_groth16::Proof::<Bn254>::deserialize_compressed(proof_bytes) {
        Ok(proof) => proof,
        Err(_) => return false,
    };
    Groth16::<Bn254>::verify_proof(&keys().pvk, &proof, &statement(public)).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_integer_successor_verifies_and_a_different_statement_does_not() {
        let public = sample_public();
        let proof = prove_successor_skeleton(&public).expect("prove");
        assert!(verify_successor_skeleton(&proof, &public));

        let mut other_height = public;
        other_height.height_after = 2;
        assert!(!verify_successor_skeleton(&proof, &other_height));

        let mut other_balance = public;
        other_balance.balance_after = 41;
        assert!(!verify_successor_skeleton(&proof, &other_balance));

        let mut other_transition = public;
        other_transition.transition_lo = 9;
        assert!(!verify_successor_skeleton(&proof, &other_transition));

        let mut backwards = public;
        backwards.timestamp_after = public.timestamp_before - 1;
        assert!(prove_successor_skeleton(&backwards).is_err());

        let mut level = public;
        level.residual_fp = level.threshold_fp;
        assert!(prove_successor_skeleton(&level).is_err());
    }
}
