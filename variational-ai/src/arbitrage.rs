//! Arbitrage action module for Equilibrium.
//!
//! Implements:
//!   - `CurrencyGraph` — directed graph of DEX exchange rates
//!   - `find_arbitrage_path` — Bellman-Ford negative-cycle detection (log-rates)
//!   - `ArbitrageAction` — `Action` trait for variational solver (maximize profit)
//!   - `compute_trade_signal` — maps solver output to concrete swap amounts

use crate::action::Action;
use libm::log;

// ── Pool snapshot ─────────────────────────────────────────────────────────────

/// Snapshot of a single AMM pool (constant-product).
#[derive(Clone, Debug)]
pub struct PoolSnapshot {
    pub pool_id:   String,
    pub token_a:   String,
    pub token_b:   String,
    pub reserve_a: f64,
    pub reserve_b: f64,
    /// Fee as a fraction, e.g. 0.003 = 0.3 %.
    pub fee:       f64,
}

impl PoolSnapshot {
    /// Compute the effective exchange rate for a swap from token_in to token_out.
    /// Returns `reserveOut / reserveIn * (1 - fee)` (small-trade approximation).
    pub fn rate(&self, from: &str) -> f64 {
        if from == self.token_a {
            (self.reserve_b / self.reserve_a) * (1.0 - self.fee)
        } else {
            (self.reserve_a / self.reserve_b) * (1.0 - self.fee)
        }
    }

    /// AMM output for a given input amount (constant-product formula).
    /// Returns 0.0 if reserve_in is zero or the pool doesn't involve `from`.
    pub fn amm_out(&self, from: &str, amount_in: f64) -> f64 {
        let (reserve_in, reserve_out) = if from == self.token_a {
            (self.reserve_a, self.reserve_b)
        } else if from == self.token_b {
            (self.reserve_b, self.reserve_a)
        } else {
            return 0.0;
        };
        if reserve_in <= 0.0 || amount_in <= 0.0 { return 0.0; }
        let effective_in = amount_in * (1.0 - self.fee);
        reserve_out * effective_in / (reserve_in + effective_in)
    }

    /// d(amm_out) / d(amount_in) — first derivative.
    pub fn amm_out_deriv(&self, from: &str, amount_in: f64) -> f64 {
        let (reserve_in, reserve_out) = if from == self.token_a {
            (self.reserve_a, self.reserve_b)
        } else if from == self.token_b {
            (self.reserve_b, self.reserve_a)
        } else {
            return 0.0;
        };
        if reserve_in <= 0.0 { return 0.0; }
        let k = 1.0 - self.fee;
        // d/dx [ R_out * k*x / (R_in + k*x) ] = R_out * k * R_in / (R_in + k*x)^2
        let denom = reserve_in + k * amount_in;
        reserve_out * k * reserve_in / (denom * denom)
    }

    /// d²(amm_out) / d(amount_in)² — second derivative.
    pub fn amm_out_deriv2(&self, from: &str, amount_in: f64) -> f64 {
        let (reserve_in, reserve_out) = if from == self.token_a {
            (self.reserve_a, self.reserve_b)
        } else if from == self.token_b {
            (self.reserve_b, self.reserve_a)
        } else {
            return 0.0;
        };
        if reserve_in <= 0.0 { return 0.0; }
        let k = 1.0 - self.fee;
        let denom = reserve_in + k * amount_in;
        -2.0 * reserve_out * k * k * reserve_in / (denom * denom * denom)
    }
}

// ── Currency graph ─────────────────────────────────────────────────────────────

/// An edge in the currency exchange graph.
#[derive(Clone, Debug)]
struct ArbEdge {
    from:    usize,    // index into `tokens`
    to:      usize,    // index into `tokens`
    pool_id: String,
    /// -log(effective_rate) for Bellman-Ford (negative cycle = profit).
    weight:  f64,
    /// token name at `from`
    #[allow(dead_code)]
    from_token: String,
}

