---
name: variational-ai crate
description: Build decisions, gotchas, and conventions for the variational-ai Rust crate
---

## Key build decisions

- **No `mnist` or `image` crates**: Replit has no MNIST data files. `mnist.rs` generates synthetic data (Gaussian blobs, seeded ChaCha8). Main binary tries real IDX files in `data/` first, falls back to synthetic.
- **`hex = "0.4"` needed**: harness binary uses `hex::encode()`; not in original spec Cargo.toml.
- **`serde`/`serde_json`/`sha2` added**: needed by CLI binary and harness.

## Math correctness rules

**NTK objective must be internally consistent.** The fixed formulation:
- `evaluate`: `½‖Kα−y‖² + (λ/2)αᵀKα`  (no /N in loss)
- `gradient`: `K(Kα−y) + λKα = K[(K+λI)α−y]`
- `hessian_vec_prod`: `K²v + λKv`
- `solve_ntk`: solves `(K+λI)α = y`

Stationarity of this objective → `(K+λI)α = y`, so residual at solution = machine epsilon.

**Why:** Original spec had `(Kα−y)/N + λKα` as gradient (missing the leading `K`). This made gradient inconsistent with both evaluate AND with solve_ntk's system, so residual was never near-zero at the exact solution — breaking the on-chain verification claim.

## Solver safety

L-BFGS two-loop recursion can produce non-descent direction when curvature history is ill-conditioned. Added guard in `solver.rs`: if `g·p ≥ 0` after two-loop, fall back to steepest descent before Armijo line search.

## CLI protocol contract

- Exit 0 = valid residual claim
- Exit 1 = invalid residual claim (parse stdout JSON for details)
- Exit 2 = unrecoverable input error (bad JSON, dimension mismatch)

Error JSON is always written to **stdout** (not stderr), so the bridge can parse it in all branches.

## Determinism

- `.cargo/config.toml` pins `target-cpu=generic -C target-feature=-fma`
- Harness SHA-256 hashes are stable across runs (verified two-run diff = identical)
- Fixed-point scale: `FIXED_SCALE = 1_000_000_000_000` (1e12)

## Binary location

Release binary is copied to `artifacts/api-server/variational-ai-cli` for the TypeScript bridge at `artifacts/api-server/src/variational-ai/bridge.ts`.

## Solver type bounds

`StationarySolver` and `LbfgsSolver` require `A: Action<Parameter = Vec<f64>>`. `NtkAction` uses `Parameter = DVector<f64>` so generic solvers cannot be used with it — use `solve_ntk()` directly.

## Arbitrage module (Gap 3 from spec)

`arbitrage.rs` implements `CurrencyGraph` (Bellman-Ford negative-cycle detection over -log(rate) edges), `ArbitrageAction` (single-parameter trade-size `Action` impl: S(x) = -(chain_out(x)-x) + λx²), and `compute_trade_signal`. It must be declared in `lib.rs`'s module list — it was written but left unwired once before, which silently excluded its `#[cfg(test)]` tests from `cargo test`.

**Still outstanding from the full spec Gap-3 deliverable** (not yet built): governance safety rails (max_arbitrage_size param, per-block rate limit, negative-P&L circuit breaker) and the atomic multi-hop WASM contract execution path. Only the Rust action/graph math is done.
