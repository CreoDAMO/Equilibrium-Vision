/// Android JNI bridge — compiled only with `--features jni-bridge`.
///
/// Entry points are exported as `Java_com_equilibrium_ai_VariationalAI_*`
/// so the Kotlin class `VariationalAI` can call them via `System.loadLibrary`.
///
/// Each function is wrapped in `std::panic::catch_unwind` so a Rust panic
/// does not unwind through the JVM and crash the process.

use jni::JNIEnv;
use jni::objects::JClass;
use jni::sys::{jdoubleArray, jboolean, jlong};

use crate::mnist::load_synthetic_mnist;
use crate::logistic::LogisticAction;
use crate::mlp::MlpAction;
use crate::ntk::{compute_empirical_ntk_mlp, solve_ntk};
use crate::solver::StationarySolver;
use crate::deterministic;

/// Helper: convert a Vec<f64> into a Java double[] and return the raw pointer.
fn vec_to_jdouble_array(env: &JNIEnv, v: &[f64]) -> jdoubleArray {
    let arr = env.new_double_array(v.len() as i32)
        .expect("new_double_array failed");
    env.set_double_array_region(arr, 0, v)
        .expect("set_double_array_region failed");
    arr
}

/// Train a logistic regression model on binary MNIST (0 vs 1) with Newton-CG.
///
/// Returns a double[2]: [test_accuracy, gradient_norm_residual].
#[no_mangle]
pub extern "system" fn Java_com_equilibrium_ai_VariationalAI_trainLogistic(
    env: JNIEnv, _class: JClass,
) -> jdoubleArray {
    let result = std::panic::catch_unwind(|| {
        let data   = load_synthetic_mnist(10_000, 2_000);
        let action = LogisticAction::new(
            data.train_data.clone(), data.train_labels.clone(), data.dim, 0.01,
        );
        let solver = StationarySolver::new(1e-6, 100);
        let theta  = solver.solve_newton_cg(&action, &vec![0.0; data.dim]);

        let grad     = action.gradient(&theta);
        let residual = deterministic::norm2(&grad);

        let mut correct = 0usize;
        for i in 0..data.test_count {
            let x    = &data.test_data[i * data.dim..(i + 1) * data.dim];
            let pred = if action.predict(&theta, x) > 0.5 { 1.0 } else { 0.0 };
            if (pred - data.test_labels[i]).abs() < 0.5 { correct += 1; }
        }
        let acc = correct as f64 / data.test_count as f64;
        vec![acc, residual]
    });

    match result {
        Ok(v)  => vec_to_jdouble_array(&env, &v),
        Err(_) => vec_to_jdouble_array(&env, &[-1.0, -1.0]),
    }
}

/// Train an NTK model on binary MNIST with CG.
///
/// Returns a double[2]: [test_accuracy, gradient_norm_residual].
#[no_mangle]
pub extern "system" fn Java_com_equilibrium_ai_VariationalAI_trainNtk(
    env: JNIEnv, _class: JClass,
) -> jdoubleArray {
    let result = std::panic::catch_unwind(|| {
        let data         = load_synthetic_mnist(10_000, 2_000);
        let support_size = 500_usize;
        let lambda       = 0.01_f64;
        let hidden       = 32_usize;
        let seed         = 42_u64;

        use rand::SeedableRng;
        use rand::rngs::StdRng;
        use rand::seq::SliceRandom;
        use rand::Rng;

        let mut rng     = StdRng::seed_from_u64(seed);
        let mut indices: Vec<usize> = (0..data.train_count).collect();
        indices.shuffle(&mut rng);
        let support_idx: Vec<usize> = indices[..support_size].to_vec();

        let mut support_data   = Vec::with_capacity(support_size * data.dim);
        let mut support_labels = Vec::with_capacity(support_size);
        for &i in &support_idx {
            support_data.extend_from_slice(&data.train_data[i * data.dim..(i + 1) * data.dim]);
            support_labels.push(data.train_labels[i]);
        }

        let ntk_action = compute_empirical_ntk_mlp(
            &support_data, &support_labels, data.dim, hidden, lambda, seed,
        );
        let alpha = solve_ntk(&ntk_action.kernel, &ntk_action.y, lambda, 1e-6, 100);
        let grad  = ntk_action.gradient(&alpha);
        let residual = deterministic::norm2(&grad);

        // Recompute support Jacobians for test prediction.
        let param_count = hidden * data.dim + hidden + hidden + 1;
        let mut rng_w = StdRng::seed_from_u64(seed);
        let theta_jac: Vec<f64> = (0..param_count)
            .map(|_| rng_w.gen::<f64>() * 0.1 - 0.05)
            .collect();
        let dummy_action = MlpAction::new(
            vec![0.0; data.dim], vec![0.0; 1], data.dim, hidden, lambda,
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
            let pred     = if pred_raw > 0.5 { 1.0 } else { 0.0 };
            if (pred - data.test_labels[i]).abs() < 0.5 { correct += 1; }
        }
        let acc = correct as f64 / data.test_count as f64;
        vec![acc, residual]
    });

    match result {
        Ok(v)  => vec_to_jdouble_array(&env, &v),
        Err(_) => vec_to_jdouble_array(&env, &[-1.0, -1.0]),
    }
}
