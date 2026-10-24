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
pub(crate) fn at_least(a: &FpVar<Fr>, b: &FpVar<Fr>) -> Result<Boolean<Fr>, SynthesisError> {
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

pub(crate) fn enforce_from_u64(n: &FpVar<Fr>) -> Result<FpVar<Fr>, SynthesisError> {
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

/// `Number(u64)` rounding, including integers at or above `2^53`.
pub(crate) fn enforce_rounded_u64(n: &FpVar<Fr>) -> Result<FpVar<Fr>, SynthesisError> {
    let cs = n.cs();
    let bits = low_bits(n, 64)?;
    let mut hot = Vec::with_capacity(64);
    for i in 0..64 {
        let bit = Boolean::new_witness(cs.clone(), || {
            let raw = u64_of(n)?;
            Ok(i == 63 - raw.leading_zeros() as usize)
        })?;
        hot.push(bit);
    }
    let mut seen = FpVar::constant(Fr::zero());
    for bit in &hot {
        seen += FpVar::conditionally_select(bit, &FpVar::constant(Fr::one()), &FpVar::constant(Fr::zero()))?;
    }
    seen.enforce_equal(&FpVar::constant(Fr::one()))?;
    for i in 0..64 {
        let keeps = hot[i].not().or(&bits[i])?;
        keeps.enforce_equal(&Boolean::TRUE)?;
        for j in (i + 1)..64 {
            let above = hot[i].not().or(&bits[j].not())?;
            above.enforce_equal(&Boolean::TRUE)?;
        }
    }
    let mut encoded = FpVar::constant(Fr::zero());
    for e in 0..64 {
        let (raw_sig, raw_round, raw_sticky, exp) = if e <= 52 {
            let mut sig = vec![Boolean::constant(false); 53];
            sig[52] = Boolean::constant(true);
            for j in 0..e {
                sig[52 - e + j] = bits[j].clone();
            }
            (sig, Boolean::constant(false), Boolean::constant(false), e as u64 + 1023)
        } else {
            let mut sig = Vec::with_capacity(53);
            for j in 0..53 {
                sig.push(bits[e - 52 + j].clone());
            }
            let round = bits[e - 53].clone();
            let sticky = if e == 53 { Boolean::constant(false) } else { any(&bits[..e - 53])? };
            (sig, round, sticky, e as u64 + 1023)
        };
        let mut significand = Vec::with_capacity(53);
        for (j, bit) in raw_sig.iter().enumerate() {
            let canonical = Boolean::constant(j == 52);
            significand.push(Boolean::conditionally_select(&hot[e], bit, &canonical)?);
        }
        let round = Boolean::conditionally_select(&hot[e], &raw_round, &Boolean::FALSE)?;
        let sticky = Boolean::conditionally_select(&hot[e], &raw_sticky, &Boolean::FALSE)?;
        let exp_var = FpVar::new_witness(cs.clone(), || Ok(Fr::from(exp)))?;
        exp_var.enforce_equal(&FpVar::constant(Fr::from(exp)))?;
        let packed = round_pack(&exp_var, &significand, &round, &sticky)?;
        encoded += FpVar::conditionally_select(&hot[e], &packed, &FpVar::constant(Fr::zero()))?;
    }
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

fn equals_usize(bits: &[Boolean<Fr>], n: usize) -> Result<Boolean<Fr>, SynthesisError> {
    let mut acc = Boolean::constant(true);
    let mut n = n;
    for bit in bits {
        let matches = if (n & 1) == 1 { bit.clone() } else { bit.not() };
        n >>= 1;
        acc = acc.and(&matches)?;
    }
    Ok(acc)
}

/// Shift a 56-bit value right by `0..64`. The lost bits become the sticky flag.
fn align56(wide: &FpVar<Fr>, shift: &FpVar<Fr>) -> Result<(FpVar<Fr>, Boolean<Fr>), SynthesisError> {
    let cs = wide.cs().or(shift.cs());
    let bits = low_bits(wide, 56)?;
    let shift_bits = low_bits(shift, 6)?;
    let aligned = FpVar::new_witness(cs.clone(), || {
        let amount = u64_of(shift)?.min(63) as u32;
        Ok(Fr::from(u64_of(wide)? >> amount))
    })?;
    let sticky = Boolean::new_witness(cs, || {
        let amount = u64_of(shift)?;
        let value = u64_of(wide)?;
        let lost = if amount == 0 { 0 } else { value & ((1u64 << amount.min(63)) - 1) };
        Ok(lost != 0)
    })?;
    let mut seen = FpVar::constant(Fr::zero());
    for s in 0..64 {
        let chosen = equals_usize(&shift_bits, s)?;
        seen += FpVar::conditionally_select(&chosen, &FpVar::constant(Fr::one()), &FpVar::constant(Fr::zero()))?;
        let shifted = if s >= 56 { FpVar::constant(Fr::zero()) } else { pack(&bits[s..])? };
        FpVar::conditionally_select(&chosen, &aligned, &FpVar::constant(Fr::zero()))?
            .enforce_equal(&FpVar::conditionally_select(&chosen, &shifted, &FpVar::constant(Fr::zero()))?)?;
        let lost = if s == 0 {
            Boolean::constant(false)
        } else if s >= 56 {
            any(&bits)?
        } else {
            any(&bits[..s])?
        };
        Boolean::conditionally_select(&chosen, &sticky, &Boolean::FALSE)?
            .enforce_equal(&Boolean::conditionally_select(&chosen, &lost, &Boolean::FALSE)?)?;
    }
    seen.enforce_equal(&FpVar::constant(Fr::one()))?;
    Ok((aligned, sticky))
}

fn normal_parts(bits: &FpVar<Fr>) -> Result<(FpVar<Fr>, FpVar<Fr>), SynthesisError> {
    let raw = low_bits(bits, 64)?;
    raw[63].enforce_equal(&Boolean::FALSE)?;
    let exp = pack(&raw[52..63])?;
    any(&raw[52..63])?.enforce_equal(&Boolean::TRUE)?;
    let sig = pack(&raw[..52])? + FpVar::constant(Fr::from(1u64 << 52));
    Ok((exp, sig))
}

pub(crate) fn enforce_add(a: &FpVar<Fr>, b: &FpVar<Fr>) -> Result<FpVar<Fr>, SynthesisError> {
    let (exp_a, sig_a) = normal_parts(a)?;
    let (exp_b, sig_b) = normal_parts(b)?;
    let a_first = at_least(&exp_a, &exp_b)?;
    let exp = FpVar::conditionally_select(&a_first, &exp_a, &exp_b)?;
    let hi = FpVar::conditionally_select(&a_first, &sig_a, &sig_b)?;
    let lo = FpVar::conditionally_select(&a_first, &sig_b, &sig_a)?;
    let shift = FpVar::conditionally_select(&a_first, &(&exp_a - &exp_b), &(&exp_b - &exp_a))?;
    let hi_wide = &hi * FpVar::constant(Fr::from(8u64));
    let lo_wide = &lo * FpVar::constant(Fr::from(8u64));
    let (aligned, sticky) = align56(&lo_wide, &shift)?;
    let sum0 = &hi_wide + &aligned;
    let low = low_bits(&sum0, 57)?;
    let add_one = sticky.and(&low[0].not())?;
    let sum = &sum0 + FpVar::conditionally_select(&add_one, &FpVar::constant(Fr::one()), &FpVar::constant(Fr::zero()))?;
    let sum_bits = low_bits(&sum, 57)?;
    let carry = sum_bits[56].clone();
    let mut kept = Vec::with_capacity(56);
    for i in 0..56 {
        let up = if i + 1 < 57 { sum_bits[i + 1].clone() } else { Boolean::FALSE };
        kept.push(Boolean::conditionally_select(&carry, &up, &sum_bits[i])?);
    }
    let shifted_low = sum_bits[1].or(&sum_bits[0])?;
    kept[0] = Boolean::conditionally_select(&carry, &shifted_low, &sum_bits[0])?;
    let exp = &exp + FpVar::conditionally_select(&carry, &FpVar::constant(Fr::one()), &FpVar::constant(Fr::zero()))?;
    let mut significand = Vec::with_capacity(53);
    for bit in kept.iter().skip(3).take(53) {
        significand.push(bit.clone());
    }
    let round = kept[2].clone();
    let sticky = kept[0].or(&kept[1])?;
    round_pack(&exp, &significand, &round, &sticky)
}

pub(crate) fn enforce_sub_abs(a: &FpVar<Fr>, b: &FpVar<Fr>) -> Result<FpVar<Fr>, SynthesisError> {
    let (exp_a, sig_a) = normal_parts(a)?;
    let (exp_b, sig_b) = normal_parts(b)?;
    let exp_a_ge = at_least(&exp_a, &exp_b)?;
    let exp_b_ge = at_least(&exp_b, &exp_a)?;
    let same_exp = exp_a_ge.and(&exp_b_ge)?;
    let sig_a_ge = at_least(&sig_a, &sig_b)?;
    let a_first = Boolean::conditionally_select(&same_exp, &sig_a_ge, &exp_a_ge)?;
    let exp = FpVar::conditionally_select(&a_first, &exp_a, &exp_b)?;
    let hi = FpVar::conditionally_select(&a_first, &sig_a, &sig_b)?;
    let lo = FpVar::conditionally_select(&a_first, &sig_b, &sig_a)?;
    let shift = FpVar::conditionally_select(&a_first, &(&exp_a - &exp_b), &(&exp_b - &exp_a))?;
    let hi_wide = &hi * FpVar::constant(Fr::from(8u64));
    let lo_wide = &lo * FpVar::constant(Fr::from(8u64));
    let (aligned, sticky) = align56(&lo_wide, &shift)?;
    let cs = a.cs().or(b.cs());
    let diff = FpVar::new_witness(cs.clone(), || {
        let left = u64_of(&hi_wide)?;
        let right = u64_of(&aligned)?;
        let borrow = if sticky.value().unwrap_or(false) { 1 } else { 0 };
        Ok(Fr::from(left - right - borrow))
    })?;
    let _ = low_bits(&diff, 56)?;
    let borrow = FpVar::conditionally_select(&sticky, &FpVar::constant(Fr::one()), &FpVar::constant(Fr::zero()))?;
    hi_wide.enforce_equal(&(&diff + &aligned + &borrow))?;
    let diff_bits = low_bits(&diff, 56)?;
    let lead = FpVar::new_witness(cs, || {
        let raw = u64_of(&diff)?;
        Ok(Fr::from(63 - raw.leading_zeros() as u64))
    })?;
    let lead_bits = low_bits(&lead, 6)?;
    let mut seen = FpVar::constant(Fr::zero());
    let mut norm_bits = vec![Boolean::FALSE; 56];
    let mut exp_out = FpVar::constant(Fr::zero());
    for k in 0..56 {
        let chosen = equals_usize(&lead_bits, k)?;
        seen += FpVar::conditionally_select(&chosen, &FpVar::constant(Fr::one()), &FpVar::constant(Fr::zero()))?;
        let top = Boolean::conditionally_select(&chosen, &diff_bits[k], &Boolean::TRUE)?;
        top.enforce_equal(&Boolean::TRUE)?;
        for above in (k + 1)..56 {
            let clear = Boolean::conditionally_select(&chosen, &diff_bits[above], &Boolean::FALSE)?;
            clear.enforce_equal(&Boolean::FALSE)?;
        }
        let rise = 55 - k;
        for i in 0..56 {
            let source = if i >= rise { diff_bits[i - rise].clone() } else { Boolean::FALSE };
            let selected = Boolean::conditionally_select(&chosen, &source, &Boolean::FALSE)?;
            norm_bits[i] = norm_bits[i].or(&selected)?;
        }
        let next_exp = &exp - FpVar::constant(Fr::from(rise as u64));
        exp_out += FpVar::conditionally_select(&chosen, &next_exp, &FpVar::constant(Fr::zero()))?;
    }
    seen.enforce_equal(&FpVar::constant(Fr::one()))?;
    let mut significand = Vec::with_capacity(53);
    for bit in norm_bits.iter().skip(3).take(53) {
        significand.push(bit.clone());
    }
    let round = norm_bits[2].clone();
    let sticky = norm_bits[0].or(&norm_bits[1])?;
    round_pack(&exp_out, &significand, &round, &sticky)
}

pub(crate) fn enforce_mul(a: &FpVar<Fr>, b: &FpVar<Fr>) -> Result<FpVar<Fr>, SynthesisError> {
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

pub(crate) fn enforce_div(a: &FpVar<Fr>, b: &FpVar<Fr>) -> Result<FpVar<Fr>, SynthesisError> {
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

pub(crate) fn enforce_floor(bits: &FpVar<Fr>) -> Result<FpVar<Fr>, SynthesisError> {
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

pub(crate) fn u64_of(value: &FpVar<Fr>) -> Result<u64, SynthesisError> {
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

    #[test]
    fn addition_matches_the_binary64_model() {
        fn check(a: f64, b: f64) {
            let cs = ConstraintSystem::<Fr>::new_ref();
            let left = FpVar::new_witness(cs.clone(), || Ok(Fr::from(a.to_bits()))).unwrap();
            let right = FpVar::new_witness(cs.clone(), || Ok(Fr::from(b.to_bits()))).unwrap();
            let got = enforce_add(&left, &right).unwrap();
            let expect = binary64::add(a.to_bits(), b.to_bits()).unwrap();
            got.enforce_equal(&FpVar::constant(Fr::from(expect))).unwrap();
            assert!(cs.is_satisfied().unwrap(), "{a} + {b}: {:?}", cs.which_is_unsatisfied().unwrap());
        }
        check(0.5, 0.35);
        check(1_000_000.0, 1_000_000.0);
        check(1.0, 1e-9);
        check(0.0008, 1e-9);
        fn check_sub(a: f64, b: f64) {
            let cs = ConstraintSystem::<Fr>::new_ref();
            let left = FpVar::new_witness(cs.clone(), || Ok(Fr::from(a.to_bits()))).unwrap();
            let right = FpVar::new_witness(cs.clone(), || Ok(Fr::from(b.to_bits()))).unwrap();
            let got = enforce_sub_abs(&left, &right).unwrap();
            let expect = binary64::sub_abs(a.to_bits(), b.to_bits()).unwrap();
            got.enforce_equal(&FpVar::constant(Fr::from(expect))).unwrap();
            assert!(cs.is_satisfied().unwrap(), "|{a} - {b}|: {:?}", cs.which_is_unsatisfied().unwrap());
        }
        check_sub(1.0, 1e-7);
        check_sub(0.5635932862873007, 2.0 / (1.0 + 5.0_f64.sqrt()));
        let cs = ConstraintSystem::<Fr>::new_ref();
        let raw = FpVar::new_witness(cs.clone(), || Ok(Fr::from(10_396_461_113_802_754_501u64))).unwrap();
        let got = enforce_rounded_u64(&raw).unwrap();
        got.enforce_equal(&FpVar::constant(Fr::from(binary64::from_u64(10_396_461_113_802_754_501).unwrap()))).unwrap();
        assert!(cs.is_satisfied().unwrap(), "{:?}", cs.which_is_unsatisfied().unwrap());
    }
}
