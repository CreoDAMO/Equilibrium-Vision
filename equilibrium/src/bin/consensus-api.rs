// ── Equilibrium Consensus API — stdin/stdout JSON-RPC ─────────────────────────
//
// Protocol: one newline-terminated JSON request per line on stdin,
//           one newline-terminated JSON response per line on stdout.
//           Error messages go to stderr.
//
// Supported methods:
//   prove   { residual, threshold, blockHash, height }
//            → { ok, proof, vkHash, circuitId, provedAt }
//   verify  { proof, residual, threshold, blockHash }
//            → { ok, valid }
//   solve   { prevHash, merkleRoot, timestamp, difficulty, maxIter,
//              mempoolPressure, cumulativeWork }
//            → { ok, nonce, residual }
//   warmup  {}
//            → { ok, warmup: true }
//
// Build: cargo build --release --bin consensus-api
// Run:   ./target/release/consensus-api   (keep running, send requests line by line)

use std::io::{self, BufRead, Write};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use equilibrium_core::chain_state::{BlockHeader, ChainState};
use equilibrium_core::stationary_solver::StationarySolver;
use equilibrium_core::zk_proof::{StationarityProof, verify_raw_proof};

// ── Request / response shapes ─────────────────────────────────────────────────

#[derive(Deserialize)]
struct ProveRequest {
    residual:   f64,
    threshold:  f64,
    #[serde(rename = "blockHash")]
    block_hash: String,
    height:     u64,
}

#[derive(Deserialize)]
struct VerifyRequest {
    proof:     Value,        // opaque — we re-serialize and pass to verifier
    residual:  f64,
    threshold: f64,
    #[serde(rename = "blockHash")]
    block_hash: String,
}

#[derive(Deserialize)]
struct SolveRequest {
    #[serde(rename = "prevHash")]
    prev_hash:         String,
    #[serde(rename = "merkleRoot")]
    merkle_root:       String,
    timestamp:         u64,
    difficulty:        u64,
    #[serde(rename = "maxIter", default = "default_max_iter")]
    max_iter:          u64,
    #[serde(rename = "mempoolPressure", default)]
    mempool_pressure:  f64,
    #[serde(rename = "cumulativeWork", default)]
    cumulative_work:   u64,
}

fn default_max_iter() -> u64 { 10_000 }

#[derive(Serialize)]
#[serde(untagged)]
enum Response {
    Prove {
        ok: bool,
        proof: Value,
        #[serde(rename = "vkHash")]
        vk_hash: String,
        #[serde(rename = "circuitId")]
        circuit_id: String,
        #[serde(rename = "provedAt")]
        proved_at: u64,
    },
    Verify {
        ok: bool,
        valid: bool,
    },
    Solve {
        ok: bool,
        nonce: u64,
        residual: f64,
    },
    Warmup {
        ok: bool,
        warmup: bool,
    },
    Error {
        ok: bool,
        error: String,
    },
}

// ── Hex helpers ───────────────────────────────────────────────────────────────

fn hex_to_bytes32(s: &str) -> [u8; 32] {
    let clean = s.trim_start_matches("0x");
    let padded = format!("{clean:0>64}");
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&padded[i * 2..i * 2 + 2], 16).unwrap_or(0);
    }
    out
}

// ── Request handler ───────────────────────────────────────────────────────────

