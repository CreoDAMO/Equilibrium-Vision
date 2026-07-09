/// variational-ai-arbitrage-cli — DEX arbitrage detection binary
///
/// Reads a JSON snapshot of live DEX pool reserves from stdin, runs
/// Bellman-Ford negative-cycle detection over the currency graph, sizes
/// each profitable cycle via the variational stationary solver, and
/// writes the ranked list of opportunities to stdout.
///
/// Used by the TypeScript bridge (artifacts/api-server/src/variational-ai/bridge.ts)
/// to power `GET /api/arbitrage/opportunities` without embedding Rust in Node.
///
/// Input JSON schema:
/// ```json
/// {
///   "pools": [
///     { "pool_id": "equ-wbtc", "token_a": "EQU", "token_b": "WBTC",
///       "reserve_a": 10000.0, "reserve_b": 1000.0, "fee": 0.003 },
///     ...
///   ],
///   "lambda": 1e-6,            // optional, L2 trade-size regularisation (default 1e-6)
///   "max_opportunities": 5     // optional, cap on cycles returned (default 5)
/// }
/// ```
///
/// Output JSON:
/// ```json
/// {
///   "opportunities": [
///     { "tokens": ["EQU","WBTC","USDC","EQU"], "poolIds": [...], "hopCount": 3,
///       "rates": [...], "profitFactor": 0.012, "optimalAmountIn": 42.1,
///       "expectedProfit": 0.51 }
///   ],
///   "count": 1
/// }
/// ```
///
/// Exit code: 0 = success (even with zero opportunities), 2 = error (bad input).

use std::io::{self, BufRead, Read, Write};
use serde::{Deserialize, Serialize};

use variational_ai::arbitrage::{
    ArbitrageAction, CurrencyGraph, PoolSnapshot, compute_trade_signal,
};
use variational_ai::solver::StationarySolver;

#[derive(Deserialize)]
struct PoolInput {
    pool_id:   String,
    token_a:   String,
    token_b:   String,
    reserve_a: f64,
    reserve_b: f64,
    fee:       f64,
}

#[derive(Deserialize)]
struct Request {
    pools: Vec<PoolInput>,
    #[serde(default = "default_lambda")]
    lambda: f64,
    #[serde(default = "default_max_opportunities")]
    max_opportunities: usize,
}

fn default_lambda() -> f64 { 1e-6 }
fn default_max_opportunities() -> usize { 5 }

#[derive(Serialize)]
struct Opportunity {
    tokens:          Vec<String>,
    #[serde(rename = "poolIds")]
    pool_ids:        Vec<String>,
    #[serde(rename = "hopCount")]
    hop_count:       usize,
    rates:           Vec<f64>,
    #[serde(rename = "profitFactor")]
    profit_factor:   f64,
    #[serde(rename = "optimalAmountIn")]
    optimal_amount_in: f64,
    #[serde(rename = "expectedProfit")]
    expected_profit: f64,
}

#[derive(Serialize)]
struct Response {
    opportunities: Vec<Opportunity>,
    count:         usize,
}

fn process(input: &str) -> Result<Response, String> {
    let req: Request = serde_json::from_str(input)
        .map_err(|e| serde_json::json!({ "error": format!("JSON parse error: {}", e) }).to_string())?;

    if req.pools.is_empty() {
        return Ok(Response { opportunities: vec![], count: 0 });
    }

    let mut working_pools: Vec<PoolSnapshot> = req.pools.iter().map(|p| PoolSnapshot {
        pool_id:   p.pool_id.clone(),
        token_a:   p.token_a.clone(),
        token_b:   p.token_b.clone(),
        reserve_a: p.reserve_a,
        reserve_b: p.reserve_b,
        fee:       p.fee,
    }).collect();

    let solver = StationarySolver::new(1e-6, 50);
    let mut opportunities: Vec<Opportunity> = Vec::new();

    // Iteratively find the best remaining cycle, size it, then drop one of its
    // pools so the next pass surfaces a *different* opportunity rather than
    // repeatedly rediscovering the same cycle.
    while opportunities.len() < req.max_opportunities {
        let graph = CurrencyGraph::from_pools(&working_pools);
        let path = match graph.find_arbitrage_path() {
            Some(p) => p,
            None => break,
        };

        let first_pool_id = path.pool_ids[0].clone();

        if let Some(action) = ArbitrageAction::new(path.clone(), &working_pools, req.lambda) {
            let opt = solver.solve_newton_cg(&action, &vec![1.0]);
            let signal = compute_trade_signal(&path, &action.pools, &opt);

            if signal.expected_profit > 0.0 {
                opportunities.push(Opportunity {
                    tokens:            path.tokens.clone(),
                    pool_ids:          path.pool_ids.clone(),
                    hop_count:         path.hop_count(),
                    rates:             path.rates.clone(),
                    profit_factor:     path.profit_factor,
                    optimal_amount_in: signal.amount_in,
                    expected_profit:   signal.expected_profit,
                });
            }
        }

        let before = working_pools.len();
        working_pools.retain(|p| p.pool_id != first_pool_id);
        if working_pools.len() == before {
            break;
        }
    }

    let count = opportunities.len();
    Ok(Response { opportunities, count })
}

/// Daemon mode: persistent line-by-line JSON processing.
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
            Ok(resp) => serde_json::to_string(&resp).expect("serialise"),
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

    if args.iter().any(|a| a == "--daemon") {
        run_daemon();
        return;
    }

    // One-shot legacy mode.
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).expect("failed to read stdin");

    match process(&input) {
        Ok(response) => {
            let out = serde_json::to_string(&response).expect("JSON serialisation failed");
            io::stdout().write_all(out.as_bytes()).expect("write failed");
            io::stdout().write_all(b"\n").expect("write failed");
        }
        Err(err_json) => {
            println!("{}", err_json);
            std::process::exit(2);
        }
    }
}
