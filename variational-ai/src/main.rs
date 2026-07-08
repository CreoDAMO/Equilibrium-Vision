mod action;
mod deterministic;
mod logistic;
mod mlp;
mod ntk;
mod solver;
mod mnist;
mod benchmarks;

use mnist::{load_synthetic_mnist, load_real_mnist};
use benchmarks::{run_logistic_variational, run_mlp_variational, run_ntk_benchmark};
use deterministic::to_fixed;

fn main() {
    // Try real MNIST first; fall back to synthetic data when files are absent.
    let data = try_real_or_synthetic();

    println!("─── Variational-AI Benchmark ─────────────────────────────────────");
    println!(
        "Data  : {} train, {} test  (dim={})",
        data.train_count, data.test_count, data.dim
    );
    println!();

    // ── Logistic Regression (Newton-CG) ──────────────────────────────────────
    let log_res = run_logistic_variational(&data);
    println!(
        "Logistic  (Newton-CG): time={:.4}s  acc={:.4}  ‖∇S‖={:.2e}  fp={}",
        log_res.time_secs, log_res.accuracy, log_res.residual,
        to_fixed(log_res.residual)
    );

    // ── MLP (L-BFGS) ─────────────────────────────────────────────────────────
    let mlp_res = run_mlp_variational(&data);
    println!(
        "MLP       (L-BFGS)  : time={:.4}s  acc={:.4}  ‖∇S‖={:.2e}  fp={}",
        mlp_res.time_secs, mlp_res.accuracy, mlp_res.residual,
        to_fixed(mlp_res.residual)
    );

    // ── NTK sketch (CG kernel solve) ─────────────────────────────────────────
    let ntk_res = run_ntk_benchmark(&data);
    println!(
        "NTK-500   (CG)      : time={:.4}s  acc={:.4}  ‖∇S‖={:.2e}  fp={}",
        ntk_res.time_secs, ntk_res.accuracy, ntk_res.residual,
        to_fixed(ntk_res.residual)
    );

    println!();
    println!("─── Done ─────────────────────────────────────────────────────────");
}

fn try_real_or_synthetic() -> mnist::MnistData {
    // If MNIST IDX files are present, use them; otherwise use synthetic data.
    let has_mnist = std::path::Path::new("data/train-images-idx3-ubyte").exists()
        && std::path::Path::new("data/train-labels-idx1-ubyte").exists()
        && std::path::Path::new("data/t10k-images-idx3-ubyte").exists()
        && std::path::Path::new("data/t10k-labels-idx1-ubyte").exists();

    if has_mnist {
        println!("(Using real MNIST data from data/)");
        load_real_mnist()
    } else {
        println!("(MNIST files not found in data/ — using synthetic data; see mnist.rs for download instructions)");
        load_synthetic_mnist(12_000, 2_000)
    }
}