fn handle(line: &str) -> Response {
    let req: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return Response::Error { ok: false, error: format!("parse error: {e}") },
    };

    let method = req.get("method").and_then(Value::as_str).unwrap_or("");

    match method {
        "warmup" => {
            // Trigger proving-key initialisation (may take ~100 ms)
            let dummy_header = BlockHeader {
                prev_hash: [0u8; 32],
                merkle_root: [0u8; 32],
                timestamp: 0,
                nonce: 0,
                difficulty: 1,
                recursion_depth: 1,
                residual: 0.005,
            };
            let state = ChainState::default();
            let _ = StationarityProof::prove(&dummy_header, &[], &state, 0.01);
            Response::Warmup { ok: true, warmup: true }
        }

        "prove" => {
            let r: ProveRequest = match serde_json::from_value(req.clone()) {
                Ok(v) => v,
                Err(e) => return Response::Error { ok: false, error: e.to_string() },
            };

            let prev_hash = hex_to_bytes32(&r.block_hash);
            let header = BlockHeader {
                prev_hash,
                merkle_root: [0u8; 32],
                timestamp: 0,
                nonce: 0,
                difficulty: 1,
                recursion_depth: 1,
                residual: r.residual,
            };
            let state = ChainState { height: r.height, ..ChainState::default() };
            let sp = StationarityProof::prove(&header, &[], &state, r.threshold);

            let proof_json = serde_json::to_value(&sp.proof).unwrap_or(Value::Null);
            let vk_hash = hex::encode(sp.vk_hash);

            Response::Prove {
                ok: true,
                proof: proof_json,
                vk_hash,
                circuit_id: "stationarity-v2-groth16-bn254".into(),
                proved_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
            }
        }

        "verify" => {
            let r: VerifyRequest = match serde_json::from_value(req.clone()) {
                Ok(v) => v,
                Err(e) => return Response::Error { ok: false, error: e.to_string() },
            };

            let prev_hash = hex_to_bytes32(&r.block_hash);
            let header = BlockHeader {
                prev_hash,
                merkle_root: [0u8; 32],
                timestamp: 0,
                nonce: 0,
                difficulty: 1,
                recursion_depth: 1,
                residual: r.residual,
            };

            // Deserialize proof bytes from the JSON wire format
            let proof_bytes: equilibrium_core::zk_proof::Groth16ProofBytes =
                match serde_json::from_value(r.proof) {
                    Ok(p) => p,
                    Err(e) => return Response::Error { ok: false, error: format!("proof decode: {e}") },
                };

            let valid = verify_raw_proof(&proof_bytes, &header, r.threshold);
            Response::Verify { ok: true, valid }
        }

        "solve" => {
            let r: SolveRequest = match serde_json::from_value(req.clone()) {
                Ok(v) => v,
                Err(e) => return Response::Error { ok: false, error: e.to_string() },
            };

            let prev_hash  = hex_to_bytes32(&r.prev_hash);
            let merkle_root = hex_to_bytes32(&r.merkle_root);
            let header = BlockHeader {
                prev_hash,
                merkle_root,
                timestamp: r.timestamp,
                nonce: 0,
                difficulty: r.difficulty,
                recursion_depth: 3,
                residual: f64::INFINITY,
            };
            let state = ChainState {
                cumulative_work: r.cumulative_work,
                mempool_pressure: r.mempool_pressure,
                ..ChainState::default()
            };
            let solver = StationarySolver::new(r.max_iter, 1e-8, 0.01, 3);

            match solver.optimize_full(header, vec![], &state) {
                Some((solution, _)) => Response::Solve {
                    ok: true,
                    nonce: solution.nonce,
                    residual: solution.residual,
                },
                None => Response::Error {
                    ok: false,
                    error: "solver did not converge".into(),
                },
            }
        }

        other => Response::Error {
            ok: false,
            error: format!("unknown method: {other:?}"),
        },
    }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

fn main() {
    let stdin  = io::stdin();
    let stdout = io::stdout();
    let mut stdout = stdout.lock();

    eprintln!("[consensus-api] ready (stdin/stdout JSON-RPC)");

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) if l.trim().is_empty() => continue,
            Ok(l) => l,
            Err(e) => { eprintln!("[consensus-api] stdin error: {e}"); break; }
        };

        let response = handle(&line);
        let json = serde_json::to_string(&response)
            .unwrap_or_else(|_| r#"{"ok":false,"error":"serialization failed"}"#.into());
        if let Err(e) = writeln!(stdout, "{json}") {
            eprintln!("[consensus-api] stdout error: {e}");
            break;
        }
        stdout.flush().ok();
    }

    eprintln!("[consensus-api] exiting");
}
