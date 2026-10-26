//! Liquid credit and staking distribution for one reward.
//!
//! The reward is an input. `Math.pow` is not in this circuit, so the residual
//! is not yet the source of that reward. The split and the per-validator
//! floors are. Dust is not credited.

use crate::difficulty_law::{enforce_floor, enforce_from_u64, enforce_mul};
use ark_bn254::{Bn254, Fr};
use ark_ff::{One, PrimeField, Zero};
use ark_groth16::{prepare_verifying_key, Groth16, PreparedVerifyingKey, ProvingKey};
use ark_r1cs_std::fields::fp::FpVar;
use ark_r1cs_std::prelude::*;
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use ark_snark::SNARK;
use rand::rngs::StdRng;
use rand::SeedableRng;
use std::sync::OnceLock;

pub const VALIDATOR_COUNT: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RewardSplit {
    pub reward: u64,
    pub liquid: u64,
    pub balance_before: u64,
    pub balance_after: u64,
    pub stakes: [u64; VALIDATOR_COUNT],
    pub shares: [u64; VALIDATOR_COUNT],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RewardSplitProof {
    pub bytes: Vec<u8>,
    pub public_inputs: RewardSplit,
}

#[derive(Clone, Copy)]
struct SplitCircuit {
    public: RewardSplit,
}

fn range64(value: &FpVar<Fr>) -> Result<(), SynthesisError> {
    let bits = value.to_bits_le()?;
    for bit in bits.iter().skip(64) {
        bit.enforce_equal(&Boolean::FALSE)?;
    }
    Ok(())
}

impl ConstraintSynthesizer<Fr> for SplitCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let reward = FpVar::new_input(cs.clone(), || Ok(Fr::from(self.public.reward)))?;
        let liquid = FpVar::new_input(cs.clone(), || Ok(Fr::from(self.public.liquid)))?;
        let balance_before = FpVar::new_input(cs.clone(), || Ok(Fr::from(self.public.balance_before)))?;
        let balance_after = FpVar::new_input(cs.clone(), || Ok(Fr::from(self.public.balance_after)))?;
        let mut stakes = Vec::with_capacity(VALIDATOR_COUNT);
        let mut shares = Vec::with_capacity(VALIDATOR_COUNT);
        for stake in self.public.stakes {
            stakes.push(FpVar::new_input(cs.clone(), || Ok(Fr::from(stake)))?);
        }
        for share in self.public.shares {
            shares.push(FpVar::new_input(cs.clone(), || Ok(Fr::from(share)))?);
        }
        for value in [&reward, &liquid, &balance_before, &balance_after] {
            range64(value)?;
        }
        let reward_bits = enforce_from_u64(&reward)?;
        let commission = FpVar::constant(Fr::from(0.1_f64.to_bits()));
        let product = enforce_mul(&reward_bits, &commission)?;
        let floored = enforce_floor(&product)?;
        floored.enforce_equal(&liquid)?;
        let staked = &reward - &liquid;
        (&balance_before + &liquid).enforce_equal(&balance_after)?;
        let mut total = FpVar::constant(Fr::zero());
        for stake in &stakes {
            range64(stake)?;
            total += stake;
        }
        let mut distributed = FpVar::constant(Fr::zero());
        for (stake, share) in stakes.iter().zip(&shares) {
            range64(share)?;
            let product = FpVar::new_witness(cs.clone(), || {
                let staked = self.public.reward - self.public.liquid;
                let bonded = u64_field(stake)?;
                Ok(Fr::from(u128::from(staked) * u128::from(bonded)))
            })?;
            let quotient = share;
            let remainder = FpVar::new_witness(cs.clone(), || {
                let staked = u128::from(self.public.reward - self.public.liquid);
                let bonded = u128::from(u64_field(stake)?);
                let whole = u128::from(u64_field(&total)?);
                Ok(Fr::from((staked * bonded) % whole))
            })?;
            range64(&remainder)?;
            (&staked * stake).enforce_equal(&product)?;
            (&quotient.clone() * &total + &remainder).enforce_equal(&product)?;
            let gap = FpVar::new_witness(cs.clone(), || {
                let whole = u64_field(&total)?;
                let rem = u64_field(&remainder)?;
                Ok(Fr::from(whole - rem - 1))
            })?;
            range64(&gap)?;
            total.enforce_equal(&(&remainder + &gap + FpVar::constant(Fr::one())))?;
            distributed += share;
        }
        let dust = &staked - &distributed;
        let room = FpVar::new_witness(cs, || {
            let staked = self.public.reward - self.public.liquid;
            let paid = self.public.shares.iter().sum::<u64>();
            Ok(Fr::from(VALIDATOR_COUNT as u64 - 1 - (staked - paid)))
        })?;
        range64(&room)?;
        dust.enforce_equal(&(FpVar::constant(Fr::from(VALIDATOR_COUNT as u64 - 1)) - &room))?;
        Ok(())
    }
}

