//! Opening of the `faithful-v1.1` statement.
//!
//! The circuit proves four integer checks from the production relation:
//! the next height, a timestamp that does not move backwards, a liquid
//! credit, and a residual strictly under the threshold. It accepts only
//! the pinned `faithful-v1.1` identifier.
//!
//! Predecessor, carried state, and header are public inputs. Each limb is
//! constrained to 128 bits and is named in a constraint, so the verifying
//! key cannot treat it as unused. They are not computed from a predecessor.
//! This is not a proof of `applySuccessor`.
//!
//! The setup seed is a development seed. It is not a production ceremony.

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
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

/// Development setup only. A production ceremony is a different key.
const DEV_SETUP_SEED: u64 = 0xFA17_0001;

/// First and second 16 bytes of the pinned `faithful-v1.1` descriptor, big-endian.
pub const FAITHFUL_V1_LO: u128 = 0x83ea7e2c265abe5911667eb47724a5c4;
pub const FAITHFUL_V1_HI: u128 = 0x7f227afdcdacc3f20fd5105e9a114bb2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FaithfulPublic {
    pub height_before: u64,
    pub height_after: u64,
    pub timestamp_before: u64,
    pub timestamp_after: u64,
    pub residual_fp: u64,
    pub threshold_fp: u64,
    pub balance_before: u64,
    pub liquid: u64,
    pub balance_after: u64,
    pub predecessor_lo: u128,
    pub predecessor_hi: u128,
    pub carried_lo: u128,
    pub carried_hi: u128,
    pub header_lo: u128,
    pub header_hi: u128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FaithfulProof {
    pub bytes: Vec<u8>,
    pub public_inputs: FaithfulPublic,
}

#[derive(Clone)]
struct FaithfulCircuit {
    public: FaithfulPublic,
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

impl ConstraintSynthesizer<Fr> for FaithfulCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let version = input_u64(cs.clone(), 1)?;
        version.enforce_equal(&FpVar::constant(Fr::one()))?;

        let relation_lo = input_u128(cs.clone(), FAITHFUL_V1_LO)?;
        let relation_hi = input_u128(cs.clone(), FAITHFUL_V1_HI)?;
        relation_lo.enforce_equal(&FpVar::constant(fr_u128(FAITHFUL_V1_LO)))?;
        relation_hi.enforce_equal(&FpVar::constant(fr_u128(FAITHFUL_V1_HI)))?;

        let height_before = input_u64(cs.clone(), self.public.height_before)?;
        let height_after = input_u64(cs.clone(), self.public.height_after)?;
        let timestamp_before = input_u64(cs.clone(), self.public.timestamp_before)?;
        let timestamp_after = input_u64(cs.clone(), self.public.timestamp_after)?;
        let residual = input_u64(cs.clone(), self.public.residual_fp)?;
        let threshold = input_u64(cs.clone(), self.public.threshold_fp)?;
        let balance_before = input_u64(cs.clone(), self.public.balance_before)?;
        let liquid = input_u64(cs.clone(), self.public.liquid)?;
        let balance_after = input_u64(cs.clone(), self.public.balance_after)?;
        let predecessor_lo = input_u128(cs.clone(), self.public.predecessor_lo)?;
        let predecessor_hi = input_u128(cs.clone(), self.public.predecessor_hi)?;
        let carried_lo = input_u128(cs.clone(), self.public.carried_lo)?;
        let carried_hi = input_u128(cs.clone(), self.public.carried_hi)?;
        let header_lo = input_u128(cs.clone(), self.public.header_lo)?;
        let header_hi = input_u128(cs.clone(), self.public.header_hi)?;

        fit_width(&height_before, 64)?;
        fit_width(&height_after, 64)?;
        fit_width(&timestamp_before, 64)?;
        fit_width(&timestamp_after, 64)?;
        fit_width(&residual, 64)?;
        fit_width(&threshold, 64)?;
        fit_width(&balance_before, 64)?;
        fit_width(&liquid, 64)?;
        fit_width(&balance_after, 64)?;
        bind_u128(cs.clone(), &predecessor_lo, self.public.predecessor_lo)?;
        bind_u128(cs.clone(), &predecessor_hi, self.public.predecessor_hi)?;
        bind_u128(cs.clone(), &carried_lo, self.public.carried_lo)?;
        bind_u128(cs.clone(), &carried_hi, self.public.carried_hi)?;
        bind_u128(cs.clone(), &header_lo, self.public.header_lo)?;
        bind_u128(cs.clone(), &header_hi, self.public.header_hi)?;

        let stepped = &height_before + &FpVar::constant(Fr::one());
        stepped.enforce_equal(&height_after)?;

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

fn witnesses(public: &FaithfulPublic) -> Result<(u64, u64), &'static str> {
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

fn statement(public: &FaithfulPublic) -> Vec<Fr> {
    let mut out = vec![Fr::one(), fr_u128(FAITHFUL_V1_LO), fr_u128(FAITHFUL_V1_HI)];
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
    for value in [
        public.predecessor_lo,
        public.predecessor_hi,
        public.carried_lo,
        public.carried_hi,
        public.header_lo,
        public.header_hi,
    ] {
        out.push(fr_u128(value));
    }
    out
}

struct FaithfulKeys {
    pk: ProvingKey<Bn254>,
    pvk: PreparedVerifyingKey<Bn254>,
}

fn keys() -> &'static FaithfulKeys {
    KEYS.get_or_init(|| {
        let public = sample_public();
        let (difference, time_delta) = witnesses(&public).expect("sample faithful statement");
        let circuit = FaithfulCircuit { public, difference, time_delta };
        let mut rng = StdRng::seed_from_u64(DEV_SETUP_SEED);
        let (pk, vk) = Groth16::<Bn254>::circuit_specific_setup(circuit, &mut rng).expect("faithful setup");
        FaithfulKeys { pk, pvk: prepare_verifying_key(&vk) }
    })
}

static KEYS: OnceLock<FaithfulKeys> = OnceLock::new();

fn sample_public() -> FaithfulPublic {
    FaithfulPublic {
        height_before: 1,
        height_after: 2,
        timestamp_before: 1_700_000_000,
        timestamp_after: 1_700_000_012,
        residual_fp: 5,
        threshold_fp: 1_000,
        balance_before: 40,
        liquid: 2,
        balance_after: 42,
        predecessor_lo: 11,
        predecessor_hi: 12,
        carried_lo: 21,
        carried_hi: 22,
        header_lo: 31,
        header_hi: 32,
    }
}

pub fn prove_faithful_v1(public: &FaithfulPublic) -> Result<FaithfulProof, &'static str> {
    let (difference, time_delta) = witnesses(public)?;
    let circuit = FaithfulCircuit { public: *public, difference, time_delta };
    let mut rng = StdRng::seed_from_u64(DEV_SETUP_SEED);
    let proof = Groth16::<Bn254>::prove(&keys().pk, circuit, &mut rng).map_err(|_| "faithful proving failed")?;
    let mut bytes = Vec::new();
    proof.serialize_compressed(&mut bytes).map_err(|_| "faithful proof did not serialize")?;
    Ok(FaithfulProof { bytes, public_inputs: *public })
}

