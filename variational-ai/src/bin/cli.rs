//! variational-ai-cli — residual verification binary
//!
//! Reads a JSON request from stdin, runs the deterministic NTK solver on
//! the provided support set, and writes the computed residual to stdout.
//!
//! Used by the TypeScript bridge (artifacts/api-server/src/variational-ai/bridge.ts)
//! to verify on-chain model residual claims without embedding Rust in Node.
//!
//! Input JSON schema:
//! ```json
//! {
//!   "support_data":    [f64, ...],   // n_support × input_dim, row-major
//!   "support_labels":  [f64, ...],   // n_support binary targets
//!   "input_dim":       usize,
//!   "hidden_dim":      usize,
//!   "lambda":          f64,
//!   "seed":            u64,
//!   "claimed_residual": i64,         // fixed-point (scaled ×1e12)
//!   "epsilon":         i64,          // acceptance tolerance (fixed-point)
//!   "tol":             f64,          // CG convergence tolerance (optional, default 1e-6)
//!   "max_iter":        usize         // max CG iterations (optional, default 100)
//! }
//! ```
//!
//! Output JSON:
//! ```json
//! {
//!   "computed_residual_fp": i64,
//!   "computed_residual_f64": f64,
//!   "valid": bool,
//!   "epsilon": i64
//! }
//! ```

use std::io::{self, BufRead, Read, Write};
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

/// Process one JSON request string → JSON response string.
/// Returns Err with an error JSON string on bad input.
fn process(input: &str) -> Result<(Response, bool), String> {
    let req: Request = serde_json::from_str(input)
        .map_err(|e| serde_json::json!({ "error": format!("JSON parse error: {}", e) }).to_string())?;

    let n_support = req.support_labels.len();
    if req.support_data.len() != n_support * req.input_dim {
        return Err(serde_json::json!({
            "error": format!(
                "support_data length {} ≠ n_support({}) × input_dim({})",
                req.support_data.len(), n_support, req.input_dim
            )
        }).to_string());
    }

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

    let grad              = ntk_action.gradient(&alpha);
    let residual_f64      = norm2(&grad);
    let computed_residual = to_fixed(residual_f64);
    let valid             = (req.claimed_residual - computed_residual).abs() <= req.epsilon;

    Ok((Response {
        computed_residual_fp:  computed_residual,
        computed_residual_f64: residual_f64,
        valid,
        epsilon: req.epsilon,
    }, valid))
}

/// Daemon mode: read one JSON request per line, write one JSON response per
/// line, flush stdout after each response. Keeps the process alive for the
/// lifetime of the TypeScript worker that owns it.
fn run_daemon() {
    let stdin  = io::stdin();
    let stdout = io::stdout();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let line = line.trim();
        if line.is_empty() { continue; }

        let json_out = match process(line) {
            Ok((resp, _valid)) => serde_json::to_string(&resp).expect("serialise"),
            Err(err_json) => err_json,
        };

        let mut out = stdout.lock();
        out.write_all(json_out.as_bytes()).expect("write");
        out.write_all(b"\n").expect("write");
        out.flush().expect("flush");
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // --daemon: persistent line-by-line mode for the TypeScript CliWorker.
    if args.iter().any(|a| a == "--daemon") {
        run_daemon();
        return;
    }

    // Default (one-shot): read all of stdin, process, exit with the same
    // legacy exit codes the bridge relied on before the worker was added.
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).expect("failed to read stdin");

    match process(&input) {
        Ok((response, valid)) => {
            let out = serde_json::to_string(&response).expect("JSON serialisation failed");
            io::stdout().write_all(out.as_bytes()).expect("write failed");
            io::stdout().write_all(b"\n").expect("write failed");
            if !valid { std::process::exit(1); }
        }
        Err(err_json) => {
            println!("{err_json}");
            std::process::exit(2);
        }
    }
}
