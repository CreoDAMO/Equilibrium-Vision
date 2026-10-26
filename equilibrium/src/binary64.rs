//! The binary64 operations `adjustDifficulty` actually performs.
//!
//! These are not rational shortcuts. Multiplication and division round to
//! nearest, ties to even, the same way ECMA-262 does. The witness generator
//! and the circuit both use this arithmetic.

const FRAC_MASK: u64 = (1 << 52) - 1;
const BIAS: i32 = 1023;

/// Decimal literals used by the difficulty clamp.
pub const BITS_0_8: u64 = 0x3fe9_9999_9999_999a;
pub const BITS_1_2: u64 = 0x3ff3_3333_3333_3333;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rounded {
    pub bits: u64,
    /// Significand including the implicit 1, before the tie-to-even step.
    pub significand: u64,
    pub round: bool,
    pub sticky: bool,
    pub exp: i32,
    pub wide: bool,
}

fn split(bits: u64) -> Result<(i32, u64), &'static str> {
    if bits >> 63 != 0 {
        return Err("negative binary64 is outside this difficulty arithmetic");
    }
    let exp = ((bits >> 52) & 0x7ff) as i32;
    if exp == 0 || exp == 0x7ff {
        return Err("subnormal or non-finite binary64 is outside this difficulty arithmetic");
    }
    Ok((exp, bits & FRAC_MASK))
}

fn finish(exp: i32, significand: u128, round: bool, sticky: bool) -> Result<Rounded, &'static str> {
    let lsb = (significand & 1) == 1;
    let mut significand = significand;
    let mut exp = exp;
    if round && (sticky || lsb) {
        significand += 1;
        if significand == (1u128 << 53) {
            significand >>= 1;
            exp += 1;
        }
    }
    if exp <= 0 || exp >= 0x7ff || !((1u128 << 52)..(1u128 << 53)).contains(&significand) {
        return Err("binary64 result left the normal range");
    }
    let bits = ((exp as u64) << 52) | ((significand as u64) & FRAC_MASK);
    Ok(Rounded {
        bits,
        significand: significand as u64,
        round,
        sticky,
        exp,
        wide: false,
    })
}

pub fn mul(a: u64, b: u64) -> Result<Rounded, &'static str> {
    let (ea, fa) = split(a)?;
    let (eb, fb) = split(b)?;
    let prod = ((1u128 << 52) | fa as u128) * ((1u128 << 52) | fb as u128);
    let wide = prod >= (1u128 << 105);
    let (significand, round, sticky, exp) = if wide {
        (
            prod >> 53,
            ((prod >> 52) & 1) == 1,
            (prod & ((1u128 << 52) - 1)) != 0,
            ea + eb - BIAS + 1,
        )
    } else {
        (
            prod >> 52,
            ((prod >> 51) & 1) == 1,
            (prod & ((1u128 << 51) - 1)) != 0,
            ea + eb - BIAS,
        )
    };
    let mut rounded = finish(exp, significand, round, sticky)?;
    rounded.wide = wide;
    Ok(rounded)
}

pub fn div(a: u64, b: u64) -> Result<Rounded, &'static str> {
    let (ea, fa) = split(a)?;
    let (eb, fb) = split(b)?;
    let sig_a = (1u128 << 52) | fa as u128;
    let sig_b = (1u128 << 52) | fb as u128;
    let q = (sig_a << 54) / sig_b;
    let r = (sig_a << 54) % sig_b;
    let wide = q >= (1u128 << 54);
    let (significand, round, sticky, exp) = if wide {
        (
            q >> 2,
            ((q >> 1) & 1) == 1,
            (q & 1) == 1 || r != 0,
            ea - eb + BIAS,
        )
    } else {
        (
            q >> 1,
            (q & 1) == 1,
            r != 0,
            ea - eb + BIAS - 1,
        )
    };
    let mut rounded = finish(exp, significand, round, sticky)?;
    rounded.wide = wide;
    Ok(rounded)
}