fn u64_field(value: &FpVar<Fr>) -> Result<u64, SynthesisError> {
    let raw = value.value()?;
    let limbs = raw.into_bigint();
    if limbs.as_ref()[1..].iter().any(|limb| *limb != 0) {
        return Err(SynthesisError::Unsatisfiable);
    }
    Ok(limbs.as_ref()[0])
}

fn statement(public: &RewardSplit) -> Vec<Fr> {
    let mut values = vec![public.reward, public.liquid, public.balance_before, public.balance_after];
    values.extend(public.stakes);
    values.extend(public.shares);
    values.into_iter().map(Fr::from).collect()
}

/// The second mainnet block's production split. Reward 26 is checked, not derived.
pub fn second_block_split() -> RewardSplit {
    RewardSplit {
        reward: 26,
        liquid: 2,
        balance_before: 1_500_000,
        balance_after: 1_500_002,
        stakes: [1_500_000, 1_500_000, 1_000_000, 1_000_000, 500_000],
        shares: [6, 6, 4, 4, 2],
    }
}

struct Keys {
    pk: ProvingKey<Bn254>,
    pvk: PreparedVerifyingKey<Bn254>,
}

fn keys() -> &'static Keys {
    KEYS.get_or_init(|| {
        let mut rng = StdRng::seed_from_u64(0x5917_0026);
        let (pk, vk) = Groth16::<Bn254>::circuit_specific_setup(SplitCircuit { public: second_block_split() }, &mut rng)
            .expect("reward split setup");
        Keys { pk, pvk: prepare_verifying_key(&vk) }
    })
}

static KEYS: OnceLock<Keys> = OnceLock::new();

pub fn prove_reward_split(public: &RewardSplit) -> Result<RewardSplitProof, &'static str> {
    if public.liquid > public.reward {
        return Err("liquid exceeds the reward");
    }
    let staked = public.reward - public.liquid;
    let total: u128 = public.stakes.iter().map(|stake| u128::from(*stake)).sum();
    if total == 0 {
        return Err("bonded stake refused");
    }
    let mut paid = 0u64;
    for (stake, share) in public.stakes.iter().zip(public.shares) {
        let product = u128::from(staked) * u128::from(*stake);
        if product / total != u128::from(share) {
            return Err("share is not the production floor");
        }
        paid = paid.checked_add(share).ok_or("share overflow")?;
    }
    if staked - paid >= VALIDATOR_COUNT as u64 {
        return Err("dust is not the flooring remainder");
    }
    if u128::from(public.balance_before) + u128::from(public.liquid) != u128::from(public.balance_after) {
        return Err("balance is not the predecessor plus the liquid credit");
    }
    let mut rng = StdRng::seed_from_u64(0x5917_0026);
    let proof = Groth16::<Bn254>::prove(&keys().pk, SplitCircuit { public: *public }, &mut rng).map_err(|_| "reward split proving failed")?;
    let mut bytes = Vec::new();
    proof.serialize_compressed(&mut bytes).map_err(|_| "reward split proof did not serialize")?;
    Ok(RewardSplitProof { bytes, public_inputs: *public })
}

pub fn verify_reward_split(proof: &RewardSplitProof) -> bool {
    let parsed = match ark_groth16::Proof::<Bn254>::deserialize_compressed(proof.bytes.as_slice()) {
        Ok(proof) => proof,
        Err(_) => return false,
    };
    Groth16::<Bn254>::verify_proof(&keys().pvk, &parsed, &statement(&proof.public_inputs)).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_second_block_derives_the_liquid_credit_and_the_dust() {
        assert_eq!((26.0_f64 * 0.1).floor() as u64, 2);
        let public = second_block_split();
        let proof = prove_reward_split(&public).expect("prove");
        assert!(verify_reward_split(&proof));
        let mut other = proof.clone();
        other.public_inputs.liquid = 3;
        assert!(!verify_reward_split(&other));
        let mut share = proof;
        share.public_inputs.shares[4] = 3;
        assert!(!verify_reward_split(&share));
        let mut claimed = second_block_split();
        claimed.shares[0] = 7;
        assert!(prove_reward_split(&claimed).is_err());
    }
}
