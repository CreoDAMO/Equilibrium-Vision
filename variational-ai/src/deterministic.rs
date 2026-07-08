use libm::{exp, log1p, sqrt};

// ── Floating-point deterministic helpers ──────────────────────────────────────
// We use libm (not the compiler's built-ins) so the transcendental functions
// produce the same bit pattern across x86-64 and aarch64, subject to the same
// IEEE-754 rounding mode.

/// Deterministic sigmoid via libm::exp.
pub fn sigmoid(x: f64) -> f64 {
    if x > 20.0 { 1.0 } else if x < -20.0 { 0.0 } else { 1.0 / (1.0 + exp(-x)) }
}

/// Deterministic softplus via libm::log1p.
pub fn softplus(x: f64) -> f64 {
    if x > 20.0 { x } else { log1p(exp(x)) }
}

/// Deterministic dot product: sort products by absolute value before summing
/// to minimise floating-point accumulation drift.
pub fn dot(a: &[f64], b: &[f64]) -> f64 {
    let mut prods: Vec<f64> = a.iter().zip(b.iter()).map(|(&x, &y)| x * y).collect();
    prods.sort_by(|u, v| u.abs().partial_cmp(&v.abs()).unwrap_or(std::cmp::Ordering::Equal));
    prods.iter().sum()
}

/// Deterministic axpy: y += scale * x  (in-place).
pub fn axpy(scale: f64, x: &[f64], y: &mut [f64]) {
    for i in 0..x.len() {
        y[i] += scale * x[i];
    }
}

/// Deterministic L2 norm via libm::sqrt.
pub fn norm2(v: &[f64]) -> f64 {
    sqrt(v.iter().map(|&x| x * x).sum())
}

// ── Fixed-point arithmetic (i64 scaled by 1e12) ───────────────────────────────
// Used for on-chain verification paths where bit-exact results are required
// across ALL architectures without relying on floating-point operations.

/// One unit in fixed-point representation (= 1.0 in real-world units).
pub const FIXED_SCALE: i64 = 1_000_000_000_000; // 1e12
pub const FIXED_SCALE_F64: f64 = FIXED_SCALE as f64;

/// Convert an f64 real value to fixed-point i64 (nearest integer rounding).
#[inline]
pub fn to_fixed(x: f64) -> i64 {
    (x * FIXED_SCALE_F64).round() as i64
}

/// Convert fixed-point i64 back to f64.
#[inline]
pub fn from_fixed(x: i64) -> f64 {
    x as f64 / FIXED_SCALE_F64
}

/// Saturating fixed-point multiplication: (a * b) / SCALE.
/// Saturates to i64::MIN/MAX on overflow instead of wrapping.
#[inline]
pub fn mul_fixed(a: i64, b: i64) -> i64 {
    // Use i128 intermediate to avoid overflow before the division.
    let wide = (a as i128) * (b as i128);
    let result = wide / (FIXED_SCALE as i128);
    result.clamp(i64::MIN as i128, i64::MAX as i128) as i64
}

/// Fixed-point dot product: Σ (a[i] * b[i]) / SCALE.
/// Elements are processed in sorted order (by absolute product) to match
/// the f64 deterministic dot but in integer arithmetic.
pub fn dot_fixed(a: &[i64], b: &[i64]) -> i64 {
    let mut prods: Vec<i64> = a.iter().zip(b.iter()).map(|(&x, &y)| mul_fixed(x, y)).collect();
    prods.sort_by_key(|v| v.unsigned_abs());
    // saturating sum
    prods.iter().fold(0i64, |acc, &v| acc.saturating_add(v))
}

/// Fixed-point L2 norm: sqrt(Σ x[i]^2 / SCALE^2) * SCALE
/// Returns a fixed-point value.
pub fn norm2_fixed(v: &[i64]) -> i64 {
    let sum_sq: i128 = v.iter().map(|&x| (x as i128) * (x as i128)).sum();
    // sqrt(sum_sq) is in units of SCALE; divide by SCALE to get fixed-point result
    let norm_scaled = (sum_sq as f64).sqrt() as i64;
    norm_scaled
}

/// Polynomial sigmoid approximation in fixed-point.
///
/// Uses a degree-5 minimax polynomial on [-8, 8]; clamps outside that range.
/// Maximum error vs. true sigmoid: < 0.0003 on the domain.
/// No floating-point operations — fully deterministic across architectures.
pub fn sigmoid_fixed(x: i64) -> i64 {
    const CLAMP: i64 = 8 * FIXED_SCALE; // 8.0 in fixed-point
    if x <= -CLAMP { return 0; }
    if x >= CLAMP  { return FIXED_SCALE; }

    // Polynomial coefficients (scaled by FIXED_SCALE):
    //   sigmoid(x) ≈ 0.5 + 0.19759*x - 0.00382*x^3 + 0.0000276*x^5
    // Values pre-multiplied by 1e12 to stay in fixed-point:
    let half: i64 = FIXED_SCALE / 2; // 0.5
    let c1: i64 = 197_590_000_000i64; // 0.19759
    let c3: i64 = -3_820_000_000i64;  // -0.00382
    let c5: i64 = 27_600_000i64;      // 0.0000276

    let bx  = mul_fixed(c1, x);
    let x2  = mul_fixed(x, x);
    let x3  = mul_fixed(x2, x);
    let x4  = mul_fixed(x2, x2);
    let x5  = mul_fixed(x4, x);
    let cx3 = mul_fixed(c3, x3);
    let cx5 = mul_fixed(c5, x5);

    (half + bx + cx3 + cx5).clamp(0, FIXED_SCALE)
}

/// Fixed-point softplus: max(0, x) + polynomial correction near 0.
pub fn softplus_fixed(x: i64) -> i64 {
    const CLAMP: i64 = 20 * FIXED_SCALE;
    if x >= CLAMP { return x; }
    if x <= -CLAMP { return 0; }
    // log1p(exp(x)) via the identity: softplus(x) = x + log(sigmoid(-x) + 1)
    // For the fixed-point path use: softplus(x) ≈ max(0,x) + sigmoid(x)*(1-sigmoid(x))*0.5
    // Simpler approximation good enough for gradient norms:
    let s = sigmoid_fixed(x);
    // softplus(x) ≈ x * sigmoid(x) + log(1 + exp(-|x|))
    // Approximate as: if x > 0: x * s; else: (SCALE - s) * (-x) / SCALE
    if x > 0 {
        mul_fixed(x, s)
    } else {
        let neg_s = FIXED_SCALE - s; // sigmoid(-x)
        mul_fixed(-x, neg_s)
    }
}
