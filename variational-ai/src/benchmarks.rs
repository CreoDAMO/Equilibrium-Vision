use std::time::Instant;
use crate::action::Action;
use crate::mnist::MnistData;
use crate::logistic::LogisticAction;
use crate::mlp::MlpAction;
use crate::ntk::{compute_empirical_ntk_mlp, solve_ntk};
use crate::solver::{StationarySolver, LbfgsSolver};
use crate::deterministic;

pub struct BenchmarkResult {
    pub time_secs: f64,
    pub accuracy:  f64,
    pub residual:  f64, // final gradient norm ‖∇S(θ*)‖
}

// ── Logistic regression (Newton-CG) ──────────────────────────────────────────

pub fn run_logistic_variational(data: &MnistData) -> BenchmarkResult {
    let action = LogisticAction::new(
        data.train_data.clone(), data.train_labels.clone(),
        data.dim, 0.01,
    );
    let solver = StationarySolver::new(1e-6, 100);
    let start  = Instant::now();
    let theta  = solver.solve_newton_cg(&action, &vec![0.0; data.dim]);
    let elapsed = start.elapsed().as_secs_f64();

    let grad     = action.gradient(&theta);
    let residual = deterministic::norm2(&grad);

    let mut correct = 0usize;
    for i in 0..data.test_count {
        let x    = &data.test_data[i * data.dim..(i + 1) * data.dim];
        let pred = if action.predict(&theta, x) > 0.5 { 1.0 } else { 0.0 };
        if (pred - data.test_labels[i]).abs() < 0.5 { correct += 1; }
    }
    BenchmarkResult {
        time_secs: elapsed,
        accuracy:  correct as f64 / data.test_count as f64,
        residual,
    }
}

// ── Two-layer ReLU MLP (L-BFGS) ──────────────────────────────────────────────

pub fn run_mlp_variational(data: &MnistData) -> BenchmarkResult {
    let hidden = 32;
    let action = MlpAction::new(
        data.train_data.clone(), data.train_labels.clone(),
        data.dim, hidden, 0.01,
    );
    let solver = LbfgsSolver::new(1e-5, 200, 10);
    let start  = Instant::now();
    let theta  = solver.solve(&action, &vec![0.0; action.param_count()]);
    let elapsed = start.elapsed().as_secs_f64();

    let grad     = action.gradient(&theta);
    let residual = deterministic::norm2(&grad);

    let (w1, b1, w2, b2) = {
        let w1sz = hidden * data.dim;
        let w1 = theta[0..w1sz].to_vec();
        let b1 = theta[w1sz..w1sz + hidden].to_vec();
        let w2 = theta[w1sz + hidden..w1sz + hidden + hidden].to_vec();
        let b2 = theta[w1sz + hidden + hidden];
        (w1, b1, w2, b2)
    };

    let mut correct = 0usize;
    for i in 0..data.test_count {
        let x   = &data.test_data[i * data.dim..(i + 1) * data.dim];
        let out = action.forward_one(x, &w1, &b1, &w2, b2);
        let pred = if out > 0.5 { 1.0 } else { 0.0 };
        if (pred - data.test_labels[i]).abs() < 0.5 { correct += 1; }
    }
    BenchmarkResult {
        time_secs: elapsed,
        accuracy:  correct as f64 / data.test_count as f64,
        residual,
    }
}

// ── NTK sketch (CG on kernel system) ─────────────────────────────────────────

pub fn run_ntk_benchmark(data: &MnistData) -> BenchmarkResult {
    let support_size = data.train_count.min(500);
    let lambda       = 0.01_f64;
    let hidden       = 32_usize;
    let seed         = 42_u64;

    // Deterministic support selection.
    use rand::SeedableRng;
    use rand::rngs::StdRng;
    use rand::seq::SliceRandom;
    let mut rng     = StdRng::seed_from_u64(seed);
    let mut indices: Vec<usize> = (0..data.train_count).collect();
    indices.shuffle(&mut rng);
    let support_idx = &indices[..support_size];

    let mut support_data   = Vec::with_capacity(support_size * data.dim);
    let mut support_labels = Vec::with_capacity(support_size);
    for &i in support_idx {
        support_data.extend_from_slice(&data.train_data[i * data.dim..(i + 1) * data.dim]);
        support_labels.push(data.train_labels[i]);
    }

    let start     = Instant::now();
    let ntk_action = compute_empirical_ntk_mlp(
        &support_data, &support_labels,
        data.dim, hidden, lambda, seed,
    );
    let alpha   = solve_ntk(&ntk_action.kernel, &ntk_action.y, lambda, 1e-6, 100);
    let elapsed = start.elapsed().as_secs_f64();

    let grad     = ntk_action.gradient(&alpha);
    let residual = deterministic::norm2(&grad);

    // Re-compute Jacobians for test prediction (same seed → identical init).
    let param_count = hidden * data.dim + hidden + hidden + 1;
    use rand::Rng;
    let mut rng_w = StdRng::seed_from_u64(seed);
    let theta_jac: Vec<f64> = (0..param_count)
        .map(|_| rng_w.gen::<f64>() * 0.1 - 0.05)
        .collect();
    let dummy_action = MlpAction::new(
        vec![0.0; data.dim], vec![0.0; 1],
        data.dim, hidden, lambda,
    );
    let support_jacobians: Vec<Vec<f64>> = support_idx.iter().map(|&i| {
        let x = &data.train_data[i * data.dim..(i + 1) * data.dim];
        dummy_action.jacobian_output(&theta_jac, x)
    }).collect();

    let mut correct = 0usize;
    for i in 0..data.test_count {
        let x        = &data.test_data[i * data.dim..(i + 1) * data.dim];
        let test_jac = dummy_action.jacobian_output(&theta_jac, x);
        let k_new: Vec<f64> = support_jacobians.iter()
            .map(|sj| deterministic::dot(&test_jac, sj))
            .collect();
        let pred_raw = ntk_action.predict(alpha.as_slice(), &k_new);
        let pred = if pred_raw > 0.5 { 1.0 } else { 0.0 };
        if (pred - data.test_labels[i]).abs() < 0.5 { correct += 1; }
    }
    BenchmarkResult {
        time_secs: elapsed,
        accuracy:  correct as f64 / data.test_count as f64,
        residual,
    }
}
