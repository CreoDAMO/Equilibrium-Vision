//! One statement: the 80-byte header, the residual, the height-1 reward, and the split.
//! The reward is not a public input.

use crate::binary64;
use crate::difficulty_law::{
    self, at_least, enforce_add, enforce_div, enforce_floor, enforce_from_u64, enforce_mul, enforce_rounded_u64,
    enforce_sub_abs, u64_of,
};
use crate::header_digest::enforce_header_hash;
use ark_bn254::{Bn254, Fr};
use ark_ff::{One, Zero};
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

pub const VALIDATOR_COUNT: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DerivedReward {
    pub id: [u64; 4],
    pub header: [u8; 80],
    pub difficulty: u64,
    pub height: u64,
    pub residual: u64,
    pub base: u64,
    pub liquid: u64,
    pub balance_before: u64,
    pub balance_after: u64,
    pub stakes: [u64; VALIDATOR_COUNT],
    pub shares: [u64; VALIDATOR_COUNT],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DerivedRewardProof {
    pub bytes: Vec<u8>,
    pub public_inputs: DerivedReward,
}

#[derive(Clone, Copy)]
struct RewardCircuit {
    public: DerivedReward,
}

fn input(cs: ConstraintSystemRef<Fr>, value: u64) -> Result<FpVar<Fr>, SynthesisError> {
    FpVar::new_input(cs, || Ok(Fr::from(value)))
}

impl ConstraintSynthesizer<Fr> for RewardCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        for limb in self.public.id {
            let limb = input(cs.clone(), limb)?;
            let _ = difficulty_law::u64_of(&limb);
            let bits = limb.to_bits_le()?;
            for bit in bits.iter().skip(64) {
                bit.enforce_equal(&Boolean::FALSE)?;
            }
        }
        let mut header = Vec::with_capacity(80);
        for byte in self.public.header {
            header.push(input(cs.clone(), byte as u64)?);
        }
        let header: [FpVar<Fr>; 80] = header.try_into().unwrap();
        let difficulty = input(cs.clone(), self.public.difficulty)?;
        let height = input(cs.clone(), self.public.height)?;
        let residual_in = input(cs.clone(), self.public.residual)?;
        let base_in = input(cs.clone(), self.public.base)?;
        let liquid = input(cs.clone(), self.public.liquid)?;
        let balance_before = input(cs.clone(), self.public.balance_before)?;
        let balance_after = input(cs.clone(), self.public.balance_after)?;
        let mut stakes = Vec::with_capacity(VALIDATOR_COUNT);
        let mut shares = Vec::with_capacity(VALIDATOR_COUNT);
        for stake in self.public.stakes {
            stakes.push(input(cs.clone(), stake)?);
        }
        for share in self.public.shares {
            shares.push(input(cs.clone(), share)?);
        }

        height.enforce_equal(&FpVar::constant(Fr::one()))?;
        let hash = enforce_header_hash(&header)?;
        let hash_bits = enforce_rounded_u64(&hash)?;
        let two64 = fixed(cs.clone(), 2.0_f64.powi(64).to_bits())?;
        let h = enforce_div(&hash_bits, &two64)?;
        let million = enforce_from_u64(&fixed(cs.clone(), 1_000_000)?)?;
        let difficulty_bits = enforce_from_u64(&difficulty)?;
        let half = enforce_div(&million, &enforce_add(&difficulty_bits, &million)?)?;
        let tau = enforce_add(&half, &fixed(cs.clone(), 0.35_f64.to_bits())?)?;
        at_least(&tau, &h)?.enforce_equal(&Boolean::TRUE)?;
        let gap = enforce_sub_abs(&h, &fixed(cs.clone(), (2.0 / (1.0 + 5.0_f64.sqrt())).to_bits())?)?;
        let residual = enforce_mul(&gap, &gap)?;
        residual.enforce_equal(&residual_in)?;

        let one = enforce_from_u64(&fixed(cs.clone(), 1)?)?;
        let y = enforce_div(&one, &enforce_from_u64(&fixed(cs.clone(), 2_100_000)?)?)?;
        let eps = enforce_mul(&y, &fixed(cs.clone(), std::f64::consts::LN_2.to_bits())?)?;
        let mut series = fixed(cs.clone(), (1.0_f64 / 3_628_800.0).to_bits())?;
        for denom in [362_880.0_f64, 40_320.0, 5_040.0, 720.0, 120.0, 24.0, 6.0, 2.0, 1.0] {
            let term = enforce_mul(&series, &eps)?;
            series = enforce_sub_abs(&fixed(cs.clone(), (1.0 / denom).to_bits())?, &term)?;
        }
        let term = enforce_mul(&series, &eps)?;
        series = enforce_sub_abs(&one, &term)?;
        let base = enforce_mul(&enforce_from_u64(&fixed(cs.clone(), 100)?)?, &series)?;
        base.enforce_equal(&base_in)?;

        let quality = enforce_div(&fixed(cs.clone(), 0.0008_f64.to_bits())?, &enforce_add(&residual, &fixed(cs.clone(), 1e-9_f64.to_bits())?)?)?;
        at_least(&one, &quality)?.enforce_equal(&Boolean::TRUE)?;
        let reward = enforce_floor(&enforce_mul(&base, &quality)?)?;
        let reward_bits = enforce_from_u64(&reward)?;
        let credited = enforce_floor(&enforce_mul(&reward_bits, &fixed(cs.clone(), 0.1_f64.to_bits())?)?)?;
        credited.enforce_equal(&liquid)?;
        (&balance_before + &liquid).enforce_equal(&balance_after)?;

        let staked = &reward - &liquid;
        let mut total = FpVar::constant(Fr::zero());
        for stake in &stakes {
            total += stake;
        }
        let mut distributed = FpVar::constant(Fr::zero());
        for (stake, share) in stakes.iter().zip(&shares) {
            let product = FpVar::new_witness(cs.clone(), || {
                Ok(Fr::from(u128::from(u64_of(&staked)?) * u128::from(u64_of(stake)?)))
            })?;
            let remainder = FpVar::new_witness(cs.clone(), || {
                let whole = u128::from(u64_of(&total)?);
                let paid = u128::from(u64_of(&staked)?) * u128::from(u64_of(stake)?);
                Ok(Fr::from(paid % whole))
            })?;
            range64(&remainder)?;
            (&staked * stake).enforce_equal(&product)?;
            (share * &total + &remainder).enforce_equal(&product)?;
            let gap = FpVar::new_witness(cs.clone(), || {
                Ok(Fr::from(u64_of(&total)? - u64_of(&remainder)? - 1))
            })?;
            range64(&gap)?;
            total.enforce_equal(&(&remainder + &gap + FpVar::constant(Fr::one())))?;
            distributed += share;
        }
        let dust = &staked - &distributed;
        dust.enforce_equal(&FpVar::constant(Fr::from(2u64)))?;
        Ok(())
    }
}

