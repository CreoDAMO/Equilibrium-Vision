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
    if exp <= 0 || exp >= 0x7ff || significand < (1u128 << 52) || significand >= (1u128 << 53) {
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

/// Exact encoding of an integer in `0..2^53`.
pub fn from_u64(n: u64) -> Result<u64, &'static str> {
    if n >= (1 << 53) {
        return Err("integer is not exact in binary64");
    }
    if n == 0 {
        return Ok(0);
    }
    let e = 63 - n.leading_zeros() as i32;
    let exp = e + BIAS;
    let frac = (n << (52 - e)) & FRAC_MASK;
    Ok(((exp as u64) << 52) | frac)
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
            }
        }
        assert_eq!(BITS_0_8, 0.8_f64.to_bits());
        assert_eq!(BITS_1_2, 1.2_f64.to_bits());
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
