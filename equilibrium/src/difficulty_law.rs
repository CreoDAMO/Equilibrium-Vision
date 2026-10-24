//! Groth16 of `adjustDifficulty` as binary64, not as a rational rewrite.
//!
//! The branch is computed. A public factor is not accepted in its place.
//! Verification does not call `successor`. This is not a proof of `Reference`.

use crate::binary64::{self, BITS_0_8, BITS_1_2};
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DifficultyLaw {
    pub difficulty: u64,
    pub block_time: u64,
    pub target_ms: u64,
    pub foreign_num: u64,
    pub foreign_den: u64,
    pub difficulty_after: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DifficultyLawProof {
    pub bytes: Vec<u8>,
    pub public_inputs: DifficultyLaw,
}

#[derive(Clone, Copy)]
struct LawCircuit {
    public: DifficultyLaw,
}

fn pack(bits: &[Boolean<Fr>]) -> Result<FpVar<Fr>, SynthesisError> {
    let mut acc = FpVar::constant(Fr::zero());
    let mut place = FpVar::constant(Fr::one());
    for bit in bits {
        let term = FpVar::conditionally_select(bit, &place, &FpVar::constant(Fr::zero()))?;
        acc += term;
        place = &place + &place;
    }
    Ok(acc)
}

fn low_bits(value: &FpVar<Fr>, n: usize) -> Result<Vec<Boolean<Fr>>, SynthesisError> {
    let bits = value.to_bits_le()?;
    for bit in bits.iter().skip(n) {
        bit.enforce_equal(&Boolean::FALSE)?;
    }
    Ok(bits.into_iter().take(n).collect())
}

fn any(bits: &[Boolean<Fr>]) -> Result<Boolean<Fr>, SynthesisError> {
    let mut acc = Boolean::FALSE;
    for bit in bits {
        acc = acc.or(bit)?;
    }
    Ok(acc)
}

/// `a >= b` for two integers that fit in 64 bits.
fn at_least(a: &FpVar<Fr>, b: &FpVar<Fr>) -> Result<Boolean<Fr>, SynthesisError> {
    let cs = a.cs().or(b.cs());
    let ge = Boolean::new_witness(cs.clone(), || {
        let av = a.value().unwrap_or(Fr::zero());
        let bv = b.value().unwrap_or(Fr::zero());
        Ok(av >= bv)
    })?;
    let diff = FpVar::new_witness(cs, || {
        let av = a.value().unwrap_or(Fr::zero());
        let bv = b.value().unwrap_or(Fr::zero());
        Ok(if av >= bv { av - bv } else { bv - av - Fr::one() })
    })?;
    let _ = low_bits(&diff, 64)?;
    let a_side = b + &diff;
    let b_side = a + &diff + FpVar::constant(Fr::one());
    let left = FpVar::conditionally_select(&ge, a, &b_side)?;
    let right = FpVar::conditionally_select(&ge, &a_side, b)?;
    left.enforce_equal(&right)?;
    Ok(ge)
}

fn enforce_from_u64(n: &FpVar<Fr>) -> Result<FpVar<Fr>, SynthesisError> {
    let cs = n.cs();
    let n_bits = low_bits(n, 53)?;
    let mut hot = Vec::with_capacity(53);
    for i in 0..53 {
        let bit = Boolean::new_witness(cs.clone(), || {
            let value = n.value().unwrap_or(Fr::zero());
            let raw = u64::from(value.into_bigint().as_ref()[0]);
            let e = 63 - raw.leading_zeros() as usize;
            Ok(i == e)
        })?;
        hot.push(bit);
    }
    let mut sum = FpVar::constant(Fr::zero());
    for bit in &hot {
        sum += FpVar::conditionally_select(bit, &FpVar::constant(Fr::one()), &FpVar::constant(Fr::zero()))?;
    }
    sum.enforce_equal(&FpVar::constant(Fr::one()))?;
    for i in 0..53 {
        let keeps = hot[i].not().or(&n_bits[i])?;
        keeps.enforce_equal(&Boolean::TRUE)?;
        for j in (i + 1)..53 {
            let above = hot[i].not().or(&n_bits[j].not())?;
            above.enforce_equal(&Boolean::TRUE)?;
        }
    }
    let mut pow = FpVar::constant(Fr::zero());
    let mut exp = FpVar::constant(Fr::zero());
    for i in 0..53 {
        let place = FpVar::constant(Fr::from(1u64 << (52 - i)));
        pow += FpVar::conditionally_select(&hot[i], &place, &FpVar::constant(Fr::zero()))?;
        let position = FpVar::constant(Fr::from(i as u64 + 1023));
        exp += FpVar::conditionally_select(&hot[i], &position, &FpVar::constant(Fr::zero()))?;
    }
    let product = n * &pow;
    let product_bits = low_bits(&product, 53)?;
    product_bits[52].enforce_equal(&Boolean::TRUE)?;
    let frac = pack(&product_bits[..52])?;
    let encoded = &exp * FpVar::constant(Fr::from(1u64 << 52)) + frac;
    Ok(encoded)
}

fn round_pack(
    exp: &FpVar<Fr>,
    significand: &[Boolean<Fr>],
    round: &Boolean<Fr>,
    sticky: &Boolean<Fr>,
) -> Result<FpVar<Fr>, SynthesisError> {
    let lsb = &significand[0];
    let bump = round.and(&sticky.or(lsb)?)?;
    let width = pack(significand)?;
    let bumped = &width + FpVar::conditionally_select(&bump, &FpVar::constant(Fr::one()), &FpVar::constant(Fr::zero()))?;
    let overflow = bumped.is_eq(&FpVar::constant(Fr::from(1u64 << 53)))?;
    let final_sig = FpVar::conditionally_select(&overflow, &FpVar::constant(Fr::from(1u64 << 52)), &bumped)?;
    let exp = exp + FpVar::conditionally_select(&overflow, &FpVar::constant(Fr::one()), &FpVar::constant(Fr::zero()))?;
    let exp_bits = low_bits(&exp, 11)?;
    any(&exp_bits)?.enforce_equal(&Boolean::TRUE)?;
    let all = any(&[exp_bits[0].not(), exp_bits[1].not(), exp_bits[2].not(), exp_bits[3].not(), exp_bits[4].not(), exp_bits[5].not(), exp_bits[6].not(), exp_bits[7].not(), exp_bits[8].not(), exp_bits[9].not(), exp_bits[10].not()])?;
    all.enforce_equal(&Boolean::TRUE)?;
    let frac_bits = low_bits(&(&final_sig - FpVar::constant(Fr::from(1u64 << 52))), 52)?;
    Ok(&exp * FpVar::constant(Fr::from(1u64 << 52)) + pack(&frac_bits)?)
}

fn enforce_mul(a: &FpVar<Fr>, b: &FpVar<Fr>) -> Result<FpVar<Fr>, SynthesisError> {
    let a_bits = low_bits(a, 64)?;
    let b_bits = low_bits(b, 64)?;
    a_bits[63].enforce_equal(&Boolean::FALSE)?;
    b_bits[63].enforce_equal(&Boolean::FALSE)?;
    let exp_a = pack(&a_bits[52..63])?;
    let exp_b = pack(&b_bits[52..63])?;
    any(&a_bits[52..63])?.enforce_equal(&Boolean::TRUE)?;
    any(&b_bits[52..63])?.enforce_equal(&Boolean::TRUE)?;
    let sig_a = pack(&a_bits[..52])? + FpVar::constant(Fr::from(1u64 << 52));
    let sig_b = pack(&b_bits[..52])? + FpVar::constant(Fr::from(1u64 << 52));
    let prod = &sig_a * &sig_b;
    let prod_bits = low_bits(&prod, 106)?;
    let wide = prod_bits[105].clone();
    let mut significand = Vec::with_capacity(53);
    for i in 0..53 {
        significand.push(Boolean::conditionally_select(&wide, &prod_bits[53 + i], &prod_bits[52 + i])?);
    }
    let round = Boolean::conditionally_select(&wide, &prod_bits[52], &prod_bits[51])?;
    let sticky_wide = any(&prod_bits[..52])?;
    let sticky_narrow = any(&prod_bits[..51])?;
    let sticky = Boolean::conditionally_select(&wide, &sticky_wide, &sticky_narrow)?;
    let exp = &exp_a + &exp_b - FpVar::constant(Fr::from(1023u64));
    let exp = exp + FpVar::conditionally_select(&wide, &FpVar::constant(Fr::one()), &FpVar::constant(Fr::zero()))?;
    round_pack(&exp, &significand, &round, &sticky)
}

fn enforce_div(a: &FpVar<Fr>, b: &FpVar<Fr>) -> Result<FpVar<Fr>, SynthesisError> {
    let cs = a.cs();
    let a_bits = low_bits(a, 64)?;
    let b_bits = low_bits(b, 64)?;
    a_bits[63].enforce_equal(&Boolean::FALSE)?;
    b_bits[63].enforce_equal(&Boolean::FALSE)?;
    let exp_a = pack(&a_bits[52..63])?;
    let exp_b = pack(&b_bits[52..63])?;
    let sig_a = pack(&a_bits[..52])? + FpVar::constant(Fr::from(1u64 << 52));
    let sig_b = pack(&b_bits[..52])? + FpVar::constant(Fr::from(1u64 << 52));
    let q = FpVar::new_witness(cs.clone(), || {
        let a = u64_of(a)?;
        let b = u64_of(b)?;
        let sig_a = (1u128 << 52) | u128::from(a & ((1 << 52) - 1));
        let sig_b = (1u128 << 52) | u128::from(b & ((1 << 52) - 1));
        Ok(Fr::from((sig_a << 54) / sig_b))
    })?;
    let r = FpVar::new_witness(cs, || {
        let a = u64_of(a)?;
        let b = u64_of(b)?;
        let sig_a = (1u128 << 52) | u128::from(a & ((1 << 52) - 1));
        let sig_b = (1u128 << 52) | u128::from(b & ((1 << 52) - 1));
        Ok(Fr::from((sig_a << 54) % sig_b))
    })?;
    let _ = low_bits(&q, 55)?;
    let _ = low_bits(&r, 53)?;
    let dividend = &sig_a * FpVar::constant(Fr::from(1u64 << 54));
    dividend.enforce_equal(&(&q * &sig_b + &r))?;
    let gap = FpVar::new_witness(q.cs(), || {
        let sig_b = u64_of(&sig_b)?;
        let rem = u64_of(&r)?;
        Ok(Fr::from(sig_b - rem - 1))
    })?;
    let _ = low_bits(&gap, 53)?;
    sig_b.enforce_equal(&(&r + &gap + FpVar::constant(Fr::one())))?;
    let q_bits = low_bits(&q, 55)?;
    let wide = q_bits[54].clone();
    let mut significand = Vec::with_capacity(53);
    for i in 0..53 {
        significand.push(Boolean::conditionally_select(&wide, &q_bits[2 + i], &q_bits[1 + i])?);
    }
    let round = Boolean::conditionally_select(&wide, &q_bits[1], &q_bits[0])?;
    let sticky_low = any(&q_bits[..1])?.or(&any(&[r.is_eq(&FpVar::constant(Fr::zero()))?.not()])?)?;
    let sticky_narrow = r.is_eq(&FpVar::constant(Fr::zero()))?.not();
    let sticky = Boolean::conditionally_select(&wide, &sticky_low, &sticky_narrow)?;
    let exp = &exp_a - &exp_b + FpVar::constant(Fr::from(1022u64));
    let exp = exp + FpVar::conditionally_select(&wide, &FpVar::constant(Fr::one()), &FpVar::constant(Fr::zero()))?;
    round_pack(&exp, &significand, &round, &sticky)
}

fn enforce_floor(bits: &FpVar<Fr>) -> Result<FpVar<Fr>, SynthesisError> {
    let cs = bits.cs();
    let raw = low_bits(bits, 64)?;
    raw[63].enforce_equal(&Boolean::FALSE)?;
    let exp = pack(&raw[52..63])?;
    let frac = pack(&raw[..52])?;
    let sig = &frac + FpVar::constant(Fr::from(1u64 << 52));
    let small = at_least(&FpVar::constant(Fr::from(1023u64)), &(&exp + FpVar::constant(Fr::one())))?;
    let e = &exp - FpVar::constant(Fr::from(1023u64));
    let mut hot = Vec::with_capacity(53);
    for i in 0..53 {
        let bit = Boolean::new_witness(cs.clone(), || {
            let exp = u64_of(&exp)?;
            let e = exp.saturating_sub(1023) as usize;
            Ok(!small.value().unwrap_or(false) && i == e.min(52))
        })?;
        hot.push(bit);
    }
    let mut sum = FpVar::constant(Fr::zero());
    let mut drop_pow = FpVar::constant(Fr::zero());
    let mut e_fp = FpVar::constant(Fr::zero());
    for i in 0..53 {
        sum += FpVar::conditionally_select(&hot[i], &FpVar::constant(Fr::one()), &FpVar::constant(Fr::zero()))?;
        drop_pow += FpVar::conditionally_select(&hot[i], &FpVar::constant(Fr::from(1u64 << (52 - i))), &FpVar::constant(Fr::zero()))?;
        e_fp += FpVar::conditionally_select(&hot[i], &FpVar::constant(Fr::from(i as u64)), &FpVar::constant(Fr::zero()))?;
    }
    sum.enforce_equal(&FpVar::constant(Fr::one()))?;
    let active = small.not();
    let bound = &e_fp - &e;
    let bound = &bound * FpVar::conditionally_select(&active, &FpVar::constant(Fr::one()), &FpVar::constant(Fr::zero()))?;
    bound.enforce_equal(&FpVar::constant(Fr::zero()))?;
    let result = FpVar::new_witness(cs.clone(), || Ok(Fr::from(binary64::floor_u64(u64_of(bits)?).unwrap_or(0))))?;
    let _ = low_bits(&result, 64)?;
    let rem = FpVar::new_witness(cs, || {
        let sig = u64_of(&sig)?;
        let pow = u64_of(&drop_pow)?;
        let floored = u64_of(&result)?;
        Ok(Fr::from(sig - floored.saturating_mul(pow)))
    })?;
    let _ = low_bits(&rem, 53)?;
    let reconstructed = &result * &drop_pow + &rem;
    let difference = &sig - &reconstructed;
    let gated = &difference * FpVar::conditionally_select(&active, &FpVar::constant(Fr::one()), &FpVar::constant(Fr::zero()))?;
    gated.enforce_equal(&FpVar::constant(Fr::zero()))?;
    let gap = FpVar::new_witness(result.cs(), || {
        let pow = u64_of(&drop_pow)?;
        let rem = u64_of(&rem)?;
        Ok(Fr::from(pow - rem - 1))
    })?;
    let _ = low_bits(&gap, 53)?;
    let remainder_law = &rem + &gap + FpVar::constant(Fr::one()) - &drop_pow;
    let remainder_gated = &remainder_law * FpVar::conditionally_select(&active, &FpVar::constant(Fr::one()), &FpVar::constant(Fr::zero()))?;
    remainder_gated.enforce_equal(&FpVar::constant(Fr::zero()))?;
    let zero = FpVar::constant(Fr::zero());
    let when_small = &result * FpVar::conditionally_select(&small, &FpVar::constant(Fr::one()), &zero)?;
    when_small.enforce_equal(&zero)?;
    Ok(result)
}

fn u64_of(value: &FpVar<Fr>) -> Result<u64, SynthesisError> {
    let raw = value.value()?;
    let limbs = raw.into_bigint();
    if limbs.as_ref()[1..].iter().any(|limb| *limb != 0) {
        return Err(SynthesisError::Unsatisfiable);
    }
    Ok(limbs.as_ref()[0])
}

fn at_least_floor(value: FpVar<Fr>) -> Result<FpVar<Fr>, SynthesisError> {
    let floor = enforce_floor(&value)?;
    let bound = FpVar::constant(Fr::from(100_000u64));
    let keeps = at_least(&floor, &bound)?;
    FpVar::conditionally_select(&keeps, &floor, &bound)
}

fn enforce_law(
    difficulty: &FpVar<Fr>,
    block_time: &FpVar<Fr>,
    target_ms: &FpVar<Fr>,
    foreign_num: &FpVar<Fr>,
    foreign_den: &FpVar<Fr>,
) -> Result<FpVar<Fr>, SynthesisError> {
    let difficulty_bits = enforce_from_u64(difficulty)?;
    let time_bits = enforce_from_u64(block_time)?;
    let target_ms_bits = enforce_from_u64(target_ms)?;
    let num_bits = enforce_from_u64(foreign_num)?;
    let den_bits = enforce_from_u64(foreign_den)?;
    let thousand = FpVar::constant(Fr::from(binary64::from_u64(1_000).expect("1000")));
    let target = enforce_div(&target_ms_bits, &thousand)?;
    let unclamped = enforce_mul(&enforce_div(&target, &time_bits)?, &enforce_div(&num_bits, &den_bits)?)?;
    let hi_bits = FpVar::constant(Fr::from(BITS_1_2));
    let lo_bits = FpVar::constant(Fr::from(BITS_0_8));
    let above = at_least(&hi_bits, &unclamped)?.not();
    let high = FpVar::conditionally_select(&above, &hi_bits, &unclamped)?;
    let below = at_least(&high, &lo_bits)?.not();
    let factor = FpVar::conditionally_select(&below, &lo_bits, &high)?;
    let on_clamp = factor.is_eq(&lo_bits)?.or(&factor.is_eq(&hi_bits)?)?;
    let clamp_result = at_least_floor(enforce_mul(&difficulty_bits, &factor)?)?;
    let numer = enforce_mul(&enforce_mul(&difficulty_bits, &target)?, &num_bits)?;
    let denom = enforce_mul(&time_bits, &den_bits)?;
    let interior_result = at_least_floor(enforce_div(&numer, &denom)?)?;
    FpVar::conditionally_select(&on_clamp, &clamp_result, &interior_result)
}

impl ConstraintSynthesizer<Fr> for LawCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let difficulty = FpVar::new_input(cs.clone(), || Ok(Fr::from(self.public.difficulty)))?;
        let block_time = FpVar::new_input(cs.clone(), || Ok(Fr::from(self.public.block_time)))?;
        let target_ms = FpVar::new_input(cs.clone(), || Ok(Fr::from(self.public.target_ms)))?;
        let foreign_num = FpVar::new_input(cs.clone(), || Ok(Fr::from(self.public.foreign_num)))?;
        let foreign_den = FpVar::new_input(cs.clone(), || Ok(Fr::from(self.public.foreign_den)))?;
        let after = FpVar::new_input(cs, || Ok(Fr::from(self.public.difficulty_after)))?;
        let chosen = enforce_law(&difficulty, &block_time, &target_ms, &foreign_num, &foreign_den)?;
        chosen.enforce_equal(&after)?;
        Ok(())
    }
}