fn fixed(cs: ConstraintSystemRef<Fr>, value: u64) -> Result<FpVar<Fr>, SynthesisError> {
    let var = FpVar::new_witness(cs, || Ok(Fr::from(value)))?;
    var.enforce_equal(&FpVar::constant(Fr::from(value)))?;
    Ok(var)
}

fn range64(value: &FpVar<Fr>) -> Result<(), SynthesisError> {
    let bits = value.to_bits_le()?;
    for bit in bits.iter().skip(64) {
        bit.enforce_equal(&Boolean::FALSE)?;
    }
    Ok(())
}

fn second_header() -> [u8; 80] {
    let mut header = [0u8; 80];
    header[64..72].copy_from_slice(&24u64.to_le_bytes());
    header[72..80].copy_from_slice(&1u64.to_le_bytes());
    header
}

pub fn second_block_reward() -> DerivedReward {
    let bytes = hex::decode("801861c38e8d596fdc42b6e6d63ac2dae0941f723dd9083415fad7240b2aef30").unwrap();
    let mut id = [0u64; 4];
    for (i, limb) in id.iter_mut().enumerate() {
        let mut raw = [0u8; 8];
        raw.copy_from_slice(&bytes[i * 8..(i + 1) * 8]);
        *limb = u64::from_be_bytes(raw);
    }
    DerivedReward {
        id,
        header: second_header(),
        difficulty: 1_000_000,
        height: 1,
        residual: 0.0029637900846207032_f64.to_bits(),
        base: 0x4058ffff758f000f,
        liquid: 2,
        balance_before: 1_500_000,
        balance_after: 1_500_002,
        stakes: [1_500_000, 1_500_000, 1_000_000, 1_000_000, 500_000],
        shares: [6, 6, 4, 4, 2],
    }
}