pub fn from_u64(n: u64) -> Result<u64, &'static str> {
    if n == 0 {
        return Ok(0);
    }
    let e = 63 - n.leading_zeros() as i32;
    if e <= 52 {
        let exp = e + BIAS;
        let frac = (n << (52 - e)) & FRAC_MASK;
        return Ok(((exp as u64) << 52) | frac);
    }
    let drop = (e - 52) as u32;
    let significand = (n >> drop) as u128;
    let round = ((n >> (drop - 1)) & 1) == 1;
    let sticky = drop > 1 && (n & ((1u64 << (drop - 1)) - 1)) != 0;
    Ok(finish(e + BIAS, significand, round, sticky)?.bits)
}

pub fn floor_u64(bits: u64) -> Result<u64, &'static str> {
    if bits == 0 {
        return Ok(0);
    }
    let (exp, frac) = split(bits)?;
    let e = exp - BIAS;
    if e < 0 {
        return Ok(0);
    }
    let sig = (1u128 << 52) | frac as u128;
    if e >= 52 {
        let shift = e - 52;
        if shift >= 64 {
            return Err("floor does not fit in u64");
        }
        let value = sig << shift;
        if value > u128::from(u64::MAX) {
            return Err("floor does not fit in u64");
        }
        return Ok(value as u64);
    }
    Ok((sig >> (52 - e)) as u64)
}

fn significand(bits: u64) -> Result<(i32, u128), &'static str> {
    if bits == 0 {
        return Ok((-1, 0));
    }
    let (exp, frac) = split(bits)?;
    Ok((exp, (1u128 << 52) | u128::from(frac)))
}

/// Addition of two non-negative finite values.
pub fn add(a: u64, b: u64) -> Result<u64, &'static str> {
    if a == 0 {
        return Ok(b);
    }
    if b == 0 {
        return Ok(a);
    }
    let (ea, sa) = significand(a)?;
    let (eb, sb) = significand(b)?;
    if eb > ea {
        return add(b, a);
    }
    let shift = (ea - eb) as u32;
    let hi = sa << 3;
    let (lo, sticky) = if shift == 0 {
        (sb << 3, false)
    } else if shift >= 56 {
        (0, sb != 0)
    } else {
        let wide = sb << 3;
        let lost = wide & ((1u128 << shift) - 1);
        (wide >> shift, lost != 0)
    };
    let mut sum = hi + lo;
    if sticky {
        sum |= 1;
    }
    let mut exp = ea;
    if sum >= (1u128 << 56) {
        let lost = (sum & 1) != 0;
        sum >>= 1;
        if lost {
            sum |= 1;
        }
        exp += 1;
    }
    let significand = sum >> 3;
    let round = ((sum >> 2) & 1) == 1;
    let sticky = (sum & 0b11) != 0;
    Ok(finish(exp, significand, round, sticky)?.bits)
}

/// Absolute difference of two non-negative finite values.
pub fn sub_abs(a: u64, b: u64) -> Result<u64, &'static str> {
    if a == b {
        return Ok(0);
    }
    let (ea, sa) = significand(a)?;
    let (eb, sb) = significand(b)?;
    let (exp, hi, lo_sig, shift) = if ea > eb || (ea == eb && sa >= sb) {
        (ea, sa, sb, (ea - eb) as u32)
    } else {
        (eb, sb, sa, (eb - ea) as u32)
    };
    let hi = hi << 3;
    let (lo, sticky) = if shift == 0 {
        (lo_sig << 3, false)
    } else if shift >= 56 {
        (0, lo_sig != 0)
    } else {
        let wide = lo_sig << 3;
        let lost = wide & ((1u128 << shift) - 1);
        (wide >> shift, lost != 0)
    };
    let mut diff = hi - lo;
    if sticky {
        diff -= 1;
    }
    if diff == 0 {
        return Ok(0);
    }
    let mut exp = exp;
    while diff < (1u128 << 55) {
        diff <<= 1;
        exp -= 1;
        if exp <= 0 {
            return Ok(0);
        }
    }
    let significand = diff >> 3;
    let round = ((diff >> 2) & 1) == 1;
    let sticky_bits = (diff & 0b11) != 0;
    Ok(finish(exp, significand, round, sticky_bits)?.bits)
}

