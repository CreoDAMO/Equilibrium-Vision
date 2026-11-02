//! Public statement of the transition proof.
//!
//! The public inputs are the statement id and the integers every successor
//! exposes. The circuit checks the next height, a timestamp that does not
//! move backwards, a liquid credit, and a residual under the threshold.
//! It does not compute `applySuccessor`. `verify_transition_statement`
//! therefore rejects every proof.

use ark_bn254::{Bn254, Fr};
use ark_ff::{Field, One, PrimeField, Zero};
use ark_groth16::{prepare_verifying_key, Groth16, PreparedVerifyingKey, ProvingKey};
use ark_r1cs_std::fields::fp::FpVar;
use ark_r1cs_std::prelude::*;
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use ark_snark::SNARK;
use rand::rngs::StdRng;
use rand::SeedableRng;
use std::sync::OnceLock;

const DEV_SETUP_SEED: u64 = 0xFA17_0002;

/// This circuit is not the production relation.
pub const COVERS_APPLY_SUCCESSOR: bool = false;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StatementPublic {
    pub statement_lo: u128,
    pub statement_hi: u128,
    pub height_before: u64,
    pub height_after: u64,
    pub timestamp_before: u64,
    pub timestamp_after: u64,
    pub residual_fp: u64,
    pub threshold_fp: u64,
    pub balance_before: u64,
    pub liquid: u64,
    pub balance_after: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatementProof {
    pub bytes: Vec<u8>,
    pub public_inputs: StatementPublic,
}

#[derive(Clone)]
struct StatementCircuit {
    public: StatementPublic,
    difference: u64,
    time_delta: u64,
}

fn fr_u128(value: u128) -> Fr {
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(&value.to_le_bytes());
    Fr::from_le_bytes_mod_order(&bytes)
}

fn fit_width<F: PrimeField>(value: &FpVar<F>, width: usize) -> Result<(), SynthesisError> {
    let bits = value.to_bits_le()?;
    for bit in bits.iter().skip(width) {
        bit.enforce_equal(&Boolean::FALSE)?;
    }
    Ok(())
}

fn bind_u128(cs: ConstraintSystemRef<Fr>, value: &FpVar<Fr>, native: u128) -> Result<(), SynthesisError> {
    fit_width(value, 128)?;
    let copy = FpVar::new_witness(cs, || Ok(fr_u128(native)))?;
    value.enforce_equal(&copy)?;
    Ok(())
}

fn input_u64(cs: ConstraintSystemRef<Fr>, value: u64) -> Result<FpVar<Fr>, SynthesisError> {
    FpVar::new_input(cs, || Ok(Fr::from(value)))
}

fn input_u128(cs: ConstraintSystemRef<Fr>, value: u128) -> Result<FpVar<Fr>, SynthesisError> {
    FpVar::new_input(cs, || Ok(fr_u128(value)))
}

impl ConstraintSynthesizer<Fr> for StatementCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let statement_lo = input_u128(cs.clone(), self.public.statement_lo)?;
        let statement_hi = input_u128(cs.clone(), self.public.statement_hi)?;
        bind_u128(cs.clone(), &statement_lo, self.public.statement_lo)?;
        bind_u128(cs.clone(), &statement_hi, self.public.statement_hi)?;

        let height_before = input_u64(cs.clone(), self.public.height_before)?;
        let height_after = input_u64(cs.clone(), self.public.height_after)?;
        let timestamp_before = input_u64(cs.clone(), self.public.timestamp_before)?;
        let timestamp_after = input_u64(cs.clone(), self.public.timestamp_after)?;
        let residual = input_u64(cs.clone(), self.public.residual_fp)?;
        let threshold = input_u64(cs.clone(), self.public.threshold_fp)?;
        let balance_before = input_u64(cs.clone(), self.public.balance_before)?;
        let liquid = input_u64(cs.clone(), self.public.liquid)?;
        let balance_after = input_u64(cs.clone(), self.public.balance_after)?;
        for value in [
            &height_before,
            &height_after,
            &timestamp_before,
            &timestamp_after,
            &residual,
            &threshold,
            &balance_before,
            &liquid,
            &balance_after,
        ] {
            fit_width(value, 64)?;
        }

        (&height_before + &FpVar::constant(Fr::one())).enforce_equal(&height_after)?;
        let delta = FpVar::new_witness(cs.clone(), || Ok(Fr::from(self.time_delta)))?;
        fit_width(&delta, 64)?;
        (&timestamp_before + &delta).enforce_equal(&timestamp_after)?;
        (&balance_before + &liquid).enforce_equal(&balance_after)?;

        let difference = FpVar::new_witness(cs.clone(), || Ok(Fr::from(self.difference)))?;
        fit_width(&difference, 64)?;
        (&residual + &difference).enforce_equal(&threshold)?;
        let inverse = FpVar::new_witness(cs, || {
            let value = difference.value().unwrap_or(Fr::zero());
            Ok(value.inverse().unwrap_or(Fr::one()))
        })?;
        difference.mul_equals(&inverse, &FpVar::constant(Fr::one()))?;
        Ok(())
    }
}