fn statement(public: &DerivedReward) -> Vec<Fr> {
    let mut values = public.id.to_vec();
    values.extend(public.header.iter().map(|byte| *byte as u64));
    values.extend([
        public.difficulty,
        public.height,
        public.residual,
        public.base,
        public.liquid,
        public.balance_before,
        public.balance_after,
    ]);
    values.extend(public.stakes);
    values.extend(public.shares);
    values.into_iter().map(Fr::from).collect()
}

struct Keys {
    pk: ProvingKey<Bn254>,
    pvk: PreparedVerifyingKey<Bn254>,
}

fn keys() -> &'static Keys {
    KEYS.get_or_init(|| {
        let mut rng = StdRng::seed_from_u64(0x5EAD_0026);
        let (pk, vk) = Groth16::<Bn254>::circuit_specific_setup(RewardCircuit { public: second_block_reward() }, &mut rng)
            .expect("derived reward setup");
        Keys { pk, pvk: prepare_verifying_key(&vk) }
    })
}

static KEYS: OnceLock<Keys> = OnceLock::new();

pub fn prove_derived_reward(public: &DerivedReward) -> Result<DerivedRewardProof, &'static str> {
    let digest = Sha256::digest(public.header);
    let hash = u64::from_le_bytes(digest[..8].try_into().unwrap());
    if binary64::from_u64(hash).map_err(|_| "hash is not a binary64 value")? == 0 {
        return Err("header digest is zero");
    }
    if public.height != 1 || public.liquid > 26 || public.base != 0x4058ffff758f000f {
        return Err("this statement is the height-1 reward");
    }
    if public.residual != 0.0029637900846207032_f64.to_bits() {
        return Err("residual bits are not this header's residual");
    }
    let mut rng = StdRng::seed_from_u64(0x5EAD_0026);
    let proof = Groth16::<Bn254>::prove(&keys().pk, RewardCircuit { public: *public }, &mut rng).map_err(|_| "derived reward proving failed")?;
    let mut bytes = Vec::new();
    proof.serialize_compressed(&mut bytes).map_err(|_| "derived reward proof did not serialize")?;
    Ok(DerivedRewardProof { bytes, public_inputs: *public })
}

pub fn verify_derived_reward(proof: &DerivedRewardProof) -> bool {
    let parsed = match ark_groth16::Proof::<Bn254>::deserialize_compressed(proof.bytes.as_slice()) {
        Ok(proof) => proof,
        Err(_) => return false,
    };
    Groth16::<Bn254>::verify_proof(&keys().pvk, &parsed, &statement(&proof.public_inputs)).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_relations::r1cs::ConstraintSystem;

    #[test]
    fn the_header_derives_the_reward_inside_one_statement() {
        let public = second_block_reward();
        let cs = ConstraintSystem::<Fr>::new_ref();
        RewardCircuit { public }.generate_constraints(cs.clone()).expect("constraints");
        assert!(cs.is_satisfied().unwrap(), "{:?}", cs.which_is_unsatisfied().unwrap());
        let proof = prove_derived_reward(&public).expect("prove");
        assert!(verify_derived_reward(&proof));
        let mut header = proof.clone();
        header.public_inputs.header[70] ^= 1;
        assert!(!verify_derived_reward(&header));
        let mut residual = proof.clone();
        residual.public_inputs.residual ^= 1;
        assert!(!verify_derived_reward(&residual));
        let mut base = proof.clone();
        base.public_inputs.base ^= 1;
        assert!(!verify_derived_reward(&base));
        let mut liquid = proof;
        liquid.public_inputs.liquid = 3;
        assert!(!verify_derived_reward(&liquid));
    }
}