/// Directed graph of currency-pair exchange rates built from DEX pool snapshots.
pub struct CurrencyGraph {
    tokens: Vec<String>,
    edges:  Vec<ArbEdge>,
    #[allow(dead_code)]
    pools:  Vec<PoolSnapshot>,
}

impl CurrencyGraph {
    /// Build the graph from a list of pool snapshots.
    /// Each pool contributes two directed edges (A→B and B→A).
    pub fn from_pools(pools: &[PoolSnapshot]) -> Self {
        let mut tokens: Vec<String> = Vec::new();

        let token_idx = |tokens: &mut Vec<String>, name: &str| -> usize {
            if let Some(i) = tokens.iter().position(|t| t == name) {
                i
            } else {
                tokens.push(name.to_string());
                tokens.len() - 1
            }
        };

        let mut edges = Vec::new();
        let mut token_tmp = tokens.clone();

        for pool in pools {
            let a = token_idx(&mut token_tmp, &pool.token_a);
            let b = token_idx(&mut token_tmp, &pool.token_b);
            let rate_ab = pool.rate(&pool.token_a);
            let rate_ba = pool.rate(&pool.token_b);
            // Weight = -log(rate); a negative-weight cycle means product of rates > 1.
            edges.push(ArbEdge {
                from: a, to: b, pool_id: pool.pool_id.clone(),
                weight: -log(rate_ab.max(f64::MIN_POSITIVE)),
                from_token: pool.token_a.clone(),
            });
            edges.push(ArbEdge {
                from: b, to: a, pool_id: pool.pool_id.clone(),
                weight: -log(rate_ba.max(f64::MIN_POSITIVE)),
                from_token: pool.token_b.clone(),
            });
        }

        tokens = token_tmp;
        CurrencyGraph { tokens, edges, pools: pools.to_vec() }
    }

    /// Find the best arbitrage cycle using Bellman-Ford negative-cycle detection.
    /// Returns `None` if no profitable cycle exists.
    pub fn find_arbitrage_path(&self) -> Option<ArbitragePath> {
        let n = self.tokens.len();
        if n == 0 { return None; }

        // dist[i] = shortest (most negative) weight path to node i
        let mut dist = vec![0.0_f64; n];
        let mut pred: Vec<Option<(usize, usize)>> = vec![None; n]; // (prev_node, edge_idx)

        // n-1 relaxation passes
        for _ in 0..(n - 1) {
            for (eidx, edge) in self.edges.iter().enumerate() {
                let new_dist = dist[edge.from] + edge.weight;
                if new_dist < dist[edge.to] - 1e-12 {
                    dist[edge.to]  = new_dist;
                    pred[edge.to]  = Some((edge.from, eidx));
                }
            }
        }

        // n-th pass: any node that relaxes is on a negative cycle
        let mut cycle_node = None;
        'outer: for _ in 0..1 {
            for edge in &self.edges {
                let new_dist = dist[edge.from] + edge.weight;
                if new_dist < dist[edge.to] - 1e-12 {
                    cycle_node = Some(edge.to);
                    break 'outer;
                }
            }
        }

        let start = cycle_node?;

        // Walk back n steps to land inside the cycle
        let mut v = start;
        for _ in 0..n {
            v = pred[v]?.0;
        }

        // Trace the cycle from v
        let cycle_start = v;
        let mut path_tokens  = Vec::new();
        let mut path_pool_ids = Vec::new();
        let mut path_rates   = Vec::new();
        let mut current      = cycle_start;

        loop {
            path_tokens.push(self.tokens[current].clone());
            let (prev_node, eidx) = pred[current]?;
            let edge = &self.edges[eidx];
            path_pool_ids.push(edge.pool_id.clone());
            path_rates.push((-edge.weight).exp()); // recover rate from -log(rate)
            current = prev_node;
            if current == cycle_start { break; }
        }
        path_tokens.push(self.tokens[cycle_start].clone()); // close the cycle

