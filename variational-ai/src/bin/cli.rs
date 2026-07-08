/// variational-ai-cli — residual verification binary
///
/// Reads a JSON request from stdin, runs the deterministic NTK solver on
/// the provided support set, and writes the computed residual to stdout.
///
/// Used by the TypeScript bridge (artifacts/api-server/src/variational-ai/bridge.ts)
/// to verify on-chain model residual claims without embedding Rust in Node.
///
/// Input JSON schema:
/// ```json
/// {
///   "support_data":    [f64, ...],   // n_support × input_dim, row-major
///   "support_labels":  [f64, ...],   // n_support binary targets
///   "input_dim":       usize,
///   "hidden_dim":      usize,
///   "lambda":          f64,
///   "seed":            u64,
///   "claimed_residual": i64,         // fixed-point (scaled ×1e12)
///   "epsilon":         i64,          // acceptance tolerance (fixed-point)
///   "tol":             f64,          // CG convergence tolerance (optional, default 1e-6)
///   "max_iter":        usize         // max CG iterations (optional, default 100)
/// }
/// ```
///
/// Output JSON:
/// ```json
/// {
///   "computed_residual_fp": i64,
///   "computed_residual_f64": f64,
///   "valid": bool,
///   "epsilon": i64
/// }
/// ```

use std::io::{self, Read, Write};
use serde::{Deserialize, Serialize};

// Pull in the library modules directly (binary is in the same crate).
use variational_ai::action::Action;
use variational_ai::ntk::{compute_empirical_ntk_mlp, solve_ntk};
use variational_ai::deterministic::{norm2, to_fixed};

#[derive(Deserialize)]
struct Request {
    support_data:     Vec<f64>,
    support_labels:   Vec<f64>,
    input_dim:        usize,
    hidden_dim:       usize,
    lambda:           f64,
    seed:             u64,
    claimed_residual: i64,
    #[serde(default = "default_epsilon")]
    epsilon:          i64,
    #[serde(default = "default_tol")]
    tol:              f64,
    #[serde(default = "default_max_iter")]
    max_iter:         usize,
}

fn default_epsilon()  -> i64   { 1_000 }         // 1e-9 in fixed-point (1e12 scale)
fn default_tol()      -> f64   { 1e-6 }
fn default_max_iter() -> usize { 100 }

#[derive(Serialize)]
struct Response {
    computed_residual_fp:  i64,
    computed_residual_f64: f64,
    valid:                 bool,
    epsilon:               i64,
}

fn main() {
    // Read all of stdin.
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).expect("failed to read stdin");

    let req: Request = match serde_json::from_str(&input) {
        Ok(r) => r,
        Err(e) => {
            // Exit 2 = unrecoverable input error (bridge checks this).
            let err = serde_json::json!({ "error": format!("JSON parse error: {}", e) });
            println!("{}", err);
            std::process::exit(2);
        }
    };

    // Validate inputs.
    let n_support = req.support_labels.len();
    if req.support_data.len() != n_support * req.input_dim {
        let err = serde_json::json!({
            "error": format!(
                "support_data length {} ≠ n_support({}) × input_dim({})",
                req.support_data.len(), n_support, req.input_dim
            )
        });
        // Exit 2 = unrecoverable validation error.
        println!("{}", err);
        std::process::exit(2);
    }

    // Run the deterministic NTK solve.
    let ntk_action = compute_empirical_ntk_mlp(
        &req.support_data,
        &req.support_labels,
        req.input_dim,
        req.hidden_dim,
        req.lambda,
        req.seed,
    );
    let alpha = solve_ntk(
        &ntk_action.kernel,
        &ntk_action.y,
        req.lambda,
        req.tol,
        req.max_iter,
    );

    // Gradient norm at the solution.
    let grad              = ntk_action.gradient(&alpha);
    let residual_f64      = norm2(&grad);
    let computed_residual = to_fixed(residual_f64);
    let valid             = (req.claimed_residual - computed_residual).abs() <= req.epsilon;

    let response = Response {
        computed_residual_fp:  computed_residual,
        computed_residual_f64: residual_f64,
        valid,
        epsilon: req.epsilon,
    };

    let out = serde_json::to_string(&response).expect("JSON serialisation failed");
    io::stdout().write_all(out.as_bytes()).expect("write failed");
    io::stdout().write_all(b"\n").expect("write failed");

    // Exit 0 = valid, 1 = residual mismatch (not an error), 2 = error.
    if !valid { std::process::exit(1); }
}