fn statement(public: &DifficultyLaw) -> Vec<Fr> {
    [
        public.difficulty,
        public.block_time,
        public.target_ms,
        public.foreign_num,
        public.foreign_den,
        public.difficulty_after,
    ]
    .into_iter()
    .map(Fr::from)
    .collect()
}

struct Keys {
    pk: ProvingKey<Bn254>,
    pvk: PreparedVerifyingKey<Bn254>,
}

fn real_block() -> DifficultyLaw {
    DifficultyLaw {
        difficulty: 1_000_000,
        block_time: 12,
        target_ms: 15_000,
        foreign_num: 1,
        foreign_den: 1,
        difficulty_after: 1_200_000,
    }
}

fn keys() -> &'static Keys {
    KEYS.get_or_init(|| {
        let mut rng = StdRng::seed_from_u64(0xB1_4464);
        let (pk, vk) = Groth16::<Bn254>::circuit_specific_setup(LawCircuit { public: real_block() }, &mut rng)
            .expect("difficulty law setup");
        Keys { pk, pvk: prepare_verifying_key(&vk) }
    })
}

static KEYS: OnceLock<Keys> = OnceLock::new();

pub fn prove_difficulty_law(public: &DifficultyLaw) -> Result<DifficultyLawProof, &'static str> {
    if public.block_time == 0 || public.foreign_den == 0 {
        return Err("difficulty divisor is zero");
    }
    let expected = binary64::adjust(
        public.difficulty,
        public.block_time,
        public.target_ms,
        public.foreign_num,
        public.foreign_den,
    )?;
    if expected != public.difficulty_after {
        return Err("difficulty is not the binary64 result");
    }
    let mut rng = StdRng::seed_from_u64(0xB1_4464);
    let proof = Groth16::<Bn254>::prove(&keys().pk, LawCircuit { public: *public }, &mut rng).map_err(|_| "difficulty law proving failed")?;
    let mut bytes = Vec::new();
    proof.serialize_compressed(&mut bytes).map_err(|_| "difficulty law proof did not serialize")?;
    Ok(DifficultyLawProof { bytes, public_inputs: *public })
}