pub fn verify_faithful_v1(proof: &FaithfulProof) -> bool {
    let inputs = statement(&proof.public_inputs);
    let vk = &keys().pvk.vk;
    if inputs.len() + 1 != vk.gamma_abc_g1.len() {
        return false;
    }
    if inputs[1] != fr_u128(FAITHFUL_V1_LO) || inputs[2] != fr_u128(FAITHFUL_V1_HI) {
        return false;
    }
    let parsed = match ark_groth16::Proof::<Bn254>::deserialize_compressed(proof.bytes.as_slice()) {
        Ok(parsed) => parsed,
        Err(_) => return false,
    };
    Groth16::<Bn254>::verify_proof(&keys().pvk, &parsed, &inputs).unwrap_or(false)
}

pub fn verifying_key_fingerprint() -> String {
    let mut bytes = Vec::new();
    keys().pvk.vk.serialize_compressed(&mut bytes).expect("verifying key serializes");
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_ec::AffineRepr;

    #[test]
    fn the_pinned_relation_verifies_and_a_different_statement_does_not() {
        let public = sample_public();
        let proof = prove_faithful_v1(&public).expect("prove");
        assert!(verify_faithful_v1(&proof));

        let mut other_height = proof.clone();
        other_height.public_inputs.height_after = 3;
        assert!(!verify_faithful_v1(&other_height));

        let mut other_predecessor = proof.clone();
        other_predecessor.public_inputs.predecessor_hi = 97;
        assert!(!verify_faithful_v1(&other_predecessor));

        let mut other_carried = proof.clone();
        other_carried.public_inputs.carried_lo = 99;
        assert!(!verify_faithful_v1(&other_carried));

        let mut other_header = proof.clone();
        other_header.public_inputs.header_hi = 98;
        assert!(!verify_faithful_v1(&other_header));

        let mut backwards = public;
        backwards.timestamp_after = public.timestamp_before - 1;
        assert!(prove_faithful_v1(&backwards).is_err());

        let mut credited = public;
        credited.balance_after = 41;
        assert!(prove_faithful_v1(&credited).is_err());

        let mut level = public;
        level.residual_fp = level.threshold_fp;
        assert!(prove_faithful_v1(&level).is_err());

        let inputs = statement(&proof.public_inputs);
        let parsed = ark_groth16::Proof::<Bn254>::deserialize_compressed(proof.bytes.as_slice()).expect("proof bytes");
        let short = &inputs[..inputs.len() - 1];
        assert!(Groth16::<Bn254>::verify_proof(&keys().pvk, &parsed, short).is_err());
    }

    #[test]
    fn each_identifier_limb_is_named_in_a_constraint() {
        use ark_relations::r1cs::ConstraintSystem;
        let public = sample_public();
        let (difference, time_delta) = witnesses(&public).expect("witness");
        let cs = ConstraintSystem::<Fr>::new_ref();
        FaithfulCircuit { public, difference, time_delta }
            .generate_constraints(cs.clone())
            .expect("constraints");
        cs.finalize();
        let matrices = cs.to_matrices().expect("matrices");
        for index in 13..=18 {
            let named = matrices
                .a
                .iter()
                .chain(&matrices.b)
                .chain(&matrices.c)
                .any(|row| row.iter().any(|&(_, column)| column == index));
            assert!(named, "public input {index} is not in a constraint");
        }
    }

    #[test]
    fn the_development_key_is_the_pinned_key() {
        let fingerprint = verifying_key_fingerprint();
        assert_eq!(fingerprint, "fd66c1dcc648e5b10d8fe2c26481737e8815aff32e30fd735b602e5c23f4d7e8");
    }

    #[test]
    fn the_relation_limbs_are_the_pinned_descriptor() {
        let hex = format!("{FAITHFUL_V1_LO:032x}{FAITHFUL_V1_HI:032x}");
        assert_eq!(hex, "83ea7e2c265abe5911667eb47724a5c47f227afdcdacc3f20fd5105e9a114bb2");
    }

    #[test]
    fn every_public_input_has_a_non_identity_coefficient() {
        let vk = &keys().pvk.vk;
        assert_eq!(vk.gamma_abc_g1.len(), 19);
        for (i, point) in vk.gamma_abc_g1.iter().enumerate() {
            assert!(!point.is_zero(), "public input {i} has the identity coefficient");
        }
    }
}