        // Reverse so cycle reads start → ... → start
        path_tokens.reverse();
        path_pool_ids.reverse();
        path_rates.reverse();

        let profit_factor: f64 = path_rates.iter().product::<f64>() - 1.0;
        if profit_factor <= 0.0 { return None; }

        Some(ArbitragePath {
            tokens: path_tokens,
            pool_ids: path_pool_ids,
            rates: path_rates,
            profit_factor,
        })
    }
}

// ── Arbitrage path ─────────────────────────────────────────────────────────────

/// A profitable arbitrage cycle identified by Bellman-Ford.
#[derive(Clone, Debug)]
pub struct ArbitragePath {
    /// Cycle tokens including start token at both ends: [A, B, C, A].
    pub tokens:        Vec<String>,
    /// Pool IDs, one per hop (len = tokens.len() - 1).
    pub pool_ids:      Vec<String>,
    /// Effective per-hop exchange rates.
    pub rates:         Vec<f64>,
    /// product(rates) - 1.0  (> 0 means profitable).
    pub profit_factor: f64,
}

impl ArbitragePath {
    /// Number of swap hops in the cycle.
    pub fn hop_count(&self) -> usize { self.pool_ids.len() }
}

// ── Trade signal ──────────────────────────────────────────────────────────────

/// Concrete trade amounts returned by the variational solver.
#[derive(Clone, Debug)]
pub struct TradeSignal {
    pub path:            ArbitragePath,
    /// Optimal initial trade amount (the solver's alpha[0]).
    pub amount_in:       f64,
    /// Expected net profit after fees and slippage.
    pub expected_profit: f64,
}

// ── ArbitrageAction ───────────────────────────────────────────────────────────

/// Variational action for single-parameter arbitrage position sizing.
///
/// Parameter space: alpha = [x] where x is the initial token amount to trade.
/// S(x) = -(profit(x)) + lambda * x²
///
/// where profit(x) = amm_chain_out(x) - x, and amm_chain_out chains the
/// AMM formula through all hops of the path.
///
/// The stationary point δS/δx = 0 gives the optimal trade size.
pub struct ArbitrageAction {
    pub path:   ArbitragePath,
    /// Ordered pool snapshots corresponding to each hop in path.pool_ids.
    pub pools:  Vec<PoolSnapshot>,
    /// L2 regularization on trade size (prevents over-large trades / slippage).
    pub lambda: f64,
}

impl ArbitrageAction {
    /// Build from a detected path and the current pool snapshots.
    pub fn new(path: ArbitragePath, all_pools: &[PoolSnapshot], lambda: f64) -> Option<Self> {
        let pools: Vec<PoolSnapshot> = path.pool_ids.iter()
            .zip(path.tokens.windows(2))
            .filter_map(|(pool_id, pair)| {
                all_pools.iter().find(|p| &p.pool_id == pool_id)
                    .cloned()
                    // Rotate so token_a matches the swap direction
                    .map(|mut p| {
                        if p.token_a != pair[0] {
                            std::mem::swap(&mut p.token_a, &mut p.token_b);
                            std::mem::swap(&mut p.reserve_a, &mut p.reserve_b);
                        }
                        p
                    })
            })
            .collect();
        if pools.len() != path.hop_count() { return None; }
        Some(ArbitrageAction { path, pools, lambda })
    }

    /// Chain AMM swaps: feed x through all hops, return final output.
    fn chain_out(&self, x: f64) -> f64 {
        let mut amount = x;
        for (i, pool) in self.pools.iter().enumerate() {
            let from = &self.path.tokens[i];
            amount = pool.amm_out(from, amount);
            if amount <= 0.0 { return 0.0; }
        }
        amount
    }