/// Pairing check only. It does not run the transition or the floating-point code.
pub fn verify_difficulty_law(proof: &DifficultyLawProof) -> bool {
    let parsed = match ark_groth16::Proof::<Bn254>::deserialize_compressed(proof.bytes.as_slice()) {
        Ok(proof) => proof,
        Err(_) => return false,
    };
    Groth16::<Bn254>::verify_proof(&keys().pvk, &parsed, &statement(&proof.public_inputs)).unwrap_or(false)
}

/// One statement. The timestamp delta is the difficulty interval.
/// The liquid credit is still an input, not a computed reward.
/// The genesis clock, the residual, and the header are not in this statement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ComposedStep {
    pub id: [u64; 4],
    pub height_before: u64,
    pub height_after: u64,
    pub timestamp_before: u64,
    pub timestamp_after: u64,
    pub difficulty_before: u64,
    pub difficulty_after: u64,
    pub target_ms: u64,
    pub foreign_num: u64,
    pub foreign_den: u64,
    pub balance_before: u64,
    pub liquid: u64,
    pub balance_after: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComposedProof {
    pub bytes: Vec<u8>,
    pub public_inputs: ComposedStep,
}

#[derive(Clone, Copy)]
struct StepCircuit {
    public: ComposedStep,
}

impl ConstraintSynthesizer<Fr> for StepCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let mut id = Vec::with_capacity(4);
        for limb in self.public.id {
            let limb = FpVar::new_input(cs.clone(), || Ok(Fr::from(limb)))?;
            let _ = low_bits(&limb, 64)?;
            id.push(limb);
        }
        let height_before = FpVar::new_input(cs.clone(), || Ok(Fr::from(self.public.height_before)))?;
        let height_after = FpVar::new_input(cs.clone(), || Ok(Fr::from(self.public.height_after)))?;
        let timestamp_before = FpVar::new_input(cs.clone(), || Ok(Fr::from(self.public.timestamp_before)))?;
        let timestamp_after = FpVar::new_input(cs.clone(), || Ok(Fr::from(self.public.timestamp_after)))?;
        let difficulty_before = FpVar::new_input(cs.clone(), || Ok(Fr::from(self.public.difficulty_before)))?;
        let difficulty_after = FpVar::new_input(cs.clone(), || Ok(Fr::from(self.public.difficulty_after)))?;
        let target_ms = FpVar::new_input(cs.clone(), || Ok(Fr::from(self.public.target_ms)))?;
        let foreign_num = FpVar::new_input(cs.clone(), || Ok(Fr::from(self.public.foreign_num)))?;
        let foreign_den = FpVar::new_input(cs.clone(), || Ok(Fr::from(self.public.foreign_den)))?;
        let balance_before = FpVar::new_input(cs.clone(), || Ok(Fr::from(self.public.balance_before)))?;
        let liquid = FpVar::new_input(cs.clone(), || Ok(Fr::from(self.public.liquid)))?;
        let balance_after = FpVar::new_input(cs, || Ok(Fr::from(self.public.balance_after)))?;
        for value in [&height_before, &height_after, &timestamp_before, &timestamp_after, &balance_before, &liquid, &balance_after] {
            let _ = low_bits(value, 64)?;
        }
        (&height_before + FpVar::constant(Fr::one())).enforce_equal(&height_after)?;
        let interval = &timestamp_after - &timestamp_before;
        let chosen = enforce_law(&difficulty_before, &interval, &target_ms, &foreign_num, &foreign_den)?;
        chosen.enforce_equal(&difficulty_after)?;
        (&balance_before + &liquid).enforce_equal(&balance_after)?;
        let _ = id;
        Ok(())
    }
}

