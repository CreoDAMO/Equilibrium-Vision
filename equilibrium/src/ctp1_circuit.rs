//! Groth16 binding for the integer projection of one CTP-1 statement.
//!
//! Verification does not call `successor` or `applySuccessor`. The public
//! inputs are the statement id and the integers a real transition emitted.
//! The circuit checks height, time, and the liquid credit. It does not
//! compute the residual, the header, the wasm host, or the ledger. A proof
//! of these integers is not a proof of `Reference`. C-007 stays open.

use ark_bn254::{Bn254, Fr};
use ark_ff::{One, PrimeField};
use ark_groth16::{prepare_verifying_key, Groth16, PreparedVerifyingKey, ProvingKey};
use ark_r1cs_std::fields::fp::FpVar;
use ark_r1cs_std::prelude::*;
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use ark_snark::SNARK;
use rand::rngs::StdRng;
use rand::SeedableRng;
use std::sync::OnceLock;

/// Public statement. The id is the CTP-1 statement id, as four big-endian limbs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ctp1Integers {
    pub id: [u64; 4],
    pub height_before: u64,
    pub height_after: u64,
    pub timestamp_before: u64,
    pub timestamp_after: u64,
    pub residual_fp: u64,
    pub balance_before: u64,
    pub liquid: u64,
    pub balance_after: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ctp1IntegerProof {
    pub bytes: Vec<u8>,
    pub public_inputs: Ctp1Integers,
}

#[derive(Clone)]
struct Ctp1Circuit {
    public: Ctp1Integers,
    time_delta: u64,
}

fn fit_u64<F: PrimeField>(value: &FpVar<F>) -> Result<(), SynthesisError> {
    let bits = value.to_bits_le()?;
    for bit in bits.iter().skip(64) {
        bit.enforce_equal(&Boolean::FALSE)?;
    }
    Ok(())
}

fn input(cs: ConstraintSystemRef<Fr>, value: u64) -> Result<FpVar<Fr>, SynthesisError> {
    FpVar::new_input(cs, || Ok(Fr::from(value)))
}

impl ConstraintSynthesizer<Fr> for Ctp1Circuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        for limb in self.public.id {
            let limb = input(cs.clone(), limb)?;
            fit_u64(&limb)?;
        }
        let height_before = input(cs.clone(), self.public.height_before)?;
        let height_after = input(cs.clone(), self.public.height_after)?;
        let timestamp_before = input(cs.clone(), self.public.timestamp_before)?;
        let timestamp_after = input(cs.clone(), self.public.timestamp_after)?;
        let residual = input(cs.clone(), self.public.residual_fp)?;
        let balance_before = input(cs.clone(), self.public.balance_before)?;
        let liquid = input(cs.clone(), self.public.liquid)?;
        let balance_after = input(cs.clone(), self.public.balance_after)?;

        fit_u64(&height_before)?;
        fit_u64(&height_after)?;
        fit_u64(&timestamp_before)?;
        fit_u64(&timestamp_after)?;
        fit_u64(&residual)?;
        fit_u64(&balance_before)?;
        fit_u64(&liquid)?;
        fit_u64(&balance_after)?;

        (&height_before + &FpVar::constant(Fr::one())).enforce_equal(&height_after)?;
        let delta = FpVar::new_witness(cs, || Ok(Fr::from(self.time_delta)))?;
        fit_u64(&delta)?;
        (&timestamp_before + &delta).enforce_equal(&timestamp_after)?;
        (&balance_before + &liquid).enforce_equal(&balance_after)?;
        Ok(())
    }
}

fn statement(public: &Ctp1Integers) -> Vec<Fr> {
    let mut values = public.id.to_vec();
    values.extend([
        public.height_before,
        public.height_after,
        public.timestamp_before,
        public.timestamp_after,
        public.residual_fp,
        public.balance_before,
        public.liquid,
        public.balance_after,
    ]);
    values.into_iter().map(Fr::from).collect()
}

fn witnesses(public: &Ctp1Integers) -> Result<u64, &'static str> {
    if public.height_after != public.height_before.saturating_add(1) || public.height_before == u64::MAX {
        return Err("height is not the next height");
    }
    if public.timestamp_after < public.timestamp_before {
        return Err("timestamp moved backwards");
    }
    let credited = u128::from(public.balance_before) + u128::from(public.liquid);
    if credited != u128::from(public.balance_after) {
        return Err("balance is not the predecessor plus the liquid credit");
    }
    Ok(public.timestamp_after - public.timestamp_before)
}

struct Keys {
    pk: ProvingKey<Bn254>,
    pvk: PreparedVerifyingKey<Bn254>,
}

fn keys() -> &'static Keys {
    KEYS.get_or_init(|| {
        let public = sample();
        let time_delta = witnesses(&public).expect("sample");
        let circuit = Ctp1Circuit { public, time_delta };
        let mut rng = StdRng::seed_from_u64(0xC7_0001);
        let (pk, vk) = Groth16::<Bn254>::circuit_specific_setup(circuit, &mut rng).expect("ctp1 setup");
        Keys { pk, pvk: prepare_verifying_key(&vk) }
    })
}