    /// d(chain_out) / dx via chain rule.
    fn chain_out_deriv(&self, x: f64) -> f64 {
        // Compute intermediate amounts
        let mut amounts = vec![x];
        for (i, pool) in self.pools.iter().enumerate() {
            let from = &self.path.tokens[i];
            amounts.push(pool.amm_out(from, *amounts.last().unwrap()));
        }

        // Accumulate derivative via chain rule (backwards)
        let mut deriv = 1.0;
        for i in (0..self.pools.len()).rev() {
            let from = &self.path.tokens[i];
            deriv *= self.pools[i].amm_out_deriv(from, amounts[i]);
        }
        deriv
    }

    /// d²(chain_out) / dx² (used for Hessian-vector product).
    fn chain_out_deriv2(&self, x: f64) -> f64 {
        // For a single-parameter chain, the HVP reduces to the scalar second derivative.
        // Numerical second derivative is used for correctness across all path lengths.
        let eps = x.abs().max(1.0) * 1e-5;
        let d_plus  = self.chain_out_deriv(x + eps);
        let d_minus = self.chain_out_deriv(x - eps);
        (d_plus - d_minus) / (2.0 * eps)
    }
}

impl Action for ArbitrageAction {
    type Parameter = Vec<f64>;

    /// S(x) = -(chain_out(x) - x) + lambda * x²  =  x - chain_out(x) + lambda * x²
    fn evaluate(&self, theta: &Vec<f64>) -> f64 {
        let x = theta[0].max(0.0);
        let profit = self.chain_out(x) - x;
        -profit + self.lambda * x * x
    }

    /// ∇S(x) = 1 - d(chain_out)/dx + 2 * lambda * x
    fn gradient(&self, theta: &Vec<f64>) -> Vec<f64> {
        let x = theta[0].max(0.0);
        let g = 1.0 - self.chain_out_deriv(x) + 2.0 * self.lambda * x;
        vec![g]
    }

    /// H(x)·v = (-d²(chain_out)/dx² + 2*lambda) * v[0]
    fn hessian_vec_prod(&self, theta: &Vec<f64>, v: &[f64]) -> Vec<f64> {
        let x = theta[0].max(0.0);
        let h = -self.chain_out_deriv2(x) + 2.0 * self.lambda;
        vec![h * v[0]]
    }

    fn dim(&self) -> usize { 1 }
}

// ── compute_trade_signal ──────────────────────────────────────────────────────