fn composed_statement(public: &ComposedStep) -> Vec<Fr> {
    let mut values = public.id.to_vec();
    values.extend([
        public.height_before,
        public.height_after,
        public.timestamp_before,
        public.timestamp_after,
        public.difficulty_before,
        public.difficulty_after,
        public.target_ms,
        public.foreign_num,
        public.foreign_den,
        public.balance_before,
        public.liquid,
        public.balance_after,
    ]);
    values.into_iter().map(Fr::from).collect()
}

fn real_step() -> ComposedStep {
    let bytes = hex::decode("801861c38e8d596fdc42b6e6d63ac2dae0941f723dd9083415fad7240b2aef30").expect("statement id");
    let mut id = [0u64; 4];
    for (i, limb) in id.iter_mut().enumerate() {
        let mut raw = [0u8; 8];
        raw.copy_from_slice(&bytes[i * 8..(i + 1) * 8]);
        *limb = u64::from_be_bytes(raw);
    }
    ComposedStep {
        id,
        height_before: 0,
        height_after: 1,
        timestamp_before: 12,
        timestamp_after: 24,
        difficulty_before: 1_000_000,
        difficulty_after: 1_200_000,
        target_ms: 15_000,
        foreign_num: 1,
        foreign_den: 1,
        balance_before: 1_500_000,
        liquid: 2,
        balance_after: 1_500_002,
    }
}