static KEYS: OnceLock<Keys> = OnceLock::new();

fn sample() -> Ctp1Integers {
    Ctp1Integers {
        id: [1, 2, 3, 4],
        height_before: 0,
        height_after: 1,
        timestamp_before: 12,
        timestamp_after: 24,
        residual_fp: 5,
        balance_before: 40,
        liquid: 2,
        balance_after: 42,
    }
}

pub fn prove_ctp1_integers(public: &Ctp1Integers) -> Result<Ctp1IntegerProof, &'static str> {
    let time_delta = witnesses(public)?;
    let circuit = Ctp1Circuit { public: *public, time_delta };
    let mut rng = StdRng::seed_from_u64(0xC7_0001);
    let proof = Groth16::<Bn254>::prove(&keys().pk, circuit, &mut rng).map_err(|_| "ctp1 proving failed")?;
    let mut bytes = Vec::new();
    proof.serialize_compressed(&mut bytes).map_err(|_| "ctp1 proof did not serialize")?;
    Ok(Ctp1IntegerProof { bytes, public_inputs: *public })
}

/// Pairing check only. This function does not execute the transition.
pub fn verify_ctp1_integers(proof: &Ctp1IntegerProof) -> bool {
    let parsed = match ark_groth16::Proof::<Bn254>::deserialize_compressed(proof.bytes.as_slice()) {
        Ok(proof) => proof,
        Err(_) => return false,
    };
    Groth16::<Bn254>::verify_proof(&keys().pvk, &parsed, &statement(&proof.public_inputs)).unwrap_or(false)
}

/// The interior difficulty branch: the factor is not exactly 0.8 or 1.2,
/// so production uses integer division rather than `floor(difficulty * factor)`.
/// The 1.2 clamp that produced statement 801861c3… is not this branch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DifficultyInterior {
    pub difficulty_before: u64,
    pub target_seconds: u64,
    pub block_time: u64,
    pub foreign_num: u64,
    pub foreign_den: u64,
    pub difficulty_after: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DifficultyProof {
    pub bytes: Vec<u8>,
    pub public_inputs: DifficultyInterior,
}

struct DifficultyCircuit {
    public: DifficultyInterior,
    quotient: u64,
    remainder: u64,
    gap: u64,
    slack: u64,
}

fn difficulty_witnesses(public: &DifficultyInterior) -> Result<(u64, u64, u64, u64), &'static str> {
    if public.block_time == 0 || public.foreign_den == 0 || public.target_seconds == 0 || public.foreign_num == 0 {
        return Err("difficulty divisor is zero");
    }
    let divisor = u128::from(public.block_time) * u128::from(public.foreign_den);
    let numerator = u128::from(public.difficulty_before) * u128::from(public.target_seconds) * u128::from(public.foreign_num);
    let quotient = numerator / divisor;
    let remainder = numerator % divisor;
    if quotient < 100_000 || quotient > u128::from(u64::MAX) || remainder > u128::from(u64::MAX) {
        return Err("difficulty quotient is outside the interior branch");
    }
    if u128::from(public.difficulty_after) != quotient {
        return Err("difficulty is not the interior quotient");
    }
    let gap = divisor - remainder - 1;
    let slack = quotient - 100_000;
    Ok((quotient as u64, remainder as u64, gap as u64, slack as u64))
}

impl ConstraintSynthesizer<Fr> for DifficultyCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let before = input(cs.clone(), self.public.difficulty_before)?;
        let target = input(cs.clone(), self.public.target_seconds)?;
        let block_time = input(cs.clone(), self.public.block_time)?;
        let foreign_num = input(cs.clone(), self.public.foreign_num)?;
        let foreign_den = input(cs.clone(), self.public.foreign_den)?;
        let after = input(cs.clone(), self.public.difficulty_after)?;
        for value in [&before, &target, &block_time, &foreign_num, &foreign_den, &after] {
            fit_u64(value)?;
        }
        let quotient = FpVar::new_witness(cs.clone(), || Ok(Fr::from(self.quotient)))?;
        let remainder = FpVar::new_witness(cs.clone(), || Ok(Fr::from(self.remainder)))?;
        let gap = FpVar::new_witness(cs.clone(), || Ok(Fr::from(self.gap)))?;
        let slack = FpVar::new_witness(cs.clone(), || Ok(Fr::from(self.slack)))?;
        fit_u64(&quotient)?;
        fit_u64(&remainder)?;
        fit_u64(&gap)?;
        fit_u64(&slack)?;
        let divisor = &block_time * &foreign_den;
        let numerator = &before * &target * &foreign_num;
        numerator.enforce_equal(&(&quotient * &divisor + &remainder))?;
        divisor.enforce_equal(&(&remainder + &gap + FpVar::constant(Fr::one())))?;
        quotient.enforce_equal(&(&slack + FpVar::constant(Fr::from(100_000u64))))?;
        after.enforce_equal(&quotient)?;
        Ok(())
    }
}