fn clamp_bits(bits: u64) -> u64 {
    let high = if bits > BITS_1_2 { BITS_1_2 } else { bits };
    if high < BITS_0_8 { BITS_0_8 } else { high }
}

/// `adjustDifficulty` for an exact integer difficulty, a positive block interval,
/// and exact integer foreign terms. `block_time <= 0` is rejected here.
pub fn adjust(difficulty: u64, block_time: u64, target_ms: u64, num: u64, den: u64) -> Result<u64, &'static str> {
    if block_time == 0 {
        return Err("block interval is not positive");
    }
    let difficulty_bits = from_u64(difficulty)?;
    let time_bits = from_u64(block_time)?;
    let target_ms_bits = from_u64(target_ms)?;
    let thousand = from_u64(1_000)?;
    let num_bits = from_u64(num)?;
    let den_bits = from_u64(den)?;
    let target = div(target_ms_bits, thousand)?.bits;
    let unclamped = mul(div(target, time_bits)?.bits, div(num_bits, den_bits)?.bits)?.bits;
    let factor = clamp_bits(unclamped);
    let on_clamp = factor == BITS_0_8 || factor == BITS_1_2;
    let raw = if on_clamp {
        floor_u64(mul(difficulty_bits, factor)?.bits)?
    } else {
        let numer = mul(mul(difficulty_bits, target)?.bits, num_bits)?.bits;
        let denom = mul(time_bits, den_bits)?.bits;
        floor_u64(div(numer, denom)?.bits)?
    };
    Ok(raw.max(100_000))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn native(difficulty: u64, block_time: u64, target_ms: u64, num: u64, den: u64) -> u64 {
        let difficulty = difficulty as f64;
        let block_time = block_time as f64;
        let target = (target_ms as f64) / 1000.0;
        let unclamped = (target / block_time) * ((num as f64) / (den as f64));
        let factor = 0.8_f64.max(1.2_f64.min(unclamped));
        let raw = if factor == 0.8 || factor == 1.2 {
            (difficulty * factor).floor()
        } else {
            ((difficulty * target * (num as f64)) / (block_time * (den as f64))).floor()
        };
        (100_000_f64).max(raw) as u64
    }

    #[test]
    fn rounding_matches_hardware_binary64() {
        let samples = [1u64, 2, 3, 8, 10, 12, 15, 16, 20, 255, 1000, 9950, 10000, 10050, 100_000, 187_500, 200_000, 800_000, 1_000_000, 1_000_001, 1_200_000, 1_500_000];
        for &a in &samples {
            assert_eq!(from_u64(a).unwrap(), (a as f64).to_bits(), "{a}");
            for &b in &samples {
                if b == 0 {
                    continue;
                }
                let ab = (a as f64) * (b as f64);
                assert_eq!(mul(from_u64(a).unwrap(), from_u64(b).unwrap()).unwrap().bits, ab.to_bits(), "mul {a} {b}");
                let q = (a as f64) / (b as f64);
                assert_eq!(div(from_u64(a).unwrap(), from_u64(b).unwrap()).unwrap().bits, q.to_bits(), "div {a} {b}");
                assert_eq!(floor_u64(ab.to_bits()).unwrap(), ab.floor() as u64, "floor {ab}");
                let sum = (a as f64) + (b as f64);
                assert_eq!(add(from_u64(a).unwrap(), from_u64(b).unwrap()).unwrap(), sum.to_bits(), "add {a} {b}");
                let diff = ((a as f64) - (b as f64)).abs();
                assert_eq!(sub_abs(from_u64(a).unwrap(), from_u64(b).unwrap()).unwrap(), diff.to_bits(), "sub {a} {b}");
            }
        }
        let wide = [1u64 << 53, (1 << 53) + 1, (1 << 53) + 2, 10_396_461_113_802_754_501];
        for n in wide {
            assert_eq!(from_u64(n).unwrap(), (n as f64).to_bits(), "{n}");
        }
        assert_eq!(BITS_0_8, 0.8_f64.to_bits());
        assert_eq!(BITS_1_2, 1.2_f64.to_bits());
    }

    #[test]
    fn the_second_block_reward_follows_from_its_header() {
        use sha2::{Digest, Sha256};
        let mut preimage = [0u8; 80];
        preimage[64..72].copy_from_slice(&24u64.to_le_bytes());
        preimage[72..80].copy_from_slice(&1u64.to_le_bytes());
        let digest = Sha256::digest(preimage);
        let hash_val = u64::from_le_bytes(digest[..8].try_into().unwrap());
        assert_eq!(hash_val, 10_396_461_113_802_754_501);

        let two64 = 2.0_f64.powi(64).to_bits();
        let h = div(from_u64(hash_val).unwrap(), two64).unwrap().bits;
        let million = from_u64(1_000_000).unwrap();
        let half = div(million, add(million, million).unwrap()).unwrap().bits;
        let tau = add(half, 0.35_f64.to_bits()).unwrap();
        assert!(h < tau);
        let inv_phi = (2.0_f64 / (1.0 + 5.0_f64.sqrt())).to_bits();
        let gap = sub_abs(h, inv_phi).unwrap();
        let residual = mul(gap, gap).unwrap().bits;
        assert_eq!(residual, 0.0029637900846207032_f64.to_bits());

        let y = div(from_u64(1).unwrap(), from_u64(2_100_000).unwrap()).unwrap().bits;
        let eps = mul(y, std::f64::consts::LN_2.to_bits()).unwrap().bits;
        let mut series = (1.0_f64 / 3_628_800.0).to_bits();
        for denom in [362_880.0_f64, 40_320.0, 5_040.0, 720.0, 120.0, 24.0, 6.0, 2.0, 1.0] {
            let term = mul(series, eps).unwrap().bits;
            let constant = (1.0 / denom).to_bits();
            series = sub_abs(constant, term).unwrap();
        }
        let term = mul(series, eps).unwrap().bits;
        series = sub_abs(from_u64(1).unwrap(), term).unwrap();
        let base = mul(from_u64(100).unwrap(), series).unwrap().bits;
        assert_eq!(base, 0x4058ffff758f000f);
        let quality = div(0.0008_f64.to_bits(), add(residual, 1e-9_f64.to_bits()).unwrap()).unwrap().bits;
        let reward = floor_u64(mul(base, quality).unwrap().bits).unwrap();
        assert_eq!(reward, 26);
    }

    #[test]
    fn difficulty_matches_the_javascript_cases() {
        let cases = [
            (1_000_000, 12, 15_000, 1, 1, 1_200_000u64),
            (1_000_000, 10, 15_000, 1, 1, 1_200_000),
            (1_000_000, 10, 12_000, 1, 1, 1_200_000),
            (1_000_000, 10, 8_000, 1, 1, 800_000),
            (1_000_000, 20, 15_000, 1, 1, 800_000),
            (200_000, 16, 15_000, 1, 1, 187_500),
            (1_000_001, 10, 12_000, 1, 1, 1_200_001),
            (1_000_000, 15, 15_000, 10_050, 10_000, 1_005_000),
        ];
        for (difficulty, time, target_ms, num, den, expected) in cases {
            let got = adjust(difficulty, time, target_ms, num, den).unwrap();
            assert_eq!(got, expected, "{difficulty} {time} {target_ms}");
            assert_eq!(got, native(difficulty, time, target_ms, num, den));
        }
    }
}
