# Equilibrium Miner Incentive Model

## Overview

Equilibrium rewards miners through a **quality-adjusted coinbase reward**.
Unlike Proof-of-Work (where any valid hash earns the same reward), PoS rewards
miners proportionally to *how close to true stationarity* their submitted block
is.  This creates a direct economic incentive to minimize the Lagrangian
residual, aligning miner behaviour with network health.

---

## Reward Formula

```
block_reward = base_reward × halving_factor(height) × quality_multiplier(residual)
```

### Halving Factor

```
halving_factor(h) = 1 / 2^floor(h / HALVING_INTERVAL)
```

Where `HALVING_INTERVAL = 210 000` blocks (≈ 4 years at 15 s/block).

### Quality Multiplier

```
quality_multiplier(actual_residual) =
    min(1.0,  target_residual / (actual_residual + ε))
```

Where:
- `target_residual` = current network threshold (default `1e-8`)
- `ε = 1e-9` (prevents division by zero)
- Result is clamped to `[0, 1]`

---

## Incentive Compatibility Proof

**Claim:** An honest miner who minimises `actual_residual` maximises their
expected reward per unit of compute.

**Proof sketch:**

Let `c(r)` = compute cost to achieve residual `r` (increasing as `r` decreases
toward 0).  Let `Q(r) = min(1, T / (r + ε))` be the quality multiplier.

A rational miner chooses `r*` to maximise:

```
Π(r) = base_reward × Q(r) − c(r)
```

Taking the derivative and setting to zero:

```
dΠ/dr = base_reward × dQ/dr − c'(r) = 0
```

Since `dQ/dr = −T / (r + ε)²` for `r > T − ε`:

```
c'(r*) = base_reward × T / (r* + ε)²
```

This has a unique interior minimum (assuming `c` is convex) because:
1. `Q(r)` is strictly decreasing — submitting a *worse* block (higher `r`) always reduces reward.
2. The marginal reward for quality improvement `|dQ/dr|` is largest near `r = T`, providing the
   strongest incentive exactly where extra compute effort is most impactful.

### Gaming Strategies & Mitigations

| Strategy | Effect | Mitigation |
|---|---|---|
| Submit block with `r` slightly above `T` | `Q ≈ T/r < 1`, reduced reward | No benefit; honest miner earns more |
| Submit artificially high `r` to reduce competition | Earns near-zero reward | Self-defeating |
| Collude to suppress low-`r` blocks | Would require >50% of mining power; fork-choice picks lowest cumulative `r` | Fork-choice rule |
| Manipulate `ε` | `ε` is a protocol constant, not miner-controlled | Hardcoded in circuit |

**Conclusion:** The quality multiplier is incentive-compatible.  The only
strategy that maximises expected reward is honest minimisation of the residual.

---

## Fork Choice Rule

When two competing chains exist, nodes prefer the chain with the **lower
cumulative residual**:

```
choose_fork(chains) = argmin_chain Σ block.residual
```

This means a miner who submits low-quality blocks also loses the fork race,
double-penalising dishonest behaviour.

---

## Worked Example

| Scenario | Residual | Quality | Reward (base = 50 M, T = 1e-8) |
|---|---|---|---|
| Perfect stationarity | 0.0 | 1.000 | 50 000 000 |
| 10× above threshold | 1e-7 | 0.099 | 4 975 124 |
| 100× above threshold | 1e-6 | 0.010 | 499 750 |
| Far above threshold | 1e-3 | 0.00001 | 500 |

Miners running the full Rust solver will routinely hit `r < 1e-8` and earn
the full reward.  Simplified TS miners (testnet only) target the same threshold.

---

## Open Questions

1. **Compute-reward calibration:** The compute cost function `c(r)` should be
   benchmarked empirically using the load-test harness (`scripts/load-test.js`)
   on representative hardware before mainnet launch.
2. **MEV / transaction ordering:** The fee cross-term in the Lagrangian
   partially aligns transaction-ordering incentives, but explicit MEV protection
   (e.g. commit-reveal) is deferred to post-mainnet governance.
3. **Validator vs miner reward split:** Section 5 of the mainnet spec allocates
   20 % of block reward to validators; this is implemented in
   `coinomics/reward.ts::splitValidatorReward` and is adjustable via governance.