fn witnesses(public: &StatementPublic) -> Result<(u64, u64), &'static str> {
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

fn public_inputs(public: &StatementPublic) -> Vec<Fr> {
    let mut out = vec![fr_u128(public.statement_lo), fr_u128(public.statement_hi)];
    for value in [
        public.height_before,
        public.height_after,
        public.timestamp_before,
        public.timestamp_after,
        public.residual_fp,
        public.threshold_fp,
        public.balance_before,
        public.liquid,
        public.balance_after,
    ] {
        out.push(Fr::from(value));
    }
    out
}

struct Keys {
    pk: ProvingKey<Bn254>,
    pvk: PreparedVerifyingKey<Bn254>,
}

fn keys() -> &'static Keys {
    KEYS.get_or_init(|| {
        let public = sample_public();
        let (difference, time_delta) = witnesses(&public).expect("sample statement");
        let circuit = StatementCircuit { public, difference, time_delta };
        let mut rng = StdRng::seed_from_u64(DEV_SETUP_SEED);
        let (pk, vk) = Groth16::<Bn254>::circuit_specific_setup(circuit, &mut rng).expect("statement setup");
        Keys { pk, pvk: prepare_verifying_key(&vk) }
    })
}

static KEYS: OnceLock<Keys> = OnceLock::new();

fn sample_public() -> StatementPublic {
    StatementPublic {
        statement_lo: 0x1111_2222_3333_4444_5555_6666_7777_8888,
        statement_hi: 0x9999_aaaa_bbbb_cccc_dddd_eeee_ffff_0000,
        height_before: 1,
        height_after: 2,
        timestamp_before: 1_700_000_000,
        timestamp_after: 1_700_000_012,
        residual_fp: 5,
        threshold_fp: 1_000,
        balance_before: 40,
        liquid: 2,
        balance_after: 42,
    }
}

pub fn prove_statement_integers(public: &StatementPublic) -> Result<StatementProof, &'static str> {
    let (difference, time_delta) = witnesses(public)?;
    let circuit = StatementCircuit { public: *public, difference, time_delta };
    let mut rng = StdRng::seed_from_u64(DEV_SETUP_SEED);
    let proof = Groth16::<Bn254>::prove(&keys().pk, circuit, &mut rng).map_err(|_| "statement proving failed")?;
    let mut bytes = Vec::new();
    proof.serialize_compressed(&mut bytes).map_err(|_| "statement proof did not serialize")?;
    Ok(StatementProof { bytes, public_inputs: *public })
}

fn partial_verifies(proof: &StatementProof) -> bool {
    let inputs = public_inputs(&proof.public_inputs);
    let vk = &keys().pvk.vk;
    if inputs.len() + 1 != vk.gamma_abc_g1.len() {
        return false;
    }
    let parsed = match ark_groth16::Proof::<Bn254>::deserialize_compressed(proof.bytes.as_slice()) {
        Ok(parsed) => parsed,
        Err(_) => return false,
    };
    Groth16::<Bn254>::verify_proof(&keys().pvk, &parsed, &inputs).unwrap_or(false)
}

/// The admission check. A partial integer proof is not accepted.
pub fn verify_transition_statement(proof: &StatementProof) -> bool {
    if !COVERS_APPLY_SUCCESSOR {
        return false;
    }
    partial_verifies(proof)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_integer_proof_verifies_and_is_not_the_transition() {
        let public = sample_public();
        let proof = prove_statement_integers(&public).expect("prove");
        assert!(partial_verifies(&proof));
        assert!(!verify_transition_statement(&proof));
        assert!(!COVERS_APPLY_SUCCESSOR);

        let mut other = proof.clone();
        other.public_inputs.statement_hi ^= 1;
        assert!(!partial_verifies(&other));

        let mut wrong_height = proof.clone();
        wrong_height.public_inputs.height_after = 3;
        assert!(!partial_verifies(&wrong_height));
    }
}