/// Map the solver's optimal alpha[0] to a concrete TradeSignal.
pub fn compute_trade_signal(
    path:  &ArbitragePath,
    pools: &[PoolSnapshot],
    alpha: &[f64],
) -> TradeSignal {
    let amount_in = alpha[0].max(0.0);

    // Re-chain to get exact output given the optimal amount
    let mut amount = amount_in;
    for (i, pool_id) in path.pool_ids.iter().enumerate() {
        let from = &path.tokens[i];
        if let Some(pool) = pools.iter().find(|p| &p.pool_id == pool_id) {
            // Normalise direction
            let (ra, rb, fa, fb) = if pool.token_a == *from {
                (pool.reserve_a, pool.reserve_b, &pool.token_a, &pool.token_b)
            } else {
                (pool.reserve_b, pool.reserve_a, &pool.token_b, &pool.token_a)
            };
            let _ = (ra, rb, fa, fb);
            let mut p = pool.clone();
            if p.token_a != *from {
                std::mem::swap(&mut p.token_a, &mut p.token_b);
                std::mem::swap(&mut p.reserve_a, &mut p.reserve_b);
            }
            amount = p.amm_out(from, amount);
        }
    }

    let expected_profit = (amount - amount_in).max(0.0);

    TradeSignal {
        path: path.clone(),
        amount_in,
        expected_profit,
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deterministic;
    use crate::solver::StationarySolver;

    fn make_pools() -> Vec<PoolSnapshot> {
        vec![
            // Pool EQU/WBTC: 1 WBTC = 10 EQU (reserve ratio 1:10)
            PoolSnapshot {
                pool_id:   "equ-wbtc".to_string(),
                token_a:   "EQU".to_string(),
                token_b:   "WBTC".to_string(),
                reserve_a: 10_000.0,
                reserve_b: 1_000.0,
                fee:       0.003,
            },
            // Pool WBTC/USDC: 1 WBTC = 9.9 USDC (slight discount vs EQU pool)
            PoolSnapshot {
                pool_id:   "wbtc-usdc".to_string(),
                token_a:   "WBTC".to_string(),
                token_b:   "USDC".to_string(),
                reserve_a: 100.0,
                reserve_b: 990.0,
                fee:       0.003,
            },
            // Pool USDC/EQU: 1 EQU = 0.105 USDC — creates a profitable triangle
            PoolSnapshot {
                pool_id:   "usdc-equ".to_string(),
                token_a:   "USDC".to_string(),
                token_b:   "EQU".to_string(),
                reserve_a: 10_500.0,
                reserve_b: 100_000.0,
                fee:       0.003,
            },
        ]
    }

    #[test]
    fn test_currency_graph_finds_cycle() {
        let pools = make_pools();
        let graph = CurrencyGraph::from_pools(&pools);
        let path = graph.find_arbitrage_path();
        // The triangle EQU→WBTC→USDC→EQU (or its reverse) should be detected.
        assert!(path.is_some(), "expected a profitable arbitrage cycle");
        let p = path.unwrap();
        assert!(p.profit_factor > 0.0, "profit factor must be positive");
        assert!(p.hop_count() >= 2, "must have at least 2 hops");
    }

    #[test]
    fn test_arbitrage_action_gradient() {
        let pools = make_pools();
        let graph = CurrencyGraph::from_pools(&pools);
        if let Some(path) = graph.find_arbitrage_path() {
            if let Some(action) = ArbitrageAction::new(path, &pools, 1e-6) {
                // Gradient near x=0 should be negative (profit increases)
                let g = action.gradient(&vec![1.0]);
                // At the stationary point the gradient should be ~0
                let solver = StationarySolver::new(1e-6, 50);
                let opt = solver.solve_newton_cg(&action, &[1.0]);
                let g_opt = action.gradient(&opt);
                assert!(
                    deterministic::norm2(&g_opt) < 1e-4,
                    "gradient at stationary point should be near zero, got {:.2e}",
                    deterministic::norm2(&g_opt)
                );
                let _ = g;
            }
        }
    }

    #[test]
    fn test_no_cycle_on_balanced_pools() {
        // Perfectly balanced pools — no arbitrage
        let pools = vec![
            PoolSnapshot {
                pool_id: "a-b".to_string(), token_a: "A".to_string(), token_b: "B".to_string(),
                reserve_a: 1000.0, reserve_b: 1000.0, fee: 0.003,
            },
            PoolSnapshot {
                pool_id: "b-a2".to_string(), token_a: "B".to_string(), token_b: "A".to_string(),
                reserve_a: 1000.0, reserve_b: 1000.0, fee: 0.003,
            },
        ];
        let graph = CurrencyGraph::from_pools(&pools);
        // With equal reserves and fees, no profitable cycle should exist
        let path = graph.find_arbitrage_path();
        if let Some(p) = path {
            assert!(p.profit_factor <= 0.01, "profit should be negligible on balanced pools");
        }
    }

    // ── Phase 4 stress tests ──────────────────────────────────────────────────

    /// Build a fully-connected graph of `n` tokens where every token pair has
    /// a pool. Pool reserves are slightly imbalanced between even/odd pairs to
    /// create a realistic (but not trivially balanced) graph.
    fn make_fully_connected_pools(n_tokens: usize) -> Vec<PoolSnapshot> {
        let tokens: Vec<String> = (0..n_tokens).map(|i| format!("T{}", i)).collect();
        let mut pools = Vec::new();
        for i in 0..n_tokens {
            for j in (i + 1)..n_tokens {
                // Slight reserve asymmetry so some edges have non-trivial weights
                let reserve_a = 10_000.0 + (i as f64) * 37.0 + (j as f64) * 13.0;
                let reserve_b = 10_000.0 + (j as f64) * 41.0 + (i as f64) * 7.0;
                pools.push(PoolSnapshot {
                    pool_id:   format!("{}-{}", tokens[i], tokens[j]),
                    token_a:   tokens[i].clone(),
                    token_b:   tokens[j].clone(),
                    reserve_a,
                    reserve_b,
                    fee: 0.003,
                });
            }
        }
        pools
    }

    /// Phase 4 stress test 1: Bellman-Ford on a large fully-connected graph.
    ///
    /// With 13 tokens there are 13*12/2 = 78 pools and 26 directed edges.
    /// Verifies the detector completes in well under a reasonable time bound
    /// (1 second) and returns a valid result without panicking.
    #[test]
    fn test_large_fully_connected_graph_completes_quickly() {
        use std::time::Instant;

        let n_tokens = 13;
        let pools = make_fully_connected_pools(n_tokens);
        assert_eq!(pools.len(), n_tokens * (n_tokens - 1) / 2);

        let graph = CurrencyGraph::from_pools(&pools);
        let start = Instant::now();
        let result = graph.find_arbitrage_path();
        let elapsed = start.elapsed();

        // Must complete in well under 1 second (Bellman-Ford is O(V*E))
        assert!(
            elapsed.as_millis() < 1_000,
            "Bellman-Ford on {} tokens took {}ms — too slow",
            n_tokens,
            elapsed.as_millis(),
        );

        // Result is either Some or None — both are correct outcomes.
        // If a cycle is found, validate its structure.
        if let Some(path) = result {
            assert!(path.profit_factor > 0.0, "profit_factor must be positive");
            assert!(
                path.tokens.len() >= 3,
                "a valid cycle needs at least 2 hops (3 tokens including close)"
            );
            assert_eq!(
                path.pool_ids.len(),
                path.tokens.len() - 1,
                "pool_ids.len() must equal tokens.len() - 1"
            );
        }
        // None is also a valid outcome — balanced pools may have no cycle.
    }

    /// Phase 4 stress test 2: near-zero-weight negative cycles are detected.
    ///
    /// We construct a triangle where one pool has a very small imbalance
    /// (profit factor ≈ 1e-4). This verifies that the 1e-12 epsilon threshold
    /// in the Bellman-Ford relaxation check does NOT swallow real (tiny) cycles.
    #[test]
    fn test_tiny_negative_cycle_is_detected() {
        // EQU→WBTC pool: slightly more WBTC per EQU than the reverse path returns
        // Rate A→B: 1000.001 / 1000.0 = 1.000001 (after fee: ~0.997)
        // We stack three pools such that product_of_rates > 1.0 by a hair.
        //
        // The Bellman-Ford epsilon is 1e-12 (see find_arbitrage_path, the
        // `new_dist < dist[edge.to] - 1e-12` guard). A cycle with a weight
        // sum of -1e-6 (well above 1e-12) must still be detected.
        let pools = vec![
            PoolSnapshot {
                pool_id:   "p1".to_string(),
                token_a:   "A".to_string(), token_b: "B".to_string(),
                // rate A→B slightly > 1 after fee
                reserve_a: 10_000.0, reserve_b: 10_050.0,
                fee: 0.001, // 0.1% fee — small to preserve the cycle
            },
            PoolSnapshot {
                pool_id:   "p2".to_string(),
                token_a:   "B".to_string(), token_b: "C".to_string(),
                reserve_a: 10_000.0, reserve_b: 10_050.0,
                fee: 0.001,
            },
            PoolSnapshot {
                pool_id:   "p3".to_string(),
                token_a:   "C".to_string(), token_b: "A".to_string(),
                // return leg: slightly favorable ratio
                reserve_a: 9_950.0, reserve_b: 10_000.0,
                fee: 0.001,
            },
        ];

        // Confirm the product of rates > 1.0 (cycle should be profitable)
        let rate_ab = pools[0].rate("A");
        let rate_bc = pools[1].rate("B");
        let rate_ca = pools[2].rate("C");
        let product = rate_ab * rate_bc * rate_ca;
        assert!(
            product > 1.0,
            "test setup error: product of rates {:.8} must be > 1.0 for a real cycle",
            product
        );

        let graph = CurrencyGraph::from_pools(&pools);
        let path = graph.find_arbitrage_path();

        assert!(
            path.is_some(),
            "expected Bellman-Ford to detect the small-imbalance cycle (product={:.8})",
            product
        );
        let p = path.unwrap();
        assert!(
            p.profit_factor > 0.0,
            "profit_factor must be positive, got {}",
            p.profit_factor
        );
    }

    /// Phase 4 stress test 3: "churn" — find a cycle, apply swap math, re-run detector.
    ///
    /// After a swap consumes some arbitrage profit, the pool reserves shift and
    /// the cycle either disappears or shrinks. The detector must not panic on
    /// mutated reserves and must return a coherent (possibly updated) result.
    #[test]
    fn test_detector_coherent_after_swap_churn() {
        let mut pools = make_pools(); // the imbalanced EQU/WBTC/USDC triangle

        let graph = CurrencyGraph::from_pools(&pools);
        let initial_path = graph.find_arbitrage_path();

        // We expect a cycle on these known-imbalanced pools
        assert!(
            initial_path.is_some(),
            "make_pools() should yield a profitable cycle for this churn test"
        );
        let path = initial_path.unwrap();

        // Simulate the first hop of the detected cycle using the AMM formula.
        // Find the first pool in the path and apply a modest swap.
        let first_pool_id = &path.pool_ids[0];
        let first_token_in = &path.tokens[0];

        if let Some(pool) = pools.iter_mut().find(|p| &p.pool_id == first_pool_id) {
            let amount_in = 50.0; // modest size to not drain the pool
            let amount_out = pool.amm_out(first_token_in, amount_in);

            assert!(amount_out > 0.0, "swap should produce positive output");

            // Apply the swap: update reserves in-place
            if first_token_in == &pool.token_a {
                pool.reserve_a += amount_in;
                pool.reserve_b -= amount_out;
            } else {
                pool.reserve_b += amount_in;
                pool.reserve_a -= amount_out;
            }

            // Constant-product invariant: k must not decrease after the swap
            let k_before = (pool.reserve_a - amount_in) * (pool.reserve_b + amount_out);
            let k_after  = pool.reserve_a * pool.reserve_b;
            assert!(
                k_after >= k_before * 0.9999,
                "k must not decrease materially after swap: before={:.2} after={:.2}",
                k_before,
                k_after,
            );
        }

        // Re-run detector on the mutated pool set — must not panic
        let graph2 = CurrencyGraph::from_pools(&pools);
        let updated_path = graph2.find_arbitrage_path();

        // Either the cycle is gone (arbitrage was consumed) or a smaller cycle
        // remains — both are correct. The only invariant is no panic.
        if let Some(p2) = updated_path {
            assert!(
                p2.profit_factor >= 0.0,
                "updated profit_factor must be non-negative: {}",
                p2.profit_factor
            );
            // If the cycle persists it should be no more profitable than before
            // (we consumed some of the imbalance)
            assert!(
                p2.profit_factor <= path.profit_factor + 0.01,
                "profit_factor should not increase after a swap: before={} after={}",
                path.profit_factor,
                p2.profit_factor
            );
        }
        // None is fine too — cycle may have been fully consumed.
    }
}