struct StepKeys {
    pk: ProvingKey<Bn254>,
    pvk: PreparedVerifyingKey<Bn254>,
}

fn step_keys() -> &'static StepKeys {
    STEP_KEYS.get_or_init(|| {
        let mut rng = StdRng::seed_from_u64(0x57E9_0001);
        let (pk, vk) = Groth16::<Bn254>::circuit_specific_setup(StepCircuit { public: real_step() }, &mut rng)
            .expect("composed step setup");
        StepKeys { pk, pvk: prepare_verifying_key(&vk) }
    })
}

static STEP_KEYS: OnceLock<StepKeys> = OnceLock::new();

pub fn prove_composed(public: &ComposedStep) -> Result<ComposedProof, &'static str> {
    if public.height_after != public.height_before.saturating_add(1) || public.height_before == u64::MAX {
        return Err("height is not the next height");
    }
    if public.timestamp_after <= public.timestamp_before {
        return Err("timestamp did not advance");
    }
    let interval = public.timestamp_after - public.timestamp_before;
    let expected = binary64::adjust(
        public.difficulty_before,
        interval,
        public.target_ms,
        public.foreign_num,
        public.foreign_den,
    )?;
    if expected != public.difficulty_after {
        return Err("difficulty is not the binary64 result");
    }
    let credited = u128::from(public.balance_before) + u128::from(public.liquid);
    if credited != u128::from(public.balance_after) {
        return Err("balance is not the predecessor plus the liquid credit");
    }
    let mut rng = StdRng::seed_from_u64(0x57E9_0001);
    let proof = Groth16::<Bn254>::prove(&step_keys().pk, StepCircuit { public: *public }, &mut rng)
        .map_err(|_| "composed proving failed")?;
    let mut bytes = Vec::new();
    proof.serialize_compressed(&mut bytes).map_err(|_| "composed proof did not serialize")?;
    Ok(ComposedProof { bytes, public_inputs: *public })
}

