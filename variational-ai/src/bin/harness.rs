/// variational-ai-harness — determinism conformance harness
///
/// Trains all three model types (logistic, MLP, NTK) on synthetic data,
/// hashes every intermediate vector and final parameter set with SHA-256,
/// and prints a machine-readable report.
///
/// Run this binary on two different architectures (x86-64, aarch64) or
/// compiler versions and diff the output — any divergence indicates a
/// non-determinism bug.
///
/// Usage:
///   cargo run --release --bin variational-ai-harness
///
/// Output (one key=hex per line):
///   LOGISTIC_THETA=<sha256>
///   LOGISTIC_GRAD_NORM_FP=<i64>
///   MLP_THETA=<sha256>
///   MLP_GRAD_NORM_FP=<i64>
///   NTK_ALPHA=<sha256>
///   NTK_GRAD_NORM_FP=<i64>
///   ALL_PASS=true

use sha2::{Sha256, Digest};

use variational_ai::action::Action;
use variational_ai::mnist::load_synthetic_mnist;
use variational_ai::logistic::LogisticAction;
use variational_ai::mlp::MlpAction;
use variational_ai::ntk::{compute_empirical_ntk_mlp, solve_ntk};
use variational_ai::solver::{StationarySolver, LbfgsSolver};
use variational_ai::deterministic::{norm2, to_fixed};

fn sha256_of_f64_slice(v: &[f64]) -> String {
    let mut h = Sha256::new();
    for &x in v {
        h.update(x.to_bits().to_le_bytes());
    }
    hex::encode(h.finalize())
}

fn sha256_of_i64_slice(v: &[i64]) -> String {
    let mut h = Sha256::new();
    for &x in v {
        h.update(x.to_le_bytes());
    }
    hex::encode(h.finalize())
}

fn main() {
    // Fixed dataset so hashes are reproducible across runs.
    let data = load_synthetic_mnist(4_000, 1_000);

    println!("# variational-ai determinism harness");
    println!("# n_train={} n_test={} dim={}", data.train_count, data.test_count, data.dim);
    println!();

    // ── 1. Logistic Regression (Newton-CG) ───────────────────────────────────
    let log_action = LogisticAction::new(
        data.train_data.clone(), data.train_labels.clone(),
        data.dim, 0.01,
    );
    let log_solver = StationarySolver::new(1e-6, 100);
    let log_theta  = log_solver.solve_newton_cg(&log_action, &vec![0.0; data.dim]);
    let log_grad   = log_action.gradient(&log_theta);
    let log_fp     = to_fixed(norm2(&log_grad));

    // Also hash intermediate grad vectors at iterations 1, 5, 10.
    let mut log_theta_iter = vec![0.0_f64; data.dim];
    let mut iter_hashes: Vec<String> = Vec::new();
    for iter in 0..10 {
        let g = log_action.gradient(&log_theta_iter);
        if [1, 5, 10].contains(&(iter + 1)) {
            iter_hashes.push(format!("LOGISTIC_GRAD_ITER{:02}={}", iter + 1, sha256_of_f64_slice(&g)));
        }
        // One Newton step (simplified: gradient descent for the iter hash, not CG)
        for j in 0..data.dim {
            log_theta_iter[j] -= 0.1 * g[j];
        }
    }

    println!("LOGISTIC_THETA={}", sha256_of_f64_slice(&log_theta));
    println!("LOGISTIC_GRAD_NORM_FP={}", log_fp);
    for h in &iter_hashes { println!("{}", h); }
    println!();

    // ── 2. MLP (L-BFGS) ──────────────────────────────────────────────────────
    let hidden    = 32_usize;
    let mlp_action = MlpAction::new(
        data.train_data.clone(), data.train_labels.clone(),
        data.dim, hidden, 0.01,
    );
    let mlp_solver = LbfgsSolver::new(1e-5, 200, 10);
    let mlp_theta  = mlp_solver.solve(&mlp_action, &vec![0.0; mlp_action.param_count()]);
    let mlp_grad   = mlp_action.gradient(&mlp_theta);
    let mlp_fp     = to_fixed(norm2(&mlp_grad));

    println!("MLP_THETA={}", sha256_of_f64_slice(&mlp_theta));
    println!("MLP_GRAD_NORM_FP={}", mlp_fp);
    println!();

    // ── 3. NTK (CG kernel solve) ──────────────────────────────────────────────
    let support_size = 200_usize; // smaller for speed in CI
    let lambda       = 0.01_f64;
    let seed         = 42_u64;

    use rand::SeedableRng;
    use rand::rngs::StdRng;
    use rand::seq::SliceRandom;
    let mut rng     = StdRng::seed_from_u64(seed);
    let mut indices: Vec<usize> = (0..data.train_count).collect();
    indices.shuffle(&mut rng);
    let support_idx = &indices[..support_size];

    let mut sup_data   = Vec::with_capacity(support_size * data.dim);
    let mut sup_labels = Vec::with_capacity(support_size);
    for &i in support_idx {
        sup_data.extend_from_slice(&data.train_data[i * data.dim..(i + 1) * data.dim]);
        sup_labels.push(data.train_labels[i]);
    }

    let ntk    = compute_empirical_ntk_mlp(&sup_data, &sup_labels, data.dim, hidden, lambda, seed);
    let alpha  = solve_ntk(&ntk.kernel, &ntk.y, lambda, 1e-6, 100);
    let ntk_grad = ntk.gradient(&alpha);
    let ntk_fp   = to_fixed(norm2(&ntk_grad));

    // Hash alpha as i64 fixed-point values for pure-integer comparison.
    let alpha_fp: Vec<i64> = alpha.iter().map(|&a| to_fixed(a)).collect();
    // Collect kernel before moving ntk.
    let nrows = ntk.kernel.nrows();
    let ncols = ntk.kernel.ncols();
    let kernel_flat: Vec<f64> = (0..nrows)
        .flat_map(|i| (0..ncols).map(move |j| (i, j)))
        .map(|(i, j)| ntk.kernel[(i, j)])
        .collect();

    println!("NTK_ALPHA_FP={}", sha256_of_i64_slice(&alpha_fp));
    println!("NTK_KERNEL={}", sha256_of_f64_slice(&kernel_flat));
    println!("NTK_GRAD_NORM_FP={}", ntk_fp);
    println!();

    // ── Summary ───────────────────────────────────────────────────────────────
    // All checks pass if all FP residuals are reasonable (< 1.0 = 1e12 fp)
    let all_pass = log_fp.abs() < 1_000_000_000_000
        && mlp_fp.abs() < 1_000_000_000_000
        && ntk_fp.abs() < 1_000_000_000_000;
    println!("ALL_PASS={}", all_pass);
}