fn difficulty_statement(public: &DifficultyInterior) -> Vec<Fr> {
    [
        public.difficulty_before,
        public.target_seconds,
        public.block_time,
        public.foreign_num,
        public.foreign_den,
        public.difficulty_after,
    ]
    .into_iter()
    .map(Fr::from)
    .collect()
}

struct DifficultyKeys {
    pk: ProvingKey<Bn254>,
    pvk: PreparedVerifyingKey<Bn254>,
}

fn difficulty_keys() -> &'static DifficultyKeys {
    DIFFICULTY_KEYS.get_or_init(|| {
        let public = DifficultyInterior {
            difficulty_before: 200_000,
            target_seconds: 15,
            block_time: 16,
            foreign_num: 1,
            foreign_den: 1,
            difficulty_after: 187_500,
        };
        let (quotient, remainder, gap, slack) = difficulty_witnesses(&public).expect("sample difficulty");
        let circuit = DifficultyCircuit { public, quotient, remainder, gap, slack };
        let mut rng = StdRng::seed_from_u64(0xD1FF_0016);
        let (pk, vk) = Groth16::<Bn254>::circuit_specific_setup(circuit, &mut rng).expect("difficulty setup");
        DifficultyKeys { pk, pvk: prepare_verifying_key(&vk) }
    })
}

static DIFFICULTY_KEYS: OnceLock<DifficultyKeys> = OnceLock::new();

pub fn prove_difficulty_interior(public: &DifficultyInterior) -> Result<DifficultyProof, &'static str> {
    let (quotient, remainder, gap, slack) = difficulty_witnesses(public)?;
    let circuit = DifficultyCircuit { public: *public, quotient, remainder, gap, slack };
    let mut rng = StdRng::seed_from_u64(0xD1FF_0016);
    let proof = Groth16::<Bn254>::prove(&difficulty_keys().pk, circuit, &mut rng).map_err(|_| "difficulty proving failed")?;
    let mut bytes = Vec::new();
    proof.serialize_compressed(&mut bytes).map_err(|_| "difficulty proof did not serialize")?;
    Ok(DifficultyProof { bytes, public_inputs: *public })
}

pub fn verify_difficulty_interior(proof: &DifficultyProof) -> bool {
    let parsed = match ark_groth16::Proof::<Bn254>::deserialize_compressed(proof.bytes.as_slice()) {
        Ok(proof) => proof,
        Err(_) => return false,
    };
    Groth16::<Bn254>::verify_proof(&difficulty_keys().pvk, &parsed, &difficulty_statement(&proof.public_inputs)).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn production_second_block() -> Ctp1Integers {
        let id = hex_id("801861c38e8d596fdc42b6e6d63ac2dae0941f723dd9083415fad7240b2aef30");
        Ctp1Integers {
            id,
            height_before: 0,
            height_after: 1,
            timestamp_before: 12,
            timestamp_after: 24,
            residual_fp: 2_963_790_084_620_703,
            balance_before: 1_500_000,
            liquid: 2,
            balance_after: 1_500_002,
        }
    }

    fn hex_id(hex: &str) -> [u64; 4] {
        let bytes = hex::decode(hex).unwrap();
        let mut id = [0u64; 4];
        for (i, limb) in id.iter_mut().enumerate() {
            let mut raw = [0u8; 8];
            raw.copy_from_slice(&bytes[i * 8..(i + 1) * 8]);
            *limb = u64::from_be_bytes(raw);
        }
        id
    }

    #[test]
    fn a_real_statement_verifies_without_reexecuting_the_transition() {
        let public = production_second_block();
        let proof = prove_ctp1_integers(&public).expect("prove");
        assert!(verify_ctp1_integers(&proof));

        let mut other = proof.clone();
        other.public_inputs.id[0] ^= 1;
        assert!(!verify_ctp1_integers(&other));

        let mut moved = proof.clone();
        moved.public_inputs.balance_after = 1_500_003;
        assert!(!verify_ctp1_integers(&moved));

        let mut early = proof;
        early.public_inputs.height_after = 2;
        assert!(!verify_ctp1_integers(&early));
    }

    #[test]
    fn the_interior_difficulty_branch_is_computed_and_the_clamp_is_not() {
        let public = DifficultyInterior {
            difficulty_before: 200_000,
            target_seconds: 15,
            block_time: 16,
            foreign_num: 1,
            foreign_den: 1,
            difficulty_after: 187_500,
        };
        let proof = prove_difficulty_interior(&public).expect("prove");
        assert!(verify_difficulty_interior(&proof));
        let mut other = proof.clone();
        other.public_inputs.difficulty_after = 187_501;
        assert!(!verify_difficulty_interior(&other));

        let clamp = DifficultyInterior {
            difficulty_before: 1_000_000,
            target_seconds: 15,
            block_time: 12,
            foreign_num: 1,
            foreign_den: 1,
            difficulty_after: 1_200_000,
        };
        assert!(prove_difficulty_interior(&clamp).is_err());
    }
}