/// One pairing check for the clock, the difficulty law, and the liquid credit.
/// It does not run `successor`.
pub fn verify_composed(proof: &ComposedProof) -> bool {
    let parsed = match ark_groth16::Proof::<Bn254>::deserialize_compressed(proof.bytes.as_slice()) {
        Ok(proof) => proof,
        Err(_) => return false,
    };
    Groth16::<Bn254>::verify_proof(&step_keys().pvk, &parsed, &composed_statement(&proof.public_inputs)).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_relations::r1cs::ConstraintSystem;

    fn check(label: &str, run: impl FnOnce(ConstraintSystemRef<Fr>) -> Result<(), SynthesisError>) {
        let cs = ConstraintSystem::<Fr>::new_ref();
        run(cs.clone()).expect(label);
        assert!(cs.is_satisfied().unwrap(), "{label}: {:?}", cs.which_is_unsatisfied().unwrap());
    }

    #[test]
    fn circuit_primitives_match_binary64() {
        check("from", |cs| {
            let n = FpVar::new_input(cs.clone(), || Ok(Fr::from(1_000_000u64)))?;
            let got = enforce_from_u64(&n)?;
            got.enforce_equal(&FpVar::constant(Fr::from(binary64::from_u64(1_000_000).unwrap())))?;
            let _ = cs;
            Ok(())
        });
        check("mul", |cs| {
            let a = FpVar::new_input(cs.clone(), || Ok(Fr::from(binary64::from_u64(15).unwrap())))?;
            let b = FpVar::new_input(cs.clone(), || Ok(Fr::from(binary64::from_u64(12).unwrap())))?;
            let got = enforce_mul(&a, &b)?;
            let expected = binary64::mul(binary64::from_u64(15).unwrap(), binary64::from_u64(12).unwrap()).unwrap();
            got.enforce_equal(&FpVar::constant(Fr::from(expected.bits)))?;
            Ok(())
        });
        check("div", |cs| {
            let a = FpVar::new_input(cs.clone(), || Ok(Fr::from(binary64::from_u64(15).unwrap())))?;
            let b = FpVar::new_input(cs.clone(), || Ok(Fr::from(binary64::from_u64(12).unwrap())))?;
            let got = enforce_div(&a, &b)?;
            let expected = binary64::div(binary64::from_u64(15).unwrap(), binary64::from_u64(12).unwrap()).unwrap();
            got.enforce_equal(&FpVar::constant(Fr::from(expected.bits)))?;
            Ok(())
        });
        check("floor", |cs| {
            let bits = binary64::mul(binary64::from_u64(1_000_001).unwrap(), BITS_1_2).unwrap().bits;
            let input = FpVar::new_input(cs.clone(), || Ok(Fr::from(bits)))?;
            let got = enforce_floor(&input)?;
            got.enforce_equal(&FpVar::constant(Fr::from(binary64::floor_u64(bits).unwrap())))?;
            Ok(())
        });
    }

    #[test]
    fn the_real_block_clamp_verifies_and_a_different_result_does_not() {
        let public = real_block();
        let proof = prove_difficulty_law(&public).expect("prove");
        assert!(verify_difficulty_law(&proof));
        let mut other = proof.clone();
        other.public_inputs.difficulty_after = 1_199_999;
        assert!(!verify_difficulty_law(&other));
        let mut moved = proof;
        moved.public_inputs.block_time = 16;
        assert!(!verify_difficulty_law(&moved));

        let interior = DifficultyLaw {
            difficulty: 200_000,
            block_time: 16,
            target_ms: 15_000,
            foreign_num: 1,
            foreign_den: 1,
            difficulty_after: 187_500,
        };
        assert!(verify_difficulty_law(&prove_difficulty_law(&interior).expect("interior")));
        let low = DifficultyLaw {
            difficulty: 1_000_000,
            block_time: 20,
            target_ms: 15_000,
            foreign_num: 1,
            foreign_den: 1,
            difficulty_after: 800_000,
        };
        assert!(verify_difficulty_law(&prove_difficulty_law(&low).expect("low clamp")));
        let odd = DifficultyLaw {
            difficulty: 1_000_001,
            block_time: 10,
            target_ms: 12_000,
            foreign_num: 1,
            foreign_den: 1,
            difficulty_after: 1_200_001,
        };
        assert!(verify_difficulty_law(&prove_difficulty_law(&odd).expect("non integer floor")));
        assert!(prove_difficulty_law(&DifficultyLaw { difficulty_after: 1_250_000, ..public }).is_err());
    }

    #[test]
    fn one_statement_binds_the_clock_to_the_difficulty_law() {
        let public = real_step();
        let proof = prove_composed(&public).expect("prove");
        assert!(verify_composed(&proof));
        let mut other = proof.clone();
        other.public_inputs.difficulty_after = 1_199_999;
        assert!(!verify_composed(&other));
        let mut height = proof.clone();
        height.public_inputs.height_after = 2;
        assert!(!verify_composed(&height));
        let mut name = proof;
        name.public_inputs.id[3] ^= 1;
        assert!(!verify_composed(&name));
    }
}
